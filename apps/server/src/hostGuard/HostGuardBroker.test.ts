// @effect-diagnostics nodeBuiltinImport:off - Integration tests bind isolated owner-only Unix domain sockets.
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { GuardGrantBroker, type GuardBrokerEvent } from "./GuardGrantBroker.ts";
import { HostGuardBroker, layerWithOptions } from "./HostGuardBroker.ts";
import { argvSha256, redactArgvCommand } from "./hostGuardRedaction.ts";

function makeTempSocketDir(prefix: string): {
  readonly dir: string;
  readonly socketPath: string;
  cleanup: () => void;
} {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), prefix));
  NodeFS.chmodSync(dir, 0o700);
  return {
    dir,
    socketPath: NodePath.join(dir, "grant.sock"),
    cleanup: () => {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function sendSocketNdjson(
  socketPath: string,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const client = NodeNet.createConnection({ path: socketPath });
    let buf = "";
    const settle = (fn: () => void) => {
      client.destroy();
      fn();
    };
    client.once("error", (err) => settle(() => reject(err)));
    client.once("connect", () => {
      client.write(`${JSON.stringify(payload)}\n`);
    });
    client.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl !== -1) {
        const line = buf.slice(0, nl).trim();
        settle(() => resolve(JSON.parse(line) as Record<string, unknown>));
      }
    });
  });
}

function waitForBrokerEvent(
  broker: GuardGrantBroker,
  predicate: (event: GuardBrokerEvent) => boolean,
): Promise<GuardBrokerEvent> {
  return new Promise((resolve) => {
    const unsub = broker.subscribe((event) => {
      if (predicate(event)) {
        unsub();
        resolve(event);
      }
    });
  });
}

describe("redactArgvCommand", () => {
  it("redacts curl/wget auth headers, bearer tokens, URL creds, and query secrets", () => {
    expect(
      redactArgvCommand([
        "curl",
        "-H",
        "Authorization: Bearer tok123",
        "--token=sec-tok",
        "--",
        "Bearer tok123;t https://u:p@h?token=q;tail&ok=1",
      ]),
    ).toEqual([
      "curl",
      "-H",
      "<redacted>",
      "--token=<redacted>",
      "--",
      "Bearer <redacted> https://<redacted>@h?token=<redacted>&ok=1",
    ]);
    expect(redactArgvCommand(["curl", "--", "https://h?a=1;api_key=sec;more&b=2"])).toEqual([
      "curl",
      "--",
      "https://h?a=1;api_key=<redacted>&b=2",
    ]);
    expect(redactArgvCommand(["curl", "-u", "alice", "https://example.com"])).toEqual([
      "curl",
      "-u",
      "alice",
      "https://example.com",
    ]);
  });

  it("redacts fly ssh remote commands and secret flags while preserving positional --", () => {
    expect(redactArgvCommand(["fly", "ssh", "console", "-C", "PASSWORD=secret env"])).toEqual([
      "fly",
      "ssh",
      "console",
      "-C",
      "<redacted-remote-command>",
    ]);
    expect(redactArgvCommand(["flyctl", "ssh", "console", '--command=API_KEY="a"b env'])).toEqual([
      "flyctl",
      "ssh",
      "console",
      "--command=<redacted-remote-command>",
    ]);
    expect(
      redactArgvCommand(["fly", "ssh", "console", "-qCPASSWORD=secret", "-qt", "tok123"]),
    ).toEqual(["fly", "ssh", "console", "-qC<redacted-remote-command>", "-qt", "<redacted>"]);
    expect(
      redactArgvCommand(["fly", "ssh", "console", "--app", "-t", "-t", "tok123", "-uubuntu"]),
    ).toEqual(["fly", "ssh", "console", "--app", "-t", "-t", "<redacted>", "-uubuntu"]);
    expect(redactArgvCommand(["fly", "ssh", "console", "--user=alice:Bearer tok"])).toEqual([
      "fly",
      "ssh",
      "console",
      "--user=<redacted>",
    ]);
    expect(redactArgvCommand(["fly", "ssh", "console", "--", "--token=positional"])).toEqual([
      "fly",
      "ssh",
      "console",
      "--",
      "--token=positional",
    ]);
  });
});

