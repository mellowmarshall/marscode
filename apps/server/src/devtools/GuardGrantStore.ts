// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Unified store for once-grants, signed SQLite bundle grants, 24h secret grants, and audit events.
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";

import { normalizeRepoSlug, normalizeSortedUnique } from "@t3tools/guard-protocol/digests";
import {
  sanitizeText,
  validateGuardAndCommand,
  type ActiveGuardBundleGrant,
  type ActiveSecretGrant,
  type GuardBundleSpec,
  type UnifiedActiveGrant,
} from "@t3tools/guard-protocol/protocol";
import {
  BUNDLE_GRANT_MAX_AGE_MS,
  ensureGuardSigningKeyPair,
  generateGuardSigningKeyPair,
  signBundleGrant,
  verifyBundleGrant,
  type GuardSigningKeyPair,
} from "@t3tools/guard-protocol/signing";

import type { GuardGrantEventRecord, StoredGuardBundleGrant } from "../persistence/GuardGrants.ts";
import { SECRET_GRANT_PREFIX } from "../secrets/SecretGrantIndex.ts";
import { readLegacyAuditTail } from "./GuardAuditFiles.ts";
import {
  bundleKeyOf,
  onceGrantKey,
  type GuardBundlePersistence,
  type SecretGrantProvider,
  type StoredOnceGrant,
} from "./GuardBrokerTypes.ts";
import { canonicalCwd, resolveConfiguredStateDir } from "./GuardSocketPath.ts";

function memoryBundleKey(bundleKey: string, threadId: string): string {
  return `${bundleKey}\0${threadId}`;
}

function toPublicBundleGrant(row: StoredGuardBundleGrant): ActiveGuardBundleGrant {
  return {
    kind: "guard_bundle",
    grantId: row.grantId,
    threadId: row.threadId,
    repo: row.repo,
    branch: row.branch,
    prOrIssue: row.prOrIssue,
    guard: row.guard,
    gateIds: row.gateIds,
    protectedPaths: row.protectedPaths,
    protectedDiffSha256: row.protectedDiffSha256,
    bodySha256: row.bodySha256,
    summary: row.summary,
    reason: row.reason,
    approvedVia: row.approvedVia,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    useCount: row.useCount,
    lastUsedAt: row.lastUsedAt,
  };
}

export class GuardGrantStore {
  private readonly preapproved = new Map<string, StoredOnceGrant>();
  private readonly memoryBundles = new Map<string, StoredGuardBundleGrant>();
  private readonly signingKeyPair: GuardSigningKeyPair | null;
  private readonly bundlePersistence: GuardBundlePersistence | undefined;
  private readonly secretGrants: SecretGrantProvider | undefined;
  private readonly auditLogPathOverride: string | undefined;
  private readonly maxPreapproved: number;

  constructor(options: {
    readonly maxPreapproved: number;
    readonly signingStateDir?: string | undefined;
    readonly bundlePersistence?: GuardBundlePersistence | undefined;
    readonly secretGrants?: SecretGrantProvider | undefined;
    readonly auditLogPath?: string | undefined;
  }) {
    this.maxPreapproved = options.maxPreapproved;
    this.bundlePersistence = options.bundlePersistence;
    this.secretGrants = options.secretGrants;
    this.auditLogPathOverride = options.auditLogPath;
    if (options.signingStateDir) {
      let loaded: GuardSigningKeyPair | null = null;
      try {
        loaded = ensureGuardSigningKeyPair(options.signingStateDir);
      } catch {
        // Fail closed on corrupted/bad-permission signing keys: disable bundle grants without blocking server startup.
        loaded = null;
      }
      this.signingKeyPair = loaded;
    } else {
      this.signingKeyPair = generateGuardSigningKeyPair();
    }
  }

  get canSignBundles(): boolean {
    return this.signingKeyPair !== null;
  }

  get publicKeyPem(): string {
    return this.signingKeyPair?.publicKeyPem ?? "";
  }

