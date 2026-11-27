import { it } from "@effect/vitest";
import {
  ANTIGRAVITY_DEFAULT_MODEL,
  ProviderDriverKind,
  ProviderInstanceId,
  type ModelSelection,
  type ProviderInstanceConfigMap,
  type ServerProvider,
} from "@t3tools/contracts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as TextGenerationOperations from "@t3tools/provider-core/server/textGenerationOperations";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { expect } from "vite-plus/test";

import * as ProviderInstallationGate from "../provider/ProviderInstallationGate.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as TextGeneration from "./TextGeneration.ts";
import * as TextGenerators from "./TextGenerators.ts";

const FIXED_CHECKED_AT = "2026-11-27T12:00:00.000Z";
const GROK_ID = ProviderInstanceId.make("grok");
const ANTIGRAVITY_ID = ProviderInstanceId.make("antigravity");

function makeSnapshot(input: {
  readonly instanceId: ProviderInstanceId;
  readonly driver: "grok" | "antigravity";
  readonly model: string;
  readonly enabled?: boolean;
  readonly status?: ServerProvider["status"];
}): ServerProvider {
  const driver = ProviderDriverKind.make(input.driver);
  return {
    instanceId: input.instanceId,
    driver,
    enabled: input.enabled ?? true,
    installed: true,
    version: "1.0.0",
    status: input.status ?? "ready",
    auth: { status: "authenticated" },
    checkedAt: FIXED_CHECKED_AT,
    models: [
      {
        slug: input.model,
        name: input.model,
        isCustom: false,
        capabilities: null,
        supportsTextGeneration: true,
      },
    ],
    slashCommands: [],
    skills: [],
  };
}

function makeInstance(input: {
  readonly snapshot: ServerProvider;
  readonly textGeneration: ProviderInstance["textGeneration"];
}): ProviderInstance {
  return {
    instanceId: input.snapshot.instanceId,
    driver: input.snapshot.driver,
    snapshot: {
      getSnapshot: Effect.succeed(input.snapshot),
      refresh: Effect.succeed(input.snapshot),
      stream: Stream.empty,
    },
    textGeneration: input.textGeneration,
  } as unknown as ProviderInstance;
}

function makeLayer(input: {
  readonly instances: ReadonlyArray<ProviderInstance>;
  readonly providerInstances: ProviderInstanceConfigMap;
  readonly defaultModelSelection?: ModelSelection;
}) {
  const byId = new Map(input.instances.map((inst) => [inst.instanceId, inst] as const));
  const registryLayer = Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
    getInstance: (id) => Effect.succeed(byId.get(id)),
    listInstances: Effect.succeed(input.instances),
    listUnavailable: Effect.succeed([]),
    streamChanges: Stream.empty,
    subscribeChanges: Effect.die("unused"),
  });
  const textGeneratorsLayer = Layer.succeed(TextGenerators.TextGenerators, {
    runner: () => Effect.undefined,
    listModels: () => Effect.succeed({ models: [] }),
  });
  const sourceControlLayer = Layer.mock(
    SourceControlProviderRegistry.SourceControlProviderRegistry,
  )({
    resolveLink: () => Effect.die("resolveLink unused in TextGeneration.test"),
  });
  const settingsLayer = ServerSettings.layerTest({
    providerInstances: input.providerInstances,
    ...(input.defaultModelSelection ? { defaultModelSelection: input.defaultModelSelection } : {}),
  });

  return Layer.effect(TextGeneration.TextGeneration, TextGeneration.make).pipe(
    Layer.provide(
      Layer.mergeAll(
        registryLayer,
        textGeneratorsLayer,
        sourceControlLayer,
        settingsLayer,
        ProviderInstallationGate.layer,
      ),
    ),
  );
}

const ChallengeSchema = Schema.Struct({
  acceptable: Schema.Boolean,
  summary: Schema.String,
  diagnosis: Schema.String,
  bypass_detected: Schema.Boolean,
  playbook_friction: Schema.Boolean,
  rejected_rises: Schema.Array(Schema.Unknown),
  rises_accepted: Schema.Boolean,
  defects: Schema.Array(Schema.Unknown),
  analysis: Schema.String,
  recommendation: Schema.String,
});

const CHALLENGE_REPLY = {
  acceptable: true,
  summary: "Checked cleanly",
  diagnosis: "ok",
  bypass_detected: false,
  playbook_friction: false,
  rejected_rises: [],
  rises_accepted: false,
  defects: [],
  analysis: "",
  recommendation: "Accept.",
};

