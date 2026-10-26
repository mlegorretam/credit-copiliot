import {
  amountTiedToInstrument,
  parseDebtInstruments,
  segmentForInstrument,
  type ParsedInstrument,
} from "@/lib/credit/debt-schedule";
import {
  figureSupportedByExcerpt,
  parseNumericToken,
  percentSupportedByExcerpt,
} from "@/lib/credit/excerpt-figures";
import {
  formatCompactAbsolute,
  formatMillions,
  formatPercent,
  SCALE_FACTOR,
} from "@/lib/credit/format-money";
import type {
  CapitalStructureView,
  DebtInstrumentInput,
  DebtInstrumentView,
  MaturityBar,
} from "@/lib/types/credit-analysis";

const GENERIC_TOKENS = new Set([
  "senior",
  "notes",
  "note",
  "loan",
  "loans",
  "credit",
  "facility",
  "revolving",
  "revolver",
  "term",
  "unsecured",
  "secured",
  "bonds",
  "bond",
  "debentures",
  "mortgage",
  "other",
  "debt",
  "tranche",
  "borrowings",
]);

const COVERAGE = 0.9;

export function buildCapitalStructure(input: {
  instruments: DebtInstrumentInput[];
  excerpt: string;
  fileNames: string[];
  totalDebtAbsolute: number | null;
}): CapitalStructureView {
  const omitted: string[] = [];
  const qualityNotes: string[] = [];
  const unsupportedMaturities: string[] = [];
  const instruments = input.instruments.flatMap((instrument) => {
    const accepted = acceptInstrument(instrument, input.excerpt, input.fileNames);
    if (!accepted) {
      if (instrument.name.trim()) omitted.push(instrument.name.trim());
      return [];
    }
    for (const note of accepted.notes) qualityNotes.push(`${accepted.view.name}: ${note}`);
    for (const note of accepted.unsupported) unsupportedMaturities.push(note);
    return [accepted.view];
  });
  mergeParsedRows(
    instruments,
    parseDebtInstruments(input.excerpt, input.fileNames),
    qualityNotes,
    unsupportedMaturities,
  );

  const outstanding = instruments.filter((row) => row.kind === "outstanding");
  const principalRows = outstanding.filter(
    (row) => row.amountBasis === "principal" && row.principalAbsolute != null,
  );
  const principalSum = sum(principalRows.map((row) => row.principalAbsolute ?? 0));
  const carryingSum = sum(
    instruments
      .map((row) => row.carryingAbsolute)
      .filter((value): value is number => value != null),
  );
  const carryingCount = instruments.filter((row) => row.carryingAbsolute != null).length;
  const reconciliation = reconcile({
    instruments: outstanding,
    principalRows,
    principalSum,
    carryingSum,
    carryingCount,
    totalDebtAbsolute: input.totalDebtAbsolute,
    omittedCount: omitted.length,
  });
  const exclusionNotes = [
    instruments.some((row) => row.kind === "undrawn")
      ? "Undrawn facilities are excluded from outstanding debt."
      : "",
    qualityNotes.some((note) => note.startsWith("Historical issuance"))
      ? "Historical issuances are excluded from outstanding debt."
      : "",
  ].filter(Boolean);
  const maturity = maturitySchedule(principalRows, principalSum, input.totalDebtAbsolute);
  const rates = rateBreakdown(principalRows, principalSum);
  const weighted = weightedAverageCoupon(
    principalRows,
    principalSum,
    input.totalDebtAbsolute,
  );

  return {
    instruments,
    omittedCount: omitted.length,
    reconciliationStatus: reconciliation.status,
    reconciliation: [reconciliation.text, ...exclusionNotes].join(" "),
    qualityNotes,
    unsupportedMaturities,
    maturityBars: maturity.bars,
    maturityMessage: maturity.message,
    rateBreakdown: rates.breakdown,
    rateMessage: rates.message,
    weightedAverageCoupon: weighted.coupon,
    weightedAverageDetail: weighted.detail,
  };
}

