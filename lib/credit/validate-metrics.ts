import { buildCapitalStructure } from "@/lib/credit/capital-structure";
import { buildDashboard } from "@/lib/credit/dashboard";
import { buildDataQuality } from "@/lib/credit/data-quality";
import { extractDisclosedMaturities } from "@/lib/credit/disclosed-maturities";
import {
  extractFinancialTrends,
  latestAnnualStatementAmount,
  readEbitdaReadings,
  type AnnualStatementAmount,
  type EbitdaReading,
  type VerifiedTrendAmount,
} from "@/lib/credit/historical-trends";
import {
  extractCash,
  extractLiquidity,
  extractReportedLeverage,
  extractTotalDebt,
  extractUndrawn,
  type ExcerptStock,
} from "@/lib/credit/excerpt-stocks";
import {
  figureSupportedByExcerpt,
  multipleSupportedByExcerpt,
  parseNumericToken,
} from "@/lib/credit/excerpt-figures";
import { sameReportingDate, splitFinancialSegments } from "@/lib/credit/financial-segments";
import { flowPeriodFromSegment, constructFlowTtm, type FlowMetric, type FlowTtm } from "@/lib/credit/ttm-flow";
import {
  formatCompactAbsolute,
  formatMultiple,
  SCALE_FACTOR,
} from "@/lib/credit/format-money";
import {
  ambiguousPeriodLabel,
  descriptionPeriodOverride,
  periodLabel,
  textClaimsInterim,
  textClaimsTtm,
} from "@/lib/credit/period-label";
import { constructTtmAdjustedEbitda } from "@/lib/credit/quarterly-ebitda";
import { NOT_AVAILABLE } from "@/lib/types/credit-analysis";
import type {
  CreditAnalysisModelResult,
  CreditAnalysisResult,
  SourcedAmount,
} from "@/lib/types/credit-analysis";

export { formatMultiple };

type Scale = SourcedAmount["scale"];
type Period = SourcedAmount["period"];

type ResolvedAmount = {
  absolute: number;
  reported: number;
  scale: Exclude<Scale, "not_available">;
  period: Period;
  sourceDocument: string;
  asOf: string;
  description: string;
  bridge?: string;
};

export type ValidationOptions = {
  fileNames: string[];
  excerpt: string;
  excerptTruncated: boolean;
  extractionNotes?: string[];
  omissions?: string[];
  /** Full-statement text used for trends and the disclosed maturity schedule. */
  historicalSource?: string;
  /** Complete extracted filing, used to tell consolidated EBITDA from segment subtotals and to read a disclosed covenant ratio. */
  filingText?: string;
};

const FLOW_PERIODS = new Set<Period>([
  "ttm",
  "annual",
  "quarterly",
  "six_month",
  "nine_month",
  "ytd",
]);

const NET_DEBT_TOLERANCE = 0.02;
const RATIO_DIFFERENCE = 0.1;

