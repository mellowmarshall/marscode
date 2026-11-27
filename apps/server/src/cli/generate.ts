/**
 * `t3 generate`: headless structured generation CLI over MarsCode's native `TextGeneration`
 * (`generatePlaybookChallenge` / structured JSON schema validation) with direct verdict
 * recording into ReviewStats (`@t3tools/playbook/statsStore`).
 */
import type { ServerProvider } from "@t3tools/contracts";
import {
  judgeChallengeReply,
  NO_RISES,
  PlaybookChallengeReply,
} from "@t3tools/playbook/challengeReply";
import {
  assertSupportedSchema,
  SchemaKeywordError,
  validateAgainstSchema,
} from "@t3tools/playbook/declarationSchema";
import * as Clock from "effect/Clock";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import { Command, Flag, GlobalFlag } from "effect/cli";

import * as ServerConfig from "../config.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import { projectLocationFlags, resolveCliAuthConfig } from "./config.ts";
import {
  countDefectSeverities,
  emptySeverityCounts,
  recordGenerateStats,
  resolveGenerateModelSelection,
} from "./generateStats.ts";

const StructuredRecordSchema = Schema.Record(Schema.String, Schema.Unknown);
const decodeJsonUnknown = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));
const encodeJsonPretty = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown, { space: 2 }));
const isSchemaKeywordError = Schema.is(SchemaKeywordError);

export class GenerateUsageError extends Schema.TaggedError<GenerateUsageError>()(
  "GenerateUsageError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

export interface RunGenerateInput {
  readonly prompt: string;
  readonly cwd: string;
  readonly provider?: string | undefined;
  readonly model?: string | undefined;
  readonly effort?: string | undefined;
  readonly outputSchema?: Readonly<Record<string, unknown>> | undefined;
  readonly timeoutMs?: number | undefined;
  readonly recordStats: boolean;
  readonly statsFile?: string | undefined;
  readonly repo?: string | undefined;
  readonly branch?: string | undefined;
  readonly commit?: string | undefined;
  readonly threadId?: string | undefined;
  readonly source: "playbook_challenge" | "ship_queue_review";
  readonly submitterModel?: string | undefined;
  readonly submitterProvider?: string | undefined;
  readonly submitterEffort?: string | undefined;
  readonly providers?: ReadonlyArray<ServerProvider> | undefined;
}

export interface RunGenerateResult {
  readonly ok: boolean;
  readonly verdict: string;
  readonly provider: string;
  readonly model: string;
  readonly effort: string;
  readonly output: unknown;
  readonly statsPath: string | null;
  readonly recorded: boolean;
  readonly durationS: number;
}

/** Run headless structured generation through `TextGeneration` and optionally log to ReviewStats. */
export const runGenerate = Effect.fn("cli.generate.run")(function* (input: RunGenerateInput) {
  const prompt = input.prompt.trim();
  if (!prompt) {
    return yield* new GenerateUsageError({
      detail: "Prompt is empty. Pass --prompt <text>, --prompt-file <path>, or pipe stdin.",
    });
  }
  const textGeneration = yield* TextGeneration.TextGeneration;
  const path = yield* Path.Path;
  const cwd = path.resolve(input.cwd);
  const chosen = resolveGenerateModelSelection({
    provider: input.provider,
    model: input.model,
    effort: input.effort,
    providers: input.providers,
  });
  const timeoutMs = input.timeoutMs ?? chosen.defaultTimeoutMs;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return yield* new GenerateUsageError({
      detail: "Timeout must be a positive finite number.",
    });
  }
  if (input.outputSchema) {
    yield* Effect.try({
      try: () => assertSupportedSchema(input.outputSchema!),
      catch: (cause) =>
        new GenerateUsageError({
          detail: isSchemaKeywordError(cause)
            ? `Unsupported --output-schema: ${cause.message}`
            : `Invalid --output-schema: ${cause instanceof Error ? cause.message : String(cause)}`,
        }),
    });
  }
  const startedMs = yield* Clock.currentTimeMillis;

  let output: unknown;
  let ok = true;
  let verdict = "PASS";
  let counts = emptySeverityCounts();
  let bypassDetected = false;
  let playbookFriction = false;
  let rejectedRisesCount = 0;

  if (input.outputSchema) {
    const raw = yield* textGeneration.generatePlaybookChallenge({
      cwd,
      prompt,
      outputSchema: StructuredRecordSchema,
      modelSelection: chosen.modelSelection,
      timeoutMs,
    });
    const schemaErrors = yield* Effect.try({
      try: () => validateAgainstSchema(raw, input.outputSchema!),
      catch: (cause) =>
        new GenerateUsageError({
          detail: isSchemaKeywordError(cause)
            ? `Unsupported --output-schema: ${cause.message}`
            : `Failed --output-schema validation: ${cause instanceof Error ? cause.message : String(cause)}`,
        }),
    });
    if (schemaErrors.length > 0) {
      return yield* new GenerateUsageError({
        detail: `Generated output failed --output-schema validation: ${schemaErrors.slice(0, 5).join("; ")}`,
      });
    }
    output = raw;
    if (typeof raw.verdict === "string" && raw.verdict.trim()) {
      verdict = raw.verdict.trim().toUpperCase();
      ok = verdict === "PASS";
    } else if (typeof raw.acceptable === "boolean") {
      ok = raw.acceptable;
      verdict = raw.acceptable ? "PASS" : "FAIL";
    }
  } else {
    const reply = yield* textGeneration.generatePlaybookChallenge({
      cwd,
      prompt,
      outputSchema: PlaybookChallengeReply,
      modelSelection: chosen.modelSelection,
      timeoutMs,
    });
    const judged = judgeChallengeReply(reply, NO_RISES);
    output = reply;
    ok = judged.passed;
    verdict = judged.label;
    counts = countDefectSeverities(reply.defects);
    bypassDetected = reply.bypass_detected;
    playbookFriction = reply.playbook_friction;
    rejectedRisesCount = judged.rejected.length;
  }

  const finishedMs = yield* Clock.currentTimeMillis;
  const durationS = Math.max(0, Math.round((finishedMs - startedMs) / 100) / 10);
  const timestamp = DateTime.formatIso(yield* DateTime.now);

  let statsPath: string | null = null;
  let recorded = false;
  if (input.recordStats) {
    const saved = recordGenerateStats({
      cwd,
      fallbackRepoName: path.basename(cwd),
      repo: input.repo,
      branch: input.branch,
      commit: input.commit,
      threadId: input.threadId,
      source: input.source,
      timestamp,
      verdict,
      provider: chosen.provider,
      model: chosen.model,
      effort: chosen.effort,
      fallbackUsed: chosen.fallbackUsed,
      durationS,
      counts,
      bypassDetected,
      playbookFriction,
      rejectedRisesCount,
      submitterModel: input.submitterModel,
      submitterProvider: input.submitterProvider,
      submitterEffort: input.submitterEffort,
      statsFile: input.statsFile,
    });
    statsPath = saved.statsPath;
    recorded = saved.recorded;
  }

  return {
    ok,
    verdict,
    provider: chosen.provider,
    model: chosen.model,
    effort: chosen.effort,
    output,
    statsPath,
    recorded,
    durationS,
  } satisfies RunGenerateResult;
});

