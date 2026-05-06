interface PollerEntry {
  intervalMs: number;
  handle: NodeJS.Timeout;
  // True while a tick is in flight. The setInterval callback short-
  // circuits on a true value so a slow tick (e.g., upstream PnL
  // provider hanging at the request timeout) can't stack overlapping
  // ticks that all hit the same RPC quotas at once. The next interval
  // tick after the slow run completes will resume normal cadence.
  inFlight: boolean;
}

const pollers = new Map<string, PollerEntry>();

export const DEFAULT_INTERVAL_MS = 60_000;
export const MIN_INTERVAL_MS = 5_000;
export const MAX_INTERVAL_MS = 60 * 60_000;

export function isPolling(groupId: string): boolean {
  return pollers.has(groupId);
}

export function getRunningPollerCount(): number {
  return pollers.size;
}

export function getPollerStatus(groupId: string): { running: boolean; intervalMs: number | null } {
  const entry = pollers.get(groupId);
  return entry
    ? { running: true, intervalMs: entry.intervalMs }
    : { running: false, intervalMs: null };
}

export function startPoller(
  groupId: string,
  intervalMs: number,
  tick: () => Promise<unknown>,
): { started: boolean; intervalMs: number } {
  if (pollers.has(groupId)) {
    return { started: false, intervalMs: pollers.get(groupId)!.intervalMs };
  }
  const safeInterval = Math.max(MIN_INTERVAL_MS, Math.min(MAX_INTERVAL_MS, intervalMs));
  // Pre-create the entry so the wrapper closure can read/write its
  // `inFlight` flag without a separate Map lookup per tick.
  const entry: PollerEntry = {
    intervalMs: safeInterval,
    handle: null as unknown as NodeJS.Timeout,
    inFlight: false,
  };
  const wrapped = () => {
    if (entry.inFlight) {
      // Skip — previous tick still running. Drops the missed beat
      // instead of stacking; the next setInterval fire after `tick`
      // resolves will resume normal cadence.
      return;
    }
    entry.inFlight = true;
    Promise.resolve()
      .then(tick)
      .catch((err) => {
        console.error(`[alertPoller] tick failed for ${groupId}: ${(err as Error).message}`);
      })
      .finally(() => {
        entry.inFlight = false;
      });
  };
  // run immediately, then on interval
  wrapped();
  entry.handle = setInterval(wrapped, safeInterval);
  pollers.set(groupId, entry);
  return { started: true, intervalMs: safeInterval };
}

export function stopPoller(groupId: string): boolean {
  const entry = pollers.get(groupId);
  if (!entry) return false;
  clearInterval(entry.handle);
  pollers.delete(groupId);
  return true;
}