  private verifyStoredBundle(row: StoredGuardBundleGrant, nowMs = Date.now()): boolean {
    if (!this.signingKeyPair || !row.signature) return false;
    return verifyBundleGrant(
      {
        v: 1,
        grantId: row.grantId,
        bundleKey: row.bundleKey,
        threadId: row.threadId,
        repo: row.repo,
        branch: row.branch,
        prOrIssue: row.prOrIssue,
        guard: row.guard,
        gateIds: row.gateIds,
        protectedPaths: row.protectedPaths,
        protectedDiffSha256: row.protectedDiffSha256,
        bodySha256: row.bodySha256,
        approvedAt: row.createdAt,
        expiresAt: row.expiresAt,
        approvedVia: row.approvedVia,
      },
      row.signature,
      this.signingKeyPair.publicKeyPem,
      nowMs,
    );
  }

  clearOnceGrants(): void {
    this.preapproved.clear();
  }

  pruneExpiredOnce(): void {
    const now = Date.now();
    for (const [k, grant] of this.preapproved) {
      if (grant.expiresAtMs <= now) this.preapproved.delete(k);
    }
  }

  canAddOnceGrant(): boolean {
    this.pruneExpiredOnce();
    return this.preapproved.size < this.maxPreapproved;
  }

  preapproveOnce(input: {
    readonly guard: string;
    readonly command: ReadonlyArray<string>;
    readonly cwd: string;
    readonly reason?: string | undefined;
    readonly threadId?: string | undefined;
    readonly ttlMs: number;
    readonly approvedVia?: string | undefined;
  }):
    | { readonly ok: true; readonly grantId: string; readonly expiresAt: string }
    | { readonly ok: false; readonly error: string } {
    const validated = validateGuardAndCommand(input.guard, input.command);
    if (!validated.ok) return validated;
    if (!this.canAddOnceGrant()) {
      return { ok: false, error: "too many pre-approved grants pending" };
    }
    const expiresAtMs = Date.now() + Math.max(5_000, Math.min(3_600_000, input.ttlMs));
    const grantId = `t3g_${NodeCrypto.randomBytes(12).toString("hex")}`;
    this.putOnceGrant({
      grantId,
      guard: validated.guard,
      argvSha256: validated.digest,
      cwd: canonicalCwd(input.cwd),
      reason: sanitizeText(input.reason, 400) || "approved in T3 Code",
      approvedBy: "human",
      approvedVia: input.approvedVia,
      threadId: sanitizeText(input.threadId, 128),
      expiresAtMs,
    });
    return { ok: true, grantId, expiresAt: new Date(expiresAtMs).toISOString() };
  }

  putOnceGrant(grant: StoredOnceGrant): void {
    this.preapproved.set(
      onceGrantKey(grant.guard, grant.argvSha256, grant.cwd, grant.threadId),
      grant,
    );
  }

  lookupOnce(
    guard: string,
    digest: string,
    cwd: string,
    threadId: string,
  ): { readonly key: string; readonly grant: StoredOnceGrant } | null {
    this.pruneExpiredOnce();
    if (threadId) {
      const exactKey = onceGrantKey(guard, digest, cwd, threadId);
      const exact = this.preapproved.get(exactKey);
      if (exact) return { key: exactKey, grant: exact };
    }
    const unscopedKey = onceGrantKey(guard, digest, cwd, "");
    const unscoped = this.preapproved.get(unscopedKey);
    return unscoped ? { key: unscopedKey, grant: unscoped } : null;
  }

  deleteOnce(key: string): void {
    this.preapproved.delete(key);
  }

  async lookupBundle(
    guard: string,
    bundle: GuardBundleSpec,
    threadId: string,
  ): Promise<StoredGuardBundleGrant | null> {
    if (!threadId) return null;
    const bKey = bundleKeyOf(guard, bundle);
    const row = this.bundlePersistence
      ? await this.bundlePersistence.findActiveByBundleKey(bKey, threadId).catch(() => null)
      : (this.memoryBundles.get(memoryBundleKey(bKey, threadId)) ?? null);
    if (!row) return null;
    if (row.threadId !== threadId || row.bundleKey !== bKey) return null;
    if (!this.verifyStoredBundle(row)) return null;
    return row;
  }

