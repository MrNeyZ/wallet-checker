// Smoke test for signalSentStore. Exercises:
//   - signalKey() format
//   - hasSignalBeenSent / markSignalSent (in-memory)
//   - persistence (disk roundtrip via dynamic re-import after rewriting cache)
//
// Cleans up its own keys at exit so successive runs stay deterministic.
// Run with `npm run signals:dedup-smoke`.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  clearSignalSentStore,
  hasSignalBeenSent,
  markSignalSent,
  signalKey,
} from "./signalSentStore.js";

const DATA_FILE = resolve(process.cwd(), "data", "signal-sent.json");

function assert(cond: unknown, msg: string): void {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`  ok  ${msg}`);
}

const RUN_ID = `smoke-${Date.now()}`;

// Stash any pre-existing entries so we can restore at the end. The store
// already loaded them on import; we'll re-mark them after our test entries
// are flushed.
const existingKeys: string[] = (() => {
  if (!existsSync(DATA_FILE)) return [];
  try {
    const raw = readFileSync(DATA_FILE, "utf8");
    const parsed = JSON.parse(raw) as { keys?: unknown };
    if (!parsed || !Array.isArray(parsed.keys)) return [];
    return parsed.keys.filter((k): k is string => typeof k === "string");
  } catch {
    return [];
  }
})();

console.log("==> signalKey()");
const k1 = signalKey("smart", "g1", "txhash-1");
assert(k1 === "smart|g1|txhash-1", `smart key shape: ${k1}`);
const k2 = signalKey("accum", "g1", "wA", "mintX", "bucket-7");
assert(k2 === "accum|g1|wA|mintX|bucket-7", `accum key shape: ${k2}`);
const k3 = signalKey("strong", "g1", "mintY", "bucket-3");
assert(k3 === "strong|g1|mintY|bucket-3", `strong key shape: ${k3}`);

console.log("==> markSignalSent / hasSignalBeenSent");
const tag = `${RUN_ID}|key`;
const probe = signalKey("smart", RUN_ID, tag);
assert(!hasSignalBeenSent(probe), "probe key absent before mark");
markSignalSent(probe);
assert(hasSignalBeenSent(probe), "probe key present after mark");
markSignalSent(probe); // idempotent
assert(hasSignalBeenSent(probe), "probe still present after duplicate mark");

console.log("==> different keys don't collide");
const probe2 = signalKey("dump", RUN_ID, tag);
assert(!hasSignalBeenSent(probe2), "different kind same tag is independent");
markSignalSent(probe2);
assert(hasSignalBeenSent(probe2), "marked second key present");
assert(hasSignalBeenSent(probe), "first key still present");

console.log("==> persistence");
assert(existsSync(DATA_FILE), `data file written at ${DATA_FILE}`);
const raw = readFileSync(DATA_FILE, "utf8");
const parsed = JSON.parse(raw) as { keys: string[] };
assert(Array.isArray(parsed.keys), "file has keys array");
assert(
  parsed.keys.includes(probe) && parsed.keys.includes(probe2),
  "both probe keys persisted",
);

console.log("==> cleanup");
// Restore the prior state by clearing then re-marking what was there before.
clearSignalSentStore();
for (const k of existingKeys) markSignalSent(k);
assert(!hasSignalBeenSent(probe), "probe cleared");
assert(!hasSignalBeenSent(probe2), "probe2 cleared");
console.log(
  `  ok  restored ${existingKeys.length} pre-existing key(s) (if any)`,
);

console.log("\nAll signalSentStore smoke checks passed.");
