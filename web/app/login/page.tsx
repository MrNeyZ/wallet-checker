import { redirect } from "next/navigation";
import { loginAction } from "./actions";
import LoginForm from "./form";

export const dynamic = "force-dynamic";

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
  return (
    <div className="mx-auto max-w-sm space-y-4 py-12">
      <h1 className="text-xl font-semibold tracking-tight">Sign in</h1>
      <p className="text-sm text-zinc-600">
        Enter the dashboard password configured via <code className="text-xs">WEB_PASSWORD</code>.
      </p>
      <LoginForm next={next} action={loginAction} />
    </div>
  );
}
