"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE, sha256Hex } from "@/lib/auth";

const ONE_WEEK = 60 * 60 * 24 * 7;

export async function loginAction(
  formData: FormData,
): Promise<{ ok: false; error: string } | void> {
  const password = process.env.WEB_PASSWORD;
  if (!password) {
    redirect("/groups");
  }
  const submitted = String(formData.get("password") ?? "");
  if (!submitted) return { ok: false, error: "Password is required" };
  if (submitted !== password) return { ok: false, error: "Wrong password" };

  const value = await sha256Hex(password);
  const jar = await cookies();
  jar.set(SESSION_COOKIE, value, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: ONE_WEEK,
  });

  const next = String(formData.get("next") ?? "/groups");
  const safeNext = next.startsWith("/") && !next.startsWith("//") ? next : "/groups";
  redirect(safeNext);
}

export async function logoutAction() {
  const jar = await cookies();
  jar.delete(SESSION_COOKIE);
  redirect("/login");
}