export function applyFinancialValidation(
  result: CreditAnalysisModelResult,
  options: ValidationOptions,
): CreditAnalysisResult {
  const notes: string[] = [];
  const basis = result.calculationBasis;
  const excerpt = options.excerpt;
  const statementText = options.historicalSource?.trim()
    ? options.historicalSource
    : excerpt;
  const stockTexts = [excerpt, statementText];

  const truncation = truncationNote(options);
  if (truncation) notes.push(truncation);

  const labelNotes: string[] = [];
  const totalDebt = preferStock(
    resolveStock(basis.totalDebt, excerpt, notes, "Total debt") ??
      proseAmount(result.keyMetrics.totalDebt, excerpt, notes, "Total debt", false),
    extractTotalDebt(excerpt, options.fileNames),
    "Total debt",
    notes,
  );
  const cash = preferStock(
    preferStock(
      resolveStock(basis.cash, excerpt, notes, "Cash") ??
        proseAmount(result.keyMetrics.cash, excerpt, notes, "Cash", false),
      statementAmountToStock(
        latestAnnualStatementAmount(statementText, options.fileNames, "cash"),
        options.fileNames,
      ),
      "Cash",
      notes,
    ),
    firstExcerptStock(stockTexts, options.fileNames, extractCash),
    "Cash",
    notes,
  );
  const dateConflict =
    totalDebt?.asOf && cash?.asOf && !sameReportingDate(totalDebt.asOf, cash.asOf)
      ? `Conflicting reporting dates: total debt is as of ${totalDebt.asOf} and cash is as of ${cash.asOf}. Net debt was not calculated from those two dates.`
      : null;
  if (dateConflict) notes.push(dateConflict);
  const statedNetDebt = resolveStock(
    basis.statedNetDebt,
    excerpt,
    notes,
    "Company-reported net debt",
  );
  const alignedEbitda = alignDescribedPeriod(
    resolveFlow(basis.ebitda, excerpt, notes, "EBITDA") ??
      proseAmount(result.keyMetrics.ebitda, excerpt, notes, "EBITDA", true),
    "EBITDA",
  );
  const ebitda = preferConsolidatedEbitda(
    chooseEbitda(alignedEbitda.amount, excerpt, options.fileNames, notes),
    options,
    notes,
  );
  if (
    alignedEbitda.note &&
    ebitda &&
    ebitda.period !== "ttm" &&
    ebitda.description === alignedEbitda.amount?.description
  ) {
    labelNotes.push(alignedEbitda.note);
  }
  const alignedInterest = alignDescribedPeriod(
    resolveFlow(basis.cashInterest, excerpt, notes, "Cash interest"),
    "Cash interest",
  );
  const groundedInterest = groundFlowPeriod(
    alignedInterest.amount,
    excerpt,
    /cash interest|interest paid/i,
    "Cash interest",
  );
  if (alignedInterest.note) labelNotes.push(alignedInterest.note);
  let cashInterest = groundedInterest.amount;
  let flowBridge = false;
  const cashBridge = applyFlowBridge(
    cashInterest,
    excerpt,
    "cash_interest",
    options.fileNames,
    notes,
    labelNotes,
    "Cash interest",
  );
  cashInterest = cashBridge.amount;
  flowBridge = cashBridge.bridged || flowBridge;
  if (!cashInterest) {
    const expenseBridge = applyFlowBridge(
      null,
      excerpt,
      "interest_expense",
      options.fileNames,
      notes,
      labelNotes,
      "Interest expense",
    );
    if (expenseBridge.amount) {
      cashInterest = expenseBridge.amount;
      flowBridge = expenseBridge.bridged || flowBridge;
      notes.push(
        "Interest coverage uses GAAP interest expense because cash interest paid was not available. The two measures are not combined.",
      );
    }
  }
  if (groundedInterest.note && cashInterest?.period !== "ttm") {
    labelNotes.push(groundedInterest.note);
  }
  const alignedAffo = alignDescribedPeriod(
    resolveFlow(basis.affo, excerpt, notes, "AFFO") ??
      proseAmount(result.keyMetrics.affo, excerpt, notes, "AFFO", true),
    "AFFO",
  );
  const affo = alignedAffo.amount;
  if (alignedAffo.note) labelNotes.push(alignedAffo.note);
  const alignedCapex = alignDescribedPeriod(
    resolveFlow(basis.capitalExpenditures, excerpt, notes, "Capital expenditures") ??
      proseAmount(
        result.capitalExpenditures,
        excerpt,
        notes,
        "Capital expenditures",
        true,
      ),
    "Capital expenditures",
  );
  const groundedCapex = groundFlowPeriod(
    alignedCapex.amount,
    excerpt,
    /capital expenditures|\bcapex\b/i,
    "Capital expenditures",
  );
  if (alignedCapex.note) labelNotes.push(alignedCapex.note);
  const capexBridge = applyFlowBridge(
    groundedCapex.amount,
    excerpt,
    "capex",
    options.fileNames,
    notes,
    labelNotes,
    "Capital expenditures",
  );
  flowBridge = capexBridge.bridged || flowBridge;
  const capex = preferHistoricalCapex(
    capexBridge.amount,
    statementText,
    options.fileNames,
    notes,
  );
  if (groundedCapex.note && capex?.period !== "ttm") labelNotes.push(groundedCapex.note);
  const operatingCashFlow = constructFlowTtm(
    excerpt,
    "operating_cash_flow",
    options.fileNames,
  );
  if (operatingCashFlow) {
    notes.push(operatingCashFlow.note);
    flowBridge = true;
  }
  recordDraftPeriodMismatch("AFFO", result.keyMetrics.affo, affo?.period ?? null, labelNotes);
  recordDraftPeriodMismatch(
    "EBITDA",
    result.keyMetrics.ebitda,
    ebitda?.period ?? null,
    labelNotes,
  );
  recordDraftPeriodMismatch(
    "Capital expenditures",
    result.capitalExpenditures,
    capex?.period ?? null,
    labelNotes,
  );

  warnIfSourceUnknown(totalDebt, options.fileNames, notes, "Total debt");
  warnIfSourceUnknown(cash, options.fileNames, notes, "Cash");
  warnIfSourceUnknown(statedNetDebt, options.fileNames, notes, "Company-reported net debt");
  warnIfSourceUnknown(ebitda, options.fileNames, notes, "EBITDA");
  warnIfSourceUnknown(cashInterest, options.fileNames, notes, "Cash interest");
  warnIfSourceUnknown(affo, options.fileNames, notes, "AFFO");
  warnIfSourceUnknown(capex, options.fileNames, notes, "Capital expenditures");

  const extractedLiquidity = firstExcerptStock(
    stockTexts,
    options.fileNames,
    extractLiquidity,
  );
  const statedLiquidity =
    resolveStock(basis.liquidity, excerpt, notes, "Liquidity") ??
    stockToResolved(extractedLiquidity);
  if (!basis.liquidity.amount.trim() && statedLiquidity) {
    notes.push("Disclosed liquidity was read from the extracted text.");
  }
  const extractedUndrawn = firstExcerptStock(
    stockTexts,
    options.fileNames,
    extractUndrawn,
  );
  const modelUndrawn = resolveStock(
    basis.undrawnAvailability,
    excerpt,
    notes,
    "Undrawn availability",
  );
  const undrawn = distinctUndrawn(
    modelUndrawn,
    stockToResolved(extractedUndrawn),
    statedLiquidity,
    cash,
    notes,
  );
  if (!basis.undrawnAvailability.amount.trim() && undrawn) {
    notes.push("Undrawn revolving availability was read from the extracted text.");
  }
  const liquidityOutcome = reconcileLiquidity(statedLiquidity, cash, undrawn, notes);
  const liquidityCalculated = liquidityOutcome.calculated;
  const liquidity = liquidityOutcome.liquidity;

  const netDebtOutcome = dateConflict
    ? {
        text: `${NOT_AVAILABLE} ${dateConflict}`,
        candidates: [],
      }
    : buildNetDebt(totalDebt, cash, statedNetDebt, notes);
  const leverage = buildLeverage(netDebtOutcome, ebitda, notes);
  const coverage = buildCoverage(ebitda, cashInterest, basis, excerpt, notes);
  const reportedLeverage = buildReportedLeverage(
    result,
    basis,
    options.filingText?.trim() || excerpt,
    options.fileNames,
    notes,
  );

  if (leverage.calculated && reportedLeverage.multiple != null) {
    const primary = leverage.primaryMultiple;
    if (
      primary != null &&
      Math.abs(primary - reportedLeverage.multiple) >= RATIO_DIFFERENCE
    ) {
      notes.push(
        `Company-reported leverage (${formatMultiple(reportedLeverage.multiple)}) differs from independently calculated leverage (${formatMultiple(primary)}). The definitions may not match, so the two ratios are shown separately.`,
      );
    } else if (primary != null) {
      notes.push(
        "Company-reported leverage and the independent calculation are close. Both are shown because the definitions can still differ.",
      );
    }
  }

  if (notes.length === 0) {
    notes.push("Calculation checks found no additional issues.");
  }

  const documentConflicts = mergeDocumentNotes(
    result.documentConflicts,
    options.extractionNotes ?? [],
  );

  const independentNetDebt =
    dateConflict || !totalDebt || !cash ? null : totalDebt.absolute - cash.absolute;
  const netDebtConflicts =
    independentNetDebt != null &&
    statedNetDebt != null &&
    !amountsClose(independentNetDebt, statedNetDebt.absolute);
  const leverageConflicts =
    leverage.primaryMultiple != null &&
    reportedLeverage.multiple != null &&
    Math.abs(leverage.primaryMultiple - reportedLeverage.multiple) >=
      RATIO_DIFFERENCE;
  const liquiditySentence = liquidity
    ? liquidityCalculated && cash && undrawn
      ? `Independently calculated ${formatCompactAbsolute(liquidity.absolute)} (cash ${formatResolved(cash)} + undrawn availability ${formatResolved(undrawn)}). This sum is not a company-reported liquidity total. Sources: ${cite(cash, "cash")}; ${cite(undrawn, "undrawn availability")}.`
      : `${formatStockSentence("Liquidity", liquidity)}${liquidityOutcome.detail}`
    : result.keyMetrics.liquidity;
  const capexSentence = capex
    ? `${formatFlowSentence("capital expenditures", capex)}${
        result.capitalExpenditures.trim() &&
        result.capitalExpenditures.trim() !== NOT_AVAILABLE
          ? ` Filing narrative: ${result.capitalExpenditures}`
          : ""
      }`
    : flaggedDraft("capital expenditures", result.capitalExpenditures);
  const sentences = {
    totalDebt: totalDebt
      ? formatStockSentence("Total debt", totalDebt)
      : flaggedDraft("total debt", result.keyMetrics.totalDebt),
    cash: cash ? formatStockSentence("Cash", cash) : flaggedDraft("cash", result.keyMetrics.cash),
    netDebt: netDebtOutcome.text,
    ebitda: ebitda
      ? formatFlowSentence("EBITDA", ebitda)
      : flaggedDraft("EBITDA", result.keyMetrics.ebitda),
    netLeverage: leverage.text,
    reportedLeverage: reportedLeverage.text,
    interestCoverage: coverage.text,
    liquidity: liquidity
      ? liquiditySentence
      : flaggedDraft("liquidity", result.keyMetrics.liquidity),
    affo: affo ? formatFlowSentence("AFFO", affo) : result.keyMetrics.affo,
    capitalExpenditures: capexSentence,
  };
  const missingSources = missingSourceLabels(
    [
      ["Total debt", totalDebt],
      ["Cash", cash],
      ["EBITDA", ebitda],
      ["Cash interest", cashInterest],
    ],
    options.fileNames,
  );
  const dashboard = buildDashboard({
    totalDebt,
    cash,
    netDebtAbsolute: dateConflict
      ? null
      : (independentNetDebt ?? statedNetDebt?.absolute ?? null),
    netDebtReportedOnly: independentNetDebt == null && statedNetDebt != null,
    netDebtConflicts,
    statedNetDebt,
    ebitda,
    leverageMultiple: leverage.primaryMultiple,
    leverageApproximated: leverage.approximated,
    reportedLeverageMultiple: reportedLeverage.multiple,
    reportedLeverageLabel: reportedLeverage.label,
    reportedLeverageAsOf: reportedLeverage.asOf,
    leverageConflicts,
    coverageUsesCashInterest: isCashInterest(cashInterest?.description ?? ""),
    coverageMultiple: coverage.multiple,
    coverageApproximated: coverage.approximated,
    coverageMixed: coverage.mixedCalendar,
    coveragePeriod: coveragePeriodLabel(coverage, ebitda, cashInterest),
    affo,
    liquidity,
    liquidityCalculated,
    capex,
    sentences,
    reviewNotes: {
      affo: labelNotes.some((note) => note.startsWith("AFFO")),
      ebitda: labelNotes.some((note) => note.startsWith("EBITDA")),
      capitalExpenditures: labelNotes.some((note) =>
        note.startsWith("Capital expenditures"),
      ),
      totalDebt: Boolean(dateConflict),
      cash: Boolean(dateConflict),
    },
  });
  const capitalStructure = buildCapitalStructure({
    instruments: result.debtInstruments,
    excerpt,
    fileNames: options.fileNames,
    totalDebtAbsolute: totalDebt?.absolute ?? null,
  });
  const financialTrends = extractFinancialTrends(
    statementText,
    options.fileNames,
    verifiedAnnualTrends(
      { totalDebt, cash, ebitda, capex },
      options.fileNames,
    ),
  );
  const maturitySchedule = extractDisclosedMaturities(statementText, options.fileNames);
  const dataQuality = buildDataQuality({
    totalDebtFound: totalDebt != null,
    cashFound: cash != null,
    ebitdaFound: ebitda != null,
    interestFound: cashInterest != null,
    ebitdaPeriod: ebitda?.period ?? null,
    interestPeriod: cashInterest?.period ?? null,
    ebitdaFromQuarters: Boolean(ebitda?.bridge),
    leverageApproximated: leverage.approximated,
    coverageApproximated: coverage.approximated,
    coverageMixed: coverage.mixedCalendar,
    leverageMultiple: leverage.primaryMultiple,
    reportedLeverageMultiple: reportedLeverage.multiple,
    missingSources,
    labelNotes,
    maturitySchedule,
    dateConflict,
    missingBalanceSheet: [
      totalDebt ? "" : "total debt",
      cash ? "" : "cash",
    ].filter(Boolean),
    flowBridge: flowBridge || Boolean(ebitda?.bridge),
  });

  return {
    ...result,
    keyMetrics: {
      ...result.keyMetrics,
      totalDebt: sentences.totalDebt,
      cash: sentences.cash,
      ebitda: sentences.ebitda,
      affo: sentences.affo,
      netDebt: sentences.netDebt,
      netLeverage: sentences.netLeverage,
      interestCoverage: sentences.interestCoverage,
      liquidity: sentences.liquidity,
      reportedLeverage: sentences.reportedLeverage,
    },
    calculationNotes: notes.join("\n"),
    documentConflicts,
    analyzedDocuments: options.fileNames,
    dashboard,
    capitalStructure,
    financialTrends,
    maturitySchedule,
    dataQuality,
  };
}