function acceptInstrument(
  input: DebtInstrumentInput,
  excerpt: string,
  fileNames: string[],
): { view: DebtInstrumentView; notes: string[]; unsupported: string[] } | null {
  const name = input.name.trim();
  if (!name || /^not available\.?$/i.test(name)) return null;
  if (!nameGrounded(name, excerpt)) return null;

  const notes: string[] = [];
  const unsupported: string[] = [];
  const row = segmentForInstrument(excerpt, name) ?? "";
  const principal = acceptedMoney(
    name,
    input.principalAmount,
    input.principalScale,
    excerpt,
  );
  const carrying = acceptedMoney(
    name,
    input.carryingAmount,
    input.carryingScale,
    excerpt,
  );
  if (input.principalAmount.trim() && !principal) {
    notes.push("The proposed principal was not on the same extracted row as this instrument.");
  }
  if (input.carryingAmount.trim() && !carrying) {
    notes.push("The proposed carrying amount was not on the same extracted row as this instrument.");
  }

  let amountBasis = input.amountBasis;
  if (amountBasis === "principal" && !principal) amountBasis = "not_disclosed";
  if (amountBasis === "carrying" && !carrying && !principal) amountBasis = "not_disclosed";
  if (amountBasis === "not_disclosed" && (principal || carrying)) {
    notes.push("The filing excerpt does not say whether this amount is principal or carrying value.");
  }

  const rateType = acceptedRateType(input.rateType, row);
  const coupon = acceptedCoupon(input.couponPercent, excerpt, row, rateType);
  const allIn = /\ball-in\b|\beffective rate\b|\bweighted average\b/i.test(row);
  const rate = acceptedRateText(input.rateText, row, coupon);
  const maturityYear = acceptedYear(input.maturityYear, name, row, unsupported);
  const maturity = acceptedMaturityText(input.maturityText, row, maturityYear);
  const secured = acceptedSecurity(input.securedStatus, row);
  const source = sourceLabel(input.sourceDocument, fileNames, notes);
  const principalAbsolute =
    amountBasis === "principal" ? (principal?.absolute ?? null) : null;
  const carryingAbsolute = carrying?.absolute ?? null;
  const recon = reconciliationAmount(amountBasis, principalAbsolute, carryingAbsolute);

  if (rateType === "not_disclosed" && input.rateType !== "not_disclosed") {
    notes.push("Fixed or floating status was not kept because the extracted row did not support it.");
  }
  if (secured === "Not disclosed" && input.securedStatus !== "not_disclosed") {
    notes.push("Secured or unsecured status was not kept because that word was not on the extracted row.");
  }

  return {
    notes,
    unsupported,
    view: {
      name,
      principalDisplay: principal ? formatMillions(principal.absolute) : "Not disclosed",
      carryingDisplay: carrying ? formatMillions(carrying.absolute) : "Not disclosed",
      principalAbsolute,
      carryingAbsolute,
      reconAbsolute: recon.absolute,
      reconBasis: recon.basis,
      rate,
      rateType,
      coupon,
      allIn,
      maturity,
      maturityYear,
      secured,
      source,
      reportingDate: "",
      kind: "outstanding",
      amountBasis,
      note: "",
    },
  };
}

function acceptedMoney(
  name: string,
  raw: string,
  scale: DebtInstrumentInput["principalScale"],
  excerpt: string,
): { absolute: number } | null {
  if (scale === "not_available" || !raw.trim()) return null;
  const reported = parseNumericToken(raw);
  if (reported == null) return null;
  if (!figureSupportedByExcerpt(raw, scale, excerpt)) return null;
  if (!amountTiedToInstrument(excerpt, name, raw)) return null;
  return { absolute: reported * SCALE_FACTOR[scale] };
}

function acceptedCoupon(
  raw: string,
  excerpt: string,
  window: string,
  rateType: DebtInstrumentView["rateType"],
): number | null {
  if (!raw.trim() || rateType === "not_disclosed") return null;
  if (!percentSupportedByExcerpt(raw, excerpt)) return null;
  const value = parseNumericToken(raw);
  if (value == null) return null;
  const token = String(value).replace(/\.0+$/, "");
  if (!window.includes(token) && !window.includes(`${token}%`)) return null;
  if (rateType === "floating" && !/\ball-in\b|\beffective rate\b|\bweighted average\b/i.test(window)) {
    return null;
  }
  return value;
}

function acceptedRateText(
  raw: string,
  row: string,
  coupon: number | null,
): string {
  const text = raw.trim();
  if (text && row.toLowerCase().includes(text.toLowerCase())) return text;
  if (coupon != null) return formatPercent(coupon);
  return "Not disclosed";
}