  createSignedBundle(input: {
    readonly grantId: string;
    readonly guard: string;
    readonly threadId: string;
    readonly cwd: string;
    readonly bundle: GuardBundleSpec;
    readonly reason: string;
    readonly approvedVia: string;
    readonly nowIso: string;
    readonly initialUseCount: number;
    readonly onPersisted: () => void;
  }): { readonly signature: string; readonly persisted: Promise<boolean> } {
    if (!this.signingKeyPair) {
      return { signature: "", persisted: Promise.resolve(false) };
    }
    const bKey = bundleKeyOf(input.guard, input.bundle);
    const repoSlug = normalizeRepoSlug(input.bundle.repo);
    const gateIds = normalizeSortedUnique(input.bundle.gates.map((g) => g.gateId));
    const createdMs = Date.parse(input.nowIso);
    const expiresAt = new Date(
      (Number.isFinite(createdMs) ? createdMs : Date.now()) + BUNDLE_GRANT_MAX_AGE_MS,
    ).toISOString();
    const signature = signBundleGrant(
      {
        v: 1,
        grantId: input.grantId,
        bundleKey: bKey,
        threadId: input.threadId,
        repo: repoSlug,
        branch: input.bundle.branch,
        prOrIssue: input.bundle.prOrIssue,
        guard: input.guard,
        gateIds,
        protectedPaths: input.bundle.protectedPaths,
        protectedDiffSha256: input.bundle.protectedDiffSha256,
        bodySha256: input.bundle.bodySha256,
        approvedAt: input.nowIso,
        expiresAt,
        approvedVia: input.approvedVia,
      },
      this.signingKeyPair.privateKeyPem,
    );
    if (this.bundlePersistence) {
      const persisted = this.bundlePersistence
        .createBundleGrant({
          grantId: input.grantId,
          bundleKey: bKey,
          threadId: input.threadId,
          repo: repoSlug,
          branch: input.bundle.branch,
          worktree: input.cwd,
          prOrIssue: input.bundle.prOrIssue,
          guard: input.guard,
          gateIds,
          protectedPaths: input.bundle.protectedPaths,
          protectedDiffSha256: input.bundle.protectedDiffSha256,
          bodySha256: input.bundle.bodySha256,
          summary: input.bundle.summary,
          reason: input.reason,
          approvedVia: input.approvedVia,
          signature,
          createdAt: input.nowIso,
          expiresAt,
        })
        .then(() => {
          input.onPersisted();
          return true;
        })
        .catch(() => false);
      return { signature, persisted };
    }

    this.memoryBundles.set(memoryBundleKey(bKey, input.threadId), {
      kind: "guard_bundle",
      grantId: input.grantId,
      bundleKey: bKey,
      threadId: input.threadId,
      repo: repoSlug,
      branch: input.bundle.branch,
      worktree: input.cwd,
      prOrIssue: input.bundle.prOrIssue,
      guard: input.guard,
      gateIds,
      protectedPaths: input.bundle.protectedPaths,
      protectedDiffSha256: input.bundle.protectedDiffSha256,
      bodySha256: input.bundle.bodySha256,
      summary: input.bundle.summary,
      reason: input.reason,
      approvedVia: input.approvedVia,
      signature,
      createdAt: input.nowIso,
      expiresAt,
      useCount: input.initialUseCount,
      lastUsedAt: input.initialUseCount > 0 ? input.nowIso : null,
    });
    input.onPersisted();
    return { signature, persisted: Promise.resolve(true) };
  }

  recordBundleUse(grant: StoredGuardBundleGrant, nowIso: string, onUpdated: () => void): void {
    if (this.bundlePersistence) {
      void this.bundlePersistence
        .recordBundleUse(grant.grantId, nowIso)
        .then(() => onUpdated())
        .catch(() => {});
      return;
    }
    this.memoryBundles.set(memoryBundleKey(grant.bundleKey, grant.threadId), {
      ...grant,
      useCount: grant.useCount + 1,
      lastUsedAt: nowIso,
    });
    onUpdated();
  }

  async listActiveGrants(): Promise<ReadonlyArray<UnifiedActiveGrant>> {
    const nowMs = Date.now();
    const rawBundles: ReadonlyArray<StoredGuardBundleGrant> = this.bundlePersistence
      ? await this.bundlePersistence.listActiveBundleGrants().catch(() => [])
      : Array.from(this.memoryBundles.values());
    const bundleGrants: ReadonlyArray<ActiveGuardBundleGrant> = rawBundles
      .filter((row) => this.verifyStoredBundle(row, nowMs))
      .map(toPublicBundleGrant);
    const secretGrants: ReadonlyArray<ActiveSecretGrant> = this.secretGrants
      ? await this.secretGrants.listActiveGrants().catch(() => [])
      : [];
    return [...bundleGrants, ...secretGrants].toSorted((a, b) =>
      a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0,
    );
  }

