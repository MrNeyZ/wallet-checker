import type { Group } from "../../lib/groupsStore.js";
import { buildPnlOverview } from "./groupPnl.js";
import { fetchGroupTrades, type FailedWallet, type MergedTrade } from "./groupTrades.js";
import {
  DEFAULT_SIGNAL_SETTINGS,
  buildAllSignals,
  computeWalletScores,
  type AccumulationSignal,
  type DumpSignal,
  type MultiDumpSignal,
  type OverviewResult,
  type SmartSignal,
  type StrongSignal,
  type TokenLeg,
  type TradeRecord,
} from "../../lib/signals/index.js";
import {
  hasSignalBeenSent,
  markSignalSent,
  signalKey,
} from "../../lib/signalSentStore.js";
import {
  MissingTelegramConfigError,
  sendTelegramMessage,
} from "../notifications/telegram.js";

// Default fetch budget — mirrors the frontend's default trades request and
// gives the cluster windows (5–10 min) plenty of recent trades to work with.
const DEFAULT_PER_WALLET_LIMIT = 10;

interface SignalBuckets {
  smart: SmartSignal[];
  accumulation: AccumulationSignal[];
  strong: StrongSignal[];
  dump: DumpSignal[];
  multiDump: MultiDumpSignal[];
}

export interface GroupSignalsResult {
  groupId: string;
  groupName: string;
  counts: {
    smart: number;
    accumulation: number;
    strong: number;
    dump: number;
    multiDump: number;
  };
  // Full signal lists (kept for backwards compatibility with the previous
  // response shape and any consumer that wants the unfiltered set).
  signals: SignalBuckets;
  // Partition of `signals` against the dedup store. Marking only happens
  // for `newSignals`; `seenSignals` are the already-emitted ones the future
  // Telegram dispatcher should skip.
  newSignals: SignalBuckets;
  seenSignals: SignalBuckets;
  failedWallets: FailedWallet[];
  // Telegram dispatch outcomes. Populated only when Telegram is configured
  // AND there were new signals to send. Missing config or per-message
  // failures are reported via `telegramWarning`; the endpoint stays 200.
  telegramSent?: number;
  telegramFailed?: number;
  telegramWarning?: string;
}

// Defensive coercion from the loose MergedTrade (provider fields are
// unknown) to the strict TradeRecord the signals module consumes. Returns
// null when any required leg field is missing/wrong-shaped — those rows are
// silently dropped from the trades feed for signal purposes.
function asString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function asFiniteNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function asTokenLeg(raw: unknown): TokenLeg | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const address = asString(r.address);
  const amount = asFiniteNumber(r.amount);
  const priceUsd = asFiniteNumber(r.priceUsd);
  const tok = r.token as Record<string, unknown> | undefined;
  if (!address || amount === null || priceUsd === null || !tok) return null;
  const symbol = asString(tok.symbol) ?? "";
  const name = asString(tok.name) ?? "";
  return {
    address,
    amount,
    token: { symbol, name },
    priceUsd,
  };
}

function toTradeRecord(m: MergedTrade): TradeRecord | null {
  const tx = asString(m.tx);
  if (!tx) return null;
  const program = asString(m.program) ?? "";
  const from = asTokenLeg(m.from);
  const to = asTokenLeg(m.to);
  if (!from || !to) return null;
  const vol = m.volume as Record<string, unknown> | null | undefined;
  const usd = vol ? asFiniteNumber(vol.usd) : null;
  const sol = vol ? asFiniteNumber(vol.sol) : null;
  return {
    wallet: m.wallet,
    label: m.label,
    tx,
    time: m.time,
    program,
    from,
    to,
    volume: { usd: usd ?? 0, sol: sol ?? 0 },
  };
}

// ============================================================================
// Telegram message formatters — one per signal kind.
// All use HTML parse_mode (matches sendTelegramMessage), keep messages short
// (≤ ~6 lines), and link to Solscan for the most-actionable tx in the cluster.
// ============================================================================

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function shortAddr(addr: string, head = 4, tail = 4): string {
  if (!addr || addr.length <= head + tail + 1) return addr;
  return `${addr.slice(0, head)}…${addr.slice(-tail)}`;
}

