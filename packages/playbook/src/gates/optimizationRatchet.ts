/**
 * Optimization budgets ratchet (PLAYBOOK §11): compares budgets against the base commit,
 * refusing loosened limits, reordered steps, dropped sections, or dropping `step_timing`
 * unless a new `justify` reason is supplied or the owner grants an override.
 */
import { showFile } from "../git.ts";
import { failed, passed, unproven, type CheckResult } from "../result.ts";
import { isRecord, parseStrictJson } from "../strictJson.ts";

const CHECK = "optimization";
const TIME = "step_timing";
const KIND_KEYS = [
  "maxRenders",
  "maxComponentRenders",
  "maxApiCalls",
  "maxDuplicateApiCalls",
  "maxWaterfallDepth",
  "maxTimers",
  "maxPollIntervals",
  "maxQueueEnqueues",
  "maxJobStatements",
  "maxRedisCalls",
] as const;
const TIGHTER_LOWER = [
  "maxRoundTrips",
  "maxMs",
  "maxPayloadBytes",
  "maxReadAmplification",
  "maxDeadStatements",
  "maxFullScans",
  "maxEmptyScanAllowance",
  ...KIND_KEYS,
] as const;
const TIGHTER_HIGHER = ["minFetchUtilization", "minResponseUtilization"] as const;

export const isActionSubject = (subject: string) => subject.startsWith("action:");

export function isTimedBudgets(data: unknown): boolean {
  const m = isRecord(data) && isRecord(data.measurements) ? data.measurements : null;
  const sec = m && isRecord(m[TIME]) ? m[TIME] : null;
  return !(sec !== null && "notApplicable" in sec && !("by" in sec));
}

const isWhole = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;

function justifyText(budget: unknown): string {
  if (!isRecord(budget)) return "";
  if (typeof budget.justify === "string") return budget.justify.trim();
  if (Array.isArray(budget.justify)) return budget.justify.map(String).join(" ").trim();
  return "";
}

function newReason(
  base: Readonly<Record<string, unknown>>,
  head: Readonly<Record<string, unknown>>,
  subject: string,
): string | null {
  const headSubj = isRecord(head.subjects) ? head.subjects[subject] : undefined;
  const baseSubj = isRecord(base.subjects) ? base.subjects[subject] : undefined;
  const why = justifyText(headSubj);
  if (!why) return null;
  return why !== justifyText(baseSubj) ? why : null;
}

function loosenedSubjects(
  base: Readonly<Record<string, unknown>>,
  head: Readonly<Record<string, unknown>>,
): { readonly global: string[]; readonly bySubject: ReadonlyMap<string, ReadonlyArray<string>> } {
  const global: string[] = [];
  const bySubject = new Map<string, string[]>();
  const baseSec = isRecord(base.measurements) ? base.measurements : {};
  const headSec = isRecord(head.measurements) ? head.measurements : {};
  for (const [name, m] of Object.entries(baseSec)) {
    const hm = headSec[name];
    if (!isRecord(m) || (hm !== undefined && !isRecord(hm))) {
      global.push(`section ${name} is malformed at the base or on the branch`);
    } else if ("by" in m && (!isRecord(hm) || !("by" in hm))) {
      global.push(`section ${name} is no longer measured`);
    }
  }
  const timedBoth = isTimedBudgets(base) && isTimedBudgets(head);
  if (
    !timedBoth &&
    isTimedBudgets(base) &&
    !global.includes(`section ${TIME} is no longer measured`)
  ) {
    global.push(`section ${TIME} is declared not applicable: time is no longer a gate`);
  }

  const lowerKeys = timedBoth ? TIGHTER_LOWER : TIGHTER_LOWER.filter((k) => k !== "maxMs");
  const stepKeys = timedBoth ? (["maxRoundTrips", "maxMs"] as const) : (["maxRoundTrips"] as const);
  const baseSubjs = isRecord(base.subjects) ? base.subjects : {};
  const headSubjs = isRecord(head.subjects) ? head.subjects : {};

  for (const [subject, oldRaw] of Object.entries(baseSubjs)) {
    if (!(subject in headSubjs) || isActionSubject(subject)) continue;
    const newRaw = headSubjs[subject];
    if (!isRecord(oldRaw) || !isRecord(newRaw)) {
      bySubject.set(subject, [`${subject}: budget is malformed`]);
      continue;
    }
    const issues: string[] = [];
    for (const key of lowerKeys) {
      if (key in oldRaw) {
        const a = oldRaw[key];
        const b = newRaw[key];
        if (!isWhole(b) || (isWhole(a) && b > a)) {
          issues.push(
            `${subject} ${key} ${String(a)} -> ${b === undefined ? "dropped" : String(b)}`,
          );
        }
      }
    }
    for (const key of TIGHTER_HIGHER) {
      if (key in oldRaw) {
        const a = oldRaw[key];
        const b = newRaw[key];
        if (!isWhole(b) || (isWhole(a) && b < a)) {
          issues.push(
            `${subject} ${key} ${String(a)} -> ${b === undefined ? "dropped" : String(b)}`,
          );
        }
      }
    }
    const oldSteps = Array.isArray(oldRaw.steps) ? oldRaw.steps.filter(isRecord) : [];
    const newSteps = Array.isArray(newRaw.steps) ? newRaw.steps.filter(isRecord) : [];
    const newStepMap = new Map(newSteps.map((s) => [String(s.name), s] as const));
    const wasOrder = oldSteps.map((s) => String(s.name)).filter((n) => newStepMap.has(n));
    const nowOrder = newSteps.map((s) => String(s.name)).filter((n) => wasOrder.includes(n));
    if (wasOrder.join("\0") !== nowOrder.join("\0")) {
      issues.push(`${subject} steps reordered (${wasOrder.join(", ")} -> ${nowOrder.join(", ")})`);
    }
    for (const s of oldSteps) {
      const name = String(s.name);
      const n = newStepMap.get(name);
      if (!n) {
        const totalsHeld = stepKeys.every(
          (k) => isWhole(oldRaw[k]) && isWhole(newRaw[k]) && newRaw[k] <= oldRaw[k],
        );
        if (!totalsHeld) issues.push(`${subject} step ${name} dropped without holding totals`);
        continue;
      }
      for (const k of stepKeys) {
        if (isWhole(s[k]) && isWhole(n[k]) && n[k] > s[k]) {
          issues.push(`${subject} step ${name} ${k} ${s[k]} -> ${n[k]}`);
        }
      }
    }
    if (issues.length > 0) bySubject.set(subject, issues);
  }
  return { global, bySubject };
}