  async revokeGrant(grantId: string, revokedVia: string): Promise<boolean> {
    const nowIso = new Date().toISOString();
    let revoked = false;
    const isSecret = grantId.startsWith(SECRET_GRANT_PREFIX);
    if (isSecret && this.secretGrants) {
      revoked = await this.secretGrants.revokeGrant(grantId).catch(() => false);
    } else if (!isSecret && this.bundlePersistence) {
      revoked = await this.bundlePersistence
        .revokeBundleGrant(grantId, nowIso, revokedVia)
        .catch(() => false);
    } else if (!isSecret) {
      for (const [key, item] of this.memoryBundles) {
        if (item.grantId === grantId) {
          this.memoryBundles.delete(key);
          revoked = true;
          break;
        }
      }
    }
    if (revoked) {
      this.recordEvent({
        ts: nowIso,
        eventType: "revoked",
        grantId,
        threadId: "",
        guard: isSecret ? "secret-access" : "guard-bundle",
        scope: isSecret ? "secret" : "bundle",
        argvSha256: "",
        command: [],
        summary: isSecret ? "Revoked 24h secret access" : "Revoked bundled diff grant",
        reason: revokedVia,
      });
    }
    return revoked;
  }

  async invalidateRepoBranch(repo: string, branch: string, reason: string): Promise<number> {
    const repoSlug = normalizeRepoSlug(repo);
    const nowIso = new Date().toISOString();
    if (this.bundlePersistence) {
      return await this.bundlePersistence
        .revokeByRepoBranch(repoSlug, branch, nowIso, reason)
        .catch(() => 0);
    }
    let count = 0;
    for (const [key, item] of this.memoryBundles) {
      if (normalizeRepoSlug(item.repo) === repoSlug && item.branch === branch) {
        this.memoryBundles.delete(key);
        count += 1;
      }
    }
    return count;
  }

  async invalidateRepoPr(repo: string, prNumber: number, reason: string): Promise<number> {
    const repoSlug = normalizeRepoSlug(repo);
    const nowIso = new Date().toISOString();
    if (this.bundlePersistence?.revokeByRepoPr) {
      return await this.bundlePersistence
        .revokeByRepoPr(repoSlug, prNumber, nowIso, reason)
        .catch(() => 0);
    }
    const plain = String(prNumber);
    const hashed = `#${prNumber}`;
    const slugHashed = `${repoSlug}#${prNumber}`;
    let count = 0;
    for (const [key, item] of this.memoryBundles) {
      const refLower = item.prOrIssue.toLowerCase();
      if (
        normalizeRepoSlug(item.repo) === repoSlug &&
        (refLower === plain || refLower === hashed || refLower === slugHashed)
      ) {
        this.memoryBundles.delete(key);
        count += 1;
      }
    }
    return count;
  }

  recordEvent(event: GuardGrantEventRecord): void {
    if (!this.bundlePersistence) return;
    void this.bundlePersistence.appendEvent(event).catch(() => {});
  }

  readLegacyAudit(limit = 50): ReadonlyArray<Record<string, unknown>> {
    const logPath =
      this.auditLogPathOverride ?? NodePath.join(resolveConfiguredStateDir(), "overrides.log");
    return readLegacyAuditTail(logPath, limit);
  }

  async readCombinedAudit(limit = 50): Promise<ReadonlyArray<Record<string, unknown>>> {
    const legacy = this.readLegacyAudit(limit);
    const dbEvents = this.bundlePersistence
      ? await this.bundlePersistence.listRecentEvents(limit).catch(() => [])
      : [];
    const normalizedDb: Array<Record<string, unknown>> = dbEvents.map((ev) => ({
      ts: ev.ts,
      eventType: ev.eventType,
      guard: ev.guard,
      scope: ev.scope,
      thread_id: ev.threadId,
      grant_id: ev.grantId,
      summary: ev.summary,
      reason: ev.reason,
      command: ev.command,
      source: "t3-broker",
    }));
    const merged = [...normalizedDb, ...legacy];
    merged.sort((a, b) => {
      const ta = typeof a.ts === "string" ? a.ts : "";
      const tb = typeof b.ts === "string" ? b.ts : "";
      return ta < tb ? 1 : ta > tb ? -1 : 0;
    });
    return merged.slice(0, Math.max(1, Math.min(200, Math.floor(limit))));
  }
}
