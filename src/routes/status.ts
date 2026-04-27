import { Router } from "express";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { env } from "../config/env.js";
import { getRunningPollerCount } from "../lib/alertPoller.js";

const router = Router();

const DATA_DIR = resolve(process.cwd(), "data");

router.get("/", (_req, res) => {
  res.json({
    ok: true,
    env: {
      solanaTrackerConfigured: Boolean(env.SOLANATRACKER_API_KEY),
      heliusConfigured: Boolean(env.HELIUS_API_KEY),
      telegramConfigured: Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID),
      appAuthEnabled: Boolean(env.APP_API_KEY),
    },
    pollers: {
      runningCount: getRunningPollerCount(),
    },
    dataFiles: {
      groups: existsSync(`${DATA_DIR}/groups.json`),
      alerts: existsSync(`${DATA_DIR}/alerts.json`),
      alertSent: existsSync(`${DATA_DIR}/alert-sent.json`),
    },
  });
});

export default router;