const PROSE_MONEY =
  /\$?\s*(-?\d{1,3}(?:,\d{3})+(?:\.\d+)?|-?\d+(?:\.\d+)?)\s*(billion|billions|million|millions|thousand|thousands)\b/i;

function verifiedAnnualTrends(
  amounts: {
    totalDebt: ResolvedAmount | null;
    cash: ResolvedAmount | null;
    ebitda: ResolvedAmount | null;
    capex: ResolvedAmount | null;
  },
  fileNames: string[],
): VerifiedTrendAmount[] {
  const found: VerifiedTrendAmount[] = [];
  const add = (
    id: VerifiedTrendAmount["id"],
    amount: ResolvedAmount | null,
    stock: boolean,
  ) => {
    const year = trendFiscalYear(amount, stock);
    if (!amount || !year || !compatibleTrendDefinition(id, amount.description)) return;
    const period = stock
      ? amount.asOf
        ? `As of ${amount.asOf}`
        : `As of ${year}`
      : /year ended/i.test(amount.asOf)
        ? amount.asOf
        : amount.asOf
          ? `Year ended ${amount.asOf}`
          : `Year ended ${year}`;
    found.push({
      id,
      reported: amount.reported,
      scale: amount.scale,
      absolute: amount.absolute,
      year,
      period,
      definition: amount.description.trim(),
      source: amount.sourceDocument || (fileNames.length === 1 ? fileNames[0] ?? "" : ""),
    });
  };
  add("totalDebt", amounts.totalDebt, true);
  add("cash", amounts.cash, true);
  add("ebitda", amounts.ebitda, false);
  add("capex", amounts.capex, false);
  return found;
}

function trendFiscalYear(amount: ResolvedAmount | null, stock: boolean): string | null {
  if (!amount) return null;
  if (stock) {
    if (amount.period !== "point_in_time") return null;
    const blob = `${amount.asOf} ${amount.description}`;
    if (!/december 31|year ended|fiscal year/i.test(blob)) return null;
  } else if (amount.period !== "annual") {
    return null;
  }
  return singleFiscalYear(amount.asOf) ?? singleFiscalYear(amount.description);
}

function singleFiscalYear(text: string): string | null {
  const years = [...text.matchAll(/\b(20\d{2})\b/g)].map((match) => match[1] ?? "");
  const unique = [...new Set(years.filter(Boolean))];
  if (unique.length !== 1) return null;
  const year = Number(unique[0]);
  if (year < 1995 || year > 2036) return null;
  return unique[0] ?? null;
}

function compatibleTrendDefinition(id: VerifiedTrendAmount["id"], description: string): boolean {
  const text = description.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  if (id === "ebitda") {
    if (/segment|reportable|margin|per share|trailing/.test(text)) return false;
    return (
      /^(?:total |consolidated )?adjusted ebitda$/.test(text) ||
      /^(?:total |consolidated )?ebitda$/.test(text)
    );
  }
  if (id === "capex") {
    return /^(?:capital expenditures?|capex|purchases? of property(?: and equipment)?|additions to property(?: and equipment)?)$/.test(
      text,
    );
  }
  if (id === "totalDebt") {
    return /^(?:total debt|total borrowings|total long term debt|total long term debt including current portion)$/.test(
      text,
    );
  }
  return /^(?:cash|cash and cash equivalents)$/.test(text);
}

function proseAmount(
  text: string,
  excerpt: string,
  notes: string[],
  label: string,
  flow: boolean,
): ResolvedAmount | null {
  const match = text.match(PROSE_MONEY);
  if (!match) return null;
  const period = periodFromProse(text, flow);
  if (!period) return null;
  const scale = scaleFromUnit(match[2]);
  if (!scale) return null;
  const parsed = parseNumericToken(match[1]);
  if (parsed == null) return null;
  if (!figureSupportedByExcerpt(match[1], scale, excerpt)) return null;
  notes.push(
    `${label} was read from the metric text because the structured amount was missing or unverified.`,
  );
  return {
    absolute: parsed * SCALE_FACTOR[scale],
    reported: parsed,
    scale,
    period,
    sourceDocument: "",
    asOf: "",
    description: /adjust/i.test(text) ? `Adjusted ${label}` : label,
  };
}

function scaleFromUnit(
  unit: string,
): Exclude<Scale, "not_available"> | null {
  const normalized = unit.toLowerCase();
  if (normalized.startsWith("billion")) return "billions";
  if (normalized.startsWith("million")) return "millions";
  if (normalized.startsWith("thousand")) return "thousands";
  return null;
}

function periodFromProse(text: string, flow: boolean): Period | null {
  const normalized = text.toLowerCase();
  if (/trailing twelve|\bttm\b|\bltm\b/.test(normalized)) return "ttm";
  if (/nine[- ]month|nine months/.test(normalized)) return "nine_month";
  if (/six[- ]month|six months|first half|second half/.test(normalized)) {
    return "six_month";
  }
  if (/quarter|three[- ]month|three months/.test(normalized)) return "quarterly";
  if (/year[- ]to[- ]date|\bytd\b/.test(normalized)) return "ytd";
  if (/fiscal year|full[- ]year|year ended|\bannual\b/.test(normalized)) {
    return "annual";
  }
  if (flow) return null;
  return "point_in_time";
}

const TTM_EBITDA_FORWARD =
  /(?:trailing twelve[- ]months?|\bTTM\b|\bLTM\b)\s+(adjusted\s+)?EBITDA\b[^$\d]{0,30}\$?\s*(-?\d{1,3}(?:,\d{3})+(?:\.\d+)?|-?\d+(?:\.\d+)?)\s*(billion|billions|million|millions|thousand|thousands)\b/i;

const TTM_EBITDA_REVERSE =
  /\$?\s*(-?\d{1,3}(?:,\d{3})+(?:\.\d+)?|-?\d+(?:\.\d+)?)\s*(billion|billions|million|millions|thousand|thousands)\s+(?:of\s+)?(?:\bTTM\b|\bLTM\b|trailing twelve[- ]months?)\s+(adjusted\s+)?EBITDA\b/i;

