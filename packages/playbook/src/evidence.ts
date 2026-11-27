/**
 * Evidence-only validator (`playbook-evidence/v1`): checks schema, HEAD tree binding,
 * declared scoped exceptions, §3.1 named split seams, and §14 granular CI step timings.
 */
import { readReceiptCandidate, type EvidenceSourceInput } from "./evidenceSource.ts";
import { hasTrackedChanges, resolveCommit, resolveTree } from "./git.ts";
import { failed, passed, unproven, type CheckResult } from "./result.ts";
import { isRecord } from "./strictJson.ts";

export const EVIDENCE_SCHEMA = "playbook-evidence/v1";
export const DEFAULT_EVIDENCE_DIR = ".playbook/evidence";
const DEFAULT_GRANULAR_THRESHOLD_MS = 30_000;

const ISSUE_REF_RE = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?#[1-9][0-9]*$/;
const FILLER_REASON_RE = /^(?:needed|todo|tbd|fixme|ok|yes|temp|temporary|later|wip|n\/a)\.?$/i;
const GENERIC_SEAM_RE =
  /^(?:utils?|utilit(?:y|ies)|helpers?|misc(?:ellaneous)?|common|shared|stuff|other|general|split|extra|parts?\d*|chunks?\d*|lib|core)(?:\.[a-z0-9]+)?$/i;

export interface EvidenceSubstep {
  readonly name: string;
  readonly durationMs: number;
}

export interface EvidenceCheckItem {
  readonly name: string;
  readonly status: "pass" | "fail" | "unproven";
  readonly durationMs: number;
  readonly detail?: string | undefined;
  readonly substeps?: ReadonlyArray<EvidenceSubstep> | undefined;
}

export interface EvidenceException {
  readonly subject: string;
  readonly reason: string;
  readonly issue: string;
}

export interface EvidenceReceipt {
  readonly schema: typeof EVIDENCE_SCHEMA;
  readonly section: string;
  readonly status: "pass" | "fail" | "unproven";
  readonly tree: string;
  readonly jobId?: string | undefined;
  readonly generatedAt?: string | undefined;
  readonly summary?: string | undefined;
  readonly durationMs?: number | undefined;
  readonly checks: ReadonlyArray<EvidenceCheckItem>;
  readonly measurements?: Readonly<Record<string, unknown>> | undefined;
  readonly exceptions?: ReadonlyArray<EvidenceException> | undefined;
}

export type ValidateEvidenceInput = EvidenceSourceInput;

function declaredExceptionMap(
  settings: Readonly<Record<string, unknown>>,
): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  if (!Array.isArray(settings.exceptions)) return out;
  for (const item of settings.exceptions) {
    if (!isRecord(item) || typeof item.subject !== "string") continue;
    const subject = item.subject.trim();
    const issue = typeof item.issue === "string" ? item.issue.trim() : "";
    if (subject) out.set(subject, issue);
  }
  return out;
}

function validateExceptions(
  section: string,
  raw: unknown,
  declared: ReadonlyMap<string, string>,
  errors: string[],
): number {
  if (raw === undefined) return 0;
  if (!Array.isArray(raw)) {
    errors.push("exceptions must be an array (§1.3)");
    return 0;
  }
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    if (!isRecord(item)) {
      errors.push(`exceptions[${i}] must be an object {subject, reason, issue} (§1.3)`);
      continue;
    }
    const subject = typeof item.subject === "string" ? item.subject.trim() : "";
    const reason = typeof item.reason === "string" ? item.reason.trim() : "";
    const issue = typeof item.issue === "string" ? item.issue.trim() : "";
    if (!subject) errors.push(`exceptions[${i}].subject must be a non-empty string (§1.3)`);
    if (reason.length < 8 || FILLER_REASON_RE.test(reason)) {
      errors.push(`exceptions[${i}].reason must state a concrete technical reason (§1.3)`);
    }
    if (!ISSUE_REF_RE.test(issue)) {
      errors.push(`exceptions[${i}].issue '${issue}' must cite an issue #N (§1.3)`);
    }
    if (subject && !declared.has(subject)) {
      errors.push(
        `undeclared receipt exception '${subject}'; declare it in playbook.json under ${section}.exceptions (§1.3)`,
      );
    } else if (subject) {
      const declaredIssue = declared.get(subject);
      if (!declaredIssue) {
        errors.push(
          `declared exception '${subject}' in playbook.json is missing required issue #N (§1.3)`,
        );
      } else if (issue && issue !== declaredIssue) {
        errors.push(
          `receipt exception '${subject}' issue '${issue}' does not match declared '${declaredIssue}' (§1.3)`,
        );
      }
    }
  }
  return raw.length;
}

function isNonNegativeNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0;
}

function validateCiSpecifics(
  checks: ReadonlyArray<Record<string, unknown>>,
  measurements: Readonly<Record<string, unknown>> | null,
  settings: Readonly<Record<string, unknown>>,
  errors: string[],
): void {
  const thresholdMs =
    typeof settings.granularThresholdMs === "number" && settings.granularThresholdMs >= 1_000
      ? settings.granularThresholdMs
      : DEFAULT_GRANULAR_THRESHOLD_MS;

  for (const item of checks) {
    const name = typeof item.name === "string" ? item.name : "(unnamed)";
    const dur = item.durationMs;
    if (!isNonNegativeNumber(dur)) continue;
    if (dur > thresholdMs) {
      const substeps = item.substeps;
      if (!Array.isArray(substeps) || substeps.length < 2) {
        errors.push(
          `ci check '${name}' took ${Math.round(dur)}ms (> ${thresholdMs}ms) without granular substeps[] breakdown (>= 2 substeps required, §14.2/§14.3)`,
        );
        continue;
      }
      let sum = 0;
      let badSubstep = false;
      for (let j = 0; j < substeps.length; j++) {
        const sub = substeps[j];
        if (
          !isRecord(sub) ||
          typeof sub.name !== "string" ||
          !sub.name.trim() ||
          !isNonNegativeNumber(sub.durationMs)
        ) {
          errors.push(
            `ci check '${name}' substeps[${j}] must have non-empty name and non-negative durationMs (§14.2)`,
          );
          badSubstep = true;
          continue;
        }
        sum += sub.durationMs;
      }
      if (!badSubstep && sum < dur * 0.5) {
        errors.push(
          `ci check '${name}' substeps[] sum (${Math.round(sum)}ms) covers less than half of total durationMs (${Math.round(dur)}ms) (§14.2)`,
        );
      }
    }
  }

  if (!measurements) {
    errors.push(
      "ci evidence must include measurements {setupMs, testMs, selectedSuites, tier1Ms|tier2Ms|tier3Ms} (§14.2/§14.3)",
    );
    return;
  }
  if (!isNonNegativeNumber(measurements.setupMs)) {
    errors.push("ci evidence measurements.setupMs must be a non-negative number (§14.3)");
  }
  if (!isNonNegativeNumber(measurements.testMs)) {
    errors.push("ci evidence measurements.testMs must be a non-negative number (§14.3)");
  }
  if (
    !Array.isArray(measurements.selectedSuites) ||
    !measurements.selectedSuites.every((s) => typeof s === "string")
  ) {
    errors.push("ci evidence measurements.selectedSuites must be a string array (§14.3)");
  }
  const tierChecks: ReadonlyArray<readonly [string, string, number]> = [
    ["tier1Ms", "maxTier1Ms", 60_000],
    ["tier2Ms", "maxTier2Ms", 180_000],
    ["tier3Ms", "maxTier3Ms", 300_000],
  ];
  let sawTier = false;
  for (const [metricKey, limitKey, defaultLimit] of tierChecks) {
    const actual = measurements[metricKey];
    if (actual === undefined) continue;
    sawTier = true;
    const limit = typeof settings[limitKey] === "number" ? settings[limitKey] : defaultLimit;
    if (!isNonNegativeNumber(actual)) {
      errors.push(`ci evidence measurements.${metricKey} must be a non-negative number (§14.2)`);
    } else if (actual > limit) {
      errors.push(`ci ${metricKey} (${Math.round(actual)}ms) exceeds ceiling ${limit}ms (§14.2)`);
    }
  }
  if (!sawTier) {
    errors.push(
      "ci evidence measurements must record at least one tier duration (tier1Ms, tier2Ms, or tier3Ms) (§14.2)",
    );
  }
}

