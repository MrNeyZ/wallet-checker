import {
  ComputeBudgetProgram,
  LAMPORTS_PER_SOL,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  createBurnInstruction,
  createCloseAccountInstruction,
} from "@solana/spl-token";
import { connection } from "./solana.js";
import { scanWalletForCleanup, type ScannedTokenAccount } from "./scanner.js";
import {
  fetchAssetMetadataBatch,
  fetchCoreAssetsByOwner,
} from "../services/helius/das.js";
import { CappedLruMap } from "./lruCache.js";
import { burnV1 as mplCoreBurnV1, mplCore } from "@metaplex-foundation/mpl-core";
import {
  createNoopSigner,
  publicKey as umiPublicKey,
} from "@metaplex-foundation/umi";
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import { toWeb3JsInstruction } from "@metaplex-foundation/umi-web3js-adapters";

// Module-scope Umi context. We never use it for RPC — only as a
// program registry so the generated `burnV1` builder can resolve the
// mpl-core program ID and emit the correct account metas. The RPC URL
// passed to `createUmi` is ignored at instruction build time. The
// `mplCore()` plugin registers the Core program so `burnV1` works.
const coreUmi = createUmi("http://localhost").use(mplCore());

export const MAX_CLOSE_IX_PER_TX = 10;

// CloseAccount uses ~3 000 CUs in practice; stay tight to discourage wallets
// from upsizing the CU limit on their side, which would pull priority fees
// up. Headroom keeps transactions resilient if the SPL Token program changes
// slightly.
const CU_PER_CLOSE = 3_000;
const CU_HEADROOM = 5_000;

// Solana's max transaction packet payload is 1 232 bytes (1 280 byte UDP
// packet minus 48 bytes of network framing). The wallet will refuse anything
// larger and validators will drop it. We trim instructions until the
// serialized tx fits with margin to spare.
const MAX_TX_SIZE_BYTES = 1_232;

// Base fee per signature on Solana mainnet, in lamports. Cleaner txs need
// exactly one signature (the wallet owner). Documented constant; safe to
// hard-code without an RPC round-trip.
const BASE_FEE_LAMPORTS_PER_SIGNATURE = 5_000;

const UNSIGNED_TX_WARNING =
  "Unsigned transaction. User wallet must review and sign client-side.";

// Priority fee for cleaner transactions, in micro-lamports per CU.
// Cleanup is not time-critical (rent reclaim, no MEV), so we default to 0 —
// the user's wallet still pays the base 5 000 lamports/signature fee, but
// no extra priority tip. Override via CLEANER_PRIORITY_FEE_MICROLAMPORTS in
// .env if a deployment needs faster confirmation.
function readPriorityFeeMicrolamports(): number {
  const raw = process.env.CLEANER_PRIORITY_FEE_MICROLAMPORTS;
  if (raw === undefined || raw.trim() === "") return 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

export interface BuildCloseEmptyTxResult {
  wallet: string;
  transactionVersion: "legacy";
  feePayer: string;
  requiresSignatureFrom: string;
  maxInstructionsPerTx: number;
  includedAccounts: ScannedTokenAccount[];
  totalEmpty: number;
  skippedAccounts: number;
  estimatedReclaimSol: number;
  // Fee breakdown — analytical, no RPC round-trip. Sum of base (per signature)
  // + priority (CU price × CU limit / 1e6, ceiled).
  estimatedBaseFeeSol: number;
  estimatedPriorityFeeSol: number;
  estimatedFeeSol: number;
  estimatedNetReclaimSol: number;
  computeUnitLimit: number;
  priorityFeeMicrolamports: number;
  transactionBase64: string | null;
  warning: string;
}

export async function buildCloseEmptyAccountsTx(
  address: string,
): Promise<BuildCloseEmptyTxResult> {
  const owner = new PublicKey(address);
  const ownerStr = owner.toBase58();
  const scan = await scanWalletForCleanup(ownerStr);

  // Filter empties to "safe to close": zero balance AND owner is this wallet
  // (can't close someone else's account; the scanner correctly returns owner
  // = the queried address, but we belt-and-brace it here). Then de-dupe by
  // tokenAccount address — a defensive guard so a future scanner change that
  // emits the same account twice can't yield a tx with two CloseAccount
  // ixs targeting the same address (validator would reject the second).
  const seen = new Set<string>();
  const safeEmpty = scan.emptyTokenAccounts.filter((acc) => {
    if (acc.amount !== "0" || acc.owner !== ownerStr) return false;
    if (seen.has(acc.tokenAccount)) return false;
    seen.add(acc.tokenAccount);
    return true;
  });

  // Cap at MAX_CLOSE_IX_PER_TX up-front; the size-fit loop below may trim
  // further if the serialized tx still exceeds the 1 232-byte packet cap.
  let included = safeEmpty.slice(0, MAX_CLOSE_IX_PER_TX);
  const priorityFeeMicrolamports = readPriorityFeeMicrolamports();

  // Empty branch: short-circuit so we don't fetch a blockhash for a tx we
  // won't return. All fee fields are zeroed because there is no transaction.
  if (included.length === 0) {
    return {
      wallet: ownerStr,
      transactionVersion: "legacy",
      feePayer: ownerStr,
      requiresSignatureFrom: ownerStr,
      maxInstructionsPerTx: MAX_CLOSE_IX_PER_TX,
      totalEmpty: safeEmpty.length,
      skippedAccounts: 0,
      warning: UNSIGNED_TX_WARNING,
      estimatedBaseFeeSol: 0,
      estimatedPriorityFeeSol: 0,
      estimatedFeeSol: 0,
      computeUnitLimit: 0,
      priorityFeeMicrolamports,
      includedAccounts: [],
      estimatedReclaimSol: 0,
      estimatedNetReclaimSol: 0,
      transactionBase64: null,
    };
  }

  // One blockhash fetch — reused across any size-fit retries below; trimming
  // only changes which CloseAccount ixs are appended, not the recent block.
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();

  // Build a tx for the current `included` set. We re-build (cheap, in-process)
  // each time the size guard trims; this avoids guesswork about per-ix bytes
  // since the actual serializer output is the only authoritative size.
  const buildTx = (
    accts: ScannedTokenAccount[],
    cuLimit: number,
  ): { tx: Transaction; serialized: Uint8Array } => {
    const t = new Transaction();
    // Order matters: ComputeBudget first so wallets respect our limits and
    // don't auto-inflate the priority fee. CloseAccount instructions follow.
    t.add(ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }));
    if (priorityFeeMicrolamports > 0) {
      t.add(
        ComputeBudgetProgram.setComputeUnitPrice({
          microLamports: priorityFeeMicrolamports,
        }),
      );
    }
    for (const acc of accts) {
      t.add(
        createCloseAccountInstruction(
          new PublicKey(acc.tokenAccount),
          owner,
          owner,
          [],
          new PublicKey(acc.programId),
        ),
      );
    }
    t.recentBlockhash = blockhash;
    t.lastValidBlockHeight = lastValidBlockHeight;
    t.feePayer = owner;
    const ser = t.serialize({ requireAllSignatures: false, verifySignatures: false });
    return { tx: t, serialized: ser };
  };

  // Trim from the tail of `included` until the serialized payload fits the
  // 1 232-byte packet cap. With N=10 closes we expect ~600–800 bytes, well
  // below the cap, so this normally exits on the first iteration. The guard
  // exists to keep us safe if MAX_CLOSE_IX_PER_TX is bumped or per-ix size
  // grows (e.g. Token-2022 with extension accounts).
  let computeUnitLimit = CU_PER_CLOSE * included.length + CU_HEADROOM;
  let built = buildTx(included, computeUnitLimit);
  while (built.serialized.length > MAX_TX_SIZE_BYTES && included.length > 1) {
    included = included.slice(0, -1);
    computeUnitLimit = CU_PER_CLOSE * included.length + CU_HEADROOM;
    built = buildTx(included, computeUnitLimit);
  }
  // Defensive: if even a single close + budget ixs don't fit, bail out
  // rather than emit something the validator will drop.
  if (built.serialized.length > MAX_TX_SIZE_BYTES) {
    throw new Error(
      `Close-empty transaction exceeds ${MAX_TX_SIZE_BYTES}-byte packet cap even with one instruction (got ${built.serialized.length} bytes)`,
    );
  }

  const skippedAccounts = safeEmpty.length - included.length;

  // Fee math on the final (possibly trimmed) included set.
  const baseFeeLamports = BASE_FEE_LAMPORTS_PER_SIGNATURE; // 1 signer
  // Solana priority fee formula: ceil(microLamports * units / 1_000_000).
  const priorityFeeLamports =
    priorityFeeMicrolamports > 0
      ? Math.ceil((priorityFeeMicrolamports * computeUnitLimit) / 1_000_000)
      : 0;
  const totalFeeLamports = baseFeeLamports + priorityFeeLamports;
  const grossReclaimSol = included.reduce(
    (sum, a) => sum + a.estimatedReclaimSol,
    0,
  );
  const estimatedFeeSol = totalFeeLamports / LAMPORTS_PER_SOL;
  const estimatedNetReclaimSol = Math.max(0, grossReclaimSol - estimatedFeeSol);

  return {
    wallet: ownerStr,
    transactionVersion: "legacy",
    feePayer: ownerStr,
    requiresSignatureFrom: ownerStr,
    maxInstructionsPerTx: MAX_CLOSE_IX_PER_TX,
    totalEmpty: safeEmpty.length,
    skippedAccounts,
    warning: UNSIGNED_TX_WARNING,
    estimatedBaseFeeSol: baseFeeLamports / LAMPORTS_PER_SOL,
    estimatedPriorityFeeSol: priorityFeeLamports / LAMPORTS_PER_SOL,
    estimatedFeeSol,
    computeUnitLimit,
    priorityFeeMicrolamports,
    includedAccounts: included,
    estimatedReclaimSol: grossReclaimSol,
    estimatedNetReclaimSol,
    transactionBase64: Buffer.from(built.serialized).toString("base64"),
  };
}

// ============================================================================
// Burn + close: irreversibly burns the entire balance of selected fungible
// SPL Token / Token-2022 accounts and immediately closes them to reclaim
// rent. Parallel to buildCloseEmptyAccountsTx — empty-account-close logic is
// untouched. Burn instructions are inherently destructive; the safety guards
// here enforce: amount > 0, owner == wallet, never WSOL, no duplicates.
// "Low-value" filtering is delegated to the caller via opts.mints (the
// scanner has no price data). Without an explicit list, every fungible
// non-WSOL account owned by the wallet becomes a candidate.
// ============================================================================

const WSOL_MINT_FOR_BURN = "So11111111111111111111111111111111111111112";

// Per-account CU estimate. Burn ≈ 6 000 CU, post-burn close ≈ 3 000 CU.
// Cap accounts per tx tighter than close-empty because each entry costs
// two instructions instead of one.
const CU_PER_BURN = 6_000;
const CU_PER_CLOSE_AFTER_BURN = 3_000;
export const MAX_BURN_AND_CLOSE_PER_TX = 5;

const BURN_AND_CLOSE_WARNING =
  "Burns tokens irreversibly, then closes the account to reclaim rent. Verify each mint manually before signing — burned tokens cannot be recovered.";

export interface BuildBurnAndCloseTxOptions {
  // Restrict to specific mints. When omitted, every fungible non-WSOL
  // account owned by the wallet is a candidate. Passing an explicit set is
  // the recommended path — guards against "burn everything" mistakes.
  mints?: string[];
}

export interface BuildBurnAndCloseTxResult {
  wallet: string;
  transactionVersion: "legacy";
  feePayer: string;
  requiresSignatureFrom: string;
  maxAccountsPerTx: number;
  includedAccounts: ScannedTokenAccount[];
  totalBurnable: number;
  burnCount: number;
  skippedAccounts: number;
  estimatedReclaimSol: number;
  estimatedBaseFeeSol: number;
  estimatedPriorityFeeSol: number;
  estimatedFeeSol: number;
  estimatedNetReclaimSol: number;
  computeUnitLimit: number;
  priorityFeeMicrolamports: number;
  transactionBase64: string | null;
  // Captured from the SAME getLatestBlockhash() call used to serialize
  // `transactionBase64`. The frontend confirmTransaction strategy form
  // requires both — `lastValidBlockHeight` is NOT part of the on-wire tx
  // message, so it doesn't survive a Transaction.serialize() round-trip.
  // Both null when transactionBase64 is null.
  blockhash: string | null;
  lastValidBlockHeight: number | null;
  warning: string;
}

export async function buildBurnAndCloseTx(
  address: string,
  opts: BuildBurnAndCloseTxOptions = {},
): Promise<BuildBurnAndCloseTxResult> {
  const owner = new PublicKey(address);
  const ownerStr = owner.toBase58();
  const scan = await scanWalletForCleanup(ownerStr);

  const mintsAllowed = opts.mints && opts.mints.length > 0
    ? new Set(opts.mints)
    : null;

  // Safety filters:
  //   - amount must be > 0 (non-empty)
  //   - owner must match the wallet (defensive — scanner already does this
  //     but we double-check before emitting a destructive instruction)
  //   - never burn WSOL (would just lose wrapped SOL)
  //   - if a mint allowlist is given, only those mints qualify
  //   - dedupe by tokenAccount address
  const seen = new Set<string>();
  const candidates: ScannedTokenAccount[] = [];
  for (const acc of scan.fungibleTokenAccounts) {
    if (acc.owner !== ownerStr) continue;
    if (acc.amount === "0") continue;
    if (acc.mint === WSOL_MINT_FOR_BURN) continue;
    if (mintsAllowed && !mintsAllowed.has(acc.mint)) continue;
    if (seen.has(acc.tokenAccount)) continue;
    seen.add(acc.tokenAccount);
    candidates.push(acc);
  }

  let included = candidates.slice(0, MAX_BURN_AND_CLOSE_PER_TX);
  const priorityFeeMicrolamports = readPriorityFeeMicrolamports();

  // Empty branch — short-circuit so we don't fetch a blockhash for a tx we
  // won't return. All fee fields are zeroed because there is no transaction.
  if (included.length === 0) {
    return {
      wallet: ownerStr,
      transactionVersion: "legacy",
      feePayer: ownerStr,
      requiresSignatureFrom: ownerStr,
      maxAccountsPerTx: MAX_BURN_AND_CLOSE_PER_TX,
      totalBurnable: candidates.length,
      burnCount: 0,
      skippedAccounts: 0,
      includedAccounts: [],
      estimatedReclaimSol: 0,
      estimatedBaseFeeSol: 0,
      estimatedPriorityFeeSol: 0,
      estimatedFeeSol: 0,
      estimatedNetReclaimSol: 0,
      computeUnitLimit: 0,
      priorityFeeMicrolamports,
      transactionBase64: null,
      blockhash: null,
      lastValidBlockHeight: null,
      warning: BURN_AND_CLOSE_WARNING,
    };
  }

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();

  // Build a tx for the current `included` set. Re-builds whenever the size
  // guard trims; serializer output is the only authoritative size source.
  const buildTx = (
    accts: ScannedTokenAccount[],
    cuLimit: number,
  ): { tx: Transaction; serialized: Uint8Array } => {
    const t = new Transaction();
    // ComputeBudget first so wallets respect our caps and stop auto-inflating
    // priority fees.
    t.add(ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }));
    if (priorityFeeMicrolamports > 0) {
      t.add(
        ComputeBudgetProgram.setComputeUnitPrice({
          microLamports: priorityFeeMicrolamports,
        }),
      );
    }
    // For each account: burn the full balance, then close.
    for (const acc of accts) {
      const tokenAccount = new PublicKey(acc.tokenAccount);
      const mint = new PublicKey(acc.mint);
      const programId = new PublicKey(acc.programId);
      t.add(
        createBurnInstruction(
          tokenAccount,
          mint,
          owner,
          BigInt(acc.amount),
          [],
          programId,
        ),
      );
      t.add(
        createCloseAccountInstruction(
          tokenAccount,
          owner,
          owner,
          [],
          programId,
        ),
      );
    }
    t.recentBlockhash = blockhash;
    t.lastValidBlockHeight = lastValidBlockHeight;
    t.feePayer = owner;
    const ser = t.serialize({ requireAllSignatures: false, verifySignatures: false });
    return { tx: t, serialized: ser };
  };

  // Trim from the tail until the serialized payload fits the 1 232-byte
  // packet cap. A burn+close pair is ≈ 80–110 bytes; 5 pairs realistically
  // sit ~700–900 bytes. Loop is defensive for future Token-2022 extensions.
  let computeUnitLimit =
    (CU_PER_BURN + CU_PER_CLOSE_AFTER_BURN) * included.length + CU_HEADROOM;
  let built = buildTx(included, computeUnitLimit);
  while (built.serialized.length > MAX_TX_SIZE_BYTES && included.length > 1) {
    included = included.slice(0, -1);
    computeUnitLimit =
      (CU_PER_BURN + CU_PER_CLOSE_AFTER_BURN) * included.length + CU_HEADROOM;
    built = buildTx(included, computeUnitLimit);
  }
  if (built.serialized.length > MAX_TX_SIZE_BYTES) {
    throw new Error(
      `Burn+close transaction exceeds ${MAX_TX_SIZE_BYTES}-byte packet cap even with one account (got ${built.serialized.length} bytes)`,
    );
  }

  const skippedAccounts = candidates.length - included.length;
  const baseFeeLamports = BASE_FEE_LAMPORTS_PER_SIGNATURE; // 1 signer
  const priorityFeeLamports =
    priorityFeeMicrolamports > 0
      ? Math.ceil((priorityFeeMicrolamports * computeUnitLimit) / 1_000_000)
      : 0;
  const totalFeeLamports = baseFeeLamports + priorityFeeLamports;
  // Reclaim is the rent on the closed accounts (lamports), summed across
  // all included entries.
  const grossReclaimLamports = included.reduce(
    (sum, a) => sum + a.lamports,
    0,
  );
  const grossReclaimSol = grossReclaimLamports / LAMPORTS_PER_SOL;
  const estimatedFeeSol = totalFeeLamports / LAMPORTS_PER_SOL;
  const estimatedNetReclaimSol = Math.max(0, grossReclaimSol - estimatedFeeSol);

  return {
    wallet: ownerStr,
    transactionVersion: "legacy",
    feePayer: ownerStr,
    requiresSignatureFrom: ownerStr,
    maxAccountsPerTx: MAX_BURN_AND_CLOSE_PER_TX,
    totalBurnable: candidates.length,
    burnCount: included.length,
    skippedAccounts,
    includedAccounts: included,
    estimatedReclaimSol: grossReclaimSol,
    estimatedBaseFeeSol: baseFeeLamports / LAMPORTS_PER_SOL,
    estimatedPriorityFeeSol: priorityFeeLamports / LAMPORTS_PER_SOL,
    estimatedFeeSol,
    estimatedNetReclaimSol,
    computeUnitLimit,
    priorityFeeMicrolamports,
    transactionBase64: Buffer.from(built.serialized).toString("base64"),
    blockhash,
    lastValidBlockHeight,
    warning: BURN_AND_CLOSE_WARNING,
  };
}