const readStdinText = Effect.fn("cli.generate.readStdin")(function* () {
  const stdio = yield* Stdio.Stdio;
  const chunks: Array<string> = [];
  yield* stdio.stdin.pipe(
    Stream.decodeText(),
    Stream.runForEach((chunk) =>
      Effect.sync(() => {
        chunks.push(chunk);
      }),
    ),
  );
  return chunks.join("");
});

const loadOutputSchema = Effect.fn("cli.generate.loadOutputSchema")(function* (raw: string) {
  const trimmed = raw.trim();
  let jsonText = trimmed;
  if (!trimmed.startsWith("{")) {
    const fs = yield* FileSystem.FileSystem;
    jsonText = yield* fs
      .readFileString(trimmed)
      .pipe(
        Effect.mapError(
          () =>
            new GenerateUsageError({ detail: `Cannot read --output-schema file '${trimmed}'.` }),
        ),
      );
  }
  const parsed = yield* decodeJsonUnknown(jsonText).pipe(
    Effect.mapError(() => new GenerateUsageError({ detail: "Invalid JSON in --output-schema." })),
  );
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return yield* new GenerateUsageError({ detail: "--output-schema must be a JSON object." });
  }
  const schemaObj = parsed as Readonly<Record<string, unknown>>;
  yield* Effect.try({
    try: () => assertSupportedSchema(schemaObj),
    catch: (cause) =>
      new GenerateUsageError({
        detail: isSchemaKeywordError(cause)
          ? `Unsupported --output-schema: ${cause.message}`
          : `Invalid --output-schema: ${cause instanceof Error ? cause.message : String(cause)}`,
      }),
  });
  return schemaObj;
});

