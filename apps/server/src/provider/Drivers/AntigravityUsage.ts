import { type AntigravitySettings, UsageReadError } from "@t3tools/contracts";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import type {
  ProviderUsageInstance,
  ProviderUsageReader,
  ProviderUsageScan,
} from "@t3tools/provider-core/server/usage";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { resolveAntigravityInstanceDirectories } from "../antigravityAuthSupport.ts";
import type { AntigravityCachedPayload } from "../../usage/usageSqliteIndex.ts";
import {
  acquireUsageSqliteIndex,
  type SharedUsageSqliteHandle,
} from "../../usage/usageSqlitePool.ts";
import {
  antigravityRateModel,
  makeAntigravityUsageCache,
  readAntigravityUsage,
} from "./antigravityUsageReader.ts";

export class AntigravityUsage extends Context.Service<
  AntigravityUsage,
  {
    readonly scan: (input: {
      readonly instances: ReadonlyArray<ProviderUsageInstance<AntigravitySettings>>;
      readonly windowStartMs: number;
    }) => Effect.Effect<ReadonlyArray<ProviderUsageScan>, UsageReadError>;
  }
>()("t3/provider/Drivers/AntigravityUsage") {}

const make = Effect.gen(function* () {
  const digest = yield* Digest.Digest;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const host = yield* ProviderHost.ProviderHost;
  const cache = makeAntigravityUsageCache();
  const persistedFingerprints = new Map<string, string>();
  let sqliteHandle: SharedUsageSqliteHandle | null = null;
  let sqliteRetryAfterMs = 0;
  const SQLITE_RETRY_COOLDOWN_MS = 60_000;
  const getSqliteIndex = (nowMs: number) => {
    if (sqliteHandle !== null) return sqliteHandle.index;
    if (nowMs < sqliteRetryAfterMs) return null;
    try {
      const handle = acquireUsageSqliteIndex(host.paths.stateDir);
      sqliteHandle = handle;
      sqliteRetryAfterMs = 0;
      for (const [key, entry] of handle.index.loadAntigravityCache()) {
        if (!cache.has(key)) {
          cache.set(key, entry as NonNullable<ReturnType<typeof cache.get>>);
        }
        persistedFingerprints.set(key, entry.fingerprint);
      }
      return handle.index;
    } catch {
      sqliteRetryAfterMs = nowMs + SQLITE_RETRY_COOLDOWN_MS;
      return null;
    }
  };
  getSqliteIndex(yield* Clock.currentTimeMillis);
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      sqliteHandle?.release();
      sqliteHandle = null;
    }),
  );

  const dataRoots = Effect.fn("AntigravityUsage.dataRoots")(function* (
    environment: NodeJS.ProcessEnv,
  ) {
    const home = yield* HostProcess.HomeDirectory;
    const configured = environment["ANTIGRAVITY_DATA_DIR"]
      ?.split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    const defaults = [
      ...["antigravity", "antigravity-cli", "antigravity-ide", "antigravity-backup"].map((name) =>
        path.join(home, ".gemini", name),
      ),
      path.join(home, ".config", "antigravity"),
    ];
    const canonical = new Set<string>();
    for (const root of configured?.length ? configured : defaults) {
      const resolved = path.resolve(expandHomePath(root, home));
      canonical.add(
        yield* fileSystem.realPath(resolved).pipe(Effect.orElseSucceed(() => resolved)),
      );
    }
    return [...canonical];
  });

  const scan: AntigravityUsage["Service"]["scan"] = Effect.fn("AntigravityUsage.scan")(function* ({
    instances,
    windowStartMs,
  }) {
    const roots: Array<string> = [];
    for (const instance of instances) roots.push(...(yield* dataRoots(instance.environment)));
    for (const { instanceId } of instances) {
      const directories = yield* resolveAntigravityInstanceDirectories(
        host.paths.stateDir,
        instanceId,
      ).pipe(
        Effect.provideService(Digest.Digest, digest),
        Effect.provideService(Path.Path, path),
        Effect.mapError(
          (cause) =>
            new UsageReadError({
              reason: "scanFailed",
              detail: "Antigravity profile directory could not be resolved.",
              cause,
            }),
        ),
      );
      roots.push(path.join(directories.profile, "antigravity-acp"));
    }
    const conversationDirs = new Set<string>();
    for (const root of roots) {
      const resolvedRoot = yield* fileSystem.realPath(root).pipe(Effect.orElseSucceed(() => root));
      const nested = path.join(resolvedRoot, "conversations");
      const dir = (yield* fileSystem
        .exists(nested)
        .pipe(Effect.catchCause(() => Effect.succeed(false))))
        ? nested
        : resolvedRoot;
      conversationDirs.add(yield* fileSystem.realPath(dir).pipe(Effect.orElseSucceed(() => dir)));
    }
    const nowMs = yield* Clock.currentTimeMillis;
    const sqliteIndex = getSqliteIndex(nowMs);
    const result = yield* readAntigravityUsage([...conversationDirs], windowStartMs, cache).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );
    if (sqliteIndex !== null) {
      const upserts = new Map<string, AntigravityCachedPayload>();
      const deletes = new Set<string>();
      for (const [key, entry] of cache) {
        if (persistedFingerprints.get(key) !== entry.fingerprint) {
          upserts.set(key, entry as AntigravityCachedPayload);
        }
      }
      // Do not persist cache evictions when any root had read errors; an unreadable root would wipe cached DBs.
      if (result.errors.length === 0) {
        for (const key of persistedFingerprints.keys()) {
          if (!cache.has(key)) deletes.add(key);
        }
      }
      if (upserts.size > 0 || deletes.size > 0) {
        const updatedAtMs = yield* Clock.currentTimeMillis;
        const saved = yield* Effect.try({
          try: () => {
            sqliteIndex.saveAntigravityChanges({ upserts, deletes, updatedAtMs });
            return true;
          },
          catch: () => false,
        }).pipe(Effect.orElseSucceed(() => false));
        if (saved) {
          for (const [key, entry] of upserts) persistedFingerprints.set(key, entry.fingerprint);
          for (const key of deletes) persistedFingerprints.delete(key);
        }
      }
    }
    const scanned: ProviderUsageScan[] = [];
    for (const dir of conversationDirs) {
      const exists = yield* fileSystem
        .exists(dir)
        .pipe(Effect.catchCause(() => Effect.succeed(false)));
      const failed = result.errors.some(
        (error) => error === dir || error.startsWith(`${dir}${path.sep}`),
      );
      scanned.push({
        dir,
        files: !exists && !failed ? null : result.files.filter((file) => file.root === dir),
        status: failed ? "partial" : "ok",
        ...(failed ? { message: "Some Antigravity history could not be read." } : {}),
      });
    }
    return scanned;
  });

  return AntigravityUsage.of({ scan });
});

export const layer = Layer.effect(AntigravityUsage, make);

export const antigravityUsageReader: ProviderUsageReader<AntigravitySettings, AntigravityUsage> = {
  kind: "scan",
  provider: "antigravity",
  rateModel: antigravityRateModel,
  scan: ({ instances, windowStartMs }) =>
    AntigravityUsage.pipe(Effect.flatMap((usage) => usage.scan({ instances, windowStartMs }))),
};