// ============================================================================
// Standard Metaplex NFT burn (BurnV1). Burns the SPL token + closes the
// token account + closes the Metadata PDA + closes the Master Edition PDA
// in one Metaplex instruction. Reclaims ~0.008 SOL per NFT vs ~0.002 SOL
// for the fungible-burn path.
//
// MVP scope (per investigation report):
//   - Token Standard NonFungible only (NonFungibleEdition excluded; would
//     need master-edition / edition-marker plumbing).
//   - Standard SPL Token program only (Token-2022 NFTs are off-spec for v1).
//   - ProgrammableNonFungible (pNFT) explicitly rejected — needs token
//     record + ruleset accounts and the ruleset failure surface.
//   - Compressed NFTs (cNFTs) not handled — different program entirely.
// ============================================================================

import {
  PROGRAM_ID as TOKEN_METADATA_PROGRAM_ID,
  Metadata,
  TokenStandard,
  createBurnInstruction as createMetaplexBurnInstruction,
} from "@metaplex-foundation/mpl-token-metadata";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { SystemProgram, SYSVAR_INSTRUCTIONS_PUBKEY } from "@solana/web3.js";

// Safety cap, NOT the primary limit — actual included count is decided by
// tx-size + simulation outcome. The sim-trim loop in buildLegacyNftBurnTx
// will bring this down further whenever needed; this cap just bounds the
// initial attempt so we don't waste a full-wallet simulation pass.
export const MAX_NFT_BURN_PER_TX = 8;
// Conservative starting cap for the legacy-NFT builder's *initial* batch.
// Verified-collection NFTs add an extra writable collection-metadata
// account per ix, so 8 BurnV1s now overflow Solana's 1 232-byte packet
// cap on real wallets. The size-trim loop in buildLegacyNftBurnTxImpl
// further reduces if needed.
const LEGACY_INITIAL_BATCH_CAP = 6;
const CU_PER_NFT_BURN = 50_000;
const STANDARD_NFT_BURN_WARNING =
  "Burns Metaplex NFTs irreversibly and closes their Metadata + Master Edition accounts. Verify each mint manually before signing — burned NFTs and their on-chain state cannot be recovered.";

export interface StandardNftCandidateConfirmation {
  mint: string;
  isStandard: boolean; // tokenStandard === NonFungible
  isProgrammable: boolean; // pNFT — explicitly excluded
  isEdition: boolean; // NonFungibleEdition — excluded for MVP
  metadataPda: string;
  masterEditionPda: string;
  metadataLamports: number;
  masterEditionLamports: number;
}

function deriveMetadataPda(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("metadata"),
      TOKEN_METADATA_PROGRAM_ID.toBuffer(),
      mint.toBuffer(),
    ],
    TOKEN_METADATA_PROGRAM_ID,
  )[0];
}

function deriveMasterEditionPda(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("metadata"),
      TOKEN_METADATA_PROGRAM_ID.toBuffer(),
      mint.toBuffer(),
      Buffer.from("edition"),
    ],
    TOKEN_METADATA_PROGRAM_ID,
  )[0];
}

// Fetches Metadata + Master Edition PDAs for each mint and decodes the
// Metadata to determine the token standard. Returns null per mint when the
// Metadata account doesn't exist or fails to deserialize (e.g. mint was
// burned outside our flow, or it's not a real Metaplex NFT).
async function confirmStandardNfts(
  mints: string[],
): Promise<Map<string, StandardNftCandidateConfirmation | null>> {
  const result = new Map<string, StandardNftCandidateConfirmation | null>();
  if (mints.length === 0) return result;

  const mintPks = mints.map((m) => new PublicKey(m));
  const pdaPairs = mintPks.map((m) => ({
    metadata: deriveMetadataPda(m),
    masterEdition: deriveMasterEditionPda(m),
  }));
  // Flatten to one address list so getMultipleAccountsInfo can batch up to
  // 100 accounts per RPC call.
  const flat: PublicKey[] = [];
  for (const p of pdaPairs) {
    flat.push(p.metadata, p.masterEdition);
  }

  const infos: ({ data: Buffer; lamports: number } | null)[] = [];
  for (let i = 0; i < flat.length; i += 100) {
    const chunk = flat.slice(i, i + 100);
    const res = await connection.getMultipleAccountsInfo(chunk);
    for (const info of res) {
      infos.push(
        info
          ? { data: Buffer.from(info.data), lamports: info.lamports }
          : null,
      );
    }
  }

  for (let i = 0; i < mints.length; i++) {
    const mint = mints[i];
    const metaInfo = infos[i * 2];
    const editionInfo = infos[i * 2 + 1];
    if (!metaInfo) {
      result.set(mint, null);
      continue;
    }
    let tokenStandard: number | null = null;
    try {
      const [decoded] = Metadata.fromAccountInfo({
        data: metaInfo.data,
        executable: false,
        lamports: metaInfo.lamports,
        owner: TOKEN_METADATA_PROGRAM_ID,
        rentEpoch: 0,
      });
      tokenStandard =
        decoded.tokenStandard !== null ? decoded.tokenStandard : null;
    } catch {
      result.set(mint, null);
      continue;
    }
    const isStandard = tokenStandard === TokenStandard.NonFungible;
    const isProgrammable =
      tokenStandard === TokenStandard.ProgrammableNonFungible ||
      tokenStandard === TokenStandard.ProgrammableNonFungibleEdition;
    const isEdition = tokenStandard === TokenStandard.NonFungibleEdition;
    result.set(mint, {
      mint,
      isStandard,
      isProgrammable,
      isEdition,
      metadataPda: pdaPairs[i].metadata.toBase58(),
      masterEditionPda: pdaPairs[i].masterEdition.toBase58(),
      metadataLamports: metaInfo.lamports,
      masterEditionLamports: editionInfo?.lamports ?? 0,
    });
  }
  return result;
}

export interface BuildStandardNftBurnTxOptions {
  // Restrict to specific NFT mints. Without it every NonFungible token
  // owned by the wallet is a candidate (capped server-side).
  mints?: string[];
}

export interface StandardNftBurnEntry {
  mint: string;
  tokenAccount: string;
  metadataPda: string;
  masterEditionPda: string;
  reclaimLamports: number;
}

export interface BuildStandardNftBurnTxResult {
  wallet: string;
  transactionVersion: "legacy";
  feePayer: string;
  requiresSignatureFrom: string;
  maxAccountsPerTx: number;
  includedNfts: StandardNftBurnEntry[];
  totalBurnable: number;
  burnCount: number;
  skippedNfts: number;
  estimatedReclaimSol: number;
  estimatedBaseFeeSol: number;
  estimatedPriorityFeeSol: number;
  estimatedFeeSol: number;
  estimatedNetReclaimSol: number;
  computeUnitLimit: number;
  priorityFeeMicrolamports: number;
  transactionBase64: string | null;
  warning: string;
}

export async function buildStandardNftBurnTx(
  address: string,
  opts: BuildStandardNftBurnTxOptions = {},
): Promise<BuildStandardNftBurnTxResult> {
  const owner = new PublicKey(address);
  const ownerStr = owner.toBase58();
  const scan = await scanWalletForCleanup(ownerStr);
  const splTokenProgramStr = TOKEN_PROGRAM_ID.toBase58();
  const token2022ProgramStr = TOKEN_2022_PROGRAM_ID.toBase58();

  const mintsAllowed =
    opts.mints && opts.mints.length > 0 ? new Set(opts.mints) : null;

  // Initial coarse filter from the cleanup scan: 1-supply, 0-decimal token
  // accounts under the classic SPL Token program. Token-2022 NFTs are not
  // covered by this MVP path — they use embedded metadata and a different
  // burn shape.
  const seen = new Set<string>();
  const coarseCandidates = scan.nftTokenAccounts.filter((acc) => {
    if (acc.owner !== ownerStr) return false;
    if (acc.amount !== "1") return false;
    if (acc.decimals !== 0) return false;
    if (acc.programId === token2022ProgramStr) return false;
    if (acc.programId !== splTokenProgramStr) return false;
    if (mintsAllowed && !mintsAllowed.has(acc.mint)) return false;
    if (seen.has(acc.tokenAccount)) return false;
    seen.add(acc.tokenAccount);
    return true;
  });

  // Confirm token standard via Metaplex Metadata PDAs. This is the safety
  // gate that distinguishes real Standard NFTs from supply-1 dead tokens
  // and rejects pNFTs / Editions for MVP.
  const confirmations = await confirmStandardNfts(
    coarseCandidates.map((c) => c.mint),
  );

  const standardOnly: {
    acc: ScannedTokenAccount;
    info: StandardNftCandidateConfirmation;
  }[] = [];
  for (const acc of coarseCandidates) {
    const info = confirmations.get(acc.mint);
    if (!info) continue; // failed metadata lookup
    if (info.isProgrammable) continue; // pNFT — out of scope
    if (info.isEdition) continue; // NonFungibleEdition — out of scope for MVP
    if (!info.isStandard) continue; // some other shape (Fungible / no standard)
    standardOnly.push({ acc, info });
  }

  let included = standardOnly.slice(0, MAX_NFT_BURN_PER_TX);
  const priorityFeeMicrolamports = readPriorityFeeMicrolamports();

  if (included.length === 0) {
    return {
      wallet: ownerStr,
      transactionVersion: "legacy",
      feePayer: ownerStr,
      requiresSignatureFrom: ownerStr,
      maxAccountsPerTx: MAX_NFT_BURN_PER_TX,
      totalBurnable: standardOnly.length,
      burnCount: 0,
      skippedNfts: 0,
      includedNfts: [],
      estimatedReclaimSol: 0,
      estimatedBaseFeeSol: 0,
      estimatedPriorityFeeSol: 0,
      estimatedFeeSol: 0,
      estimatedNetReclaimSol: 0,
      computeUnitLimit: 0,
      priorityFeeMicrolamports,
      transactionBase64: null,
      warning: STANDARD_NFT_BURN_WARNING,
    };
  }

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();

  const buildTx = (
    items: typeof included,
    cuLimit: number,
  ): { tx: Transaction; serialized: Uint8Array } => {
    const t = new Transaction();
    t.add(ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }));
    if (priorityFeeMicrolamports > 0) {
      t.add(
        ComputeBudgetProgram.setComputeUnitPrice({
          microLamports: priorityFeeMicrolamports,
        }),
      );
    }
    for (const { acc, info } of items) {
      const mint = new PublicKey(acc.mint);
      const tokenAccount = new PublicKey(acc.tokenAccount);
      const metadata = new PublicKey(info.metadataPda);
      const masterEdition = new PublicKey(info.masterEditionPda);
      // BurnV1 with TokenStandard.NonFungible:
      //   - authority = owner (signer, writable)
      //   - metadata, mint, token, edition (writable)
      //   - sysvarInstructions, splTokenProgram, systemProgram
      // collectionMetadata / masterEdition[Mint|Token] / editionMarker /
      // tokenRecord / authorizationRules left as default — only Edition /
      // pNFT need them, both excluded above.
      t.add(
        createMetaplexBurnInstruction(
          {
            authority: owner,
            metadata,
            edition: masterEdition,
            mint,
            token: tokenAccount,
            sysvarInstructions: SYSVAR_INSTRUCTIONS_PUBKEY,
            splTokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          },
          {
            burnArgs: { __kind: "V1", amount: 1n },
          },
        ),
      );
    }
    t.recentBlockhash = blockhash;
    t.lastValidBlockHeight = lastValidBlockHeight;
    t.feePayer = owner;
    const ser = t.serialize({ requireAllSignatures: false, verifySignatures: false });
    return { tx: t, serialized: ser };
  };

  let computeUnitLimit = CU_PER_NFT_BURN * included.length + CU_HEADROOM;
  let built = buildTx(included, computeUnitLimit);
  while (built.serialized.length > MAX_TX_SIZE_BYTES && included.length > 1) {
    included = included.slice(0, -1);
    computeUnitLimit = CU_PER_NFT_BURN * included.length + CU_HEADROOM;
    built = buildTx(included, computeUnitLimit);
  }
  if (built.serialized.length > MAX_TX_SIZE_BYTES) {
    throw new Error(
      `Standard NFT burn transaction exceeds ${MAX_TX_SIZE_BYTES}-byte packet cap even with one NFT (got ${built.serialized.length} bytes)`,
    );
  }

  const skippedNfts = standardOnly.length - included.length;
  const baseFeeLamports = BASE_FEE_LAMPORTS_PER_SIGNATURE;
  const priorityFeeLamports =
    priorityFeeMicrolamports > 0
      ? Math.ceil((priorityFeeMicrolamports * computeUnitLimit) / 1_000_000)
      : 0;
  const totalFeeLamports = baseFeeLamports + priorityFeeLamports;

  const includedEntries: StandardNftBurnEntry[] = included.map(({ acc, info }) => ({
    mint: acc.mint,
    tokenAccount: acc.tokenAccount,
    metadataPda: info.metadataPda,
    masterEditionPda: info.masterEditionPda,
    // BurnV1 closes all three accounts at chain time. Sum their rent so
    // the preview shows realistic gross reclaim.
    reclaimLamports:
      acc.lamports + info.metadataLamports + info.masterEditionLamports,
  }));
  const grossReclaimLamports = includedEntries.reduce(
    (sum, e) => sum + e.reclaimLamports,
    0,
  );
  const grossReclaimSol = grossReclaimLamports / LAMPORTS_PER_SOL;
  const estimatedFeeSol = totalFeeLamports / LAMPORTS_PER_SOL;
  const estimatedNetReclaimSol = Math.max(0, grossReclaimSol - estimatedFeeSol);

  return {
    wallet: ownerStr,
    transactionVersion: "legacy",
    feePayer: ownerStr,
    requiresSignatureFrom: ownerStr,
    maxAccountsPerTx: MAX_NFT_BURN_PER_TX,
    totalBurnable: standardOnly.length,
    burnCount: includedEntries.length,
    skippedNfts,
    includedNfts: includedEntries,
    estimatedReclaimSol: grossReclaimSol,
    estimatedBaseFeeSol: baseFeeLamports / LAMPORTS_PER_SOL,
    estimatedPriorityFeeSol: priorityFeeLamports / LAMPORTS_PER_SOL,
    estimatedFeeSol,
    estimatedNetReclaimSol,
    computeUnitLimit,
    priorityFeeMicrolamports,
    transactionBase64: Buffer.from(built.serialized).toString("base64"),
    warning: STANDARD_NFT_BURN_WARNING,
  };
}

// ============================================================================
// Milestone 1 — Legacy Metaplex NFT burn (BurnV1, max-reclaim).
//
// Canonical successor to the earlier `buildStandardNftBurnTx` MVP precursor:
// adds per-NFT skip reasons, name/symbol enrichment, and a richer response
// envelope. The older endpoint is left in place so any in-flight integrations
// keep working.
//
// Scope (Milestone 1 only):
//   ✓ NonFungible
//   ✗ NonFungibleEdition       — needs master-edition / edition-marker
//                                 plumbing; included in detection but skipped
//                                 from the tx with a clear reason
//   ✗ ProgrammableNonFungible  — Milestone 2 (pNFT)
//   ✗ Metaplex Core            — Milestone 3
//   ✗ Compressed NFTs          — out of scope (no rent to reclaim)
// ============================================================================

const LEGACY_NFT_BURN_WARNING =
  "Burns Metaplex NFTs irreversibly via BurnV1 and closes their Metadata + Master Edition accounts. Verify each mint manually before signing — burned NFTs cannot be recovered.";

// Strip Metaplex's fixed-length null/space padding from name/symbol so JSON
// consumers don't see embedded   or trailing whitespace.
// Merge Helius DAS results into a list of LegacyNftConfirmation objects.
// Mutates in place: fills in name/symbol from off-chain JSON when on-chain
// extraction yielded null/empty, and always sets image when DAS provided
// one. Confined to burnable entries to keep the DAS call payload tight.
async function enrichLegacyConfirmationsWithDas(
  confirmations: LegacyNftConfirmation[],
): Promise<void> {
  const ids = confirmations
    .filter((c) => c.isBurnable)
    .map((c) => c.mint);
  if (ids.length === 0) return;
  const dasMap = await fetchAssetMetadataBatch(ids);
  for (const c of confirmations) {
    const m = dasMap.get(c.mint);
    if (!m) continue;
    if (!c.name && m.name) c.name = m.name;
    if (!c.symbol && m.symbol) c.symbol = m.symbol;
    if (m.image) c.image = m.image;
  }
}

// Same merge for pNFT confirmations. Forward-declared here so both
// builders share one implementation shape.
async function enrichPnftConfirmationsWithDas(
  confirmations: { mint: string; isBurnable: boolean; name: string | null; symbol: string | null; image: string | null }[],
): Promise<void> {
  const ids = confirmations
    .filter((c) => c.isBurnable)
    .map((c) => c.mint);
  if (ids.length === 0) return;
  const dasMap = await fetchAssetMetadataBatch(ids);
  for (const c of confirmations) {
    const m = dasMap.get(c.mint);
    if (!m) continue;
    if (!c.name && m.name) c.name = m.name;
    if (!c.symbol && m.symbol) c.symbol = m.symbol;
    if (m.image) c.image = m.image;
  }
}

function stripPadding(s: string | null | undefined): string | null {
  if (typeof s !== "string") return null;
  // Two-step strip: NUL bytes (Metaplex pads name/symbol with U+0000)
  // plus ASCII whitespace at both ends. JS .trim() does NOT consider
  // NUL as whitespace, so the explicit char-class is required — without
  // it, names like "MyNFT\u0000\u0000\u0000 \u2026" leaked through with
  // the padding intact, contributing to the "metadata not yet loaded"
  // UX bug.
  const trimmed = s.replace(/[\u0000\s]+$/g, "").replace(/^[\u0000\s]+/, "");
  return trimmed.length > 0 ? trimmed : null;
}

