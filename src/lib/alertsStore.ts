import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export interface AlertRule {
  id: string;
  groupId: string;
  name: string;
  enabled: boolean;
  minUsd: number;
  token?: string;
  side?: "buy" | "sell";
  program?: string;
  createdAt: string;
}

const DATA_FILE = resolve(process.cwd(), "data", "alerts.json");
const alerts = new Map<string, AlertRule>();

function loadFromDisk(): void {
  if (!existsSync(DATA_FILE)) return;
  let raw: string;
  try {
    raw = readFileSync(DATA_FILE, "utf8");
  } catch (err) {
    console.warn(
      `[alertsStore] Failed to read ${DATA_FILE}: ${(err as Error).message}. Starting empty.`,
    );
    return;
  }
  try {
    const parsed = JSON.parse(raw) as { alerts?: AlertRule[] };
    if (!parsed || !Array.isArray(parsed.alerts)) {
      console.warn(`[alertsStore] ${DATA_FILE} has unexpected shape. Starting empty.`);
      return;
    }
    for (const a of parsed.alerts) {
      if (a && typeof a.id === "string") alerts.set(a.id, a);
    }
  } catch (err) {
    console.warn(
      `[alertsStore] Corrupt JSON in ${DATA_FILE}: ${(err as Error).message}. Starting empty.`,
    );
  }
}

function persist(): void {
  try {
    mkdirSync(dirname(DATA_FILE), { recursive: true });
    const payload = JSON.stringify({ alerts: Array.from(alerts.values()) }, null, 2);
    writeFileSync(DATA_FILE, payload, "utf8");
  } catch (err) {
    console.warn(`[alertsStore] Failed to persist ${DATA_FILE}: ${(err as Error).message}`);
  }
}

loadFromDisk();

export interface CreateAlertInput {
  groupId: string;
  name: string;
  minUsd: number;
  token?: string;
  side?: "buy" | "sell";
  program?: string;
  enabled?: boolean;
}

export interface UpdateAlertPatch {
  name?: string;
  minUsd?: number;
  token?: string;
  side?: "buy" | "sell";
  program?: string;
  enabled?: boolean;
}

export function listAlertsForGroup(groupId: string): AlertRule[] {
  return Array.from(alerts.values()).filter((a) => a.groupId === groupId);
}

export function getAlert(id: string): AlertRule | undefined {
  return alerts.get(id);
}

export function createAlert(input: CreateAlertInput): AlertRule {
  const rule: AlertRule = {
    id: randomUUID(),
    groupId: input.groupId,
    name: input.name,
    enabled: input.enabled ?? true,
    minUsd: input.minUsd,
    token: input.token,
    side: input.side,
    program: input.program,
    createdAt: new Date().toISOString(),
  };
  alerts.set(rule.id, rule);
  persist();
  return rule;
}

export function updateAlert(id: string, patch: UpdateAlertPatch): AlertRule | null {
  const cur = alerts.get(id);
  if (!cur) return null;
  const next: AlertRule = { ...cur };
  if (patch.name !== undefined) next.name = patch.name;
  if (patch.minUsd !== undefined) next.minUsd = patch.minUsd;
  if (patch.token !== undefined) next.token = patch.token;
  if (patch.side !== undefined) next.side = patch.side;
  if (patch.program !== undefined) next.program = patch.program;
  if (patch.enabled !== undefined) next.enabled = patch.enabled;
  alerts.set(id, next);
  persist();
  return next;
}

export function deleteAlert(id: string): boolean {
  if (!alerts.has(id)) return false;
  alerts.delete(id);
  persist();
  return true;
}