function formatUsd(usd: number): string {
  // Two-decimal currency for compact Telegram bodies; lossy for large
  // values but readable in chat.
  const abs = Math.abs(usd);
  if (abs >= 1000) return `$${Math.round(usd).toLocaleString("en-US")}`;
  return `$${usd.toFixed(2)}`;
}

function tokenLabel(symbol: string | null, name: string | null, mint: string): string {
  if (symbol && name && symbol !== name) return `${symbol} · ${name}`;
  return symbol ?? name ?? `${mint.slice(0, 6)}…`;
}

function walletLabel(label: string | null, address: string): string {
  return label ?? shortAddr(address);
}

function txLink(tx: string, label: string): string {
  return `<a href="https://solscan.io/tx/${encodeURIComponent(tx)}">${escapeHtml(label)}</a>`;
}

function durationLabel(firstMs: number, lastMs: number): string {
  const sec = Math.max(0, Math.round((lastMs - firstMs) / 1000));
  if (sec < 60) return `${sec}s`;
  return `${Math.floor(sec / 60)}m ${sec % 60}s`;
}

export function formatSmartSignalMessage(s: SmartSignal, groupName: string): string {
  const t = s.trade;
  const tok = tokenLabel(t.to.token?.symbol ?? null, t.to.token?.name ?? null, t.to.address);
  return [
    `<b>🔥 Top wallet buy</b>`,
    `👛 ${escapeHtml(walletLabel(t.label, t.wallet))} · #${s.rank} (score ${s.scored.score})`,
    `🪙 ${escapeHtml(tok)}`,
    `💰 ${formatUsd(t.volume?.usd ?? 0)}`,
    `${txLink(t.tx, "View transaction")}`,
    `<i>${escapeHtml(groupName)}</i>`,
  ].join("\n");
}

export function formatAccumulationMessage(s: AccumulationSignal, groupName: string): string {
  const tok = tokenLabel(s.tokenSymbol, s.tokenName, s.tokenMint);
  return [
    `<b>🧠 Early accumulation</b>`,
    `👛 ${escapeHtml(walletLabel(s.walletLabel, s.wallet))} · #${s.rank} (score ${s.score})`,
    `🪙 ${escapeHtml(tok)}`,
    `🔁 ${s.buyCount} buys in ${durationLabel(s.firstTime, s.lastTime)} · total ${formatUsd(s.totalUsd)}`,
    `${txLink(s.latestTx, "Latest tx")}`,
    `<i>${escapeHtml(groupName)}</i>`,
  ].join("\n");
}

export function formatStrongSignalMessage(s: StrongSignal, groupName: string, windowMinutes: number): string {
  const tok = tokenLabel(s.tokenSymbol, s.tokenName, s.tokenMint);
  const wallets = s.topWallets
    .map((w) => `${escapeHtml(walletLabel(w.label, w.wallet))} #${w.rank}`)
    .join(", ");
  const more = s.walletCount > s.topWallets.length
    ? ` +${s.walletCount - s.topWallets.length} more`
    : "";
  return [
    `<b>🚨 Strong buy signal</b>`,
    `🪙 ${escapeHtml(tok)} · ${s.walletCount} top wallets in ≤${windowMinutes}m`,
    `💰 total bought ${formatUsd(s.totalUsd)}`,
    `👛 ${wallets}${more}`,
    `${txLink(s.latestTx, "Latest tx")}`,
    `<i>${escapeHtml(groupName)}</i>`,
  ].join("\n");
}

export function formatDumpSignalMessage(s: DumpSignal, groupName: string): string {
  const t = s.trade;
  const tok = tokenLabel(t.from.token?.symbol ?? null, t.from.token?.name ?? null, t.from.address);
  return [
    `<b>🔻 Top wallet dump</b>`,
    `👛 ${escapeHtml(walletLabel(t.label, t.wallet))} · #${s.rank} (score ${s.scored.score})`,
    `🪙 ${escapeHtml(tok)}`,
    `💰 sold ${formatUsd(t.volume?.usd ?? 0)}`,
    `${txLink(t.tx, "View transaction")}`,
    `<i>${escapeHtml(groupName)}</i>`,
  ].join("\n");
}

