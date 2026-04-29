import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

export interface GroupWallet {
  address: string;
  label: string | null;
  addedAt: string;
}

export interface Group {
  id: string;
  name: string;
  createdAt: string;
  wallets: GroupWallet[];
}

const DATA_FILE = resolve(process.cwd(), "data", "groups.json");

const groups = new Map<string, Group>();

function loadFromDisk(): void {
  if (!existsSync(DATA_FILE)) return;
  let raw: string;
  try {
    raw = readFileSync(DATA_FILE, "utf8");
  } catch (err) {
    console.warn(`[groupsStore] Failed to read ${DATA_FILE}: ${(err as Error).message}. Starting empty.`);
    return;
  }
  try {
    const parsed = JSON.parse(raw) as { groups?: Group[] };
    if (!parsed || !Array.isArray(parsed.groups)) {
      console.warn(`[groupsStore] ${DATA_FILE} has unexpected shape. Starting empty.`);
      return;
    }
    for (const g of parsed.groups) {
      if (g && typeof g.id === "string") groups.set(g.id, g);
    }
  } catch (err) {
    console.warn(`[groupsStore] Corrupt JSON in ${DATA_FILE}: ${(err as Error).message}. Starting empty.`);
  }
}

// Atomic write: serialize to a tmp file then rename onto the target.
// Protects against torn writes if the process crashes mid-write —
// `groups.json` is the only source of truth, so a corrupt file means
// every group is lost on next startup.
function persist(): void {
  const tmp = `${DATA_FILE}.tmp`;
  try {
    mkdirSync(dirname(DATA_FILE), { recursive: true });
    const payload = JSON.stringify(
      { groups: Array.from(groups.values()) },
      null,
      2,
    );
    writeFileSync(tmp, payload, "utf8");
    renameSync(tmp, DATA_FILE);
  } catch (err) {
    console.warn(
      `[groupsStore] Failed to persist ${DATA_FILE}: ${(err as Error).message}`,
    );
    // Best-effort cleanup; if rename never happened, drop the tmp file
    // so the next persist() doesn't accumulate stale tmp's.
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      // ignore
    }
  }
}

loadFromDisk();

export function createGroup(name: string): Group {
  const group: Group = {
    id: randomUUID(),
    name,
    createdAt: new Date().toISOString(),
    wallets: [],
  };
  groups.set(group.id, group);
  persist();
  return group;
}

export function listGroups(): Group[] {
  return Array.from(groups.values());
}

export function getGroup(id: string): Group | undefined {
  return groups.get(id);
}

export function addWalletToGroup(
  id: string,
  address: string,
  label: string | null,
): { ok: true; wallet: GroupWallet } | { ok: false; error: "not_found" | "duplicate" } {
  const group = groups.get(id);
  if (!group) return { ok: false, error: "not_found" };
  if (group.wallets.some((w) => w.address === address)) {
    return { ok: false, error: "duplicate" };
  }
  const wallet: GroupWallet = {
    address,
    label: label ?? null,
    addedAt: new Date().toISOString(),
  };
  group.wallets.push(wallet);
  persist();
  return { ok: true, wallet };
}

export function deleteGroup(id: string): "ok" | "not_found" {
  const existed = groups.delete(id);
  if (!existed) return "not_found";
  persist();
  return "ok";
}

export function removeWalletFromGroup(
  id: string,
  address: string,
): "ok" | "not_found_group" | "not_found_wallet" {
  const group = groups.get(id);
  if (!group) return "not_found_group";
  const idx = group.wallets.findIndex((w) => w.address === address);
  if (idx === -1) return "not_found_wallet";
  group.wallets.splice(idx, 1);
  persist();
  return "ok";
}
