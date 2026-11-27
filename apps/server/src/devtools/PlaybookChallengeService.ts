/**
 * The server's declaration challenge: @t3tools/playbook's challenger on the real worktree,
 * reviewed by TextGeneration on the `playbook_challenge` role plan's models, in plan order.
 */
import type { ModelSelection, ProviderInstanceId } from "@t3tools/contracts";
import { repoBypasses } from "@t3tools/playbook/bypass";
import { PlaybookChallengeReply } from "@t3tools/playbook/challengeReply";
import {
  runChallenge,
  type ChallengeModel,
  type ChallengeOutcome,
} from "@t3tools/playbook/challenger";
import { repoName, repoRoot } from "@t3tools/playbook/git";
import { defaultPlaybookStateDir } from "@t3tools/playbook/statsStore";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as UsageLimitSources from "../usage/UsageLimitSources.ts";
import * as DevtoolsConfig from "./DevtoolsConfig.ts";

export interface ServerChallengeRequest {
  readonly repoDir: string;
  readonly exceptions: unknown;
  readonly base?: string | undefined;
  readonly tip?: string | undefined;
  readonly advisory?: boolean | undefined;
  readonly threadId?: string | undefined;
}

/** The model selection for one role-plan candidate (Codex names its effort option differently). */
export function candidateModelSelection(
  candidate: DevtoolsConfig.ResolvedModelCandidate,
): ModelSelection {
  return {
    instanceId: candidate.provider as ProviderInstanceId,
    model: candidate.model,
    options: [
      {
        id: candidate.provider === "codex" ? "reasoningEffort" : "effort",
        value: candidate.effort,
      },
    ],
  };
}

/** A ChallengeModel that tries each usable plan candidate in order through TEXTGENERATION. */
export function makeChallengeModel(
  textGeneration: TextGeneration.TextGeneration["Service"],
  plan: DevtoolsConfig.ResolvedRolePlan,
  timeoutMs: number,
): ChallengeModel {
  const candidates = plan.candidates.filter((c) => c.available);
  return async ({ cwd, prompt, signal }) => {
    const failures: string[] = [];
    for (const candidate of candidates) {
      if (signal?.aborted) throw new Error("the challenge was cancelled");
      const exit = await Effect.runPromiseExit(
        textGeneration.generatePlaybookChallenge({
          cwd,
          prompt,
          outputSchema: PlaybookChallengeReply,
          timeoutMs,
          modelSelection: candidateModelSelection(candidate),
        }),
        signal ? { signal } : undefined,
      );
      if (exit._tag === "Success") {
        return {
          reply: exit.value,
          reviewer: {
            model: candidate.model,
            provider: candidate.provider,
            effort: candidate.effort,
          },
          fallbackUsed: !candidate.isDefault,
        };
      }
      failures.push(`${candidate.provider}/${candidate.model}: ${String(exit.cause)}`);
    }
    throw new Error(
      failures.length > 0 ? failures.join("; ") : "no playbook_challenge candidate is available",
    );
  };
}

/** Resolve the role plan and clock now; the returned run is started (and aborted) by its caller. */
export const prepareServerChallenge = Effect.fn("PlaybookChallengeService.prepare")(function* (
  request: ServerChallengeRequest,
) {
  const textGeneration = yield* TextGeneration.TextGeneration;
  const providerRegistry = yield* Effect.serviceOption(ProviderRegistry.ProviderRegistry);
  const limitSourcesOpt = yield* Effect.serviceOption(UsageLimitSources.UsageLimitSources);
  const providers = Option.isSome(providerRegistry)
    ? yield* providerRegistry.value.getProviders.pipe(Effect.orElseSucceed(() => []))
    : [];
  const limitSources = Option.isSome(limitSourcesOpt)
    ? yield* limitSourcesOpt.value.current.pipe(Effect.orElseSucceed(() => []))
    : [];
  const config = DevtoolsConfig.readDevtoolsHostConfig();
  const plan = DevtoolsConfig.resolveReviewRolePlan("playbook_challenge", config, {
    providers,
    limitSources,
  });
  const root = repoRoot(request.repoDir);
  const now = DateTime.formatIso(yield* DateTime.now);
  const run = (signal: AbortSignal): Promise<ChallengeOutcome> =>
    runChallenge({
      root,
      repo: repoName(root),
      bypasses: repoBypasses(request.exceptions, repoName(root)),
      model: makeChallengeModel(textGeneration, plan, config.challenge_timeout_s * 1_000),
      now,
      stateDir: defaultPlaybookStateDir(),
      base: request.base,
      tip: request.tip,
      advisory: request.advisory,
      threadId: request.threadId,
      signal,
    }).then((outcome) => ({ ...outcome, prompt: null }));
  return { run, plan };
});
