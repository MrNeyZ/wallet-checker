// Same-origin proxy for the Express backend's group scan-all endpoint.
//
// Why this exists: scan-all needs to be cancellable mid-flight from the
// browser. The original wiring went through a Next.js server action, which
// can't accept an AbortSignal — so a user cancel never reached the Express
// backend and every wallet ran to completion. This route is a thin
// passthrough that forwards `request.signal` to the upstream fetch, which
// in turn fires `req.on("close")` on the Express side and aborts the
// in-flight scanWalletQueued.
//
// Mounted under /web-api (NOT /api) because nginx in production proxies
// /api/* directly to the Express backend, bypassing Next entirely. Mirrors
// the /web-api/wallet/[address]/cleanup-scan layout so all cancellable
// proxy routes share one prefix and the README's nginx config keeps a
// single /api → backend rule.
//
// Auth: middleware.ts only matches page routes, not /web-api/*, so this
// handler enforces the same WEB_PASSWORD cookie gate inline. Without that
// an unauthenticated client could trigger arbitrary group scans and burn
// Helius / RPC quota.

import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, sha256Hex } from "@/lib/auth";
import { BACKEND_URL, authHeaders } from "@/lib/api";

export const runtime = "nodejs";

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ groupId: string }> },
): Promise<Response> {
  const password = process.env.WEB_PASSWORD;
  if (password) {
    const expected = await sha256Hex(password);
    const cookie = req.cookies.get(SESSION_COOKIE)?.value;
    if (!cookie || cookie !== expected) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const { groupId } = await ctx.params;
  const body = await req.text();

  try {
    const upstream = await fetch(
      `${BACKEND_URL}/api/groups/${encodeURIComponent(groupId)}/cleanup-scan-all`,
      {
        method: "POST",
        // Same shared helper used by server actions in lib/api.ts so
        // the upstream auth header is always identical (`x-app-key`).
        headers: {
          "content-type": "application/json",
          ...authHeaders(),
        },
        body,
        cache: "no-store",
        // Forwards a browser-side AbortController.abort() through this
        // route into the Express backend. Express picks it up via
        // req.on("close") in cleanup-scan-all and stops the loop.
        signal: req.signal,
      },
    );
    const text = await upstream.text();
    return new Response(text, {
      status: upstream.status,
      headers: {
        "content-type":
          upstream.headers.get("content-type") ?? "application/json",
      },
    });
  } catch (err) {
    if ((err as Error)?.name === "AbortError" || req.signal.aborted) {
      // 499 Client Closed Request — the browser already knows it
      // cancelled, so this is informational only. The body is empty.
      return new Response(null, { status: 499 });
    }
    return NextResponse.json(
      {
        error: `Upstream fetch failed: ${(err as Error)?.message ?? err}`,
      },
      { status: 502 },
    );
  }
}
