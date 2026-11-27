// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off - Server-owned 0600 Unix socket broker matching @t3tools/guard-protocol.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";

import {
  sanitizeText,
  type GuardBrokerEvent,
  type GuardGrantScope,
  type PendingGuardRequest,
  type UnifiedActiveGrant,
} from "@t3tools/guard-protocol/protocol";

import { readExceptionsFile } from "./GuardAuditFiles.ts";
import type {
  GuardBundlePersistence,
  GuardGrantBrokerOptions,
  PendingEntry,
  SecretGrantProvider,
} from "./GuardBrokerTypes.ts";
import { GuardGrantStore } from "./GuardGrantStore.ts";
import { defaultResolvePeerThreadId, type PeerThreadResolution } from "./GuardPeerIdentity.ts";
import {
  defaultGuardSocketPath,
  ensurePrivateParentDir,
  probeSocketAlive,
} from "./GuardSocketPath.ts";
import { attachGuardSocketReader, writeAndCloseSocket } from "./GuardSocketProtocol.ts";

export type {
  GuardBrokerEvent,
  GuardBundlePersistence,
  GuardGrantBrokerOptions,
  PeerThreadResolution,
  PendingGuardRequest,
  SecretGrantProvider,
};
export { redactArgvCommand } from "@t3tools/guard-protocol/redaction";

const MAX_PENDING_DEFAULT = 64;
const MAX_PREAPPROVED_DEFAULT = 256;
const MAX_CONNECTIONS = 128;
const DEFAULT_GRANT_TTL_MS = 15 * 60 * 1000;
const DEFAULT_REQUEST_TIMEOUT_MS = 300_000;
const MIN_REQUEST_TIMEOUT_MS = 5_000;
const MAX_REQUEST_TIMEOUT_MS = 600_000;

export class GuardGrantBroker {
  readonly socketPath: string;
  private defaultGrantTtlMs: number;
  private defaultRequestTimeoutMs: number;
  private readonly maxPending: number;
  private readonly exceptionsPathsOverride: ReadonlyArray<string> | undefined;
  private readonly store: GuardGrantStore;
  private readonly resolvePeerThreadId: (
    socket: NodeNet.Socket,
    platform: NodeJS.Platform,
  ) => Promise<PeerThreadResolution>;
  private readonly hasCustomResolver: boolean;

  private server: NodeNet.Server | null = null;
  private startPromise: Promise<void> | null = null;
  private platform: NodeJS.Platform = "linux";
  private boundStat: { readonly dev: number; readonly ino: number } | null = null;
  private readonly activeSockets = new Set<NodeNet.Socket>();
  private readonly pending = new Map<string, PendingEntry>();
  private readonly subscribers = new Set<(event: GuardBrokerEvent) => void>();
  private unsubscribeSecrets: (() => void) | null = null;
  private closed = false;

  constructor(options: GuardGrantBrokerOptions = {}) {
    this.socketPath = options.socketPath ?? defaultGuardSocketPath();
    this.defaultGrantTtlMs = options.defaultGrantTtlMs ?? DEFAULT_GRANT_TTL_MS;
    this.defaultRequestTimeoutMs = options.defaultRequestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.maxPending = options.maxPending ?? MAX_PENDING_DEFAULT;
    this.exceptionsPathsOverride = options.exceptionsPaths;
    this.store = new GuardGrantStore({
      maxPreapproved: options.maxPreapproved ?? MAX_PREAPPROVED_DEFAULT,
      signingStateDir: options.signingStateDir,
      bundlePersistence: options.bundlePersistence,
      secretGrants: options.secretGrants,
      auditLogPath: options.auditLogPath,
    });
    this.hasCustomResolver = options.resolvePeerThreadId !== undefined;
    const getTrustedCodexAppServers = options.getTrustedCodexAppServers;
    this.resolvePeerThreadId =
      options.resolvePeerThreadId ??
      ((socket, platform) =>
        defaultResolvePeerThreadId(socket, platform, getTrustedCodexAppServers?.()));
    if (options.secretGrants?.subscribeGrants) {
      this.unsubscribeSecrets = options.secretGrants.subscribeGrants(() => {
        void this.broadcastGrantsChanged();
      });
    }
  }

