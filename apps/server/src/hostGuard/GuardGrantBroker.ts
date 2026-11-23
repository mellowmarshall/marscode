// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off - Server-owned 0600 Unix socket broker matching host-guards/hg_t3_grant.py.
import * as NodeCrypto from "node:crypto";
import type * as NodeNet from "node:net";
import type { HostGuardState, PendingHostGuardRequest } from "@t3tools/contracts";

import { defaultResolvePeerThreadId, type PeerThreadResolution } from "./hostGuardPeerThread.ts";
import {
  buildPendingHostGuardRequest,
  canonicalCwd,
  grantKey,
  sanitizeHostGuardText,
  validateGuardAndCommand,
} from "./hostGuardRedaction.ts";
import {
  attachSingleJsonLineReader,
  bindPrivateUnixSocket,
  defaultGuardSocketPath,
  parseGrantWireMessage,
  unlinkOwnedSocket,
  writeJsonLineAndClose,
  type OwnedSocketStat,
} from "./hostGuardSocket.ts";

export type GuardBrokerEvent =
  | { readonly type: "snapshot"; readonly pending: ReadonlyArray<PendingHostGuardRequest> }
  | { readonly type: "pending_added"; readonly request: PendingHostGuardRequest }
  | {
      readonly type: "pending_resolved";
      readonly requestId: string;
      readonly decision: "approved" | "denied" | "expired" | "disconnected";
    };

export interface GuardGrantBrokerOptions {
  readonly socketPath?: string | undefined;
  readonly defaultGrantTtlMs?: number | undefined;
  readonly defaultRequestTimeoutMs?: number | undefined;
  readonly maxPending?: number | undefined;
  readonly maxPreapproved?: number | undefined;
  readonly resolvePeerThreadId?:
    | ((socket: NodeNet.Socket, platform: NodeJS.Platform) => Promise<PeerThreadResolution>)
    | undefined;
}

interface StoredGrant {
  readonly grantId: string;
  readonly guard: string;
  readonly argvSha256: string;
  readonly cwd: string;
  readonly reason: string;
  readonly approvedBy: string;
  readonly approvedVia?: string | undefined;
  readonly threadId: string;
  readonly expiresAtMs: number;
}

interface PendingEntry {
  readonly request: PendingHostGuardRequest;
  readonly socket: NodeNet.Socket | null;
  readonly timer: ReturnType<typeof setTimeout>;
  settled: boolean;
}

const MAX_PENDING_DEFAULT = 64;
const MAX_PREAPPROVED_DEFAULT = 256;
const MAX_CONNECTIONS = 128;
const DEFAULT_GRANT_TTL_MS = 120_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 300_000;

/** Local owner-only Unix socket server implementing the `hg_t3_grant.py` override grant protocol. */
export class GuardGrantBroker {
  readonly socketPath: string;
  private readonly defaultGrantTtlMs: number;
  private readonly defaultRequestTimeoutMs: number;
  private readonly maxPending: number;
  private readonly maxPreapproved: number;
  private readonly resolvePeerThreadId: (
    socket: NodeNet.Socket,
    platform: NodeJS.Platform,
  ) => Promise<PeerThreadResolution>;
  private readonly hasCustomResolver: boolean;

  private server: NodeNet.Server | null = null;
  private startPromise: Promise<void> | null = null;
  private platform: NodeJS.Platform = "linux";
  private boundStat: OwnedSocketStat | null = null;
  private readonly activeSockets = new Set<NodeNet.Socket>();
  private readonly preapproved = new Map<string, StoredGrant>();
  private readonly pending = new Map<string, PendingEntry>();
  private readonly subscribers = new Set<(event: GuardBrokerEvent) => void>();
  private closed = false;

