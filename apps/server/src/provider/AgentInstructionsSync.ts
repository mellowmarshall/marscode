import { setT3OrchestrationInstructionsOverride } from "@t3tools/provider-core/server/orchestrationInstructions";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as Settings from "../serverSettings.ts";

/** Applies the `agentInstructions` setting to sessions that start after each save. */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const serverSettings = yield* Settings.ServerSettingsService;
    // Subscribe before the seed read so a save in between is not lost.
    const changes = yield* serverSettings.subscribeChanges;
    const initial = yield* serverSettings.getSettings.pipe(Effect.option);
    if (initial._tag === "Some")
      setT3OrchestrationInstructionsOverride(initial.value.agentInstructions);
    yield* changes.pipe(
      Stream.runForEach((settings) =>
        Effect.sync(() => setT3OrchestrationInstructionsOverride(settings.agentInstructions)),
      ),
      Effect.forkScoped,
    );
  }),
);
