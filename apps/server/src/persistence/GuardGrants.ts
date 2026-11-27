import { normalizeRepoSlug } from "@t3tools/guard-protocol/digests";
import type { ActiveGuardBundleGrant } from "@t3tools/guard-protocol/protocol";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import { toPersistenceSqlError, type GuardGrantsRepositoryError } from "./Errors.ts";

export interface CreateGuardBundleGrantInput {
  readonly grantId: string;
  readonly bundleKey: string;
  readonly threadId: string;
  readonly repo: string;
  readonly branch: string;
  readonly worktree: string;
  readonly prOrIssue: string;
  readonly guard: string;
  readonly gateIds: ReadonlyArray<string>;
  readonly protectedPaths: ReadonlyArray<string>;
  readonly protectedDiffSha256: string;
  readonly bodySha256: string;
  readonly summary: string;
  readonly reason: string;
  readonly approvedVia: string;
  readonly signature: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface StoredGuardBundleGrant extends ActiveGuardBundleGrant {
  readonly bundleKey: string;
  readonly worktree: string;
  readonly signature: string;
}

export type GuardGrantEventType =
  | "pending_added"
  | "approved"
  | "denied"
  | "expired"
  | "disconnected"
  | "used"
  | "revoked";

export interface GuardGrantEventRecord {
  readonly ts: string;
  readonly eventType: GuardGrantEventType;
  readonly requestId?: string | undefined;
  readonly grantId?: string | undefined;
  readonly threadId: string;
  readonly guard: string;
  readonly scope: "once" | "bundle" | "secret";
  readonly argvSha256: string;
  readonly command: ReadonlyArray<string>;
  readonly summary: string;
  readonly reason: string;
}

interface GuardGrantSqlRow {
  readonly grant_id: string;
  readonly bundle_key: string;
  readonly thread_id: string;
  readonly repo: string;
  readonly branch: string;
  readonly worktree: string;
  readonly pr_or_issue: string;
  readonly guard: string;
  readonly gate_ids_json: string;
  readonly protected_paths_json: string;
  readonly protected_diff_sha256: string;
  readonly body_sha256: string;
  readonly summary: string;
  readonly reason: string;
  readonly approved_via: string;
  readonly signature: string;
  readonly created_at: string;
  readonly expires_at: string | null;
  readonly use_count: number;
  readonly last_used_at: string | null;
}

interface GuardGrantEventSqlRow {
  readonly ts: string;
  readonly event_type: string;
  readonly request_id: string | null;
  readonly grant_id: string | null;
  readonly thread_id: string;
  readonly guard: string;
  readonly scope: string;
  readonly argv_sha256: string;
  readonly command_json: string;
  readonly summary: string;
  readonly reason: string;
}

function parseJsonStringArray(raw: string): ReadonlyArray<string> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function toStoredBundleGrant(row: GuardGrantSqlRow): StoredGuardBundleGrant {
  return {
    kind: "guard_bundle",
    grantId: row.grant_id,
    bundleKey: row.bundle_key,
    threadId: row.thread_id,
    repo: row.repo,
    branch: row.branch,
    worktree: row.worktree,
    prOrIssue: row.pr_or_issue,
    guard: row.guard,
    gateIds: parseJsonStringArray(row.gate_ids_json),
    protectedPaths: parseJsonStringArray(row.protected_paths_json),
    protectedDiffSha256: row.protected_diff_sha256,
    bodySha256: row.body_sha256,
    summary: row.summary,
    reason: row.reason,
    approvedVia: row.approved_via,
    signature: row.signature,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    useCount: row.use_count,
    lastUsedAt: row.last_used_at,
  };
}

export class GuardGrantsRepository extends Context.Service<
  GuardGrantsRepository,
  {
    readonly createBundleGrant: (
      input: CreateGuardBundleGrantInput,
    ) => Effect.Effect<void, GuardGrantsRepositoryError>;
    readonly findActiveByBundleKey: (
      bundleKey: string,
      threadId: string,
    ) => Effect.Effect<Option.Option<StoredGuardBundleGrant>, GuardGrantsRepositoryError>;
    readonly recordBundleUse: (
      grantId: string,
      usedAt: string,
    ) => Effect.Effect<void, GuardGrantsRepositoryError>;
    readonly listActiveBundleGrants: () => Effect.Effect<
      ReadonlyArray<StoredGuardBundleGrant>,
      GuardGrantsRepositoryError
    >;
    readonly revokeBundleGrant: (
      grantId: string,
      revokedAt: string,
      revokedVia: string,
    ) => Effect.Effect<boolean, GuardGrantsRepositoryError>;
    readonly revokeByRepoBranch: (
      repo: string,
      branch: string,
      revokedAt: string,
      revokedVia: string,
    ) => Effect.Effect<number, GuardGrantsRepositoryError>;
    readonly revokeByRepoPr: (
      repo: string,
      prNumber: number,
      revokedAt: string,
      revokedVia: string,
    ) => Effect.Effect<number, GuardGrantsRepositoryError>;
    readonly appendEvent: (
      event: GuardGrantEventRecord,
    ) => Effect.Effect<void, GuardGrantsRepositoryError>;
    readonly listRecentEvents: (
      limit: number,
    ) => Effect.Effect<ReadonlyArray<GuardGrantEventRecord>, GuardGrantsRepositoryError>;
  }
>()("t3/persistence/GuardGrants/GuardGrantsRepository") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  return GuardGrantsRepository.of({
    createBundleGrant: Effect.fn("GuardGrantsRepository.createBundleGrant")(function (input) {
      const repoSlug = normalizeRepoSlug(input.repo);
      return sql`
        INSERT INTO guard_grants (
          grant_id, bundle_key, thread_id, repo, branch, worktree, pr_or_issue,
          guard, gate_ids_json, protected_paths_json, protected_diff_sha256,
          body_sha256, summary, reason, approved_via, signature, created_at, expires_at
        ) VALUES (
          ${input.grantId}, ${input.bundleKey}, ${input.threadId}, ${repoSlug},
          ${input.branch}, ${input.worktree}, ${input.prOrIssue}, ${input.guard},
          ${JSON.stringify(input.gateIds)}, ${JSON.stringify(input.protectedPaths)},
          ${input.protectedDiffSha256}, ${input.bodySha256}, ${input.summary},
          ${input.reason}, ${input.approvedVia}, ${input.signature}, ${input.createdAt},
          ${input.expiresAt}
        )
      `.pipe(Effect.asVoid, Effect.mapError(toPersistenceSqlError("createBundleGrant")));
    }),

    findActiveByBundleKey: Effect.fn("GuardGrantsRepository.findActiveByBundleKey")(
      function* (bundleKey, threadId) {
        const nowIso = DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis));
        return yield* sql<GuardGrantSqlRow>`
        SELECT grant_id, bundle_key, thread_id, repo, branch, worktree, pr_or_issue,
               guard, gate_ids_json, protected_paths_json, protected_diff_sha256,
               body_sha256, summary, reason, approved_via, signature, created_at,
               expires_at, use_count, last_used_at
        FROM guard_grants
        WHERE bundle_key = ${bundleKey}
          AND thread_id = ${threadId}
          AND revoked_at IS NULL
          AND (expires_at IS NULL OR expires_at > ${nowIso})
        ORDER BY created_at DESC
        LIMIT 1
      `.pipe(
          NodeSqliteClient.readOnly,
          Effect.map((rows) =>
            rows[0] ? Option.some(toStoredBundleGrant(rows[0])) : Option.none(),
          ),
          Effect.mapError(toPersistenceSqlError("findActiveByBundleKey")),
        );
      },
    ),