  constructor(options: GuardGrantBrokerOptions = {}) {
    this.socketPath = options.socketPath ?? defaultGuardSocketPath();
    this.defaultGrantTtlMs = options.defaultGrantTtlMs ?? DEFAULT_GRANT_TTL_MS;
    this.defaultRequestTimeoutMs = options.defaultRequestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.maxPending = options.maxPending ?? MAX_PENDING_DEFAULT;
    this.maxPreapproved = options.maxPreapproved ?? MAX_PREAPPROVED_DEFAULT;
    this.hasCustomResolver = options.resolvePeerThreadId !== undefined;
    this.resolvePeerThreadId = options.resolvePeerThreadId ?? defaultResolvePeerThreadId;
  }

  get listening(): boolean {
    return this.server !== null && this.server.listening && !this.closed;
  }

  getState(): HostGuardState {
    return {
      listening: this.listening,
      pending: this.listPending(),
    };
  }

  listPending(): ReadonlyArray<PendingHostGuardRequest> {
    return Array.from(this.pending.values(), (entry) => entry.request);
  }

  subscribe(listener: (event: GuardBrokerEvent) => void): () => void {
    this.subscribers.add(listener);
    return () => {
      this.subscribers.delete(listener);
    };
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
    const bound = await bindPrivateUnixSocket({
      socketPath: this.socketPath,
      maxConnections: MAX_CONNECTIONS,
      isClosed: () => this.closed,
      onConnection: (socket) => this.handleConnection(socket),
    });
    if (!bound) return;
    this.server = bound.server;
    this.boundStat = bound.boundStat;
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.startPromise) {
      try {
        await this.startPromise;
      } catch {
        // ignore failed startup during shutdown
      }
    }
    for (const entry of this.pending.values()) {
      // Shutdown is broker unavailability, not an explicit owner denial.
      this.finishPending(entry, "disconnected", {
        ok: false,
        denied: false,
        error: "T3 Code server shutting down",
      });
    }
    this.pending.clear();
    this.preapproved.clear();
    for (const socket of this.activeSockets) {
      socket.destroy();
    }
    this.activeSockets.clear();
    const server = this.server;
    this.server = null;
    if (server) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
    unlinkOwnedSocket(this.socketPath, this.boundStat);
    this.boundStat = null;
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
    if (!this.listening) {
      return { ok: false, error: "guard grant broker is not listening" };
    }
    this.pruneExpiredGrants();
    const validated = validateGuardAndCommand(input.guard, input.command);
    if (!validated.ok) return validated;
    if (this.preapproved.size >= this.maxPreapproved) {
      return { ok: false, error: "too many pre-approved grants pending" };
    }
    const ttlMs = Math.max(5_000, Math.min(600_000, input.ttlMs ?? this.defaultGrantTtlMs));
    const expiresAtMs = Date.now() + ttlMs;
    const grantId = `t3g_${NodeCrypto.randomBytes(12).toString("hex")}`;
    const threadId = sanitizeHostGuardText(input.threadId, 128);
    const grant: StoredGrant = {
      grantId,
      guard: validated.guard,
      argvSha256: validated.digest,
      cwd: canonicalCwd(input.cwd),
      reason: sanitizeHostGuardText(input.reason, 400) || "pre-approved in T3 Code",
      approvedBy: "human",
      approvedVia: input.approvedVia,
      threadId,
      expiresAtMs,
    };
    this.preapproved.set(grantKey(validated.guard, validated.digest, grant.cwd, threadId), grant);
    return { ok: true, grantId, expiresAt: new Date(expiresAtMs).toISOString() };
  }

  resolveRequest(
    requestId: string,
    input: {
      readonly decision: "approve" | "deny";
      readonly reason?: string | undefined;
      readonly approvedVia?: string | undefined;
    },
  ): { readonly found: boolean; readonly grantId?: string } {
    const entry = this.pending.get(requestId);
    if (!entry || entry.settled) return { found: false };

    if (input.decision === "approve") {
      const grantId = `t3g_${NodeCrypto.randomBytes(12).toString("hex")}`;
      const reason =
        sanitizeHostGuardText(input.reason, 400) ||
        entry.request.proposedReason ||
        "approved in T3 Code";
      // Non-blocking hook requests store a single-use grant so the PATH shim consumes it on retry.
      if (entry.socket === null) {
        if (!entry.request.threadId) {
          this.finishPending(entry, "denied", {
            ok: false,
            denied: true,
            error: "override requests require a verified thread_id",
          });
          return { found: true };
        }
        this.pruneExpiredGrants();
        const expiresAtMs = Date.now() + this.defaultGrantTtlMs;
        const grant: StoredGrant = {
          grantId,
          guard: entry.request.guard,
          argvSha256: entry.request.argvSha256,
          cwd: entry.request.cwd,
          reason,
          approvedBy: "human",
          approvedVia: input.approvedVia,
          threadId: entry.request.threadId,
          expiresAtMs,
        };
        this.preapproved.set(
          grantKey(grant.guard, grant.argvSha256, grant.cwd, grant.threadId),
          grant,
        );
      }
      this.finishPending(entry, "approved", {
        ok: true,
        grant_id: grantId,
        reason,
        approved_by: "human",
        ...(input.approvedVia ? { approved_via: input.approvedVia } : {}),
        thread_id: entry.request.threadId,
      });
      return { found: true, grantId };
    }

    const reason = sanitizeHostGuardText(input.reason, 400) || "denied by owner in T3 Code";
    this.finishPending(entry, "denied", { ok: false, denied: true, error: reason });
    return { found: true };
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

  private pruneExpiredGrants(): void {
    const now = Date.now();
    for (const [k, grant] of this.preapproved) {
      if (grant.expiresAtMs <= now) this.preapproved.delete(k);
    }
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
    if (entry.socket !== null) writeJsonLineAndClose(entry.socket, payload);
    this.emit({ type: "pending_resolved", requestId: entry.request.requestId, decision });
  }

  private lookupPreapproved(
    guard: string,
    digest: string,
    cwd: string,
    threadId: string,
  ): { readonly key: string; readonly grant: StoredGrant } | null {
    if (threadId) {
      const exactKey = grantKey(guard, digest, cwd, threadId);
      const exact = this.preapproved.get(exactKey);
      if (exact) return { key: exactKey, grant: exact };
    }
    const unscopedKey = grantKey(guard, digest, cwd, "");
    const unscoped = this.preapproved.get(unscopedKey);
    return unscoped ? { key: unscopedKey, grant: unscoped } : null;
  }

  private handleConnection(socket: NodeNet.Socket): void {
    if (this.closed) {
      socket.destroy();
      return;
    }
    this.activeSockets.add(socket);
    attachSingleJsonLineReader({
      socket,
      onClose: () => {
        this.activeSockets.delete(socket);
      },
      onLine: (line) => {
        void this.handleMessage(socket, line).catch(() => {
          writeJsonLineAndClose(socket, { ok: false, error: "internal broker error" });
        });
      },
    });
  }

  private consumePreapprovedGrant(
    socket: NodeNet.Socket,
    matched: { readonly key: string; readonly grant: StoredGrant },
    effectiveThreadId: string,
  ): void {
    this.preapproved.delete(matched.key);
    writeJsonLineAndClose(socket, {
      ok: true,
      grant_id: matched.grant.grantId,
      reason: matched.grant.reason,
      approved_by: matched.grant.approvedBy,
      ...(matched.grant.approvedVia ? { approved_via: matched.grant.approvedVia } : {}),
      thread_id: matched.grant.threadId || effectiveThreadId,
    });
  }

  private async handleMessage(socket: NodeNet.Socket, line: string): Promise<void> {
    if (this.closed) {
      writeJsonLineAndClose(socket, { ok: false, denied: false, error: "broker closed" });
      return;
    }
    const msg = parseGrantWireMessage(line);
    if (typeof msg === "string") {
      writeJsonLineAndClose(socket, { ok: false, error: msg });
      return;
    }
    const op = typeof msg.op === "string" ? msg.op : "";
    if (op !== "peek" && op !== "check" && op !== "request") {
      writeJsonLineAndClose(socket, { ok: false, error: "unsupported op" });
      return;
    }
    const validated = validateGuardAndCommand(msg.guard, msg.command, msg.argv_sha256);
    if (!validated.ok) {
      writeJsonLineAndClose(socket, { ok: false, error: validated.error });
      return;
    }
    const cwd = typeof msg.cwd === "string" ? canonicalCwd(msg.cwd) : "";
    const reqThreadId = sanitizeHostGuardText(msg.thread_id, 128);
    // Verify caller thread ownership from kernel peer PID so callers cannot spoof another thread.
    const peer = await this.resolvePeerThreadId(socket, this.platform);
    if (this.closed || socket.destroyed) return;
    if (!peer.verified) {
      writeJsonLineAndClose(socket, { ok: false, error: peer.error });
      return;
    }
    if (reqThreadId && reqThreadId !== peer.threadId) {
      writeJsonLineAndClose(socket, {
        ok: false,
        error: "thread_id does not match caller process",
      });
      return;
    }
    const effectiveThreadId = peer.threadId;
    this.pruneExpiredGrants();
    const matched = this.lookupPreapproved(
      validated.guard,
      validated.digest,
      cwd,
      effectiveThreadId,
    );

    if (op === "peek") {
      writeJsonLineAndClose(socket, { ok: matched !== null });
      return;
    }
    if (op === "check") {
      if (!matched) {
        writeJsonLineAndClose(socket, { ok: false });
        return;
      }
      this.consumePreapprovedGrant(socket, matched, effectiveThreadId);
      return;
    }
    this.handleRequestOp(socket, msg, validated, cwd, peer, matched);
  }

  private handleRequestOp(
    socket: NodeNet.Socket,
    msg: Record<string, unknown>,
    validated: {
      readonly guard: string;
      readonly displayCommand: ReadonlyArray<string>;
      readonly digest: string;
    },
    cwd: string,
    peer: {
      readonly verified: true;
      readonly threadId: string;
      readonly peerPid?: number | undefined;
    },
    matched: { readonly key: string; readonly grant: StoredGrant } | null,
  ): void {
    const effectiveThreadId = peer.threadId;
    const wait = msg.wait !== false;
    const consumeExisting = msg.consume_existing !== false;
    if (matched) {
      if (!wait && !consumeExisting) {
        writeJsonLineAndClose(socket, { ok: true, already_approved: true });
        return;
      }
      this.consumePreapprovedGrant(socket, matched, effectiveThreadId);
      return;
    }
    if (socket.destroyed || !socket.writable) return;
    if (!effectiveThreadId) {
      writeJsonLineAndClose(socket, {
        ok: false,
        error: "override requests require a verified thread_id",
      });
      return;
    }
    if (this.pending.size >= this.maxPending) {
      writeJsonLineAndClose(socket, { ok: false, error: "too many pending override requests" });
      return;
    }
    const { request, timeoutMs } = buildPendingHostGuardRequest({
      msg,
      guard: validated.guard,
      displayCommand: validated.displayCommand,
      digest: validated.digest,
      cwd,
      threadId: effectiveThreadId,
      peerPid: peer.peerPid,
      defaultRequestTimeoutMs: this.defaultRequestTimeoutMs,
      nowMs: Date.now(),
    });
    const timer = setTimeout(() => {
      this.finishPending(entry, "expired", {
        ok: false,
        denied: false,
        error: "override request timed out waiting for owner",
      });
    }, timeoutMs);
    const entry: PendingEntry = { request, socket: wait ? socket : null, timer, settled: false };
    this.pending.set(request.requestId, entry);
    if (wait) {
      socket.once("close", () => {
        if (!entry.settled) {
          this.finishPending(entry, "disconnected", { ok: false, error: "client disconnected" });
        }
      });
    } else {
      writeJsonLineAndClose(socket, { ok: true, queued: true, request_id: request.requestId });
    }
    this.emit({ type: "pending_added", request });
  }
}