function acceptedRateType(
  rateType: DebtInstrumentInput["rateType"],
  window: string,
): DebtInstrumentView["rateType"] {
  if (rateType === "fixed" && /fixed|%|percent/.test(window)) return "fixed";
  if (
    rateType === "floating" &&
    /floating|variable|sofr|libor|bsby|sonia/.test(window)
  ) {
    return "floating";
  }
  if (rateType === "mixed" && /fixed/.test(window) && /floating|variable|sofr/.test(window)) {
    return "mixed";
  }
  return "not_disclosed";
}

function acceptedYear(
  raw: string,
  name: string,
  row: string,
  unsupported: string[],
): number | null {
  const rowYear = dueYear(row);
  const yearText = raw.trim();
  const proposed = /^\d{4}$/.test(yearText) ? Number(yearText) : null;
  if (proposed != null && rowYear != null && proposed !== rowYear) {
    unsupported.push(
      `Unsupported debt maturity for ${name}: ${proposed} is not the maturity on that instrument's extracted row, which shows ${rowYear}.`,
    );
  }
  if (rowYear != null) return rowYear;
  if (proposed == null || proposed < 1990 || proposed > 2100) return null;
  if (!row.includes(yearText)) return null;
  const due = row.match(/\bdue\s+(?:[A-Za-z]+\s+\d{1,2},\s+)?(20\d{2})\b/i);
  if (!due || due[1] !== yearText) return null;
  return proposed;
}

function acceptedMaturityText(
  raw: string,
  row: string,
  year: number | null,
): string {
  const text = raw.trim();
  if (text && row.toLowerCase().includes(text.toLowerCase())) return text;
  if (year != null) return String(year);
  return "Not disclosed";
}

function acceptedSecurity(
  status: DebtInstrumentInput["securedStatus"],
  window: string,
): string {
  const unsecured = /\bunsecured\b/.test(window);
  const secured = /\bsecured\b/.test(window.replace(/\bunsecured\b/g, ""));
  if (status === "unsecured" && unsecured) return "Unsecured";
  if (status === "secured" && secured) return "Secured";
  return "Not disclosed";
}

function sourceLabel(
  source: string,
  fileNames: string[],
  notes: string[],
): string {
  const trimmed = source.trim();
  if (!trimmed) {
    notes.push("Source document was not identified.");
    return "Not identified";
  }
  const needle = trimmed.toLowerCase();
  const matched = fileNames.some((name) => {
    const hay = name.toLowerCase();
    return hay.includes(needle) || needle.includes(hay);
  });
  if (!matched && fileNames.length > 0) {
    notes.push(`Source "${trimmed}" does not match an uploaded filename.`);
  }
  return trimmed;
}

function nameGrounded(name: string, excerpt: string): boolean {
  const lower = excerpt.toLowerCase();
  if (lower.includes(name.toLowerCase())) return true;
  const tokens = name.match(/\d[\d.]*%?|\d{4}|[A-Za-z]{5,}/g) ?? [];
  const distinctive = tokens.filter((token) => !GENERIC_TOKENS.has(token.toLowerCase()));
  if (distinctive.length === 0) return false;
  return distinctive.some((token) => lower.includes(token.toLowerCase()));
}

