import type { GroupWallet } from "../../lib/groupsStore.js";
import { applyTradeFilters, fetchGroupTrades, QUOTE_MINTS, type MergedTrade } from "./groupTrades.js";
import { listAlertsForGroup } from "../../lib/alertsStore.js";
import { sendTelegramMessage } from "../notifications/telegram.js";
import {
  alertKey,
  hasAlertBeenSent,
  markAlertSent,
} from "../../lib/alertSentStore.js";

export interface AlertMatch {
  ruleId: string;
  ruleName: string;
  wallet: string;
  label: string | null;
  tx: unknown;
  time: number;
  program: unknown;
  tokenSymbol: string | null;
  volumeUsd: number;
}

export interface FailedWallet {
  wallet: string;
  label: string | null;
  error: string;
}

export interface AlertEvaluationResult {
  evaluatedRules: number;
  matches: AlertMatch[];
  failedWallets: FailedWallet[];
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function shortWallet(addr: string): string {
  return addr.length > 9 ? `${addr.slice(0, 4)}…${addr.slice(-4)}` : addr;
}

export function formatAlertTelegramMessage(m: AlertMatch): string {
  const usd = m.volumeUsd.toFixed(2);
  const symbol = m.tokenSymbol ?? "?";
  const program = typeof m.program === "string" ? m.program : "?";
  const tx = typeof m.tx === "string" ? m.tx : "";
  return [
    `<b>🚨 Alert: ${escapeHtml(m.ruleName)}</b>`,
    "",
    `💰 $${usd}`,
    `🪙 ${escapeHtml(symbol)}`,
    `📍 ${escapeHtml(program)}`,
    `👛 ${shortWallet(m.wallet)}`,
    "",
    `<a href="https://solscan.io/tx/${encodeURIComponent(tx)}">View transaction</a>`,
  ].join("\n");
}

function nonQuoteTokenSymbol(trade: MergedTrade): string | null {
  const fromLeg = trade.from as { address?: unknown; token?: { symbol?: unknown } } | null;
  const toLeg = trade.to as { address?: unknown; token?: { symbol?: unknown } } | null;
  const fromAddr = typeof fromLeg?.address === "string" ? fromLeg.address : null;
  const toAddr = typeof toLeg?.address === "string" ? toLeg.address : null;
  const fromSym = typeof fromLeg?.token?.symbol === "string" ? fromLeg.token.symbol : null;
  const toSym = typeof toLeg?.token?.symbol === "string" ? toLeg.token.symbol : null;
  const fromQuote = fromAddr ? QUOTE_MINTS.has(fromAddr) : false;
  const toQuote = toAddr ? QUOTE_MINTS.has(toAddr) : false;
  if (fromQuote && !toQuote) return toSym;
  if (toQuote && !fromQuote) return fromSym;
  return toSym ?? fromSym;
}

export const DEFAULT_ALERT_PER_WALLET_LIMIT = 20;
export const MIN_ALERT_PER_WALLET_LIMIT = 5;
export const MAX_ALERT_PER_WALLET_LIMIT = 100;

export async function evaluateGroupAlerts(
  group: { id: string; wallets: GroupWallet[] },
  perWalletLimit: number = DEFAULT_ALERT_PER_WALLET_LIMIT,
): Promise<AlertEvaluationResult> {
  const rules = listAlertsForGroup(group.id).filter((r) => r.enabled);

  if (rules.length === 0 || group.wallets.length === 0) {
    return { evaluatedRules: rules.length, matches: [], failedWallets: [] };
  }

  const safeLimit = Math.max(
    MIN_ALERT_PER_WALLET_LIMIT,
    Math.min(MAX_ALERT_PER_WALLET_LIMIT, perWalletLimit),
  );
  const { merged, failedWallets } = await fetchGroupTrades(group, safeLimit);

  const matches: AlertMatch[] = [];
  for (const rule of rules) {
    const hits = applyTradeFilters(merged, {
      minUsd: rule.minUsd,
      token: rule.token,
      side: rule.side,
      program: rule.program,
    });
    for (const t of hits) {
      const usd = (t.volume as { usd?: unknown } | null)?.usd;
      const volumeUsd = typeof usd === "number" && Number.isFinite(usd) ? usd : 0;
      matches.push({
        ruleId: rule.id,
        ruleName: rule.name,
        wallet: t.wallet,
        label: t.label,
        tx: t.tx,
        time: t.time,
        program: t.program,
        tokenSymbol: nonQuoteTokenSymbol(t),
        volumeUsd,
      });
    }
  }

  const seenInRequest = new Set<string>();
  for (const m of matches) {
    const tx = typeof m.tx === "string" ? m.tx : "";
    if (!tx) continue;
    const key = alertKey(m.ruleId, tx);
    if (seenInRequest.has(key)) continue;
    seenInRequest.add(key);
    if (hasAlertBeenSent(key)) continue;
    try {
      await sendTelegramMessage(formatAlertTelegramMessage(m));
      markAlertSent(key);
    } catch (err) {
      console.error(
        `[alertEvaluator] Telegram send failed for rule=${m.ruleId} tx=${tx.slice(0, 16)}: ${(err as Error).message}`,
      );
    }
  }

  return { evaluatedRules: rules.length, matches, failedWallets };
}
