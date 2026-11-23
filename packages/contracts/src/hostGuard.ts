import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const PendingHostGuardRequest = Schema.Struct({
  requestId: TrimmedNonEmptyString,
  guard: TrimmedNonEmptyString,
  command: Schema.Array(Schema.String),
  argvSha256: TrimmedNonEmptyString,
  cwd: Schema.String,
  refusal: Schema.String,
  proposedReason: Schema.String,
  threadId: Schema.String,
  session: Schema.String,
  pid: NonNegativeInt,
  createdAt: IsoDateTime,
  expiresAt: IsoDateTime,
});
export type PendingHostGuardRequest = typeof PendingHostGuardRequest.Type;

export const HostGuardState = Schema.Struct({
  listening: Schema.Boolean,
  pending: Schema.Array(PendingHostGuardRequest),
});
export type HostGuardState = typeof HostGuardState.Type;

export const HostGuardDecision = Schema.Literals(["approve", "deny"]);
export type HostGuardDecision = typeof HostGuardDecision.Type;

export const HostGuardSubscribeInput = Schema.Struct({});
export type HostGuardSubscribeInput = typeof HostGuardSubscribeInput.Type;

export const HostGuardResolveInput = Schema.Struct({
  requestId: TrimmedNonEmptyString,
  decision: HostGuardDecision,
  reason: Schema.optionalKey(Schema.String),
});
export type HostGuardResolveInput = typeof HostGuardResolveInput.Type;

export const HostGuardResolveResult = Schema.Struct({
  resolved: Schema.Boolean,
  grantId: Schema.optionalKey(TrimmedNonEmptyString),
});
export type HostGuardResolveResult = typeof HostGuardResolveResult.Type;
