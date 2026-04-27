import { Router } from "express";
import { z } from "zod";
import {
  sendTelegramMessage,
  MissingTelegramConfigError,
  TelegramApiError,
} from "../services/notifications/telegram.js";

const router = Router();

const telegramTestSchema = z.object({
  message: z.string().trim().min(1).max(4096),
});

router.post("/telegram", async (req, res) => {
  const parsed = telegramTestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }

  try {
    await sendTelegramMessage(parsed.data.message);
    res.json({ ok: true });
  } catch (err) {
    if (err instanceof MissingTelegramConfigError) {
      return res.status(503).json({ error: err.message });
    }
    if (err instanceof TelegramApiError) {
      return res.status(502).json({ error: err.message, providerStatus: err.status });
    }
    const message = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: message });
  }
});

export default router;
