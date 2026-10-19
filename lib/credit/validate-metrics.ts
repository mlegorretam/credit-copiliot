import { constructTtmAdjustedEbitda } from "@/lib/credit/quarterly-ebitda";
import { NOT_AVAILABLE } from "@/lib/types/credit-analysis";
import type {
  CreditAnalysisModelResult,
  CreditAnalysisResult,
  SourcedAmount,
} from "@/lib/types/credit-analysis";

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
};

const SCALE_FACTOR: Record<Exclude<Scale, "not_available">, number> = {
  ones: 1,
  thousands: 1_000,
  millions: 1_000_000,
  billions: 1_000_000_000,
};

const FLOW_PERIODS = new Set<Period>([
  "ttm",
  "annual",
  "quarterly",
  "six_month",
  "nine_month",
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

  if (options.excerptTruncated) {
    notes.push(
      "The extracted text was truncated before analysis. Calculations use only figures found in the excerpt that was sent to the model.",
    );
  }

  const totalDebt =
    resolveStock(basis.totalDebt, excerpt, notes, "Total debt") ??
    proseAmount(result.keyMetrics.totalDebt, excerpt, notes, "Total debt", false);
  const cash =
    resolveStock(basis.cash, excerpt, notes, "Cash") ??
    proseAmount(result.keyMetrics.cash, excerpt, notes, "Cash", false);
  const statedNetDebt = resolveStock(
    basis.statedNetDebt,
    excerpt,
    notes,
    "Company-reported net debt",
  );
  const ebitda = chooseEbitda(
    resolveFlow(basis.ebitda, excerpt, notes, "EBITDA") ??
      proseAmount(result.keyMetrics.ebitda, excerpt, notes, "EBITDA", true),
    excerpt,
    options.fileNames,
    notes,
  );
  const cashInterest = resolveFlow(
    basis.cashInterest,
    excerpt,
    notes,
    "Cash interest",
  );
  const affo =
    resolveFlow(basis.affo, excerpt, notes, "AFFO") ??
    proseAmount(result.keyMetrics.affo, excerpt, notes, "AFFO", true);

  warnIfSourceUnknown(totalDebt, options.fileNames, notes, "Total debt");
  warnIfSourceUnknown(cash, options.fileNames, notes, "Cash");
  warnIfSourceUnknown(statedNetDebt, options.fileNames, notes, "Company-reported net debt");
  warnIfSourceUnknown(ebitda, options.fileNames, notes, "EBITDA");
  warnIfSourceUnknown(cashInterest, options.fileNames, notes, "Cash interest");
  warnIfSourceUnknown(affo, options.fileNames, notes, "AFFO");

  const netDebtOutcome = buildNetDebt(totalDebt, cash, statedNetDebt, notes);
  const leverage = buildLeverage(netDebtOutcome, ebitda, notes);
  const coverage = buildCoverage(ebitda, cashInterest, basis, excerpt, notes);
  const reportedLeverage = buildReportedLeverage(result, basis, excerpt, notes);

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

  return {
    ...result,
    keyMetrics: {
      ...result.keyMetrics,
      totalDebt: totalDebt
        ? formatStockSentence("Total debt", totalDebt)
        : result.keyMetrics.totalDebt,
      cash: cash ? formatStockSentence("Cash", cash) : result.keyMetrics.cash,
      ebitda: ebitda
        ? formatFlowSentence("EBITDA", ebitda)
        : result.keyMetrics.ebitda,
      affo: affo ? formatFlowSentence("AFFO", affo) : result.keyMetrics.affo,
      netDebt: netDebtOutcome.text,
      netLeverage: leverage.text,
      interestCoverage: coverage,
      reportedLeverage: reportedLeverage.text,
    },
    calculationNotes: notes.join("\n"),
    documentConflicts,
    analyzedDocuments: options.fileNames,
  };
}

const PROSE_MONEY =
  /\$?\s*(-?\d{1,3}(?:,\d{3})+(?:\.\d+)?|-?\d+(?:\.\d+)?)\s*(billion|billions|million|millions|thousand|thousands)\b/i;

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
): { text: string; calculated: boolean; primaryMultiple: number | null } {
  if (!ebitda || netDebt.candidates.length === 0) {
    const reason = !ebitda
      ? "EBITDA with an identified reporting period was missing or not found in the extracted text."
      : "Net debt was not available.";
    notes.push(`Leverage check: independent leverage was not calculated. ${reason}`);
    return {
      text: `${NOT_AVAILABLE} Independent leverage was not calculated. ${reason}`,
      calculated: false,
      primaryMultiple: null,
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
  };
}

function buildCoverage(
  ebitda: ResolvedAmount | null,
  interest: ResolvedAmount | null,
  basis: CreditAnalysisModelResult["calculationBasis"],
  excerpt: string,
  notes: string[],
): string {
  const stated = verifiedMultiple(
    basis.statedInterestCoverageMultiple,
    excerpt,
  );
  const statedSentence = stated
    ? ` Company-reported interest coverage: ${formatMultiple(stated)} (${basis.statedInterestCoverageDefinition.trim() || "definition not stated"}). Source: ${sourcePhrase(basis.statedInterestCoverageSource)}.`
    : "";

  if (!ebitda || !interest) {
    notes.push(
      "Interest coverage check: independent coverage was not calculated because EBITDA and cash interest for identified periods were not both available.",
    );
    if (statedSentence) {
      return `Independent interest coverage: ${NOT_AVAILABLE} EBITDA and cash interest were not both available in the extracted text.${statedSentence}`;
    }
    return `${NOT_AVAILABLE} Independent interest coverage was not calculated because EBITDA and cash interest were not both available in the extracted text.`;
  }

  const annualizedEbitda = annualize(ebitda);
  const annualizedInterest = annualize(interest);
  if (!annualizedEbitda || !annualizedInterest) {
    notes.push(
      "Interest coverage check: independent coverage was not calculated because the EBITDA and cash interest periods could not both be expressed on a twelve-month basis.",
    );
    return `${NOT_AVAILABLE} Independent interest coverage was not calculated because the EBITDA and cash interest periods could not be aligned.${statedSentence}`;
  }

  if (annualizedInterest.value <= 0) {
    notes.push(
      "Interest coverage check: independent coverage was not calculated because twelve-month cash interest is zero or negative.",
    );
    return `${NOT_AVAILABLE} Independent interest coverage was not calculated because cash interest is zero or negative.${statedSentence}`;
  }
  if (annualizedEbitda.value <= 0) {
    notes.push(
      "Interest coverage check: independent coverage was not calculated because twelve-month EBITDA is zero or negative.",
    );
    return `${NOT_AVAILABLE} Independent interest coverage was not calculated because EBITDA is zero or negative.${statedSentence}`;
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

  const work = [describeAnnualization(ebitda, annualizedEbitda, "EBITDA"), describeAnnualization(interest, annualizedInterest, "cash interest")]
    .filter(Boolean)
    .join(" ");

  return `Independently calculated ${formatMultiple(multiple)}${approximated ? ", an annualized approximation" : ""} (${ebitdaName(ebitda, annualizedEbitda.kind)} ${formatAbsolute(annualizedEbitda.value, ebitda.scale)} / ${interestName(annualizedInterest.kind)} ${formatAbsolute(annualizedInterest.value, interest.scale)}). ${label} ${work} Sources: ${cite(ebitda, "EBITDA")}; ${cite(interest, "cash interest")}.${statedSentence}`;
}

function buildReportedLeverage(
  result: CreditAnalysisModelResult,
  basis: CreditAnalysisModelResult["calculationBasis"],
  excerpt: string,
  notes: string[],
): { text: string; multiple: number | null } {
  const multiple = verifiedMultiple(basis.statedLeverageMultiple, excerpt);
  if (multiple == null) {
    if (result.keyMetrics.reportedLeverage.trim() !== NOT_AVAILABLE) {
      notes.push(
        "Company-reported leverage was kept from the narrative draft, but its multiple was not matched to the extracted text.",
      );
    }
    return { text: result.keyMetrics.reportedLeverage, multiple: null };
  }

  const definition =
    basis.statedLeverageDefinition.trim() || "definition not stated in the filing";
  const asOf = basis.statedLeverageAsOf.trim();
  const source = sourcePhrase(basis.statedLeverageSource);
  const when = asOf ? ` (${asOf})` : "";
  return {
    text: `Company-reported ${formatMultiple(multiple)} (${definition}). Source: ${source}${when}. This is the company's ratio, not the independent calculation.`,
    multiple,
  };
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

function interestName(kind: Annualized["kind"]): string {
  if (kind === "ttm") return "TTM cash interest";
  if (kind === "annual") return "annual cash interest";
  return "annualized cash interest";
}

function formatStockSentence(label: string, amount: ResolvedAmount): string {
  const asOf = amount.asOf ? ` as of ${amount.asOf}` : "";
  return `${label}: ${formatResolved(amount)}${asOf}. Source: ${sourcePhrase(amount.sourceDocument)}.`;
}

function formatFlowSentence(label: string, amount: ResolvedAmount): string {
  const described = flowDescription(label, amount);
  const detail = amount.bridge ? ` ${amount.bridge}` : "";
  return `${described}: ${formatResolved(amount)}.${detail} Source: ${sourcePhrase(amount.sourceDocument)}${amount.asOf ? ` (${amount.asOf})` : ""}.`;
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

export function formatMultiple(value: number): string {
  const text = (Math.round(value * 100) / 100).toFixed(2).replace(/\.?0+$/, "");
  return `${text}x`;
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

function parseNumericToken(raw: string): number | null {
  let text = raw.trim().replace(/[$,]/g, "").replace(/\s+/g, "");
  if (!text) return null;
  let negative = false;
  if (text.startsWith("(") && text.endsWith(")")) {
    negative = true;
    text = text.slice(1, -1);
  }
  if (text.endsWith("x") || text.endsWith("X")) {
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

function verifiedMultiple(raw: string, excerpt: string): number | null {
  const value = parseNumericToken(raw);
  if (value == null || raw.trim() === "") return null;
  if (!multipleSupportedByExcerpt(raw, excerpt)) return null;
  return value;
}

function multipleSupportedByExcerpt(raw: string, excerpt: string): boolean {
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

function figureSupportedByExcerpt(
  rawAmount: string,
  scale: Exclude<Scale, "not_available">,
  excerpt: string,
): boolean {
  const token = parseNumericToken(rawAmount);
  if (token == null) return false;
  const variants = numericVariants(String(Math.abs(token)));
  for (const variant of variants) {
    const pattern = new RegExp(`(?<![\\d.])${escapeRegExp(variant)}(?![\\d.])`, "g");
    for (const match of excerpt.matchAll(pattern)) {
      const index = match.index ?? 0;
      const digits = variant.replace(/\D/g, "");
      if (digits.length >= 4 && scale !== "ones") return true;
      if (hasMoneyCue(excerpt, index, scale)) return true;
    }
  }
  return false;
}

function numericVariants(raw: string): string[] {
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

function hasMoneyCue(excerpt: string, index: number, scale: Scale): boolean {
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function mergeDocumentNotes(modelText: string, extractionNotes: string[]): string {
  if (extractionNotes.length === 0) return modelText;
  const missing = extractionNotes.filter(
    (note) => !modelText.toLowerCase().includes(note.slice(0, 48).toLowerCase()),
  );
  if (missing.length === 0) return modelText;
  return `${missing.join(" ")} ${modelText}`.trim();
}
