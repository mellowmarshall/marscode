import * as Schema from "effect/Schema";

import { NonNegativeInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

const PlainWords = TrimmedNonEmptyString.check(Schema.isMaxLength(400));

/** One cleanup rule an agent proposes; the user accepts or rejects it in the Reaper UI. */
export const ReaperRuleProposalInput = Schema.Struct({
  path: TrimmedNonEmptyString.check(Schema.isMaxLength(512)).annotate({
    description: "Absolute directory whose old entries may be deleted, never a repo root.",
  }),
  maxAgeDays: Schema.Finite.check(Schema.isBetween({ minimum: 1, maximum: 3650 })).annotate({
    description: "Delete entries older than this many days (1-3650).",
  }),
  keepLatest: NonNegativeInt.check(Schema.isLessThanOrEqualTo(1000)).annotate({
    description: "Newest entries always kept.",
  }),
  deletes: PlainWords.annotate({ description: "For the user, in plain words: what it deletes." }),
  safeBecause: PlainWords.annotate({
    description: "For the user, in plain words: why that is safe (who owns it, how it comes back).",
  }),
  estimatedBytes: Schema.optionalKey(NonNegativeInt),
});
export type ReaperRuleProposalInput = typeof ReaperRuleProposalInput.Type;

export const ReaperRuleProposal = Schema.Struct({
  ...ReaperRuleProposalInput.fields,
  id: TrimmedNonEmptyString,
  host: Schema.String,
  threadId: Schema.optionalKey(ThreadId),
  proposedAt: Schema.String,
});
export type ReaperRuleProposal = typeof ReaperRuleProposal.Type;

export const ReaperProposeRulesInput = Schema.Struct({
  rules: Schema.Array(ReaperRuleProposalInput).check(Schema.isMinLength(1), Schema.isMaxLength(20)),
});
export type ReaperProposeRulesInput = typeof ReaperProposeRulesInput.Type;

export const ReaperProposeRulesResult = Schema.Struct({
  queued: Schema.Array(Schema.Struct({ id: Schema.String, path: Schema.String })),
  refused: Schema.Array(Schema.Struct({ path: Schema.String, reason: Schema.String })),
});
export type ReaperProposeRulesResult = typeof ReaperProposeRulesResult.Type;

export const ReaperProposalDecision = Schema.Struct({
  id: TrimmedNonEmptyString,
  decision: Schema.Literals(["accept", "reject"]),
});
export type ReaperProposalDecision = typeof ReaperProposalDecision.Type;

export const ReaperProposalList = Schema.Struct({
  proposals: Schema.Array(ReaperRuleProposal),
});
export type ReaperProposalList = typeof ReaperProposalList.Type;