function preferConsolidatedEbitda(
  current: ResolvedAmount | null,
  options: ValidationOptions,
  notes: string[],
): ResolvedAmount | null {
  const statementText =
    options.historicalSource?.trim() || options.filingText?.trim() || options.excerpt;
  const segmentText = options.filingText?.trim() || statementText;
  const consolidatedReadings = readEbitdaReadings(statementText, options.fileNames).consolidated;
  const consolidated =
    consolidatedReadings.length > 0 || segmentText === statementText
      ? consolidatedReadings
      : readEbitdaReadings(segmentText, options.fileNames).consolidated;
  const segment = readEbitdaReadings(segmentText, options.fileNames).segment;
  if (!current) {
    const years = [...consolidated].sort((left, right) => Number(left.year) - Number(right.year));
    const latest = years[years.length - 1];
    if (!latest) return null;
    notes.push(
      `EBITDA uses ${latest.year} ${latest.definition} from the consolidated reconciliation because no trailing-twelve-month figure was available.`,
    );
    return readingToResolved(latest, options.fileNames);
  }
  const modelYear = singleFiscalYear(current.asOf) ?? singleFiscalYear(current.description);
  const segmentHits = segment.filter(
    (row) =>
      nearlySame(row.absolute, current.absolute) && (!modelYear || row.year === modelYear),
  );
  const describedAsSegment = /segment|reportable/i.test(current.description);
  if (segmentHits.length === 0 && !describedAsSegment) return current;

  const hitYears = [...new Set(segmentHits.map((row) => row.year))];
  const year = modelYear ?? (hitYears.length === 1 ? (hitYears[0] ?? null) : null);
  const replacement = year
    ? consolidated.find((row) => row.year === year)
    : consolidated.length === 1
      ? consolidated[0]
      : undefined;
  if (replacement && nearlySame(replacement.absolute, current.absolute)) {
    return describedAsSegment ? readingToResolved(replacement, options.fileNames) : current;
  }
  if (replacement) {
    const rejected = segmentHits[0]?.definition ?? "A reportable-segment subtotal";
    notes.push(
      `EBITDA uses consolidated ${replacement.definition} of ${formatAbsolute(replacement.absolute, replacement.scale)} (${replacement.period}). ${rejected} was not used as consolidated EBITDA.`,
    );
    return readingToResolved(replacement, options.fileNames);
  }
  notes.push(
    "EBITDA was not used because the figure is a reportable-segment subtotal and the filing does not disclose consolidated Adjusted EBITDA for that year.",
  );
  return null;
}

function readingToResolved(reading: EbitdaReading, fileNames: string[]): ResolvedAmount {
  return {
    absolute: reading.absolute,
    reported: reading.reported,
    scale: reading.scale,
    period: "annual",
    sourceDocument: reading.source || (fileNames.length === 1 ? fileNames[0] ?? "" : ""),
    asOf: reading.period,
    description: reading.definition,
  };
}

function truncationNote(options: ValidationOptions): string | null {
  if (!options.excerptTruncated) return null;
  const omitted = (options.omissions ?? []).filter(Boolean);
  const omittedSentence = omitted.length > 0 ? ` Omitted: ${omitted.join("; ")}.` : "";
  if (options.historicalSource?.trim()) {
    return `Credit Overview uses the shortened text sent to the model.${omittedSentence} Financial Trends and the debt maturity schedule use a separate extract of the full document, including consolidated financial statements, Adjusted EBITDA reconciliations, and disclosed maturity tables. Cash, disclosed liquidity, and historical capital expenditures are taken from that full-document extract when the model excerpt omits them. A Credit Overview figure can still be missing when it appears only in an omitted part of the model excerpt and is not in the statement extract.`;
  }
  return omitted.length > 0
    ? `The extracted text was shortened before analysis.${omittedSentence} Calculations that depend on the model excerpt use only figures found in that excerpt.`
    : "The extracted text was truncated before analysis. Calculations that depend on the model excerpt use only figures found in that excerpt.";
}

function chooseEbitda(
  current: ResolvedAmount | null,
  excerpt: string,
  fileNames: string[],
  notes: string[],
): ResolvedAmount | null {
  const stated = statedTtmEbitda(excerpt, fileNames);
  const summed = constructTtmAdjustedEbitda(excerpt, fileNames);

  if (current?.period === "ttm") {
    const confirmed =
      stated != null && nearlySame(current.absolute, stated.absolute);
    if (!confirmed && stated == null && summed) {
      notes.push(summed.note);
      return summedAmount(summed);
    }
    return current;
  }

  if (stated) {
    notes.push(
      current
        ? "Trailing-twelve-month EBITDA is disclosed in the extracted text, so the interim or fiscal-year figure was not used for leverage or coverage."
        : "Trailing-twelve-month EBITDA was read from the extracted text.",
    );
    return stated;
  }

  if (summed) {
    notes.push(summed.note);
    return summedAmount(summed);
  }

  return current;
}

function summedAmount(
  summed: NonNullable<ReturnType<typeof constructTtmAdjustedEbitda>>,
): ResolvedAmount {
  return {
    absolute: summed.absolute,
    reported: summed.absolute / SCALE_FACTOR.millions,
    scale: "millions",
    period: "ttm",
    sourceDocument: summed.sourceDocument,
    asOf: summed.asOf,
    description: summed.adjusted ? "Adjusted EBITDA" : "EBITDA",
    bridge: summed.bridge,
  };
}

function nearlySame(a: number, b: number): boolean {
  const base = Math.max(Math.abs(a), Math.abs(b), 1);
  return Math.abs(a - b) / base <= 0.005;
}

function statedTtmEbitda(
  excerpt: string,
  fileNames: string[],
): ResolvedAmount | null {
  const forward = excerpt.match(TTM_EBITDA_FORWARD);
  if (forward) {
    return ttmEbitdaAmount(forward[2], forward[3], Boolean(forward[1]), fileNames);
  }
  const reverse = excerpt.match(TTM_EBITDA_REVERSE);
  if (reverse) {
    return ttmEbitdaAmount(reverse[1], reverse[2], Boolean(reverse[3]), fileNames);
  }
  return null;
}

function ttmEbitdaAmount(
  rawAmount: string | undefined,
  unit: string | undefined,
  adjusted: boolean,
  fileNames: string[],
): ResolvedAmount | null {
  if (!rawAmount || !unit) return null;
  const scale = scaleFromUnit(unit);
  const reported = parseNumericToken(rawAmount);
  if (!scale || reported == null) return null;
  return {
    absolute: reported * SCALE_FACTOR[scale],
    reported,
    scale,
    period: "ttm",
    sourceDocument: fileNames.length === 1 ? fileNames[0] : "",
    asOf: "",
    description: adjusted ? "Adjusted EBITDA" : "EBITDA",
  };
}

function resolveStock(
  input: SourcedAmount,
  excerpt: string,
  notes: string[],
  label: string,
): ResolvedAmount | null {
  return resolveAmount(input, excerpt, notes, label, false);
}

function resolveFlow(
  input: SourcedAmount,
  excerpt: string,
  notes: string[],
  label: string,
): ResolvedAmount | null {
  return resolveAmount(input, excerpt, notes, label, true);
}

function resolveAmount(
  input: SourcedAmount,
  excerpt: string,
  notes: string[],
  label: string,
  requireFlowPeriod: boolean,
): ResolvedAmount | null {
  if (input.scale === "not_available" || !input.amount.trim()) {
    return null;
  }
  const reported = parseNumericToken(input.amount);
  if (reported == null) {
    notes.push(`${label} was not used because the amount was not a plain number.`);
    return null;
  }
  if (requireFlowPeriod && !FLOW_PERIODS.has(input.period)) {
    notes.push(
      `${label} was not used in period-sensitive calculations because its reporting period was not identified.`,
    );
    return null;
  }
  if (!figureSupportedByExcerpt(input.amount, input.scale, excerpt)) {
    notes.push(
      `${label} of ${input.amount} (${input.scale}) was excluded because that figure was not found in the extracted text.`,
    );
    return null;
  }
  return {
    absolute: reported * SCALE_FACTOR[input.scale],
    reported,
    scale: input.scale,
    period: input.period,
    sourceDocument: input.sourceDocument.trim(),
    asOf: input.asOf.trim(),
    description: input.description.trim(),
  };
}