    recordBundleUse: Effect.fn("GuardGrantsRepository.recordBundleUse")(function (grantId, usedAt) {
      return sql`
        UPDATE guard_grants
        SET use_count = use_count + 1, last_used_at = ${usedAt}
        WHERE grant_id = ${grantId} AND revoked_at IS NULL
      `.pipe(Effect.asVoid, Effect.mapError(toPersistenceSqlError("recordBundleUse")));
    }),

    listActiveBundleGrants: Effect.fn("GuardGrantsRepository.listActiveBundleGrants")(function* () {
      const nowIso = DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis));
      return yield* sql<GuardGrantSqlRow>`
        SELECT grant_id, bundle_key, thread_id, repo, branch, worktree, pr_or_issue,
               guard, gate_ids_json, protected_paths_json, protected_diff_sha256,
               body_sha256, summary, reason, approved_via, signature, created_at,
               expires_at, use_count, last_used_at
        FROM guard_grants
        WHERE revoked_at IS NULL
          AND (expires_at IS NULL OR expires_at > ${nowIso})
        ORDER BY created_at DESC
        LIMIT 256
      `.pipe(
        NodeSqliteClient.readOnly,
        Effect.map((rows) => rows.map(toStoredBundleGrant)),
        Effect.mapError(toPersistenceSqlError("listActiveBundleGrants")),
      );
    }),

    revokeBundleGrant: Effect.fn("GuardGrantsRepository.revokeBundleGrant")(
      function (grantId, revokedAt, revokedVia) {
        return sql<{ readonly grant_id: string }>`
        UPDATE guard_grants
        SET revoked_at = ${revokedAt}, revoked_via = ${revokedVia}
        WHERE grant_id = ${grantId} AND revoked_at IS NULL
        RETURNING grant_id
      `.pipe(
          Effect.map((rows) => rows.length > 0),
          Effect.mapError(toPersistenceSqlError("revokeBundleGrant")),
        );
      },
    ),

    revokeByRepoBranch: Effect.fn("GuardGrantsRepository.revokeByRepoBranch")(
      function (repo, branch, revokedAt, revokedVia) {
        const repoSlug = normalizeRepoSlug(repo);
        return sql<{ readonly grant_id: string }>`
        UPDATE guard_grants
        SET revoked_at = ${revokedAt}, revoked_via = ${revokedVia}
        WHERE LOWER(repo) = ${repoSlug} AND branch = ${branch} AND revoked_at IS NULL
        RETURNING grant_id
      `.pipe(
          Effect.map((rows) => rows.length),
          Effect.mapError(toPersistenceSqlError("revokeByRepoBranch")),
        );
      },
    ),

    revokeByRepoPr: Effect.fn("GuardGrantsRepository.revokeByRepoPr")(
      function (repo, prNumber, revokedAt, revokedVia) {
        const repoSlug = normalizeRepoSlug(repo);
        const plain = String(prNumber);
        const hashed = `#${prNumber}`;
        const slugHashed = `${repoSlug}#${prNumber}`;
        return sql<{ readonly grant_id: string }>`
        UPDATE guard_grants
        SET revoked_at = ${revokedAt}, revoked_via = ${revokedVia}
        WHERE LOWER(repo) = ${repoSlug}
          AND LOWER(pr_or_issue) IN (${plain}, ${hashed}, ${slugHashed})
          AND revoked_at IS NULL
        RETURNING grant_id
      `.pipe(
          Effect.map((rows) => rows.length),
          Effect.mapError(toPersistenceSqlError("revokeByRepoPr")),
        );
      },
    ),

    appendEvent: Effect.fn("GuardGrantsRepository.appendEvent")(function (event) {
      return sql`
        INSERT INTO guard_grant_events (
          ts, event_type, request_id, grant_id, thread_id, guard, scope,
          argv_sha256, command_json, summary, reason
        ) VALUES (
          ${event.ts}, ${event.eventType}, ${event.requestId ?? null}, ${event.grantId ?? null},
          ${event.threadId}, ${event.guard}, ${event.scope}, ${event.argvSha256},
          ${JSON.stringify(event.command)}, ${event.summary}, ${event.reason}
        )
      `.pipe(Effect.asVoid, Effect.mapError(toPersistenceSqlError("appendEvent")));
    }),

    listRecentEvents: Effect.fn("GuardGrantsRepository.listRecentEvents")(function (limit) {
      const capped = Math.max(1, Math.min(200, Math.floor(limit)));
      return sql<GuardGrantEventSqlRow>`
        SELECT ts, event_type, request_id, grant_id, thread_id, guard, scope,
               argv_sha256, command_json, summary, reason
        FROM guard_grant_events
        ORDER BY id DESC
        LIMIT ${capped}
      `.pipe(
        NodeSqliteClient.readOnly,
        Effect.map((rows) =>
          rows.map((row) => ({
            ts: row.ts,
            eventType: row.event_type as GuardGrantEventType,
            ...(row.request_id ? { requestId: row.request_id } : {}),
            ...(row.grant_id ? { grantId: row.grant_id } : {}),
            threadId: row.thread_id,
            guard: row.guard,
            scope: (row.scope === "bundle" || row.scope === "secret" ? row.scope : "once") as
              | "once"
              | "bundle"
              | "secret",
            argvSha256: row.argv_sha256,
            command: parseJsonStringArray(row.command_json),
            summary: row.summary,
            reason: row.reason,
          })),
        ),
        Effect.mapError(toPersistenceSqlError("listRecentEvents")),
      );
    }),
  });
});

