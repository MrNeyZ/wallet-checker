// Sanity-check route that renders the UI kit's reference dashboard.
// Visit /preview after styling changes to confirm tokens, animations,
// and components still look right in isolation.
import DashboardPreview from "@/ui-kit/examples/dashboard-preview";

export const dynamic = "force-static";

export default function Page() {
  return <DashboardPreview />;
}
