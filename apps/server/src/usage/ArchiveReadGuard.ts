import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import {
  acquireArchiveFsSlot,
  ARCHIVE_READ_TIMEOUT_MS,
  markArchiveOffline,
  releaseArchiveFsSlot,
} from "./usageArchiveFsGuard.ts";

/** A share slower than 1 MB/s times out rather than holding the caller. */
const ARCHIVE_READ_BYTES_PER_MS = 1_000;

/**
 * Runs a read of a file on the session archive (a transcript the archive pass moved behind a
 * link) under the process-wide archive FS cap, with a timeout sized to `bytes`. On timeout the
 * archive folder is marked offline and the result is null; the read keeps its slot until the
 * OS call settles, so a stalled share never holds more than the capped libuv threads.
 */
export const boundedArchiveRead = Effect.fn("boundedArchiveRead")(function* <A, E, R>(
  archivedPath: string,
  bytes: number,
  read: Effect.Effect<A, E, R>,
  options: { readonly timeoutMs?: number } = {},
) {
  const path = yield* Path.Path;
  const timeoutMs =
    options.timeoutMs ?? Math.max(ARCHIVE_READ_TIMEOUT_MS, bytes / ARCHIVE_READ_BYTES_PER_MS);
  const markOffline = Clock.currentTimeMillis.pipe(
    Effect.flatMap((nowMs) =>
      Effect.sync(() => markArchiveOffline(path.dirname(archivedPath), nowMs, "timeout")),
    ),
  );
  // The wait for a slot is interruptible; from the grant to the fork that owns it, nothing is.
  const fiber = yield* Effect.uninterruptibleMask((restore) => {
    let pending: Promise<void> | undefined;
    const acquire = Effect.tryPromise({
      try: (signal) => (pending = acquireArchiveFsSlot(timeoutMs, "archive read", signal)),
      catch: () => "slot-timeout" as const,
    });
    return restore(acquire).pipe(
      // Interrupted while waiting: the abort leaves the queue; a grant that won the race is given back.
      Effect.onInterrupt(() =>
        Effect.sync(() => void pending?.then(releaseArchiveFsSlot, () => undefined)),
      ),
      Effect.flatMap(() =>
        // Not interrupted on timeout: the slot is released only once the read itself returns.
        Effect.forkDetach(read.pipe(Effect.ensuring(Effect.sync(releaseArchiveFsSlot)))).pipe(
          Effect.asSome,
        ),
      ),
      Effect.catch(() => markOffline.pipe(Effect.as(Option.none()))),
    );
  });
  if (Option.isNone(fiber)) return null;
  const result = yield* Fiber.join(fiber.value).pipe(Effect.timeoutOption(timeoutMs));
  if (Option.isSome(result)) return result.value;
  yield* markOffline;
  return null;
});