it.effect(
  "runs playbook challenge directly on Antigravity and falls back from Grok to Antigravity",
  () =>
    Effect.gen(function* () {
      const calls: Array<{ readonly driver: string; readonly op: string; readonly model: string }> =
        [];

      const grokTextGen = TextGenerationOperations.fromRunner(
        "GrokTextGeneration",
        TextGenerationOperations.withoutInvestigation("Grok", (req) => {
          calls.push({ driver: "grok", op: req.operation, model: req.modelSelection.model });
          return TextGenerationOperations.decodeJsonReply(req, "Grok", '{"title":"Grok title"}');
        }),
      );

      const antigravityTextGen = TextGenerationOperations.fromRunner(
        "AntigravityTextGeneration",
        (req) => {
          calls.push({ driver: "antigravity", op: req.operation, model: req.modelSelection.model });
          return TextGenerationOperations.decodeJsonReply(
            req,
            "Antigravity",
            JSON.stringify(
              req.operation === "generatePlaybookChallenge"
                ? CHALLENGE_REPLY
                : { title: "Antigravity title" },
            ),
          );
        },
      );

      const layer = makeLayer({
        instances: [
          makeInstance({
            snapshot: makeSnapshot({ instanceId: GROK_ID, driver: "grok", model: "grok-3" }),
            textGeneration: grokTextGen,
          }),
          makeInstance({
            snapshot: makeSnapshot({
              instanceId: ANTIGRAVITY_ID,
              driver: "antigravity",
              model: "gemini-3-pro",
            }),
            textGeneration: antigravityTextGen,
          }),
        ],
        providerInstances: {
          [GROK_ID]: { driver: ProviderDriverKind.make("grok"), enabled: true },
          [ANTIGRAVITY_ID]: { driver: ProviderDriverKind.make("antigravity"), enabled: true },
        },
      });

      const service = yield* TextGeneration.TextGeneration.pipe(Effect.provide(layer));

      // Direct Antigravity investigation succeeds without fallback
      const direct = yield* service.generatePlaybookChallenge({
        cwd: "/tmp/repo",
        prompt: "Check the diff",
        outputSchema: ChallengeSchema,
        modelSelection: { instanceId: ANTIGRAVITY_ID, model: "gemini-3-pro" },
      });
      expect(direct.acceptable).toBe(true);

      // Selecting Grok for playbook challenge falls back cleanly to Antigravity
      const fallback = yield* service.generatePlaybookChallenge({
        cwd: "/tmp/repo",
        prompt: "Check the diff",
        outputSchema: ChallengeSchema,
        modelSelection: { instanceId: GROK_ID, model: "grok-3" },
      });
      expect(fallback.acceptable).toBe(true);

      // Grok still handles non-investigating operations directly
      const title = yield* service.generateThreadTitle({
        cwd: "/tmp/repo",
        message: "Fix auth",
        modelSelection: { instanceId: GROK_ID, model: "grok-3" },
      });
      expect(title.title).toBe("Grok title");

      expect(calls).toEqual([
        { driver: "antigravity", op: "generatePlaybookChallenge", model: "gemini-3-pro" },
        {
          driver: "antigravity",
          op: "generatePlaybookChallenge",
          model: ANTIGRAVITY_DEFAULT_MODEL,
        },
        { driver: "grok", op: "generateThreadTitle", model: "grok-3" },
      ]);
    }),
);

it.effect(
  "fails closed when Grok is selected for investigation and no investigating driver is ready",
  () =>
    Effect.gen(function* () {
      const grokTextGen = TextGenerationOperations.fromRunner(
        "GrokTextGeneration",
        TextGenerationOperations.withoutInvestigation("Grok", (req) =>
          TextGenerationOperations.decodeJsonReply(req, "Grok", '{"title":"Grok title"}'),
        ),
      );
      const layer = makeLayer({
        instances: [
          makeInstance({
            snapshot: makeSnapshot({ instanceId: GROK_ID, driver: "grok", model: "grok-3" }),
            textGeneration: grokTextGen,
          }),
        ],
        providerInstances: {
          [GROK_ID]: { driver: ProviderDriverKind.make("grok"), enabled: true },
        },
      });

      const service = yield* TextGeneration.TextGeneration.pipe(Effect.provide(layer));
      const err = yield* service
        .generatePlaybookChallenge({
          cwd: "/tmp/repo",
          prompt: "Check the diff",
          outputSchema: ChallengeSchema,
          modelSelection: { instanceId: GROK_ID, model: "grok-3" },
        })
        .pipe(Effect.flip);
      expect(err._tag).toBe("TextGenerationError");
      expect(err.detail).toContain("Codex, Claude, or Antigravity");
    }),
);
