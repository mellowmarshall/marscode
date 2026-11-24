import * as Schema from "effect/Schema";

import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const ShipQueueJob = Schema.Struct({
  id: Schema.String,
  key: Schema.optionalKey(Schema.String),
  repo: Schema.optionalKey(Schema.String),
  branch: Schema.optionalKey(Schema.String),
  title: Schema.optionalKey(Schema.String),
  state: Schema.String,
  displayState: Schema.optionalKey(Schema.String),
  stage: Schema.optionalKey(Schema.String),
  postMerge: Schema.optionalKey(Schema.Boolean),
  submittedAt: Schema.optionalKey(Schema.String),
  lastMarker: Schema.optionalKey(Schema.String),
  waiting: Schema.optionalKey(Schema.String),
  reason: Schema.optionalKey(Schema.String),
  pr: Schema.optionalKey(Schema.String),
  prRepo: Schema.optionalKey(Schema.String),
  prUrl: Schema.optionalKey(Schema.String),
  primary: Schema.optionalKey(Schema.String),
  worktree: Schema.optionalKey(Schema.String),
  threadId: Schema.optionalKey(Schema.String),
  reviewThreadId: Schema.optionalKey(Schema.String),
  ciDone: Schema.optionalKey(Schema.Boolean),
  pushExit: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  mergeExit: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  syncExit: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  watchers: Schema.optionalKey(Schema.Number),
  logBytes: Schema.optionalKey(Schema.Number),
  routeHost: Schema.optionalKey(Schema.String),
  routeLoad: Schema.optionalKey(Schema.String),
  routeLocal: Schema.optionalKey(Schema.Boolean),
  parkedFor: Schema.optionalKey(Schema.String),
  needsRootRequest: Schema.optionalKey(Schema.String),
  needsRootHosts: Schema.optionalKey(Schema.Array(Schema.String)),
});
export type ShipQueueJob = typeof ShipQueueJob.Type;

export const ShipQueueDepUpdate = Schema.Struct({
  packageFile: Schema.String,
  depName: Schema.String,
  currentValue: Schema.String,
  newValue: Schema.String,
  releaseTimestamp: Schema.NullOr(Schema.String),
});
export type ShipQueueDepUpdate = typeof ShipQueueDepUpdate.Type;

export const ShipQueueDepRepo = Schema.Struct({
  repo: Schema.String,
  reportId: Schema.NullOr(Schema.String),
  status: Schema.String,
  scannedAt: Schema.NullOr(Schema.Number),
  active: Schema.Boolean,
  holding: Schema.Boolean,
  pendingCount: NonNegativeInt,
  waitingCount: NonNegativeInt,
  heldCount: NonNegativeInt,
  failedCount: NonNegativeInt,
  attemptId: Schema.NullOr(Schema.String),
  attemptStatus: Schema.NullOr(Schema.String),
  decisionKind: Schema.NullOr(Schema.String),
  decisionUntil: Schema.NullOr(Schema.Number),
  error: Schema.NullOr(Schema.String),
  updates: Schema.Array(ShipQueueDepUpdate),
});
export type ShipQueueDepRepo = typeof ShipQueueDepRepo.Type;

export const ShipQueueSnapshot = Schema.Struct({
  available: Schema.Boolean,
  daemonRunning: Schema.Boolean,
  daemonPid: Schema.NullOr(Schema.Number),
  openCount: NonNegativeInt,
  totalCount: NonNegativeInt,
  jobs: Schema.Array(ShipQueueJob),
  deps: Schema.Array(ShipQueueDepRepo),
});
export type ShipQueueSnapshot = typeof ShipQueueSnapshot.Type;

export const ShipQueueSubscribeInput = Schema.Struct({});
export type ShipQueueSubscribeInput = typeof ShipQueueSubscribeInput.Type;

export const ShipQueueCancelInput = Schema.Struct({
  jobId: TrimmedNonEmptyString,
});
export type ShipQueueCancelInput = typeof ShipQueueCancelInput.Type;

export const ShipQueueDepDecision = Schema.Literals(["approve", "reject"]);
export type ShipQueueDepDecision = typeof ShipQueueDepDecision.Type;

export const ShipQueueDecideDepsInput = Schema.Struct({
  reportId: TrimmedNonEmptyString,
  decision: ShipQueueDepDecision,
  reason: Schema.optionalKey(Schema.String),
});
export type ShipQueueDecideDepsInput = typeof ShipQueueDecideDepsInput.Type;

export const ShipQueueScanDepsInput = Schema.Struct({
  repo: TrimmedNonEmptyString,
});
export type ShipQueueScanDepsInput = typeof ShipQueueScanDepsInput.Type;

export const ShipQueueActionResult = Schema.Struct({
  ok: Schema.Boolean,
  output: Schema.optionalKey(Schema.String),
  error: Schema.optionalKey(Schema.String),
  started: Schema.optionalKey(Schema.Boolean),
});
export type ShipQueueActionResult = typeof ShipQueueActionResult.Type;