export interface LegacyNftConfirmation {
  mint: string;
  tokenAccount: string;
  isLegacy: boolean;
  isProgrammable: boolean;
  isEdition: boolean;
  isBurnable: boolean;
  unburnableReason?: string;
  metadataPda: string;
  masterEditionPda: string;
  metadataLamports: number;
  masterEditionLamports: number;
  name: string | null;
  symbol: string | null;
  // Off-chain JSON metadata (image URL). Populated by the Helius DAS
  // enrichment pass in buildLegacyNftBurnTx; null on confirm-time.
  image: string | null;
  // Set when the legacy NFT belongs to a verified Metaplex collection AND
  // that collection's Metadata account exists on-chain. BurnV1 requires
  // this PDA in the `collectionMetadata` slot for collection-verified NFTs;
  // omitting it triggers Phantom's "transaction reverted during simulation"
  // warning (and fails on-chain with a missing-collection-metadata error).
  collectionMetadataPda: string | null;
  // Verified collection MINT (not the metadata PDA). Used by the frontend
  // to group candidates by collection in the selection UI. Null when the
  // NFT is not part of a verified collection.
  collection: string | null;
}

async function confirmLegacyNfts(
  candidates: ScannedTokenAccount[],
): Promise<LegacyNftConfirmation[]> {
  if (candidates.length === 0) return [];

  const mintPks = candidates.map((c) => new PublicKey(c.mint));
  const pdas = mintPks.map((m) => ({
    metadata: deriveMetadataPda(m),
    masterEdition: deriveMasterEditionPda(m),
  }));
  const flat: PublicKey[] = [];
  for (const p of pdas) flat.push(p.metadata, p.masterEdition);

  const infos: ({ data: Buffer; lamports: number } | null)[] = [];
  for (let i = 0; i < flat.length; i += 100) {
    const chunk = flat.slice(i, i + 100);
    try {
      const res = await connection.getMultipleAccountsInfo(chunk);
      for (const info of res) {
        infos.push(
          info ? { data: Buffer.from(info.data), lamports: info.lamports } : null,
        );
      }
    } catch (err) {
      // Fail open: surface as nulls so each affected candidate becomes a
      // skipped entry ("Metadata account not found …"). Throwing here used
      // to 500 the whole discovery — never throw for the wallet because of
      // a transient chunk failure.
      console.warn(
        `[legacyNftBurn] confirm Pass 1 chunk RPC failed (offset=${i}, size=${chunk.length}): ${(err as Error)?.message ?? err}`,
      );
      for (let j = 0; j < chunk.length; j++) infos.push(null);
    }
  }

  // Indexed by candidates[]; populated in Pass 1, consumed in Pass 2 for
  // verified-collection NFTs. Same shape as confirmPnfts.
  const collectionMintByCandidateIdx = new Map<number, PublicKey>();

  const out: LegacyNftConfirmation[] = [];
  for (let i = 0; i < candidates.length; i++) {
    const acc = candidates[i];
    const metaInfo = infos[i * 2];
    const editionInfo = infos[i * 2 + 1];
    const base = {
      mint: acc.mint,
      tokenAccount: acc.tokenAccount,
      metadataPda: pdas[i].metadata.toBase58(),
      masterEditionPda: pdas[i].masterEdition.toBase58(),
      metadataLamports: metaInfo?.lamports ?? 0,
      masterEditionLamports: editionInfo?.lamports ?? 0,
      name: null as string | null,
      symbol: null as string | null,
      image: null as string | null,
      collectionMetadataPda: null as string | null,
      collection: null as string | null,
    };
    if (!metaInfo) {
      out.push({
        ...base,
        isLegacy: false,
        isProgrammable: false,
        isEdition: false,
        isBurnable: false,
        unburnableReason:
          "Metadata account not found — not a Metaplex NFT or already burned",
      });
      continue;
    }
    let tokenStandard: number | null = null;
    let name: string | null = null;
    let symbol: string | null = null;
    let verifiedCollectionMint: PublicKey | null = null;
    try {
      const [decoded] = Metadata.fromAccountInfo({
        data: metaInfo.data,
        executable: false,
        lamports: metaInfo.lamports,
        owner: TOKEN_METADATA_PROGRAM_ID,
        rentEpoch: 0,
      });
      // Nullish coalescing — older Metaplex metadata (pre-tokenStandard era)
      // returns `undefined` here, which slipped through the previous
      // `!== null` guard and produced misleading "Unsupported tokenStandard
      // undefined" skip reasons.
      tokenStandard = decoded.tokenStandard ?? null;
      name = stripPadding(decoded.data?.name ?? null);
      symbol = stripPadding(decoded.data?.symbol ?? null);
      verifiedCollectionMint = extractVerifiedCollectionMint(decoded.collection);
    } catch (err) {
      out.push({
        ...base,
        isLegacy: false,
        isProgrammable: false,
        isEdition: false,
        isBurnable: false,
        unburnableReason: `Failed to decode Metadata: ${(err as Error).message}`,
      });
      continue;
    }
    const isProgrammable =
      tokenStandard === TokenStandard.ProgrammableNonFungible ||
      tokenStandard === TokenStandard.ProgrammableNonFungibleEdition;
    const isEdition = tokenStandard === TokenStandard.NonFungibleEdition;
    const isStandard = tokenStandard === TokenStandard.NonFungible;
    // Pre-Metaplex / pre-tokenStandard NFTs: minted before mid-2022 when
    // the `tokenStandard` field was added, so it deserializes as null
    // even though the metadata is a real NFT. We accept these as legacy
    // ONLY when a master-edition account exists on-chain — that's the
    // signature of a real NFT mint vs a 1/0 spam token. Without this
    // recovery the operator was losing ~45 burnable NFTs to the
    // "Metadata has no tokenStandard" skip.
    const hasMasterEdition = (editionInfo?.lamports ?? 0) > 0;
    const isPreMetaplexNft = tokenStandard === null && hasMasterEdition;
    const isLegacy = isStandard || isEdition || isPreMetaplexNft;

    let isBurnable = false;
    let unburnableReason: string | undefined;
    if (isProgrammable) {
      // pNFTs ARE burnable, just not by this section. Point the user at
      // the pNFT section that shares the same /burner "NFTs" tab so they
      // realise these aren't lost — the old "Milestone 2" wording read
      // as "deferred / not implemented", which it isn't anymore.
      unburnableReason = "ProgrammableNonFungible (pNFT) — see pNFT section below";
    } else if (!isLegacy) {
      unburnableReason =
        tokenStandard === null
          ? "Metadata has no tokenStandard and no master edition — likely a 1-supply spam token, not an NFT"
          : `Unsupported tokenStandard ${tokenStandard}`;
    } else if (isEdition) {
      unburnableReason =
        "NonFungibleEdition — burn requires master edition + edition marker accounts; deferred to a later milestone";
    } else {
      isBurnable = true;
    }

    if (verifiedCollectionMint && isBurnable) {
      collectionMintByCandidateIdx.set(i, verifiedCollectionMint);
    }

    out.push({
      ...base,
      name,
      symbol,
      isLegacy,
      isProgrammable,
      isEdition,
      isBurnable,
      unburnableReason,
      collection: verifiedCollectionMint
        ? verifiedCollectionMint.toBase58()
        : null,
    });
  }

  // Pass 2: fetch each verified collection's parent Metadata account. If it
  // exists on-chain, hand its PDA to BurnV1 via `collectionMetadata` so the
  // Token Metadata program can do the sized-collection bookkeeping at burn
  // time. If it doesn't exist, mark the NFT non-burnable to avoid the
  // "Missing collection metadata" revert (Phantom's "reverted during
  // simulation" warning). Same shape as confirmPnfts.
  const collectionEntries = [...collectionMintByCandidateIdx.entries()];
  if (collectionEntries.length > 0) {
    const collectionPdas = collectionEntries.map(([, mint]) =>
      deriveMetadataPda(mint),
    );
    const collectionInfos: ({ data: Buffer; lamports: number } | null)[] = [];
    for (let i = 0; i < collectionPdas.length; i += 100) {
      const chunk = collectionPdas.slice(i, i + 100);
      try {
        const res = await connection.getMultipleAccountsInfo(chunk);
        for (const info of res) {
          collectionInfos.push(
            info
              ? { data: Buffer.from(info.data), lamports: info.lamports }
              : null,
          );
        }
      } catch (err) {
        // Same fail-open pattern as Pass 1. Affected candidates fall through
        // to the !colInfo branch below and become non-burnable with a
        // collection-metadata-missing reason rather than 500-ing the whole
        // discovery call.
        console.warn(
          `[legacyNftBurn] confirm Pass 2 chunk RPC failed (offset=${i}, size=${chunk.length}): ${(err as Error)?.message ?? err}`,
        );
        for (let j = 0; j < chunk.length; j++) collectionInfos.push(null);
      }
    }
    for (let k = 0; k < collectionEntries.length; k++) {
      const [candidateIdx, collectionMint] = collectionEntries[k];
      const colInfo = collectionInfos[k];
      const colPda = collectionPdas[k].toBase58();
      const conf = out[candidateIdx];
      console.log("[legacyNftBurn] collection metadata", {
        mint: conf.mint,
        collectionMint: collectionMint.toBase58(),
        collectionMetadata: colInfo ? colPda : null,
      });
      // Strict: BurnV1 rejects collection-verified NFTs (`0x67 / Missing
      // collection metadata account`) when the `collectionMetadata` slot
      // isn't supplied. The previous "best-effort" branch (leave the slot
      // null and let the sim-trim loop catch it) was the actual cause of
      // the preflight error the operator was seeing — we'd build a tx the
      // program guaranteed to reject.
      //
      // If we have the parent metadata account on-chain → wire it in.
      // If the metadata's `collection` says verified but we can't fetch
      // the parent metadata account → skip this NFT with the explicit
      // "Missing verified collection metadata account" reason. The user
      // sees it surfaced in the section's non-burnable summary and can
      // burn other NFTs in the wallet without one bad collection
      // gumming up the whole batch.
      if (colInfo) {
        conf.collectionMetadataPda = colPda;
      } else {
        conf.isBurnable = false;
        conf.unburnableReason = "Missing verified collection metadata account";
      }
    }
  }

  return out;
}

export interface BuildLegacyNftBurnTxOptions {
  mints?: string[];
}

export interface LegacyNftBurnIncludedEntry {
  mint: string;
  tokenAccount: string;
  metadata: string;
  masterEdition: string;
  name: string | null;
  symbol: string | null;
  image: string | null;
  estimatedGrossReclaimSol: number;
  reason: string;
}

export interface LegacyNftBurnSkippedEntry {
  mint: string;
  tokenAccount: string;
  reason: string;
  // Optional metadata fields — historically populated for cap-overflow /
  // tx-size-trimmed entries. With the new burnableCandidates field, those
  // entries no longer appear in skippedNfts (they're surfaced via
  // burnableCandidates instead). Kept optional for backwards-compat.
  name?: string | null;
  symbol?: string | null;
  image?: string | null;
  estimatedGrossReclaimSol?: number;
  metadata?: string;
  masterEdition?: string;
}

// Full burnable candidate — every NFT/asset that passed all static checks
// and CAN be included in a burn tx. The frontend uses this list to render
// the selectable candidate table; the user can pick any combination, and
// includedNfts is whatever subset of the user's selection actually fit
// the per-tx cap on the build call.
export interface BurnableLegacyCandidate {
  mint: string;
  tokenAccount: string;
  name: string | null;
  symbol: string | null;
  image: string | null;
  estimatedGrossReclaimSol: number;
  metadata: string;
  masterEdition: string;
  // Verified collection mint (or null). Drives frontend grouping in the
  // selectable candidate list.
  collection: string | null;
}

export interface BuildLegacyNftBurnTxResult {
  burnCount: number;
  totalBurnable: number;
  includedNfts: LegacyNftBurnIncludedEntry[];
  skippedNfts: LegacyNftBurnSkippedEntry[];
  estimatedGrossReclaimSol: number;
  estimatedBaseFeeSol: number;
  estimatedPriorityFeeSol: number;
  estimatedFeeSol: number;
  estimatedNetReclaimSol: number;
  computeUnitLimit: number;
  priorityFeeMicrolamports: number;
  transactionBase64: string | null;
  // Captured from the same getLatestBlockhash() that built the tx; both
  // null when transactionBase64 is null. See BuildBurnAndCloseTxResult.
  blockhash: string | null;
  lastValidBlockHeight: number | null;
  transactionVersion: "legacy";
  feePayer: string;
  requiresSignatureFrom: string;
  warning: string;
  // Backend preflight simulation outcome. `simulationOk` is true when the
  // unsigned tx simulated successfully end-to-end; false if the chain
  // would have rejected (most common cause: verified-collection NFTs whose
  // collection metadata account is missing, or token-record / freeze
  // delegate state we couldn't catch statically). When false, all
  // includedNfts move to skippedNfts and transactionBase64 is null per
  // the same all-or-nothing pattern as pNFT/Core.
  simulationOk: boolean;
  simulationError?: string;
  // Full list of burnable NFTs in the wallet — independent of which ones
  // fit this tx. Frontend renders the selectable candidate table from
  // this; the user picks any combination and the build call returns
  // includedNfts containing the largest chosen subset that fits + sims.
  burnableCandidates: BurnableLegacyCandidate[];
  // Safety cap on the INITIAL build attempt. Actual included count is
  // decided by tx size + simulation; the sim-trim loop may produce a
  // smaller batch than maxPerTx. Frontend uses this to display "select
  // up to N per transaction" as a hint, not a hard gate.
  maxPerTx: number;
  // Items the user selected (or in discovery, all burnable items past the
  // safety cap) that did NOT fit this batch and were NOT sim-isolated.
  // Drives the "Build next batch" button — no rescan required between
  // batches when the same selection still has leftovers.
  nextBatchCandidates: BurnableLegacyCandidate[];
}

// Public entry point. Wraps the impl below with a fail-open safety net so
// any unexpected error during discovery returns a valid (empty) envelope
// instead of 500-ing the route. Address validation throws early — that's
// caught upstream and surfaced as 400, not 500.
export async function buildLegacyNftBurnTx(
  address: string,
  opts: BuildLegacyNftBurnTxOptions = {},
): Promise<BuildLegacyNftBurnTxResult> {
  const owner = new PublicKey(address);
  const ownerStr = owner.toBase58();
  try {
    return await buildLegacyNftBurnTxImpl(owner, ownerStr, opts);
  } catch (err) {
    console.warn(
      `[legacyNftBurn] discovery failed unexpectedly for ${ownerStr}: ${(err as Error)?.message ?? err}`,
    );
    return {
      burnCount: 0,
      totalBurnable: 0,
      includedNfts: [],
      skippedNfts: [],
      estimatedGrossReclaimSol: 0,
      estimatedBaseFeeSol: 0,
      estimatedPriorityFeeSol: 0,
      estimatedFeeSol: 0,
      estimatedNetReclaimSol: 0,
      computeUnitLimit: 0,
      priorityFeeMicrolamports: 0,
      transactionBase64: null,
      blockhash: null,
      lastValidBlockHeight: null,
      transactionVersion: "legacy",
      feePayer: ownerStr,
      requiresSignatureFrom: ownerStr,
      warning: LEGACY_NFT_BURN_WARNING,
      simulationOk: false,
      simulationError: "Discovery failed. Try again.",
      burnableCandidates: [],
      maxPerTx: LEGACY_INITIAL_BATCH_CAP,
      nextBatchCandidates: [],
    };
  }
}

