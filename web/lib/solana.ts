"use client";

// Frontend Solana RPC connection — used to confirm signatures the wallet
// extension just sent. Phantom returns a signature once it has handed the
// tx to ITS RPC, but the tx may still drop out of mempool or fail to land.
// We need to verify with our own RPC at "confirmed" / "finalized" commitment
// before showing the user "Sent ✓". Without this, the user sees Phantom's
// optimistic confirmation but the tx never reaches Solscan.
//
// All client RPC calls go through the same-origin Next route handler at
// `/web-api/rpc`, which keeps the Helius (or other paid) RPC URL+key in
// SERVER env only. The previous design read NEXT_PUBLIC_SOLANA_RPC_URL,
// which Next.js inlines into the public client bundle — leaking the API
// key to anyone with DevTools. The proxy enforces a method allowlist
// (sendTransaction / getSignatureStatuses / getBlockHeight /
// getLatestBlockhash) and a per-IP rate limit, so even an authenticated
// session can't pivot the proxy into an unbounded RPC tap.

import { Connection } from "@solana/web3.js";

let cached: Connection | null = null;

function rpcEndpoint(): string {
  // `Connection` constructs `new URL(endpoint)` internally, which throws
  // on a relative path. Resolve against the current origin in the
  // browser. SSR placeholder is unreachable: this module is "use client",
  // so getConnection() is never called server-side.
  if (typeof window !== "undefined") {
    return new URL("/web-api/rpc", window.location.origin).toString();
  }
  return "http://localhost/web-api/rpc";
}

export function getConnection(): Connection {
  if (!cached) {
    // "confirmed" commitment for the default ops; specific calls (e.g.,
    // confirmTransaction with "finalized") override per-call.
    cached = new Connection(rpcEndpoint(), "confirmed");
  }
  return cached;
}
