"use client";

// Frontend Solana RPC connection — used to confirm signatures the wallet
// extension just sent. Phantom returns a signature once it has handed the
// tx to ITS RPC, but the tx may still drop out of mempool or fail to land.
// We need to verify with our own RPC at "confirmed" / "finalized" commitment
// before showing the user "Sent ✓". Without this, the user sees Phantom's
// optimistic confirmation but the tx never reaches Solscan.
//
// Reads NEXT_PUBLIC_SOLANA_RPC_URL at build time (Next.js inlines this into
// the client bundle). Falls back to public mainnet-beta if unset — works
// for low-volume confirms but is rate-limited; production should set the
// env to a Helius / Triton URL.

import { Connection } from "@solana/web3.js";

const RPC_URL =
  process.env.NEXT_PUBLIC_SOLANA_RPC_URL ??
  "https://api.mainnet-beta.solana.com";

let cached: Connection | null = null;

export function getConnection(): Connection {
  if (!cached) {
    // "confirmed" commitment for the default ops; specific calls (e.g.,
    // confirmTransaction with "finalized") override per-call.
    cached = new Connection(RPC_URL, "confirmed");
  }
  return cached;
}
