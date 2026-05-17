"use client";

// Client-built Legacy NFT BurnV1 instruction builder.
//
// Mirrors the backend's account map at src/lib/txBuilder.ts:1781-1796
// LINE-FOR-LINE. The only difference is that this runs in the browser:
// no RPC, no PDA pre-fetch (caller supplies metadata + master edition
// PDAs from the discovery response), and `createBurnInstruction` is
// invoked with the same args + arg union shape.
//
// Scope: prototype-only, gated behind `?proto=1` in /burner. Used by
// the experimental "Client-built legacy burn" path. The production
// bulk-burn / per-section flow continues to use the backend-built
// serialized tx unchanged.

import {
  PROGRAM_ID as TOKEN_METADATA_PROGRAM_ID,
  createBurnInstruction,
} from "@metaplex-foundation/mpl-token-metadata";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  PublicKey,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  TransactionInstruction,
} from "@solana/web3.js";

export interface LegacyBurnInput {
  // SPL mint of the NFT being burned.
  mint: string;
  // SPL token account currently holding the NFT (must be owned by `owner`).
  tokenAccount: string;
  // Token Metadata PDA: ["metadata", TM_PROGRAM, mint]. Pre-derived by
  // the backend discovery and surfaced in BurnableLegacyCandidate.metadata.
  metadata: string;
  // Master Edition PDA: ["metadata", TM_PROGRAM, mint, "edition"]. Pre-
  // derived by the backend; surfaced in BurnableLegacyCandidate.masterEdition.
  masterEdition: string;
  // Verified collection MINT (NOT the metadata PDA). When non-null the
  // child NFT has `collection.verified === true` on-chain and BurnV1
  // requires the collection's metadata PDA in the `collectionMetadata`
  // account slot or rejects with `0x67 Missing collection metadata
  // account`. The PDA is derived locally from the collection mint
  // using the same seeds as the asset's own metadata PDA. The on-
  // chain account does NOT need to exist (BurnV1 reads the empty slot
  // and proceeds — see backend comment at txBuilder.ts:1289-1304).
  collection: string | null;
}

// PDA derivation: ["metadata", TM_PROGRAM, mint]. Used both for the
// asset's own metadata (already pre-derived by backend) and for the
// collection's metadata (derived locally here from the candidate's
// `collection` mint). The seeds are identical to the backend's
// `deriveMetadataPda` at txBuilder.ts:626-635.
export function deriveCollectionMetadataPda(collectionMint: string): PublicKey {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("metadata"),
      TOKEN_METADATA_PROGRAM_ID.toBuffer(),
      new PublicKey(collectionMint).toBuffer(),
    ],
    TOKEN_METADATA_PROGRAM_ID,
  )[0];
}

// Build a single BurnV1 instruction. Account set is verbatim from
// src/lib/txBuilder.ts:1781-1796. burnArgs is the same tagged union
// (`{__kind: "V1", amount: 1n}`) — 10 bytes of ix data on the wire,
// matching the empirical decode of a backend-built tx in this branch's
// audit (data=10B, keys=14 incl. collectionMetadata).
export function buildLegacyBurnIx(
  owner: PublicKey,
  input: LegacyBurnInput,
): TransactionInstruction {
  const accounts: Parameters<typeof createBurnInstruction>[0] = {
    authority: owner,
    metadata: new PublicKey(input.metadata),
    edition: new PublicKey(input.masterEdition),
    mint: new PublicKey(input.mint),
    token: new PublicKey(input.tokenAccount),
    sysvarInstructions: SYSVAR_INSTRUCTIONS_PUBKEY,
    splTokenProgram: TOKEN_PROGRAM_ID,
    systemProgram: SystemProgram.programId,
  };
  if (input.collection) {
    // Type-cast to permit the optional slot. The SDK's account-map type
    // exposes `collectionMetadata` as an optional field but doesn't
    // include it in the indexed Parameters type cleanly; assigning
    // through a writable cast matches the backend's spread pattern.
    (accounts as { collectionMetadata?: PublicKey }).collectionMetadata =
      deriveCollectionMetadataPda(input.collection);
  }
  return createBurnInstruction(accounts, { burnArgs: { __kind: "V1", amount: 1n } });
}
