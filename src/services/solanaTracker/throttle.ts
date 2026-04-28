// Centralized throttle + retry for SolanaTracker HTTP calls.
//
// All SolanaTracker requests (PnL, Trades, …) must go through
// solanaTrackerFetch() so that:
//   1. At most MAX_CONCURRENCY requests are in-flight at any time.
//   2. There is at least MIN_SPACING_MS between request starts.
//   3. HTTP 429 responses are transparently retried with backoff.
//
// Why: group-open fans out per-wallet PnL/Trades requests; on large groups
// this trips the upstream limiter (HTTP 429). A single in-process queue
// keeps fan-out under control without per-call-site logic.

// Bumped from 1/750ms to 2/350ms to roughly halve group-open latency on
// large groups while staying under SolanaTracker's free-tier rate cap. The
// retry-on-429 ladder below is the safety net if the tighter pacing trips
// the upstream limiter.
const MIN_SPACING_MS = 350;
const MAX_CONCURRENCY = 2;
const RETRY_BACKOFFS_MS = [2000, 5000, 10000]; // 3 retries on 429

let inFlight = 0;
let lastStartedAt = 0;
const waiters: Array<() => void> = [];

const sleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));

async function acquire(): Promise<void> {
  if (inFlight >= MAX_CONCURRENCY) {
    await new Promise<void>((res) => waiters.push(res));
    return acquire();
  }
  const wait = lastStartedAt + MIN_SPACING_MS - Date.now();
  if (wait > 0) await sleep(wait);
  inFlight++;
  lastStartedAt = Date.now();
}

function release(): void {
  inFlight--;
  const next = waiters.shift();
  if (next) next();
}

export async function solanaTrackerFetch(
  url: string,
  init?: RequestInit,
): Promise<Response> {
  for (let attempt = 0; attempt <= RETRY_BACKOFFS_MS.length; attempt++) {
    await acquire();
    let res: Response;
    try {
      res = await fetch(url, init);
    } finally {
      release();
    }
    if (res.status !== 429 || attempt === RETRY_BACKOFFS_MS.length) {
      return res;
    }
    // Drain body so the underlying connection can be reused.
    await res.text().catch(() => "");
    await sleep(RETRY_BACKOFFS_MS[attempt]);
  }
  throw new Error("solanaTrackerFetch: unreachable");
}