async function buildLegacyNftBurnTxImpl(
  owner: PublicKey,
  ownerStr: string,
  opts: BuildLegacyNftBurnTxOptions,
): Promise<BuildLegacyNftBurnTxResult> {
  const scan = await scanWalletForCleanup(ownerStr);
  const splTokenProgramStr = TOKEN_PROGRAM_ID.toBase58();
  const token2022ProgramStr = TOKEN_2022_PROGRAM_ID.toBase58();
  const mintsAllowed =
    opts.mints && opts.mints.length > 0 ? new Set(opts.mints) : null;
  const skippedNfts: LegacyNftBurnSkippedEntry[] = [];

  const seen = new Set<string>();
  const coarse: ScannedTokenAccount[] = [];
  for (const acc of scan.nftTokenAccounts) {
    if (acc.owner !== ownerStr) {
      skippedNfts.push({
        mint: acc.mint,
        tokenAccount: acc.tokenAccount,
        reason: "Owner mismatch",
      });
      continue;
    }
    if (acc.amount !== "1" || acc.decimals !== 0) {
      skippedNfts.push({
        mint: acc.mint,
        tokenAccount: acc.tokenAccount,
        reason: "Not a 1-supply 0-decimal token",
      });
      continue;
    }
    if (acc.programId === token2022ProgramStr) {
      skippedNfts.push({
        mint: acc.mint,
        tokenAccount: acc.tokenAccount,
        reason: "Token-2022 — outside legacy NFT scope",
      });
      continue;
    }
    if (acc.programId !== splTokenProgramStr) {
      skippedNfts.push({
        mint: acc.mint,
        tokenAccount: acc.tokenAccount,
        reason: `Unsupported token program ${acc.programId.slice(0, 8)}…`,
      });
      continue;
    }
    // mintsAllowed is intentionally NOT applied here — we walk every NFT
    // so burnableCandidates reflects the full wallet. The user-selected
    // subset is filtered post-confirmation when picking included items.
    if (seen.has(acc.tokenAccount)) continue;
    seen.add(acc.tokenAccount);
    coarse.push(acc);
  }

  const confirmations = await confirmLegacyNfts(coarse);

  // Helius DAS enrichment. The on-chain Metadata.data.name field is often
  // empty (the real name lives in off-chain JSON), so without this pass
  // most candidates show as "metadata not yet loaded" in the UI. DAS
  // resolves both layers in a single batched call. Fails open: if Helius
  // is unavailable, the on-chain bytes we already extracted are kept.
  await enrichLegacyConfirmationsWithDas(confirmations);

  const burnable: LegacyNftConfirmation[] = [];
  for (const c of confirmations) {
    if (c.isBurnable) burnable.push(c);
    else {
      skippedNfts.push({
        mint: c.mint,
        tokenAccount: c.tokenAccount,
        reason: c.unburnableReason ?? "Not burnable in this milestone",
      });
    }
  }

  // Diagnostic — surface why the burnable count came out as it did. One
  // concise line per discovery, dumped to backend logs so we can see the
  // wallet-level classification breakdown without a UI roundtrip.
  {
    const tsBuckets: Record<string, number> = {};
    for (const c of confirmations) {
      const ts =
        c.isProgrammable
          ? c.isEdition
            ? "ProgrammableNonFungibleEdition"
            : "ProgrammableNonFungible"
          : c.isEdition
            ? "NonFungibleEdition"
            : c.isLegacy
              ? "NonFungible"
              : c.unburnableReason?.startsWith("Failed to decode")
                ? "decodeFailed"
                : c.unburnableReason?.startsWith("Metadata account not found")
                  ? "noMetadataAccount"
                  : "nullOrOther";
      tsBuckets[ts] = (tsBuckets[ts] ?? 0) + 1;
    }
    const reasonBuckets: Record<string, number> = {};
    for (const s of skippedNfts) {
      reasonBuckets[s.reason] = (reasonBuckets[s.reason] ?? 0) + 1;
    }
    console.log(
      `[legacyNftBurn] classify ${ownerStr}: scan.nft=${scan.nftTokenAccounts.length} coarse=${coarse.length} confirmed=${confirmations.length} burnable=${burnable.length} tokenStandard=${JSON.stringify(tsBuckets)} skipReasons=${JSON.stringify(reasonBuckets)}`,
    );
  }

  // Token-account lookup needed for both reclaim-SOL math and buildTx's
  // per-NFT account list.
  const tokenAccountByMint = new Map<string, ScannedTokenAccount>();
  for (const acc of coarse) tokenAccountByMint.set(acc.mint, acc);

  // Full burnable candidate list — what the frontend renders in the
  // selectable table. Includes every NFT that passed static checks,
  // regardless of which subset will fit the current tx.
  const burnableCandidates: BurnableLegacyCandidate[] = burnable.map((c) => {
    const acc = tokenAccountByMint.get(c.mint);
    const reclaimLamports = Math.max(
      0,
      acc
        ? acc.lamports + c.metadataLamports + c.masterEditionLamports
        : c.metadataLamports + c.masterEditionLamports,
    );
    return {
      mint: c.mint,
      tokenAccount: c.tokenAccount,
      name: c.name,
      symbol: c.symbol,
      image: c.image,
      estimatedGrossReclaimSol: reclaimLamports / LAMPORTS_PER_SOL,
      metadata: c.metadataPda,
      masterEdition: c.masterEditionPda,
      collection: c.collection,
    };
  });

  // Pick the user-selected subset (or fall back to all burnable on
  // discovery calls), then cap at LEGACY_INITIAL_BATCH_CAP as a safety
  // bound on the initial attempt. The actual included count is decided by
  // the size-trim + sim-trim loops below — verified-collection NFTs ship
  // an extra writable account so per-ix size is larger than vanilla.
  const selected = mintsAllowed
    ? burnable.filter((c) => mintsAllowed.has(c.mint))
    : burnable;
  let included = selected.slice(0, LEGACY_INITIAL_BATCH_CAP);
  const priorityFeeMicrolamports = readPriorityFeeMicrolamports();
  const burnableByMint = new Map(burnableCandidates.map((c) => [c.mint, c]));
  // Helper: compute the leftover items the user can try in the next
  // batch — anything they selected (or all on discovery) that isn't in
  // the final `included` and isn't isolated as a sim failure.
  const computeNextBatch = (
    finalIncluded: LegacyNftConfirmation[],
    isolatedMint: string | null,
  ): BurnableLegacyCandidate[] => {
    const includedSet = new Set(finalIncluded.map((c) => c.mint));
    return selected
      .filter((c) => !includedSet.has(c.mint) && c.mint !== isolatedMint)
      .map((c) => burnableByMint.get(c.mint))
      .filter((c): c is BurnableLegacyCandidate => c !== undefined);
  };

  if (included.length === 0) {
    return {
      burnCount: 0,
      totalBurnable: burnable.length,
      includedNfts: [],
      skippedNfts,
      estimatedGrossReclaimSol: 0,
      estimatedBaseFeeSol: 0,
      estimatedPriorityFeeSol: 0,
      estimatedFeeSol: 0,
      estimatedNetReclaimSol: 0,
      computeUnitLimit: 0,
      priorityFeeMicrolamports,
      transactionBase64: null,
      blockhash: null,
      lastValidBlockHeight: null,
      transactionVersion: "legacy",
      feePayer: ownerStr,
      requiresSignatureFrom: ownerStr,
      warning: LEGACY_NFT_BURN_WARNING,
      simulationOk: true,
      burnableCandidates,
      maxPerTx: LEGACY_INITIAL_BATCH_CAP,
      nextBatchCandidates: computeNextBatch([], null),
    };
  }

  let blockhash: string;
  let lastValidBlockHeight: number;
  try {
    const got = await connection.getLatestBlockhash();
    blockhash = got.blockhash;
    lastValidBlockHeight = got.lastValidBlockHeight;
  } catch (err) {
    // Discovery must never 500. If the blockhash fetch fails, return an
    // envelope without a tx — frontend gets the burnableCandidates list
    // for the selectable grid and can retry on Build.
    console.warn(
      `[legacyNftBurn] getLatestBlockhash failed for ${ownerStr}: ${(err as Error)?.message ?? err}`,
    );
    return {
      burnCount: 0,
      totalBurnable: burnable.length,
      includedNfts: [],
      skippedNfts,
      estimatedGrossReclaimSol: 0,
      estimatedBaseFeeSol: 0,
      estimatedPriorityFeeSol: 0,
      estimatedFeeSol: 0,
      estimatedNetReclaimSol: 0,
      computeUnitLimit: 0,
      priorityFeeMicrolamports,
      transactionBase64: null,
      blockhash: null,
      lastValidBlockHeight: null,
      transactionVersion: "legacy",
      feePayer: ownerStr,
      requiresSignatureFrom: ownerStr,
      warning: LEGACY_NFT_BURN_WARNING,
      simulationOk: false,
      simulationError: "RPC busy fetching blockhash. Try again.",
      burnableCandidates,
      maxPerTx: LEGACY_INITIAL_BATCH_CAP,
      nextBatchCandidates: computeNextBatch([], null),
    };
  }

  const buildTx = (
    items: LegacyNftConfirmation[],
    cuLimit: number,
  ): { tx: Transaction; serialized: Uint8Array } => {
    const t = new Transaction();
    t.add(ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }));
    if (priorityFeeMicrolamports > 0) {
      t.add(
        ComputeBudgetProgram.setComputeUnitPrice({
          microLamports: priorityFeeMicrolamports,
        }),
      );
    }
    for (const c of items) {
      const acc = tokenAccountByMint.get(c.mint)!;
      const mint = new PublicKey(c.mint);
      const tokenAccount = new PublicKey(acc.tokenAccount);
      const metadata = new PublicKey(c.metadataPda);
      const masterEdition = new PublicKey(c.masterEditionPda);
      // BurnV1 / TokenStandard.NonFungible — see comment in
      // buildStandardNftBurnTx for the full account-set rationale.
      // Verified-collection NFTs need the parent collection's Metadata PDA
      // in `collectionMetadata`; confirmLegacyNfts has already validated
      // the account exists on-chain and recorded the PDA. Without this
      // slot, Phantom flags the tx as "reverted during simulation".
      t.add(
        createMetaplexBurnInstruction(
          {
            authority: owner,
            metadata,
            edition: masterEdition,
            mint,
            token: tokenAccount,
            sysvarInstructions: SYSVAR_INSTRUCTIONS_PUBKEY,
            splTokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
            ...(c.collectionMetadataPda
              ? { collectionMetadata: new PublicKey(c.collectionMetadataPda) }
              : {}),
          },
          { burnArgs: { __kind: "V1", amount: 1n } },
        ),
      );
    }
    t.recentBlockhash = blockhash;
    t.lastValidBlockHeight = lastValidBlockHeight;
    t.feePayer = owner;
    const ser = t.serialize({ requireAllSignatures: false, verifySignatures: false });
    return { tx: t, serialized: ser };
  };

  // ============================================================================
  // Tx-size trim — wrap buildTx in try/catch so a "Transaction too large"
  // throw at serialize-time also triggers a tail trim instead of escaping.
  // (web3.js's t.serialize() throws synchronously on oversize; the previous
  // post-build size check never fired in that case.)
  // ============================================================================
  let computeUnitLimit = CU_PER_NFT_BURN * included.length + CU_HEADROOM;
  let built: { tx: Transaction; serialized: Uint8Array } | null = null;
  let isolated: LegacyNftBurnSkippedEntry | null = null;
  while (included.length > 0) {
    let attempt: { tx: Transaction; serialized: Uint8Array } | null = null;
    let buildErr: Error | null = null;
    try {
      attempt = buildTx(included, computeUnitLimit);
    } catch (err) {
      buildErr = err as Error;
    }
    const oversized =
      buildErr !== null ||
      (attempt !== null && attempt.serialized.length > MAX_TX_SIZE_BYTES);
    if (!oversized && attempt) {
      built = attempt;
      break;
    }
    // Genuine non-size error — let the outer fail-open wrapper handle.
    if (buildErr && !/transaction too large|exceeds.*packet|encode.*too|exceeds.*size/i.test(buildErr.message)) {
      throw buildErr;
    }
    if (included.length === 1) {
      isolated = {
        mint: included[0].mint,
        tokenAccount: included[0].tokenAccount,
        reason: "Single NFT burn transaction exceeds Solana packet size",
      };
      included = [];
      built = null;
      break;
    }
    included = included.slice(0, -1);
    computeUnitLimit = CU_PER_NFT_BURN * included.length + CU_HEADROOM;
  }

  // ============================================================================
  // Preflight simulation — sim-trim loop.
  // Each iteration: simulate the current `included` batch. On success, exit.
  // On failure, trim the tail by one and rebuild. If the loop bottoms out at
  // size 1 with a still-failing tx, isolate that single item to skippedNfts
  // with a reason — the next batch will try the rest. Each sim is one RPC
  // call, so worst case = LEGACY_INITIAL_BATCH_CAP RPCs (rare; only when
  // one bad item sits at or near the head of the selection).
  // ============================================================================
  let simulationOk = false;
  let simulationError: string | undefined;
  // Tracks the previous attempt's friendly error string. When two consecutive
  // shrinks fail with the SAME error, further trimming is futile — the bad
  // item isn't at the tail. Bail with the head isolated so the UI can move
  // on instead of burning ~30-60s of RPC time on guaranteed-failure sims.
  let prevSimErr: string | undefined;
  while (built !== null && included.length > 0) {
    let simErr: string | undefined;
    try {
      console.log(
        `[legacyNftBurn] simulateTransaction start owner=${ownerStr} batch=${included.length}`,
      );
      const simStart = Date.now();
      // 20s hard timeout — public mainnet-beta sometimes hangs indefinitely
      // on simulate, leaving the user with a forever-spinning "Preparing…".
      // Cleaner to fail fast and surface a clear error than to hang.
      const sim = await Promise.race([
        connection.simulateTransaction(built.tx),
        new Promise<never>((_, rej) =>
          setTimeout(
            () => rej(new Error("simulateTransaction timed out after 20s — RPC unresponsive")),
            20_000,
          ),
        ),
      ]);
      console.log(
        `[legacyNftBurn] simulateTransaction done owner=${ownerStr} batch=${included.length} ms=${Date.now() - simStart} err=${sim.value.err ? "yes" : "no"}`,
      );
      if (!sim.value.err) {
        simulationOk = true;
        break;
      }
      simErr = parseSimulationError(sim.value.err, sim.value.logs ?? []);
      console.warn(
        `[legacyNftBurn] preflight rejected for ${ownerStr} at batch=${included.length}: friendly="${simErr}" rawErr=${JSON.stringify(sim.value.err)} logs=${JSON.stringify(sim.value.logs ?? [])}`,
      );
    } catch (err) {
      simErr =
        err instanceof Error ? err.message : "Simulation request failed";
      console.warn(
        `[legacyNftBurn] preflight call failed for ${ownerStr} at batch=${included.length}: ${(err as Error)?.message ?? err}`,
      );
    }
    // Fast-fail when the same friendly error repeats — trimming clearly
    // isn't fixing it (bad item at head, or a deterministic per-batch
    // issue like "Missing collection metadata account"). Isolating the
    // head lets the user retry the rest immediately.
    if (prevSimErr !== undefined && prevSimErr === simErr && included.length > 1) {
      console.warn(
        `[legacyNftBurn] fast-fail for ${ownerStr}: same error twice ("${simErr}"), isolating head ${included[0].mint}`,
      );
      isolated = {
        mint: included[0].mint,
        tokenAccount: included[0].tokenAccount,
        reason: `Preflight rejected: ${simErr}`,
      };
      simulationError = simErr;
      included = [];
      built = null;
      break;
    }
    prevSimErr = simErr;
    if (included.length === 1) {
      isolated = {
        mint: included[0].mint,
        tokenAccount: included[0].tokenAccount,
        reason: `Preflight rejected: ${simErr}`,
      };
      simulationError = simErr;
      included = [];
      built = null;
      break;
    }
    included = included.slice(0, -1);
    computeUnitLimit = CU_PER_NFT_BURN * included.length + CU_HEADROOM;
    try {
      built = buildTx(included, computeUnitLimit);
    } catch (err) {
      // Defensive: trimming SHOULD shrink size, so a too-large here is
      // unexpected. Treat as preflight failure for this batch.
      simErr =
        err instanceof Error ? err.message : "Build after trim failed";
      console.warn(
        `[legacyNftBurn] rebuild after trim failed for ${ownerStr} at batch=${included.length}: ${simErr}`,
      );
      simulationError = simErr;
      included = [];
      built = null;
      break;
    }
  }

  if (isolated) skippedNfts.push(isolated);

  // No items survived simulation — empty envelope with the isolated reason
  // so the UI can explain why nothing built.
  if (included.length === 0 || built === null) {
    return {
      burnCount: 0,
      totalBurnable: burnable.length,
      includedNfts: [],
      skippedNfts,
      estimatedGrossReclaimSol: 0,
      estimatedBaseFeeSol: 0,
      estimatedPriorityFeeSol: 0,
      estimatedFeeSol: 0,
      estimatedNetReclaimSol: 0,
      computeUnitLimit: 0,
      priorityFeeMicrolamports,
      transactionBase64: null,
      blockhash: null,
      lastValidBlockHeight: null,
      transactionVersion: "legacy",
      feePayer: ownerStr,
      requiresSignatureFrom: ownerStr,
      warning: LEGACY_NFT_BURN_WARNING,
      simulationOk: false,
      simulationError,
      burnableCandidates,
      maxPerTx: LEGACY_INITIAL_BATCH_CAP,
      nextBatchCandidates: computeNextBatch([], isolated?.mint ?? null),
    };
  }

  const baseFeeLamports = BASE_FEE_LAMPORTS_PER_SIGNATURE;
  const priorityFeeLamports =
    priorityFeeMicrolamports > 0
      ? Math.ceil((priorityFeeMicrolamports * computeUnitLimit) / 1_000_000)
      : 0;
  const totalFeeLamports = baseFeeLamports + priorityFeeLamports;

  const includedNfts: LegacyNftBurnIncludedEntry[] = included.map((c) => {
    const acc = tokenAccountByMint.get(c.mint)!;
    const reclaimLamports = Math.max(
      0,
      acc.lamports + c.metadataLamports + c.masterEditionLamports,
    );
    return {
      mint: c.mint,
      tokenAccount: c.tokenAccount,
      metadata: c.metadataPda,
      masterEdition: c.masterEditionPda,
      name: c.name,
      symbol: c.symbol,
      image: c.image,
      estimatedGrossReclaimSol: reclaimLamports / LAMPORTS_PER_SOL,
      reason:
        "Standard NonFungible — full BurnV1 (token + metadata + master edition)",
    };
  });
  const grossReclaimSol = includedNfts.reduce(
    (sum, e) => sum + e.estimatedGrossReclaimSol,
    0,
  );
  const estimatedFeeSol = totalFeeLamports / LAMPORTS_PER_SOL;
  const estimatedNetReclaimSol = Math.max(0, grossReclaimSol - estimatedFeeSol);

  return {
    burnCount: includedNfts.length,
    totalBurnable: burnable.length,
    includedNfts,
    skippedNfts,
    estimatedGrossReclaimSol: grossReclaimSol,
    estimatedBaseFeeSol: baseFeeLamports / LAMPORTS_PER_SOL,
    estimatedPriorityFeeSol: priorityFeeLamports / LAMPORTS_PER_SOL,
    estimatedFeeSol,
    estimatedNetReclaimSol,
    computeUnitLimit,
    priorityFeeMicrolamports,
    transactionBase64: Buffer.from(built.serialized).toString("base64"),
    blockhash,
    lastValidBlockHeight,
    transactionVersion: "legacy",
    feePayer: ownerStr,
    requiresSignatureFrom: ownerStr,
    warning: LEGACY_NFT_BURN_WARNING,
    simulationOk,
    burnableCandidates,
    maxPerTx: LEGACY_INITIAL_BATCH_CAP,
    nextBatchCandidates: computeNextBatch(included, isolated?.mint ?? null),
  };
}

// ============================================================================
// Milestone 2 — Programmable NFT (pNFT) burn (BurnV1, max-reclaim).
//
// pNFT BurnV1 needs additional accounts beyond the legacy form:
//   - Token Record PDA at  ["metadata", TOKEN_METADATA_PROGRAM_ID, mint,
//                           "token_record", tokenAccount]
//   - authorizationRules + authorizationRulesProgram if metadata's
//     programmableConfig.ruleSet is set
//
// Scope (Milestone 2):
//   ✓ ProgrammableNonFungible (no active ruleset)
//   ✗ ProgrammableNonFungible WITH a ruleSet — skipped with reason
//     (current package builder doesn't pass authorizationRules; ruleset-
//     governed burns can revert at simulation time, requires a different
//     handling path)
//   ✗ ProgrammableNonFungibleEdition — deferred (master edition / edition
//     marker plumbing same complexity story as legacy NonFungibleEdition)
//   ✗ Tokens missing a Token Record PDA — old pNFTs minted pre-token-record
//     era won't have one; skipped with reason rather than guessing
// ============================================================================

