// In-memory poller for backend smart-signal evaluation. Mirrors the
// alertPoller pattern but lives in its own module so signals + alerts can
// run independently with different cadences. No persistence: running state
// resets on process restart, matching the user-controlled-poller spec.

interface PollerEntry {
  intervalMs: number;
  handle: NodeJS.Timeout;
}

const pollers = new Map<string, PollerEntry>();

// Signal cadence is gentler than alerts: trade cache TTL is 60 s, so polling
// faster than 60 s would just hit the same cached data. Default of 2 min
// gives the cache a small grace window without piling SolanaTracker bursts.
export const DEFAULT_INTERVAL_MS = 120_000;
export const MIN_INTERVAL_MS = 60_000;
export const MAX_INTERVAL_MS = 60 * 60_000;

export function isPolling(groupId: string): boolean {
  return pollers.has(groupId);
}

export function getRunningPollerCount(): number {
  return pollers.size;
}

export function getPollerStatus(
  groupId: string,
): { running: boolean; intervalMs: number | null } {
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
  // Idempotent: if a poller is already running for this group, don't double
  // up — return its current interval so the caller can verify.
  if (pollers.has(groupId)) {
    return { started: false, intervalMs: pollers.get(groupId)!.intervalMs };
  }
  const safeInterval = Math.max(
    MIN_INTERVAL_MS,
    Math.min(MAX_INTERVAL_MS, intervalMs),
  );
  const wrapped = () => {
    Promise.resolve()
      .then(tick)
      .catch((err) => {
        // Errors are logged but never propagate — the poller keeps ticking.
        console.error(
          `[signalPoller] tick failed for ${groupId}: ${(err as Error).message}`,
        );
      });
  };
  // Run once immediately so users see the first signal batch without waiting
  // a full interval, then schedule subsequent ticks.
  wrapped();
  const handle = setInterval(wrapped, safeInterval);
  pollers.set(groupId, { intervalMs: safeInterval, handle });
  return { started: true, intervalMs: safeInterval };
}

export function stopPoller(groupId: string): boolean {
  const entry = pollers.get(groupId);
  if (!entry) return false;
  clearInterval(entry.handle);
  pollers.delete(groupId);
  return true;
}