export function formatMultiDumpMessage(s: MultiDumpSignal, groupName: string, windowMinutes: number): string {
  const tok = tokenLabel(s.tokenSymbol, s.tokenName, s.tokenMint);
  const wallets = s.topWallets
    .map((w) => `${escapeHtml(walletLabel(w.label, w.wallet))} #${w.rank}`)
    .join(", ");
  const more = s.walletCount > s.topWallets.length
    ? ` +${s.walletCount - s.topWallets.length} more`
    : "";
  return [
    `<b>💥 Multi-wallet dump</b>`,
    `🪙 ${escapeHtml(tok)} · ${s.walletCount} top wallets in ≤${windowMinutes}m`,
    `💰 total exited ${formatUsd(s.totalUsd)}`,
    `👛 ${wallets}${more}`,
    `${txLink(s.latestTx, "Latest tx")}`,
    `<i>${escapeHtml(groupName)}</i>`,
  ].join("\n");
}

// ============================================================================
// Dispatch loop. Iterates the new signals (already marked sent at this point,
// per the dedup partition above), formats each, and fires Telegram. Failures
// are logged and accumulated; the endpoint never crashes.
// ============================================================================

interface DispatchOutcome {
  sent: number;
  failed: number;
  warning?: string;
}

async function dispatchTelegram(
  newSignals: SignalBuckets,
  groupName: string,
  windows: { strongMin: number; multiDumpMin: number },
): Promise<DispatchOutcome> {
  const total =
    newSignals.smart.length +
    newSignals.accumulation.length +
    newSignals.strong.length +
    newSignals.dump.length +
    newSignals.multiDump.length;
  if (total === 0) return { sent: 0, failed: 0 };

  const messages: string[] = [
    ...newSignals.smart.map((s) => formatSmartSignalMessage(s, groupName)),
    ...newSignals.accumulation.map((s) => formatAccumulationMessage(s, groupName)),
    ...newSignals.strong.map((s) =>
      formatStrongSignalMessage(s, groupName, windows.strongMin),
    ),
    ...newSignals.dump.map((s) => formatDumpSignalMessage(s, groupName)),
    ...newSignals.multiDump.map((s) =>
      formatMultiDumpMessage(s, groupName, windows.multiDumpMin),
    ),
  ];

  let sent = 0;
  let failed = 0;
  let warning: string | undefined;

  for (const msg of messages) {
    try {
      await sendTelegramMessage(msg);
      sent++;
    } catch (err) {
      // Missing config: stop trying further sends — every message would
      // hit the same failure. Surface once as a clean warning.
      if (err instanceof MissingTelegramConfigError) {
        warning = err.message;
        // Count remaining as failed so the caller knows what didn't ship.
        failed += messages.length - sent;
        break;
      }
      failed++;
      const message = err instanceof Error ? err.message : "Unknown error";
      console.error(`[groupSignals] Telegram send failed: ${message}`);
    }
  }

  return { sent, failed, warning };
}

