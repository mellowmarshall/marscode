// @effect-diagnostics nodeBuiltinImport:off - Headless playbook gate reads `.tree-guard.conf` paths with posix path utilities.
/**
 * Optimization waste rules and `measuredBy: "merge-gate"` validation (PLAYBOOK §11).
 * Domain seam extracted from `optimizationGate.ts`.
 */
import * as NodePath from "node:path";

import { readWorktreeFile } from "../git.ts";
import { isRecord } from "../strictJson.ts";

const isWhole = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;

function mergeGateCommand(root: string): string | null {
  const text = readWorktreeFile(root, ".tree-guard.conf");
  if (!text) return null;
  let gate = "";
  const records = new Set<string>();
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const idx = line.indexOf("=");
    const key = line.slice(0, idx).trim();
    const val = line.slice(idx + 1).trim();
    if (key === "ship_merge_gate") gate = val;
    else if (key === "ship_pass_record") records.add(val);
  }
  return gate && records.has("merge") ? gate : null;
}

export function mergeGateProblems(root: string, data: Readonly<Record<string, unknown>>): string[] {
  const command = mergeGateCommand(root);
  if (!command) {
    return [
      "playbook.json: contracts.optimization.measuredBy is merge-gate, but .tree-guard.conf does not declare ship_merge_gate and ship_pass_record=merge",
    ];
  }
  const measurements = isRecord(data.measurements) ? data.measurements : {};
  const harnesses = [
    ...new Set(
      Object.values(measurements)
        .filter((m): m is Record<string, unknown> => isRecord(m) && typeof m.by === "string")
        .map((m) => String(m.by)),
    ),
  ].toSorted();
  const texts = [command];
  for (const word of command.split(/\s+/)) {
    const rel = word.replace(/^["']|["']$/g, "").replace(/^\.\//, "");
    if (rel.includes("/")) {
      const body = readWorktreeFile(root, rel);
      if (body !== null) texts.push(body);
    }
  }
  const missing = harnesses.filter((h) => {
    const dir = NodePath.posix.dirname(h);
    const wants = [h, ...(dir && dir !== "." ? [dir] : [])];
    return !texts.some((text) =>
      text
        .split("\n")
        .filter((l) => !l.trimStart().startsWith("#"))
        .some((line) => {
          const code = line.split(/\s#/)[0] ?? "";
          return code
            .split(/[\s;&|()<>"'=`]+/)
            .map((w) => w.replace(/^\.\//, "").replace(/\/+$/, ""))
            .some((w) => wants.some((t) => w === t || w.endsWith(`/${t}`)));
        }),
    );
  });
  return missing.length > 0
    ? [
        `playbook.json: contracts.optimization.measuredBy is merge-gate, but ${command} does not name harness ${missing.join(", ")}`,
      ]
    : [];
}

export function judgeOptimizationWaste(
  subject: string,
  budget: Readonly<Record<string, unknown>>,
  r: Readonly<Record<string, unknown>>,
  volumes: ReadonlyMap<string, string | null>,
  addFinding: (rule: string, subject: string, message: string) => void,
  values: Map<string, number>,
  problems: string[],
  rel: string,
): void {
  const allowance = isWhole(budget.maxEmptyScanAllowance) ? budget.maxEmptyScanAllowance : 10;
  if (isRecord(r.worstScanNode) || Array.isArray(r.scanNodes)) {
    const nodes = isRecord(r.worstScanNode)
      ? [r.worstScanNode]
      : (r.scanNodes as unknown[]).filter(isRecord);
    let worstRatio = 1;
    let worstTarget = "no scans";
    for (const node of nodes) {
      const outRows = isWhole(node.rowsOutput) ? node.rowsOutput : 0;
      const removed = isWhole(node.rowsRemoved) ? node.rowsRemoved : 0;
      const ratio = isWhole(node.amplification)
        ? node.amplification
        : outRows === 0 && removed <= allowance
          ? 1
          : Math.ceil((removed + outRows) / Math.max(outRows, 1));
      if (ratio >= worstRatio) {
        worstRatio = ratio;
        worstTarget = `${String(node.type ?? "Scan")} on ${String(node.table ?? "unknown")}`;
      }
    }
    if (isWhole(budget.maxReadAmplification) && worstRatio > budget.maxReadAmplification) {
      values.set(`${subject}\0optimization/read-amplification`, worstRatio);
      addFinding(
        "optimization/read-amplification",
        subject,
        `${subject} examines ${worstRatio} row(s) per row output at ${worstTarget} > ${budget.maxReadAmplification}`,
      );
    }
  } else if (isWhole(r.rowsExamined)) {
    const returned = isWhole(r.rowsReturned) ? r.rowsReturned : 0;
    const done =
      returned +
      (isWhole(r.rowsReduced) ? r.rowsReduced : 0) +
      (isWhole(r.rowsWritten) ? r.rowsWritten : 0);
    const ratio =
      returned === 0 && r.rowsExamined <= allowance
        ? 1
        : Math.ceil(r.rowsExamined / Math.max(done, 1));
    if (isWhole(budget.maxReadAmplification) && ratio > budget.maxReadAmplification) {
      values.set(`${subject}\0optimization/read-amplification`, ratio);
      addFinding(
        "optimization/read-amplification",
        subject,
        `${subject} examines ${ratio} row(s) per row > ${budget.maxReadAmplification}`,
      );
    }
  }
  const fullScans = Array.isArray(r.fullScans)
    ? r.fullScans.filter((t): t is string => typeof t === "string")
    : [];
  const large = fullScans
    .filter((t) => volumes.get(t) === "large" || volumes.get(t) === "huge")
    .toSorted();
  if (isWhole(budget.maxFullScans) && large.length > budget.maxFullScans) {
    values.set(`${subject}\0optimization/full-scan`, large.length);
    addFinding(
      "optimization/full-scan",
      subject,
      `${subject} fully scans ${large.length} large table(s) > ${budget.maxFullScans}: ${large.join(", ")}`,
    );
  }
  if (
    isWhole(budget.maxDeadStatements) &&
    isWhole(r.deadStatements) &&
    r.deadStatements > budget.maxDeadStatements
  ) {
    values.set(`${subject}\0optimization/dead-statements`, r.deadStatements);
    addFinding(
      "optimization/dead-statements",
      subject,
      `${subject} runs ${r.deadStatements} dead statement(s) > ${budget.maxDeadStatements}`,
    );
  }
  for (const [kind, sent, used, key] of [
    ["fetch", "fieldsFetched", "fieldsUsed", "minFetchUtilization"],
    ["response", "responseFieldsSent", "responseFieldsRead", "minResponseUtilization"],
  ] as const) {
    if (!isWhole(budget[key])) continue;
    if (!isWhole(r[sent]) || !isWhole(r[used])) {
      problems.push(
        `${rel}: ${subject} budgets ${key}, but its receipt has no ${sent} and ${used}`,
      );
      continue;
    }
    const pct = r[sent] === 0 ? 100 : Math.floor((100 * Math.min(r[used], r[sent])) / r[sent]);
    if (pct < budget[key]) {
      values.set(`${subject}\0optimization/${kind}-waste`, 100 - pct);
      addFinding(
        `optimization/${kind}-waste`,
        subject,
        `${subject} uses ${pct}% < ${budget[key]}%`,
      );
    }
  }
}
