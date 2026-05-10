// POST /web-api/auth/siws/verify
//
// Step 2 of Sign-In With Solana. Consumes the nonce, verifies the
// ed25519 signature against the canonical message the server stored,
// validates the invite passphrase (WEB_PASSWORD), and — on success —
// sets the EXISTING wallet_checker_session cookie that middleware.ts
// already reads. The cookie format is unchanged (sha256(WEB_PASSWORD))
// so no other code path needs to know SIWS exists.
//
// Failure modes return 401 + a short reason code. We never echo back
// the nonce, signature, message, or passphrase in any response.

import { NextResponse, type NextRequest } from "next/server";
import { verifyLogin } from "@/lib/siws";
import { SESSION_COOKIE, sha256Hex } from "@/lib/auth";
import { makeRateLimiter, clientIp } from "@/lib/rate-limit-inline";

export const runtime = "nodejs";

const ONE_WEEK_SEC = 60 * 60 * 24 * 7;
const limiter = makeRateLimiter({ limit: 10, windowMs: 60_000, label: "siws/verify" });

export async function POST(req: NextRequest) {
  if (!limiter.allowed(clientIp(req))) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: { "retry-after": "60" } });
  }

  let body: { wallet?: unknown; nonce?: unknown; signature?: unknown; password?: unknown };
  try { body = await req.json() as typeof body; }
  catch { return NextResponse.json({ error: "invalid_json" }, { status: 400 }); }

  const password = process.env.WEB_PASSWORD;
  if (!password) {
    // Misconfiguration — the env wasn't loaded. Mirror the server-action
    // behaviour: 500 with a non-actionable error.
    return NextResponse.json({ error: "server_auth_misconfigured" }, { status: 500 });
  }

  const result = verifyLogin({
    wallet:       body.wallet,
    nonce:        body.nonce,
    signatureB64: body.signature,
    passphrase:   body.password,
  });
  if (!result.ok) {
    const status = result.reason === "passphrase_unconfigured" ? 500 : 401;
    // Log a short, redaction-safe code only. The wallet pubkey is
    // base58 and is safe to log a prefix of for audit.
    const walletForLog = typeof body.wallet === "string" ? body.wallet.slice(0, 6) : "?";
    console.warn(`[siws/verify] reject reason=${result.reason} wallet=${walletForLog}…`);
    return NextResponse.json({ error: "unauthorized", reason: result.reason }, { status });
  }

  // Set the same cookie the existing loginAction issues so middleware.ts
  // accepts the session without any code change. The cookie value is
  // sha256(WEB_PASSWORD), not the password itself, so it never
  // round-trips the secret.
  const cookieValue = await sha256Hex(password);
  const res = NextResponse.json({ ok: true }, {
    status: 200,
    headers: { "cache-control": "no-store" },
  });
  res.cookies.set(SESSION_COOKIE, cookieValue, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: ONE_WEEK_SEC,
  });
  return res;
}
