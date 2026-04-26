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

export function fmtTime(epochMs: number): string {
  return new Date(epochMs).toISOString().replace("T", " ").slice(0, 16);
}

export function shortAddr(addr: string, head = 4, tail = 4): string {
  if (!addr || addr.length <= head + tail + 1) return addr;
  return `${addr.slice(0, head)}…${addr.slice(-tail)}`;
}
