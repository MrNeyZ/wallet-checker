import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { SESSION_COOKIE, sha256Hex } from "./lib/auth";

export const config = {
  matcher: ["/", "/groups/:path*"],
};

export async function middleware(req: NextRequest) {
  const password = process.env.WEB_PASSWORD;
  if (!password) return NextResponse.next();

  const expected = await sha256Hex(password);
  const cookie = req.cookies.get(SESSION_COOKIE)?.value;
  if (cookie && cookie === expected) return NextResponse.next();

  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.searchParams.set("next", req.nextUrl.pathname);
  return NextResponse.redirect(url);
}
