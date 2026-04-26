export const BACKEND_URL = process.env.BACKEND_URL ?? "http://localhost:3000";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BACKEND_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
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

export const api = {
  listGroups: () => request<{ groups: Group[] }>("/api/groups"),
  createGroup: (name: string) =>
    request<Group>("/api/groups", { method: "POST", body: JSON.stringify({ name }) }),
  getDashboard: (groupId: string) =>
    request<Dashboard>(`/api/groups/${groupId}/dashboard`),
  getGroupWallets: (groupId: string) =>
    request<{ groupId: string; wallets: GroupWallet[] }>(`/api/groups/${groupId}/wallets`),
  addWallet: (groupId: string, wallet: string, label?: string) =>
    request<GroupWallet>(`/api/groups/${groupId}/wallets`, {
      method: "POST",
      body: JSON.stringify({ wallet, label: label || undefined }),
    }),
  removeWallet: (groupId: string, wallet: string) =>
    fetch(`${BACKEND_URL}/api/groups/${groupId}/wallets/${wallet}`, {
      method: "DELETE",
      cache: "no-store",
    }).then((res) => {
      if (!res.ok) throw new Error(`Backend ${res.status}`);
    }),
};
