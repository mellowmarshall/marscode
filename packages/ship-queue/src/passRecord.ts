// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Pass-record store: records complete CI/merge/deploy passes keyed by git tree hash.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

export const PASS_RECORD_SCHEMA = 1;
export const PASS_KEEP_DAYS = 14;
export const PASS_KEEP_PER_STAGE = 200;
export const PASS_SKEW_S = 600;
export const PASS_MAX_LINE = 65_536;
export const PASS_REPORT_MAX = 40_000;
const REPORT_CUT = "\n(cut: the report is longer)\n";

const STAGES = new Set<PassStage>(["ci", "merge", "deploy"]);
const NAME_RE = /^[A-Za-z0-9._-]+$/;
const HEX_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const CLAIM_KEYS = new Set([
  "schema",
  "repo",
  "stage",
  "tree",
  "command",
  "context",
  "excludes",
  "tools",
  "at",
]);

export type PassStage = "ci" | "merge" | "deploy";

export interface PassClaim {
  readonly schema: 1;
  readonly repo: string;
  readonly stage: PassStage;
  readonly tree: string;
  readonly command: string;
  readonly context: string;
  readonly excludes: ReadonlyArray<string>;
  readonly tools: Readonly<Record<string, string>>;
  readonly at: number;
  readonly report?: string | undefined;
}

export interface StoredPassRecord extends PassClaim {
  readonly host: string;
  readonly time: string;
}

export interface FindPassQuery {
  readonly repo: string;
  readonly stage: PassStage;
  readonly tree: string;
  readonly command: string;
  readonly context: string;
  readonly excludes: ReadonlyArray<string>;
}

function isValidLineText(value: unknown, limit = 4096): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= limit &&
    !value.includes("\n") &&
    !value.includes("\0")
  );
}

/** Returns why `claim` is invalid, or `null` when valid. */
export function validatePassClaim(claim: unknown): string | null {
  if (!claim || typeof claim !== "object" || Array.isArray(claim)) return "not a claim's fields";
  const c = claim as Record<string, unknown>;
  const keys = Object.keys(c).filter((k) => k !== "report");
  if (keys.length !== CLAIM_KEYS.size || !keys.every((k) => CLAIM_KEYS.has(k))) {
    return "not a claim's fields";
  }
  if ("report" in c) {
    if (
      typeof c.report !== "string" ||
      c.report.length === 0 ||
      c.report.length > PASS_REPORT_MAX ||
      c.report.includes("\0")
    ) {
      return "report";
    }
  }
  if (c.schema !== PASS_RECORD_SCHEMA) return `schema ${JSON.stringify(c.schema)}`;
  if (!isValidLineText(c.repo, 100) || !NAME_RE.test(c.repo) || c.repo === "." || c.repo === "..") {
    return "repo";
  }
  if (typeof c.stage !== "string" || !STAGES.has(c.stage as PassStage)) return "stage";
  if (typeof c.tree !== "string" || !HEX_RE.test(c.tree)) return "tree";
  if (typeof c.context !== "string" || !HEX_RE.test(c.context)) return "context";
  const tools = c.tools;
  if (!tools || typeof tools !== "object" || Array.isArray(tools)) return "tools";
  const toolEntries = Object.entries(tools as Record<string, unknown>);
  if (
    toolEntries.length === 0 ||
    toolEntries.length > 500 ||
    !toolEntries.every(([n, v]) => isValidLineText(n, 100) && isValidLineText(v, 200))
  ) {
    return "tools";
  }
  if (!isValidLineText(c.command)) return "command";
  const ex = c.excludes;
  if (!Array.isArray(ex) || ex.length > 200 || !ex.every((x) => isValidLineText(x, 1024))) {
    return "excludes";
  }
  const sortedUnique = [...new Set(ex as string[])].toSorted();
  if (sortedUnique.length !== ex.length || sortedUnique.some((v, idx) => v !== ex[idx])) {
    return "excludes";
  }
  if (typeof c.at !== "number" || !Number.isInteger(c.at) || c.at <= 0) return "at";
  return null;
}

