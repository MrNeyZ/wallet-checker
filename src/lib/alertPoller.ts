interface PollerEntry {
  intervalMs: number;
  handle: NodeJS.Timeout;
}

const pollers = new Map<string, PollerEntry>();

export const DEFAULT_INTERVAL_MS = 60_000;
export const MIN_INTERVAL_MS = 5_000;
export const MAX_INTERVAL_MS = 60 * 60_000;

export function isPolling(groupId: string): boolean {
  return pollers.has(groupId);
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
  const wrapped = () => {
    Promise.resolve()
      .then(tick)
      .catch((err) => {
        console.error(`[alertPoller] tick failed for ${groupId}: ${(err as Error).message}`);
      });
  };
  // run immediately, then on interval
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
