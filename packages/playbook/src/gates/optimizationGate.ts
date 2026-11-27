// @effect-diagnostics nodeBuiltinImport:off - Computes deterministic SHA-1 digests for optimization budget and source receipts.
/**
 * `playbook check optimization`: optimization budgets and receipts (PLAYBOOK §11).
 * Composes with `@t3tools/surface` (`surfaceItems`) to enumerate route subjects, validates
 * budgets against `optimization-budgets.schema.json`, checks receipts or `measuredBy: "merge-gate"`,
 * delegates waste & ratchet checks to sibling domain modules, and enforces value-rule Baselines.
 */
import * as NodeCrypto from "node:crypto";

import type { BaselineEntry } from "../baseline.ts";
import { sectionRuleReasons, type Bypasses } from "../bypass.ts";
import { validateAgainstSchema } from "../declarationSchema.ts";
import { changedFiles, readWorktreeBytes, worktreePathExists } from "../git.ts";
import { failed, passed, type CheckResult } from "../result.ts";
import { canonicalJson, isRecord } from "../strictJson.ts";
import { findingCountsSummary, judgeFindings, type GateFinding } from "./findings.ts";
import { isActionSubject, isTimedBudgets, runBudgetRatchet } from "./optimizationRatchet.ts";
import {
  listOptimizationSubjects,
  readStrictJsonFile,
  schemaWithTiming,
} from "./optimizationSubjects.ts";
import { judgeOptimizationWaste, mergeGateProblems } from "./optimizationWaste.ts";

const CHECK = "optimization";
const SECTIONS = [
  "step_timing",
  "round_trips",
  "query_shape",
  "read_amplification",
  "fetch_utilization",
  "plan_stability",
  "payload",
  "caching",
  "search",
  "write_coalescing",
  "connection_hold",
  "cancellation",
  "transaction_scope",
  "memory_churn",
  "complexity",
  "bundle_size",
  "external_timeouts",
  "tail_latency",
  "render_bounds",
] as const;
const SECTION_SET = new Set<string>(SECTIONS);
const KINDS: Readonly<Record<string, readonly [string, string, string]>> = {
  renders: ["maxRenders", "optimization/over-renders", "render(s)"],
  componentRenders: [
    "maxComponentRenders",
    "optimization/over-component-renders",
    "component render(s)",
  ],
  apiCalls: ["maxApiCalls", "optimization/over-api-calls", "API call(s)"],
  duplicateApiCalls: [
    "maxDuplicateApiCalls",
    "optimization/over-duplicate-api-calls",
    "duplicate API call(s)",
  ],
  waterfallDepth: ["maxWaterfallDepth", "optimization/over-waterfall-depth", "waterfall depth"],
  timers: ["maxTimers", "optimization/over-timers", "timer(s)"],
  pollIntervals: ["maxPollIntervals", "optimization/over-poll-intervals", "poll interval(s)"],
  queueEnqueues: ["maxQueueEnqueues", "optimization/over-queue-enqueues", "queue enqueue(s)"],
  jobStatements: ["maxJobStatements", "optimization/over-job-statements", "job statement(s)"],
  redisCalls: ["maxRedisCalls", "optimization/over-redis-calls", "Redis call(s)"],
};
const VALUE_RULES = new Set<string>([
  "optimization/over-round-trips",
  "optimization/over-time",
  "optimization/read-amplification",
  "optimization/full-scan",
  "optimization/dead-statements",
  "optimization/fetch-waste",
  "optimization/response-waste",
  ...Object.values(KINDS).map(([, rule]) => rule),
]);
const SECTION_FIELDS: Readonly<Record<string, ReadonlyArray<string>>> = {
  read_amplification: ["rowsExamined", "rowsReturned"],
  fetch_utilization: ["fieldsFetched", "fieldsUsed", "deadStatements"],
};
const SECTION_BUDGETS: Readonly<Record<string, ReadonlyArray<string>>> = {
  read_amplification: ["maxReadAmplification", "maxFullScans"],
  fetch_utilization: ["minFetchUtilization", "maxDeadStatements"],
};
const SUBJECT_RE = /^(?:[A-Z]+ \S+|role:\S+)$/;
const SHA1_RE = /^[0-9a-f]{40}$/;

const isWhole = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;
const sha1Hex = (data: string | Buffer) => NodeCrypto.createHash("sha1").update(data).digest("hex");

