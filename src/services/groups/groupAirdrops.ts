import type { GroupWallet } from "../../lib/groupsStore.js";
import { runWithConcurrency } from "../../lib/concurrency.js";
import { fetchWalletAirdropValue } from "../airdrops/dropsBot.js";

const CONCURRENCY = 5;

export interface GroupAirdropWalletItem {
  wallet: string;
  label: string | null;
  airdropsCount: number;
  totalValueUsd: number;
  totalValueUsdFormatted: string | null;
  isUnknownUsdValue: boolean;
  addressUrl: string | null;
}

export interface GroupAirdropsResult {
  totalAirdropsCount: number;
  totalValueUsd: number;
  unknownValueWallets: number;
  wallets: GroupAirdropWalletItem[];
  failedWallets: { wallet: string; label: string | null; error: string }[];
}

export async function buildGroupAirdrops(group: {
  wallets: GroupWallet[];
}): Promise<GroupAirdropsResult> {
  const failedWallets: { wallet: string; label: string | null; error: string }[] = [];

  type Outcome = { ok: true; item: GroupAirdropWalletItem } | { ok: false };

  const settled = await runWithConcurrency<GroupWallet, Outcome>(
    group.wallets,
    CONCURRENCY,
    async ({ address, label }) => {
      try {
        const r = await fetchWalletAirdropValue(address);
        return {
          ok: true,
          item: {
            wallet: address,
            label,
            airdropsCount: r.airdropsCount,
            totalValueUsd: r.totalValueUsd,
            totalValueUsdFormatted: r.totalValueUsdFormatted,
            isUnknownUsdValue: r.isUnknownUsdValue,
            addressUrl: r.addressUrl,
          },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        failedWallets.push({ wallet: address, label, error: message });
        return { ok: false };
      }
    },
  );
  const results: Outcome[] = settled.map((r, i) => {
    if (r.status === "fulfilled") return r.value;
    const { address, label } = group.wallets[i];
    const message = r.reason instanceof Error ? r.reason.message : "Unknown error";
    failedWallets.push({ wallet: address, label, error: message });
    return { ok: false };
  });

  const wallets: GroupAirdropWalletItem[] = [];
  let totalAirdropsCount = 0;
  let totalValueUsd = 0;
  let unknownValueWallets = 0;
  for (const r of results) {
    if (!r.ok) continue;
    wallets.push(r.item);
    totalAirdropsCount += r.item.airdropsCount;
    totalValueUsd += r.item.totalValueUsd;
    if (r.item.isUnknownUsdValue) unknownValueWallets += 1;
  }
  wallets.sort((a, b) => b.totalValueUsd - a.totalValueUsd);

  return {
    totalAirdropsCount,
    totalValueUsd,
    unknownValueWallets,
    wallets,
    failedWallets,
  };
}