function reconcile(input: {
  instruments: DebtInstrumentView[];
  principalRows: DebtInstrumentView[];
  principalSum: number;
  carryingSum: number;
  carryingCount: number;
  totalDebtAbsolute: number | null;
  omittedCount: number;
}): { status: CapitalStructureView["reconciliationStatus"]; text: string } {
  const incomplete = input.instruments.some(
    (row) => row.amountBasis !== "principal" || row.principalAbsolute == null,
  );
  const omitted =
    input.omittedCount > 0
      ? ` ${input.omittedCount} proposed instrument${input.omittedCount === 1 ? "" : "s"} omitted because the name was not found in the extracted text.`
      : "";
  const principalGap =
    input.totalDebtAbsolute == null
      ? false
      : Math.abs(input.principalSum - input.totalDebtAbsolute) /
          Math.max(Math.abs(input.totalDebtAbsolute), 1) >
        0.02;
  const carryingMatches =
    principalGap &&
    input.totalDebtAbsolute != null &&
    input.carryingCount > 0 &&
    Math.abs(input.carryingSum - input.totalDebtAbsolute) /
      Math.max(Math.abs(input.totalDebtAbsolute), 1) <=
      0.02;
  const carrying =
    input.carryingCount > 0
      ? ` Disclosed carrying amounts sum to ${formatCompactAbsolute(input.carryingSum)}.${
          carryingMatches
            ? " That carrying-value sum matches reported total debt. The remaining gap is the disclosed difference between principal and carrying value."
            : " Carrying amounts are not treated as principal."
        }`
      : "";

  const reconRows = input.instruments.filter((row) => row.reconAbsolute != null);
  const reconSum = sum(reconRows.map((row) => row.reconAbsolute ?? 0));
  const principalComplete =
    input.instruments.length > 0 &&
    input.instruments.every(
      (row) => row.amountBasis === "principal" && row.principalAbsolute != null,
    );
  const reconComplete =
    input.instruments.length > 0 && reconRows.length === input.instruments.length;
  if (
    !principalComplete &&
    reconComplete &&
    input.totalDebtAbsolute != null &&
    input.principalRows.length < input.instruments.length
  ) {
    const difference = reconSum - input.totalDebtAbsolute;
    const percent = (difference / Math.max(Math.abs(input.totalDebtAbsolute), 1)) * 100;
    const within = Math.abs(percent) <= 2;
    const basisNote =
      " At least one instrument row was not explicitly labeled as principal. The reconciliation uses the balance printed on each row and does not invent a principal or carrying split.";
    return {
      status: within ? "matched" : "difference",
      text: within
        ? `Extracted instrument balances ${formatCompactAbsolute(reconSum)} are within 2% of reported total debt ${formatCompactAbsolute(input.totalDebtAbsolute)} (difference ${formatCompactAbsolute(difference)}).${basisNote}${carrying}${omitted}`
        : `Unreconciled difference: extracted instrument balances ${formatCompactAbsolute(reconSum)} versus reported total debt ${formatCompactAbsolute(input.totalDebtAbsolute)}, a difference of ${formatCompactAbsolute(difference)} (${percent.toFixed(1)}%). The gap was not plugged.${basisNote}${carrying}${omitted}`,
    };
  }

  if (input.principalRows.length === 0) {
    return {
      status: "insufficient",
      text: `Insufficient data. No principal balance could be tied to a named instrument in the extracted text, so the list was not reconciled to reported total debt.${carrying}${omitted} Missing amounts were not estimated.`,
    };
  }
  if (input.totalDebtAbsolute == null) {
    return {
      status: "insufficient",
      text: `Extracted principal is ${formatCompactAbsolute(input.principalSum)}. Reported total debt was not available, so the difference was not calculated.${carrying}${omitted}`,
    };
  }

  const difference = input.principalSum - input.totalDebtAbsolute;
  const percent = (difference / Math.max(Math.abs(input.totalDebtAbsolute), 1)) * 100;
  const within = Math.abs(percent) <= 2;
  const base = within
    ? `Extracted principal ${formatCompactAbsolute(input.principalSum)} is within 2% of reported total debt ${formatCompactAbsolute(input.totalDebtAbsolute)} (difference ${formatCompactAbsolute(difference)}).`
    : `Unreconciled difference: extracted principal ${formatCompactAbsolute(input.principalSum)} versus reported total debt ${formatCompactAbsolute(input.totalDebtAbsolute)}, a difference of ${formatCompactAbsolute(difference)} (${percent.toFixed(1)}%). The gap was not plugged.`;
  const incompleteText = incomplete
    ? " The principal sum is incomplete because at least one listed instrument has no disclosed principal."
    : "";
  return {
    status: within && !incomplete ? "matched" : "difference",
    text: `${base}${incompleteText}${carrying}${omitted}`,
  };
}