function buildNetDebt(
  totalDebt: ResolvedAmount | null,
  cash: ResolvedAmount | null,
  stated: ResolvedAmount | null,
  notes: string[],
): NetDebtOutcome {
  const independent =
    totalDebt && cash ? totalDebt.absolute - cash.absolute : null;

  if (independent == null && !stated) {
    notes.push(
      "Net debt check: not calculated. Total debt, cash, and a company-reported net debt figure were missing or not found in the extracted text.",
    );
    return {
      text: `${NOT_AVAILABLE} Total debt, cash, and company-reported net debt were missing or not found in the extracted text.`,
      candidates: [],
    };
  }

  if (independent != null && stated) {
    const matches = amountsClose(independent, stated.absolute);
    const independentText = `${formatAbsolute(independent, totalDebt!.scale)} (total debt ${formatResolved(totalDebt!)} − cash ${formatResolved(cash!)})`;
    if (matches) {
      notes.push(
        "Net debt check: total debt minus cash matches company-reported net debt within 2%.",
      );
      return {
        text: `Independently calculated ${independentText}, consistent with company-reported net debt of ${formatResolved(stated)}. Sources: ${cite(totalDebt!, "total debt")}; ${cite(cash!, "cash")}; ${cite(stated, "company-reported net debt")}.`,
        candidates: [
          {
            label: "net debt (total debt − cash, consistent with company-reported net debt)",
            value: independent,
            scale: totalDebt!.scale,
          },
        ],
      };
    }
    notes.push(
      "Net debt check: total debt minus cash differs from company-reported net debt. Both figures are shown and neither is treated as a correction of the other.",
    );
    return {
      text: `Independently calculated ${independentText}. Company-reported net debt is ${formatResolved(stated)}. The figures differ and may use different definitions, such as restricted cash, leases, or other adjustments. Sources: ${cite(totalDebt!, "total debt")}; ${cite(cash!, "cash")}; ${cite(stated, "company-reported net debt")}.`,
      candidates: [
        {
          label: "independently calculated net debt (total debt − cash)",
          value: independent,
          scale: totalDebt!.scale,
        },
        {
          label: "company-reported net debt",
          value: stated.absolute,
          scale: stated.scale,
        },
      ],
    };
  }

  if (independent != null) {
    notes.push(
      "Net debt check: calculated as total debt minus cash. No company-reported net debt figure was available to compare.",
    );
    return {
      text: `Independently calculated ${formatAbsolute(independent, totalDebt!.scale)} (total debt ${formatResolved(totalDebt!)} − cash ${formatResolved(cash!)}). Company-reported net debt was not available. Sources: ${cite(totalDebt!, "total debt")}; ${cite(cash!, "cash")}.`,
      candidates: [
        {
          label: "independently calculated net debt (total debt − cash)",
          value: independent,
          scale: totalDebt!.scale,
        },
      ],
    };
  }

  notes.push(
    "Net debt check: only a company-reported figure was available. Independent net debt was not calculated because total debt or cash was missing.",
  );
  return {
    text: `Company-reported net debt: ${formatResolved(stated!)}. Source: ${cite(stated!, "company-reported net debt")}. Independent net debt was not calculated because total debt or cash was missing or not found in the extracted text.`,
    candidates: [
      {
        label: "company-reported net debt",
        value: stated!.absolute,
        scale: stated!.scale,
      },
    ],
  };
}

type NetDebtCandidate = {
  label: string;
  value: number;
  scale: Exclude<Scale, "not_available">;
};

type NetDebtOutcome = {
  text: string;
  candidates: NetDebtCandidate[];
};

function buildLeverage(
  netDebt: NetDebtOutcome,
  ebitda: ResolvedAmount | null,
  notes: string[],
): {
  text: string;
  calculated: boolean;
  primaryMultiple: number | null;
  approximated: boolean;
} {
  if (!ebitda || netDebt.candidates.length === 0) {
    const reason = !ebitda
      ? "EBITDA with an identified reporting period was missing or not found in the extracted text."
      : "Net debt was not available.";
    notes.push(`Leverage check: independent leverage was not calculated. ${reason}`);
    return {
      text: `${NOT_AVAILABLE} Independent leverage was not calculated. ${reason}`,
      calculated: false,
      primaryMultiple: null,
      approximated: false,
    };
  }

  const annualized = annualize(ebitda);
  if (!annualized) {
    notes.push(
      "Leverage check: independent leverage was not calculated because the EBITDA period cannot be expressed as a twelve-month figure.",
    );
    return {
      text: `${NOT_AVAILABLE} Independent leverage was not calculated because the EBITDA period cannot be expressed as a twelve-month figure.`,
      calculated: false,
      primaryMultiple: null,
      approximated: false,
    };
  }

  if (annualized.value <= 0) {
    notes.push(
      "Leverage check: independent leverage was not calculated because EBITDA is zero or negative.",
    );
    return {
      text: `${NOT_AVAILABLE} Independent leverage was not calculated because EBITDA is zero or negative.`,
      calculated: false,
      primaryMultiple: null,
      approximated: false,
    };
  }

  const name = ebitdaName(ebitda, annualized.kind);
  const sentences = netDebt.candidates.map((candidate) => {
    const multiple = candidate.value / annualized.value;
    return `${formatMultiple(multiple)} on ${candidate.label} of ${formatAbsolute(candidate.value, candidate.scale)} / ${name} of ${formatAbsolute(annualized.value, ebitda.scale)}`;
  });

  const periodSentence = annualizedPeriodSentence(ebitda, annualized);
  notes.push(`Leverage check: ${periodSentence}`);

  const prefix =
    annualized.kind === "annualized"
      ? "Independently calculated annualized approximation (not trailing-twelve-month EBITDA)"
      : "Independently calculated";

  return {
    text: `${prefix}: ${sentences.join("; ")}. ${periodSentence} Source: ${cite(ebitda, "EBITDA")}.`,
    calculated: true,
    primaryMultiple: netDebt.candidates[0].value / annualized.value,
    approximated: annualized.kind === "annualized",
  };
}

function buildCoverage(
  ebitda: ResolvedAmount | null,
  interest: ResolvedAmount | null,
  basis: CreditAnalysisModelResult["calculationBasis"],
  excerpt: string,
  notes: string[],
): {
  text: string;
  multiple: number | null;
  approximated: boolean;
  mixedCalendar: boolean;
} {
  const stated = verifiedMultiple(
    basis.statedInterestCoverageMultiple,
    excerpt,
  );
  const statedSentence = stated
    ? ` Company-reported interest coverage: ${formatMultiple(stated)} (${basis.statedInterestCoverageDefinition.trim() || "definition not stated"}). Source: ${sourcePhrase(basis.statedInterestCoverageSource)}.`
    : "";
  const unavailable = (
    text: string,
  ): {
    text: string;
    multiple: number | null;
    approximated: boolean;
    mixedCalendar: boolean;
  } => ({
    text,
    multiple: null,
    approximated: false,
    mixedCalendar: false,
  });

  if (!ebitda || !interest) {
    notes.push(
      "Interest coverage check: independent coverage was not calculated because EBITDA and cash interest for identified periods were not both available.",
    );
    if (statedSentence) {
      return unavailable(
        `Independent interest coverage: ${NOT_AVAILABLE} EBITDA and cash interest were not both available in the extracted text.${statedSentence}`,
      );
    }
    return unavailable(
      `${NOT_AVAILABLE} Independent interest coverage was not calculated because EBITDA and cash interest were not both available in the extracted text.`,
    );
  }

  const annualizedEbitda = annualize(ebitda);
  const annualizedInterest = annualize(interest);
  if (!annualizedEbitda || !annualizedInterest) {
    notes.push(
      "Interest coverage check: independent coverage was not calculated because the EBITDA and cash interest periods could not both be expressed on a twelve-month basis.",
    );
    return unavailable(
      `${NOT_AVAILABLE} Independent interest coverage was not calculated because the EBITDA and cash interest periods could not be aligned.${statedSentence}`,
    );
  }

  if (annualizedInterest.value <= 0) {
    notes.push(
      "Interest coverage check: independent coverage was not calculated because twelve-month cash interest is zero or negative.",
    );
    return unavailable(
      `${NOT_AVAILABLE} Independent interest coverage was not calculated because cash interest is zero or negative.${statedSentence}`,
    );
  }
  if (annualizedEbitda.value <= 0) {
    notes.push(
      "Interest coverage check: independent coverage was not calculated because twelve-month EBITDA is zero or negative.",
    );
    return unavailable(
      `${NOT_AVAILABLE} Independent interest coverage was not calculated because EBITDA is zero or negative.${statedSentence}`,
    );
  }

  const multiple = annualizedEbitda.value / annualizedInterest.value;
  const approximated =
    annualizedEbitda.kind === "annualized" ||
    annualizedInterest.kind === "annualized";
  const mixedCalendar =
    !approximated &&
    ((annualizedEbitda.kind === "ttm" && annualizedInterest.kind === "annual") ||
      (annualizedEbitda.kind === "annual" && annualizedInterest.kind === "ttm"));

  let label = "No annualization. Both figures are already twelve-month amounts.";
  if (approximated) {
    label =
      "Annualized approximation, not trailing-twelve-month coverage. Partial-period inputs were scaled to twelve months and labeled as an approximation.";
  } else if (mixedCalendar) {
    label =
      "Both inputs cover about twelve months, but one is trailing-twelve-month and the other is a fiscal year, so the periods may not match exactly.";
  } else if (
    annualizedEbitda.kind === "annual" &&
    annualizedInterest.kind === "annual"
  ) {
    label =
      "Based on fiscal-year figures. This is not explicitly trailing-twelve-month coverage.";
  } else if (
    annualizedEbitda.kind === "ttm" &&
    annualizedInterest.kind === "ttm"
  ) {
    label = "Trailing-twelve-month EBITDA and trailing-twelve-month cash interest. No annualization.";
  }

  notes.push(`Interest coverage check: ${label}`);
  if (
    stated != null &&
    Math.abs(stated - multiple) >= RATIO_DIFFERENCE
  ) {
    notes.push(
      `Company-reported interest coverage (${formatMultiple(stated)}) differs from the independent calculation (${formatMultiple(multiple)}).`,
    );
  }

  const interestLabel = interestCaption(interest.description);
  const work = [
    describeAnnualization(ebitda, annualizedEbitda, "EBITDA"),
    describeAnnualization(interest, annualizedInterest, interestLabel),
    interest.bridge ?? "",
  ]
    .filter(Boolean)
    .join(" ");
  const title = isCashInterest(interest.description)
    ? "Cash interest coverage"
    : "Interest coverage";
  const numerator = `${ebitdaName(ebitda, annualizedEbitda.kind)} ${formatAbsolute(annualizedEbitda.value, ebitda.scale)} (${periodLabel(ebitda.period)})`;
  const denominator = `${interestName(annualizedInterest.kind, interest.description)} ${formatAbsolute(annualizedInterest.value, interest.scale)} (${periodLabel(interest.period)})`;

  return {
    text: `${title}, independently calculated ${formatMultiple(multiple)}${approximated ? ", an annualized approximation" : ""}: numerator ${numerator} / denominator ${denominator}. ${label} ${work} Sources: ${cite(ebitda, "EBITDA")}; ${cite(interest, interestLabel)}.${statedSentence}`,
    multiple,
    approximated,
    mixedCalendar,
  };
}