const PNFT_BURN_WARNING =
  "Burns Programmable NFTs irreversibly via BurnV1 and closes their Metadata + Master Edition + Token Record accounts. Verify each mint manually before signing — burned NFTs cannot be recovered.";

// Safety cap — see MAX_NFT_BURN_PER_TX comment. pNFT ix carries token
// record + (optional) auth-rules + collection metadata, so it's wider than
// legacy; lower safety cap reflects that. Sim-trim loop trims further as
// needed. Dropped to 5 because real-wallet pNFTs with verified-collection
// metadata overflow the 1 232-byte packet cap at 6+ ixs; the size-trim
// loop at the build call site handles further trims.
export const MAX_PNFT_BURN_PER_TX = 5;

// Metaplex Token Auth Rules program. Required as account #14 in BurnV1
// when the pNFT's metadata.programmableConfig.ruleSet is set. The v2.13.0
// mpl-token-metadata helper doesn't expose authorizationRules /
// authorizationRulesProgram fields, so we append them manually after
// creating the ix — see buildPnftBurnTx.
const AUTH_RULES_PROGRAM_ID = new PublicKey(
  "auth9SigNpDKz4sJJ1DfCTuZrZNSAgh9sFD3rboVmgg",
);

// Token Record PDA: governs delegate / lock state on pNFTs. BurnV1 closes
// it as part of the burn so its rent is part of the gross reclaim.
function deriveTokenRecordPda(
  mint: PublicKey,
  tokenAccount: PublicKey,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("metadata"),
      TOKEN_METADATA_PROGRAM_ID.toBuffer(),
      mint.toBuffer(),
      Buffer.from("token_record"),
      tokenAccount.toBuffer(),
    ],
    TOKEN_METADATA_PROGRAM_ID,
  )[0];
}

// Pulls the rule-set pubkey out of metadata.programmableConfig if present.
// Returns null when there's no programmable config OR the ruleSet is unset.
// We treat both as "no active ruleset" — the burn can proceed without
// auth_rules accounts in those cases.
function extractRuleSet(programmableConfig: unknown): string | null {
  if (!programmableConfig || typeof programmableConfig !== "object") return null;
  const cfg = programmableConfig as Record<string, unknown>;
  // Beet decodes the V1 variant as `{ __kind: "V1", ruleSet: PublicKey | null }`.
  if (cfg.__kind !== "V1") return null;
  const rs = cfg.ruleSet;
  if (!rs) return null;
  // PublicKey instance has toBase58; null/undefined returns above.
  if (typeof rs === "object" && typeof (rs as { toBase58?: () => string }).toBase58 === "function") {
    return (rs as { toBase58: () => string }).toBase58();
  }
  return null;
}

export interface PnftConfirmation {
  mint: string;
  tokenAccount: string;
  isProgrammable: boolean;
  isProgrammableEdition: boolean;
  hasRuleSet: boolean;
  ruleSet: string | null;
  hasTokenRecord: boolean;
  isBurnable: boolean;
  unburnableReason?: string;
  metadataPda: string;
  masterEditionPda: string;
  tokenRecordPda: string;
  metadataLamports: number;
  masterEditionLamports: number;
  tokenRecordLamports: number;
  name: string | null;
  symbol: string | null;
  // Off-chain JSON metadata (image URL). Populated by the Helius DAS
  // enrichment pass in buildPnftBurnTx; null on confirm-time.
  image: string | null;
  // Set when the pNFT belongs to a verified Metaplex collection AND that
  // collection's Metadata account exists on-chain. BurnV1 requires this
  // PDA in the `collectionMetadata` slot for collection-verified pNFTs;
  // omitting it results in a "Missing collection metadata account" error
  // (Custom 103 from the Token Metadata program).
  collectionMetadataPda: string | null;
  // Verified collection MINT. Used by the frontend to group candidates by
  // collection in the selection UI.
  collection: string | null;
}

// Pulls verified-collection key out of decoded metadata. Returns null when
// the pNFT has no collection or the collection record is unverified — only
// VERIFIED collections require the parent metadata in BurnV1.
function extractVerifiedCollectionMint(
  collection: unknown,
): PublicKey | null {
  if (!collection || typeof collection !== "object") return null;
  const c = collection as Record<string, unknown>;
  if (c.verified !== true) return null;
  const key = c.key;
  if (
    !key ||
    typeof key !== "object" ||
    typeof (key as { toBase58?: () => string }).toBase58 !== "function"
  ) {
    return null;
  }
  return new PublicKey((key as { toBase58: () => string }).toBase58());
}

async function confirmPnfts(
  candidates: ScannedTokenAccount[],
): Promise<PnftConfirmation[]> {
  if (candidates.length === 0) return [];

  const mintPks = candidates.map((c) => new PublicKey(c.mint));
  const tokenAccountPks = candidates.map((c) => new PublicKey(c.tokenAccount));
  const pdas = candidates.map((_, i) => ({
    metadata: deriveMetadataPda(mintPks[i]),
    masterEdition: deriveMasterEditionPda(mintPks[i]),
    tokenRecord: deriveTokenRecordPda(mintPks[i], tokenAccountPks[i]),
  }));
  const flat: PublicKey[] = [];
  for (const p of pdas) flat.push(p.metadata, p.masterEdition, p.tokenRecord);

  const infos: ({ data: Buffer; lamports: number } | null)[] = [];
  for (let i = 0; i < flat.length; i += 100) {
    const chunk = flat.slice(i, i + 100);
    try {
      const res = await connection.getMultipleAccountsInfo(chunk);
      for (const info of res) {
        infos.push(
          info ? { data: Buffer.from(info.data), lamports: info.lamports } : null,
        );
      }
    } catch (err) {
      // Fail open — see confirmLegacyNfts Pass 1. RPC throw here used to
      // 500 the whole pNFT discovery; now it falls through as nulls.
      console.warn(
        `[pnftBurn] confirm Pass 1 chunk RPC failed (offset=${i}, size=${chunk.length}): ${(err as Error)?.message ?? err}`,
      );
      for (let j = 0; j < chunk.length; j++) infos.push(null);
    }
  }

  // Pass 2 prep: identify pNFTs with verified collections so we can derive
  // and fetch the parent collection's Metadata PDA. Indices align with
  // `candidates`. Done here (after Pass 1) because we need the decoded
  // metadata.collection field.
  const collectionMintByCandidateIdx = new Map<number, PublicKey>();
  // Populated alongside the main loop below.

  const out: PnftConfirmation[] = [];
  for (let i = 0; i < candidates.length; i++) {
    const acc = candidates[i];
    const metaInfo = infos[i * 3];
    const editionInfo = infos[i * 3 + 1];
    const tokenRecordInfo = infos[i * 3 + 2];
    const base = {
      mint: acc.mint,
      tokenAccount: acc.tokenAccount,
      metadataPda: pdas[i].metadata.toBase58(),
      masterEditionPda: pdas[i].masterEdition.toBase58(),
      tokenRecordPda: pdas[i].tokenRecord.toBase58(),
      metadataLamports: metaInfo?.lamports ?? 0,
      masterEditionLamports: editionInfo?.lamports ?? 0,
      tokenRecordLamports: tokenRecordInfo?.lamports ?? 0,
      name: null as string | null,
      symbol: null as string | null,
      image: null as string | null,
    };
    if (!metaInfo) {
      out.push({
        ...base,
        isProgrammable: false,
        isProgrammableEdition: false,
        hasRuleSet: false,
        ruleSet: null,
        hasTokenRecord: !!tokenRecordInfo,
        isBurnable: false,
        unburnableReason:
          "Metadata account not found — not a Metaplex NFT or already burned",
        collectionMetadataPda: null,
        collection: null,
      });
      continue;
    }
    let tokenStandard: number | null = null;
    let ruleSet: string | null = null;
    let name: string | null = null;
    let symbol: string | null = null;
    let verifiedCollectionMint: PublicKey | null = null;
    try {
      const [decoded] = Metadata.fromAccountInfo({
        data: metaInfo.data,
        executable: false,
        lamports: metaInfo.lamports,
        owner: TOKEN_METADATA_PROGRAM_ID,
        rentEpoch: 0,
      });
      // Same nullish-coalescing fix as confirmLegacyNfts — handles undefined.
      tokenStandard = decoded.tokenStandard ?? null;
      ruleSet = extractRuleSet(decoded.programmableConfig);
      name = stripPadding(decoded.data?.name ?? null);
      symbol = stripPadding(decoded.data?.symbol ?? null);
      verifiedCollectionMint = extractVerifiedCollectionMint(decoded.collection);
    } catch (err) {
      out.push({
        ...base,
        isProgrammable: false,
        isProgrammableEdition: false,
        hasRuleSet: false,
        ruleSet: null,
        hasTokenRecord: !!tokenRecordInfo,
        isBurnable: false,
        unburnableReason: `Failed to decode Metadata: ${(err as Error).message}`,
        collectionMetadataPda: null,
        collection: null,
      });
      continue;
    }
    if (verifiedCollectionMint) {
      collectionMintByCandidateIdx.set(i, verifiedCollectionMint);
    }
    const isProgrammable =
      tokenStandard === TokenStandard.ProgrammableNonFungible;
    const isProgrammableEdition =
      tokenStandard === TokenStandard.ProgrammableNonFungibleEdition;
    const hasTokenRecord = !!tokenRecordInfo;
    const hasRuleSet = ruleSet !== null;

    let isBurnable = false;
    let unburnableReason: string | undefined;
    if (isProgrammableEdition) {
      unburnableReason =
        "ProgrammableNonFungibleEdition — burn requires master edition + edition marker plumbing; deferred to a later milestone";
    } else if (!isProgrammable) {
      unburnableReason =
        tokenStandard === null
          ? "Metadata has no tokenStandard"
          : tokenStandard === TokenStandard.NonFungible ||
              tokenStandard === TokenStandard.NonFungibleEdition
            ? "Legacy Metaplex NFT — use legacy-nft-burn-tx"
            : `Unsupported tokenStandard ${tokenStandard}`;
    } else if (!hasTokenRecord) {
      // Most modern pNFTs always have a token record; the rare exception
      // is pre-token-record era pNFTs which existed briefly.
      unburnableReason =
        "Token Record PDA not found — pre-token-record pNFT, can't safely build BurnV1";
    } else {
      // Ruleset-governed pNFTs now qualify — buildPnftBurnTx appends the
      // auth-rules accounts and runs a preflight simulation.
      isBurnable = true;
    }

    out.push({
      ...base,
      name,
      symbol,
      isProgrammable,
      isProgrammableEdition,
      hasRuleSet,
      ruleSet,
      hasTokenRecord,
      isBurnable,
      unburnableReason,
      collectionMetadataPda: null, // populated in Pass 2 below for verified collections
      collection: verifiedCollectionMint
        ? verifiedCollectionMint.toBase58()
        : null,
    });
  }

  // Pass 2: fetch each verified collection's parent Metadata account.
  // We need it to (a) confirm the account actually exists on-chain (some
  // pNFTs reference deleted/never-created collections), and (b) hand its
  // PDA to BurnV1 as `collectionMetadata` so the program can do the
  // sized-collection bookkeeping at burn time.
  const collectionEntries = [...collectionMintByCandidateIdx.entries()];
  if (collectionEntries.length > 0) {
    const collectionPdas = collectionEntries.map(([, mint]) =>
      deriveMetadataPda(mint),
    );
    const collectionInfos: ({ data: Buffer; lamports: number } | null)[] = [];
    for (let i = 0; i < collectionPdas.length; i += 100) {
      const chunk = collectionPdas.slice(i, i + 100);
      try {
        const res = await connection.getMultipleAccountsInfo(chunk);
        for (const info of res) {
          collectionInfos.push(
            info
              ? { data: Buffer.from(info.data), lamports: info.lamports }
              : null,
          );
        }
      } catch (err) {
        // Same fail-open pattern as confirmLegacyNfts Pass 2.
        console.warn(
          `[pnftBurn] confirm Pass 2 chunk RPC failed (offset=${i}, size=${chunk.length}): ${(err as Error)?.message ?? err}`,
        );
        for (let j = 0; j < chunk.length; j++) collectionInfos.push(null);
      }
    }
    for (let k = 0; k < collectionEntries.length; k++) {
      const [candidateIdx, collectionMint] = collectionEntries[k];
      const colInfo = collectionInfos[k];
      const colPda = collectionPdas[k].toBase58();
      const conf = out[candidateIdx];
      console.log("[pnftBurn] collection metadata", {
        mint: conf.mint,
        collectionMint: collectionMint.toBase58(),
        collectionMetadata: colInfo ? colPda : null,
      });
      // Strict: pNFT BurnV1 rejects collection-verified pNFTs (`0x67 /
      // Missing collection metadata account`) when the
      // `collectionMetadata` slot isn't supplied. Mirror the legacy
      // section's strict pre-skip so the failure surfaces as a clean
      // discovery skip with a clear reason instead of a preflight
      // rejection that mass-trims the batch.
      if (colInfo) {
        conf.collectionMetadataPda = colPda;
      } else {
        conf.isBurnable = false;
        conf.unburnableReason = "Missing verified collection metadata account";
      }
    }
  }

  return out;
}

export interface BuildPnftBurnTxOptions {
  mints?: string[];
}

export interface PnftBurnIncludedEntry {
  mint: string;
  tokenAccount: string;
  metadata: string;
  masterEdition: string;
  tokenRecord: string;
  name: string | null;
  symbol: string | null;
  image: string | null;
  estimatedGrossReclaimSol: number;
  reason: string;
}

export interface PnftBurnSkippedEntry {
  mint: string;
  tokenAccount: string;
  reason: string;
  // Optional metadata fields — historically populated for cap-overflow /
  // tx-size-trimmed entries. Now redundant since burnableCandidates carries
  // the full pNFT list; kept optional for backwards-compat.
  name?: string | null;
  symbol?: string | null;
  image?: string | null;
  estimatedGrossReclaimSol?: number;
  metadata?: string;
  masterEdition?: string;
  tokenRecord?: string;
  ruleSet?: string | null;
  collectionMetadata?: string | null;
}

export interface BurnablePnftCandidate {
  mint: string;
  tokenAccount: string;
  name: string | null;
  symbol: string | null;
  image: string | null;
  estimatedGrossReclaimSol: number;
  metadata: string;
  masterEdition: string;
  tokenRecord: string;
  ruleSet: string | null;
  collectionMetadata: string | null;
  // Verified collection MINT — drives frontend grouping in the
  // selectable candidate list. Null when the pNFT is standalone.
  collection: string | null;
}

export interface BuildPnftBurnTxResult {
  burnCount: number;
  totalBurnable: number;
  includedPnfts: PnftBurnIncludedEntry[];
  skippedPnfts: PnftBurnSkippedEntry[];
  estimatedGrossReclaimSol: number;
  estimatedBaseFeeSol: number;
  estimatedPriorityFeeSol: number;
  estimatedFeeSol: number;
  estimatedNetReclaimSol: number;
  computeUnitLimit: number;
  priorityFeeMicrolamports: number;
  transactionBase64: string | null;
  // Captured from the same getLatestBlockhash() that built the tx; both
  // null when transactionBase64 is null. See BuildBurnAndCloseTxResult.
  blockhash: string | null;
  lastValidBlockHeight: number | null;
  transactionVersion: "legacy";
  feePayer: string;
  requiresSignatureFrom: string;
  warning: string;
  // Preflight simulation outcome. `simulationOk` is true when the
  // unsigned tx simulated successfully end-to-end; false if the chain
  // would have rejected (most commonly an auth-rules ruleset block).
  // When false, all included pNFTs are moved to skippedPnfts and
  // transactionBase64 is null per spec.
  simulationOk: boolean;
  simulationError?: string;
  // Full burnable list — see BuildLegacyNftBurnTxResult.burnableCandidates.
  burnableCandidates: BurnablePnftCandidate[];
  maxPerTx: number;
  // See BuildLegacyNftBurnTxResult.nextBatchCandidates.
  nextBatchCandidates: BurnablePnftCandidate[];
}

// Friendly mapping for the most common Token Metadata / auth-rules custom
// error codes returned by simulateTransaction. We only list codes we've
// confirmed in the wild; unknown codes get a generic "Token Metadata program
// error N" envelope so the user still sees the number for support purposes.
//
// 103 — empirically returned by Metaplex when a pNFT's auth-rules ruleset
// rejects the burn (or the rule-set account is missing required state).
// The pattern we saw on a real wallet was {"InstructionError":[1,{"Custom":103}]}
// across multiple distinct rulesets, all matching this case.
const METAPLEX_CUSTOM_ERROR_MESSAGES: Record<number, string> = {
  103: "Ruleset rejected burn. This collection may block burning or require additional authorization.",
};

// Walks an arbitrary RPC error object looking for the `Custom: N` shape.
// Solana RPC commonly returns either:
//   { InstructionError: [ixIndex, { Custom: N }] }
//   { Custom: N }
function extractCustomCode(err: unknown): number | null {
  if (!err || typeof err !== "object") return null;
  const obj = err as Record<string, unknown>;
  if (typeof obj.Custom === "number") return obj.Custom;
  if (Array.isArray(obj.InstructionError) && obj.InstructionError.length >= 2) {
    const inner = obj.InstructionError[1];
    if (
      inner &&
      typeof inner === "object" &&
      typeof (inner as Record<string, unknown>).Custom === "number"
    ) {
      return (inner as Record<string, number>).Custom;
    }
  }
  return null;
}