  get listening(): boolean {
    return this.server !== null && this.server.listening && !this.closed;
  }

  get publicKeyPem(): string {
    return this.store.publicKeyPem;
  }

  setRuntimeTimeouts(options: {
    readonly defaultGrantTtlMs?: number | undefined;
    readonly defaultRequestTimeoutMs?: number | undefined;
  }): void {
    if (
      typeof options.defaultGrantTtlMs === "number" &&
      Number.isFinite(options.defaultGrantTtlMs) &&
      options.defaultGrantTtlMs >= 10_000 &&
      options.defaultGrantTtlMs <= 3_600_000
    ) {
      this.defaultGrantTtlMs = Math.round(options.defaultGrantTtlMs);
    }
    if (
      typeof options.defaultRequestTimeoutMs === "number" &&
      Number.isFinite(options.defaultRequestTimeoutMs) &&
      options.defaultRequestTimeoutMs >= MIN_REQUEST_TIMEOUT_MS &&
      options.defaultRequestTimeoutMs <= MAX_REQUEST_TIMEOUT_MS
    ) {
      this.defaultRequestTimeoutMs = Math.round(options.defaultRequestTimeoutMs);
    }
  }

  start(platform: NodeJS.Platform = "linux"): Promise<void> {
    this.platform = platform;
    if (this.closed || platform === "win32") return Promise.resolve();
    if (platform !== "linux" && !this.hasCustomResolver) return Promise.resolve();
    if (this.server) return Promise.resolve();
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.doStart().finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  private async doStart(): Promise<void> {
    ensurePrivateParentDir(this.socketPath);
    try {
      const existing = NodeFS.lstatSync(this.socketPath);
      if (!existing.isSocket()) {
        throw new Error(`Refusing to replace non-socket path at ${this.socketPath}`);
      }
      const alive = await probeSocketAlive(this.socketPath);
      if (alive) {
        throw new Error(`Guard socket ${this.socketPath} is already owned by a live broker`);
      }
      if (this.closed) return;
      const recheck = NodeFS.lstatSync(this.socketPath);
      if (recheck.isSocket() && recheck.dev === existing.dev && recheck.ino === existing.ino) {
        NodeFS.unlinkSync(this.socketPath);
      } else {
        throw new Error(`Guard socket ${this.socketPath} was replaced during startup`);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
    }
    if (this.closed) return;

    const protocolCtx = {
      isClosed: () => this.closed,
      getDefaultRequestTimeoutMs: () => this.defaultRequestTimeoutMs,
      maxPending: this.maxPending,
      pending: this.pending,
      store: this.store,
      resolvePeer: (sock: NodeNet.Socket) => this.resolvePeerThreadId(sock, this.platform),
      emit: (ev: GuardBrokerEvent) => this.emit(ev),
      broadcastGrantsChanged: () => void this.broadcastGrantsChanged(),
      finishPending: (
        entry: PendingEntry,
        decision: "approved" | "denied" | "expired" | "disconnected",
        payload: Record<string, unknown>,
      ) => this.finishPending(entry, decision, payload),
    };

    const server = NodeNet.createServer((socket) =>
      attachGuardSocketReader(socket, this.activeSockets, protocolCtx),
    );
    server.maxConnections = MAX_CONNECTIONS;
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        server.removeListener("listening", onListening);
        reject(err);
      };
      const onListening = () => {
        server.removeListener("error", onError);
        try {
          NodeFS.chmodSync(this.socketPath, 0o600);
          const st = NodeFS.lstatSync(this.socketPath);
          this.boundStat = { dev: st.dev, ino: st.ino };
        } catch {
          // best-effort; parent dir is 0700
        }
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(this.socketPath);
    });
    if (this.closed) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      this.unlinkOwnedSocket();
      return;
    }
    server.on("error", () => {});
    this.server = server;
  }

  private unlinkOwnedSocket(): void {
    const owned = this.boundStat;
    this.boundStat = null;
    if (!owned) return;
    try {
      const st = NodeFS.lstatSync(this.socketPath);
      if (st.isSocket() && st.dev === owned.dev && st.ino === owned.ino) {
        NodeFS.unlinkSync(this.socketPath);
      }
    } catch {
      // ignore
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.unsubscribeSecrets?.();
    this.unsubscribeSecrets = null;
    if (this.startPromise) {
      await this.startPromise.catch(() => {});
    }
    for (const entry of this.pending.values()) {
      this.finishPending(entry, "disconnected", {
        ok: false,
        denied: false,
        error: "T3 Code server shutting down",
      });
    }
    this.pending.clear();
    this.store.clearOnceGrants();
    for (const socket of this.activeSockets) socket.destroy();
    this.activeSockets.clear();
    const server = this.server;
    this.server = null;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    this.unlinkOwnedSocket();
  }

  listPending(): ReadonlyArray<PendingGuardRequest> {
    return Array.from(this.pending.values(), (entry) => entry.request);
  }

  listActiveGrants(): Promise<ReadonlyArray<UnifiedActiveGrant>> {
    return this.store.listActiveGrants();
  }

  async revokeGrant(grantId: string, revokedVia = "t3-security-settings"): Promise<boolean> {
    const revoked = await this.store.revokeGrant(grantId, revokedVia);
    if (revoked) await this.broadcastGrantsChanged();
    return revoked;
  }

  async invalidateRepoBranch(repo: string, branch: string, reason = "pr-merged"): Promise<number> {
    const count = await this.store.invalidateRepoBranch(repo, branch, reason);
    if (count > 0) await this.broadcastGrantsChanged();
    return count;
  }

  async invalidateRepoPr(repo: string, prNumber: number, reason = "pr-merged"): Promise<number> {
    const count = await this.store.invalidateRepoPr(repo, prNumber, reason);
    if (count > 0) await this.broadcastGrantsChanged();
    return count;
  }

  subscribe(listener: (event: GuardBrokerEvent) => void): () => void {
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }

  private emit(event: GuardBrokerEvent): void {
    for (const listener of this.subscribers) {
      try {
        listener(event);
      } catch {
        // isolate subscriber failures
      }
    }
  }

  private async broadcastGrantsChanged(): Promise<void> {
    if (this.closed || this.subscribers.size === 0) return;
    const grants = await this.store.listActiveGrants();
    this.emit({ type: "grants_changed", grants });
  }

  preapprove(input: {
    readonly guard: string;
    readonly command: ReadonlyArray<string>;
    readonly cwd: string;
    readonly reason?: string | undefined;
    readonly threadId?: string | undefined;
    readonly ttlMs?: number | undefined;
    readonly approvedVia?: string | undefined;
  }):
    | { readonly ok: true; readonly grantId: string; readonly expiresAt: string }
    | { readonly ok: false; readonly error: string } {
    if (!this.listening) return { ok: false, error: "guard grant broker is not listening" };
    return this.store.preapproveOnce({
      ...input,
      ttlMs: input.ttlMs ?? this.defaultGrantTtlMs,
    });
  }

  resolveRequest(
    requestId: string,
    input: {
      readonly decision: "approve" | "deny";
      readonly scope?: GuardGrantScope | undefined;
      readonly reason?: string | undefined;
      readonly approvedVia?: string | undefined;
    },
  ): {
    readonly found: boolean;
    readonly grantId?: string;
    readonly scope?: GuardGrantScope;
    readonly persisted?: Promise<boolean>;
  } {
    const entry = this.pending.get(requestId);
    if (!entry || entry.settled) return { found: false };
    const req = entry.request;
    const nowIso = new Date().toISOString();

    if (input.decision === "approve") {
      const grantId = `t3g_${NodeCrypto.randomBytes(12).toString("hex")}`;
      const reason = sanitizeText(input.reason, 400) || req.proposedReason || "approved in T3 Code";
      const wantBundle =
        input.scope === "bundle" &&
        this.store.canSignBundles &&
        req.threadId.length > 0 &&
        req.bundleEligible &&
        req.bundle !== undefined;
      const effectiveScope: GuardGrantScope = wantBundle ? "bundle" : "once";
      const approvedVia = input.approvedVia ?? "t3-input-request";

      if (wantBundle && req.bundle) {
        entry.settled = true;
        clearTimeout(entry.timer);
        this.pending.delete(req.requestId);
        const created = this.store.createSignedBundle({
          grantId,
          guard: req.guard,
          threadId: req.threadId,
          cwd: req.cwd,
          bundle: req.bundle,
          reason,
          approvedVia,
          nowIso,
          initialUseCount: entry.sockets.size > 0 ? 1 : 0,
          onPersisted: () => void this.broadcastGrantsChanged(),
        });
        const persisted = created.persisted.then((ok) => {
          if (!ok) {
            this.flushPendingSockets(entry, "denied", {
              ok: false,
              denied: false,
              error: "failed to persist bundle grant",
            });
            return false;
          }
          this.recordDecisionEvent(req, "approved", "bundle", nowIso, reason, grantId);
          this.flushPendingSockets(entry, "approved", {
            ok: true,
            grant_id: grantId,
            scope: "bundle",
            reason,
            approved_by: "human",
            ...(input.approvedVia ? { approved_via: input.approvedVia } : {}),
            signature: created.signature,
            thread_id: req.threadId,
          });
          return true;
        });
        return { found: true, grantId, scope: "bundle", persisted };
      }

      if (entry.sockets.size === 0) {
        if (!req.threadId) {
          this.finishPending(entry, "denied", {
            ok: false,
            denied: true,
            error: "override requests require a verified thread_id",
          });
          return { found: true };
        }
        this.store.pruneExpiredOnce();
        this.store.putOnceGrant({
          grantId,
          guard: req.guard,
          argvSha256: req.argvSha256,
          cwd: req.cwd,
          reason,
          approvedBy: "human",
          approvedVia: input.approvedVia,
          threadId: req.threadId,
          expiresAtMs: Date.now() + this.defaultGrantTtlMs,
        });
      }

      this.recordDecisionEvent(req, "approved", effectiveScope, nowIso, reason, grantId);
      this.finishPending(entry, "approved", {
        ok: true,
        grant_id: grantId,
        scope: effectiveScope,
        reason,
        approved_by: "human",
        ...(input.approvedVia ? { approved_via: input.approvedVia } : {}),
        thread_id: req.threadId,
      });
      return { found: true, grantId, scope: effectiveScope };
    }

    const reason = sanitizeText(input.reason, 400) || "denied by owner in T3 Code";
    this.recordDecisionEvent(req, "denied", req.bundleEligible ? "bundle" : "once", nowIso, reason);
    this.finishPending(entry, "denied", { ok: false, denied: true, error: reason });
    return { found: true };
  }

  private recordDecisionEvent(
    req: PendingGuardRequest,
    eventType: "approved" | "denied",
    scope: GuardGrantScope,
    ts: string,
    reason: string,
    grantId?: string,
  ): void {
    this.store.recordEvent({
      ts,
      eventType,
      requestId: req.requestId,
      ...(grantId ? { grantId } : {}),
      threadId: req.threadId,
      guard: req.guard,
      scope,
      argvSha256: req.argvSha256,
      command: req.command,
      summary: req.bundle?.summary ?? req.command.slice(0, 3).join(" "),
      reason,
    });
  }

  readAuditTail(limit = 50): ReadonlyArray<Record<string, unknown>> {
    return this.store.readLegacyAudit(limit);
  }

  readCombinedAudit(limit = 50): Promise<ReadonlyArray<Record<string, unknown>>> {
    return this.store.readCombinedAudit(limit);
  }

  readExceptions(): { readonly path: string | null; readonly entries: unknown } {
    return readExceptionsFile(this.exceptionsPathsOverride);
  }

  private finishPending(
    entry: PendingEntry,
    decision: "approved" | "denied" | "expired" | "disconnected",
    payload: Record<string, unknown>,
  ): void {
    if (entry.settled) return;
    entry.settled = true;
    clearTimeout(entry.timer);
    this.pending.delete(entry.request.requestId);
    this.flushPendingSockets(entry, decision, payload);
  }

  private flushPendingSockets(
    entry: PendingEntry,
    decision: "approved" | "denied" | "expired" | "disconnected",
    payload: Record<string, unknown>,
  ): void {
    for (const sock of entry.sockets) {
      writeAndCloseSocket(sock, payload);
    }
    entry.sockets.clear();
    this.emit({ type: "pending_resolved", requestId: entry.request.requestId, decision });
  }
}
