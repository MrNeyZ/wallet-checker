// Sign-In With Solana — server-side primitives for wallet-checker.
//
// Mirrors the design of /root/nft-live-feed/src/auth/siws.ts (see that
// file's header for the threat model rationale). Differences vs. the
// nft-live-feed module are limited to:
//   - default domain `wallet.victorylabs.app` (overridable via SIWS_DOMAIN)
//   - the invite passphrase is checked against WEB_PASSWORD
//   - a separate UI_ALLOWED_WALLETS check is NOT enforced here because
//     wallet-checker doesn't run a per-wallet allowlist today; if it
//     ever grows one, plug it into the verify route, NOT this module.

import { randomBytes, timingSafeEqual } from "crypto";
import nacl from "tweetnacl";
import bs58 from "bs58";

const DEFAULT_DOMAIN = "wallet.victorylabs.app";
function siwsDomain(): string {
  return (process.env.SIWS_DOMAIN ?? "").trim() || DEFAULT_DOMAIN;
}
function siwsUri(): string {
  const explicit = (process.env.SIWS_URI ?? "").trim();
  return explicit || `https://${siwsDomain()}`;
}

const NONCE_TTL_MS = 5 * 60_000;
const NONCE_BYTES = 16; // 128 bits

interface NonceRecord {
  wallet: string;
  message: string;
  issuedAt: number;
  expiresAt: number;
}
// Module-scope Map. Next.js Route Handlers run inside the same Node
// process across requests, so this Map survives between calls within
// one worker. A redeploy (pm2 restart) wipes outstanding nonces;
// clients re-fetch. Bounded by opportunistic eviction.
const nonces = new Map<string, NonceRecord>();
function key(wallet: string, nonce: string): string { return `${wallet}:${nonce}`; }

function evictExpired(now: number): void {
  if (nonces.size <= 256) return;
  let n = 0;
  for (const [k, v] of nonces) {
    if (v.expiresAt <= now) { nonces.delete(k); if (++n >= 16) break; }
  }
}

function buildMessage(wallet: string, nonce: string, now: Date, exp: Date): string {
  const domain = siwsDomain();
  const uri    = siwsUri();
  return [
    `${domain} wants you to sign in with your Solana account:`,
    wallet,
    "",
    "Sign in to VictoryLabs",
    "",
    `URI: ${uri}`,
    "Version: 1",
    "Chain ID: solana:mainnet",
    `Nonce: ${nonce}`,
    `Issued At: ${now.toISOString()}`,
    `Expiration Time: ${exp.toISOString()}`,
  ].join("\n");
}

function isValidWallet(s: unknown): s is string {
  return typeof s === "string"
      && s.length >= 32 && s.length <= 44
      && /^[1-9A-HJ-NP-Za-km-z]+$/.test(s);
}
function isValidNonceShape(s: unknown): s is string {
  return typeof s === "string" && /^[0-9a-f]{32}$/.test(s);
}

export interface IssuedNonce {
  nonce: string;
  message: string;
  expiresAt: number;
}
export function issueNonce(wallet: string): IssuedNonce | { error: string } {
  if (!isValidWallet(wallet)) return { error: "invalid_wallet" };
  const now = new Date();
  const exp = new Date(now.getTime() + NONCE_TTL_MS);
  const nonce = randomBytes(NONCE_BYTES).toString("hex");
  const message = buildMessage(wallet, nonce, now, exp);
  nonces.set(key(wallet, nonce), {
    wallet,
    message,
    issuedAt: now.getTime(),
    expiresAt: exp.getTime(),
  });
  evictExpired(now.getTime());
  return { nonce, message, expiresAt: exp.getTime() };
}

export type VerifyError =
  | "invalid_wallet"
  | "invalid_nonce_shape"
  | "unknown_nonce"
  | "expired_nonce"
  | "wallet_mismatch"
  | "invalid_signature_shape"
  | "bad_signature"
  | "bad_passphrase"
  | "passphrase_unconfigured";

export type VerifyResult =
  | { ok: true; wallet: string }
  | { ok: false; reason: VerifyError };

export function verifyLogin(args: {
  wallet: unknown;
  nonce: unknown;
  signatureB64: unknown;
  passphrase: unknown;
}): VerifyResult {
  const { wallet, nonce, signatureB64, passphrase } = args;
  if (!isValidWallet(wallet))    return { ok: false, reason: "invalid_wallet" };
  if (!isValidNonceShape(nonce)) return { ok: false, reason: "invalid_nonce_shape" };

  const record = nonces.get(key(wallet, nonce));
  if (record) nonces.delete(key(wallet, nonce));
  if (!record) return { ok: false, reason: "unknown_nonce" };

  const now = Date.now();
  evictExpired(now);
  if (record.expiresAt <= now) return { ok: false, reason: "expired_nonce" };
  if (record.wallet !== wallet) return { ok: false, reason: "wallet_mismatch" };

  if (typeof signatureB64 !== "string") return { ok: false, reason: "invalid_signature_shape" };
  let sigBytes: Buffer;
  try { sigBytes = Buffer.from(signatureB64, "base64"); }
  catch { return { ok: false, reason: "invalid_signature_shape" }; }
  if (sigBytes.length !== 64) return { ok: false, reason: "invalid_signature_shape" };

  let pubBytes: Uint8Array;
  try { pubBytes = bs58.decode(wallet); }
  catch { return { ok: false, reason: "invalid_wallet" }; }
  if (pubBytes.length !== 32) return { ok: false, reason: "invalid_wallet" };

  const msgBytes = Buffer.from(record.message, "utf8");
  if (!nacl.sign.detached.verify(msgBytes, sigBytes, pubBytes)) {
    return { ok: false, reason: "bad_signature" };
  }

  // Invite passphrase — compared against the existing WEB_PASSWORD env so
  // the operator can keep using one short invite string while the wallet
  // signature does the real authenticating work.
  const expected = (process.env.WEB_PASSWORD ?? "").trim();
  if (!expected) return { ok: false, reason: "passphrase_unconfigured" };
  if (typeof passphrase !== "string") return { ok: false, reason: "bad_passphrase" };
  const a = Buffer.from(passphrase, "utf8");
  const b = Buffer.from(expected,   "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: "bad_passphrase" };
  }
  return { ok: true, wallet };
}

export function siwsRequired(): boolean {
  return (process.env.AUTH_REQUIRE_SIWS ?? "").trim().toLowerCase() === "true";
}
