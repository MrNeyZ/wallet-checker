import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

// Persistent dedup store for emitted smart signals. Mirrors the
// alertSentStore pattern but lives in its own file so signal-dedup keys
// can grow/shrink independently of user-defined alert-rule dedup.
//
// Not yet wired to anything — populated by the future signal evaluator /
// Telegram dispatcher. Keeping it landed early so the storage contract is
// stable before consumers depend on it.

const DATA_FILE = resolve(process.cwd(), "data", "signal-sent.json");
const sent = new Set<string>();

function loadFromDisk(): void {
  if (!existsSync(DATA_FILE)) return;
  let raw: string;
  try {
    raw = readFileSync(DATA_FILE, "utf8");
  } catch (err) {
    console.warn(
      `[signalSentStore] Failed to read ${DATA_FILE}: ${(err as Error).message}. Starting empty.`,
    );
    return;
  }
  try {
    const parsed = JSON.parse(raw) as { keys?: unknown };
    if (!parsed || !Array.isArray(parsed.keys)) {
      console.warn(
        `[signalSentStore] ${DATA_FILE} has unexpected shape. Starting empty.`,
      );
      return;
    }
    for (const k of parsed.keys) {
      if (typeof k === "string") sent.add(k);
    }
  } catch (err) {
    console.warn(
      `[signalSentStore] Corrupt JSON in ${DATA_FILE}: ${(err as Error).message}. Starting empty.`,
    );
  }
}

function persist(): void {
  try {
    mkdirSync(dirname(DATA_FILE), { recursive: true });
    const payload = JSON.stringify({ keys: Array.from(sent) }, null, 2);
    writeFileSync(DATA_FILE, payload, "utf8");
  } catch (err) {
    console.warn(
      `[signalSentStore] Failed to persist ${DATA_FILE}: ${(err as Error).message}`,
    );
  }
}

loadFromDisk();

// Builds a stable, pipe-delimited dedup key. `kind` distinguishes signal
// types so a buy and a dump on the same tx never collide. `uniqueParts`
// covers the per-kind discriminators:
//   - smart / dump:       tx hash
//   - accumulation:       wallet, mint, time-bucket
//   - strong / multiDump: mint, time-bucket
// Pipe-delimited because none of those fields contain a literal "|".
export function signalKey(
  kind: string,
  groupId: string,
  ...uniqueParts: string[]
): string {
  return [kind, groupId, ...uniqueParts].join("|");
}

export function hasSignalBeenSent(key: string): boolean {
  return sent.has(key);
}

export function markSignalSent(key: string): void {
  if (sent.has(key)) return;
  sent.add(key);
  persist();
}

// Test/admin helper. Not used by production code paths; exposed so smoke
// tests and future maintenance scripts can clear stale entries without
// touching the JSON file directly.
export function clearSignalSentStore(): void {
  sent.clear();
  persist();
}