// Extracts a *friendly* simulation error reason. Walks logs first (most
// specific), then falls back to known custom-error mappings, then to a
// generic "Token Metadata program error N", and finally to a stringified
// error. Raw payload stays available in the backend log via the caller.
function parseSimulationError(err: unknown, logs: string[]): string {
  // 1. Prefer log-level signal — typically clearer than the numeric code.
  // Walk OLDEST → NEWEST: program lifecycle rejections (freeze plugin,
  // ruleset deny) emit their root-cause log line BEFORE the catch-all
  // "Invalid Authority" / generic-reject lines that follow. Earliest-match
  // wins.
  for (let i = 0; i < logs.length; i++) {
    const log = (logs[i] ?? "").trim();
    if (!log) continue;
    // --- Core plugin lifecycle rejections (Milestone 3) ---
    if (/permanent_freeze_delegate.*reject/i.test(log)) {
      return "Asset has a Permanent Freeze Delegate plugin — unfreeze it before burning.";
    }
    if (/freeze_delegate.*reject/i.test(log)) {
      return "Asset has a Freeze Delegate plugin and is frozen. Unfreeze before burning.";
    }
    if (/permanent_burn_delegate.*reject/i.test(log)) {
      return "Asset has a Permanent Burn Delegate plugin — burn must be issued by the delegate.";
    }
    if (/lifecycle.*reject/i.test(log)) {
      return "Asset plugin rejected the burn (lifecycle hook). Common causes: Freeze, Royalty, or Permanent plugin.";
    }
    if (/invalid authority/i.test(log)) {
      return "Asset's plugin chain rejected this authority. Owner-burn may be blocked by a Freeze / Permanent plugin.";
    }
    // --- Token Metadata (legacy NFT / pNFT) signals ---
    // Collection-verified NFTs: program demands the real collection
    // Metadata PDA in the `collectionMetadata` slot. Fires for legacy
    // BurnV1 too (custom error 0x67), not just pNFT — keep the wording
    // generic.
    if (/missing collection metadata/i.test(log)) {
      return "Collection-verified NFT requires parent collection metadata account";
    }
    if (/token record.*lock/i.test(log)) {
      return "Token record is locked. Unfreeze the pNFT before burning.";
    }
    if (/auth.?rules?/i.test(log)) {
      return `Ruleset rejected burn — ${log.replace(/^Program log:\s*/i, "")}`;
    }
    if (/operation not allowed/i.test(log)) {
      return `Operation not allowed by ruleset — ${log}`;
    }
    if (/pubkey ?mismatch/i.test(log)) {
      return `Ruleset pubkey mismatch — ${log}`;
    }
    if (/insufficient/i.test(log)) {
      return log;
    }
  }
  // 2. Map known Metaplex custom error codes to friendly copy.
  const code = extractCustomCode(err);
  if (code !== null) {
    if (METAPLEX_CUSTOM_ERROR_MESSAGES[code]) {
      return METAPLEX_CUSTOM_ERROR_MESSAGES[code];
    }
    // Fallback is program-agnostic — both Token Metadata and Core can
    // surface custom codes, and the caller's context (which builder is
    // running) is what disambiguates. Keeping the message neutral avoids
    // mislabeling a Core error as "Token Metadata program error N".
    return `On-chain program error ${code}`;
  }
  // 3. Last-resort fallbacks.
  if (typeof err === "string") return err;
  return "Unknown simulation error";
}

// Public entry point. See buildLegacyNftBurnTx for the wrapper rationale.
export async function buildPnftBurnTx(
  address: string,
  opts: BuildPnftBurnTxOptions = {},
): Promise<BuildPnftBurnTxResult> {
  const owner = new PublicKey(address);
  const ownerStr = owner.toBase58();
  try {
    return await buildPnftBurnTxImpl(owner, ownerStr, opts);
  } catch (err) {
    console.warn(
      `[pnftBurn] discovery failed unexpectedly for ${ownerStr}: ${(err as Error)?.message ?? err}`,
    );
    return {
      burnCount: 0,
      totalBurnable: 0,
      includedPnfts: [],
      skippedPnfts: [],
      estimatedGrossReclaimSol: 0,
      estimatedBaseFeeSol: 0,
      estimatedPriorityFeeSol: 0,
      estimatedFeeSol: 0,
      estimatedNetReclaimSol: 0,
      computeUnitLimit: 0,
      priorityFeeMicrolamports: 0,
      transactionBase64: null,
      blockhash: null,
      lastValidBlockHeight: null,
      transactionVersion: "legacy",
      feePayer: ownerStr,
      requiresSignatureFrom: ownerStr,
      warning: PNFT_BURN_WARNING,
      simulationOk: false,
      simulationError: "Discovery failed. Try again.",
      burnableCandidates: [],
      maxPerTx: MAX_PNFT_BURN_PER_TX,
      nextBatchCandidates: [],
    };
  }
}

async function buildPnftBurnTxImpl(
  owner: PublicKey,
  ownerStr: string,
  opts: BuildPnftBurnTxOptions,
): Promise<BuildPnftBurnTxResult> {
  const scan = await scanWalletForCleanup(ownerStr);
  const splTokenProgramStr = TOKEN_PROGRAM_ID.toBase58();
  const token2022ProgramStr = TOKEN_2022_PROGRAM_ID.toBase58();
  const mintsAllowed =
    opts.mints && opts.mints.length > 0 ? new Set(opts.mints) : null;
  const skippedPnfts: PnftBurnSkippedEntry[] = [];

  // Coarse pass: same shape filter as legacy. Token-2022 is excluded; pNFT
  // mints live under the classic SPL Token program.
  const seen = new Set<string>();
  const coarse: ScannedTokenAccount[] = [];
  for (const acc of scan.nftTokenAccounts) {
    if (acc.owner !== ownerStr) {
      skippedPnfts.push({
        mint: acc.mint,
        tokenAccount: acc.tokenAccount,
        reason: "Owner mismatch",
      });
      continue;
    }
    if (acc.amount !== "1" || acc.decimals !== 0) {
      skippedPnfts.push({
        mint: acc.mint,
        tokenAccount: acc.tokenAccount,
        reason: "Not a 1-supply 0-decimal token",
      });
      continue;
    }
    if (acc.programId === token2022ProgramStr) {
      skippedPnfts.push({
        mint: acc.mint,
        tokenAccount: acc.tokenAccount,
        reason: "Token-2022 — outside pNFT scope",
      });
      continue;
    }
    if (acc.programId !== splTokenProgramStr) {
      skippedPnfts.push({
        mint: acc.mint,
        tokenAccount: acc.tokenAccount,
        reason: `Unsupported token program ${acc.programId.slice(0, 8)}…`,
      });
      continue;
    }
    // mintsAllowed intentionally NOT applied here — see legacy comment.
    if (seen.has(acc.tokenAccount)) continue;
    seen.add(acc.tokenAccount);
    coarse.push(acc);
  }

  const confirmations = await confirmPnfts(coarse);

  // Helius DAS enrichment — see comment in buildLegacyNftBurnTx.
  await enrichPnftConfirmationsWithDas(confirmations);

  const burnable: PnftConfirmation[] = [];
  for (const c of confirmations) {
    if (c.isBurnable) burnable.push(c);
    else {
      skippedPnfts.push({
        mint: c.mint,
        tokenAccount: c.tokenAccount,
        reason: c.unburnableReason ?? "Not burnable in this milestone",
      });
    }
  }

  // Diagnostic — see buildLegacyNftBurnTxImpl. One concise line summarising
  // why the pNFT burnable count came out as it did.
  {
    const tsBuckets: Record<string, number> = {};
    let withTokenRecord = 0;
    for (const c of confirmations) {
      const ts =
        c.isProgrammable
          ? "ProgrammableNonFungible"
          : c.isProgrammableEdition
            ? "ProgrammableNonFungibleEdition"
            : c.unburnableReason?.startsWith("Failed to decode")
              ? "decodeFailed"
              : c.unburnableReason?.startsWith("Metadata account not found")
                ? "noMetadataAccount"
                : c.unburnableReason?.startsWith("Legacy Metaplex NFT")
                  ? "NonFungibleOrEdition"
                  : c.unburnableReason?.startsWith("Metadata has no tokenStandard")
                    ? "nullTokenStandard"
                    : "other";
      tsBuckets[ts] = (tsBuckets[ts] ?? 0) + 1;
      if (c.hasTokenRecord) withTokenRecord++;
    }
    const reasonBuckets: Record<string, number> = {};
    for (const s of skippedPnfts) {
      reasonBuckets[s.reason] = (reasonBuckets[s.reason] ?? 0) + 1;
    }
    console.log(
      `[pnftBurn] classify ${ownerStr}: scan.nft=${scan.nftTokenAccounts.length} coarse=${coarse.length} confirmed=${confirmations.length} hasTokenRecord=${withTokenRecord} burnable=${burnable.length} tokenStandard=${JSON.stringify(tsBuckets)} skipReasons=${JSON.stringify(reasonBuckets)}`,
    );
  }

  // Token-account lookup needed for both reclaim-SOL math and buildTx's
  // per-NFT account list.
  const tokenAccountByMint = new Map<string, ScannedTokenAccount>();
  for (const acc of coarse) tokenAccountByMint.set(acc.mint, acc);

  // Full burnable candidate list — what the frontend renders.
  const burnableCandidates: BurnablePnftCandidate[] = burnable.map((c) => {
    const acc = tokenAccountByMint.get(c.mint);
    const reclaimLamports = Math.max(
      0,
      acc
        ? acc.lamports +
          c.metadataLamports +
          c.masterEditionLamports +
          c.tokenRecordLamports
        : c.metadataLamports + c.masterEditionLamports + c.tokenRecordLamports,
    );
    return {
      mint: c.mint,
      tokenAccount: c.tokenAccount,
      name: c.name,
      symbol: c.symbol,
      image: c.image,
      estimatedGrossReclaimSol: reclaimLamports / LAMPORTS_PER_SOL,
      metadata: c.metadataPda,
      masterEdition: c.masterEditionPda,
      tokenRecord: c.tokenRecordPda,
      ruleSet: c.ruleSet,
      collectionMetadata: c.collectionMetadataPda,
      collection: c.collection,
    };
  });

  // User-selected subset (or all on discovery), capped at MAX_PNFT_BURN_PER_TX
  // for the initial attempt. Sim-trim loop below shrinks further as needed.
  const selected = mintsAllowed
    ? burnable.filter((c) => mintsAllowed.has(c.mint))
    : burnable;
  let included = selected.slice(0, MAX_PNFT_BURN_PER_TX);
  const priorityFeeMicrolamports = readPriorityFeeMicrolamports();
  const burnableByMint = new Map(burnableCandidates.map((c) => [c.mint, c]));
  const computeNextBatch = (
    finalIncluded: PnftConfirmation[],
    isolatedMint: string | null,
  ): BurnablePnftCandidate[] => {
    const includedSet = new Set(finalIncluded.map((c) => c.mint));
    return selected
      .filter((c) => !includedSet.has(c.mint) && c.mint !== isolatedMint)
      .map((c) => burnableByMint.get(c.mint))
      .filter((c): c is BurnablePnftCandidate => c !== undefined);
  };

  if (included.length === 0) {
    return {
      burnCount: 0,
      totalBurnable: burnable.length,
      includedPnfts: [],
      skippedPnfts,
      estimatedGrossReclaimSol: 0,
      estimatedBaseFeeSol: 0,
      estimatedPriorityFeeSol: 0,
      estimatedFeeSol: 0,
      estimatedNetReclaimSol: 0,
      computeUnitLimit: 0,
      priorityFeeMicrolamports,
      transactionBase64: null,
      blockhash: null,
      lastValidBlockHeight: null,
      transactionVersion: "legacy",
      feePayer: ownerStr,
      requiresSignatureFrom: ownerStr,
      warning: PNFT_BURN_WARNING,
      simulationOk: true,
      burnableCandidates,
      maxPerTx: MAX_PNFT_BURN_PER_TX,
      nextBatchCandidates: computeNextBatch([], null),
    };
  }

  let blockhash: string;
  let lastValidBlockHeight: number;
  try {
    const got = await connection.getLatestBlockhash();
    blockhash = got.blockhash;
    lastValidBlockHeight = got.lastValidBlockHeight;
  } catch (err) {
    // Discovery must never 500 — see buildLegacyNftBurnTx for the same
    // pattern. Return a tx-less envelope so the UI lists candidates.
    console.warn(
      `[pnftBurn] getLatestBlockhash failed for ${ownerStr}: ${(err as Error)?.message ?? err}`,
    );
    return {
      burnCount: 0,
      totalBurnable: burnable.length,
      includedPnfts: [],
      skippedPnfts,
      estimatedGrossReclaimSol: 0,
      estimatedBaseFeeSol: 0,
      estimatedPriorityFeeSol: 0,
      estimatedFeeSol: 0,
      estimatedNetReclaimSol: 0,
      computeUnitLimit: 0,
      priorityFeeMicrolamports,
      transactionBase64: null,
      blockhash: null,
      lastValidBlockHeight: null,
      transactionVersion: "legacy",
      feePayer: ownerStr,
      requiresSignatureFrom: ownerStr,
      warning: PNFT_BURN_WARNING,
      simulationOk: false,
      simulationError: "RPC busy fetching blockhash. Try again.",
      burnableCandidates,
      maxPerTx: MAX_PNFT_BURN_PER_TX,
      nextBatchCandidates: computeNextBatch([], null),
    };
  }

  // pNFT BurnV1 is heavier than legacy BurnV1 (extra account access for
  // token record + delegate checks). Conservative ~70k CU per pNFT.
  const CU_PER_PNFT_BURN = 70_000;

  const buildTx = (
    items: PnftConfirmation[],
    cuLimit: number,
  ): { tx: Transaction; serialized: Uint8Array } => {
    const t = new Transaction();
    t.add(ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }));
    if (priorityFeeMicrolamports > 0) {
      t.add(
        ComputeBudgetProgram.setComputeUnitPrice({
          microLamports: priorityFeeMicrolamports,
        }),
      );
    }
    for (const c of items) {
      const acc = tokenAccountByMint.get(c.mint)!;
      const mint = new PublicKey(c.mint);
      const tokenAccount = new PublicKey(acc.tokenAccount);
      const metadata = new PublicKey(c.metadataPda);
      const masterEdition = new PublicKey(c.masterEditionPda);
      const tokenRecord = new PublicKey(c.tokenRecordPda);
      // BurnV1 / TokenStandard.ProgrammableNonFungible. Token record is
      // required (passed). For ruleset-governed pNFTs we append the two
      // auth-rules accounts (program + rule-set pubkey) AFTER the SDK call
      // — the v2.13.0 helper doesn't expose those keys, but the on-chain
      // program reads them positionally as keys[14] and keys[15].
      const ix = createMetaplexBurnInstruction(
        {
          authority: owner,
          metadata,
          edition: masterEdition,
          mint,
          token: tokenAccount,
          tokenRecord,
          sysvarInstructions: SYSVAR_INSTRUCTIONS_PUBKEY,
          splTokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          // Verified-collection pNFTs need the parent collection's
          // Metadata PDA in this slot. confirmPnfts has already validated
          // the account exists on-chain and recorded the PDA.
          ...(c.collectionMetadataPda
            ? { collectionMetadata: new PublicKey(c.collectionMetadataPda) }
            : {}),
        },
        { burnArgs: { __kind: "V1", amount: 1n } },
      );
      if (c.ruleSet) {
        ix.keys.push(
          {
            pubkey: AUTH_RULES_PROGRAM_ID,
            isSigner: false,
            isWritable: false,
          },
          {
            pubkey: new PublicKey(c.ruleSet),
            isSigner: false,
            isWritable: false,
          },
        );
      }
      t.add(ix);
    }
    t.recentBlockhash = blockhash;
    t.lastValidBlockHeight = lastValidBlockHeight;
    t.feePayer = owner;
    const ser = t.serialize({
      requireAllSignatures: false,
      verifySignatures: false,
    });
    return { tx: t, serialized: ser };
  };

  // ============================================================================
  // Tx-size trim — same serialize-aware pattern as buildLegacyNftBurnTxImpl.
  // Wrap buildTx in try/catch so a "Transaction too large" throw at
  // serialize-time triggers a tail trim instead of escaping to the outer
  // fail-open wrapper.
  // ============================================================================
  let computeUnitLimit = CU_PER_PNFT_BURN * included.length + CU_HEADROOM;
  let built: { tx: Transaction; serialized: Uint8Array } | null = null;
  let isolated: PnftBurnSkippedEntry | null = null;
  while (included.length > 0) {
    let attempt: { tx: Transaction; serialized: Uint8Array } | null = null;
    let buildErr: Error | null = null;
    try {
      attempt = buildTx(included, computeUnitLimit);
    } catch (err) {
      buildErr = err as Error;
    }
    const oversized =
      buildErr !== null ||
      (attempt !== null && attempt.serialized.length > MAX_TX_SIZE_BYTES);
    if (!oversized && attempt) {
      built = attempt;
      break;
    }
    if (buildErr && !/transaction too large|exceeds.*packet|encode.*too|exceeds.*size/i.test(buildErr.message)) {
      throw buildErr;
    }
    if (included.length === 1) {
      isolated = {
        mint: included[0].mint,
        tokenAccount: included[0].tokenAccount,
        reason: "Single pNFT burn transaction exceeds Solana packet size",
      };
      included = [];
      built = null;
      break;
    }
    included = included.slice(0, -1);
    computeUnitLimit = CU_PER_PNFT_BURN * included.length + CU_HEADROOM;
  }

  // ============================================================================
  // Preflight simulation — sim-trim loop. See buildLegacyNftBurnTx for the
  // pattern. Each fail trims the tail and retries; size-1 fail isolates the
  // bad item with a per-item skip reason. Skipped entirely when size-trim
  // already isolated everything (built === null).
  // ============================================================================
  let simulationOk = false;
  let simulationError: string | undefined;
  while (built !== null && included.length > 0) {
    let simErr: string | undefined;
    try {
      const sim = await connection.simulateTransaction(built.tx);
      if (!sim.value.err) {
        simulationOk = true;
        break;
      }
      simErr = parseSimulationError(sim.value.err, sim.value.logs ?? []);
      console.warn(
        `[pnftBurn] preflight rejected for ${ownerStr} at batch=${included.length}: friendly="${simErr}" rawErr=${JSON.stringify(sim.value.err)} logs=${JSON.stringify(sim.value.logs ?? [])}`,
      );
    } catch (err) {
      simErr =
        err instanceof Error ? err.message : "Simulation request failed";
      console.warn(
        `[pnftBurn] preflight call failed for ${ownerStr} at batch=${included.length}: ${(err as Error)?.message ?? err}`,
      );
    }
    if (included.length === 1) {
      isolated = {
        mint: included[0].mint,
        tokenAccount: included[0].tokenAccount,
        reason: `Preflight rejected: ${simErr}`,
      };
      simulationError = simErr;
      included = [];
      built = null;
      break;
    }
    included = included.slice(0, -1);
    computeUnitLimit = CU_PER_PNFT_BURN * included.length + CU_HEADROOM;
    try {
      built = buildTx(included, computeUnitLimit);
    } catch (err) {
      simErr =
        err instanceof Error ? err.message : "Build after trim failed";
      console.warn(
        `[pnftBurn] rebuild after trim failed for ${ownerStr} at batch=${included.length}: ${simErr}`,
      );
      simulationError = simErr;
      included = [];
      built = null;
      break;
    }
  }

  if (isolated) skippedPnfts.push(isolated);

  if (included.length === 0 || built === null) {
    return {
      burnCount: 0,
      totalBurnable: burnable.length,
      includedPnfts: [],
      skippedPnfts,
      estimatedGrossReclaimSol: 0,
      estimatedBaseFeeSol: 0,
      estimatedPriorityFeeSol: 0,
      estimatedFeeSol: 0,
      estimatedNetReclaimSol: 0,
      computeUnitLimit: 0,
      priorityFeeMicrolamports,
      transactionBase64: null,
      blockhash: null,
      lastValidBlockHeight: null,
      transactionVersion: "legacy",
      feePayer: ownerStr,
      requiresSignatureFrom: ownerStr,
      warning: PNFT_BURN_WARNING,
      simulationOk: false,
      simulationError,
      burnableCandidates,
      maxPerTx: MAX_PNFT_BURN_PER_TX,
      nextBatchCandidates: computeNextBatch([], isolated?.mint ?? null),
    };
  }

  // Compute fees + included entries from the FINAL `included` (post sim-trim).
  const baseFeeLamports = BASE_FEE_LAMPORTS_PER_SIGNATURE;
  const priorityFeeLamports =
    priorityFeeMicrolamports > 0
      ? Math.ceil((priorityFeeMicrolamports * computeUnitLimit) / 1_000_000)
      : 0;
  const totalFeeLamports = baseFeeLamports + priorityFeeLamports;

  const includedPnfts: PnftBurnIncludedEntry[] = included.map((c) => {
    const acc = tokenAccountByMint.get(c.mint)!;
    const reclaimLamports = Math.max(
      0,
      acc.lamports +
        c.metadataLamports +
        c.masterEditionLamports +
        c.tokenRecordLamports,
    );
    return {
      mint: c.mint,
      tokenAccount: c.tokenAccount,
      metadata: c.metadataPda,
      masterEdition: c.masterEditionPda,
      tokenRecord: c.tokenRecordPda,
      name: c.name,
      symbol: c.symbol,
      image: c.image,
      estimatedGrossReclaimSol: reclaimLamports / LAMPORTS_PER_SOL,
      reason: c.ruleSet
        ? "ProgrammableNonFungible with ruleset — full BurnV1 (token + metadata + master edition + token record + auth-rules)"
        : "ProgrammableNonFungible (no active ruleset) — full BurnV1 (token + metadata + master edition + token record)",
    };
  });
  const grossReclaimSol = includedPnfts.reduce(
    (sum, e) => sum + e.estimatedGrossReclaimSol,
    0,
  );
  const estimatedFeeSol = totalFeeLamports / LAMPORTS_PER_SOL;
  const estimatedNetReclaimSol = Math.max(0, grossReclaimSol - estimatedFeeSol);

  return {
    burnCount: includedPnfts.length,
    totalBurnable: burnable.length,
    includedPnfts,
    skippedPnfts,
    estimatedGrossReclaimSol: grossReclaimSol,
    estimatedBaseFeeSol: baseFeeLamports / LAMPORTS_PER_SOL,
    estimatedPriorityFeeSol: priorityFeeLamports / LAMPORTS_PER_SOL,
    estimatedFeeSol,
    estimatedNetReclaimSol,
    computeUnitLimit,
    priorityFeeMicrolamports,
    transactionBase64: Buffer.from(built.serialized).toString("base64"),
    blockhash,
    lastValidBlockHeight,
    transactionVersion: "legacy",
    feePayer: ownerStr,
    requiresSignatureFrom: ownerStr,
    warning: PNFT_BURN_WARNING,
    simulationOk,
    burnableCandidates,
    maxPerTx: MAX_PNFT_BURN_PER_TX,
    nextBatchCandidates: computeNextBatch(included, isolated?.mint ?? null),
  };
}

