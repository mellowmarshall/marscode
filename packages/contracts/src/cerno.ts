import * as Schema from "effect/Schema";

import { NonNegativeInt, PositiveInt, ThreadId } from "./baseSchemas.ts";

export const CernoRunState = Schema.Literals([
  "RUNNING",
  "SUCCEEDED",
  "FAILED",
  "NEEDS_INPUT",
  "STUCK_LOOP",
]);
export type CernoRunState = typeof CernoRunState.Type;

export const CernoRunOutcome = Schema.Literals(["IN_PROGRESS", "PASS", "FAIL"]);
export type CernoRunOutcome = typeof CernoRunOutcome.Type;

export const CernoResourceKill = Schema.Literals(["NORMAL", "OOM_KILLED", "DISK_FULL"]);
export type CernoResourceKill = typeof CernoResourceKill.Type;

export const CernoGitConflict = Schema.Literals(["NORMAL", "MERGE_CONFLICT", "REJECTED_OR_LOCK"]);
export type CernoGitConflict = typeof CernoGitConflict.Type;

const Probability = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 }));

export const CernoStateProbs = Schema.Struct({
  RUNNING: Probability,
  SUCCEEDED: Probability,
  FAILED: Probability,
  NEEDS_INPUT: Probability,
  STUCK_LOOP: Probability,
});
export type CernoStateProbs = typeof CernoStateProbs.Type;

export const CernoCutoffs = Schema.Struct({
  suspThresh: Probability,
  suspMargin: Schema.Number,
  confThresh: Probability,
  confMargin: Schema.Number,
});
export type CernoCutoffs = typeof CernoCutoffs.Type;

export const CernoLiveRun = Schema.Struct({
  schemaVersion: PositiveInt,
  pid: PositiveInt,
  childPid: NonNegativeInt,
  startedAtMs: NonNegativeInt,
  updatedAtMs: NonNegativeInt,
  elapsedSec: Schema.Number,
  mode: Schema.String,
  engine: Schema.String,
  cwd: Schema.String,
  command: Schema.String,
  logPath: Schema.NullOr(Schema.String),
  state: CernoRunState,
  confidence: Probability,
  margin: Schema.Number,
  stateProbs: CernoStateProbs,
  outcome: CernoRunOutcome,
  pFail: Probability,
  failMargin: Schema.Number,
  cutoffs: CernoCutoffs,
  prompt: Schema.Boolean,
  hangLoop: Schema.Boolean,
  serverReady: Schema.Boolean,
  authRequired: Schema.Boolean,
  resourceKill: CernoResourceKill,
  gitConflict: CernoGitConflict,
  wchan: Schema.String,
  cpuActive: Schema.Boolean,
  hasRemoteSocket: Schema.Boolean,
  hasListenSocket: Schema.Boolean,
  hasExtFileLock: Schema.Boolean,
  silenceSec: Schema.Number,
  stallTimeoutSec: Schema.Number,
  bytesStdout: NonNegativeInt,
  bytesStderr: NonNegativeInt,
  alert: Schema.NullOr(Schema.String),
  tail: Schema.String,
  logTail: Schema.optionalKey(Schema.String),
  threadId: Schema.optionalKey(ThreadId),
});
export type CernoLiveRun = typeof CernoLiveRun.Type;

export const CernoLiveRunsResult = Schema.Struct({
  sampledAt: NonNegativeInt,
  runs: Schema.Array(CernoLiveRun),
});
export type CernoLiveRunsResult = typeof CernoLiveRunsResult.Type;
