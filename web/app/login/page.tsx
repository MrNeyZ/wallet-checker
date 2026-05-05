import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { loginAction } from "./actions";
import LoginForm from "./form";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Login" };

// Page-level shell is intentionally bare — the Gate component (form.tsx)
// is a full-screen takeover (`position: fixed; inset: 0`). Wrapping it in
// the dashboard's Tailwind container would clip the dark-purple wash and
// break pixel parity with the VictoryLabs source.
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  if (!process.env.WEB_PASSWORD) {
    redirect("/groups");
  }
  const sp = await searchParams;
  const next = sp.next ?? "/groups";
  return <LoginForm next={next} action={loginAction} />;
}
