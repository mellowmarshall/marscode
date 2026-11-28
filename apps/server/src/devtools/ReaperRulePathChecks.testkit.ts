import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProcessRunner from "../processRunner.ts";
import { makeGitTracksFiles, type GitTracksFiles } from "./ReaperRulePathChecks.ts";

/** The production git check, on the real process runner, for tests outside an Effect layer. */
export const realGitTracksFiles = (): Promise<GitTracksFiles> =>
  Effect.runPromise(
    makeGitTracksFiles().pipe(
      Effect.provide(ProcessRunner.layer.pipe(Layer.provide(NodeServices.layer))),
    ),
  );

/** Git that never answers, as when it is missing or times out. */
export const gitCannotAnswer: GitTracksFiles = async () => null;
