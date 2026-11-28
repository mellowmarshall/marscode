// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off - NDJSON wire frame handling and RPC dispatch for GuardGrantBroker.
import * as NodeCrypto from "node:crypto";
import type * as NodeNet from "node:net";
import * as NodeStringDecoder from "node:string_decoder";

import { PLAN_GUARD, parsePlanEntries, planEntryDigest } from "@t3tools/guard-protocol/plan";
import {
  parseBundleSpec,
  sanitizeText,
  validateGuardAndCommand,
  type GuardBrokerEvent,
  type PendingGuardRequest,
} from "@t3tools/guard-protocol/protocol";

import type { StoredGuardBundleGrant } from "../persistence/GuardGrants.ts";
import {
  bundleKeyOf,
  onceGrantKey,
  type PendingEntry,
  type StoredOnceGrant,
} from "./GuardBrokerTypes.ts";
import type { GuardGrantStore } from "./GuardGrantStore.ts";
import type { PeerThreadResolution } from "./GuardPeerIdentity.ts";
import type { GuardJobBindings } from "./GuardJobBindings.ts";
import { verifyQueueWorkerJob, type QueueWorkerTrust } from "./GuardQueueWorker.ts";
import { canonicalCwd } from "./GuardSocketPath.ts";

const MAX_LINE_BYTES = 64 * 1024;
const MIN_REQUEST_TIMEOUT_MS = 5_000;
const MAX_REQUEST_TIMEOUT_MS = 600_000;

export interface GuardProtocolContext {
  readonly isClosed: () => boolean;
  readonly getDefaultRequestTimeoutMs: () => number;
  readonly maxPending: number;
  readonly pending: Map<string, PendingEntry>;
  readonly store: GuardGrantStore;
  readonly resolvePeer: (socket: NodeNet.Socket) => Promise<PeerThreadResolution>;
  readonly emit: (event: GuardBrokerEvent) => void;
  readonly broadcastGrantsChanged: () => void;
  readonly finishPending: (
    entry: PendingEntry,
    decision: "approved" | "denied" | "expired" | "disconnected",
    payload: Record<string, unknown>,
    reason?: string,
  ) => void;
  readonly queueWorkerTrust: QueueWorkerTrust;
  readonly jobBindings: GuardJobBindings;
}

export function writeAndCloseSocket(
  socket: NodeNet.Socket,
  payload: Record<string, unknown>,
): void {
  if (socket.destroyed) return;
  const forceDestroy = setTimeout(() => {
    if (!socket.destroyed) socket.destroy();
  }, 250);
  forceDestroy.unref();
  socket.once("close", () => clearTimeout(forceDestroy));
  if (!socket.writable) {
    socket.destroy();
    return;
  }
  try {
    socket.end(`${JSON.stringify(payload)}\n`, () => {
      if (!socket.destroyed) socket.destroy();
    });
  } catch {
    socket.destroy();
  }
}

export function attachGuardSocketReader(
  socket: NodeNet.Socket,
  activeSockets: Set<NodeNet.Socket>,
  ctx: GuardProtocolContext,
): void {
  if (ctx.isClosed()) {
    socket.destroy();
    return;
  }
  activeSockets.add(socket);
  const decoder = new NodeStringDecoder.StringDecoder("utf8");
  let buffer = "";
  let rawBytes = 0;
  let handled = false;
  const headerTimeout = setTimeout(() => {
    if (!handled) {
      handled = true;
      writeAndCloseSocket(socket, { ok: false, error: "request timeout" });
    }
  }, 5_000);

  socket.on("error", () => clearTimeout(headerTimeout));
  socket.on("close", () => {
    clearTimeout(headerTimeout);
    activeSockets.delete(socket);
  });
  socket.on("data", (chunk: Buffer) => {
    if (handled) return;
    rawBytes += chunk.byteLength;
    if (rawBytes > MAX_LINE_BYTES) {
      handled = true;
      clearTimeout(headerTimeout);
      writeAndCloseSocket(socket, { ok: false, error: "request too large" });
      return;
    }
    buffer += decoder.write(chunk);
    const newlineIdx = buffer.indexOf("\n");
    if (newlineIdx === -1) return;
    handled = true;
    clearTimeout(headerTimeout);
    const line = buffer.slice(0, newlineIdx).trim();
    void handleGuardProtocolMessage(socket, line, ctx).catch(() => {
      writeAndCloseSocket(socket, { ok: false, error: "internal broker error" });
    });
  });
}

