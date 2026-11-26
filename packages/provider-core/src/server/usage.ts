import type {
  ProviderInstanceId,
  ServerSettings,
  UsageProviderKind,
  UsageReadError,
  UsageSource,
  UsageTokenTotals,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import type * as Schema from "effect/Schema";
import { expandHomePath } from "./pathExpansion.ts";

export type UsageSpeed = "standard" | "fast" | "ultrafast";

export interface UsageRecord {
  readonly provider: UsageProviderKind;
  readonly timestampMs: number;
  readonly model: string;
  readonly rateModel?: string;
  readonly sessionId: string;
  readonly totals: UsageTokenTotals;
  /** The part of `totals.cacheCreationTokens` written with a 1-hour TTL. */
  readonly cacheCreation1hTokens?: number;
  readonly reportedCostUsd: number | null;
  readonly speed: UsageSpeed;
  readonly unresolvedServiceTierTurnId?: string;
  readonly dedupeKey: string | null;
}

export const EMPTY_TOTALS: UsageTokenTotals = {
  uncachedInputTokens: 0,
  cachedInputTokens: 0,
  cacheCreationTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
};

export function totalTokens(totals: UsageTokenTotals): number {
  // reasoningTokens is a subset of outputTokens and must not be added again.
  return (
    totals.uncachedInputTokens +
    totals.cachedInputTokens +
    totals.cacheCreationTokens +
    totals.outputTokens
  );
}

export function tokenCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

export function parseTimestampMs(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

export type SelectedFields = { readonly [key: string]: true | SelectedFields };

export interface TranscriptUsageFormat<State> {
  readonly selectFields: SelectedFields;
  /** ASCII markers must match every relevant line, including state-only updates. */
  readonly usageMarkers: readonly [string, ...string[]];
  parseLine(line: string, state: State): readonly UsageRecord[];
  parseProjected(projected: unknown, state: State): readonly UsageRecord[];
  /** Timestamps of malformed or inconsistent usage records, including skipped records. */
  readMalformedRecords?(state: State): readonly number[];
  /**
   * Present for formats whose records depend on earlier lines. The state at a
   * resume point is persisted in the scan cache through `schema`, so a grown
   * file resumes with it. Absent means every line stands alone.
   */
  readonly state?: {
    readonly initial: () => State;
    readonly schema: Schema.Codec<State, unknown>;
  };
  /** Enable cross-file deduplication when session records can appear in multiple files. */
  readonly sharedSessionsAcrossFiles?: true;
}

export interface ProviderUsageInstance<Config> {
  readonly instanceId: ProviderInstanceId;
  /** Undefined for invalid stored config; config-independent readers should still read history. */
  readonly config: Config | undefined;
  readonly environment: NodeJS.ProcessEnv;
  readonly configured: boolean;
}

export interface ProviderUsageScan {
  readonly dir: string;
  readonly volumeId?: string;
  readonly hostId?: string;
  readonly status?: UsageSource["status"];
  readonly message?: string;
  readonly files:
    | readonly { readonly path: string; readonly records: readonly UsageRecord[] }[]
    | null;
  readonly refreshing?: true;
}

export interface ProviderUsageScanInput<Config> {
  readonly instances: ReadonlyArray<ProviderUsageInstance<Config>>;
  readonly settings: ServerSettings;
  readonly windowStartMs: number;
  readonly retentionCutoffMs: number;
  readonly awaitRefresh: boolean;
}

interface ProviderUsageRateModel {
  /**
   * The rate-table name for a model ID this provider records with a separate `rateModel`, so
   * usage mapped onto that ID prices like the provider's own records of it.
   */
  readonly rateModel?: (model: string) => string;
}

export type ProviderUsageReader<Config, R> =
  | (ProviderUsageRateModel & {
      readonly kind: "transcripts";
      readonly provider: UsageProviderKind;
      readonly format: TranscriptUsageFormat<unknown>;
      readonly resolveServiceTiers?: (
        records: readonly UsageRecord[],
      ) => Effect.Effect<ReadonlyMap<UsageRecord, UsageSpeed>, never, R>;
      /** A `refreshing` entry is not scanned; it reports its source as still being located. */
      readonly directories: (
        instance: ProviderUsageInstance<Config>,
        options: { readonly awaitRefresh: boolean },
      ) => Effect.Effect<
        ReadonlyArray<{
          readonly dir: string;
          readonly fileName?: string;
          readonly refreshing?: true;
          /** Cold/immutable archive root; scanned on demand with dir-mtime skipping and offline cache fallback. */
          readonly archive?: true;
        }>,
        never,
        R
      >;
    })
  | (ProviderUsageRateModel & {
      readonly kind: "scan";
      readonly provider: UsageProviderKind;
      /** Fails only when the whole usage read cannot go on; an unreadable source is a status. */
      readonly scan: (
        input: ProviderUsageScanInput<Config>,
      ) => Effect.Effect<ReadonlyArray<ProviderUsageScan>, UsageReadError, R>;
    });

/** True when a path exists or is a symlink (even if its remote target is temporarily unmounted). */
export const pathOrSymlinkExists = (
  fileSystem: FileSystem.FileSystem,
  target: string,
): Effect.Effect<boolean> =>
  fileSystem.readLink(target).pipe(
    Effect.as(true),
    Effect.catch(() => fileSystem.exists(target).pipe(Effect.orElseSucceed(() => false))),
  );

/** Resolves an optional session-archive root if configured or symlinked under ~/.local/state/session-archive/remote. */
export const resolveSessionArchiveRoot = Effect.fn("usage.resolveSessionArchiveRoot")(function* (
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  homeDirectory: string,
  environment: NodeJS.ProcessEnv,
): Effect.fn.Return<string | undefined> {
  const explicit = environment["T3CODE_USAGE_SESSION_ARCHIVE_DIR"]?.trim();
  if (explicit) return path.resolve(expandHomePath(explicit, homeDirectory));
  const defaultLink = path.join(homeDirectory, ".local", "state", "session-archive", "remote");
  return (yield* pathOrSymlinkExists(fileSystem, defaultLink)) ? defaultLink : undefined;
});

/**
 * Resolves a provider subdirectory beneath a session-archive root without probing the
 * filesystem synchronously, so `UsageService` guards remote/SMB access with bounded timeouts
 * and negative caching.
 */
export function resolveSessionArchiveSubdir(
  path: Path.Path,
  archiveRoot: string,
  subdir: string,
): string {
  return path.join(archiveRoot, subdir);
}

/** Parses comma-separated extra archive directories from an environment variable. */
export function resolveExtraUsageDirs(
  environment: NodeJS.ProcessEnv,
  envKey: string,
  homeDirectory: string,
  path: Path.Path,
): readonly string[] {
  const raw = environment[envKey]?.trim();
  if (!raw) return [];
  const resolved: string[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const dir = path.resolve(expandHomePath(trimmed, homeDirectory));
    if (seen.has(dir)) continue;
    seen.add(dir);
    resolved.push(dir);
  }
  return resolved;
}