function buildReportedLeverage(
  result: CreditAnalysisModelResult,
  basis: CreditAnalysisModelResult["calculationBasis"],
  excerpt: string,
  fileNames: string[],
  notes: string[],
): { text: string; multiple: number | null; asOf: string; label: string } {
  const verified = verifiedMultiple(basis.statedLeverageMultiple, excerpt);
  const fromExcerpt = verified == null ? extractReportedLeverage(excerpt, fileNames) : null;
  const multiple = verified ?? fromExcerpt?.multiple ?? null;
  if (multiple == null) {
    const draft = result.keyMetrics.reportedLeverage.trim();
    if (draft && draft !== NOT_AVAILABLE && /\d/.test(draft)) {
      notes.push(
        "Company-reported leverage in the narrative was not matched to the extracted text.",
      );
      return {
        text: flaggedDraft("reported leverage", result.keyMetrics.reportedLeverage),
        multiple: null,
        asOf: "",
        label: "Reported leverage",
      };
    }
    return {
      text: result.keyMetrics.reportedLeverage,
      multiple: null,
      asOf: "",
      label: "Reported leverage",
    };
  }

  const name = fromExcerpt?.name?.trim() || "";
  const definition = verified != null
    ? basis.statedLeverageDefinition.trim() || name || "definition not stated in the filing"
    : fromExcerpt?.definition || "as disclosed in the extracted text";
  const asOf = verified != null ? basis.statedLeverageAsOf.trim() : fromExcerpt?.asOf || "";
  const source = sourcePhrase(
    verified != null ? basis.statedLeverageSource : fromExcerpt?.sourceDocument || "",
  );
  const when = asOf ? ` as of ${asOf}` : "";
  const maximum = fromExcerpt?.maximumText ? `${fromExcerpt.maximumText}. ` : "";
  const definitionText = definition.replace(/[.\s]+$/, "");
  const showDefinition =
    definitionText.length > 0 && definitionText.toLowerCase() !== name.toLowerCase();
  if (verified == null && fromExcerpt) {
    notes.push("Company-reported leverage was read from the filing.");
  }
  return {
    text: `Company-reported ${name || "leverage"} ${formatMultiple(multiple)}${when}. ${showDefinition ? `${definitionText}. ` : ""}${maximum}Source: ${source}. This is the company's disclosed ratio, not independently calculated net leverage.`,
    multiple,
    asOf,
    label: reportedCardLabel(name),
  };
}

function reportedCardLabel(name: string): string {
  if (/ratio|lease|covenant|ebitdar|indenture/i.test(name) && name.length <= 90) return name;
  return "Reported leverage";
}

type Annualized = {
  value: number;
  factor: number;
  kind: "ttm" | "annual" | "annualized";
  factorLabel: string;
};

function annualize(amount: ResolvedAmount): Annualized | null {
  switch (amount.period) {
    case "ttm":
      return { value: amount.absolute, factor: 1, kind: "ttm", factorLabel: "" };
    case "annual":
      return {
        value: amount.absolute,
        factor: 1,
        kind: "annual",
        factorLabel: "",
      };
    case "quarterly":
      return {
        value: amount.absolute * 4,
        factor: 4,
        kind: "annualized",
        factorLabel: "quarterly figure × 4",
      };
    case "six_month":
      return {
        value: amount.absolute * 2,
        factor: 2,
        kind: "annualized",
        factorLabel: "six-month figure × 2",
      };
    case "nine_month":
      return {
        value: amount.absolute * (4 / 3),
        factor: 4 / 3,
        kind: "annualized",
        factorLabel: "nine-month figure × 4/3",
      };
    case "ytd":
      return null;
    default:
      return null;
  }
}

function annualizedPeriodSentence(
  ebitda: ResolvedAmount,
  annualized: Annualized,
): string {
  if (annualized.kind === "ttm") {
    if (ebitda.bridge) {
      const name = /adjust/i.test(ebitda.description)
        ? "Trailing-twelve-month Adjusted EBITDA"
        : "Trailing-twelve-month EBITDA";
      return `${name} is the sum of four consecutive quarterly figures. No annualization was applied.`;
    }
    const adjusted = /adjust/i.test(ebitda.description)
      ? "Trailing-twelve-month Adjusted EBITDA was used."
      : "Trailing-twelve-month EBITDA was used. The source description does not say the figure is adjusted.";
    return `${adjusted} No annualization was applied.`;
  }
  if (annualized.kind === "annual") {
    return "A full-year EBITDA figure was used. It is not explicitly trailing-twelve-month EBITDA, and it was not annualized from a partial period.";
  }
  return `Trailing-twelve-month EBITDA was not available. This ratio uses an annualized approximation (${annualized.factorLabel}), starting from ${formatResolved(ebitda)}. It is not trailing-twelve-month EBITDA.`;
}

function describeAnnualization(
  amount: ResolvedAmount,
  annualized: Annualized,
  label: string,
): string {
  if (annualized.kind !== "annualized") return "";
  return `${label}: ${formatResolved(amount)} ${annualized.factorLabel}.`;
}

function ebitdaName(amount: ResolvedAmount, kind: Annualized["kind"]): string {
  const adjusted = /adjust/i.test(amount.description);
  const base = adjusted ? "Adjusted EBITDA" : "EBITDA";
  if (kind === "ttm") return `TTM ${base}`;
  if (kind === "annual") return `annual ${base}`;
  return `annualized ${base}`;
}

function isCashInterest(description: string): boolean {
  return /cash\s+(?:interest|paid)|interest\s+paid|paid\s+for\s+interest/i.test(description);
}

function interestCaption(description: string): string {
  if (!isCashInterest(description)) return "interest expense";
  if (/paid/i.test(description) && !/cash interest/i.test(description)) {
    return "cash paid for interest";
  }
  return "cash interest";
}

function interestName(kind: Annualized["kind"], description: string): string {
  const base = interestCaption(description);
  if (kind === "ttm") return `TTM ${base}`;
  if (kind === "annual") return `annual ${base}`;
  return `annualized ${base}`;
}

function formatStockSentence(label: string, amount: ResolvedAmount): string {
  const asOf = amount.asOf ? ` as of ${amount.asOf}` : "";
  return `${label}: ${formatResolved(amount)}${asOf}. Source: ${sourcePhrase(amount.sourceDocument)}.`;
}

function formatFlowSentence(label: string, amount: ResolvedAmount): string {
  const described = flowDescription(label, amount);
  const definition =
    amount.description.trim() &&
    amount.description.trim().toLowerCase() !== label.toLowerCase()
      ? ` ${amount.description.trim()}.`
      : "";
  const detail = amount.bridge ? ` ${amount.bridge}` : "";
  return `${described}: ${formatResolved(amount)}.${definition}${detail} Source: ${sourcePhrase(amount.sourceDocument)}${amount.asOf ? ` (${amount.asOf})` : ""}.`;
}

