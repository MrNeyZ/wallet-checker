import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const DATA_FILE = resolve(process.cwd(), "data", "alert-sent.json");
const sent = new Set<string>();

function loadFromDisk(): void {
  if (!existsSync(DATA_FILE)) return;
  let raw: string;
  try {
    raw = readFileSync(DATA_FILE, "utf8");
  } catch (err) {
    console.warn(
      `[alertSentStore] Failed to read ${DATA_FILE}: ${(err as Error).message}. Starting empty.`,
    );
    return;
  }
  try {
    const parsed = JSON.parse(raw) as { keys?: unknown };
    if (!parsed || !Array.isArray(parsed.keys)) {
      console.warn(`[alertSentStore] ${DATA_FILE} has unexpected shape. Starting empty.`);
      return;
    }
    for (const k of parsed.keys) {
      if (typeof k === "string") sent.add(k);
    }
  } catch (err) {
    console.warn(
      `[alertSentStore] Corrupt JSON in ${DATA_FILE}: ${(err as Error).message}. Starting empty.`,
    );
  }
}

function persist(): void {
  try {
    mkdirSync(dirname(DATA_FILE), { recursive: true });
    const payload = JSON.stringify({ keys: Array.from(sent) }, null, 2);
    writeFileSync(DATA_FILE, payload, "utf8");
  } catch (err) {
    console.warn(`[alertSentStore] Failed to persist ${DATA_FILE}: ${(err as Error).message}`);
  }
}

loadFromDisk();

export function alertKey(ruleId: string, tx: string): string {
  return `${ruleId}|${tx}`;
}

export function hasAlertBeenSent(key: string): boolean {
  return sent.has(key);
}

export function markAlertSent(key: string): void {
  if (sent.has(key)) return;
  sent.add(key);
  persist();
}
