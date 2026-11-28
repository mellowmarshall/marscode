import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import { collectReviewRecords } from "@t3tools/playbook/statsStore";
import * as TextGenerationOperations from "@t3tools/provider-core/server/textGenerationOperations";
import * as NetService from "@t3tools/shared/Net";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/cli";
import { expect } from "vite-plus/test";

import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import { generateCommand, runGenerate } from "./generate.ts";

const PASS_REPLY = {
  acceptable: true,
  summary: "Branch respects all declared contracts.",
  bypass_detected: false,
  playbook_friction: false,
  rejected_rises: [],
  rises_accepted: false,
  defects: [],
};

const CHALLENGED_REPLY = {
  ...PASS_REPLY,
  acceptable: false,
  summary: "Critical defect found in auth middleware.",
  bypass_detected: true,
  defects: [
    { severity: "critical", file: "src/auth.ts", what: "Missing token expiry verification" },
    { severity: "low", file: "src/auth.ts", what: "Minor log wording nit" },
  ],
};

function makeTextGenLayer(
  reply: unknown,
  onCall?: (req: {
    model: string;
    provider: string;
    options?: ReadonlyArray<{ readonly id: string; readonly value: unknown }> | undefined;
  }) => void,
) {
  const service = TextGenerationOperations.fromRunner("MockGenerate", (request) => {
    onCall?.({
      model: request.modelSelection.model,
      provider: request.modelSelection.instanceId,
      options: request.modelSelection.options,
    });
    return TextGenerationOperations.decodeJsonReply(request, "MockGenerate", JSON.stringify(reply));
  });
  return Layer.succeed(TextGeneration.TextGeneration, service);
}

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, NetService.layer, TestConsole.layer))(
  "t3 generate CLI",
  (it) => {
    it.effect(
      "runs PlaybookChallengeReply generation and records verdict directly into ReviewStats",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const tmp = yield* fs.makeTempDirectoryScoped({ prefix: "t3-generate-test-" });
          const statsFile = path.join(tmp, "review-stats.jsonl");
          const calls: Array<{ model: string; provider: string }> = [];

          const result = yield* runGenerate({
            prompt: "Review this branch against PLAYBOOK.md.",
            cwd: tmp,
            provider: ProviderInstanceId.make("antigravity"),
            model: "gemini-3-pro",
            effort: "high",
            recordStats: true,
            statsFile,
            repo: "sample-repo",
            branch: "feat/test",
            commit: "abc1234",
            threadId: "thread-submit-1",
            source: "playbook_challenge",
          }).pipe(Effect.provide(makeTextGenLayer(CHALLENGED_REPLY, (c) => calls.push(c))));

          expect(result.ok).toBe(false);
          expect(result.verdict).toBe("CHALLENGED");
          expect(result.recorded).toBe(true);
          expect(result.statsPath).toBe(statsFile);
          expect(calls).toEqual([
            {
              provider: "antigravity",
              model: "gemini-3-pro",
              options: [{ id: "thinking_level", value: "high" }],
            },
          ]);

          const records = collectReviewRecords({
            jsonlPath: statsFile,
            playbookStateDir: tmp,
            shipJobsDir: tmp,
          });
          expect(records).toHaveLength(1);
          expect(records[0]).toMatchObject({
            source: "playbook_challenge",
            repo: "sample-repo",
            branch: "feat/test",
            commit: "abc1234",
            threadId: "thread-submit-1",
            verdict: "CHALLENGED",
            bypassDetected: true,
            counts: { critical: 1, low: 1, total: 2 },
          });
          expect(records[0]?.reviewer.model).toBe("gemini-3-pro");
        }),
    );

    it.effect("validates custom --output-schema and rejects schema violations", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tmp = yield* fs.makeTempDirectoryScoped({ prefix: "t3-generate-schema-" });
        const statsFile = path.join(tmp, "review-stats.jsonl");
        const schema = {
          type: "object",
          required: ["verdict", "score"],
          properties: {
            verdict: { type: "string", enum: ["PASS", "FAIL"] },
            score: { type: "integer", minimum: 0 },
          },
          additionalProperties: false,
        };

        const ok = yield* runGenerate({
          prompt: "Score this diff.",
          cwd: tmp,
          provider: "codex",
          model: "gpt-5.4",
          outputSchema: schema,
          recordStats: true,
          statsFile,
          repo: "sample-repo",
          source: "ship_queue_review",
        }).pipe(Effect.provide(makeTextGenLayer({ verdict: "PASS", score: 95 })));

        expect(ok.ok).toBe(true);
        expect(ok.verdict).toBe("PASS");
        expect(ok.output).toEqual({ verdict: "PASS", score: 95 });
        expect(ok.recorded).toBe(true);

        const bad = yield* runGenerate({
          prompt: "Score this diff.",
          cwd: tmp,
          provider: "codex",
          model: "gpt-5.4",
          outputSchema: schema,
          recordStats: false,
          source: "ship_queue_review",
        }).pipe(Effect.provide(makeTextGenLayer({ verdict: "MAYBE", score: -5 })), Effect.flip);

        expect(bad._tag).toBe("GenerateUsageError");
        expect(bad.message).toContain("--output-schema");
      }),
    );

    it.effect("invokes generateCommand via CLI flags and emits structured JSON", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tmp = yield* fs.makeTempDirectoryScoped({ prefix: "t3-generate-cli-" });
        const statsFile = path.join(tmp, "review-stats.jsonl");

        yield* Command.runWith(generateCommand, { version: "0.0.0" })([
          "--prompt",
          "Check contracts.",
          "--cwd",
          tmp,
          "--provider",
          "codex",
          "--model",
          "gpt-5.4",
          "--stats-file",
          statsFile,
          "--repo",
          "sample-repo",
          "--json",
        ]).pipe(Effect.provide(makeTextGenLayer(PASS_REPLY)));

        const lines = yield* TestConsole.logLines;
        const parsed = JSON.parse(String(lines.at(-1))) as {
          ok: boolean;
          verdict: string;
          recorded: boolean;
          provider: string;
          model: string;
        };
        expect(parsed).toMatchObject({
          ok: true,
          verdict: "PASS",
          recorded: true,
          provider: "codex",
          model: "gpt-5.4",
        });
      }),
    );

    it.effect(
      "rejects unsupported --output-schema keywords before calling TextGeneration, rejects invalid timeouts, and maps Antigravity effort to thinking_level",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const tmp = yield* fs.makeTempDirectoryScoped({ prefix: "t3-generate-hardening-" });
          const calls: Array<{
            model: string;
            provider: string;
            options?: ReadonlyArray<{ readonly id: string; readonly value: unknown }> | undefined;
          }> = [];

          // 1. Unsupported schema keyword fails as GenerateUsageError without invoking model
          const unsupported = yield* runGenerate({
            prompt: "Review.",
            cwd: tmp,
            provider: "codex",
            model: "gpt-5.4",
            outputSchema: {
              type: "object",
              properties: { value: { oneOf: [{ type: "string" }, { type: "number" }] } },
            },
            recordStats: false,
            source: "playbook_challenge",
          }).pipe(Effect.provide(makeTextGenLayer(PASS_REPLY, (c) => calls.push(c))), Effect.flip);
          expect(unsupported._tag).toBe("GenerateUsageError");
          expect(unsupported.message).toContain("Unsupported --output-schema");
          expect(calls).toEqual([]);

          // 2. Non-positive or non-finite timeouts fail as GenerateUsageError
          for (const badTimeout of [0, -1000, Number.NaN, Number.POSITIVE_INFINITY]) {
            const err = yield* runGenerate({
              prompt: "Review.",
              cwd: tmp,
              provider: "codex",
              model: "gpt-5.4",
              timeoutMs: badTimeout,
              recordStats: false,
              source: "playbook_challenge",
            }).pipe(
              Effect.provide(makeTextGenLayer(PASS_REPLY, (c) => calls.push(c))),
              Effect.flip,
            );
            expect(err._tag).toBe("GenerateUsageError");
            expect(err.message).toContain("Timeout");
          }
          expect(calls).toEqual([]);

          // 3. Antigravity effort maps to thinking_level option
          yield* runGenerate({
            prompt: "Review.",
            cwd: tmp,
            provider: "antigravity",
            model: "gemini-3-pro",
            effort: "high",
            recordStats: false,
            source: "playbook_challenge",
          }).pipe(Effect.provide(makeTextGenLayer(PASS_REPLY, (c) => calls.push(c))));
          expect(calls).toEqual([
            {
              provider: "antigravity",
              model: "gemini-3-pro",
              options: [{ id: "thinking_level", value: "high" }],
            },
          ]);
        }),
    );
  },
);