function maturitySchedule(
  principalRows: DebtInstrumentView[],
  principalSum: number,
  totalDebtAbsolute: number | null,
): { bars: MaturityBar[] | null; message: string } {
  const dated = principalRows.filter((row) => row.maturityYear != null && row.principalAbsolute != null);
  const datedSum = sum(dated.map((row) => row.principalAbsolute ?? 0));
  const principalCoverage = principalSum > 0 ? datedSum / principalSum : 0;
  const debtCoverage =
    totalDebtAbsolute != null && totalDebtAbsolute > 0 ? datedSum / totalDebtAbsolute : principalCoverage;
  const enough =
    dated.length >= 2 &&
    principalCoverage >= COVERAGE &&
    debtCoverage >= COVERAGE;

  if (!enough) {
    return {
      bars: null,
      message:
        "Insufficient data. A maturity chart is shown only when disclosed principal and an explicit maturity year cover at least 90% of extracted principal and reported total debt. Undated buckets, including thereafter, are not spread across years.",
    };
  }

  const byYear = new Map<number, number>();
  for (const row of dated) {
    const year = row.maturityYear ?? 0;
    byYear.set(year, (byYear.get(year) ?? 0) + (row.principalAbsolute ?? 0));
  }
  const bars = [...byYear.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([year, absolute]) => ({
      year: String(year),
      absolute,
      display: formatCompactAbsolute(absolute),
      share: datedSum > 0 ? absolute / datedSum : 0,
    }));
  return {
    bars,
    message: "Principal by disclosed maturity year. Carrying amounts and undated balances are excluded.",
  };
}

function rateBreakdown(
  principalRows: DebtInstrumentView[],
  principalSum: number,
): { breakdown: CapitalStructureView["rateBreakdown"]; message: string } {
  if (principalSum <= 0) {
    return {
      breakdown: null,
      message:
        "Insufficient data. Fixed and floating amounts are not estimated when principal balances are missing.",
    };
  }
  const fixed = sum(
    principalRows
      .filter((row) => row.rateType === "fixed")
      .map((row) => row.principalAbsolute ?? 0),
  );
  const floating = sum(
    principalRows
      .filter((row) => row.rateType === "floating")
      .map((row) => row.principalAbsolute ?? 0),
  );
  const classified = fixed + floating;
  if (classified / principalSum < COVERAGE) {
    return {
      breakdown: null,
      message:
        "Insufficient data. Fixed versus floating debt is shown only when the extracted text supports a rate type for at least 90% of principal. Unclassified balances were not allocated.",
    };
  }
  const unclassified = Math.max(0, principalSum - classified);
  return {
    breakdown: {
      fixedAbsolute: fixed,
      floatingAbsolute: floating,
      unclassifiedAbsolute: unclassified,
      fixedDisplay: formatCompactAbsolute(fixed),
      floatingDisplay: formatCompactAbsolute(floating),
      unclassifiedDisplay: formatCompactAbsolute(unclassified),
    },
    message: "Based on disclosed principal whose rate type is supported by the extracted text.",
  };
}

function weightedAverageCoupon(
  principalRows: DebtInstrumentView[],
  principalSum: number,
  totalDebtAbsolute: number | null,
): { coupon: string | null; detail: string } {
  const priced = principalRows.filter(
    (row) =>
      row.coupon != null &&
      row.principalAbsolute != null &&
      (row.rateType === "fixed" || (row.rateType === "floating" && row.allIn)),
  );
  const pricedSum = sum(priced.map((row) => row.principalAbsolute ?? 0));
  const principalCoverage = principalSum > 0 ? pricedSum / principalSum : 0;
  const debtCoverage =
    totalDebtAbsolute != null && totalDebtAbsolute > 0
      ? pricedSum / totalDebtAbsolute
      : principalCoverage;
  if (priced.length === 0 || principalCoverage < COVERAGE || debtCoverage < COVERAGE) {
    return {
      coupon: null,
      detail:
        "Insufficient data. A weighted average cost of debt needs disclosed all-in coupons for at least 90% of principal and reported total debt. Floating spreads were not converted into a rate, and missing coupons were not estimated.",
    };
  }
  const weighted =
    priced.reduce(
      (total, row) => total + (row.principalAbsolute ?? 0) * (row.coupon ?? 0),
      0,
    ) / pricedSum;
  return {
    coupon: formatPercent(weighted),
    detail: `Calculated on ${formatCompactAbsolute(pricedSum)} of principal with disclosed all-in coupons. Formula: sum of principal times coupon, divided by that principal. Instruments without an all-in coupon are excluded rather than estimated.`,
  };
}

