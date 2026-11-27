import type { SourceControlProviderKind } from "@t3tools/contracts";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerConfig from "../config.ts";
import * as SourceControlProviderRegistry from "./SourceControlProviderRegistry.ts";

export interface RepositoryTarget {
  readonly provider: SourceControlProviderKind;
  readonly host: string;
  /** `owner/name`. */
  readonly repository: string;
}

/** `unknown` covers hosts that cannot say and failed reads; callers treat it as public. */
export type RepositoryAudience = "public" | "private" | "unknown";

const CACHE_CAPACITY = 256;
const KNOWN_TTL = Duration.minutes(10);

export class RepositoryVisibility extends Context.Service<
  RepositoryVisibility,
  {
    readonly of: (target: RepositoryTarget) => Effect.Effect<RepositoryAudience>;
  }
>()("t3/sourceControl/RepositoryVisibility") {}

const make = Effect.gen(function* () {
  const registry = yield* SourceControlProviderRegistry.SourceControlProviderRegistry;
  const { cwd } = yield* ServerConfig.ServerConfig;
  const targets = new Map<string, RepositoryTarget>();
  const read = Effect.fn("RepositoryVisibility.read")(function* (key: string) {
    const target = targets.get(key);
    if (target === undefined) return "unknown" as const;
    const provider = yield* registry.get(target.provider).pipe(Effect.option);
    if (Option.isNone(provider) || provider.value.getRepositoryVisibility === undefined) {
      return "unknown" as const;
    }
    return yield* provider.value
      .getRepositoryVisibility({
        cwd,
        repository: target.repository,
        host: target.host,
      })
      .pipe(
        Effect.tapError((error) => Effect.logWarning("repository visibility read failed", error)),
        Effect.orElseSucceed(() => "unknown" as const),
      );
  });
  const cache = yield* Cache.makeWith(read, {
    capacity: CACHE_CAPACITY,
    timeToLive: (exit) =>
      Exit.isSuccess(exit) && exit.value !== "unknown" ? KNOWN_TTL : Duration.zero,
  });
  return RepositoryVisibility.of({
    of: Effect.fn("RepositoryVisibility.of")(function* (target) {
      const key = [target.provider, target.host, target.repository]
        .map((part) => part.toLowerCase())
        .join("\0");
      targets.set(key, target);
      return yield* Cache.get(cache, key);
    }),
  });
});

export const layer = Layer.effect(RepositoryVisibility, make);