describe("GuardGrantBroker", () => {
  it("handles preapprove -> peek -> atomic check and rejects invalid payloads and caps", async () => {
    const tmp = makeTempSocketDir("t3hg-pre-");
    const broker = new GuardGrantBroker({
      socketPath: tmp.socketPath,
      maxPreapproved: 2,
      resolvePeerThreadId: async () => ({ verified: true, threadId: "thread-1", peerPid: 4242 }),
    });
    await broker.start("linux");

    try {
      expect(NodeFS.statSync(tmp.socketPath).mode & 0o777).toBe(0o600);

      const grant = broker.preapprove({
        guard: "git",
        command: ["git", "push", "--force"],
        cwd: tmp.dir,
        reason: "rebase confirmed by human",
      });
      expect(grant.ok).toBe(true);

      const forged = await sendSocketNdjson(tmp.socketPath, {
        v: 1,
        op: "check",
        guard: "git",
        command: ["git", "status"],
        argv_sha256: "0".repeat(64),
        cwd: tmp.dir,
      });
      expect(forged).toMatchObject({ ok: false, error: "argv_sha256 mismatch" });

      const nulArg = await sendSocketNdjson(tmp.socketPath, {
        v: 1,
        op: "check",
        guard: "git",
        command: ["git", "push\0--force"],
        cwd: tmp.dir,
      });
      expect(nulArg.ok).toBe(false);

      const mismatchedThread = await sendSocketNdjson(tmp.socketPath, {
        v: 1,
        op: "peek",
        guard: "git",
        command: ["git", "push", "--force"],
        cwd: tmp.dir,
        thread_id: "spoofed-thread",
      });
      expect(mismatchedThread).toMatchObject({
        ok: false,
        error: "thread_id does not match caller process",
      });

      const peek = await sendSocketNdjson(tmp.socketPath, {
        v: 1,
        op: "peek",
        guard: "git",
        command: ["git", "push", "--force"],
        cwd: tmp.dir,
        thread_id: "thread-1",
      });
      expect(peek).toEqual({ ok: true });

      const check1 = await sendSocketNdjson(tmp.socketPath, {
        v: 1,
        op: "check",
        guard: "git",
        command: ["git", "push", "--force"],
        cwd: tmp.dir,
        argv_sha256: argvSha256(["git", "push", "--force"]),
      });
      expect(check1).toMatchObject({
        ok: true,
        reason: "rebase confirmed by human",
        approved_by: "human",
        thread_id: "thread-1",
      });

      const check2 = await sendSocketNdjson(tmp.socketPath, {
        v: 1,
        op: "check",
        guard: "git",
        command: ["git", "push", "--force"],
        cwd: tmp.dir,
      });
      expect(check2).toEqual({ ok: false });

      expect(broker.preapprove({ guard: "\x01", command: ["x"], cwd: tmp.dir }).ok).toBe(false);
      expect(broker.preapprove({ guard: "g1", command: ["a"], cwd: tmp.dir }).ok).toBe(true);
      expect(broker.preapprove({ guard: "g2", command: ["b"], cwd: tmp.dir }).ok).toBe(true);
      expect(broker.preapprove({ guard: "g3", command: ["c"], cwd: tmp.dir }).ok).toBe(false);
    } finally {
      await broker.close();
      tmp.cleanup();
    }
  });

  it("handles blocking approve/deny, non-blocking hook enqueue, timeout, and fail-closed verification", async () => {
    const tmp = makeTempSocketDir("t3hg-req-");
    const broker = new GuardGrantBroker({
      socketPath: tmp.socketPath,
      resolvePeerThreadId: async () => ({ verified: true, threadId: "thread-owner", peerPid: 777 }),
    });
    await broker.start("linux");

    try {
      // Blocking request approved
      const addedApprove = waitForBrokerEvent(broker, (e) => e.type === "pending_added");
      const reqApprove = sendSocketNdjson(tmp.socketPath, {
        v: 1,
        op: "request",
        guard: "rm",
        command: ["rm", "-rf", "/tmp/demo"],
        cwd: tmp.dir,
        refusal: "blocked recursive delete",
        proposed_reason: "clean demo dir",
        timeout: 15,
      });
      const added1 = await addedApprove;
      if (added1.type !== "pending_added") throw new Error("expected pending_added");
      expect(added1.request.pid).toBe(777);
      expect(broker.resolveRequest(added1.request.requestId, { decision: "approve" }).found).toBe(
        true,
      );
      expect(await reqApprove).toMatchObject({
        ok: true,
        reason: "clean demo dir",
        approved_by: "human",
        thread_id: "thread-owner",
      });

      // Blocking request denied
      const addedDeny = waitForBrokerEvent(broker, (e) => e.type === "pending_added");
      const reqDeny = sendSocketNdjson(tmp.socketPath, {
        v: 1,
        op: "request",
        guard: "git",
        command: ["git", "reset", "--hard"],
        cwd: tmp.dir,
        timeout: 15,
      });
      const added2 = await addedDeny;
      if (added2.type !== "pending_added") throw new Error("expected pending_added");
      broker.resolveRequest(added2.request.requestId, {
        decision: "deny",
        reason: "use safer alternative",
      });
      expect(await reqDeny).toEqual({
        ok: false,
        denied: true,
        error: "use safer alternative",
      });

      // Non-blocking enqueue -> approve stores single-use grant -> consume_existing:false peek keeps it -> check consumes it
      const secretCurl = ["curl", "-H", "Authorization: Bearer supersecret", "https://example.com"];
      const queued = await sendSocketNdjson(tmp.socketPath, {
        v: 1,
        op: "request",
        wait: false,
        consume_existing: false,
        guard: "argv",
        command: secretCurl,
        cwd: tmp.dir,
      });
      expect(queued.ok).toBe(true);
      expect(queued.queued).toBe(true);
      const pending = broker.listPending();
      expect(pending).toHaveLength(1);
      expect(pending[0]!.command).toEqual(["curl", "-H", "<redacted>", "https://example.com"]);
      expect(
        broker.resolveRequest(pending[0]!.requestId, {
          decision: "approve",
          reason: "hook approved",
          approvedVia: "bearer:owner",
        }).found,
      ).toBe(true);
      expect(broker.listPending()).toHaveLength(0);

      const secondHook = await sendSocketNdjson(tmp.socketPath, {
        v: 1,
        op: "request",
        wait: false,
        consume_existing: false,
        guard: "argv",
        command: secretCurl,
        cwd: tmp.dir,
      });
      expect(secondHook).toEqual({ ok: true, already_approved: true });

      const shimCheck = await sendSocketNdjson(tmp.socketPath, {
        v: 1,
        op: "check",
        guard: "argv",
        command: secretCurl,
        cwd: tmp.dir,
      });
      expect(shimCheck).toMatchObject({
        ok: true,
        reason: "hook approved",
        approved_via: "bearer:owner",
      });
      expect(
        await sendSocketNdjson(tmp.socketPath, {
          v: 1,
          op: "check",
          guard: "argv",
          command: secretCurl,
          cwd: tmp.dir,
        }),
      ).toEqual({ ok: false });
    } finally {
      await broker.close();
      tmp.cleanup();
    }

    // Timeout expiry + shutdown + non-linux silent fallback + fail-closed peer check
    const macTmp = makeTempSocketDir("t3hg-mac-");
    const macBroker = new GuardGrantBroker({ socketPath: macTmp.socketPath });
    await macBroker.start("darwin");
    try {
      expect(macBroker.listening).toBe(false);
      expect(NodeFS.existsSync(macTmp.socketPath)).toBe(false);
      expect(
        macBroker.preapprove({ guard: "git", command: ["git", "status"], cwd: macTmp.dir }).ok,
      ).toBe(false);
    } finally {
      await macBroker.close();
      macTmp.cleanup();
    }

    const failTmp = makeTempSocketDir("t3hg-fail-");
    const failBroker = new GuardGrantBroker({
      socketPath: failTmp.socketPath,
      resolvePeerThreadId: async () => ({ verified: false, error: "peer check failed" }),
    });
    await failBroker.start("linux");
    try {
      expect(
        failBroker.preapprove({ guard: "git", command: ["git", "status"], cwd: failTmp.dir }).ok,
      ).toBe(true);
      expect(
        await sendSocketNdjson(failTmp.socketPath, {
          v: 1,
          op: "check",
          guard: "git",
          command: ["git", "status"],
          cwd: failTmp.dir,
        }),
      ).toEqual({ ok: false, error: "peer check failed" });
    } finally {
      await failBroker.close();
      failTmp.cleanup();
    }
  });

  it("refuses to hijack a live socket and emits denied:false on close", async () => {
    const tmp = makeTempSocketDir("t3hg-live-");
    const broker = new GuardGrantBroker({
      socketPath: tmp.socketPath,
      resolvePeerThreadId: async () => ({ verified: true, threadId: "thread-live", peerPid: 11 }),
    });
    await broker.start("linux");

    const intruder = new GuardGrantBroker({ socketPath: tmp.socketPath });
    try {
      await expect(intruder.start("linux")).rejects.toThrow(/already owned/);
      expect(NodeFS.existsSync(tmp.socketPath)).toBe(true);

      const addedPromise = waitForBrokerEvent(broker, (e) => e.type === "pending_added");
      const reqPromise = sendSocketNdjson(tmp.socketPath, {
        v: 1,
        op: "request",
        guard: "rm",
        command: ["rm", "-rf", "/tmp/demo"],
        cwd: tmp.dir,
        timeout: 15,
      });
      await addedPromise;
      await broker.close();
      expect(await reqPromise).toMatchObject({ ok: false, denied: false });
      expect(NodeFS.existsSync(tmp.socketPath)).toBe(false);
    } finally {
      await broker.close();
      tmp.cleanup();
    }
  });

  it.effect(
    "publishes live HostGuardBroker stateStream transitions and resolves over Effect service",
    () => {
      const tmp = makeTempSocketDir("t3hg-svc-");
      const serviceLayer = layerWithOptions({
        socketPath: tmp.socketPath,
        resolvePeerThreadId: async () => ({ verified: true, threadId: "thread-svc", peerPid: 99 }),
      }).pipe(Layer.provide(Layer.succeed(HostProcess.Platform, "linux")));

      return Effect.gen(function* () {
        const brokerSvc = yield* HostGuardBroker;
        const initial = yield* brokerSvc.state;
        expect(initial).toEqual({ listening: true, pending: [] });

        const collector = yield* Stream.take(brokerSvc.stateStream, 3).pipe(
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* Effect.yieldNow;

        const replyPromise = sendSocketNdjson(tmp.socketPath, {
          v: 1,
          op: "request",
          guard: "git",
          command: ["git", "push", "--force"],
          cwd: tmp.dir,
          proposed_reason: "push feature branch",
        });

        const pendingSnapshot = yield* brokerSvc.stateStream.pipe(
          Stream.filter((state) => state.pending.length > 0),
          Stream.runHead,
        );
        if (Option.isNone(pendingSnapshot)) {
          throw new Error("expected pending host guard state emission");
        }
        const requestId = pendingSnapshot.value.pending[0]!.requestId;
        expect(requestId).toBeTruthy();

        const resolved = yield* brokerSvc.resolve({
          requestId,
          decision: "approve",
          approvedVia: "bearer-token:owner",
        });
        expect(resolved.resolved).toBe(true);
        expect(resolved.grantId).toBeTruthy();

        const reply = yield* Effect.promise(() => replyPromise);
        expect(reply).toMatchObject({ ok: true, approved_by: "human", thread_id: "thread-svc" });

        const states = yield* Fiber.join(collector);
        expect(states).toHaveLength(3);
        expect(states[0]!.pending).toHaveLength(0);
        expect(states[1]!.pending).toHaveLength(1);
        expect(states[2]!.pending).toHaveLength(0);
      }).pipe(
        Effect.ensuring(Effect.sync(() => tmp.cleanup())),
        Effect.provide(serviceLayer),
        Effect.scoped,
      );
    },
  );
});