// ============================================================================
// Milestone 3 — Metaplex Core asset burn (BurnV1, max-reclaim).
//
// Core's BurnV1 is much simpler than Token Metadata's: a 6-slot account list
// and a fixed 2-byte data payload (`0x0c 0x00` = discriminator + None
// compressionProof). We hand-roll the instruction to avoid pulling in the
// Umi-only `@metaplex-foundation/mpl-core` package.
//
// Detection uses RPC `getProgramAccounts` on the Core program with two
// memcmp filters: AssetV1 discriminator (key=1) at offset 0, and the
// wallet's pubkey at offset 1 (the asset's `owner` field). Helius / paid
// RPC providers index this efficiently.
//
// Scope (Milestone 3):
//   ✓ Core AssetV1 owned by the wallet
//   ✗ Compressed NFTs (cNFT) — different program; out of scope
//   ✗ Token Metadata NFTs / pNFTs — handled by other builders
// ============================================================================

const MPL_CORE_PROGRAM_ID = new PublicKey(
  "CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d",
);

// AssetV1 key discriminator from mpl-core's `Key` enum.
const CORE_KEY_ASSET_V1 = 1;

// Per-asset CU estimate. Core BurnV1 is lighter than Token Metadata BurnV1
// because there's no separate metadata / edition / token-record account
// closure — just the asset itself.
const CU_PER_CORE_BURN = 30_000;

// Safety cap — see MAX_NFT_BURN_PER_TX comment. Core BurnV1 ix is
// narrower than pNFT (no token record, no auth rules) so we can fit
// more per tx.
export const MAX_CORE_BURN_PER_TX = 10;

const CORE_BURN_WARNING =
  "Burns Metaplex Core assets irreversibly and closes the asset account to reclaim its rent. Verify each asset manually before signing — burned assets cannot be recovered.";

interface CoreAssetParsed {
  asset: PublicKey;
  owner: PublicKey;
  collection: PublicKey | null;
  name: string | null;
  uri: string | null;
  lamports: number;
  // Off-chain image URL. Populated by the Helius DAS enrichment pass in
  // buildCoreBurnTx; null on parse-time.
  image: string | null;
}

// Borsh-decode just enough of the AssetV1 layout to know whether the asset
// has a collection (which determines whether `collection` slot of BurnV1 is
// a real PDA or a placeholder), plus optional name/uri for display.
//
// Layout:
//   key:                u8 (must be 1 for AssetV1)
//   owner:              [u8; 32]
//   update_authority:   enum tag (0=None, 1=Address, 2=Collection) + Pubkey when 1/2
//   name:               u32-LE length + UTF-8 bytes (Borsh String)
//   uri:                u32-LE length + UTF-8 bytes
//   ...
function parseCoreAssetData(
  data: Buffer,
): {
  owner: PublicKey;
  collection: PublicKey | null;
  name: string | null;
  uri: string | null;
} | null {
  if (data.length < 33) return null;
  if (data[0] !== CORE_KEY_ASSET_V1) return null;
  let offset = 1;
  const owner = new PublicKey(data.subarray(offset, offset + 32));
  offset += 32;
  if (offset >= data.length) return { owner, collection: null, name: null, uri: null };
  const uaKind = data[offset];
  offset += 1;
  let collection: PublicKey | null = null;
  if (uaKind === 1) {
    if (offset + 32 > data.length) return { owner, collection, name: null, uri: null };
    offset += 32; // Address(pubkey) — not the collection
  } else if (uaKind === 2) {
    if (offset + 32 > data.length) return { owner, collection, name: null, uri: null };
    collection = new PublicKey(data.subarray(offset, offset + 32));
    offset += 32;
  } else if (uaKind !== 0) {
    // Unknown variant — be conservative and stop parsing here.
    return { owner, collection, name: null, uri: null };
  }
  let name: string | null = null;
  let uri: string | null = null;
  try {
    if (offset + 4 <= data.length) {
      const nameLen = data.readUInt32LE(offset);
      offset += 4;
      if (nameLen <= 1024 && offset + nameLen <= data.length) {
        name = data.subarray(offset, offset + nameLen).toString("utf8");
        offset += nameLen;
      }
    }
    if (offset + 4 <= data.length) {
      const uriLen = data.readUInt32LE(offset);
      offset += 4;
      if (uriLen <= 4096 && offset + uriLen <= data.length) {
        uri = data.subarray(offset, offset + uriLen).toString("utf8");
      }
    }
  } catch {
    /* ignore — name/uri are optional for the burn flow */
  }
  return { owner, collection, name, uri };
}

// Per-wallet Core discovery cache (10 min TTL + in-flight dedupe). Identical
// pattern to the cleanup-scan cache in scanner.ts. Bumped to 10 min because
// the underlying call is more expensive than the SPL scan and the user spec
// for the burner explicitly asks for a 10-minute cache window.
const CORE_DISCOVERY_TTL_MS = 10 * 60 * 1000;
const CORE_DISCOVERY_CACHE_MAX = 1000;
// Capped LRU prevents the cache from growing without bound on long-running
// servers. TTL enforcement stays at the call site.
const coreDiscoveryCache = new CappedLruMap<
  string,
  { ts: number; promise: Promise<CoreAssetParsed[]> }
>(CORE_DISCOVERY_CACHE_MAX);

async function findCoreAssets(owner: PublicKey): Promise<CoreAssetParsed[]> {
  const ownerStr = owner.toBase58();
  const now = Date.now();
  const cached = coreDiscoveryCache.get(ownerStr);
  if (cached && now - cached.ts < CORE_DISCOVERY_TTL_MS) {
    return cached.promise;
  }
  const promise = doFindCoreAssets(owner);
  coreDiscoveryCache.set(ownerStr, { ts: now, promise });
  // If the underlying discovery rejects, drop the entry so the next call
  // retries instead of returning the cached failure forever.
  promise.catch(() => {
    if (coreDiscoveryCache.get(ownerStr)?.promise === promise) {
      coreDiscoveryCache.delete(ownerStr);
    }
  });
  return promise;
}

// Two-tier discovery: prefer Helius DAS (server-side wallet index — much
// faster than scanning the whole Core program) and fall back to the on-chain
// program scan when DAS is unavailable, errors, or returns nothing. DAS
// gives us asset id + metadata + image url; we hydrate per-asset lamports
// via getMultipleAccountsInfo on the discovered ids since DAS doesn't
// expose raw account state.
async function doFindCoreAssets(owner: PublicKey): Promise<CoreAssetParsed[]> {
  const ownerStr = owner.toBase58();
  console.log(`[coreBurn] DAS start for ${ownerStr}`);
  let dasResult: Awaited<ReturnType<typeof fetchCoreAssetsByOwner>>;
  try {
    dasResult = await fetchCoreAssetsByOwner(ownerStr);
  } catch (err) {
    const msg = (err as Error)?.message ?? String(err);
    console.warn(
      `[coreBurn] DAS getAssetsByOwner threw for ${ownerStr}: ${msg}`,
    );
    dasResult = {
      ok: false,
      reason: "exception",
      detail: msg,
      durationMs: 0,
    };
  }
  if (dasResult.ok) {
    console.log(
      `[coreBurn] DAS ok count=${dasResult.assets.length} raw=${dasResult.rawCount} pages=${dasResult.pagesFetched} ms=${dasResult.durationMs} for ${ownerStr}`,
    );
    const hydrateStart = Date.now();
    const hydrated = await hydrateCoreAssetsFromDas(owner, dasResult.assets);
    console.log(
      `[coreBurn] hydrate ok count=${hydrated.length} ms=${Date.now() - hydrateStart} for ${ownerStr}`,
    );
    return hydrated;
  }
  console.warn(
    `[coreBurn] DAS miss/fail reason=${dasResult.reason}${dasResult.detail ? ` detail=${dasResult.detail}` : ""} ms=${dasResult.durationMs} for ${ownerStr}`,
  );
  console.log(
    `[coreBurn] fallback getProgramAccounts start for ${ownerStr}`,
  );
  const fallbackStart = Date.now();
  const fallback = await findCoreAssetsViaProgramScan(owner);
  console.log(
    `[coreBurn] fallback ok count=${fallback.length} ms=${Date.now() - fallbackStart} for ${ownerStr}`,
  );
  return fallback;
}

// DAS gives us metadata + collection but no rent lamports. Pull lamports in
// chunks of 100 via getMultipleAccountsInfo so the discovered list still has
// accurate per-asset reclaim values. Chunk-level RPC failures are tolerated:
// affected entries are dropped from the result rather than throwing.
async function hydrateCoreAssetsFromDas(
  owner: PublicKey,
  das: import("../services/helius/das.js").CoreAssetFromDas[],
): Promise<CoreAssetParsed[]> {
  if (das.length === 0) return [];
  const pks: PublicKey[] = [];
  for (const a of das) {
    try {
      pks.push(new PublicKey(a.asset));
    } catch {
      // Malformed id from DAS — skip.
    }
  }
  const lamportsByIdx: (number | null)[] = [];
  // Owner of the program account — must be MPL_CORE_PROGRAM_ID for a real
  // Core AssetV1. DAS already filters by ownerAddress + interface, but
  // we do the cheap on-chain double-check while we're here for lamports.
  const programOwnerByIdx: (string | null)[] = [];
  for (let i = 0; i < pks.length; i += 100) {
    const chunk = pks.slice(i, i + 100);
    try {
      const res = await connection.getMultipleAccountsInfo(chunk);
      for (const info of res) {
        lamportsByIdx.push(info?.lamports ?? null);
        programOwnerByIdx.push(info?.owner.toBase58() ?? null);
      }
    } catch (err) {
      console.warn(
        `[coreBurn] hydrate lamports chunk RPC failed (offset=${i}, size=${chunk.length}): ${(err as Error)?.message ?? err}`,
      );
      for (let j = 0; j < chunk.length; j++) {
        lamportsByIdx.push(null);
        programOwnerByIdx.push(null);
      }
    }
  }
  const out: CoreAssetParsed[] = [];
  const corePid = MPL_CORE_PROGRAM_ID.toBase58();
  for (let i = 0; i < pks.length; i++) {
    const lp = lamportsByIdx[i];
    const ownerProg = programOwnerByIdx[i];
    if (lp === null) continue; // account not found / RPC failure — skip
    if (ownerProg !== null && ownerProg !== corePid) continue; // not Core
    let collection: PublicKey | null = null;
    if (das[i].collection) {
      try {
        collection = new PublicKey(das[i].collection as string);
      } catch {
        collection = null;
      }
    }
    out.push({
      asset: pks[i],
      owner,
      collection,
      name: das[i].name?.replace(/\0+$/, "").trim() || null,
      uri: das[i].uri?.replace(/\0+$/, "").trim() || null,
      lamports: lp,
      image: das[i].image ?? null,
    });
  }
  return out;
}

async function findCoreAssetsViaProgramScan(
  owner: PublicKey,
): Promise<CoreAssetParsed[]> {
  // bs58 of single byte 0x01 is "2" (constant). Used for the AssetV1 key
  // filter at offset 0. The owner filter at offset 1 narrows to just the
  // user's assets.
  const accounts = await connection.getProgramAccounts(MPL_CORE_PROGRAM_ID, {
    filters: [
      { memcmp: { offset: 0, bytes: "2" } },
      { memcmp: { offset: 1, bytes: owner.toBase58() } },
    ],
    encoding: "base64",
  });
  const out: CoreAssetParsed[] = [];
  for (const a of accounts) {
    const buf = Buffer.from(a.account.data);
    const parsed = parseCoreAssetData(buf);
    if (!parsed) continue;
    if (!parsed.owner.equals(owner)) continue; // belt-and-brace
    out.push({
      asset: a.pubkey,
      owner: parsed.owner,
      collection: parsed.collection,
      name: parsed.name?.replace(/\0+$/, "").trim() || null,
      uri: parsed.uri?.replace(/\0+$/, "").trim() || null,
      lamports: a.account.lamports,
      image: null,
    });
  }
  return out;
}

// BurnV1 ix built via the official mpl-core `burnV1` generated builder.
// Hand-rolling the metas was rejected on chain with `IncorrectAccount`
// (custom error 0x6) — kinobi-generated layout is the source of truth,
// don't guess. We use a Umi noop signer for the owner so the helper
// can mark the right slots as `isSigner` without needing a real
// keypair (the user's wallet signs client-side as before).
//
// Per task spec: do NOT pass `collection` unless we know it (the helper
// requires the actual collection PDA when the asset belongs to one,
// otherwise it must be omitted so the placeholder slot is used).
function buildCoreBurnIx(
  asset: PublicKey,
  owner: PublicKey,
  collection: PublicKey | null,
): TransactionInstruction {
  console.log("[coreBurn] burn input:", {
    asset: asset.toBase58(),
    owner: owner.toBase58(),
    authority: owner.toBase58(),
    payer: owner.toBase58(),
    collection: collection ? collection.toBase58() : null,
  });
  console.log(
    `[coreBurn] collection ${collection ? collection.toBase58() : "<none>"} for asset ${asset.toBase58()}`,
  );
  const ownerSigner = createNoopSigner(umiPublicKey(owner.toBase58()));
  const builder = mplCoreBurnV1(coreUmi, {
    asset: umiPublicKey(asset.toBase58()),
    payer: ownerSigner,
    authority: ownerSigner,
    ...(collection
      ? { collection: umiPublicKey(collection.toBase58()) }
      : {}),
  });
  const umiIxs = builder.getInstructions();
  if (umiIxs.length !== 1) {
    throw new Error(
      `[coreBurn] expected 1 burnV1 instruction, got ${umiIxs.length}`,
    );
  }
  return toWeb3JsInstruction(umiIxs[0]);
}

export interface BuildCoreBurnTxOptions {
  // Restrict to specific Core asset addresses. Without it every Core asset
  // owned by the wallet becomes a candidate (capped server-side).
  assetIds?: string[];
}

export interface CoreBurnIncludedEntry {
  asset: string;
  collection: string | null;
  name: string | null;
  uri: string | null;
  image: string | null;
  estimatedGrossReclaimSol: number;
  reason: string;
}

export interface CoreBurnSkippedEntry {
  asset: string;
  reason: string;
  // Optional metadata fields — kept for backwards compat (cap-overflow
  // entries are no longer pushed here; they live in burnableCandidates).
  collection?: string | null;
  name?: string | null;
  uri?: string | null;
  image?: string | null;
  estimatedGrossReclaimSol?: number;
}

