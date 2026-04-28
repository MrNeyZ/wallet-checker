export function fmtUsd(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  if (abs >= 1000) return `${sign}$${abs.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
  if (abs >= 1) return `${sign}$${abs.toFixed(2)}`;
  if (abs > 0) return `${sign}$${abs.toFixed(4)}`;
  return "$0";
}

export function fmtPercent(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  return `${(value * 100).toFixed(1)}%`;
}

export function fmtNumber(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

// SOL-specific formatter. Closeable token accounts return ~0.002 SOL of rent
// each, which fmtNumber's 2-decimal cap rounds to "0". This formatter keeps
// up to 6 decimal places (Solana's lamport precision is 9, but 6 is enough
// to read rent-sized values) and never displays "0" for non-zero positives.
// Larger values stay compact: 1.23 stays "1.23", 100 stays "100".
export function fmtSol(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  if (value === 0) return "0";
  const abs = Math.abs(value);
  // Below 1 microSOL: show "<0.000001" so the user sees there's something
  // there, not a misleading 0.
  if (abs < 0.000001) return value < 0 ? "-<0.000001" : "<0.000001";
  return value.toLocaleString("en-US", {
    maximumFractionDigits: 6,
    minimumFractionDigits: 0,
  });
}

export function fmtTime(epochMs: number): string {
  return new Date(epochMs).toISOString().replace("T", " ").slice(0, 16);
}

export function shortAddr(addr: string, head = 4, tail = 4): string {
  if (!addr || addr.length <= head + tail + 1) return addr;
  return `${addr.slice(0, head)}…${addr.slice(-tail)}`;
}
