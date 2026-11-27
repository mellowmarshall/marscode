import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import { boundedArchiveRead } from "./ArchiveReadGuard.ts";
import {
  archiveFsSlotUsage,
  clearArchiveProbeCache,
  isArchivePathCachedOffline,
} from "./usageArchiveFsGuard.ts";

const archived = "/mnt/share/agent-sessions/host/claude/-work/a.jsonl";
const archiveDir = "/mnt/share/agent-sessions/host/claude/-work";

it.layer(NodeServices.layer)("boundedArchiveRead", (it) => {
  describe("reads on the session archive", () => {
    it.effect("returns the read's result while the share answers", () =>
      Effect.gen(function* () {
        expect(yield* boundedArchiveRead(archived, 1024, Effect.succeed("records"))).toBe(
          "records",
        );
        expect(isArchivePathCachedOffline(archiveDir, 0)).toBe(false);
      }),
    );

    it.effect(
      "gives up on a stalled read, marks the share offline, and frees the slot only when the read returns",
      () =>
        Effect.gen(function* () {
          const started = yield* Deferred.make<void>();
          const release = yield* Deferred.make<string>();
          const stalled = Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
          );
          const fiber = yield* Effect.forkChild(
            boundedArchiveRead(archived, 0, stalled, { timeoutMs: 5_000 }),
          );
          yield* Deferred.await(started);
          yield* Effect.yieldNow;
          yield* TestClock.adjust("5 seconds");

          expect(yield* Fiber.join(fiber)).toBeNull();
          expect(isArchivePathCachedOffline(archiveDir, 5_000)).toBe(true);

          // The stalled read still holds its slot; once it returns, the next read gets one at once.
          yield* Deferred.succeed(release, "late");
          yield* Effect.yieldNow;
          expect(yield* boundedArchiveRead(archived, 0, Effect.succeed("next"))).toBe("next");
        }).pipe(Effect.ensuring(Effect.sync(clearArchiveProbeCache))),
    );

    it.effect("leaks no slot when a caller waiting behind two stalled reads is interrupted", () =>
      Effect.gen(function* () {
        const stall = Effect.fn("stall")(function* () {
          const started = yield* Deferred.make<void>();
          const release = yield* Deferred.make<string>();
          const fiber = yield* Effect.forkChild(
            boundedArchiveRead(
              archived,
              0,
              Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release))),
              { timeoutMs: 60_000 },
            ),
          );
          yield* Deferred.await(started);
          return { fiber, release };
        });
        const first = yield* stall();
        const second = yield* stall();
        expect(archiveFsSlotUsage()).toEqual({ active: 2, waiting: 0 });

        const queued = yield* Effect.forkChild(
          boundedArchiveRead(archived, 0, Effect.succeed("never runs"), { timeoutMs: 60_000 }),
        );
        yield* Effect.yieldNow;
        expect(archiveFsSlotUsage()).toEqual({ active: 2, waiting: 1 });
        yield* Fiber.interrupt(queued);
        expect(archiveFsSlotUsage()).toEqual({ active: 2, waiting: 0 });

        yield* Deferred.succeed(first.release, "a");
        yield* Deferred.succeed(second.release, "b");
        expect(yield* Fiber.join(first.fiber)).toBe("a");
        expect(yield* Fiber.join(second.fiber)).toBe("b");
        yield* Effect.yieldNow;
        expect(archiveFsSlotUsage()).toEqual({ active: 0, waiting: 0 });

        // Both slots are free again: two new reads hold them at once.
        const third = yield* stall();
        const fourth = yield* stall();
        expect(archiveFsSlotUsage()).toEqual({ active: 2, waiting: 0 });
        yield* Deferred.succeed(third.release, "c");
        yield* Deferred.succeed(fourth.release, "d");
        expect([yield* Fiber.join(third.fiber), yield* Fiber.join(fourth.fiber)]).toEqual([
          "c",
          "d",
        ]);
        yield* Effect.yieldNow;
        expect(archiveFsSlotUsage()).toEqual({ active: 0, waiting: 0 });
      }),
    );
  });
});