export const generateCommand = Command.make("generate", {
  ...projectLocationFlags,
  prompt: Flag.String("prompt").pipe(
    Flag.withDescription("Prompt text to send, or '-' to read stdin."),
    Flag.optional,
  ),
  promptFile: Flag.String("prompt-file").pipe(
    Flag.withDescription("Read the prompt text from a file."),
    Flag.optional,
  ),
  cwd: Flag.String("cwd").pipe(
    Flag.withDescription("Repository checkout directory for read-only investigation."),
    Flag.withDefault("."),
  ),
  provider: Flag.String("provider").pipe(
    Flag.withDescription("Provider instance id (for example codex, claudeAgent, antigravity)."),
    Flag.optional,
  ),
  model: Flag.String("model").pipe(Flag.withDescription("Model slug to invoke."), Flag.optional),
  effort: Flag.String("effort").pipe(
    Flag.withDescription("Reasoning/effort level (for example low, medium, high, xhigh)."),
    Flag.optional,
  ),
  outputSchema: Flag.String("output-schema").pipe(
    Flag.withDescription(
      "Optional JSON Schema file path or inline JSON object; defaults to PlaybookChallengeReply.",
    ),
    Flag.optional,
  ),
  timeout: Flag.Int("timeout").pipe(Flag.withDescription("Timeout in seconds."), Flag.optional),
  recordStats: Flag.Boolean("record-stats").pipe(
    Flag.withDescription("Record the verdict into ReviewStats JSONL (default true)."),
    Flag.withDefault(true),
  ),
  statsFile: Flag.String("stats-file").pipe(
    Flag.withDescription("Explicit ReviewStats JSONL file path."),
    Flag.optional,
  ),
  repo: Flag.String("repo").pipe(
    Flag.withDescription("Repository name override for ReviewStats."),
    Flag.optional,
  ),
  branch: Flag.String("branch").pipe(
    Flag.withDescription("Branch name override for ReviewStats."),
    Flag.optional,
  ),
  commit: Flag.String("commit").pipe(
    Flag.withDescription("Commit SHA override for ReviewStats."),
    Flag.optional,
  ),
  threadId: Flag.String("thread-id").pipe(
    Flag.withDescription("Originating thread ID for ReviewStats correlation."),
    Flag.optional,
  ),
  source: Flag.Literals("source", ["playbook_challenge", "ship_queue_review"] as const).pipe(
    Flag.withDescription("ReviewStats source label."),
    Flag.withDefault("playbook_challenge" as const),
  ),
  json: Flag.Boolean("json").pipe(
    Flag.withDescription("Emit full structured result envelope as JSON."),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription(
    "Run headless structured generation through T3 TextGeneration and record verdicts in ReviewStats.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const promptFileOpt = flags.promptFile;
      const promptText = Option.isSome(promptFileOpt)
        ? yield* fs.readFileString(promptFileOpt.value).pipe(
            Effect.mapError(
              () =>
                new GenerateUsageError({
                  detail: `Cannot read --prompt-file '${promptFileOpt.value}'.`,
                }),
            ),
          )
        : Option.isSome(flags.prompt) && flags.prompt.value !== "-"
          ? flags.prompt.value
          : yield* readStdinText();
      const outputSchema = Option.isSome(flags.outputSchema)
        ? yield* loadOutputSchema(flags.outputSchema.value)
        : undefined;
      if (
        Option.isSome(flags.timeout) &&
        (!Number.isFinite(flags.timeout.value) || flags.timeout.value <= 0)
      ) {
        return yield* new GenerateUsageError({
          detail: "--timeout must be a positive integer number of seconds.",
        });
      }

      const existing = yield* Effect.serviceOption(TextGeneration.TextGeneration);
      const execute = Effect.fn("cli.generate.execute")(function* (
        providers?: ReadonlyArray<ServerProvider>,
      ) {
        const result = yield* runGenerate({
          prompt: promptText,
          cwd: flags.cwd,
          provider: Option.getOrUndefined(flags.provider),
          model: Option.getOrUndefined(flags.model),
          effort: Option.getOrUndefined(flags.effort),
          outputSchema,
          timeoutMs: Option.isSome(flags.timeout) ? flags.timeout.value * 1_000 : undefined,
          recordStats: flags.recordStats,
          statsFile: Option.getOrUndefined(flags.statsFile),
          repo: Option.getOrUndefined(flags.repo),
          branch: Option.getOrUndefined(flags.branch),
          commit: Option.getOrUndefined(flags.commit),
          threadId: Option.getOrUndefined(flags.threadId),
          source: flags.source,
          providers,
        });
        yield* Console.log(encodeJsonPretty(flags.json ? result : result.output));
      });

      if (Option.isSome(existing)) {
        return yield* execute().pipe(
          Effect.provideService(TextGeneration.TextGeneration, existing.value),
        );
      }

      const cliLogLevel = yield* GlobalFlag.LogLevel;
      const resolvedConfig = yield* resolveCliAuthConfig(flags, cliLogLevel, { quietLogs: true });
      const configLayer = Layer.succeed(ServerConfig.ServerConfig, resolvedConfig);
      const runtimeMod = yield* Effect.promise(() => import("./generateRuntime.ts"));
      const headlessLayer = runtimeMod.makeHeadlessGenerateLayer(configLayer);
      return yield* runtimeMod.getProvidersSafe.pipe(
        Effect.flatMap((providers) => execute(providers)),
        Effect.provide(headlessLayer),
      );
    }).pipe(
      Effect.catch((error) =>
        Console.error(error instanceof Error ? error.message : String(error)).pipe(
          Effect.andThen(
            Effect.sync(() => {
              process.exitCode = 1;
            }),
          ),
        ),
      ),
    ),
  ),
);
