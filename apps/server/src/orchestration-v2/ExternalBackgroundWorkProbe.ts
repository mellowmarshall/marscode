import type { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

/**
 * Optional probe for external OS-level background watchers (such as live `cerno` processes)
 * attributed to a thread via `T3CODE_THREAD_ID`. Keeps provider sessions alive while verified
 * watchers are still running without coupling `orchestration-v2` to `devtools`.
 */
export class ExternalBackgroundWorkProbe extends Context.Service<
  ExternalBackgroundWorkProbe,
  {
    readonly hasLiveWorkForThread: (threadId: ThreadId) => Effect.Effect<boolean>;
  }
>()("t3/orchestration-v2/ExternalBackgroundWorkProbe") {}