export async function optimizationGate(input: {
  readonly root: string;
  readonly settings: Readonly<Record<string, unknown>>;
  readonly declaration: Readonly<Record<string, unknown>>;
  readonly entries: ReadonlyArray<BaselineEntry>;
  readonly bypasses: Bypasses;
  readonly base: string | null;
  readonly baseData: Readonly<Record<string, unknown>> | null;
  readonly ask: (reason: string) => Promise<boolean>;
}): Promise<ReadonlyArray<CheckResult>> {
  const s = input.settings;
  const { owners, problems } = listOptimizationSubjects(input.root, input.declaration);

  if ("none" in s) {
    if (Object.keys(s).length !== 1) {
      return [
        failed(CHECK, "contracts.optimization is `none` or file/receipts, not both", {
          files: ["playbook.json"],
        }),
      ];
    }
    if (owners.size > 0) {
      return [
        failed(
          CHECK,
          `contracts.optimization opts out, but the repo has ${owners.size} subject(s) to budget (e.g. ${[...owners.keys()].toSorted()[0]})`,
          { files: ["playbook.json"] },
        ),
      ];
    }
    return [passed(CHECK, `opted out: ${String(s.none)}`)];
  }

  const gated = "measuredBy" in s;
  if (gated) {
    if (s.measuredBy !== "merge-gate") {
      problems.push("playbook.json: contracts.optimization.measuredBy must be 'merge-gate'");
    }
    if ("receipts" in s) {
      problems.push(
        "playbook.json: contracts.optimization declares measuredBy or receipts, not both",
      );
    }
  }

  const fileRel = typeof s.file === "string" ? s.file : null;
  const loaded = readStrictJsonFile(input.root, fileRel);
  if (loaded.error || !isRecord(loaded.data)) {
    return [
      failed(CHECK, `the budgets file ${String(fileRel)} ${loaded.error ?? "is not an object"}`, {
        errors: problems,
      }),
    ];
  }
  const data = loaded.data;
  const nonActionSubjects = isRecord(data.subjects)
    ? Object.fromEntries(Object.entries(data.subjects).filter(([k]) => !isActionSubject(k)))
    : data.subjects;
  for (const err of validateAgainstSchema(
    { ...data, subjects: nonActionSubjects },
    schemaWithTiming(data),
  )) {
    problems.push(`${fileRel}: ${err}`);
  }
  const measurements = isRecord(data.measurements) ? data.measurements : {};
  for (const [name, m] of Object.entries(measurements)) {
    if (!SECTION_SET.has(name))
      problems.push(`${fileRel}: ${name} is not a section of the standard`);
    else if (isRecord(m)) {
      if ("by" in m === "notApplicable" in m) {
        problems.push(`${fileRel}: section ${name} takes exactly one of by and notApplicable`);
      } else if (typeof m.by === "string" && !worktreePathExists(input.root, m.by)) {
        problems.push(`${fileRel}: section ${name} is measured by ${m.by}, which does not exist`);
      }
    }
  }
  const budgets: Record<string, Record<string, unknown>> = {};
  if (isRecord(nonActionSubjects)) {
    for (const [subj, b] of Object.entries(nonActionSubjects)) {
      if (!isRecord(b)) continue;
      budgets[subj] = b;
      if (!SUBJECT_RE.test(subj))
        problems.push(`${fileRel}: '${subj}' is not a valid budget subject`);
      const steps = Array.isArray(b.steps) ? b.steps.filter(isRecord) : [];
      if (steps.length === 0) problems.push(`${fileRel}: ${subj} declares no steps`);
      const names = steps.map((st) => String(st.name));
      if (new Set(names).size !== names.length)
        problems.push(`${fileRel}: ${subj} names a step twice`);
    }
  }
  if (gated && problems.length === 0) problems.push(...mergeGateProblems(input.root, data));

  const receiptsRel = gated ? "(merge-gate)" : typeof s.receipts === "string" ? s.receipts : null;
  const receipts: Record<string, Record<string, unknown>> = {};
  if (!gated && problems.length === 0) {
    const rLoaded = readStrictJsonFile(input.root, receiptsRel);
    if (
      rLoaded.error ||
      !isRecord(rLoaded.data) ||
      rLoaded.data.version !== 1 ||
      !isRecord(rLoaded.data.receipts)
    ) {
      problems.push(
        `the receipts ledger ${String(receiptsRel)} ${rLoaded.error ?? 'expected {"version": 1, "receipts": {...}}'}`,
      );
    } else {
      for (const [k, v] of Object.entries(rLoaded.data.receipts)) {
        if (isRecord(v)) receipts[k] = v;
      }
    }
  }

  const timed = isTimedBudgets(data);
  const actions = new Set([...owners.keys()].filter(isActionSubject));
  for (const [subj, r] of Object.entries(receipts)) {
    if (!(subj in budgets) && !actions.has(subj)) {
      problems.push(`${receiptsRel}: a receipt for ${subj}, which has no budget`);
      continue;
    }
    const steps = Array.isArray(r.steps) ? r.steps : null;
    const msOk = (obj: Record<string, unknown>) =>
      timed ? isWhole(obj.ms) : !("ms" in obj) || isWhole(obj.ms);
    const digestOk = actions.has(subj)
      ? Boolean(steps && steps.length > 0) &&
        (!("budget" in r) || (typeof r.budget === "string" && SHA1_RE.test(r.budget)))
      : typeof r.budget === "string" && SHA1_RE.test(r.budget);
    if (
      !steps ||
      !steps.every(
        (st) => isRecord(st) && typeof st.name === "string" && isWhole(st.roundTrips) && msOk(st),
      ) ||
      !isWhole(r.roundTrips) ||
      !msOk(r) ||
      !digestOk ||
      ("source" in r && !(typeof r.source === "string" && SHA1_RE.test(r.source)))
    ) {
      problems.push(`${receiptsRel}: malformed receipt for ${subj}`);
    }
  }

  const measured = new Set(
    Object.entries(measurements)
      .filter(([, m]) => isRecord(m) && "by" in m)
      .map(([n]) => n),
  );
  for (const [subj, b] of Object.entries(budgets)) {
    for (const sec of [...measured].toSorted()) {
      for (const reqKey of SECTION_BUDGETS[sec] ?? []) {
        if (!(reqKey in b))
          problems.push(
            `${fileRel}: ${subj} declares no ${reqKey} required by measured section ${sec}`,
          );
      }
    }
  }
  for (const subj of Object.keys(budgets).toSorted()) {
    if (!owners.has(subj))
      problems.push(`${fileRel}: ${subj} is budgeted but is no route or role the repo lists`);
  }
  if (problems.length > 0) {
    return [
      failed(CHECK, `${problems.length} optimization budget problem(s)`, {
        errors: problems,
        files: fileRel ? [fileRel] : [],
      }),
    ];
  }

  const ratchet = await runBudgetRatchet({
    root: input.root,
    rel: fileRel!,
    head: data,
    base: input.base,
    baseData: input.baseData,
    ask: input.ask,
  });
  if (ratchet.some((r) => r.status !== "PASS")) return ratchet;

  const volumes = new Map<string, string | null>();
  const contracts = isRecord(input.declaration.contracts) ? input.declaration.contracts : {};
  const dictRel =
    isRecord(contracts.dictionary) && typeof contracts.dictionary.file === "string"
      ? contracts.dictionary.file
      : null;
  if (dictRel) {
    const dict = readStrictJsonFile(input.root, dictRel);
    if (isRecord(dict.data) && isRecord(dict.data.tables)) {
      for (const [t, spec] of Object.entries(dict.data.tables)) {
        volumes.set(t, isRecord(spec) && typeof spec.volume === "string" ? spec.volume : null);
      }
    }
  }

  const findings: GateFinding[] = [];
  const values = new Map<string, number>();
  const addFinding = (rule: string, subject: string, message: string) =>
    findings.push({ rule, file: subject, text: "", message, where: subject });

  for (const name of SECTIONS) {
    if (!(name in measurements)) {
      addFinding(
        "optimization/unmeasured-section",
        `section:${name}`,
        `section ${name} is neither measured (by) nor declared notApplicable`,
      );
    }
  }
  if (measured.has("read_amplification")) {
    for (const [table, vol] of [...volumes.entries()].toSorted(([a], [b]) => a.localeCompare(b))) {
      if (vol === null)
        addFinding(
          "optimization/undeclared-volume",
          `table:${table}`,
          `table ${table} declares no volume in dictionary`,
        );
    }
  }
  for (const subj of [...owners.keys()].toSorted()) {
    if (!(subj in budgets) && !actions.has(subj))
      addFinding("optimization/unbudgeted", subj, `${subj} has no budget`);
  }
  const sourceDigest = (owner: string | null) => {
    if (!owner) return null;
    const bytes = readWorktreeBytes(input.root, owner);
    return bytes ? sha1Hex(bytes) : null;
  };
  const repoEvidenceWaived = sectionRuleReasons(input.bypasses, 9, ["Repo evidence"]).length > 0;
  for (const subj of [...actions].toSorted()) {
    if (repoEvidenceWaived) continue;
    const r = receipts[subj];
    if (!r) {
      if (!gated) addFinding("optimization/unmeasured", subj, `${subj} has no receipt`);
      continue;
    }
    if (r.source !== sourceDigest(owners.get(subj) ?? null)) {
      addFinding("optimization/stale", subj, `${subj}'s receipt predates its owning file`);
    }
  }

  const receiptProblems: string[] = [];
  for (const [subj, budget] of Object.entries(budgets).toSorted(([a], [b]) => a.localeCompare(b))) {
    const r = receipts[subj];
    if (!r) {
      if (!gated) addFinding("optimization/unmeasured", subj, `${subj} has no receipt`);
      continue;
    }
    if (
      r.budget !== sha1Hex(canonicalJson(budget)) ||
      (r.source ?? null) !== sourceDigest(owners.get(subj) ?? null)
    ) {
      addFinding(
        "optimization/stale",
        subj,
        `${subj}'s receipt predates its budget or owning file`,
      );
      continue;
    }
    const bSteps = Array.isArray(budget.steps) ? budget.steps.filter(isRecord) : [];
    const rSteps = Array.isArray(r.steps) ? r.steps.filter(isRecord) : [];
    const rNames = rSteps.map((st) => String(st.name));
    const bNames = bSteps.map((st) => String(st.name));
    const required = bSteps.filter((st) => st.optional !== true).map((st) => String(st.name));
    if (
      rNames.join("\0") !== bNames.filter((n) => rNames.includes(n)).join("\0") ||
      required.some((req) => !rNames.includes(req))
    ) {
      receiptProblems.push(
        `${receiptsRel}: receipt for ${subj} does not measure its budget's steps`,
      );
      continue;
    }
    const bMap = new Map(bSteps.map((st) => [String(st.name), st] as const));
    const metricPairs: ReadonlyArray<readonly [string, string, string]> = timed
      ? [
          ["roundTrips", "maxRoundTrips", "optimization/over-round-trips"],
          ["ms", "maxMs", "optimization/over-time"],
        ]
      : [["roundTrips", "maxRoundTrips", "optimization/over-round-trips"]];
    for (const [metric, key, rule] of metricPairs) {
      const late: string[] = [];
      for (const st of rSteps) {
        const b = bMap.get(String(st.name));
        if (b && isWhole(b[key]) && isWhole(st[metric]) && st[metric] > b[key]) {
          late.push(`step ${String(st.name)} ${st[metric]} > ${b[key]}`);
        }
      }
      const overTotal = isWhole(r[metric]) && isWhole(budget[key]) && r[metric] > budget[key];
      if (overTotal || late.length > 0) {
        values.set(`${subj}\0${rule}`, isWhole(r[metric]) ? r[metric] : 0);
        const parts = [
          ...(overTotal ? [`total ${String(r[metric])} > ${String(budget[key])}`] : []),
          ...late,
        ];
        addFinding(rule, subj, `${subj} measured over its ${metric} budget: ${parts.join(", ")}`);
      }
    }
    for (const [metric, [key, rule, label]] of Object.entries(KINDS)) {
      if (!isWhole(budget[key])) continue;
      if (!isWhole(r[metric]))
        receiptProblems.push(`${receiptsRel}: ${subj} budgets ${key}, but receipt lacks ${metric}`);
      else if (r[metric] > budget[key]) {
        values.set(`${subj}\0${rule}`, r[metric]);
        addFinding(rule, subj, `${subj} measured ${r[metric]} ${label} > ${budget[key]}`);
      }
    }
    for (const sec of [...measured].toSorted()) {
      if (sec === "read_amplification" && ("worstScanNode" in r || "scanNodes" in r)) continue;
      const missing = (SECTION_FIELDS[sec] ?? []).filter((f) => !(f in r));
      if (missing.length > 0)
        receiptProblems.push(`${receiptsRel}: receipt for ${subj} lacks ${missing.join(", ")}`);
    }
    judgeOptimizationWaste(
      subj,
      budget,
      r,
      volumes,
      addFinding,
      values,
      receiptProblems,
      receiptsRel!,
    );
  }
  if (receiptProblems.length > 0) {
    return [
      failed(CHECK, `${receiptProblems.length} optimization receipt problem(s)`, {
        errors: receiptProblems,
      }),
    ];
  }

  const touched = new Set<string>();
  if (input.base && typeof s.baseline === "string") {
    const changed = new Set(
      (changedFiles(input.root, input.base, "HEAD") ?? []).map((c) => c.path),
    );
    for (const [subj, owner] of owners) if (owner && changed.has(owner)) touched.add(subj);
  }
  const baselinePath = typeof s.baseline === "string" ? s.baseline : null;
  const judged = judgeFindings(findings, input.entries, {
    baselinePath,
    touched,
    touchedNote: " (its owning file changed in this change: touch it, fix it)",
    measuredValues: values,
    valueRules: VALUE_RULES,
  });
  const summary = `${Object.keys(budgets).length} of ${owners.size - actions.size} subject(s) budgeted`;
  if (judged.problems.length > 0) {
    return [
      ...ratchet,
      failed(CHECK, `${judged.problems.length} optimization finding(s)`, {
        errors: judged.problems,
        files: [fileRel!],
      }),
    ];
  }
  const heldNote =
    findings.length > 0 ? `, ${findings.length} held (${findingCountsSummary(findings)})` : "";
  return [
    ...ratchet,
    passed(
      CHECK,
      `${summary}, ${gated ? "merge gate measures" : "every receipt fresh and within budget"}${heldNote}`,
    ),
  ];
}
