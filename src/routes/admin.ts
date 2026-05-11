// Operator-only diagnostic endpoints. Read-only, no side effects.
//
// Mounted under /api/admin/* so the global `apiKeyAuth` middleware
// (x-app-key header check) gates the entire prefix. There is no
// separate /admin role — anyone holding the BACKEND_APP_API_KEY can
// hit these endpoints. That key is already required for every other
// /api/* call, so this doesn't widen the trust boundary.
//
// Designed to be safe to scrape on an interval: no allocations beyond
// the returned JSON, no RPC, no DAS, no DB. The handlers should never
// return wallet addresses, cache keys, or anything that would leak
// per-user state.

import { Router } from "express";
import { getScanCacheStats } from "../lib/scanner.js";
import { getScanQueueStats } from "../services/cleanup/scanQueue.js";

const router = Router();

router.get("/scan-stats", (_req, res) => {
  res.json({
    scanCache: getScanCacheStats(),
    scanQueue: getScanQueueStats(),
    now: new Date().toISOString(),
  });
});

export default router;
