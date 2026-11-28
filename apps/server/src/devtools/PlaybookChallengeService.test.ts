import { TextGenerationError, type ModelSelection } from "@t3tools/contracts";
import type { PlaybookChallengeReply } from "@t3tools/playbook/challengeReply";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import type * as TextGeneration from "../textGeneration/TextGeneration.ts";
import { DEFAULT_DEVTOOLS_HOST_CONFIG, resolveReviewRolePlan } from "./DevtoolsConfig.ts";
import { candidateModelSelection, makeChallengeModel } from "./PlaybookChallengeService.ts";

const REPLY: PlaybookChallengeReply = {
  acceptable: true,
  summary: "Meets the standards",
  bypass_detected: false,
  playbook_friction: false,
  rejected_rises: [],
  rises_accepted: false,
  defects: [],
};

const unused = () => Effect.die("unused");

function fakeTextGeneration(failFor: ReadonlySet<string>) {
  const calls: Array<{ selection: ModelSelection; cwd: string; timeoutMs: number | undefined }> =
    [];
  const service = {
    generateCommitMessage: unused,
    generatePrContent: unused,
    generateBranchName: unused,
    generateThreadTitle: unused,
    generateReviewGuide: unused,
    generateTranscriptionPostProcessing: unused,
    generatePlaybookChallenge: (input) => {
      calls.push({ selection: input.modelSelection, cwd: input.cwd, timeoutMs: input.timeoutMs });
      return failFor.has(input.modelSelection.instanceId)
        ? Effect.fail(
            new TextGenerationError({
              operation: "generatePlaybookChallenge",
              detail: "exhausted",
            }),
          )
        : Effect.succeed(REPLY as never);
    },
  } satisfies TextGeneration.TextGeneration["Service"];
  return { calls, service };
}

const config = {
  ...DEFAULT_DEVTOOLS_HOST_CONFIG,
  playbook_challenge: {
    default: { provider: "codex", model: "gpt-6-astra", effort: "medium" as const },
    fallbacks: [
      { provider: "claudeAgent", model: "claude-opus-5-5", effort: "high" as const },
      { provider: "grok", model: "grok-4.7", effort: "high" as const },
    ],
    min_remaining_pct: 10,
  },
};

describe("PlaybookChallengeService", () => {
  it("names each driver's effort option in the model selection", () => {
    const plan = resolveReviewRolePlan("playbook_challenge", config, {
      availability: { codex: true, claudeAgent: true, grok: true },
    });
    expect(candidateModelSelection(plan.candidates[0]!)).toEqual({
      instanceId: "codex",
      model: "gpt-6-astra",
      options: [{ id: "reasoningEffort", value: "medium" }],
    });
    expect(candidateModelSelection(plan.candidates[1]!).options).toEqual([
      { id: "effort", value: "high" },
    ]);
  });

  it("asks TextGeneration on the real checkout and falls back down the role plan", async () => {
    const plan = resolveReviewRolePlan("playbook_challenge", config, {
      availability: { codex: true, claudeAgent: true, grok: false },
    });
    const { calls, service } = fakeTextGeneration(new Set(["codex"]));
    const model = makeChallengeModel(service, plan, 900_000);
    const answer = await model({ cwd: "/data/Dev/sample-repo", prompt: "judge it" });
    expect(answer).toEqual({
      reply: REPLY,
      reviewer: { model: "claude-opus-5-5", provider: "claudeAgent", effort: "high" },
      fallbackUsed: true,
    });
    expect(calls.map((c) => c.selection.instanceId)).toEqual(["codex", "claudeAgent"]);
    expect(calls.every((c) => c.cwd === "/data/Dev/sample-repo" && c.timeoutMs === 900_000)).toBe(
      true,
    );
  });

  it("gives no answer when every available candidate fails", async () => {
    const plan = resolveReviewRolePlan("playbook_challenge", config, {
      availability: { codex: true, claudeAgent: false, grok: false },
    });
    const { service } = fakeTextGeneration(new Set(["codex"]));
    await expect(
      makeChallengeModel(service, plan, 1_000)({ cwd: "/x", prompt: "p" }),
    ).rejects.toThrow(/codex\/gpt-6-astra/);
  });
});
