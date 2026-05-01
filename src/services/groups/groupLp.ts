import type { GroupWallet } from "../../lib/groupsStore.js";
import { runWithConcurrency } from "../../lib/concurrency.js";
import {
  fetchWalletMeteoraDlmm,
  type MeteoraDlmmPosition,
} from "../lp/meteoraDlmm.js";

const CONCURRENCY = 5;

export interface GroupLpPosition extends MeteoraDlmmPosition {
  wallet: string;
  label: string | null;
}

export interface GroupLpResult {
  totalPositions: number;
  totalValueUsd: number;
  totalUnclaimedFeesUsd: number;
  positions: GroupLpPosition[];
  failedWallets: { wallet: string; label: string | null; error: string }[];
}

export async function buildGroupLpPositions(group: {
  wallets: GroupWallet[];
}): Promise<GroupLpResult> {
  const failedWallets: { wallet: string; label: string | null; error: string }[] = [];

  const settled = await runWithConcurrency<GroupWallet, GroupLpPosition[]>(
    group.wallets,
    CONCURRENCY,
    async ({ address, label }) => {
      try {
        const result = await fetchWalletMeteoraDlmm(address);
        return result.positions.map((p) => ({ ...p, wallet: address, label }));
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        failedWallets.push({ wallet: address, label, error: message });
        return [];
      }
    },
  );
  const perWallet: GroupLpPosition[][] = settled.map((r, i) => {
    if (r.status === "fulfilled") return r.value;
    const { address, label } = group.wallets[i];
    const message = r.reason instanceof Error ? r.reason.message : "Unknown error";
    failedWallets.push({ wallet: address, label, error: message });
    return [];
  });

  const positions = perWallet.flat().sort((a, b) => b.valueUsd - a.valueUsd);
  const totalValueUsd = positions.reduce((sum, p) => sum + p.valueUsd, 0);
  const totalUnclaimedFeesUsd = positions.reduce(
    (sum, p) => sum + p.unclaimedFeesUsd,
    0,
  );

  return {
    totalPositions: positions.length,
    totalValueUsd,
    totalUnclaimedFeesUsd,
    positions,
    failedWallets,
  };
}