export function createPassClaim(input: {
  readonly tools: Readonly<Record<string, string>>;
  readonly repo: string;
  readonly stage: PassStage;
  readonly tree: string;
  readonly command: string;
  readonly context: string;
  readonly excludes?: ReadonlyArray<string> | undefined;
  readonly nowEpochSec: number;
  readonly reportText?: string | undefined;
}): PassClaim {
  let report: string | undefined;
  if (input.reportText) {
    const cleaned = input.reportText.replaceAll("\0", "");
    if (cleaned.trim().length > 0) {
      report =
        cleaned.length <= PASS_REPORT_MAX
          ? cleaned
          : cleaned.slice(0, PASS_REPORT_MAX - 40) + REPORT_CUT;
    }
  }
  const base: PassClaim = {
    schema: PASS_RECORD_SCHEMA,
    repo: input.repo,
    stage: input.stage,
    tree: input.tree,
    command: input.command,
    context: input.context,
    excludes: [...new Set(input.excludes ?? [])].toSorted(),
    tools: { ...input.tools },
    at: Math.floor(input.nowEpochSec),
    ...(report ? { report } : {}),
  };
  let trimmedReport = base.report;
  while (
    trimmedReport &&
    JSON.stringify({ ...base, report: trimmedReport }).length > PASS_MAX_LINE - 2048 &&
    trimmedReport.length > REPORT_CUT.length
  ) {
    const nextLen = Math.floor(((trimmedReport.length - REPORT_CUT.length) * 3) / 4);
    trimmedReport = trimmedReport.slice(0, nextLen) + REPORT_CUT;
  }
  const current: PassClaim =
    trimmedReport !== undefined ? { ...base, report: trimmedReport } : base;
  const err = validatePassClaim(current);
  if (err) throw new Error(`not a pass record: ${err}`);
  return current;
}

export function passRecordPath(
  rootDir: string,
  repo: string,
  stage: PassStage,
  tree: string,
): string {
  return NodePath.join(rootDir, repo, stage, `${tree}.json`);
}