function flowDescription(label: string, amount: ResolvedAmount): string {
  const adjusted = /adjust/i.test(amount.description);
  const name =
    label === "EBITDA"
      ? adjusted
        ? "Adjusted EBITDA"
        : "EBITDA"
      : label;
  switch (amount.period) {
    case "ttm":
      return `TTM ${name}`;
    case "annual":
      return `Annual ${name}`;
    case "quarterly":
      return `Quarterly ${name}`;
    case "six_month":
      return `Six-month ${name}`;
    case "nine_month":
      return `Nine-month ${name}`;
    case "ytd":
      return `Year-to-date ${name}`;
    default:
      return name;
  }
}

function formatResolved(amount: ResolvedAmount): string {
  return formatAbsolute(amount.absolute, amount.scale);
}

function formatAbsolute(
  absolute: number,
  scale: Exclude<Scale, "not_available">,
): string {
  const sign = absolute < 0 ? "-" : "";
  const scaled = Math.abs(absolute) / SCALE_FACTOR[scale];
  const value = Math.round(scaled * 1000) / 1000;
  const body =
    scale === "ones"
      ? value.toLocaleString("en-US", { maximumFractionDigits: 0 })
      : value.toLocaleString("en-US", { maximumFractionDigits: 3 });
  const unit =
    scale === "ones"
      ? ""
      : scale === "thousands"
        ? " thousand"
        : scale === "millions"
          ? " million"
          : " billion";
  return `${sign}$${body}${unit}`;
}

function cite(amount: ResolvedAmount, label: string): string {
  const when = amount.asOf ? ` (${amount.asOf})` : "";
  return `${label} from ${sourcePhrase(amount.sourceDocument)}${when}`;
}

function sourcePhrase(source: string): string {
  const trimmed = source.trim();
  return trimmed || "source document not identified";
}

function amountsClose(a: number, b: number): boolean {
  const base = Math.max(Math.abs(a), Math.abs(b), 1);
  return Math.abs(a - b) / base <= NET_DEBT_TOLERANCE;
}

function warnIfSourceUnknown(
  amount: ResolvedAmount | null,
  fileNames: string[],
  notes: string[],
  label: string,
) {
  if (!amount) return;
  if (!amount.sourceDocument) {
    notes.push(`${label} does not name a source document.`);
    return;
  }
  if (!sourceMatchesUpload(amount.sourceDocument, fileNames)) {
    notes.push(
      `${label} cites "${amount.sourceDocument}", which does not match an uploaded filename (${fileNames.join(", ")}).`,
    );
  }
}

function sourceMatchesUpload(source: string, fileNames: string[]): boolean {
  const needle = source.toLowerCase();
  return fileNames.some((name) => {
    const hay = name.toLowerCase();
    return hay.includes(needle) || needle.includes(hay);
  });
}

function verifiedMultiple(raw: string, excerpt: string): number | null {
  const value = parseNumericToken(raw);
  if (value == null || raw.trim() === "") return null;
  if (!multipleSupportedByExcerpt(raw, excerpt)) return null;
  return value;
}

function mergeDocumentNotes(modelText: string, extractionNotes: string[]): string {
  if (extractionNotes.length === 0) return modelText;
  const missing = extractionNotes.filter(
    (note) => !modelText.toLowerCase().includes(note.slice(0, 48).toLowerCase()),
  );
  if (missing.length === 0) return modelText;
  return `${missing.join(" ")} ${modelText}`.trim();
}

function alignDescribedPeriod(
  amount: ResolvedAmount | null,
  label: string,
): { amount: ResolvedAmount | null; note: string | null } {
  if (!amount) return { amount: null, note: null };
  const override = descriptionPeriodOverride(amount.description, amount.period);
  if (override && override !== amount.period) {
    return {
      amount: { ...amount, period: override },
      note: `${label}: the description "${amount.description}" indicates ${periodLabel(override)}, so the ${periodLabel(amount.period)} tag was not used. The figure is not treated as trailing-twelve-month.`,
    };
  }
  if (ambiguousPeriodLabel(amount.description, amount.period)) {
    return {
      amount,
      note: `${label}: the description "${amount.description}" mixes interim language with a ${periodLabel(amount.period)} period. The period was not relabeled.`,
    };
  }
  return { amount, note: null };
}

function recordDraftPeriodMismatch(
  label: string,
  draft: string,
  period: Period | null,
  notes: string[],
): void {
  if (!period || period === "ttm") return;
  if (!textClaimsTtm(draft)) return;
  if (textClaimsInterim(draft) && textClaimsInterim(label)) return;
  notes.push(
    `${label}: the narrative called this trailing-twelve-month, but the figure used is ${periodLabel(period)}. It is not shown as a TTM amount.`,
  );
}

function missingSourceLabels(
  amounts: Array<[string, ResolvedAmount | null]>,
  fileNames: string[],
): string[] {
  return amounts.flatMap(([label, amount]) => {
    if (!amount) return [];
    if (!amount.sourceDocument.trim()) return [label];
    if (!sourceMatchesUpload(amount.sourceDocument, fileNames)) return [label];
    return [];
  });
}

function firstExcerptStock(
  texts: string[],
  fileNames: string[],
  extract: (text: string, fileNames: string[]) => ExcerptStock | null,
): ExcerptStock | null {
  for (const text of texts) {
    if (!text.trim()) continue;
    const found = extract(text, fileNames);
    if (found) return found;
  }
  return null;
}

function statementAmountToStock(
  amount: AnnualStatementAmount | null,
  fileNames: string[],
): ExcerptStock | null {
  if (!amount) return null;
  const scale = amount.scale;
  if (scale === "ones") return null;
  const asOf = amount.period.replace(/^As of\s+/i, "");
  const dated = asOf.match(
    /\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+20\d{2}\b/i,
  );
  const parsed = dated?.[0] ? Date.parse(dated[0]) : Number.NaN;
  return {
    absolute: amount.absolute,
    reported: amount.reported,
    scale,
    asOf: dated?.[0] ?? asOf,
    asOfTime: Number.isFinite(parsed) ? parsed : null,
    sourceDocument: amount.source || (fileNames.length === 1 ? fileNames[0] ?? "" : ""),
    description: amount.definition,
  };
}

function distinctUndrawn(
  model: ResolvedAmount | null,
  extracted: ResolvedAmount | null,
  stated: ResolvedAmount | null,
  cash: ResolvedAmount | null,
  notes: string[],
): ResolvedAmount | null {
  const matchesTotal = (amount: ResolvedAmount | null) =>
    Boolean(
      amount &&
        stated &&
        cash &&
        amountsClose(amount.absolute, stated.absolute) &&
        !amountsClose(amount.absolute, cash.absolute),
    );
  if (matchesTotal(model)) {
    notes.push(
      "A figure labeled undrawn availability matched the disclosed liquidity total, so it was not treated as unused revolver capacity.",
    );
    return extracted && !matchesTotal(extracted) ? extracted : null;
  }
  return model ?? extracted;
}

