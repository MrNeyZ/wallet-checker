import { env } from "../../config/env.js";

export class MissingTelegramConfigError extends Error {
  constructor() {
    super("TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is not configured");
    this.name = "MissingTelegramConfigError";
  }
}

export class TelegramApiError extends Error {
  constructor(
    message: string,
    public status?: number,
  ) {
    super(message);
    this.name = "TelegramApiError";
  }
}

export async function sendTelegramMessage(text: string): Promise<void> {
  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    throw new MissingTelegramConfigError();
  }

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Network error";
    throw new TelegramApiError(`Telegram request failed: ${message}`);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new TelegramApiError(
      `Telegram returned ${res.status}: ${body.slice(0, 300)}`,
      res.status,
    );
  }
}
