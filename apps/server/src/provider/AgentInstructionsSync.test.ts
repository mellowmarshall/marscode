import { assert, it } from "@effect/vitest";
import {
  T3_CODE_ORCHESTRATION_INSTRUCTIONS,
  setT3OrchestrationInstructionsOverride,
  t3OrchestrationInstructionsText,
} from "@t3tools/provider-core/server/orchestrationInstructions";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ServerSettingsService } from "../serverSettings.ts";
import * as AgentInstructionsSync from "./AgentInstructionsSync.ts";

it.effect("gives new agent sessions the instructions saved in settings", () =>
  Effect.gen(function* () {
    yield* Effect.addFinalizer(() => Effect.sync(() => setT3OrchestrationInstructionsOverride("")));
    yield* Layer.build(
      AgentInstructionsSync.layer.pipe(
        Layer.provide(ServerSettingsService.layerTest({ agentInstructions: "Ask first." })),
      ),
    );
    assert.equal(t3OrchestrationInstructionsText(), "Ask first.");
  }).pipe(Effect.scoped),
);

it.effect("keeps the built-in text when the setting is empty", () =>
  Effect.gen(function* () {
    yield* Layer.build(
      AgentInstructionsSync.layer.pipe(Layer.provide(ServerSettingsService.layerTest())),
    );
    assert.equal(t3OrchestrationInstructionsText(), T3_CODE_ORCHESTRATION_INSTRUCTIONS.trim());
  }).pipe(Effect.scoped),
);