export const layer = Layer.effect(GuardGrantsRepository, make);

export type GuardGrantsRepositoryShape = GuardGrantsRepository["Service"];

export const makeGuardBundlePersistenceEffect = Effect.fn("GuardGrants.makeBundlePersistence")(
  function* (repo: GuardGrantsRepositoryShape) {
    const services = yield* Effect.context<never>();
    return makeGuardBundlePersistence(repo, Effect.runPromiseWith(services));
  },
);

function makeGuardBundlePersistence(
  repo: GuardGrantsRepositoryShape,
  runPromise: <A, E>(eff: Effect.Effect<A, E>) => Promise<A>,
) {
  return {
    createBundleGrant: (input: CreateGuardBundleGrantInput) =>
      runPromise(repo.createBundleGrant(input)),
    findActiveByBundleKey: (bundleKey: string, threadId: string) =>
      runPromise(
        repo.findActiveByBundleKey(bundleKey, threadId).pipe(Effect.map(Option.getOrNull)),
      ),
    recordBundleUse: (grantId: string, usedAt: string) =>
      runPromise(repo.recordBundleUse(grantId, usedAt)),
    listActiveBundleGrants: () => runPromise(repo.listActiveBundleGrants()),
    revokeBundleGrant: (grantId: string, revokedAt: string, revokedVia: string) =>
      runPromise(repo.revokeBundleGrant(grantId, revokedAt, revokedVia)),
    revokeByRepoBranch: (repoName: string, branch: string, revokedAt: string, revokedVia: string) =>
      runPromise(repo.revokeByRepoBranch(repoName, branch, revokedAt, revokedVia)),
    revokeByRepoPr: (repoName: string, prNumber: number, revokedAt: string, revokedVia: string) =>
      runPromise(repo.revokeByRepoPr(repoName, prNumber, revokedAt, revokedVia)),
    appendEvent: (event: GuardGrantEventRecord) => runPromise(repo.appendEvent(event)),
    listRecentEvents: (limit: number) => runPromise(repo.listRecentEvents(limit)),
  };
}
