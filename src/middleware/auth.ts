import type { Request, Response, NextFunction } from "express";
import { env } from "../config/env.js";

const EXEMPT_PATHS = new Set<string>(["/health"]);

export function apiKeyAuth(req: Request, res: Response, next: NextFunction): void {
  const expected = env.APP_API_KEY;
  if (!expected) {
    next();
    return;
  }
  if (EXEMPT_PATHS.has(req.path)) {
    next();
    return;
  }
  const provided = req.header("x-app-key");
  if (provided && provided === expected) {
    next();
    return;
  }
  res.status(401).json({ error: "Unauthorized" });
}