function validateSizeSpecifics(
  measurements: Readonly<Record<string, unknown>> | null,
  errors: string[],
): void {
  if (!measurements || measurements.splitFiles === undefined) return;
  if (!Array.isArray(measurements.splitFiles)) {
    errors.push("size evidence measurements.splitFiles must be an array of {file, seam} (§3.1)");
    return;
  }
  for (let i = 0; i < measurements.splitFiles.length; i++) {
    const entry = measurements.splitFiles[i];
    if (!isRecord(entry) || typeof entry.file !== "string" || !entry.file.trim()) {
      errors.push(
        `size evidence measurements.splitFiles[${i}].file must be a non-empty path (§3.1)`,
      );
      continue;
    }
    const seam = typeof entry.seam === "string" ? entry.seam.trim() : "";
    if (seam.length < 3 || FILLER_REASON_RE.test(seam) || GENERIC_SEAM_RE.test(seam)) {
      errors.push(
        `size evidence measurements.splitFiles[${i}] (${entry.file}) must name a concrete domain seam, never generic '${seam || "(empty)"}' (§3.1)`,
      );
    }
  }
}

/** Validate repo-emitted `playbook-evidence/v1` receipt for one declared section without executing repo code. */
export function validateSectionEvidence(input: ValidateEvidenceInput): CheckResult {
  const { root, section, settings } = input;
  const candidate = readReceiptCandidate(input);
  if (candidate.kind === "trust_error") {
    return unproven(section, candidate.detail, {
      files: [candidate.source],
      fix: "have CI / ship-queue write receipts to PLAYBOOK_EVIDENCE_DIR outside the worktree",
    });
  }
  if (candidate.kind === "missing") {
    return unproven(section, `missing playbook-evidence/v1 receipt at ${candidate.expected}`, {
      files: [candidate.expected],
      fix: `run the repo's own ${section} check to emit ${candidate.expected} (schema: "${EVIDENCE_SCHEMA}")`,
    });
  }
  if (candidate.kind === "parse_error") {
    return failed(section, `${candidate.source}: ${candidate.detail}`, {
      files: [candidate.source],
      fix: `emit valid ${EVIDENCE_SCHEMA} JSON for ${section}`,
    });
  }
  const raw = candidate.raw;
  if (!isRecord(raw)) {
    return failed(section, `${candidate.source}: receipt must be a JSON object`, {
      files: [candidate.source],
    });
  }

  const headTree = resolveTree(root, "HEAD");
  if (!headTree) {
    return unproven(section, "cannot resolve HEAD^{tree} to verify receipt freshness (§1.6)", {
      files: [candidate.source],
      fix: "commit the branch cleanly so HEAD^{tree} can be verified",
    });
  }
  if (hasTrackedChanges(root) !== false) {
    return unproven(
      section,
      "worktree has uncommitted tracked changes; commit and re-run checks to refresh evidence (§1.6)",
      {
        files: [candidate.source],
        fix: `commit tracked changes and regenerate ${candidate.source}`,
      },
    );
  }

  const errors: string[] = [];
  if (raw.schema !== EVIDENCE_SCHEMA) {
    errors.push(`schema must be '${EVIDENCE_SCHEMA}', got ${JSON.stringify(raw.schema ?? null)}`);
  }
  if (raw.section !== section) {
    errors.push(`section must be '${section}', got ${JSON.stringify(raw.section ?? null)}`);
  }

  const receiptTree = typeof raw.tree === "string" ? raw.tree.trim() : "";
  const headCommit = resolveCommit(root, "HEAD");
  if (!receiptTree) {
    errors.push("missing required 'tree' git hash binding evidence to HEAD (§1.6)");
  } else if (receiptTree !== headTree && receiptTree !== headCommit) {
    return unproven(
      section,
      `stale evidence: receipt tree ${receiptTree.slice(0, 12)} does not match HEAD tree ${headTree.slice(0, 12)}`,
      {
        files: [candidate.source],
        fix: `re-run the repo's ${section} check on the current tree`,
      },
    );
  }

  const expectedJob = (input.env ?? process.env).PLAYBOOK_EVIDENCE_JOB?.trim();
  if (expectedJob) {
    const receiptJob = typeof raw.jobId === "string" ? raw.jobId.trim() : "";
    if (receiptJob !== expectedJob) {
      return unproven(
        section,
        `receipt jobId '${receiptJob || "(missing)"}' does not match PLAYBOOK_EVIDENCE_JOB '${expectedJob}' (§1.6)`,
        {
          files: [candidate.source],
          fix: "regenerate evidence receipts inside the current ship-queue / CI job",
        },
      );
    }
  }

  const status = raw.status;
  if (status !== "pass" && status !== "fail" && status !== "unproven") {
    errors.push(
      `status must be 'pass', 'fail', or 'unproven', got ${JSON.stringify(status ?? null)}`,
    );
  }

  const checks: Array<Record<string, unknown>> = [];
  let sumCheckMs = 0;
  let maxCheckMs = 0;
  if (!Array.isArray(raw.checks) || raw.checks.length === 0) {
    errors.push("checks must be a non-empty array of timed check results (§1.6)");
  } else {
    for (let i = 0; i < raw.checks.length; i++) {
      const item = raw.checks[i];
      if (!isRecord(item)) {
        errors.push(`checks[${i}] must be an object {name, status, durationMs}`);
        continue;
      }
      checks.push(item);
      const name = typeof item.name === "string" ? item.name.trim() : "";
      if (!name) errors.push(`checks[${i}].name must be a non-empty string`);
      if (item.status !== "pass" && item.status !== "fail" && item.status !== "unproven") {
        errors.push(`checks[${i}].status must be 'pass', 'fail', or 'unproven'`);
      } else if (item.status === "fail") {
        const detail =
          typeof item.detail === "string" && item.detail.trim() ? `: ${item.detail.trim()}` : "";
        errors.push(`check '${name || i}' failed${detail}`);
      } else if (item.status === "unproven") {
        errors.push(`check '${name || i}' is unproven`);
      }
      if (!isNonNegativeNumber(item.durationMs)) {
        errors.push(`checks[${i}] ('${name || i}') must record non-negative durationMs`);
      } else {
        sumCheckMs += item.durationMs;
        if (item.durationMs > maxCheckMs) maxCheckMs = item.durationMs;
      }
    }
  }

  if (raw.durationMs === undefined) {
    if (section === "ci") {
      errors.push("ci evidence must record top-level durationMs (§14.2)");
    }
  } else if (!isNonNegativeNumber(raw.durationMs)) {
    errors.push("durationMs must be a non-negative number");
  } else if (raw.durationMs < maxCheckMs) {
    errors.push(
      `durationMs (${Math.round(raw.durationMs)}ms) is less than slowest check (${Math.round(maxCheckMs)}ms)`,
    );
  } else if (section === "ci") {
    const parallel =
      typeof settings.parallel === "number" && settings.parallel >= 1 ? settings.parallel : 1;
    const minParallelMs = Math.ceil(sumCheckMs / parallel);
    if (raw.durationMs < minParallelMs) {
      errors.push(
        `ci durationMs (${Math.round(raw.durationMs)}ms) is less than physical lower bound ${minParallelMs}ms for parallel=${parallel} (§14.2)`,
      );
    }
  }

  const declared = declaredExceptionMap(settings);
  const excCount = validateExceptions(section, raw.exceptions, declared, errors);
  const measurements = isRecord(raw.measurements) ? raw.measurements : null;
  if (section === "ci") validateCiSpecifics(checks, measurements, settings, errors);
  if (section === "size") validateSizeSpecifics(measurements, errors);

  if (status === "unproven" && errors.length === 0) {
    const why =
      typeof raw.summary === "string" && raw.summary.trim()
        ? raw.summary.trim()
        : "reported unproven";
    return unproven(section, why, { files: [candidate.source] });
  }
  if (status === "fail" && errors.length === 0) {
    const why =
      typeof raw.summary === "string" && raw.summary.trim() ? raw.summary.trim() : "reported fail";
    errors.push(why);
  }
  if (errors.length > 0) {
    return failed(section, errors[0]!, {
      errors,
      files: [candidate.source],
      fix: `fix the failing ${section} check and regenerate ${candidate.source}`,
    });
  }

  const totalMs = isNonNegativeNumber(raw.durationMs)
    ? Math.round(raw.durationMs)
    : Math.round(sumCheckMs);
  const excNote = excCount > 0 ? `, ${excCount} scoped exception(s)` : "";
  const extra =
    typeof raw.summary === "string" && raw.summary.trim() ? `: ${raw.summary.trim()}` : "";
  return passed(section, `${checks.length} check(s) passed in ${totalMs}ms${excNote}${extra}`);
}