async function handleGuardProtocolMessage(
  socket: NodeNet.Socket,
  line: string,
  ctx: GuardProtocolContext,
): Promise<void> {
  if (ctx.isClosed()) {
    writeAndCloseSocket(socket, { ok: false, denied: false, error: "broker closed" });
    return;
  }
  let msg: Record<string, unknown>;
  try {
    const parsed = JSON.parse(line) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      writeAndCloseSocket(socket, { ok: false, error: "invalid JSON object" });
      return;
    }
    msg = parsed as Record<string, unknown>;
  } catch {
    writeAndCloseSocket(socket, { ok: false, error: "malformed JSON" });
    return;
  }
  if (msg.v !== 1 && msg.v !== 2) {
    writeAndCloseSocket(socket, { ok: false, error: "unsupported protocol version" });
    return;
  }

  const op = typeof msg.op === "string" ? msg.op : "";
  if (op === "identify") {
    const peer = await ctx.resolvePeer(socket);
    if (ctx.isClosed() || socket.destroyed) return;
    if (!peer.verified) {
      writeAndCloseSocket(socket, { ok: false, error: peer.error });
      return;
    }
    writeAndCloseSocket(socket, {
      ok: true,
      ...(peer.peerPid !== undefined && peer.peerPid > 0 ? { pid: peer.peerPid } : {}),
      thread_id: peer.threadId,
    });
    return;
  }
  if (op === "bind_job") {
    const peer = await ctx.resolvePeer(socket);
    if (ctx.isClosed() || socket.destroyed) return;
    if (!peer.verified) {
      writeAndCloseSocket(socket, { ok: false, error: peer.error });
      return;
    }
    const bound = ctx.jobBindings.bind(ctx.queueWorkerTrust, {
      peerPid: peer.peerPid,
      threadId: peer.threadId,
      jobId: typeof msg.job_id === "string" ? msg.job_id : "",
      worktree: typeof msg.cwd === "string" ? msg.cwd : "",
      branch: sanitizeText(msg.branch, 200),
    });
    writeAndCloseSocket(socket, bound.ok ? { ok: true, thread_id: peer.threadId } : bound);
    return;
  }
  if (op !== "peek" && op !== "check" && op !== "use" && op !== "request") {
    writeAndCloseSocket(socket, { ok: false, error: "unsupported op" });
    return;
  }

  const validated = validateGuardAndCommand(msg.guard, msg.command, msg.argv_sha256);
  if (!validated.ok) {
    writeAndCloseSocket(socket, { ok: false, error: validated.error });
    return;
  }
  const parsedBundle = parseBundleSpec(msg.bundle, validated.guard);
  if (!parsedBundle.ok) {
    writeAndCloseSocket(socket, { ok: false, error: parsedBundle.error });
    return;
  }

  const parsedPlan = msg.plan === undefined ? null : parsePlanEntries(msg.plan);
  if (parsedPlan && !parsedPlan.ok) {
    writeAndCloseSocket(socket, { ok: false, error: parsedPlan.error });
    return;
  }
  const plan = parsedPlan?.ok ? parsedPlan.entries : undefined;
  if (
    plan &&
    (op !== "request" ||
      validated.guard !== PLAN_GUARD ||
      !plan.some((e) => planEntryDigest(e) === validated.digest))
  ) {
    writeAndCloseSocket(socket, {
      ok: false,
      error: "plan requests use guard 'plan' and list their command",
    });
    return;
  }

  const cwd = typeof msg.cwd === "string" ? canonicalCwd(msg.cwd) : "";
  const reqThreadId = sanitizeText(msg.thread_id, 128);
  const jobId = typeof msg.job_id === "string" ? msg.job_id : "";
  const peer = await ctx.resolvePeer(socket);
  if (ctx.isClosed() || socket.destroyed) return;
  if (!peer.verified) {
    writeAndCloseSocket(socket, { ok: false, error: peer.error });
    return;
  }
  let effectiveThreadId = peer.threadId;
  if (jobId) {
    if (op === "request") {
      writeAndCloseSocket(socket, { ok: false, error: "queue workers cannot request grants" });
      return;
    }
    const worker = verifyQueueWorkerJob(ctx.queueWorkerTrust, ctx.jobBindings, {
      peerPid: peer.peerPid,
      jobId,
      guard: validated.guard,
      command: validated.command,
      cwd,
      bundle: parsedBundle.bundle,
    });
    if (!worker.ok) {
      writeAndCloseSocket(socket, { ok: false, error: worker.error });
      return;
    }
    effectiveThreadId = worker.threadId;
  }
  if (reqThreadId && reqThreadId !== effectiveThreadId) {
    writeAndCloseSocket(socket, { ok: false, error: "thread_id does not match caller process" });
    return;
  }

  // A job-bound worker check is satisfied only by the job's bundle grant, never a once grant.
  const matchedOnce = jobId
    ? null
    : ctx.store.lookupOnce(validated.guard, validated.digest, cwd, effectiveThreadId);
  const matchedBundle =
    !matchedOnce && parsedBundle.bundleEligible && parsedBundle.bundle && effectiveThreadId
      ? await ctx.store.lookupBundle(validated.guard, parsedBundle.bundle, effectiveThreadId)
      : null;

  if (op === "peek") {
    writeAndCloseSocket(socket, { ok: matchedOnce !== null || matchedBundle !== null });
    return;
  }

  const replyOnce = (key: string, grant: StoredOnceGrant, consume: boolean) => {
    if (consume) ctx.store.deleteOnce(key);
    if (consume)
      ctx.store.recordEvent({
        ts: new Date().toISOString(),
        eventType: "used",
        grantId: grant.grantId,
        threadId: grant.threadId || effectiveThreadId,
        guard: validated.guard,
        scope: "once",
        argvSha256: validated.digest,
        command: validated.displayCommand,
        summary: validated.displayCommand.slice(0, 3).join(" "),
        reason: grant.reason,
      });
    writeAndCloseSocket(socket, {
      ok: true,
      grant_id: grant.grantId,
      scope: "once",
      reason: grant.reason,
      approved_by: grant.approvedBy,
      ...(grant.approvedVia ? { approved_via: grant.approvedVia } : {}),
      thread_id: grant.threadId || effectiveThreadId,
    });
  };

  const replyBundle = (grant: StoredGuardBundleGrant, recordUse = true) => {
    const nowIso = new Date().toISOString();
    if (recordUse) ctx.store.recordBundleUse(grant, nowIso, ctx.broadcastGrantsChanged);
    if (recordUse)
      ctx.store.recordEvent({
        ts: nowIso,
        eventType: "used",
        grantId: grant.grantId,
        threadId: effectiveThreadId || grant.threadId,
        guard: validated.guard,
        scope: "bundle",
        argvSha256: validated.digest,
        command: validated.displayCommand,
        summary: grant.summary,
        reason: grant.reason,
      });
    writeAndCloseSocket(socket, {
      ok: true,
      grant_id: grant.grantId,
      scope: "bundle",
      reason: grant.reason,
      approved_by: "human",
      approved_via: grant.approvedVia,
      signature: grant.signature,
      thread_id: effectiveThreadId || grant.threadId,
    });
  };

  if (op === "check" || op === "use") {
    // v2 `check` is read-only; v1 `check` keeps consuming so older installed hooks stay single-use.
    const consume = op === "use" || msg.v === 1;
    if (matchedOnce) return replyOnce(matchedOnce.key, matchedOnce.grant, consume);
    if (matchedBundle) return replyBundle(matchedBundle, consume);
    writeAndCloseSocket(socket, { ok: false });
    return;
  }

  const wait = msg.wait !== false;
  const storeGrant = plan !== undefined || msg.store_grant === true;
  const consumeExisting = msg.consume_existing !== false && !storeGrant;
  if (matchedOnce && !plan) {
    if (!consumeExisting) {
      writeAndCloseSocket(socket, {
        ok: true,
        already_approved: true,
        scope: "once",
        grant_id: matchedOnce.grant.grantId,
        thread_id: matchedOnce.grant.threadId || effectiveThreadId,
      });
      return;
    }
    return replyOnce(matchedOnce.key, matchedOnce.grant, true);
  }
  if (matchedBundle && !plan) {
    if (!consumeExisting) {
      writeAndCloseSocket(socket, {
        ok: true,
        already_approved: true,
        scope: "bundle",
        grant_id: matchedBundle.grantId,
      });
      return;
    }
    return replyBundle(matchedBundle);
  }
  if (socket.destroyed || !socket.writable) return;
  if (!effectiveThreadId) {
    writeAndCloseSocket(socket, {
      ok: false,
      error: "override requests require a verified thread_id",
    });
    return;
  }

  const coalesceKey = plan
    ? `plan\0${plan.map((c) => JSON.stringify(c)).join("\0")}\0${cwd}\0${effectiveThreadId}`
    : parsedBundle.bundleEligible && parsedBundle.bundle
      ? `bundle\0${bundleKeyOf(validated.guard, parsedBundle.bundle)}\0${effectiveThreadId}`
      : `${storeGrant ? "stored" : "once"}\0${onceGrantKey(validated.guard, validated.digest, cwd, effectiveThreadId)}`;

  for (const existing of ctx.pending.values()) {
    if (!existing.settled && existing.coalesceKey === coalesceKey) {
      if (wait) {
        existing.sockets.add(socket);
        socket.once("close", () => existing.sockets.delete(socket));
      } else {
        writeAndCloseSocket(socket, {
          ok: true,
          queued: true,
          coalesced: true,
          request_id: existing.request.requestId,
        });
      }
      return;
    }
  }

  if (ctx.pending.size >= ctx.maxPending) {
    writeAndCloseSocket(socket, { ok: false, error: "too many pending override requests" });
    return;
  }

  const rawTimeoutSec = typeof msg.timeout === "number" ? msg.timeout : undefined;
  const timeoutMs =
    rawTimeoutSec !== undefined && Number.isFinite(rawTimeoutSec)
      ? Math.max(
          MIN_REQUEST_TIMEOUT_MS,
          Math.min(MAX_REQUEST_TIMEOUT_MS, Math.round(rawTimeoutSec * 1000)),
        )
      : ctx.getDefaultRequestTimeoutMs();
  const nowMs = Date.now();
  const requestId = `t3r_${NodeCrypto.randomBytes(10).toString("hex")}`;
  const reportedPid =
    typeof msg.pid === "number" && Number.isInteger(msg.pid) && msg.pid > 0 ? msg.pid : 0;
  const request: PendingGuardRequest = {
    requestId,
    guard: validated.guard,
    command: validated.displayCommand,
    argvSha256: validated.digest,
    cwd,
    refusal: sanitizeText(msg.refusal, 1000),
    proposedReason: sanitizeText(msg.proposed_reason, 400),
    threadId: effectiveThreadId,
    session: sanitizeText(msg.session, 128),
    pid: peer.verified && peer.peerPid && peer.peerPid > 0 ? peer.peerPid : reportedPid,
    createdAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(nowMs + timeoutMs).toISOString(),
    ...(parsedBundle.bundle ? { bundle: parsedBundle.bundle } : {}),
    bundleEligible: plan ? false : parsedBundle.bundleEligible,
    wholeCommitGates: parsedBundle.wholeCommitGates,
    ...(plan ? { plan } : {}),
  };

  const summary = parsedBundle.bundle?.summary ?? validated.displayCommand.slice(0, 3).join(" ");
  const scope = parsedBundle.bundleEligible ? "bundle" : "once";
  const timer = setTimeout(() => {
    ctx.store.recordEvent({
      ts: new Date().toISOString(),
      eventType: "expired",
      requestId,
      threadId: effectiveThreadId,
      guard: validated.guard,
      scope,
      argvSha256: validated.digest,
      command: validated.displayCommand,
      summary,
      reason: "override request timed out waiting for owner",
    });
    ctx.finishPending(
      entry,
      "expired",
      { ok: false, denied: false, error: "override request timed out waiting for owner" },
      "timed out",
    );
  }, timeoutMs);

  const sockets = new Set<NodeNet.Socket>();
  if (wait) sockets.add(socket);
  const entry: PendingEntry = {
    request,
    coalesceKey,
    sockets,
    timer,
    storeGrant,
    settled: false,
  };
  ctx.pending.set(requestId, entry);

  if (wait) {
    socket.once("close", () => {
      entry.sockets.delete(socket);
      if (!entry.settled && entry.sockets.size === 0) {
        ctx.store.recordEvent({
          ts: new Date().toISOString(),
          eventType: "disconnected",
          requestId,
          threadId: effectiveThreadId,
          guard: validated.guard,
          scope,
          argvSha256: validated.digest,
          command: validated.displayCommand,
          summary,
          reason: "client socket closed while awaiting owner approval",
        });
      }
    });
  } else {
    writeAndCloseSocket(socket, { ok: true, queued: true, request_id: requestId });
  }

  ctx.store.recordEvent({
    ts: request.createdAt,
    eventType: "pending_added",
    requestId,
    threadId: effectiveThreadId,
    guard: validated.guard,
    scope,
    argvSha256: validated.digest,
    command: validated.displayCommand,
    summary,
    reason: request.proposedReason || request.refusal,
  });
  ctx.emit({ type: "pending_added", request });
}
