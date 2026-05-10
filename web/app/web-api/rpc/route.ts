// Same-origin Solana JSON-RPC proxy.
//
// Why this exists: the wallet-checker frontend used to read
// NEXT_PUBLIC_SOLANA_RPC_URL at build time, which Next.js inlines into
// the public client bundle — leaking the Helius API key to anyone with
// DevTools. This route moves the upstream URL (with key) into a
// server-only env (`SOLANA_RPC_URL`) and forwards a tightly scoped
// JSON-RPC subset on the client's behalf.
//
// Allowlist is intentionally narrow — only the methods the burn flow
// actually needs (sendTransaction, getSignatureStatuses, getBlockHeight)
// plus getLatestBlockhash for defence in depth (web3.js may refresh a
// blockhash internally on retry paths). Heavy / expensive methods
// (getProgramAccounts, getAssetsByOwner, getTransaction by sig, …) stay
// blocked here; if a future flow needs them, add them deliberately or
// route through the existing /api/* backend which is gated by the
// shared APP_API_KEY.

import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, sha256Hex } from "@/lib/auth";

export const runtime = "nodejs";

const UPSTREAM_RPC_URL =
  process.env.SOLANA_RPC_URL ??
  process.env.HELIUS_RPC_URL ??
  "";

const UPSTREAM_TIMEOUT_MS = 15_000;
const MAX_BODY_BYTES = 1 * 1024 * 1024; // 1 MB — JSON-RPC requests are tiny
const MAX_BATCH = 10;

const ALLOWED_METHODS = new Set<string>([
  "sendTransaction",
  "getSignatureStatuses",
  "getBlockHeight",
  "getLatestBlockhash",
]);

// Per-IP fixed-window rate limit. A single burn confirmation poll fires
// up to ~45 getSignatureStatuses + 9 getBlockHeight calls over ~90s; 120
// requests/min leaves comfortable headroom for two concurrent confirms
// while making bulk abuse expensive. Map size is opportunistically
// pruned so it stays bounded by the active-IP set.
const RATE_LIMIT_PER_MIN = 120;
const RATE_WINDOW_MS = 60_000;
interface Bucket { count: number; resetAt: number }
const buckets = new Map<string, Bucket>();

function checkRate(ip: string): boolean {
  const now = Date.now();
  let b = buckets.get(ip);
  if (!b || b.resetAt <= now) {
    b = { count: 0, resetAt: now + RATE_WINDOW_MS };
    buckets.set(ip, b);
  }
  b.count++;
  if (buckets.size > 256) {
    let n = 0;
    for (const [k, v] of buckets) {
      if (v.resetAt <= now) { buckets.delete(k); if (++n >= 16) break; }
    }
  }
  return b.count <= RATE_LIMIT_PER_MIN;
}

async function isAuthed(req: NextRequest): Promise<boolean> {
  // Mirrors middleware.ts behaviour: when WEB_PASSWORD isn't set we're in
  // dev mode and skip the gate. In production the cookie value is the
  // SHA-256 of the password (see lib/auth.ts) so this comparison never
  // touches the plaintext secret.
  const password = process.env.WEB_PASSWORD;
  if (!password) return true;
  const expected = await sha256Hex(password);
  const cookie = req.cookies.get(SESSION_COOKIE)?.value;
  return !!cookie && cookie === expected;
}

function clientIp(req: NextRequest): string {
  // nginx in front sets X-Forwarded-For = "<attacker>, <real_ip>" — the
  // last hop is the trusted one. Read the LAST entry, not the first.
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const parts = xff.split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length > 0) return parts[parts.length - 1];
  }
  const xri = req.headers.get("x-real-ip");
  if (xri) return xri.trim();
  return "unknown";
}

interface JsonRpcRequest {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

function isAllowedJsonRpc(r: unknown): boolean {
  if (!r || typeof r !== "object") return false;
  const method = (r as JsonRpcRequest).method;
  return typeof method === "string" && ALLOWED_METHODS.has(method);
}

export async function POST(req: NextRequest) {
  if (!UPSTREAM_RPC_URL) {
    return NextResponse.json({ error: "rpc_not_configured" }, { status: 503 });
  }
  if (!(await isAuthed(req))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const ip = clientIp(req);
  if (!checkRate(ip)) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: { "retry-after": "60" } });
  }

  const cl = req.headers.get("content-length");
  if (cl && Number(cl) > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "body_too_large" }, { status: 413 });
  }

  let bodyText: string;
  try {
    bodyText = await req.text();
  } catch {
    return NextResponse.json({ error: "bad_body" }, { status: 400 });
  }
  if (bodyText.length > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "body_too_large" }, { status: 413 });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  if (Array.isArray(parsed)) {
    if (parsed.length === 0 || parsed.length > MAX_BATCH) {
      return NextResponse.json({ error: "invalid_batch" }, { status: 400 });
    }
    for (const r of parsed) {
      if (!isAllowedJsonRpc(r)) {
        return NextResponse.json({ error: "method_not_allowed" }, { status: 403 });
      }
    }
  } else if (!isAllowedJsonRpc(parsed)) {
    return NextResponse.json({ error: "method_not_allowed" }, { status: 403 });
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), UPSTREAM_TIMEOUT_MS);
  let upstream: Response;
  try {
    upstream = await fetch(UPSTREAM_RPC_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: bodyText,
      signal: ac.signal,
      // No redirect-follow needed for a JSON-RPC endpoint; reject any
      // upstream that tries to redirect the request.
      redirect: "error",
    });
  } catch {
    clearTimeout(timer);
    return NextResponse.json({ error: "upstream_unreachable" }, { status: 502 });
  }
  clearTimeout(timer);

  // Stream-safe-ish: read full body since JSON-RPC responses are small
  // and capped above. We do NOT forward upstream cache-control headers
  // (they sometimes carry per-key metadata and we want browser caches
  // to never persist these responses anyway).
  const responseText = await upstream.text();
  return new NextResponse(responseText, {
    status: upstream.status,
    headers: {
      "content-type": upstream.headers.get("content-type") ?? "application/json",
      "cache-control": "no-store",
    },
  });
}