function readJsonRecord(filePath: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(NodeFS.readFileSync(filePath, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function prunePassRecords(stageDir: string, nowEpochSec: number): void {
  if (!NodeFS.existsSync(stageDir)) return;
  let names: string[];
  try {
    names = NodeFS.readdirSync(stageDir);
  } catch {
    return;
  }
  const live: Array<{ readonly at: number; readonly filePath: string }> = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const filePath = NodePath.join(stageDir, name);
    const doc = readJsonRecord(filePath);
    const at = typeof doc?.at === "number" && Number.isInteger(doc.at) ? doc.at : null;
    if (at === null || nowEpochSec - at > PASS_KEEP_DAYS * 86_400) {
      NodeFS.rmSync(filePath, { force: true });
    } else {
      live.push({ at, filePath });
    }
  }
  live.sort((a, b) => b.at - a.at);
  for (const stale of live.slice(PASS_KEEP_PER_STAGE)) {
    NodeFS.rmSync(stale.filePath, { force: true });
  }
}

export function writePassRecord(
  rootDir: string,
  doc: PassClaim | StoredPassRecord,
  nowEpochSec: number,
): boolean {
  const targetPath = passRecordPath(rootDir, doc.repo, doc.stage, doc.tree);
  const stageDir = NodePath.dirname(targetPath);
  NodeFS.mkdirSync(stageDir, { recursive: true });
  const existing = readJsonRecord(targetPath);
  if (existing && typeof existing.at === "number" && existing.at > doc.at) {
    return false;
  }
  const tmpPath = NodePath.join(stageDir, `.tmp-${process.pid}-${doc.tree}.json`);
  NodeFS.writeFileSync(tmpPath, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
  NodeFS.renameSync(tmpPath, targetPath);
  prunePassRecords(stageDir, nowEpochSec);
  return true;
}

export function toStoredPassRecord(claim: PassClaim, host: string): StoredPassRecord {
  if (!isValidLineText(host, 100) || !NAME_RE.test(host)) {
    throw new Error(`not a host name: ${JSON.stringify(host)}`);
  }
  const time = new Date(claim.at * 1000).toISOString().slice(0, 19);
  return { ...claim, host, time };
}

export function dumpPassClaims(outboxDir: string, nowEpochSec: number): ReadonlyArray<string> {
  if (!NodeFS.existsSync(outboxDir)) return [];
  const out: string[] = [];
  for (const repo of NodeFS.readdirSync(outboxDir).toSorted()) {
    for (const stage of STAGES) {
      const stageDir = NodePath.join(outboxDir, repo, stage);
      if (!NodeFS.existsSync(stageDir)) continue;
      prunePassRecords(stageDir, nowEpochSec);
      for (const name of NodeFS.readdirSync(stageDir).toSorted()) {
        if (!name.endsWith(".json")) continue;
        const fullPath = NodePath.join(stageDir, name);
        const doc = readJsonRecord(fullPath);
        if (!doc || validatePassClaim(doc) !== null) continue;
        const claim = doc as unknown as PassClaim;
        if (passRecordPath(outboxDir, claim.repo, claim.stage, claim.tree) === fullPath) {
          out.push(JSON.stringify(claim));
        }
      }
    }
  }
  return out;
}

export function ingestPassClaims(input: {
  readonly storeDir: string;
  readonly host: string;
  readonly lines: ReadonlyArray<string>;
  readonly nowEpochSec: number;
}): number {
  let count = 0;
  for (const rawLine of input.lines) {
    const line = rawLine.trim();
    if (!line || line === "END" || line.length > PASS_MAX_LINE) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      continue;
    }
    if (validatePassClaim(parsed) !== null) continue;
    const claim = parsed as PassClaim;
    if (
      claim.at > input.nowEpochSec + PASS_SKEW_S ||
      input.nowEpochSec - claim.at > PASS_KEEP_DAYS * 86_400
    ) {
      continue;
    }
    if (writePassRecord(input.storeDir, toStoredPassRecord(claim, input.host), input.nowEpochSec)) {
      count += 1;
    }
  }
  return count;
}

export function findMatchingPassRecord(
  storeDir: string,
  query: FindPassQuery,
  nowEpochSec: number,
):
  | { readonly ok: true; readonly record: StoredPassRecord }
  | { readonly ok: false; readonly reason: string } {
  if (
    !NAME_RE.test(query.repo) ||
    query.repo === "." ||
    query.repo === ".." ||
    !STAGES.has(query.stage) ||
    !HEX_RE.test(query.tree)
  ) {
    return { ok: false, reason: "not a pass record's key" };
  }
  const filePath = passRecordPath(storeDir, query.repo, query.stage, query.tree);
  const raw = readJsonRecord(filePath);
  if (!raw) return { ok: false, reason: "no record of this tree" };
  const claimOnly: Record<string, unknown> = {};
  for (const key of CLAIM_KEYS) {
    if (key in raw) claimOnly[key] = raw[key];
  }
  if (
    validatePassClaim(claimOnly) !== null ||
    !isValidLineText(raw.host, 100) ||
    !NAME_RE.test(raw.host)
  ) {
    return { ok: false, reason: "the record of this tree cannot be read" };
  }
  const rec = raw as unknown as StoredPassRecord;
  if (rec.repo !== query.repo) return { ok: false, reason: "the record is of another repo" };
  if (rec.stage !== query.stage) return { ok: false, reason: "the record is of another stage" };
  if (rec.tree !== query.tree) return { ok: false, reason: "the record is of another tree" };
  if (rec.command !== query.command) {
    return { ok: false, reason: "the stage's declared step changed since the record" };
  }
  if (rec.context !== query.context) {
    return { ok: false, reason: "the base's step scripts or the PR body changed since the record" };
  }
  const wantExcludes = [...new Set(query.excludes)].toSorted();
  if (
    rec.excludes.length !== wantExcludes.length ||
    rec.excludes.some((v, idx) => v !== wantExcludes[idx])
  ) {
    return { ok: false, reason: "the declared excluded paths changed since the record" };
  }
  if (nowEpochSec - rec.at > PASS_KEEP_DAYS * 86_400) {
    return { ok: false, reason: `the record is older than ${PASS_KEEP_DAYS} days` };
  }
  return { ok: true, record: rec };
}