function reconciliationAmount(
  basis: DebtInstrumentView["amountBasis"],
  principal: number | null,
  carrying: number | null,
): { absolute: number | null; basis: DebtInstrumentView["reconBasis"] } {
  if (basis === "principal" && principal != null) return { absolute: principal, basis: "principal" };
  if (basis === "carrying" && carrying != null) return { absolute: carrying, basis: "carrying" };
  if (principal != null) return { absolute: principal, basis: "unlabeled" };
  if (carrying != null) return { absolute: carrying, basis: "unlabeled" };
  return { absolute: null, basis: "none" };
}

function dueYear(row: string): number | null {
  const match = row.match(/\bdue\s+(?:[A-Za-z]+\s+\d{1,2},\s+)?(20\d{2})\b/i);
  if (!match) return null;
  const year = Number(match[1]);
  return year >= 1990 && year <= 2100 ? year : null;
}

function mergeParsedRows(
  instruments: DebtInstrumentView[],
  parsed: ParsedInstrument[],
  qualityNotes: string[],
  unsupportedMaturities: string[],
) {
  for (const row of parsed) {
    const disclosed = row.principal ?? row.carrying ?? row.unlabeled;
    if (row.kind === "historical") {
      qualityNotes.push(
        `Historical issuance excluded from outstanding debt: ${row.name}${
          disclosed != null ? ` (${formatCompactAbsolute(disclosed)})` : ""
        }. The excerpt describes an issuance rather than a balance outstanding.`,
      );
      continue;
    }
    if (row.kind === "undrawn") {
      qualityNotes.push(
        `Undrawn facility excluded from outstanding debt: ${row.name}${
          disclosed != null ? `, availability ${formatCompactAbsolute(disclosed)}` : ""
        }.`,
      );
      const existing = instruments.find((view) => sameInstrument(view.name, row.name));
      if (existing) existing.kind = "undrawn";
      else instruments.push(viewFromParsed(row));
      continue;
    }

    const existing = instruments.find((view) => sameInstrument(view.name, row.name));
    if (!existing) {
      const created = viewFromParsed(row);
      instruments.push(created);
      if (created.reconBasis === "unlabeled") {
        qualityNotes.push(
          `${created.name}: the extracted balance was not labeled as principal or carrying value.`,
        );
      }
      continue;
    }

    const previousDate = existing.reportingDate;
    if (row.reportingDate) existing.reportingDate = preferDate(existing.reportingDate, row.reportingDate);
    if (row.sourceDocument && (existing.source === "Not identified" || !existing.source)) {
      existing.source = row.sourceDocument;
    }
    if (row.maturityYear && existing.maturityYear && row.maturityYear !== existing.maturityYear) {
      const note = `Unsupported debt maturity for ${existing.name}: ${existing.maturityYear} does not match the extracted row, which shows ${row.maturityYear}.`;
      if (!unsupportedMaturities.includes(note)) unsupportedMaturities.push(note);
      existing.maturityYear = row.maturityYear;
      existing.maturity = String(row.maturityYear);
    } else if (row.maturityYear && existing.maturityYear == null) {
      existing.maturityYear = row.maturityYear;
      existing.maturity = String(row.maturityYear);
    }
    if (
      existing.principalAbsolute != null &&
      row.principal != null &&
      !amountsClose(existing.principalAbsolute, row.principal)
    ) {
      const later = isLater(row.reportingDate, previousDate);
      qualityNotes.push(
        `Conflicting instrument information for ${existing.name}: ${formatCompactAbsolute(existing.principalAbsolute)} and ${formatCompactAbsolute(row.principal)}. ${
          later
            ? `The later balance dated ${row.reportingDate} was kept.`
            : "The amounts disagree and no later reporting date identified a replacement, so the first row-supported balance was kept."
        }`,
      );
      if (later && row.principal != null) {
        existing.principalAbsolute = row.principal;
        existing.principalDisplay = formatMillions(row.principal);
        existing.reconAbsolute = row.principal;
        existing.reconBasis = "principal";
        existing.amountBasis = "principal";
        existing.reportingDate = row.reportingDate;
        if (row.sourceDocument) existing.source = row.sourceDocument;
      }
    } else if (existing.principalAbsolute == null && (row.principal != null || (row.basis === "principal" && row.unlabeled != null))) {
      const amount = row.principal ?? row.unlabeled ?? 0;
      existing.principalAbsolute = amount;
      existing.principalDisplay = formatMillions(amount);
      existing.amountBasis = "principal";
      existing.reconAbsolute = amount;
      existing.reconBasis = "principal";
    }
    if (existing.carryingAbsolute == null && row.carrying != null) {
      existing.carryingAbsolute = row.carrying;
      existing.carryingDisplay = formatMillions(row.carrying);
    }
    if (existing.rateType === "not_disclosed" && row.rateType !== "not_disclosed") {
      existing.rateType = row.rateType;
      existing.rate = row.rateText || existing.rate;
      existing.coupon = row.coupon;
      existing.allIn = row.allIn;
    }
    if (existing.secured === "Not disclosed" && row.secured !== "Not disclosed") {
      existing.secured = row.secured;
    }
  }
}

