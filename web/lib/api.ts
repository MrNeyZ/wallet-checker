export const BACKEND_URL = process.env.BACKEND_URL ?? "http://localhost:3000";
const BACKEND_APP_API_KEY = process.env.BACKEND_APP_API_KEY;

function authHeaders(): Record<string, string> {
  return BACKEND_APP_API_KEY ? { "x-app-key": BACKEND_APP_API_KEY } : {};
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BACKEND_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(),
      ...(init?.headers ?? {}),
    },
    cache: "no-store",
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Backend ${res.status}: ${body.slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

export interface GroupWallet {
  address: string;
  label: string | null;
  addedAt: string;
}

export interface Group {
  id: string;
  name: string;
  createdAt: string;
  wallets: GroupWallet[];
}

export interface PnlSummary {
  totalPnlUsd: number | null;
  realizedPnlUsd: number | null;
  unrealizedPnlUsd: number | null;
  winRate: number | null;
  totalTrades: number | null;
  tokensCount: number | null;
}

export interface OverviewResultItem {
  wallet: string;
  label: string | null;
  ok: boolean;
  summary?: PnlSummary;
  error?: string;
}

export interface PortfolioToken {
  mint: string;
  symbol: string | null;
  name: string | null;
  image: string | null;
  totalBalance: number;
  totalValueUsd: number;
  walletsCount: number;
  wallets: { wallet: string; label: string | null; balance: number; valueUsd: number }[];
}

export interface ActivityToken {
  mint: string;
  symbol: string | null;
  name: string | null;
  image: string | null;
  buysCount: number;
  sellsCount: number;
  totalBuyUsd: number;
  totalSellUsd: number;
  netUsd: number;
  walletsCount: number;
  wallets: { wallet: string; label: string | null }[];
}

export interface TradeItem {
  wallet: string;
  label: string | null;
  tx: string;
  time: number;
  program: string;
  from: { address: string; amount: number; token: { symbol: string; name: string }; priceUsd: number };
  to: { address: string; amount: number; token: { symbol: string; name: string }; priceUsd: number };
  volume: { usd: number; sol: number };
}

export interface Dashboard {
  groupId: string;
  groupName: string;
  walletsCount: number;
  pnlOverview: {
    ok: number;
    failed: number;
    totals: PnlSummary;
    results: OverviewResultItem[];
  } | null;
  portfolioSummary: {
    totalUsd: number;
    totalSol: number;
    tokens: PortfolioToken[];
    filteredTokensCount?: number;
    failedWallets: { wallet: string; label: string | null; error: string }[];
  } | null;
  tokenActivitySummary: {
    perWalletLimit: number;
    tokens: ActivityToken[];
    failedWallets: { wallet: string; label: string | null; error: string }[];
  } | null;
  recentTrades: {
    limit: number;
    trades: TradeItem[];
    failedWallets: { wallet: string; label: string | null; error: string }[];
  } | null;
  warnings: string[];
}

export interface OverviewResponse {
  groupId: string;
  groupName: string;
  walletsCount: number;
  ok: number;
  failed: number;
  totals: PnlSummary;
  results: OverviewResultItem[];
}

export interface PortfolioResponse {
  groupId: string;
  groupName: string;
  walletsCount: number;
  totalUsd: number;
  totalSol: number;
  tokens: PortfolioToken[];
  filteredTokensCount?: number;
  failedWallets: { wallet: string; label: string | null; error: string }[];
}

export interface TokenActivityResponse {
  groupId: string;
  groupName: string;
  walletsCount: number;
  perWalletLimit: number;
  tokens: ActivityToken[];
  failedWallets: { wallet: string; label: string | null; error: string }[];
}

export interface ScannedTokenAccount {
  tokenAccount: string;
  mint: string;
  owner: string;
  amount: string;
  decimals: number;
  lamports: number;
  estimatedReclaimSol: number;
  programId: string;
}

export interface CleanupScanResult {
  wallet: string;
  totals: { tokenAccounts: number; estimatedReclaimSol: number };
  emptyTokenAccounts: ScannedTokenAccount[];
  fungibleTokenAccounts: ScannedTokenAccount[];
  nftTokenAccounts: ScannedTokenAccount[];
  unknownTokenAccounts: ScannedTokenAccount[];
}

export interface LegacyNftBurnIncludedEntry {
  mint: string;
  tokenAccount: string;
  metadata: string;
  masterEdition: string;
  name: string | null;
  symbol: string | null;
  image: string | null;
  estimatedGrossReclaimSol: number;
  reason: string;
}

export interface LegacyNftBurnSkippedEntry {
  mint: string;
  tokenAccount: string;
  reason: string;
  // Optional metadata fields — kept for backwards compat. Cap-overflow
  // entries used to land here; they're now in burnableCandidates instead.
  name?: string | null;
  symbol?: string | null;
  image?: string | null;
  estimatedGrossReclaimSol?: number;
  metadata?: string;
  masterEdition?: string;
}

export interface BurnableLegacyCandidate {
  mint: string;
  tokenAccount: string;
  name: string | null;
  symbol: string | null;
  image: string | null;
  estimatedGrossReclaimSol: number;
  metadata: string;
  masterEdition: string;
  // Verified collection mint — drives the candidate grid's grouping.
  collection: string | null;
}

export interface BuildLegacyNftBurnTxResult {
  burnCount: number;
  totalBurnable: number;
  includedNfts: LegacyNftBurnIncludedEntry[];
  skippedNfts: LegacyNftBurnSkippedEntry[];
  estimatedGrossReclaimSol: number;
  estimatedBaseFeeSol: number;
  estimatedPriorityFeeSol: number;
  estimatedFeeSol: number;
  estimatedNetReclaimSol: number;
  computeUnitLimit: number;
  priorityFeeMicrolamports: number;
  transactionBase64: string | null;
  transactionVersion: "legacy";
  feePayer: string;
  requiresSignatureFrom: string;
  warning: string;
  // Backend preflight simulation outcome — same shape as pNFT/Core. UI
  // disables Sign & send when false to keep Phantom from receiving a tx
  // the chain would reject.
  simulationOk: boolean;
  simulationError?: string;
  // Full burnable list — what the frontend renders in the candidate
  // table. includedNfts is a subset of this (the chosen current-tx batch).
  burnableCandidates: BurnableLegacyCandidate[];
  // Safety cap on the initial build attempt. Actual included count is
  // decided by tx-size + simulation. Frontend uses this as a display hint.
  maxPerTx: number;
  // Items the user selected (or in discovery, all burnable beyond the
  // safety cap) that did NOT fit this batch and were NOT sim-isolated.
  // Drives the "Build next batch" button.
  nextBatchCandidates: BurnableLegacyCandidate[];
}

export interface PnftBurnIncludedEntry {
  mint: string;
  tokenAccount: string;
  metadata: string;
  masterEdition: string;
  tokenRecord: string;
  name: string | null;
  symbol: string | null;
  image: string | null;
  estimatedGrossReclaimSol: number;
  reason: string;
}

export interface PnftBurnSkippedEntry {
  mint: string;
  tokenAccount: string;
  reason: string;
  // Optional metadata fields — kept for backwards compat. Cap-overflow
  // entries used to land here; they're now in burnableCandidates instead.
  name?: string | null;
  symbol?: string | null;
  image?: string | null;
  estimatedGrossReclaimSol?: number;
  metadata?: string;
  masterEdition?: string;
  tokenRecord?: string;
  ruleSet?: string | null;
  collectionMetadata?: string | null;
}

export interface BurnablePnftCandidate {
  mint: string;
  tokenAccount: string;
  name: string | null;
  symbol: string | null;
  image: string | null;
  estimatedGrossReclaimSol: number;
  metadata: string;
  masterEdition: string;
  tokenRecord: string;
  ruleSet: string | null;
  collectionMetadata: string | null;
  // Verified collection mint — drives the candidate grid's grouping.
  collection: string | null;
}

export interface BuildPnftBurnTxResult {
  burnCount: number;
  totalBurnable: number;
  includedPnfts: PnftBurnIncludedEntry[];
  skippedPnfts: PnftBurnSkippedEntry[];
  estimatedGrossReclaimSol: number;
  estimatedBaseFeeSol: number;
  estimatedPriorityFeeSol: number;
  estimatedFeeSol: number;
  estimatedNetReclaimSol: number;
  computeUnitLimit: number;
  priorityFeeMicrolamports: number;
  transactionBase64: string | null;
  transactionVersion: "legacy";
  feePayer: string;
  requiresSignatureFrom: string;
  warning: string;
  simulationOk: boolean;
  simulationError?: string;
  burnableCandidates: BurnablePnftCandidate[];
  maxPerTx: number;
  nextBatchCandidates: BurnablePnftCandidate[];
}

export interface CoreBurnIncludedEntry {
  asset: string;
  collection: string | null;
  name: string | null;
  uri: string | null;
  image: string | null;
  estimatedGrossReclaimSol: number;
  reason: string;
}

export interface CoreBurnSkippedEntry {
  asset: string;
  reason: string;
  // Optional metadata fields — kept for backwards compat.
  collection?: string | null;
  name?: string | null;
  uri?: string | null;
  image?: string | null;
  estimatedGrossReclaimSol?: number;
}

export interface BurnableCoreCandidate {
  asset: string;
  collection: string | null;
  name: string | null;
  uri: string | null;
  image: string | null;
  estimatedGrossReclaimSol: number;
}

export interface BuildCoreBurnTxResult {
  burnCount: number;
  totalBurnable: number;
  includedAssets: CoreBurnIncludedEntry[];
  skippedAssets: CoreBurnSkippedEntry[];
  estimatedGrossReclaimSol: number;
  estimatedBaseFeeSol: number;
  estimatedPriorityFeeSol: number;
  estimatedFeeSol: number;
  estimatedNetReclaimSol: number;
  computeUnitLimit: number;
  priorityFeeMicrolamports: number;
  transactionBase64: string | null;
  transactionVersion: "legacy";
  feePayer: string;
  requiresSignatureFrom: string;
  warning: string;
  simulationOk: boolean;
  simulationError?: string;
  burnableCandidates: BurnableCoreCandidate[];
  maxPerTx: number;
  nextBatchCandidates: BurnableCoreCandidate[];
}

export interface BuildBurnAndCloseTxResult {
  wallet: string;
  transactionVersion: "legacy";
  feePayer: string;
  requiresSignatureFrom: string;
  maxAccountsPerTx: number;
  includedAccounts: ScannedTokenAccount[];
  totalBurnable: number;
  burnCount: number;
  skippedAccounts: number;
  estimatedReclaimSol: number;
  estimatedBaseFeeSol: number;
  estimatedPriorityFeeSol: number;
  estimatedFeeSol: number;
  estimatedNetReclaimSol: number;
  computeUnitLimit: number;
  priorityFeeMicrolamports: number;
  transactionBase64: string | null;
  warning: string;
}

export interface BuildCloseEmptyTxResult {
  wallet: string;
  transactionVersion: "legacy";
  feePayer: string;
  requiresSignatureFrom: string;
  maxInstructionsPerTx: number;
  includedAccounts: ScannedTokenAccount[];
  totalEmpty: number;
  skippedAccounts: number;
  estimatedReclaimSol: number;
  estimatedBaseFeeSol: number;
  estimatedPriorityFeeSol: number;
  estimatedFeeSol: number;
  estimatedNetReclaimSol: number;
  computeUnitLimit: number;
  priorityFeeMicrolamports: number;
  transactionBase64: string | null;
  warning: string;
}

export interface BurnCandidate {
  tokenAccount: string;
  mint: string;
  owner: string;
  amount: string;
  uiAmount: number;
  decimals: number;
  lamports: number;
  programId: string;
  estimatedReclaimSolAfterBurnAndClose: number;
  symbol: string | null;
  name: string | null;
  // Off-chain JSON image URL — populated by backend via Helius DAS when
  // available. Optional in the UI (falls back to a neutral square).
  image: string | null;
  riskLevel: "unknown" | string;
  burnRecommended: boolean;
  reason: string;
}

export interface BurnCandidatesResult {
  wallet: string;
  count: number;
  totalEstimatedReclaimSol: number;
  candidates: BurnCandidate[];
  warning: string;
}

// Per-wallet result from POST /api/groups/:groupId/cleanup-scan-all.
// Status tags drive the progress UI (cached/timeout/rate-limited counters).
export type GroupScanWalletStatus =
  | "ok"
  | "cached"
  | "timeout"
  | "rate-limited"
  | "error";

export interface GroupScanWalletResult {
  address: string;
  label: string | null;
  status: GroupScanWalletStatus;
  scan?: CleanupScanResult;
  burn?: BurnCandidatesResult;
  error?: string;
  durationMs: number;
}

export interface GroupCleanupScanAllResult {
  groupId: string;
  total: number;
  counts: {
    ok: number;
    cached: number;
    timeout: number;
    rateLimited: number;
    error: number;
  };
  wallets: GroupScanWalletResult[];
}

export interface AirdropWalletItem {
  wallet: string;
  label: string | null;
  airdropsCount: number;
  totalValueUsd: number;
  totalValueUsdFormatted: string | null;
  isUnknownUsdValue: boolean;
  addressUrl: string | null;
}

export interface GroupAirdropsResponse {
  groupId: string;
  groupName: string;
  walletsCount: number;
  totalAirdropsCount: number;
  totalValueUsd: number;
  unknownValueWallets: number;
  wallets: AirdropWalletItem[];
  failedWallets: { wallet: string; label: string | null; error: string }[];
}

export type AirdropsState =
  | { state: "configured"; data: GroupAirdropsResponse }
  | { state: "not_configured" }
  | { state: "error"; message: string };

export interface LpTokenLeg {
  mint: string;
  symbol: string | null;
  name: string | null;
  icon: string | null;
  decimals: number | null;
}

export interface LpPosition {
  wallet: string;
  label: string | null;
  protocol: "meteora_dlmm";
  poolAddress: string;
  positionAddress: string;
  pairName: string | null;
  tokenX: LpTokenLeg;
  tokenY: LpTokenLeg;
  valueUsd: number;
  unclaimedFeesUsd: number;
  totalDepositsUsd: number;
  totalWithdrawsUsd: number;
  totalClaimedFeesUsd: number;
  unrealizedPnlUsd: number;
  unrealizedPnlPct: number;
  lowerBinId: number | null;
  upperBinId: number | null;
  activeBinId: number | null;
  createdAt: number | null;
}

export interface GroupLpResponse {
  groupId: string;
  groupName: string;
  walletsCount: number;
  totalPositions: number;
  totalValueUsd: number;
  totalUnclaimedFeesUsd: number;
  positions: LpPosition[];
  failedWallets: { wallet: string; label: string | null; error: string }[];
}

export interface AlertRule {
  id: string;
  groupId: string;
  name: string;
  enabled: boolean;
  minUsd: number;
  token?: string;
  side?: "buy" | "sell";
  program?: string;
  createdAt: string;
}

export interface CreateAlertRuleInput {
  name: string;
  minUsd: number;
  token?: string;
  side?: "buy" | "sell";
  program?: string;
  enabled?: boolean;
}

export interface GroupTradesResponse {
  groupId: string;
  groupName: string;
  walletsCount: number;
  limit: number;
  perWalletLimit: number;
  trades: TradeItem[];
  failedWallets: { wallet: string; label: string | null; error: string }[];
}

export interface GroupTradesFilters {
  minUsd?: number | string;
  token?: string;
  side?: "buy" | "sell";
  program?: string;
  limit?: number;
  perWalletLimit?: number;
}

export interface SystemStatus {
  ok: boolean;
  env: {
    solanaTrackerConfigured: boolean;
    heliusConfigured: boolean;
    telegramConfigured: boolean;
    appAuthEnabled: boolean;
  };
  pollers: { runningCount: number };
  dataFiles: { groups: boolean; alerts: boolean; alertSent: boolean };
}

export const api = {
  getStatus: () => request<SystemStatus>("/api/status"),
  listGroups: () => request<{ groups: Group[] }>("/api/groups"),
  createGroup: (name: string) =>
    request<Group>("/api/groups", { method: "POST", body: JSON.stringify({ name }) }),
  deleteGroup: (groupId: string) =>
    request<{ ok: boolean }>(`/api/groups/${groupId}`, { method: "DELETE" }),
  getDashboard: (groupId: string) =>
    request<Dashboard>(`/api/groups/${groupId}/dashboard`),
  getOverview: (groupId: string) =>
    request<OverviewResponse>(`/api/groups/${groupId}/overview`),
  getPortfolioSummary: (groupId: string) =>
    request<PortfolioResponse>(`/api/groups/${groupId}/portfolio-summary`),
  getTokenSummary: (groupId: string) =>
    request<TokenActivityResponse>(`/api/groups/${groupId}/token-summary`),
  getGroupWallets: (groupId: string) =>
    request<{ groupId: string; wallets: GroupWallet[] }>(`/api/groups/${groupId}/wallets`),
  getGroupTrades: (groupId: string, filters: GroupTradesFilters) => {
    const q = new URLSearchParams();
    if (filters.minUsd !== undefined && String(filters.minUsd) !== "")
      q.set("minUsd", String(filters.minUsd));
    if (filters.token) q.set("token", filters.token);
    if (filters.side) q.set("side", filters.side);
    if (filters.program) q.set("program", filters.program);
    if (filters.limit !== undefined) q.set("limit", String(filters.limit));
    if (filters.perWalletLimit !== undefined)
      q.set("perWalletLimit", String(filters.perWalletLimit));
    const qs = q.toString();
    return request<GroupTradesResponse>(
      `/api/groups/${groupId}/trades${qs ? `?${qs}` : ""}`,
    );
  },
  addWallet: (groupId: string, wallet: string, label?: string) =>
    request<GroupWallet>(`/api/groups/${groupId}/wallets`, {
      method: "POST",
      body: JSON.stringify({ wallet, label: label || undefined }),
    }),
  removeWallet: (groupId: string, wallet: string) =>
    fetch(`${BACKEND_URL}/api/groups/${groupId}/wallets/${wallet}`, {
      method: "DELETE",
      cache: "no-store",
      headers: authHeaders(),
    }).then((res) => {
      if (!res.ok) throw new Error(`Backend ${res.status}`);
    }),
  getCleanupScan: (wallet: string, opts: { refresh?: boolean } = {}) =>
    request<CleanupScanResult>(
      `/api/wallet/${wallet}/cleanup-scan${opts.refresh ? "?refresh=true" : ""}`,
    ),
  getBurnCandidates: (wallet: string) =>
    request<BurnCandidatesResult>(`/api/wallet/${wallet}/burn-candidates`),
  buildCloseEmptyTx: (wallet: string) =>
    request<BuildCloseEmptyTxResult>(`/api/wallet/${wallet}/close-empty-tx`, {
      method: "POST",
      body: "{}",
    }),
  buildBurnAndCloseTx: (wallet: string, mints: string[] = []) =>
    request<BuildBurnAndCloseTxResult>(
      `/api/wallet/${wallet}/burn-and-close-tx`,
      {
        method: "POST",
        body: JSON.stringify(mints.length > 0 ? { mints } : {}),
      },
    ),
  buildLegacyNftBurnTx: (wallet: string, mints: string[] = []) =>
    request<BuildLegacyNftBurnTxResult>(
      `/api/wallet/${wallet}/legacy-nft-burn-tx`,
      {
        method: "POST",
        body: JSON.stringify(mints.length > 0 ? { mints } : {}),
      },
    ),
  buildPnftBurnTx: (wallet: string, mints: string[] = []) =>
    request<BuildPnftBurnTxResult>(`/api/wallet/${wallet}/pnft-burn-tx`, {
      method: "POST",
      body: JSON.stringify(mints.length > 0 ? { mints } : {}),
    }),
  buildCoreBurnTx: (wallet: string, assetIds: string[] = []) =>
    request<BuildCoreBurnTxResult>(`/api/wallet/${wallet}/core-burn-tx`, {
      method: "POST",
      body: JSON.stringify(assetIds.length > 0 ? { assetIds } : {}),
    }),
  scanGroupCleanupAll: (groupId: string, force = false) =>
    request<GroupCleanupScanAllResult>(
      `/api/groups/${groupId}/cleanup-scan-all`,
      {
        method: "POST",
        body: JSON.stringify({ force }),
      },
    ),
  getGroupLpPositions: (groupId: string) =>
    request<GroupLpResponse>(`/api/groups/${groupId}/lp-positions`),
  getGroupAirdrops: async (groupId: string): Promise<AirdropsState> => {
    const res = await fetch(`${BACKEND_URL}/api/groups/${groupId}/airdrops`, {
      headers: { ...authHeaders() },
      cache: "no-store",
    });
    if (res.status === 503) return { state: "not_configured" };
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { state: "error", message: `Backend ${res.status}: ${body.slice(0, 200)}` };
    }
    const data = (await res.json()) as GroupAirdropsResponse;
    return { state: "configured", data };
  },
  listAlertRules: (groupId: string) =>
    request<{ groupId: string; alerts: AlertRule[] }>(`/api/groups/${groupId}/alerts`),
  createAlertRule: (groupId: string, input: CreateAlertRuleInput) =>
    request<AlertRule>(`/api/groups/${groupId}/alerts`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  patchAlertRule: (
    groupId: string,
    alertId: string,
    patch: Partial<CreateAlertRuleInput> & { enabled?: boolean },
  ) =>
    request<AlertRule>(`/api/groups/${groupId}/alerts/${alertId}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  deleteAlertRule: (groupId: string, alertId: string) =>
    fetch(`${BACKEND_URL}/api/groups/${groupId}/alerts/${alertId}`, {
      method: "DELETE",
      cache: "no-store",
      headers: authHeaders(),
    }).then((res) => {
      if (!res.ok) throw new Error(`Backend ${res.status}`);
    }),
  evaluateAlerts: (groupId: string) =>
    request<{
      groupId: string;
      evaluatedRules: number;
      matches: { ruleName: string; volumeUsd: number; tokenSymbol: string | null }[];
      failedWallets: { wallet: string; label: string | null; error: string }[];
    }>(`/api/groups/${groupId}/alerts/evaluate`, { method: "POST", body: "{}" }),
  getAlertStatus: (groupId: string) =>
    request<{ groupId: string; running: boolean; intervalMs: number | null }>(
      `/api/groups/${groupId}/alerts/status`,
    ),
  startAlerts: (groupId: string, intervalMs?: number) =>
    request<{ groupId: string; running: boolean; intervalMs: number; started: boolean }>(
      `/api/groups/${groupId}/alerts/start`,
      { method: "POST", body: JSON.stringify(intervalMs ? { intervalMs } : {}) },
    ),
  stopAlerts: (groupId: string) =>
    request<{ groupId: string; running: boolean; stopped: boolean }>(
      `/api/groups/${groupId}/alerts/stop`,
      { method: "POST", body: "{}" },
    ),
  getSignalStatus: (groupId: string) =>
    request<{ groupId: string; running: boolean; intervalMs: number | null }>(
      `/api/groups/${groupId}/signals/status`,
    ),
  startSignalMonitor: (groupId: string, intervalMs?: number) =>
    request<{ groupId: string; running: boolean; intervalMs: number; started: boolean }>(
      `/api/groups/${groupId}/signals/start`,
      { method: "POST", body: JSON.stringify(intervalMs ? { intervalMs } : {}) },
    ),
  stopSignalMonitor: (groupId: string) =>
    request<{ groupId: string; running: boolean; stopped: boolean }>(
      `/api/groups/${groupId}/signals/stop`,
      { method: "POST", body: "{}" },
    ),
};
