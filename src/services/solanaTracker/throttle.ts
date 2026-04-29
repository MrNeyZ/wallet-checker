// Centralized throttle + retry for SolanaTracker HTTP calls.
//
// All SolanaTracker requests (PnL, Trades, …) must go through
// solanaTrackerFetch() so that:
//   1. At most MAX_CONCURRENCY requests are in-flight at any time.
//   2. There is at least MIN_SPACING_MS between request starts.
//   3. HTTP 429 responses are transparently retried with backoff.
//
// Tuned conservatively for the upstream limiter we actually see in prod
// (~1 req/sec sustained before 429s start). Earlier 2/350ms tuning hit
// the cap on group-open fan-out for medium+ groups; this 1/1200ms ladder
// trades a bit of group-open latency for reliability. The retry ladder
// (5s/15s/30s) absorbs occasional spikes — even one full retry chain
// (5+15+30=50s) is preferable to a hard error in the UI.

const MIN_SPACING_MS = 1200;
const MAX_CONCURRENCY = 1;
const RETRY_BACKOFFS_MS = [5000, 15000, 30000]; // 3 retries on 429

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
    const backoffMs = RETRY_BACKOFFS_MS[attempt];
    // Visibility on the throttle's behavior in prod logs. Helps explain
    // why a particular request took 5-50s to return when the upstream
    // limiter is hot. Path is enough — full URL may include API keys.
    const path = (() => {
      try {
        return new URL(url).pathname;
      } catch {
        return url;
      }
    })();
    console.warn(
      `[SolanaTracker] retry 429 attempt ${attempt + 1}/${RETRY_BACKOFFS_MS.length} on ${path} in ${Math.round(backoffMs / 1000)}s`,
    );
    await sleep(backoffMs);
  }
  throw new Error("solanaTrackerFetch: unreachable");
}
