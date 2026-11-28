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

const Violation = Schema.Struct({
  section: Schema.String,
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
  bypass_detected: Schema.Boolean,
  playbook_friction: Schema.Boolean,
  violations: Schema.optional(Schema.Array(Violation)),
  rejected_rises: Schema.Array(RejectedRise),
  rises_accepted: Schema.Boolean,
  defects: Schema.Array(Defect),
});
export type PlaybookChallengeReply = typeof PlaybookChallengeReply.Type;

export const PLAYBOOK_CHALLENGE_JSON_SCHEMA = {
  type: "object",
  properties: {
    acceptable: { type: "boolean" },
    summary: { type: "string" },
    bypass_detected: { type: "boolean" },
    playbook_friction: { type: "boolean" },
    violations: {
      type: "array",
      items: {
        type: "object",
        properties: {
          section: { type: "string" },
          file: { type: "string" },
          what: { type: "string" },
        },
        required: ["section", "file", "what"],
        additionalProperties: false,
      },
    },
    rejected_rises: {
      type: "array",
      items: {
        type: "object",
        properties: {
          subject: { type: "string" },
          why: { type: "string" },
        },
        required: ["subject", "why"],
        additionalProperties: false,
      },
    },
    rises_accepted: { type: "boolean" },
    defects: {
      type: "array",
      items: {
        type: "object",
        properties: {
          severity: { type: "string", enum: ["breaking", "critical", "high"] },
          file: { type: "string" },
          what: { type: "string" },
        },
        required: ["severity", "file", "what"],
        additionalProperties: false,
      },
    },
  },
  required: [
    "acceptable",
    "summary",
    "bypass_detected",
    "playbook_friction",
    "violations",
    "rejected_rises",
    "rises_accepted",
    "defects",
  ],
  additionalProperties: false,
} as const;

export const NO_RISES = "(none)";
const UNREADABLE_RISES = "(the budgets cannot be compared here: judge no rise as accepted)";
export const RISE_REFUSED = 3;

/** Severities ignored by the challenger: only breaking, critical, high (or unknown, fail-closed) challenge. */
const IGNORED_SEVERITIES = new Set(["medium", "low", "info", "nit", "minor"]);

export interface ChallengeDefect {
  /** Lower-cased; an empty or unrecognized severity reads as `unknown` and is severe. */
  readonly severity: string;
  readonly file: string;
  readonly what: string;
}

export interface ChallengeViolation {
  readonly section: string;
  readonly file: string;
  readonly what: string;
}

export interface ChallengeVerdict {
  readonly passed: boolean;
  readonly label: "PASS" | "CHALLENGED" | "REJECTED BUDGET REASON";
  readonly rejected: ReadonlyArray<{ readonly subject: string; readonly why: string }>;
  readonly violations: ReadonlyArray<ChallengeViolation>;
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
  const violations = (reply.violations ?? [])
    .map((v) => ({
      section: v.section.trim() || "PLAYBOOK.md",
      file: (v.file ?? "").trim(),
      what: (v.what ?? "").trim(),
    }))
    .filter((v) => v.section.length > 0 || v.what.length > 0);
  const defects = reply.defects
    .map((d) => ({
      severity: d.severity.trim().toLowerCase() || "unknown",
      file: (d.file ?? "").trim(),
      what: (d.what ?? "").trim(),
    }))
    .filter((d) => !IGNORED_SEVERITIES.has(d.severity));
  // Friction is a report on the playbook, never on the change. Fail closed: any applicable
  // playbook violation or severe production-path defect (breaking, critical, high) challenges (§2.2).
  const severe = defects.length > 0;
  const passed =
    reply.acceptable &&
    !reply.bypass_detected &&
    violations.length === 0 &&
    rejected.length === 0 &&
    !severe;
  return {
    passed,
    label: passed ? "PASS" : rejected.length > 0 ? "REJECTED BUDGET REASON" : "CHALLENGED",
    rejected,
    violations,
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

/** Compact outcome report for the agent, job log, and PR comment (metadata stays in the JSON record). */
export function renderChallengeReport(
  _meta: ChallengeMeta,
  reply: PlaybookChallengeReply,
  verdict: ChallengeVerdict,
  _rises: string,
): string {
  const lines = [`PLAYBOOK REVIEW: ${verdict.label}`];
  const summary = reply.summary.trim();
  if (summary) lines.push(`Summary: ${summary}`);
  if (verdict.rejected.length > 0) {
    lines.push("", "Rejected reasons:", ...verdict.rejected.map((r) => `- ${r.subject}: ${r.why}`));
  }
  if (verdict.violations.length > 0) {
    lines.push(
      "",
      "Playbook violations:",
      ...verdict.violations.map((v) => `- ${v.section}${v.file ? ` (${v.file})` : ""}: ${v.what}`),
    );
  }
  if (verdict.defects.length > 0) {
    lines.push(
      "",
      "Defects:",
      ...verdict.defects.map((d) => `- ${d.severity}: ${d.file}: ${d.what}`),
    );
  }
  return lines.join("\n");
}
