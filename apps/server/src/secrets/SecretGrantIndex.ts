// @effect-diagnostics nodeBuiltinImport:off - In-memory index and sweep for 24-hour secret/password grants (opaque IDs only, zero secret values).
import * as NodeCrypto from "node:crypto";

import type { ActiveSecretGrant } from "@t3tools/guard-protocol/protocol";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import type * as ServerSecretStore from "../auth/ServerSecretStore.ts";

export const SECRET_REF_PREFIX = "secret-ref:";
export const SECRET_GRANT_PREFIX = "secret-grant:";
export const SECRET_REF_TTL_MS = 24 * 60 * 60 * 1000;
const STORE_NAME_PATTERN = /^(secret-request-[0-9a-f]{32})\.bin$/;
const FILE_NAME_PATTERN = /^[0-9a-f]{32}(\.partial)?$/;
const LIVE_FILE_NAME_PATTERN = /^[0-9a-f]{32}$/;

export const StoredSecret = Schema.fromJsonString(
  Schema.Struct({
    projectId: Schema.String,
    value: Schema.String,
    savedAt: Schema.Number,
    threadId: Schema.optional(Schema.String),
    label: Schema.optional(Schema.String),
    delivery: Schema.optional(Schema.Literals(["secretRef", "file"])),
  }),
);
export const encodeStoredSecret = Schema.encodeEffect(StoredSecret);
export const decodeStoredSecret = Schema.decodeUnknownOption(StoredSecret);

export interface TrackedSecretGrantInput {
  readonly threadId: string;
  readonly projectId: string;
  readonly delivery: "secretRef" | "file";
  readonly summary: string;
  readonly savedAtMs: number;
  readonly storeName?: string | undefined;
  readonly filePath?: string | undefined;
}

export interface TrackedSecretGrant {
  readonly grant: ActiveSecretGrant;
  readonly storeName?: string | undefined;
  readonly filePath?: string | undefined;
}

function grantsEqual(a: TrackedSecretGrant, b: TrackedSecretGrant): boolean {
  return (
    a.storeName === b.storeName &&
    a.filePath === b.filePath &&
    a.grant.threadId === b.grant.threadId &&
    a.grant.projectId === b.grant.projectId &&
    a.grant.delivery === b.grant.delivery &&
    a.grant.summary === b.grant.summary &&
    a.grant.createdAt === b.grant.createdAt &&
    a.grant.expiresAt === b.grant.expiresAt
  );
}

/**
 * In-memory index of active 24-hour secret/password grants owned by SecretRequests.
 * Uses opaque random `secret-grant:` IDs (never exposes `secret-ref:` handles or raw paths)
 * and stores metadata/storage handles only — never secret values.
 */
export class SecretGrantIndex {
  private readonly entries = new Map<string, TrackedSecretGrant>();
  private readonly listeners = new Set<() => void>();

  private findByBacking(
    storeName: string | undefined,
    filePath: string | undefined,
  ): TrackedSecretGrant | undefined {
    for (const entry of this.entries.values()) {
      if (storeName !== undefined && entry.storeName === storeName) return entry;
      if (filePath !== undefined && entry.filePath === filePath) return entry;
    }
    return undefined;
  }

  hasFilePath(filePath: string): boolean {
    for (const entry of this.entries.values()) {
      if (entry.filePath === filePath) return true;
    }
    return false;
  }

  record(input: TrackedSecretGrantInput): string {
    const existing = this.findByBacking(input.storeName, input.filePath);
    const grantId =
      existing?.grant.grantId ??
      `${SECRET_GRANT_PREFIX}${NodeCrypto.randomBytes(16).toString("hex")}`;
    const next: TrackedSecretGrant = {
      grant: {
        kind: "secret_access",
        grantId,
        threadId: input.threadId || existing?.grant.threadId || "",
        projectId: input.projectId || existing?.grant.projectId || "",
        delivery: input.delivery,
        summary: input.summary || existing?.grant.summary || "Secret access",
        createdAt: DateTime.formatIso(DateTime.makeUnsafe(input.savedAtMs)),
        expiresAt: DateTime.formatIso(DateTime.makeUnsafe(input.savedAtMs + SECRET_REF_TTL_MS)),
      },
      ...((input.storeName ?? existing?.storeName)
        ? { storeName: input.storeName ?? existing?.storeName }
        : {}),
      ...((input.filePath ?? existing?.filePath)
        ? { filePath: input.filePath ?? existing?.filePath }
        : {}),
    };
    if (existing && grantsEqual(existing, next)) {
      return grantId;
    }
    this.entries.set(grantId, next);
    this.notify();
    return grantId;
  }

  markDeliveredFile(storeName: string, filePath: string): void {
    const existing = this.findByBacking(storeName, filePath);
    if (!existing) return;
    const next: TrackedSecretGrant = {
      ...existing,
      grant: { ...existing.grant, delivery: "file" },
      filePath,
    };
    if (grantsEqual(existing, next)) return;
    this.entries.set(existing.grant.grantId, next);
    this.notify();
  }

