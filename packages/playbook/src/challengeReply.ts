/**
 * The reviewer's reply to the declaration challenge, its verdict, and the
 * report the owner reads. The schema is the caller's output schema for the
 * server's `generatePlaybookChallenge` TextGeneration op and the decoder for a
 * headless `--response` file, so both paths judge one shape.
 */
import * as Schema from "effect/Schema";

import { extractJsonCandidates } from "./statsParse.ts";

const Defect = Schema.Struct({
  severity: Schema.String,
  file: Schema.optional(Schema.String),
  what: Schema.optional(Schema.String),
});

const RejectedRise = Schema.Struct({
  subject: Schema.String,
  why: Schema.optional(Schema.String),
});

export const PlaybookChallengeReply = Schema.Struct({
  acceptable: Schema.Boolean,
  summary: Schema.String,
  diagnosis: Schema.String,
  bypass_detected: Schema.Boolean,
  playbook_friction: Schema.Boolean,
  rejected_rises: Schema.Array(RejectedRise),
  rises_accepted: Schema.Boolean,
  defects: Schema.Array(Defect),
  analysis: Schema.String,
  recommendation: Schema.String,
});
export type PlaybookChallengeReply = typeof PlaybookChallengeReply.Type;

export const NO_RISES = "(none)";
const UNREADABLE_RISES = "(the budgets cannot be compared here: judge no rise as accepted)";
export const RISE_REFUSED = 3;

/** Severities that never block; `medium` is listed, anything else (or unknown) is severe. */
const MINOR_SEVERITIES = new Set(["low", "info", "nit", "minor"]);

export interface ChallengeDefect {
  /** Lower-cased; an empty or unrecognized severity reads as `unknown` and is severe. */
  readonly severity: string;
  readonly file: string;
  readonly what: string;
}

export interface ChallengeVerdict {
  readonly passed: boolean;
  readonly label: "PASS" | "CHALLENGED" | "REJECTED BUDGET REASON";
  readonly rejected: ReadonlyArray<{ readonly subject: string; readonly why: string }>;
  readonly defects: ReadonlyArray<ChallengeDefect>;
}

/** Rises the reviewer did not accept: with rises to judge, a pass needs none rejected AND rises_accepted. */
function rejectedRises(reply: PlaybookChallengeReply, rises: string) {
  if (rises === NO_RISES) return [];
  if (rises === UNREADABLE_RISES) {
    return [
      { subject: "(every rise)", why: "the budgets could not be compared, so no rise is judged" },
    ];
  }
  const rejected = reply.rejected_rises.map((r) => ({
    subject: r.subject.trim() || "(unnamed)",
    why: (r.why ?? "").trim(),
  }));
  if (rejected.length === 0 && !reply.rises_accepted) {
    return [{ subject: "(every rise)", why: "the reviewer did not accept the rises: no verdict" }];
  }
  return rejected;
}

export function judgeChallengeReply(
  reply: PlaybookChallengeReply,
  rises: string,
): ChallengeVerdict {
  const rejected = rejectedRises(reply, rises);
  const defects = reply.defects
    .map((d) => ({
      severity: d.severity.trim().toLowerCase() || "unknown",
      file: (d.file ?? "").trim(),
      what: (d.what ?? "").trim(),
    }))
    .filter((d) => !MINOR_SEVERITIES.has(d.severity));
  // Friction is a report on the playbook, never on the change. Fail closed: every listed defect
  // but a medium one (breaking, critical, high, or a severity the engine does not know) challenges.
  const severe = defects.some((d) => d.severity !== "medium");
  const passed = reply.acceptable && !reply.bypass_detected && rejected.length === 0 && !severe;
  return {
    passed,
    label: passed ? "PASS" : rejected.length > 0 ? "REJECTED BUDGET REASON" : "CHALLENGED",
    rejected,
    defects,
  };
}

const decodeReply = Schema.decodeUnknownOption(PlaybookChallengeReply);

/** The last JSON object in TEXT that decodes as a reply (models wrap JSON in prose), or null. */
export function decodeChallengeReplyText(text: string): PlaybookChallengeReply | null {
  for (const candidate of extractJsonCandidates(text).toReversed()) {
    const decoded = decodeReply(candidate);
    if (decoded._tag === "Some") return decoded.value;
  }
  return null;
}

export interface ChallengeMeta {
  readonly repo: string;
  readonly branch: string;
  readonly pass: number;
  readonly commit: string;
  readonly base: string;
  readonly reviewer: string;
  readonly timestamp: string;
}

/** The outcome as the owner reads it (a PR comment, the job log): pass or not, in full. */
export function renderChallengeReport(
  meta: ChallengeMeta,
  reply: PlaybookChallengeReply,
  verdict: ChallengeVerdict,
  rises: string,
): string {
  const rule = "=".repeat(80);
  const lines = [
    rule,
    `PLAYBOOK REVIEW: ${verdict.label}`,
    `Repo:           ${meta.repo}`,
    `Branch:         ${meta.branch}`,
    `Pass:           ${meta.pass}`,
    `Commit:         ${meta.commit.slice(0, 12)}`,
    `Base:           ${meta.base.slice(0, 12)}`,
    `Reviewer:       ${meta.reviewer}`,
    `Timestamp:      ${meta.timestamp}`,
    `Bypass Flagged: ${reply.bypass_detected ? "YES" : "No"}`,
    `Rule Friction:  ${reply.playbook_friction ? "YES" : "No"}`,
    rule,
    `Summary:\n  ${reply.summary}`,
    "",
    `Diagnosis:\n  ${reply.diagnosis}`,
  ];
  if (reply.analysis) lines.push("", `Analysis:\n${reply.analysis}`);
  if (rises !== NO_RISES) lines.push("", `Budget rises and their reasons:\n${rises}`);
  if (verdict.rejected.length > 0) {
    lines.push("", "Rejected reasons:", ...verdict.rejected.map((r) => `- ${r.subject}: ${r.why}`));
  }
  if (verdict.defects.length > 0) {
    lines.push(
      "",
      "Defects:",
      ...verdict.defects.map((d) => `- ${d.severity}: ${d.file}: ${d.what}`),
    );
  }
  if (reply.recommendation) lines.push("", `Recommendation:\n  ${reply.recommendation}`);
  lines.push(rule);
  return lines.join("\n");
}
