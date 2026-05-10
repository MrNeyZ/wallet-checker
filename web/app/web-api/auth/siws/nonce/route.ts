// POST /web-api/auth/siws/nonce
//
// Step 1 of Sign-In With Solana. Issues a server-recorded nonce + the
// canonical message the wallet should sign. The route does not require
// auth (there's no session yet — this is how the session is bootstrapped),
// but it IS rate-limited per-IP so an attacker can't farm nonces.

import { NextResponse, type NextRequest } from "next/server";
import { issueNonce } from "@/lib/siws";
import { makeRateLimiter, clientIp } from "@/lib/rate-limit-inline";

export const runtime = "nodejs";

const limiter = makeRateLimiter({ limit: 20, windowMs: 60_000, label: "siws/nonce" });

export async function POST(req: NextRequest) {
  if (!limiter.allowed(clientIp(req))) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: { "retry-after": "60" } });
  }

  let body: { wallet?: unknown };
  try { body = await req.json() as { wallet?: unknown }; }
  catch { return NextResponse.json({ error: "invalid_json" }, { status: 400 }); }

  const wallet = body.wallet;
  if (typeof wallet !== "string") {
    return NextResponse.json({ error: "invalid_wallet" }, { status: 400 });
  }

  const result = issueNonce(wallet);
  if ("error" in result) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }
  return NextResponse.json(result, {
    status: 200,
    headers: { "cache-control": "no-store" },
  });
}