function reconcileLiquidity(
  stated: ResolvedAmount | null,
  cash: ResolvedAmount | null,
  undrawn: ResolvedAmount | null,
  notes: string[],
): { liquidity: ResolvedAmount | null; calculated: boolean; detail: string } {
  const statedIsCashOnly = Boolean(
    stated && cash && amountsClose(stated.absolute, cash.absolute),
  );
  const usableStated = stated && !statedIsCashOnly ? stated : null;
  const sum = cash && undrawn ? cash.absolute + undrawn.absolute : null;

  if (usableStated && cash && undrawn && sum != null && amountsClose(usableStated.absolute, sum)) {
    notes.push(
      `Disclosed liquidity of ${formatResolved(usableStated)} is consistent with cash ${formatResolved(cash)} plus undrawn availability ${formatResolved(undrawn)}. Cash was not added to the disclosed total.`,
    );
    return {
      liquidity: usableStated,
      calculated: false,
      detail: ` Independently, cash ${formatResolved(cash)} + undrawn availability ${formatResolved(undrawn)} is consistent with that disclosed total. Cash was not added again.`,
    };
  }
  if (usableStated) {
    if (undrawn && amountsClose(usableStated.absolute, undrawn.absolute) && cash) {
      notes.push(
        "The disclosed liquidity total already includes cash and undrawn revolving capacity, so cash was not added to that total.",
      );
      return {
        liquidity: usableStated,
        calculated: false,
        detail:
          " This disclosed total already includes cash and undrawn revolving capacity, so cash was not added again.",
      };
    }
    if (sum != null) {
      notes.push(
        `Disclosed liquidity of ${formatResolved(usableStated)} differs from cash plus undrawn availability. The disclosed total is shown and the components were not added together as a replacement.`,
      );
    }
    return { liquidity: usableStated, calculated: false, detail: "" };
  }
  if (cash && undrawn) {
    if (statedIsCashOnly) {
      notes.push(
        "Disclosed liquidity matched cash and omitted revolving availability, so liquidity is cash plus undrawn availability.",
      );
    }
    return {
      liquidity: {
        absolute: cash.absolute + undrawn.absolute,
        reported: (cash.absolute + undrawn.absolute) / SCALE_FACTOR[cash.scale],
        scale: cash.scale,
        period: "point_in_time",
        sourceDocument: cash.sourceDocument || undrawn.sourceDocument,
        asOf: cash.asOf || undrawn.asOf,
        description: "Cash plus undrawn availability",
      },
      calculated: true,
      detail: "",
    };
  }
  return { liquidity: stated, calculated: false, detail: "" };
}

function preferHistoricalCapex(
  current: ResolvedAmount | null,
  statementText: string,
  fileNames: string[],
  notes: string[],
): ResolvedAmount | null {
  const historical = latestAnnualStatementAmount(statementText, fileNames, "capex");
  if (!historical) return current;
  if (current && !looksProjectedCapex(current)) return current;
  const outflow = historical.absolute < 0 ? -historical.absolute : historical.absolute;
  const reported = historical.reported < 0 ? -historical.reported : historical.reported;
  if (!(outflow > 0)) return current;
  const resolved: ResolvedAmount = {
    absolute: outflow,
    reported,
    scale: historical.scale,
    period: "annual",
    sourceDocument: historical.source || (fileNames.length === 1 ? fileNames[0] ?? "" : ""),
    asOf: historical.period,
    description: historical.definition,
  };
  if (!current || looksProjectedCapex(current)) {
    notes.push(
      `Capital expenditures uses ${historical.year} ${historical.definition} from the consolidated cash flow statement. This is historical spend, not a projected commitment.`,
    );
    return resolved;
  }
  return current;
}

function looksProjectedCapex(amount: ResolvedAmount): boolean {
  return /commit|expected|remaining|on order|future|projected|forecast|contracted/i.test(
    `${amount.description} ${amount.asOf} ${amount.bridge ?? ""}`,
  );
}

function preferStock(
  current: ResolvedAmount | null,
  excerptStock: ExcerptStock | null,
  label: string,
  notes: string[],
): ResolvedAmount | null {
  if (!excerptStock) return current;
  const fromExcerpt = stockToResolved(excerptStock);
  if (!fromExcerpt) return current;
  if (!current) {
    notes.push(
      `${label} was read from the extracted text${fromExcerpt.asOf ? ` as of ${fromExcerpt.asOf}` : ""}.`,
    );
    return fromExcerpt;
  }
  if (nearlySame(current.absolute, fromExcerpt.absolute)) {
    const currentTime = current.asOf ? Date.parse(current.asOf) : Number.NaN;
    const excerptTime = excerptStock.asOfTime;
    const laterExcerpt =
      excerptTime != null && (!Number.isFinite(currentTime) || excerptTime > currentTime);
    return {
      ...current,
      asOf: laterExcerpt ? fromExcerpt.asOf : current.asOf || fromExcerpt.asOf,
      sourceDocument: current.sourceDocument || fromExcerpt.sourceDocument,
      description: current.description || fromExcerpt.description,
    };
  }
  const excerptTime = excerptStock.asOfTime;
  const currentTime = current.asOf ? Date.parse(current.asOf) : Number.NaN;
  if (excerptTime != null && (!Number.isFinite(currentTime) || excerptTime > currentTime)) {
    notes.push(
      `${label} uses the most recent extracted balance${fromExcerpt.asOf ? ` as of ${fromExcerpt.asOf}` : ""}. A different figure was not used for the current balance.`,
    );
    return fromExcerpt;
  }
  notes.push(
    `Conflicting ${label.toLowerCase()} amounts appear in the extracted text (${formatCompactAbsolute(current.absolute)} and ${formatCompactAbsolute(fromExcerpt.absolute)}). The structured figure that was supported by the excerpt was kept.`,
  );
  return current;
}

function stockToResolved(stock: ExcerptStock | null): ResolvedAmount | null {
  if (!stock) return null;
  return {
    absolute: stock.absolute,
    reported: stock.reported,
    scale: stock.scale,
    period: "point_in_time",
    sourceDocument: stock.sourceDocument,
    asOf: stock.asOf,
    description: stock.description,
  };
}

function groundFlowPeriod(
  amount: ResolvedAmount | null,
  excerpt: string,
  cue: RegExp,
  label: string,
): { amount: ResolvedAmount | null; note: string | null } {
  if (!amount || (amount.period !== "ttm" && amount.period !== "annual")) {
    return { amount, note: null };
  }
  const periods = splitFinancialSegments(excerpt)
    .filter((segment) => cue.test(segment) && segmentHasAmount(segment, amount.reported))
    .map((segment) => flowPeriodFromSegment(segment))
    .filter((period): period is Period => period != null && period !== "not_available");
  const unique = [...new Set(periods)];
  if (unique.length !== 1 || unique[0] === amount.period) return { amount, note: null };
  return {
    amount: { ...amount, period: unique[0] },
    note: `${label}: the extracted text describes this figure as ${periodLabel(unique[0])}, so the ${periodLabel(amount.period)} tag was not used.`,
  };
}

function applyFlowBridge(
  current: ResolvedAmount | null,
  excerpt: string,
  metric: FlowMetric,
  fileNames: string[],
  notes: string[],
  labelNotes: string[],
  label: string,
): { amount: ResolvedAmount | null; bridged: boolean } {
  const built = constructFlowTtm(excerpt, metric, fileNames);
  if (!built) return { amount: current, bridged: false };
  const resolved = flowToResolved(built);
  if (current?.period === "ttm" && nearlySame(current.absolute, built.absolute)) {
    return {
      amount: { ...current, bridge: current.bridge || built.bridge, description: current.description || built.description },
      bridged: built.method !== "stated",
    };
  }
  if (current && current.period === "ttm" && !nearlySame(current.absolute, built.absolute)) {
    labelNotes.push(
      `${label}: a trailing-twelve-month label did not match the calculated trailing-twelve-month figure, so the calculated figure was used.`,
    );
  }
  notes.push(built.note);
  return { amount: resolved, bridged: true };
}

function flowToResolved(flow: FlowTtm): ResolvedAmount {
  return {
    absolute: flow.absolute,
    reported: flow.reported,
    scale: flow.scale,
    period: "ttm",
    sourceDocument: flow.sourceDocument,
    asOf: flow.asOf,
    description: flow.description,
    bridge: flow.bridge,
  };
}

function segmentHasAmount(segment: string, reported: number): boolean {
  const compact = String(Math.abs(reported)).replace(/\.0+$/, "");
  const grouped = compact.includes(".")
    ? compact
    : compact.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return segment.includes(compact) || segment.includes(grouped);
}

function flaggedDraft(label: string, draft: string): string {
  const trimmed = draft.trim();
  if (!trimmed || trimmed === NOT_AVAILABLE) return trimmed || NOT_AVAILABLE;
  if (!/\d/.test(trimmed)) return trimmed;
  return `${NOT_AVAILABLE} The draft ${label} text was not used because that amount was not accepted from the extracted text. Unverified draft: ${trimmed}`;
}

function coveragePeriodLabel(
  coverage: { multiple: number | null; approximated: boolean; mixedCalendar: boolean },
  ebitda: ResolvedAmount | null,
  interest: ResolvedAmount | null,
): string {
  if (coverage.multiple == null) return "Not disclosed";
  if (coverage.approximated) return "Annualized approximation";
  if (coverage.mixedCalendar) return "Mixed twelve-month periods";
  if (ebitda?.period === "ttm" && interest?.period === "ttm") return "Trailing twelve months";
  if (ebitda?.period === "annual" && interest?.period === "annual") return "Fiscal year";
  return "Review period";
}
