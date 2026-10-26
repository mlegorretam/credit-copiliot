const SCALE_FACTOR = {
  ones: 1,
  thousands: 1_000,
  millions: 1_000_000,
  billions: 1_000_000_000,
} as const;

export type MoneyScale = keyof typeof SCALE_FACTOR;

export { SCALE_FACTOR };

/** Compact research display. The caller keeps the original absolute amount. */
export function formatCompactAbsolute(absolute: number): string {
  if (!Number.isFinite(absolute)) return "n/a";
  const sign = absolute < 0 ? "-" : "";
  const abs = Math.abs(absolute);
  if (abs >= 1_000_000_000) return `${sign}$${formatScaled(abs / 1_000_000_000)}B`;
  if (abs >= 1_000_000) return `${sign}$${formatScaled(abs / 1_000_000)}M`;
  if (abs >= 1_000) return `${sign}$${formatScaled(abs / 1_000)}K`;
  return `${sign}$${Math.round(abs).toLocaleString("en-US")}`;
}

/** Principal and carrying columns, in millions, without changing the stored dollars. */
export function formatMillions(absolute: number): string {
  const millions = Math.round((absolute / 1_000_000) * 1000) / 1000;
  return millions.toLocaleString("en-US", { maximumFractionDigits: 3 });
}

export function formatRatio(value: number): string {
  if (!Number.isFinite(value)) return "n/a";
  return `${(Math.round(value * 100) / 100).toFixed(2)}x`;
}

export function formatMultiple(value: number): string {
  const text = (Math.round(value * 100) / 100).toFixed(2).replace(/\.?0+$/, "");
  return `${text}x`;
}

export function formatPercent(value: number): string {
  return `${(Math.round(value * 100) / 100).toFixed(2)}%`;
}

function formatScaled(value: number): string {
  const digits = Math.abs(value) >= 100 ? 1 : 2;
  const rounded = Math.round(value * 10 ** digits) / 10 ** digits;
  const fractionDigits = Number.isInteger(rounded) ? 0 : digits;
  return rounded.toLocaleString("en-US", {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  });
}
