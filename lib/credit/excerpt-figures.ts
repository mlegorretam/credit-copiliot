import type { MoneyScale } from "@/lib/credit/format-money";

export function parseNumericToken(raw: string): number | null {
  let text = raw.trim().replace(/[$,]/g, "").replace(/\s+/g, "");
  if (!text) return null;
  let negative = false;
  if (text.startsWith("(") && text.endsWith(")")) {
    negative = true;
    text = text.slice(1, -1);
  }
  if (text.endsWith("x") || text.endsWith("X") || text.endsWith("%")) {
    text = text.slice(0, -1);
  }
  if (text.startsWith("-")) {
    negative = !negative;
    text = text.slice(1);
  }
  if (!/^\d+(\.\d+)?$/.test(text)) return null;
  const value = Number(text);
  if (!Number.isFinite(value)) return null;
  return negative ? -value : value;
}

export function numericVariants(raw: string): string[] {
  const token = parseNumericToken(raw);
  if (token == null) return [];
  const absolute = String(Math.abs(token));
  const variants = new Set<string>([absolute]);
  if (absolute.includes(".")) {
    variants.add(absolute.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, ""));
    variants.add(absolute.replace(/\.(\d)$/, ".$10"));
  }
  const [whole, fraction] = absolute.split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  variants.add(fraction ? `${grouped}.${fraction}` : grouped);
  return [...variants];
}

export function figureSupportedByExcerpt(
  rawAmount: string,
  scale: MoneyScale,
  excerpt: string,
): boolean {
  const token = parseNumericToken(rawAmount);
  if (token == null) return false;
  const variants = numericVariants(String(Math.abs(token)));
  for (const variant of variants) {
    const pattern = new RegExp(
      `(?<![\\d.])${escapeRegExp(variant)}(?![\\d.])`,
      "g",
    );
    for (const match of excerpt.matchAll(pattern)) {
      const index = match.index ?? 0;
      const digits = variant.replace(/\D/g, "");
      if (digits.length >= 4 && scale !== "ones") return true;
      if (hasMoneyCue(excerpt, index, scale)) return true;
    }
  }
  return false;
}

export function multipleSupportedByExcerpt(raw: string, excerpt: string): boolean {
  const token = parseNumericToken(raw);
  if (token == null) return false;
  const variants = numericVariants(String(Math.abs(token)));
  return variants.some((variant) => {
    const pattern = new RegExp(
      `(?<![\\d.])${escapeRegExp(variant)}\\s*(x|times|to\\s*1)`,
      "i",
    );
    return pattern.test(excerpt);
  });
}

export function percentSupportedByExcerpt(raw: string, excerpt: string): boolean {
  const token = parseNumericToken(raw);
  if (token == null || token <= 0 || token >= 40) return false;
  const variants = numericVariants(String(Math.abs(token)));
  return variants.some((variant) => {
    const pattern = new RegExp(
      `(?<![\\d.])${escapeRegExp(variant)}\\s*(%|percent)`,
      "i",
    );
    return pattern.test(excerpt);
  });
}

export function excerptWindow(
  excerpt: string,
  anchor: string,
  radius: number,
): string | null {
  const needle = anchor.trim().toLowerCase();
  if (needle.length < 4) return null;
  const lower = excerpt.toLowerCase();
  const index = lower.indexOf(needle);
  if (index === -1) return null;
  return lower.slice(
    Math.max(0, index - radius),
    Math.min(lower.length, index + needle.length + radius),
  );
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasMoneyCue(excerpt: string, index: number, scale: MoneyScale): boolean {
  const start = Math.max(0, index - 48);
  const end = Math.min(excerpt.length, index + 48);
  const window = excerpt.slice(start, end).toLowerCase();
  if (window.includes("$") || window.includes("dollar")) return true;
  if (scale === "billions" && /billion|\bbn\b/.test(window)) return true;
  if (scale === "millions" && /million|\bmm\b/.test(window)) return true;
  if (scale === "thousands" && /thousand/.test(window)) return true;
  if (scale === "ones" && /\$|dollar|debt|cash|interest|ebitda|affo/.test(window)) {
    return true;
  }
  return /debt|cash|ebitda|interest|affo|revenue|billion|million|thousand/.test(
    window,
  );
}