export async function runBudgetRatchet(input: {
  readonly root: string;
  readonly rel: string;
  readonly head: Readonly<Record<string, unknown>>;
  readonly base: string | null;
  readonly baseData: Readonly<Record<string, unknown>> | null;
  readonly ask: (reason: string) => Promise<boolean>;
}): Promise<ReadonlyArray<CheckResult>> {
  if (!input.base) return [];
  const baseContracts = isRecord(input.baseData?.contracts) ? input.baseData.contracts : {};
  const baseOpt = isRecord(baseContracts.optimization) ? baseContracts.optimization : {};
  const baseRel = typeof baseOpt.file === "string" ? baseOpt.file : input.rel;
  const baseText = showFile(input.root, input.base, baseRel);
  if (baseText === null) {
    const hasNonAction =
      isRecord(input.head.subjects) &&
      Object.keys(input.head.subjects).some((s) => !isActionSubject(s));
    if (!isTimedBudgets(input.head) && hasNonAction) {
      const line = `section ${TIME} is declared not applicable: time is no longer a gate`;
      if (await input.ask(`${input.rel} loosens its budgets: ${line}`)) {
        return [passed(`${CHECK} budgets`, "1 loosening under override")];
      }
      return [
        failed(CHECK, `${input.rel} loosens 1 budget(s) with no new reason`, {
          errors: [line],
          files: [input.rel],
        }),
      ];
    }
    return [];
  }
  let baseDoc: unknown;
  try {
    baseDoc = parseStrictJson(baseText);
  } catch (cause) {
    return [
      unproven(
        `${CHECK} budgets`,
        `the base's budgets ${baseRel} cannot be read (${String(cause)})`,
        {
          files: [input.rel],
        },
      ),
    ];
  }
  if (!isRecord(baseDoc)) {
    return [
      unproven(`${CHECK} budgets`, `the base's budgets ${baseRel} are not an object`, {
        files: [input.rel],
      }),
    ];
  }

  const diff = loosenedSubjects(baseDoc, input.head);
  const reasoned: Array<{ readonly subject: string; readonly why: string }> = [];
  const loose: string[] = [...diff.global];
  for (const [subject, lines] of diff.bySubject) {
    const why = newReason(baseDoc, input.head, subject);
    if (why) reasoned.push({ subject, why });
    else loose.push(...lines);
  }

  const out: CheckResult[] = [];
  if (reasoned.length > 0) {
    const desc = reasoned
      .toSorted((a, b) => a.subject.localeCompare(b.subject))
      .map((r) => `${r.subject} (${r.why})`)
      .join("; ");
    out.push(
      passed(
        `${CHECK} reasons`,
        `${reasoned.length} budget rise(s) with a new reason: ${desc.slice(0, 400)}`,
      ),
    );
  }
  if (loose.length === 0) return out;
  if (await input.ask(`${input.rel} loosens its budgets: ${loose.join("; ").slice(0, 360)}`)) {
    out.push(passed(`${CHECK} budgets`, `${loose.length} loosening(s) under override`));
    return out;
  }
  return [
    failed(CHECK, `${input.rel} loosens ${loose.length} budget(s) with no new reason`, {
      errors: loose,
      files: [input.rel],
      fix: "optimize until the measurement meets the budget, or add a new `justify` reason",
    }),
  ];
}
