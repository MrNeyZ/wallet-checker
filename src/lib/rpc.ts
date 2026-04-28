// Per-method RPC throttling + retry helpers. Scoped to the bursty calls the
// cleaner makes (getParsedTokenAccountsByOwner) so unrelated providers don't
// share the same semaphore.
//
// Why this exists: even on Helius's paid dev plan, individual RPC METHODS have
// per-second rate limits that fire 429 ("Too many requests for a specific RPC
// call") when the cleaner bursts the same call across SPL Token + Token-2022
// for several wallets/clicks. Capping concurrency, spacing calls, and
// retrying with backoff smooths out the burst without changing user-visible
// behavior except under stress.

import { Connection, PublicKey } from "@solana/web3.js";

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

export class RpcRateLimitError extends Error {
  constructor() {
    super("RPC rate limit hit. Please wait a few seconds and try again.");
    this.name = "RpcRateLimitError";
  }
}

function isRateLimitError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const m = err.message;
  if (!m) return false;
  // web3.js wraps RPC errors with messages like:
  //   "failed to get token accounts by owner: 429 Too many requests for a specific RPC call"
  //   "fetch failed" (no body) — but Helius surfaces 429 with the message above
  return /\b429\b|too many requests|rate limit/i.test(m);
}

class RpcThrottle {
  private active = 0;
  private queue: Array<() => void> = [];
  private lastStartTs = 0;

  constructor(
    private readonly maxConcurrent: number,
    private readonly minSpacingMs: number,
  ) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private async acquire(): Promise<void> {
    while (this.active >= this.maxConcurrent) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.active++;
    const elapsed = Date.now() - this.lastStartTs;
    if (elapsed < this.minSpacingMs) {
      await sleep(this.minSpacingMs - elapsed);
    }
    this.lastStartTs = Date.now();
  }

  private release(): void {
    this.active--;
    const next = this.queue.shift();
    if (next) next();
  }
}

// Module-level singleton: shared across all concurrent scans/wallets so a
// burst from the group cleaner never exceeds these limits in aggregate.
const tokenAccountsThrottle = new RpcThrottle(2, 150);

const RETRY_DELAYS_MS = [250, 750, 1500];

async function withRateLimitRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  // 1 initial attempt + up to RETRY_DELAYS_MS.length retries.
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isRateLimitError(err)) throw err;
      lastErr = err;
      if (attempt < RETRY_DELAYS_MS.length) {
        await sleep(RETRY_DELAYS_MS[attempt]);
      }
    }
  }
  // Exhausted retries on a rate-limit error — return a sanitized error
  // (never the raw JSON-RPC body) so the UI stays clean.
  if (lastErr) {
    throw new RpcRateLimitError();
  }
  // Unreachable, but TS needs it.
  throw new Error("withRateLimitRetry: no result");
}

// Throttled, retrying wrapper for connection.getParsedTokenAccountsByOwner.
// Used by the cleanup scanner.
export function getParsedTokenAccountsByOwnerThrottled(
  connection: Connection,
  owner: PublicKey,
  programId: PublicKey,
) {
  return tokenAccountsThrottle.run(() =>
    withRateLimitRetry(() =>
      connection.getParsedTokenAccountsByOwner(owner, { programId }),
    ),
  );
}
