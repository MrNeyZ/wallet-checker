"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { api } from "@/lib/api";

export async function createGroupAction(formData: FormData) {
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return;
  const group = await api.createGroup(name);
  revalidatePath("/groups");
  redirect(`/groups/${group.id}`);
}

export async function addWalletAction(groupId: string, formData: FormData) {
  const wallet = String(formData.get("wallet") ?? "").trim();
  const label = String(formData.get("label") ?? "").trim();
  if (!wallet) return;
  await api.addWallet(groupId, wallet, label || undefined);
  revalidatePath(`/groups/${groupId}`);
  revalidatePath("/groups");
}

export async function removeWalletAction(groupId: string, wallet: string) {
  await api.removeWallet(groupId, wallet);
  revalidatePath(`/groups/${groupId}`);
  revalidatePath("/groups");
}

export async function startSignalMonitorAction(
  groupId: string,
  intervalMs: number,
): Promise<{ ok: boolean; error?: string }> {
  try {
    await api.startSignalMonitor(groupId, intervalMs);
    revalidatePath(`/groups/${groupId}`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Start failed" };
  }
}

export async function stopSignalMonitorAction(
  groupId: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    await api.stopSignalMonitor(groupId);
    revalidatePath(`/groups/${groupId}`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Stop failed" };
  }
}

export async function startAlertsAction(
  groupId: string,
  intervalMs: number,
): Promise<{ ok: boolean; error?: string }> {
  try {
    await api.startAlerts(groupId, intervalMs);
    revalidatePath(`/groups/${groupId}`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Start failed" };
  }
}

export async function stopAlertsAction(
  groupId: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    await api.stopAlerts(groupId);
    revalidatePath(`/groups/${groupId}`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Stop failed" };
  }
}

export async function createAlertRuleAction(
  groupId: string,
  formData: FormData,
): Promise<{ ok: boolean; error?: string }> {
  const name = String(formData.get("name") ?? "").trim();
  const minUsdRaw = String(formData.get("minUsd") ?? "").trim();
  const minUsd = Number(minUsdRaw);
  const token = String(formData.get("token") ?? "").trim();
  const sideRaw = String(formData.get("side") ?? "");
  const program = String(formData.get("program") ?? "").trim();
  const enabled = formData.get("enabled") !== null;

  if (!name) return { ok: false, error: "Name is required" };
  if (!Number.isFinite(minUsd) || minUsd < 0) {
    return { ok: false, error: "minUsd must be a number ≥ 0" };
  }
  const side = sideRaw === "buy" || sideRaw === "sell" ? sideRaw : undefined;

  try {
    await api.createAlertRule(groupId, {
      name,
      minUsd,
      token: token || undefined,
      side,
      program: program || undefined,
      enabled,
    });
    revalidatePath(`/groups/${groupId}`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Create failed" };
  }
}

export async function toggleAlertRuleAction(
  groupId: string,
  alertId: string,
  enabled: boolean,
): Promise<{ ok: boolean; error?: string }> {
  try {
    await api.patchAlertRule(groupId, alertId, { enabled });
    revalidatePath(`/groups/${groupId}`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Patch failed" };
  }
}

export async function deleteAlertRuleAction(
  groupId: string,
  alertId: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    await api.deleteAlertRule(groupId, alertId);
    revalidatePath(`/groups/${groupId}`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Delete failed" };
  }
}

export async function buildCloseEmptyTxAction(
  wallet: string,
): Promise<
  | { ok: true; result: import("@/lib/api").BuildCloseEmptyTxResult }
  | { ok: false; error: string }
> {
  try {
    const result = await api.buildCloseEmptyTx(wallet);
    return { ok: true, result };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Build failed" };
  }
}

export async function scanCleanupAction(
  wallet: string,
  opts: { refresh?: boolean } = {},
): Promise<
  | {
      ok: true;
      scan: import("@/lib/api").CleanupScanResult;
      burn: import("@/lib/api").BurnCandidatesResult;
    }
  | { ok: false; error: string }
> {
  try {
    const [scan, burn] = await Promise.all([
      api.getCleanupScan(wallet, opts),
      // Burn-candidates internally calls scanWalletForCleanup, so it shares
      // the same cache and refresh semantics — no separate flag needed.
      api.getBurnCandidates(wallet),
    ]);
    return { ok: true, scan, burn };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Scan failed" };
  }
}

export async function loadOverviewAction(
  groupId: string,
): Promise<
  | { ok: true; data: import("@/lib/api").OverviewResponse }
  | { ok: false; error: string }
> {
  try {
    const data = await api.getOverview(groupId);
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Failed to load" };
  }
}

export async function loadPortfolioAction(
  groupId: string,
): Promise<
  | { ok: true; data: import("@/lib/api").PortfolioResponse }
  | { ok: false; error: string }
> {
  try {
    const data = await api.getPortfolioSummary(groupId);
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Failed to load" };
  }
}

export async function loadLpAction(
  groupId: string,
): Promise<
  | { ok: true; data: import("@/lib/api").GroupLpResponse }
  | { ok: false; error: string }
> {
  try {
    const data = await api.getGroupLpPositions(groupId);
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Failed to load" };
  }
}

export async function loadAirdropsAction(
  groupId: string,
): Promise<
  | { ok: true; data: import("@/lib/api").AirdropsState }
  | { ok: false; error: string }
> {
  try {
    const data = await api.getGroupAirdrops(groupId);
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Failed to load" };
  }
}

export async function loadTokenSummaryAction(
  groupId: string,
): Promise<
  | { ok: true; data: import("@/lib/api").TokenActivityResponse }
  | { ok: false; error: string }
> {
  try {
    const data = await api.getTokenSummary(groupId);
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Failed to load" };
  }
}

export async function loadTradesAction(
  groupId: string,
  filters: import("@/lib/api").GroupTradesFilters,
): Promise<
  | { ok: true; data: import("@/lib/api").GroupTradesResponse }
  | { ok: false; error: string }
> {
  try {
    const data = await api.getGroupTrades(groupId, filters);
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Failed to load" };
  }
}

export async function evaluateAlertsAction(
  groupId: string,
): Promise<{ ok: boolean; matches?: number; error?: string }> {
  try {
    const res = await api.evaluateAlerts(groupId);
    revalidatePath(`/groups/${groupId}`);
    return { ok: true, matches: res.matches.length };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Evaluate failed" };
  }
}