  removeByStoreName(storeName: string): void {
    let changed = false;
    for (const [id, entry] of this.entries) {
      if (entry.storeName === storeName && entry.filePath === undefined) {
        this.entries.delete(id);
        changed = true;
      }
    }
    if (changed) this.notify();
  }

  removeByFilePath(filePath: string): void {
    let changed = false;
    for (const [id, entry] of this.entries) {
      if (entry.filePath === filePath) {
        this.entries.delete(id);
        changed = true;
      }
    }
    if (changed) this.notify();
  }

  remove(grantId: string): TrackedSecretGrant | undefined {
    const existing = this.entries.get(grantId);
    if (!existing) return undefined;
    this.entries.delete(grantId);
    this.notify();
    return existing;
  }

  listActive(nowMs: number): ReadonlyArray<ActiveSecretGrant> {
    let pruned = false;
    const out: ActiveSecretGrant[] = [];
    for (const [id, entry] of this.entries) {
      if (Date.parse(entry.grant.expiresAt) <= nowMs) {
        this.entries.delete(id);
        pruned = true;
        continue;
      }
      out.push(entry.grant);
    }
    if (pruned) this.notify();
    return out.toSorted((a, b) =>
      a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0,
    );
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // isolate subscriber errors
      }
    }
  }
}

export function makeSecretSweep(deps: {
  readonly store: ServerSecretStore.ServerSecretStore["Service"];
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly filesDir: string | undefined;
  readonly grantIndex: SecretGrantIndex;
  readonly removeLogged: (name: string) => Effect.Effect<boolean>;
}): Effect.Effect<void> {
  const { store, fileSystem, path, filesDir, grantIndex, removeLogged } = deps;
  const sweepExpired = Effect.gen(function* () {
    if (store.directory === undefined) return;
    const now = yield* Clock.currentTimeMillis;
    const names = (yield* fileSystem.readDirectory(store.directory)).flatMap((file) => {
      const match = STORE_NAME_PATTERN.exec(file);
      return match?.[1] === undefined ? [] : [match[1]];
    });
    let removed = 0;
    for (const name of names) {
      const stored = yield* store.get(name).pipe(Effect.orElseSucceed(Option.none));
      const decoded = Option.flatMap(stored, (bytes) =>
        decodeStoredSecret(new TextDecoder().decode(bytes)),
      );
      if (Option.isSome(decoded) && now - decoded.value.savedAt <= SECRET_REF_TTL_MS) {
        grantIndex.record({
          threadId: decoded.value.threadId ?? "",
          projectId: decoded.value.projectId,
          delivery: decoded.value.delivery ?? "secretRef",
          summary: decoded.value.label ?? "Secret access",
          savedAtMs: decoded.value.savedAt,
          storeName: name,
        });
        continue;
      }
      if (yield* removeLogged(name)) {
        grantIndex.removeByStoreName(name);
        removed += 1;
      }
    }
    yield* Effect.annotateCurrentSpan({ "secret_request.expired_removed": removed });
  }).pipe(
    Effect.catchCause((cause) => Effect.logWarning("Could not sweep expired secret refs", cause)),
    Effect.withSpan("SecretRequests.sweepExpired"),
  );

  const sweepExpiredFiles = Effect.gen(function* () {
    if (filesDir === undefined || !(yield* fileSystem.exists(filesDir))) return;
    const now = yield* Clock.currentTimeMillis;
    let removed = 0;
    for (const name of yield* fileSystem.readDirectory(filesDir)) {
      if (!FILE_NAME_PATTERN.test(name)) continue;
      const file = path.join(filesDir, name);
      const { mtime } = yield* fileSystem.stat(file);
      if (Option.exists(mtime, (time) => now - time.getTime() <= SECRET_REF_TTL_MS)) {
        // Re-hydrate surviving delivered/pasted files after restart so they stay visible and revocable.
        if (
          LIVE_FILE_NAME_PATTERN.test(name) &&
          !grantIndex.hasFilePath(file) &&
          Option.isSome(mtime)
        ) {
          grantIndex.record({
            threadId: "",
            projectId: "",
            delivery: "file",
            summary: "Secret file",
            savedAtMs: mtime.value.getTime(),
            filePath: file,
          });
        }
        continue;
      }
      yield* fileSystem.remove(file);
      grantIndex.removeByFilePath(file);
      removed += 1;
    }
    yield* Effect.annotateCurrentSpan({ "secret_request.expired_files_removed": removed });
  }).pipe(
    Effect.catchCause((cause) => Effect.logWarning("Could not sweep expired secret files", cause)),
    Effect.withSpan("SecretRequests.sweepExpiredFiles"),
  );

  return Effect.andThen(sweepExpired, sweepExpiredFiles);
}