function viewFromParsed(row: ParsedInstrument): DebtInstrumentView {
  const outstanding = row.kind === "outstanding";
  const principalAbsolute =
    outstanding && row.basis === "principal" ? (row.principal ?? row.unlabeled) : outstanding ? row.principal : null;
  const carryingAbsolute =
    outstanding && row.basis === "carrying" ? (row.carrying ?? row.unlabeled) : outstanding ? row.carrying : null;
  const unlabeled = outstanding && row.basis === "unlabeled" ? row.unlabeled : null;
  const reconAbsolute = principalAbsolute ?? carryingAbsolute ?? unlabeled;
  const reconBasis: DebtInstrumentView["reconBasis"] =
    principalAbsolute != null ? "principal" : carryingAbsolute != null ? "carrying" : unlabeled != null ? "unlabeled" : "none";
  const amountBasis: DebtInstrumentView["amountBasis"] =
    reconBasis === "principal" ? "principal" : reconBasis === "carrying" ? "carrying" : "not_disclosed";
  return {
    name: row.name,
    principalDisplay:
      row.kind === "undrawn"
        ? "Undrawn"
        : principalAbsolute != null
          ? formatMillions(principalAbsolute)
          : unlabeled != null
            ? formatMillions(unlabeled)
            : "Not disclosed",
    carryingDisplay: carryingAbsolute != null ? formatMillions(carryingAbsolute) : "Not disclosed",
    principalAbsolute: amountBasis === "principal" ? principalAbsolute : null,
    carryingAbsolute,
    reconAbsolute,
    reconBasis,
    rate: row.rateText || (row.coupon != null ? formatPercent(row.coupon) : "Not disclosed"),
    rateType: row.rateType,
    coupon: row.coupon,
    allIn: row.allIn,
    maturity: row.maturityYear ? String(row.maturityYear) : "Not disclosed",
    maturityYear: row.maturityYear,
    secured: row.secured,
    source: row.sourceDocument || "Not identified",
    reportingDate: row.reportingDate,
    kind: row.kind,
    amountBasis,
    note: "",
  };
}

function sameInstrument(left: string, right: string): boolean {
  if (left.trim().toLowerCase() === right.trim().toLowerCase()) return true;
  const a = instrumentIdentity(left);
  const b = instrumentIdentity(right);
  if (a.kind !== b.kind) return false;
  if (a.year && b.year && a.year !== b.year) return false;
  if (a.coupon && b.coupon && Math.abs(a.coupon - b.coupon) > 0.001) return false;
  return Boolean(a.year && b.year && a.year === b.year);
}

function instrumentIdentity(name: string): {
  year: number | null;
  coupon: number | null;
  kind: string;
} {
  const year = name.match(/\b(20\d{2})\b/);
  const coupon = name.match(/(\d+(?:\.\d+)?)%/);
  const kind = /term loan/i.test(name)
    ? "loan"
    : /revolv|credit facility/i.test(name)
      ? "revolver"
      : /note|bond|debenture/i.test(name)
        ? "note"
        : "other";
  return {
    year: year ? Number(year[1]) : null,
    coupon: coupon ? Number(coupon[1]) : null,
    kind,
  };
}

function preferDate(current: string, next: string): string {
  if (!current) return next;
  return isLater(next, current) ? next : current;
}

function isLater(candidate: string, current: string): boolean {
  const nextTime = Date.parse(candidate);
  const currentTime = Date.parse(current);
  if (!Number.isFinite(nextTime) || !Number.isFinite(currentTime)) return false;
  return nextTime > currentTime;
}

function amountsClose(left: number, right: number): boolean {
  const base = Math.max(Math.abs(left), Math.abs(right), 1);
  return Math.abs(left - right) / base <= 0.02;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