// Computes all five signal kinds for a group. Pure I/O wrapper — calls the
// existing overview + trades helpers (both with their own caches), maps to
// the signals module's strict types, and runs buildAllSignals.
//
// No Telegram, no polling, no dedup persistence here — those are layered in
// later tasks. Settings are fixed at DEFAULT_SIGNAL_SETTINGS for now; the
// per-group signalSettings store is a separate task.
export async function evaluateGroupSignals(
  group: Group,
  opts: { perWalletLimit?: number } = {},
): Promise<GroupSignalsResult> {
  const perWalletLimit = opts.perWalletLimit ?? DEFAULT_PER_WALLET_LIMIT;

  const [overview, tradesResult] = await Promise.all([
    buildPnlOverview(group),
    fetchGroupTrades(group, perWalletLimit),
  ]);

  // OverviewItem and OverviewResult are structurally compatible, but cast
  // explicitly so the type contract on computeWalletScores is satisfied.
  const overviewResults = overview.results as OverviewResult[];
  const scored = computeWalletScores(overviewResults);

  const trades: TradeRecord[] = [];
  for (const m of tradesResult.merged) {
    const rec = toTradeRecord(m);
    if (rec) trades.push(rec);
  }

  const sigs = buildAllSignals(trades, scored, DEFAULT_SIGNAL_SETTINGS);

  // Window sizes (in ms) used to bucket cluster keys. Match the same values
  // buildAllSignals just used. Per-trade signals (smart, dump) don't need
  // a window — their key is just the tx hash.
  const accumWindowMs = DEFAULT_SIGNAL_SETTINGS.accumulationWindowMinutes * 60_000;
  const strongWindowMs =
    DEFAULT_SIGNAL_SETTINGS.strongSignalWindowMinutes * 60_000;
  const multiDumpWindowMs =
    DEFAULT_SIGNAL_SETTINGS.multiDumpWindowMinutes * 60_000;

  // Bucketing function: identical sliding clusters that fall inside the same
  // window-sized bucket dedupe to the same key, so a continuing strong/multi/
  // accumulation cluster fires once per window even if the evaluator runs
  // every minute. Tx-keyed signals (smart, dump) ignore this and dedupe by
  // tx hash directly.
  const bucket = (timeMs: number, windowMs: number): string =>
    String(Math.floor(timeMs / windowMs));

  const newSignals: SignalBuckets = {
    smart: [],
    accumulation: [],
    strong: [],
    dump: [],
    multiDump: [],
  };
  const seenSignals: SignalBuckets = {
    smart: [],
    accumulation: [],
    strong: [],
    dump: [],
    multiDump: [],
  };

  // Partition + mark helper. Picks the "new" branch when the key is unseen,
  // marks it sent so subsequent evaluations within the same window treat it
  // as seen. Per spec: only new signals are marked.
  const partition = <T>(
    items: T[],
    keyOf: (item: T) => string,
    intoNew: T[],
    intoSeen: T[],
  ): void => {
    for (const item of items) {
      const key = keyOf(item);
      if (hasSignalBeenSent(key)) {
        intoSeen.push(item);
      } else {
        intoNew.push(item);
        markSignalSent(key);
      }
    }
  };

  partition(
    sigs.smart,
    (s) => signalKey("smart", group.id, s.trade.tx),
    newSignals.smart,
    seenSignals.smart,
  );
  partition(
    sigs.dumps,
    (d) => signalKey("dump", group.id, d.trade.tx),
    newSignals.dump,
    seenSignals.dump,
  );
  partition(
    sigs.accumulation,
    (a) =>
      signalKey(
        "accum",
        group.id,
        a.wallet,
        a.tokenMint,
        bucket(a.lastTime, accumWindowMs),
      ),
    newSignals.accumulation,
    seenSignals.accumulation,
  );
  partition(
    sigs.strong,
    (s) =>
      signalKey(
        "strong",
        group.id,
        s.tokenMint,
        bucket(s.latestTime, strongWindowMs),
      ),
    newSignals.strong,
    seenSignals.strong,
  );
  partition(
    sigs.multiDumps,
    (m) =>
      signalKey(
        "mdump",
        group.id,
        m.tokenMint,
        bucket(m.latestTime, multiDumpWindowMs),
      ),
    newSignals.multiDump,
    seenSignals.multiDump,
  );

  const dispatch = await dispatchTelegram(newSignals, group.name, {
    strongMin: DEFAULT_SIGNAL_SETTINGS.strongSignalWindowMinutes,
    multiDumpMin: DEFAULT_SIGNAL_SETTINGS.multiDumpWindowMinutes,
  });

  return {
    groupId: group.id,
    groupName: group.name,
    counts: {
      smart: sigs.smart.length,
      accumulation: sigs.accumulation.length,
      strong: sigs.strong.length,
      dump: sigs.dumps.length,
      multiDump: sigs.multiDumps.length,
    },
    signals: {
      smart: sigs.smart,
      accumulation: sigs.accumulation,
      strong: sigs.strong,
      dump: sigs.dumps,
      multiDump: sigs.multiDumps,
    },
    newSignals,
    seenSignals,
    failedWallets: tradesResult.failedWallets,
    telegramSent: dispatch.sent,
    telegramFailed: dispatch.failed,
    ...(dispatch.warning ? { telegramWarning: dispatch.warning } : {}),
  };
}