export interface BurnableCoreCandidate {
  asset: string;
  collection: string | null;
  name: string | null;
  uri: string | null;
  image: string | null;
  estimatedGrossReclaimSol: number;
}

export interface BuildCoreBurnTxResult {
  burnCount: number;
  totalBurnable: number;
  includedAssets: CoreBurnIncludedEntry[];
  skippedAssets: CoreBurnSkippedEntry[];
  estimatedGrossReclaimSol: number;
  estimatedBaseFeeSol: number;
  estimatedPriorityFeeSol: number;
  estimatedFeeSol: number;
  estimatedNetReclaimSol: number;
  computeUnitLimit: number;
  priorityFeeMicrolamports: number;
  transactionBase64: string | null;
  // Captured from the same getLatestBlockhash() that built the tx; both
  // null when transactionBase64 is null. See BuildBurnAndCloseTxResult.
  blockhash: string | null;
  lastValidBlockHeight: number | null;
  transactionVersion: "legacy";
  feePayer: string;
  requiresSignatureFrom: string;
  warning: string;
  simulationOk: boolean;
  simulationError?: string;
  // Full burnable list — see BuildLegacyNftBurnTxResult.burnableCandidates.
  burnableCandidates: BurnableCoreCandidate[];
  maxPerTx: number;
  // See BuildLegacyNftBurnTxResult.nextBatchCandidates.
  nextBatchCandidates: BurnableCoreCandidate[];
}

export async function buildCoreBurnTx(
  address: string,
  opts: BuildCoreBurnTxOptions = {},
): Promise<BuildCoreBurnTxResult> {
  const owner = new PublicKey(address);
  const ownerStr = owner.toBase58();
  const allowSet =
    opts.assetIds && opts.assetIds.length > 0
      ? new Set(opts.assetIds)
      : null;

  const skippedAssets: CoreBurnSkippedEntry[] = [];
  const discoveryStart = Date.now();
  const allAssets = await findCoreAssets(owner);
  console.log(
    `[coreBurn] discovery total ms=${Date.now() - discoveryStart} count=${allAssets.length} for ${ownerStr}`,
  );

  // Walk all Core assets — allowSet is intentionally NOT applied at this
  // stage so burnableCandidates reflects the full wallet. The user's
  // selection is applied after enrichment when picking included items.
  const seen = new Set<string>();
  const candidates: CoreAssetParsed[] = [];
  for (const a of allAssets) {
    const id = a.asset.toBase58();
    if (seen.has(id)) continue;
    seen.add(id);
    candidates.push(a);
  }

  // Helius DAS enrichment for Core assets — same rationale as legacy/pNFT:
  // on-chain Core layout often stores a short or empty name; the real name
  // and image live in off-chain JSON resolved by DAS.
  const dasMap = await fetchAssetMetadataBatch(
    candidates.map((a) => a.asset.toBase58()),
  );
  for (const a of candidates) {
    const m = dasMap.get(a.asset.toBase58());
    if (!m) continue;
    if (!a.name && m.name) a.name = m.name;
    if (!a.uri && m.uri) a.uri = m.uri;
    if (m.image) a.image = m.image;
  }

  // Full burnable candidate list — what the frontend renders.
  const burnableCandidates: BurnableCoreCandidate[] = candidates.map((a) => ({
    asset: a.asset.toBase58(),
    collection: a.collection ? a.collection.toBase58() : null,
    name: a.name,
    uri: a.uri,
    image: a.image,
    estimatedGrossReclaimSol: a.lamports / LAMPORTS_PER_SOL,
  }));

  // User-selected subset (or all on discovery), capped at MAX_CORE_BURN_PER_TX
  // for the initial attempt. Sim-trim loop below shrinks further as needed.
  const selected = allowSet
    ? candidates.filter((a) => allowSet.has(a.asset.toBase58()))
    : candidates;
  let included = selected.slice(0, MAX_CORE_BURN_PER_TX);

  // Live-state refresh for the SELECTED batch only. The discovery cache
  // (10 min) keeps `candidates` fresh enough for grid display, but a real
  // burn tx must be built from current on-chain state — never from cached
  // DAS rows. Verify each selected asset still exists, is still owned by
  // the Core program, update its lamports to the on-chain value, AND
  // re-derive its `update_authority::Collection(pubkey)` from the
  // freshly-decoded account data.
  //
  // The collection re-derivation is the fix for the on-chain
  // `IncorrectAccount` (custom error 0x6) we kept hitting: DAS sometimes
  // returned `collection = null` for an asset whose on-chain
  // update_authority is actually a Collection. The mpl-core BurnV1
  // handler then rejects because the collection slot must hold the
  // real collection pubkey when the asset belongs to one. Source of
  // truth = the on-chain bytes we just fetched, never the cached DAS row.
  if (allowSet && included.length > 0) {
    try {
      const refreshKeys = included.map((a) => a.asset);
      const fresh = await connection.getMultipleAccountsInfo(refreshKeys);
      const corePid = MPL_CORE_PROGRAM_ID.toBase58();
      const verified: CoreAssetParsed[] = [];
      for (let i = 0; i < included.length; i++) {
        const cur = included[i];
        const info = fresh[i];
        if (!info) {
          skippedAssets.push({
            asset: cur.asset.toBase58(),
            reason: "Asset account not found at build time — already burned or transferred",
          });
          continue;
        }
        console.log(
          `[coreBurn] asset owner from getAccountInfo ${cur.asset.toBase58()} = ${info.owner.toBase58()}`,
        );
        if (info.owner.toBase58() !== corePid) {
          skippedAssets.push({
            asset: cur.asset.toBase58(),
            reason: "Asset no longer owned by Metaplex Core program at build time",
          });
          continue;
        }
        // Decode update_authority from the fresh bytes. If parsing fails
        // we keep the cached collection (best effort) rather than block
        // the burn; the on-chain handler will still reject if it's wrong.
        const parsed = parseCoreAssetData(Buffer.from(info.data));
        const onChainCollection = parsed?.collection ?? null;
        // Defensive guard: if the cached collection AND the on-chain
        // parse both came back null, but the asset clearly references a
        // collection we couldn't decode (parse returned non-null but
        // its `collection` field is still null because the variant tag
        // was unrecognized), skip with the explicit reason from spec.
        // We treat this as: parser reached the update_authority byte
        // but couldn't surface a usable collection pubkey.
        if (
          parsed === null &&
          cur.collection === null &&
          info.data.length >= 33
        ) {
          skippedAssets.push({
            asset: cur.asset.toBase58(),
            reason: "Missing Core collection account",
          });
          continue;
        }
        const collection = onChainCollection ?? cur.collection;
        if (collection !== null && cur.collection !== null) {
          if (!collection.equals(cur.collection)) {
            console.warn(
              `[coreBurn] collection drift for ${cur.asset.toBase58()} cached=${cur.collection.toBase58()} onChain=${collection.toBase58()} — using on-chain`,
            );
          }
        } else if (collection !== null && cur.collection === null) {
          console.log(
            `[coreBurn] recovered collection ${collection.toBase58()} for ${cur.asset.toBase58()} (DAS returned null)`,
          );
        }
        console.log("[coreBurn] asset classification:", {
          asset: cur.asset.toBase58(),
          collection: collection ? collection.toBase58() : null,
          lamports: info.lamports,
          source: onChainCollection ? "onChain" : cur.collection ? "cache" : "none",
        });
        verified.push({ ...cur, lamports: info.lamports, collection });
      }
      included = verified;
    } catch (err) {
      // Refresh failed (RPC busy). Fall back to cached lamports rather
      // than 500 — sim will still catch any inconsistency.
      console.warn(
        `[coreBurn] live refresh failed for ${ownerStr}: ${(err as Error)?.message ?? err}`,
      );
    }
  }

  const priorityFeeMicrolamports = readPriorityFeeMicrolamports();
  const burnableByAsset = new Map(
    burnableCandidates.map((c) => [c.asset, c]),
  );
  const computeNextBatch = (
    finalIncluded: CoreAssetParsed[],
    isolatedAssetId: string | null,
  ): BurnableCoreCandidate[] => {
    const includedSet = new Set(
      finalIncluded.map((a) => a.asset.toBase58()),
    );
    return selected
      .map((a) => a.asset.toBase58())
      .filter((id) => !includedSet.has(id) && id !== isolatedAssetId)
      .map((id) => burnableByAsset.get(id))
      .filter((c): c is BurnableCoreCandidate => c !== undefined);
  };

  if (included.length === 0) {
    return {
      burnCount: 0,
      totalBurnable: candidates.length,
      includedAssets: [],
      skippedAssets,
      estimatedGrossReclaimSol: 0,
      estimatedBaseFeeSol: 0,
      estimatedPriorityFeeSol: 0,
      estimatedFeeSol: 0,
      estimatedNetReclaimSol: 0,
      computeUnitLimit: 0,
      priorityFeeMicrolamports,
      transactionBase64: null,
      blockhash: null,
      lastValidBlockHeight: null,
      transactionVersion: "legacy",
      feePayer: ownerStr,
      requiresSignatureFrom: ownerStr,
      warning: CORE_BURN_WARNING,
      simulationOk: true,
      burnableCandidates,
      maxPerTx: MAX_CORE_BURN_PER_TX,
      nextBatchCandidates: computeNextBatch([], null),
    };
  }

  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash();

  const buildTx = (
    items: CoreAssetParsed[],
    cuLimit: number,
  ): { tx: Transaction; serialized: Uint8Array } => {
    const t = new Transaction();
    t.add(ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }));
    if (priorityFeeMicrolamports > 0) {
      t.add(
        ComputeBudgetProgram.setComputeUnitPrice({
          microLamports: priorityFeeMicrolamports,
        }),
      );
    }
    for (const a of items) {
      t.add(buildCoreBurnIx(a.asset, owner, a.collection));
    }
    t.recentBlockhash = blockhash;
    t.lastValidBlockHeight = lastValidBlockHeight;
    t.feePayer = owner;
    const ser = t.serialize({
      requireAllSignatures: false,
      verifySignatures: false,
    });
    return { tx: t, serialized: ser };
  };

  let computeUnitLimit = CU_PER_CORE_BURN * included.length + CU_HEADROOM;
  let built = buildTx(included, computeUnitLimit);
  // Tx-size trim (cheap, no RPC).
  while (built.serialized.length > MAX_TX_SIZE_BYTES && included.length > 1) {
    included = included.slice(0, -1);
    computeUnitLimit = CU_PER_CORE_BURN * included.length + CU_HEADROOM;
    built = buildTx(included, computeUnitLimit);
  }
  if (built.serialized.length > MAX_TX_SIZE_BYTES) {
    throw new Error(
      `Core burn transaction exceeds ${MAX_TX_SIZE_BYTES}-byte packet cap even with one asset (got ${built.serialized.length} bytes)`,
    );
  }

  // ============================================================================
  // Preflight simulation — sim-trim loop. See buildLegacyNftBurnTx for the
  // pattern. Catches plugin-level rejections (Frozen, Royalty, etc.) and any
  // other chain-side issue.
  // ============================================================================
  // mpl-core "IncorrectAccount" surfaces as either the literal log line
  // "Program log: Incorrect account" or the raw `custom program error: 0x6`.
  // Detect both so we can hard-stop the trim loop instead of shrinking the
  // batch (which never helps — every asset has the same wrong meta).
  const isIncorrectAccount = (
    err: string | undefined,
    logs: string[],
  ): boolean => {
    if (err && /incorrect account/i.test(err)) return true;
    if (err && /custom program error:\s*0x6\b/i.test(err)) return true;
    for (const l of logs) {
      if (/incorrect account/i.test(l)) return true;
      if (/custom program error:\s*0x6\b/i.test(l)) return true;
    }
    return false;
  };
  // Snapshot of the ix metas for the most recent simulate call. Logged
  // before every preflight, AND surfaced via simulationError when we
  // hard-stop on IncorrectAccount so the frontend's compact error +
  // backend logs together explain exactly what we sent.
  let lastIxAccountsSnapshot: Array<{
    asset: string;
    collection: string | null;
    keys: Array<{ pubkey: string; signer: boolean; writable: boolean }>;
  }> = [];

  let simulationOk = false;
  let simulationError: string | undefined;
  let isolated: CoreBurnSkippedEntry | null = null;
  while (included.length > 0) {
    let simErr: string | undefined;
    // Hard debug — log every burn ix's account metas before the preflight
    // call. Skips the two ComputeBudget instructions at the head of the
    // tx so the log is just the BurnV1 ix list. Snapshotted so the
    // hard-stop branch below can include it in the compact error.
    lastIxAccountsSnapshot = [];
    for (let i = 0; i < included.length; i++) {
      const ix = built.tx.instructions[built.tx.instructions.length - included.length + i];
      const a = included[i];
      const keys = ix.keys.map((k) => ({
        pubkey: k.pubkey.toBase58(),
        signer: k.isSigner,
        writable: k.isWritable,
      }));
      lastIxAccountsSnapshot.push({
        asset: a.asset.toBase58(),
        collection: a.collection ? a.collection.toBase58() : null,
        keys,
      });
      console.log(
        `[coreBurn] ix accounts asset=${a.asset.toBase58()} collection=${a.collection ? a.collection.toBase58() : "<none>"} keys=${JSON.stringify(keys)}`,
      );
    }
    try {
      const sim = await connection.simulateTransaction(built.tx);
      if (!sim.value.err) {
        simulationOk = true;
        break;
      }
      simErr = parseSimulationError(sim.value.err, sim.value.logs ?? []);
      const hardStop = isIncorrectAccount(simErr, sim.value.logs ?? []);
      console.warn(
        `[coreBurn] preflight rejected for ${ownerStr} at batch=${included.length}: friendly="${simErr}" hardStop=${hardStop} rawErr=${JSON.stringify(sim.value.err)} logs=${JSON.stringify(sim.value.logs ?? [])}`,
      );
      if (hardStop) {
        // Per spec: do NOT silently trim/retry batch for IncorrectAccount.
        // Stop immediately at any batch size and surface a compact error
        // that includes the ix accounts + collection source we just
        // sent — that's the actionable diagnostic.
        const compact = `Incorrect account · accounts=${JSON.stringify(lastIxAccountsSnapshot)}`;
        simulationError = "Core burn preflight failed: Incorrect account";
        // Mark every selected asset as skipped so the frontend doesn't
        // think any of them passed.
        for (const a of included) {
          skippedAssets.push({
            asset: a.asset.toBase58(),
            collection: a.collection ? a.collection.toBase58() : null,
            reason: simulationError,
          });
        }
        console.warn(`[coreBurn] preflight hardStop for ${ownerStr}: ${compact}`);
        included = [];
        break;
      }
    } catch (err) {
      simErr =
        err instanceof Error ? err.message : "Simulation request failed";
      console.warn(
        `[coreBurn] preflight call failed for ${ownerStr} at batch=${included.length}: ${(err as Error)?.message ?? err}`,
      );
    }
    if (included.length === 1) {
      isolated = {
        asset: included[0].asset.toBase58(),
        reason: `Preflight rejected: ${simErr}`,
      };
      simulationError = simErr;
      included = [];
      break;
    }
    included = included.slice(0, -1);
    computeUnitLimit = CU_PER_CORE_BURN * included.length + CU_HEADROOM;
    built = buildTx(included, computeUnitLimit);
  }

  if (isolated) skippedAssets.push(isolated);

  if (included.length === 0) {
    return {
      burnCount: 0,
      totalBurnable: candidates.length,
      includedAssets: [],
      skippedAssets,
      estimatedGrossReclaimSol: 0,
      estimatedBaseFeeSol: 0,
      estimatedPriorityFeeSol: 0,
      estimatedFeeSol: 0,
      estimatedNetReclaimSol: 0,
      computeUnitLimit: 0,
      priorityFeeMicrolamports,
      transactionBase64: null,
      blockhash: null,
      lastValidBlockHeight: null,
      transactionVersion: "legacy",
      feePayer: ownerStr,
      requiresSignatureFrom: ownerStr,
      warning: CORE_BURN_WARNING,
      simulationOk: false,
      simulationError,
      burnableCandidates,
      maxPerTx: MAX_CORE_BURN_PER_TX,
      nextBatchCandidates: computeNextBatch([], isolated?.asset ?? null),
    };
  }

  const baseFeeLamports = BASE_FEE_LAMPORTS_PER_SIGNATURE;
  const priorityFeeLamports =
    priorityFeeMicrolamports > 0
      ? Math.ceil((priorityFeeMicrolamports * computeUnitLimit) / 1_000_000)
      : 0;
  const totalFeeLamports = baseFeeLamports + priorityFeeLamports;

  const includedAssets: CoreBurnIncludedEntry[] = included.map((a) => ({
    asset: a.asset.toBase58(),
    collection: a.collection ? a.collection.toBase58() : null,
    name: a.name,
    uri: a.uri,
    image: a.image,
    estimatedGrossReclaimSol: a.lamports / LAMPORTS_PER_SOL,
    reason: a.collection
      ? "Core asset (collection-stamped) — full BurnV1 with collection slot wired"
      : "Core asset (no collection) — full BurnV1",
  }));
  const grossReclaimSol = includedAssets.reduce(
    (sum, e) => sum + e.estimatedGrossReclaimSol,
    0,
  );
  const estimatedFeeSol = totalFeeLamports / LAMPORTS_PER_SOL;
  const estimatedNetReclaimSol = Math.max(0, grossReclaimSol - estimatedFeeSol);

  return {
    burnCount: includedAssets.length,
    totalBurnable: candidates.length,
    includedAssets,
    skippedAssets,
    estimatedGrossReclaimSol: grossReclaimSol,
    estimatedBaseFeeSol: baseFeeLamports / LAMPORTS_PER_SOL,
    estimatedPriorityFeeSol: priorityFeeLamports / LAMPORTS_PER_SOL,
    estimatedFeeSol,
    estimatedNetReclaimSol,
    computeUnitLimit,
    priorityFeeMicrolamports,
    transactionBase64: Buffer.from(built.serialized).toString("base64"),
    blockhash,
    lastValidBlockHeight,
    transactionVersion: "legacy",
    feePayer: ownerStr,
    requiresSignatureFrom: ownerStr,
    warning: CORE_BURN_WARNING,
    simulationOk,
    burnableCandidates,
    maxPerTx: MAX_CORE_BURN_PER_TX,
    nextBatchCandidates: computeNextBatch(included, isolated?.asset ?? null),
  };
}
