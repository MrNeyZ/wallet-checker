// Same-origin proxy for the Express backend's per-wallet cleanup-scan
// + burn-candidates endpoints, combined into a single
// AbortController-cancellable round trip. The original wiring was a
// Next.js server action (scanCleanupAction) which can't accept an
// AbortSignal — so the /burner Cancel button stopped the UI but never
// reached the backend. This route forwards `request.signal` to the
// upstream fetches; aborting the browser fetch closes both upstream
// connections, which fires `req.on("close")` on the Express side.
//
// Auth: middleware.ts only matches page routes, not /api/*, so this
// handler enforces the same WEB_PASSWORD cookie gate inline.

import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, sha256Hex } from "@/lib/auth";

export const runtime = "nodejs";

const BACKEND_URL = process.env.BACKEND_URL ?? "http://localhost:3002";
const BACKEND_APP_API_KEY = process.env.BACKEND_APP_API_KEY;

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ address: string }> },
): Promise<Response> {
  const password = process.env.WEB_PASSWORD;
  if (password) {
    const expected = await sha256Hex(password);
    const cookie = req.cookies.get(SESSION_COOKIE)?.value;
    if (!cookie || cookie !== expected) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const { address } = await ctx.params;
  const refresh = req.nextUrl.searchParams.get("refresh");
  const refreshSuffix = refresh && /^(true|1|yes)$/i.test(refresh)
    ? "?refresh=true"
    : "";

  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(BACKEND_APP_API_KEY ? { "x-app-key": BACKEND_APP_API_KEY } : {}),
  };

  try {
    const [scanRes, burnRes] = await Promise.all([
      fetch(
        `${BACKEND_URL}/api/wallet/${encodeURIComponent(address)}/cleanup-scan${refreshSuffix}`,
        { method: "GET", headers, cache: "no-store", signal: req.signal },
      ),
      fetch(
        `${BACKEND_URL}/api/wallet/${encodeURIComponent(address)}/burn-candidates`,
        { method: "GET", headers, cache: "no-store", signal: req.signal },
      ),
    ]);
    if (!scanRes.ok || !burnRes.ok) {
      const detail = !scanRes.ok
        ? await scanRes.text().catch(() => "")
        : await burnRes.text().catch(() => "");
      return NextResponse.json(
        {
          error: `Upstream ${!scanRes.ok ? scanRes.status : burnRes.status}: ${detail.slice(0, 300)}`,
        },
        { status: 502 },
      );
    }
    const [scan, burn] = await Promise.all([scanRes.json(), burnRes.json()]);
    return NextResponse.json({ scan, burn });
  } catch (err) {
    if ((err as Error)?.name === "AbortError" || req.signal.aborted) {
      // 499 Client Closed Request — browser already knows it cancelled.
      return new Response(null, { status: 499 });
    }
    return NextResponse.json(
      { error: `Proxy failed: ${(err as Error)?.message ?? err}` },
      { status: 502 },
    );
  }
}
