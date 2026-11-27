// @effect-diagnostics nodeBuiltinImport:off - Tests exercise local Unix sockets and the real Python host-guards client.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";

import {
  AuthAccessWriteScope,
  AuthDiagnosticsReadScope,
  AuthEnvironmentMaintainScope,
  AuthOrchestrationReadScope,
  AuthTerminalOperateScope,
  type AuthEnvironmentScope,
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as KnownWorkspaces from "../workspace/KnownWorkspaces.ts";
import * as DevtoolsHttp from "./DevtoolsHttp.ts";
import { isAllowedFleetPath } from "./fleet/FleetRoutePolicy.ts";
import { NativeFleetService } from "./fleet/NativeFleetService.ts";
import * as JobRegistry from "./jobs/JobRegistry.ts";
import { GuardGrantBroker, redactArgvCommand, type GuardBrokerEvent } from "./GuardGrantBroker.ts";
import { makeTrustedProviderRegistry, readProcStartTime } from "./TrustedProviderRegistry.ts";
import { validatePlaybookRequest } from "./DevtoolsPlaybookRoutes.ts";

const cleanupDirs: Array<string> = [];

function mkTempDir(prefix: string): string {
  const dir = NodeFS.mkdtempSync(NodePath.join("/tmp", prefix));
  NodeFS.chmodSync(dir, 0o700);
  cleanupDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop()!;
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
});

function sendSocketNdjson(
  socketPath: string,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const conn = NodeNet.createConnection({ path: socketPath });
    let buf = "";
    conn.setEncoding("utf8");
    conn.on("connect", () => {
      conn.write(`${JSON.stringify(payload)}\n`);
    });
    conn.on("data", (chunk: string) => {
      buf += chunk;
      const idx = buf.indexOf("\n");
      if (idx !== -1) {
        const line = buf.slice(0, idx);
        conn.end();
        resolve(JSON.parse(line) as Record<string, unknown>);
      }
    });
    conn.on("error", reject);
  });
}

function sendSocketNdjsonAsThread(
  socketPath: string,
  payload: Record<string, unknown>,
  envThreadId: string,
  grandchildSpoofThreadId?: string,
): Promise<Record<string, unknown>> {
  const py = grandchildSpoofThreadId
    ? `
import os, subprocess, sys
env = dict(os.environ, T3CODE_THREAD_ID=sys.argv[3])
out = subprocess.check_output([sys.executable, "-I", "-c", r"""
import socket, sys
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.connect(sys.argv[1])
s.sendall((sys.argv[2] + "\\n").encode("utf-8"))
buf = b""
while b"\\n" not in buf:
    c = s.recv(4096)
    if not c: break
    buf += c
s.close()
sys.stdout.write(buf.decode("utf-8").splitlines()[0])
""", sys.argv[1], sys.argv[2]], env=env, text=True)
sys.stdout.write(out)
`
    : `
import socket, sys
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.connect(sys.argv[1])
s.sendall((sys.argv[2] + "\\n").encode("utf-8"))
buf = b""
while b"\\n" not in buf:
    c = s.recv(4096)
    if not c: break
    buf += c
s.close()
sys.stdout.write(buf.decode("utf-8").splitlines()[0])
`;
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  if (envThreadId) {
    childEnv.T3CODE_THREAD_ID = envThreadId;
  } else {
    delete childEnv.T3CODE_THREAD_ID;
  }
  const args = ["-I", "-c", py, socketPath, JSON.stringify(payload)];
  if (grandchildSpoofThreadId) args.push(grandchildSpoofThreadId);
  const pyBin = NodeFS.existsSync("/usr/bin/python3") ? "/usr/bin/python3" : "python3";
  return new Promise((resolve, reject) => {
    NodeChildProcess.execFile(pyBin, args, { env: childEnv, timeout: 5_000 }, (err, stdout) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(JSON.parse(stdout.trim()) as Record<string, unknown>);
    });
  });
}

function waitForBrokerEvent(
  broker: GuardGrantBroker,
  predicate: (event: GuardBrokerEvent) => boolean,
): Promise<GuardBrokerEvent> {
  return new Promise((resolve) => {
    const unsubscribe = broker.subscribe((event) => {
      if (predicate(event)) {
        unsubscribe();
        resolve(event);
      }
    });
  });
}

function findHostGuardsDir(): string | null {
  const candidates = [
    process.env.HOST_GUARDS_DIR,
    NodePath.resolve(process.cwd(), "host-guards"),
    "/home/dev/.t3/worktrees/devtools/10d85e80-d5cc5e1cf0080568/host-guards",
  ].filter((v): v is string => Boolean(v));
  for (const dir of candidates) {
    if (NodeFS.existsSync(NodePath.join(dir, "hg_t3_grant.py"))) {
      return dir;
    }
  }
  return null;
}

const runHandler = Effect.fn("DevtoolsHttp.test.runHandler")(function* (
  handler: ReturnType<typeof DevtoolsHttp.makeHandler>,
  req: {
    method: string;
    url: string;
    body?: unknown;
    rawBody?: string;
    omitContentLength?: boolean;
    scopes?: ReadonlyArray<AuthEnvironmentScope>;
    subject?: string;
    allowedWorkspaceDir?: string;
    omitKnownWorkspaces?: boolean;
  },
  invalidated: Effect.Effect<void, never> = Effect.never,
) {
  const bodyStr =
    req.rawBody !== undefined
      ? req.rawBody
      : req.body !== undefined
        ? JSON.stringify(req.body)
        : undefined;

  let webRequest: Request;
  if (bodyStr !== undefined && req.omitContentLength) {
    // Chunked streaming body with no content-length header to verify MaxBodySize enforcement.
    const encoder = new TextEncoder();
    const bytes = encoder.encode(bodyStr);
    const bodyStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
    webRequest = new Request(`http://localhost${req.url}`, {
      method: req.method,
      headers: { "content-type": "application/json" },
      body: bodyStream,
      duplex: "half",
    } as RequestInit);
  } else {
    webRequest = new Request(`http://localhost${req.url}`, {
      method: req.method,
      ...(bodyStr !== undefined
        ? {
            headers: { "content-type": "application/json" },
            body: bodyStr,
          }
        : {}),
    });
  }

  const serverRequest = HttpServerRequest.fromWeb(webRequest);
  const scopes = req.scopes ?? [
    AuthOrchestrationReadScope,
    AuthDiagnosticsReadScope,
    AuthTerminalOperateScope,
    AuthAccessWriteScope,
    AuthEnvironmentMaintainScope,
  ];

  const makeSession = () =>
    Effect.succeed({
      sessionId: "test-session",
      subject: req.subject ?? "test-user",
      method: "browser-session-cookie" as const,
      scopes,
      issuedAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });

  const authLayer = Layer.succeed(EnvironmentAuth.EnvironmentAuth, {
    authenticateHttpRequest: makeSession,
    authenticateWebSocketUpgrade: makeSession,
  } as unknown as typeof EnvironmentAuth.EnvironmentAuth.Service);

  const sessionStoreLayer = Layer.succeed(SessionStore.SessionStore, {
    cookieName: "t3_session",
    legacyCookieName: undefined,
    awaitInvalidation: () => invalidated,
  } as unknown as typeof SessionStore.SessionStore.Service);

  const knownWorkspacesLayer = Layer.succeed(KnownWorkspaces.KnownWorkspaces, {
    contains: (realPath: string) =>
      Effect.succeed(
        req.allowedWorkspaceDir !== undefined &&
          realPath === NodeFS.realpathSync(req.allowedWorkspaceDir),
      ),
    assertContains: (cwd: string) =>
      req.allowedWorkspaceDir !== undefined &&
      NodePath.resolve(cwd) === NodePath.resolve(req.allowedWorkspaceDir)
        ? Effect.void
        : Effect.fail(new KnownWorkspaces.UnknownWorkspaceError({ cwd })),
  });

  const baseLayers = req.omitKnownWorkspaces
    ? Layer.mergeAll(authLayer, sessionStoreLayer, Path.layer)
    : Layer.mergeAll(authLayer, sessionStoreLayer, knownWorkspacesLayer, Path.layer);

  const provided = handler.pipe(
    Effect.provideService(HttpServerRequest.HttpServerRequest, serverRequest),
    Effect.provideService(HostProcess.Platform, "linux"),
    Effect.provide(baseLayers),
  );

  const exit = yield* Effect.exit(provided);
  if (exit._tag === "Failure") {
    return { status: 403, json: { error: String(exit.cause) } as unknown, response: null };
  }
  const response = exit.value;
  const webRes = HttpServerResponse.toWeb(response);
  const contentType = webRes.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream")) {
    return { status: webRes.status, json: null as unknown, response };
  }
  const text = yield* Effect.promise(() => webRes.text());
  return {
    status: webRes.status,
    json: text ? (JSON.parse(text) as unknown) : null,
    response,
  };
});

describe("GuardGrantBroker", () => {
  it("handles preapprove -> peek -> single-use check and rejects forged digests, NUL bytes, and caps", async () => {
    const dir = mkTempDir("t3-guard-broker-");
    const socketPath = NodePath.join(dir, "t3-guard-grant.sock");
    const broker = new GuardGrantBroker({ socketPath, maxPreapproved: 2 });
    await broker.start("linux");

    try {
      const stat = NodeFS.statSync(socketPath);
      expect(stat.mode & 0o777).toBe(0o600);

      const grant = broker.preapprove({
        guard: "git",
        command: ["git", "push", "--force"],
        cwd: dir,
        reason: "rebase confirmed by human",
      });
      expect(grant.ok).toBe(true);
      if (!grant.ok) throw new Error("expected preapprove ok");
      expect(grant.grantId).toBeTruthy();

      // Reject forged argv_sha256 mismatch
      const forged = await sendSocketNdjson(socketPath, {
        v: 1,
        op: "check",
        guard: "git",
        command: ["git", "status"],
        argv_sha256: "0".repeat(64),
        cwd: dir,
      });
      expect(forged.ok).toBe(false);
      expect(forged.error).toBe("argv_sha256 mismatch");

      // Reject NUL byte in argv
      const nulArg = await sendSocketNdjson(socketPath, {
        v: 1,
        op: "check",
        guard: "git",
        command: ["git", "push\0--force"],
        cwd: dir,
      });
      expect(nulArg.ok).toBe(false);

      // Reject >256 args (never silently truncate)
      const tooMany = await sendSocketNdjson(socketPath, {
        v: 1,
        op: "request",
        guard: "git",
        command: Array.from({ length: 260 }, (_, i) => `a${i}`),
        cwd: dir,
      });
      expect(tooMany.ok).toBe(false);

      // Valid peek -> single-use check -> exhausted
      const peek = await sendSocketNdjson(socketPath, {
        v: 1,
        op: "peek",
        guard: "git",
        command: ["git", "push", "--force"],
        cwd: dir,
      });
      expect(peek.ok).toBe(true);

      const check1 = await sendSocketNdjson(socketPath, {
        v: 1,
        op: "check",
        guard: "git",
        command: ["git", "push", "--force"],
        cwd: dir,
      });
      expect(check1.ok).toBe(true);
      expect(check1.reason).toBe("rebase confirmed by human");

      const check2 = await sendSocketNdjson(socketPath, {
        v: 1,
        op: "check",
        guard: "git",
        command: ["git", "push", "--force"],
        cwd: dir,
      });
      expect(check2.ok).toBe(false);

      // Preapprove cap & invalid guard name (never throws)
      expect(broker.preapprove({ guard: "\x01", command: ["x"], cwd: dir }).ok).toBe(false);
      // Redact entire Fly ssh remote command whenever any secret indicator appears
      expect(
        redactArgvCommand(["fly", "ssh", "console", "-C", "PASSWORD=\"dummy \"'secret'tail env"]),
      ).toEqual(["fly", "ssh", "console", "-C", "<redacted-remote-command>"]);
      expect(
        redactArgvCommand(["fly", "ssh", "console", "-C", 'TOKEN="unclosed secret tail']),
      ).toEqual(["fly", "ssh", "console", "-C", "<redacted-remote-command>"]);
      expect(redactArgvCommand(["fly", "ssh", "console", '--command=API_KEY="a"b env'])).toEqual([
        "fly",
        "ssh",
        "console",
        "--command=<redacted-remote-command>",
      ]);
      expect(
        redactArgvCommand([
          "fly",
          "ssh",
          "console",
          '--command=curl -H "Authorization: Bearer tok123" https://u:p@h?token=q; PASSWORD="$(echo "inner") tail"',
        ]),
      ).toEqual(["fly", "ssh", "console", "--command=<redacted-remote-command>"]);
      expect(
        redactArgvCommand(["fly", "ssh", "console", "-a", "myapp", "-C", "ls -la /app"]),
      ).toEqual(["fly", "ssh", "console", "-a", "myapp", "-C", "<redacted-remote-command>"]);
      expect(redactArgvCommand(["fly", "ssh", "console", "-qC", "PASSWORD=secret env"])).toEqual([
        "fly",
        "ssh",
        "console",
        "-qC",
        "<redacted-remote-command>",
      ]);
      expect(
        redactArgvCommand(["fly", "ssh", "console", "-qCPASSWORD=secret", "-qt", "tok123"]),
      ).toEqual(["fly", "ssh", "console", "-qC<redacted-remote-command>", "-qt", "<redacted>"]);
      expect(
        redactArgvCommand(["fly", "ssh", "console", "-a", "-C", "-C", "PASSWORD=secret"]),
      ).toEqual(["fly", "ssh", "console", "-a", "-C", "-C", "<redacted-remote-command>"]);
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
      expect(
        redactArgvCommand(["curl", "--", "Bearer tok123;t https://u:p@h?token=q;tail&ok=1"]),
      ).toEqual(["curl", "--", "Bearer <redacted> https://<redacted>@h?token=<redacted>&ok=1"]);
      expect(redactArgvCommand(["curl", "--", "https://h?a=1;api_key=sec;more&b=2"])).toEqual([
        "curl",
        "--",
        "https://h?a=1;api_key=<redacted>&b=2",
      ]);
      expect(broker.preapprove({ guard: "g1", command: ["a"], cwd: dir }).ok).toBe(true);
      expect(broker.preapprove({ guard: "g2", command: ["b"], cwd: dir }).ok).toBe(true);
      expect(broker.preapprove({ guard: "g3", command: ["c"], cwd: dir }).ok).toBe(false);
    } finally {
      await broker.close();
    }
  });

  it("refuses to hijack a live socket, closes cleanly with open connections, and sends denied:false on shutdown", async () => {
    const dir = mkTempDir("t3-guard-live-");
    const socketPath = NodePath.join(dir, "t3-guard-grant.sock");
    const broker = new GuardGrantBroker({ socketPath });
    await broker.start("linux");

    // Second broker MUST NOT unlink a live socket
    const intruder = new GuardGrantBroker({ socketPath });
    await expect(intruder.start("linux")).rejects.toThrow(/already owned/);
    expect(NodeFS.existsSync(socketPath)).toBe(true);

    // Hold a live request + an idle open socket, then close() and verify fast teardown + denied:false
    const idleSocket = NodeNet.createConnection({ path: socketPath });
    await new Promise<void>((resolve) => idleSocket.once("connect", resolve));

    const addedPromise = waitForBrokerEvent(broker, (e) => e.type === "pending_added");
    const reqPromise = sendSocketNdjsonAsThread(
      socketPath,
      {
        v: 1,
        op: "request",
        guard: "rm",
        command: ["rm", "-rf", "/tmp/demo"],
        cwd: dir,
        refusal: "blocked recursive delete",
        proposed_reason: "clean demo dir",
        thread_id: "thread-live-shutdown",
        timeout: 15,
      },
      "thread-live-shutdown",
    );

    const added = await addedPromise;
    expect(added.type).toBe("pending_added");
    if (added.type !== "pending_added") throw new Error("unexpected event");
    expect(added.request.proposedReason).toBe("clean demo dir");

    await broker.close();
    const reply = await reqPromise;
    expect(reply.ok).toBe(false);
    expect(reply.denied).toBe(false);
    expect(NodeFS.existsSync(socketPath)).toBe(false);
    idleSocket.destroy();
  });

  it("interoperates end-to-end with real Python host-guards/hg_t3_grant.py", async () => {
    const hgPath = findHostGuardsDir();
    if (!hgPath) return;

    const dir = mkTempDir("t3-guard-py-");
    const socketPath = NodePath.join(dir, "t3-guard-grant.sock");
    const broker = new GuardGrantBroker({ socketPath });
    await broker.start("linux");

    try {
      const pre = broker.preapprove({
        guard: "git",
        command: ["git", "tag", "-f", "v1"],
        cwd: dir,
        reason: "preapproved tag",
      });
      expect(pre.ok).toBe(true);

      const addedPromise = waitForBrokerEvent(broker, (e) => e.type === "pending_added");
      const pyScript = `
import json, sys
sys.path.insert(0, ${JSON.stringify(hgPath)})
import hg_t3_grant
peeked = hg_t3_grant.peek("git", ["git", "tag", "-f", "v1"], ${JSON.stringify(dir)})
checked = hg_t3_grant.check("git", ["git", "tag", "-f", "v1"], ${JSON.stringify(dir)})
checked_again = hg_t3_grant.check("git", ["git", "tag", "-f", "v1"], ${JSON.stringify(dir)})
grant, detail, denied = hg_t3_grant.request(
    "git", ["git", "push", "--force"],
    ${JSON.stringify(dir)},
    "force push blocked",
    proposed_reason="rebased feature branch",
    timeout=10,
)
print(json.dumps({
    "peeked": peeked,
    "checked": checked,
    "checked_again": checked_again,
    "grant": grant,
    "detail": detail,
    "denied": denied,
}))
`;
      const pyRun = new Promise<{ code: number | null; stdout: string; stderr: string }>(
        (resolve) => {
          const child = NodeChildProcess.spawn("python3", ["-c", pyScript], {
            env: {
              ...process.env,
              HOME: dir,
              HOST_GUARDS_TEST: "1",
              T3_GUARD_GRANT_SOCKET: socketPath,
              T3CODE_THREAD_ID: "thread-py-interop",
            },
            stdio: ["ignore", "pipe", "pipe"],
          });
          let stdout = "";
          let stderr = "";
          child.stdout.on("data", (d: Buffer) => {
            stdout += d.toString("utf8");
          });
          child.stderr.on("data", (d: Buffer) => {
            stderr += d.toString("utf8");
          });
          child.on("close", (code) => resolve({ code, stdout, stderr }));
        },
      );

      const added = await Promise.race([
        addedPromise,
        pyRun.then((r) => {
          throw new Error(
            `Python exited early (code=${r.code}): stdout=${r.stdout} stderr=${r.stderr}`,
          );
        }),
      ]);
      if (added.type !== "pending_added") throw new Error("expected pending_added");
      expect(added.request.guard).toBe("git");
      expect(added.request.proposedReason).toBe("rebased feature branch");

      broker.resolveRequest(added.request.requestId, {
        decision: "approve",
        reason: "ok from t3 modal",
      });

      const out = await pyRun;
      expect(out.code, out.stderr).toBe(0);
      const parsed = JSON.parse(out.stdout.trim()) as {
        peeked: boolean;
        checked: { grant_id: string; reason: string; approved_by: string } | null;
        checked_again: unknown;
        grant: { grant_id: string; reason: string; approved_by: string } | null;
        detail: string;
        denied: boolean;
      };
      expect(parsed.peeked).toBe(true);
      expect(parsed.checked?.reason).toBe("preapproved tag");
      expect(parsed.checked_again).toBeNull();
      expect(parsed.denied).toBe(false);
      expect(parsed.grant?.reason).toBe("ok from t3 modal");
      expect(parsed.grant?.approved_by).toBe("human");
      expect(parsed.grant?.grant_id).toBeTruthy();
    } finally {
      await broker.close();
    }
  });

  it("steps past one untagged T3 process-launcher helper and rejects generic or chained helpers on Linux", async () => {
    if (!NodeFS.existsSync("/proc/self")) return;
    const dir = mkTempDir("t3-guard-launcher-");
    const socketPath = NodePath.join(dir, "t3-guard-grant.sock");
    const broker = new GuardGrantBroker({ socketPath });
    await broker.start("linux");
    try {
      const pyBin = NodeFS.existsSync("/usr/bin/python3") ? "/usr/bin/python3" : "python3";
      const clientPy = `
import socket, sys
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.connect(sys.argv[1])
s.sendall((sys.argv[2] + "\\n").encode("utf-8"))
buf = b""
while b"\\n" not in buf:
    c = s.recv(4096)
    if not c: break
    buf += c
s.close()
sys.stdout.write(buf.decode("utf-8").splitlines()[0])
`;
      const clientScriptPath = NodePath.join(dir, "client.py");
      NodeFS.writeFileSync(clientScriptPath, clientPy, "utf8");
      const launcherMjs = NodePath.join(dir, "process-launcher.mjs");
      const otherMjs = NodePath.join(dir, "other-helper.mjs");
      const runnerBody = `
import cp from "node:child_process";
const mode = process.env.TEST_HOP_MODE || "direct";
const pyBin = process.env.TEST_PY_BIN;
const clientPath = process.env.TEST_CLIENT_PATH;
const sock = process.env.TEST_SOCK;
const payload = process.env.TEST_PAYLOAD;
const tid = process.env.TEST_CHILD_TID;
if (mode === "direct") {
  const out = cp.execFileSync(pyBin, ["-I", clientPath, sock, payload], {
    env: { ...process.env, T3CODE_THREAD_ID: tid },
    encoding: "utf8",
  });
  process.stdout.write(out);
} else if (mode === "double-launcher") {
  const innerEnv = { ...process.env, TEST_HOP_MODE: "direct" };
  delete innerEnv.T3CODE_THREAD_ID;
  const out = cp.execFileSync(process.execPath, [process.argv[1]], { env: innerEnv, encoding: "utf8" });
  process.stdout.write(out);
} else {
  const innerEnv = { ...process.env };
  delete innerEnv.T3CODE_THREAD_ID;
  const hopPy = "import os, subprocess, sys; env = dict(os.environ, T3CODE_THREAD_ID=sys.argv[4]); sys.stdout.write(subprocess.check_output([sys.executable, '-I', sys.argv[1], sys.argv[2], sys.argv[3]], env=env, text=True))";
  const out = cp.execFileSync(pyBin, ["-I", "-c", hopPy, clientPath, sock, payload, tid], { env: innerEnv, encoding: "utf8" });
  process.stdout.write(out);
}
`;
      NodeFS.writeFileSync(launcherMjs, runnerBody, "utf8");
      NodeFS.writeFileSync(otherMjs, runnerBody, "utf8");

      const runViaScript = (
        scriptPath: string,
        mode: "direct" | "double-launcher" | "py-hop",
        payload: Record<string, unknown>,
        grandchildThreadId: string,
      ): Promise<Record<string, unknown>> => {
        const helperEnv: NodeJS.ProcessEnv = {
          ...process.env,
          TEST_HOP_MODE: mode,
          TEST_PY_BIN: pyBin,
          TEST_CLIENT_PATH: clientScriptPath,
          TEST_SOCK: socketPath,
          TEST_PAYLOAD: JSON.stringify(payload),
          TEST_CHILD_TID: grandchildThreadId,
        };
        delete helperEnv.T3CODE_THREAD_ID;
        return new Promise((resolve, reject) => {
          NodeChildProcess.execFile(
            process.execPath,
            [scriptPath],
            { env: helperEnv, timeout: 10_000 },
            (err, stdout) => {
              if (err) {
                reject(err);
                return;
              }
              resolve(JSON.parse(stdout.trim()) as Record<string, unknown>);
            },
          );
        });
      };

      // 1. Single untagged process-launcher.mjs direct child of server -> allowed.
      const addedPromise = waitForBrokerEvent(broker, (e) => e.type === "pending_added");
      const okResp = await runViaScript(
        launcherMjs,
        "direct",
        {
          v: 1,
          op: "request",
          wait: false,
          guard: "playbook",
          command: ["playbook", "amend", "playbook/PLAYBOOK.md"],
          cwd: dir,
          thread_id: "thread-via-launcher",
          refusal: "change playbook/PLAYBOOK.md",
        },
        "thread-via-launcher",
      );
      expect(okResp.ok).toBe(true);
      expect(okResp.queued).toBe(true);
      const added = await addedPromise;
      if (added.type !== "pending_added") throw new Error("expected pending_added");
      expect(added.request.threadId).toBe("thread-via-launcher");

      // 2. Untagged non-launcher script running the same server binary inode -> rejected.
      const otherHelperResp = await runViaScript(
        otherMjs,
        "direct",
        {
          v: 1,
          op: "request",
          wait: false,
          guard: "playbook",
          command: ["playbook", "amend", "playbook/PLAYBOOK.md"],
          cwd: dir,
          thread_id: "thread-other-helper",
          refusal: "change playbook/PLAYBOOK.md",
        },
        "thread-other-helper",
      );
      expect(otherHelperResp.ok).toBe(false);
      expect(otherHelperResp.error).toBe("thread_id does not match caller process");

      // 3. Chained double process-launcher.mjs hops -> rejected (at most one hop allowed).
      const doubleHopResp = await runViaScript(
        launcherMjs,
        "double-launcher",
        {
          v: 1,
          op: "request",
          wait: false,
          guard: "playbook",
          command: ["playbook", "amend", "playbook/PLAYBOOK.md"],
          cwd: dir,
          thread_id: "thread-double-hop",
          refusal: "change playbook/PLAYBOOK.md",
        },
        "thread-double-hop",
      );
      expect(doubleHopResp.ok).toBe(false);
      expect(doubleHopResp.error).toBe("thread_id does not match caller process");

      // 4. Untagged non-server binary sitting between launcher and tagged process -> rejected.
      const spoofResp = await runViaScript(
        launcherMjs,
        "py-hop",
        {
          v: 1,
          op: "request",
          wait: false,
          guard: "playbook",
          command: ["playbook", "amend", "playbook/PLAYBOOK.md"],
          cwd: dir,
          thread_id: "thread-spoofed",
          refusal: "change playbook/PLAYBOOK.md",
        },
        "thread-spoofed",
      );
      expect(spoofResp.ok).toBe(false);
      expect(spoofResp.error).toBe("thread_id does not match caller process");
    } finally {
      await broker.close();
    }
  });

  it("handles op=identify cleanly when peerPid is absent or peer verification fails", async () => {
    const dir = mkTempDir("t3-guard-identify-meta-");
    const customSock = NodePath.join(dir, "custom.sock");
    const customBroker = new GuardGrantBroker({
      socketPath: customSock,
      resolvePeerThreadId: async () => ({ verified: true, threadId: "thread-custom-no-pid" }),
    });
    await customBroker.start("linux");
    try {
      const resp = await sendSocketNdjson(customSock, { v: 1, op: "identify" });
      expect(resp).toEqual({ ok: true, thread_id: "thread-custom-no-pid" });
      expect("pid" in resp).toBe(false);
    } finally {
      await customBroker.close();
    }

    const unverifiedSock = NodePath.join(dir, "unverified.sock");
    const unverifiedBroker = new GuardGrantBroker({
      socketPath: unverifiedSock,
      resolvePeerThreadId: async () => ({
        verified: false,
        error: "cannot verify caller thread ownership",
      }),
    });
    await unverifiedBroker.start("linux");
    try {
      const resp = await sendSocketNdjson(unverifiedSock, { v: 1, op: "identify" });
      expect(resp).toEqual({ ok: false, error: "cannot verify caller thread ownership" });
    } finally {
      await unverifiedBroker.close();
    }
  });

  it.skipIf(!NodeFS.existsSync("/proc/self"))(
    "supports read-only op=identify and trusts registered Codex app-server (pid, startTime) hops on Linux",
    async () => {
      const dir = mkTempDir("t3-guard-identify-");
      const socketPath = NodePath.join(dir, "t3-guard-grant.sock");
      const registry = makeTrustedProviderRegistry();
      const broker = new GuardGrantBroker({
        socketPath,
        getTrustedCodexAppServers: registry.snapshotCodexAppServers,
      });
      await broker.start("linux");
      try {
        const pyBin = NodeFS.existsSync("/usr/bin/python3") ? "/usr/bin/python3" : "python3";
        const clientPy = `
import json, os, socket, sys
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.connect(sys.argv[1])
s.sendall((sys.argv[2] + "\\n").encode("utf-8"))
buf = b""
while b"\\n" not in buf:
    c = s.recv(4096)
    if not c: break
    buf += c
s.close()
resp = json.loads(buf.decode("utf-8").splitlines()[0])
sys.stdout.write(json.dumps({"self_pid": os.getpid(), "resp": resp}))
`;
        const clientScriptPath = NodePath.join(dir, "identify_client.py");
        NodeFS.writeFileSync(clientScriptPath, clientPy, "utf8");

        const runIdentify = (
          env: NodeJS.ProcessEnv,
          payload: Record<string, unknown> = { v: 1, op: "identify" },
        ): Promise<{ self_pid: number; resp: Record<string, unknown> }> =>
          new Promise((resolve, reject) => {
            NodeChildProcess.execFile(
              pyBin,
              ["-I", clientScriptPath, socketPath, JSON.stringify(payload)],
              { env, timeout: 10_000 },
              (err, stdout) => {
                if (err) {
                  reject(err);
                  return;
                }
                resolve(
                  JSON.parse(stdout.trim()) as { self_pid: number; resp: Record<string, unknown> },
                );
              },
            );
          });

        // 1. Tagged direct child: identify returns kernel-verified pid and thread_id, ignoring spoofed thread_id.
        const tagged = await runIdentify(
          { ...process.env, T3CODE_THREAD_ID: "thread-identify-direct" },
          { v: 1, op: "identify", thread_id: "thread-spoofed" },
        );
        expect(tagged.resp).toEqual({
          ok: true,
          pid: tagged.self_pid,
          thread_id: "thread-identify-direct",
        });

        // 2. Untagged direct child: identify returns ok=true with empty thread_id.
        const untaggedEnv: NodeJS.ProcessEnv = { ...process.env };
        delete untaggedEnv.T3CODE_THREAD_ID;
        const untagged = await runIdentify(untaggedEnv);
        expect(untagged.resp).toEqual({
          ok: true,
          pid: untagged.self_pid,
          thread_id: "",
        });

        // 3. Real untagged child acting as a registered shared codex app-server (no systemd scope or codex binary).
        const codexSimPy = `
import json, os, subprocess, sys
print("READY", flush=True)
for line in sys.stdin:
    req = json.loads(line)
    mode = req["mode"]
    tid = req["tid"]
    sock = req.get("sock") or sys.argv[2]
    if mode == "direct":
        env = dict(os.environ, T3CODE_THREAD_ID=tid)
        out = subprocess.check_output(
            [sys.executable, "-I", sys.argv[1], sock, json.dumps({"v": 1, "op": "identify"})],
            env=env,
            text=True,
        )
    else:
        inner = (
            "import os, subprocess, sys; "
            "env = dict(os.environ, T3CODE_THREAD_ID=sys.argv[4]); "
            "sys.stdout.write(subprocess.check_output([sys.executable, '-I', sys.argv[1], sys.argv[2], sys.argv[3]], env=env, text=True))"
        )
        env = {k: v for k, v in os.environ.items() if k != "T3CODE_THREAD_ID"}
        out = subprocess.check_output(
            [sys.executable, "-I", "-c", inner, sys.argv[1], sock, json.dumps({"v": 1, "op": "identify"}), tid],
            env=env,
            text=True,
        )
    print(out.strip(), flush=True)
`;
        const codexSim = NodeChildProcess.spawn(
          pyBin,
          ["-I", "-c", codexSimPy, clientScriptPath, socketPath],
          { env: untaggedEnv, stdio: ["pipe", "pipe", "pipe"] },
        );
        let simStderr = "";
        codexSim.stderr.on("data", (chunk: Buffer) => {
          simStderr += chunk.toString("utf8");
        });
        const readLine = (): Promise<string> =>
          new Promise((resolve, reject) => {
            let buf = "";
            const cleanup = () => {
              codexSim.stdout.off("data", onData);
              codexSim.off("error", onError);
              codexSim.off("exit", onExit);
            };
            const onData = (chunk: Buffer) => {
              buf += chunk.toString("utf8");
              const idx = buf.indexOf("\n");
              if (idx !== -1) {
                cleanup();
                resolve(buf.slice(0, idx).trim());
              }
            };
            const onError = (err: Error) => {
              cleanup();
              reject(err);
            };
            const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
              cleanup();
              reject(
                new Error(
                  `codex simulator exited early (code=${code}, signal=${signal}): ${simStderr.trim()}`,
                ),
              );
            };
            codexSim.stdout.on("data", onData);
            codexSim.once("error", onError);
            codexSim.once("exit", onExit);
          });
        try {
          expect(await readLine()).toBe("READY");
          const simPid = codexSim.pid!;
          const askSim = async (mode: "direct" | "nested", tid: string, sock?: string) => {
            const linePromise = readLine();
            codexSim.stdin.write(`${JSON.stringify({ mode, tid, ...(sock ? { sock } : {}) })}\n`);
            return JSON.parse(await linePromise) as {
              self_pid: number;
              resp: Record<string, unknown>;
            };
          };

          // Before registration: untagged non-codex child is NOT stepped past.
          const beforeReg = await askSim("direct", "thread-codex-registered");
          expect(beforeReg.resp).toEqual({ ok: true, pid: beforeReg.self_pid, thread_id: "" });

          // After registering its exact (pid, startTime): direct tagged child resolves.
          const release = registry.registerCodexAppServer(simPid);
          const afterReg = await askSim("direct", "thread-codex-registered");
          expect(afterReg.resp).toEqual({
            ok: true,
            pid: afterReg.self_pid,
            thread_id: "thread-codex-registered",
          });

          // Still at most ONE hop past registered Codex: an untagged wrapper between codex and leaf fails to resolve.
          const nestedUnderCodex = await askSim("nested", "thread-codex-nested-escape");
          expect(nestedUnderCodex.resp).toEqual({
            ok: true,
            pid: nestedUnderCodex.self_pid,
            thread_id: "",
          });

          // After release (unregister): direct child no longer resolves.
          release();
          const afterRelease = await askSim("direct", "thread-codex-registered");
          expect(afterRelease.resp).toEqual({
            ok: true,
            pid: afterRelease.self_pid,
            thread_id: "",
          });

          // Mismatched startTime for the exact same PID (simPid) is rejected (PID-reuse defense).
          const wrongStartBroker = new GuardGrantBroker({
            socketPath: NodePath.join(dir, "wrong-start.sock"),
            getTrustedCodexAppServers: () => [
              { pid: simPid, startTime: `${readProcStartTime(simPid) ?? "1"}999` },
            ],
          });
          await wrongStartBroker.start("linux");
          try {
            const wrongStart = await askSim(
              "direct",
              "thread-wrong-start",
              wrongStartBroker.socketPath,
            );
            expect(wrongStart.resp).toEqual({
              ok: true,
              pid: wrongStart.self_pid,
              thread_id: "",
            });
          } finally {
            await wrongStartBroker.close();
          }
        } finally {
          codexSim.kill("SIGTERM");
        }
      } finally {
        await broker.close();
      }
    },
  );
});

describe("FleetRoutePolicy & CliRunners validation", () => {
  it("enforces path allowlist, %2F server IDs, no restart, no traversal, and CLI argument safety", () => {
    expect(isAllowedFleetPath("GET", "/api/events?panels=servers,nodes,hosts")).toBe(true);
    expect(isAllowedFleetPath("POST", "/api/servers/proj%2Fsvc/start")).toBe(true);
    expect(isAllowedFleetPath("POST", "/api/servers/proj/svc/stop")).toBe(true);
    expect(isAllowedFleetPath("POST", "/api/servers/proj/svc/restart")).toBe(false);
    expect(isAllowedFleetPath("POST", "/api/servers/../evil/start")).toBe(false);
    expect(isAllowedFleetPath("POST", "/api/servers/%2e%2e/svc/start")).toBe(false);
    expect(isAllowedFleetPath("GET", "/api/events?evil=1")).toBe(false);
    expect(isAllowedFleetPath("GET", "/api/events?toString=1")).toBe(false);
    expect(isAllowedFleetPath("GET", "/api/events?constructor=1")).toBe(false);

    expect(validatePlaybookRequest({ mode: "check", contracts: ["fleet"] }).ok).toBe(true);
    expect(validatePlaybookRequest({ mode: "check", contracts: ["--ship"] }).ok).toBe(false);
    expect(validatePlaybookRequest({ mode: "doctor", contracts: ["fleet"] }).ok).toBe(false);
    expect(validatePlaybookRequest({ mode: "bogus", contracts: undefined }).ok).toBe(false);
  });
});

describe("DevtoolsHttp routes", () => {
  it.effect(
    "enforces auth scopes, chunked body cap, workspace allowlist, native fleet routes, and SSE teardown",
    () =>
      Effect.gen(function* () {
        const dir = mkTempDir("t3-devtools-http-");
        const guardSock = NodePath.join(dir, "t3-guard-grant.sock");
        const nativeFleet = new NativeFleetService({
          hostname: "fleet-test-host",
          platform: "linux",
          stateDir: dir,
          manifestPath: NodePath.join(dir, "missing-ci-hosts.json"),
          githubAuditPath: NodePath.join(dir, "missing-audit.json"),
          enableBackgroundPolling: false,
          writeNodesFile: false,
        });
        yield* Effect.addFinalizer(() => Effect.sync(() => nativeFleet.close()));

        const broker = new GuardGrantBroker({ socketPath: guardSock });
        yield* Effect.promise(() => broker.start("linux"));
        yield* Effect.addFinalizer(() => Effect.promise(() => broker.close()));
        const registry = JobRegistry.makeJobRegistry({ enableShipBridge: false });
        yield* Effect.addFinalizer(() => Effect.promise(() => registry.dispose()));

        const handler = DevtoolsHttp.makeHandler(
          broker,
          registry,
          undefined,
          undefined,
          nativeFleet,
        );

        // Maintenance-only scope cannot preapprove overrides or run playbook code
        const maintainPreapprove = yield* runHandler(handler, {
          method: "POST",
          url: "/api/devtools/guards/preapprove",
          body: { guard: "git", command: ["git", "status"], cwd: dir },
          scopes: [AuthOrchestrationReadScope, AuthEnvironmentMaintainScope],
        });
        expect(maintainPreapprove.status).toBe(403);

        const maintainPlaybook = yield* runHandler(handler, {
          method: "POST",
          url: "/api/devtools/playbook/run",
          body: { repoDir: dir, mode: "check" },
          scopes: [AuthOrchestrationReadScope, AuthEnvironmentMaintainScope],
          allowedWorkspaceDir: dir,
        });
        expect(maintainPlaybook.status).toBe(403);

        // Peer-link subjects cannot approve host-guard overrides even with wide scopes
        const peerLinkPreapprove = yield* runHandler(handler, {
          method: "POST",
          url: "/api/devtools/guards/preapprove",
          body: { guard: "git", command: ["git", "status"], cwd: dir },
          subject: "peer-link:full-access",
        });
        expect(peerLinkPreapprove.status).toBe(403);

        // Orchestration-read-only scope cannot read DevDeck process command lines or guard events
        const readOnlyDevdeck = yield* runHandler(handler, {
          method: "GET",
          url: "/api/devtools/devdeck/snapshot",
          scopes: [AuthOrchestrationReadScope],
        });
        expect(readOnlyDevdeck.status).toBe(403);

        const readOnlyGuardSse = yield* runHandler(handler, {
          method: "GET",
          url: "/api/devtools/guards/events",
          scopes: [AuthOrchestrationReadScope],
        });
        expect(readOnlyGuardSse.status).toBe(403);

        // Playbook fails closed (503) when KnownWorkspaces service is absent
        const noWorkspaceSvc = yield* runHandler(handler, {
          method: "POST",
          url: "/api/devtools/playbook/run",
          body: { repoDir: dir, mode: "check" },
          omitKnownWorkspaces: true,
        });
        expect(noWorkspaceSvc.status).toBe(503);

        // Thread-scoped single-use grants cannot be stolen by another thread (even if the caller forges
        // thread_id in JSON or spoofs T3CODE_THREAD_ID in a grandchild env); non-blocking hook wait=false works;
        // argv guard ALWAYS rejects spoofed preview/digest mismatch and redacts secrets server-side!
        const secretCurl = [
          "curl",
          "-H",
          "Authorization: Bearer supersecret",
          "https://api.example.com",
        ];
        const spoofedArgv = yield* Effect.promise(() =>
          sendSocketNdjsonAsThread(
            guardSock,
            {
              v: 1,
              op: "request",
              wait: false,
              guard: "argv",
              command: ["curl", "https://benign.example.com"],
              argv_sha256: "a".repeat(64),
              cwd: dir,
              thread_id: "thread-owner-A",
            },
            "thread-owner-A",
          ),
        );
        expect(spoofedArgv.ok).toBe(false);

        const nonBlockingReq = yield* Effect.promise(() =>
          sendSocketNdjsonAsThread(
            guardSock,
            {
              v: 1,
              op: "request",
              wait: false,
              guard: "argv",
              command: secretCurl,
              cwd: dir,
              thread_id: "thread-owner-A",
            },
            "thread-owner-A",
          ),
        );
        expect(nonBlockingReq.ok).toBe(true);
        expect(nonBlockingReq.queued).toBe(true);
        const queuedId = String(nonBlockingReq.request_id);
        const queuedPending = broker.listPending().find((p) => p.requestId === queuedId);
        expect(queuedPending?.command.join(" ")).not.toContain("supersecret");
        expect(queuedPending?.command).toEqual([
          "curl",
          "-H",
          "<redacted>",
          "https://api.example.com",
        ]);

        // Quoted multi-word secrets in fly ssh -C must be completely redacted server-side
        const flyQuotedReq = yield* Effect.promise(() =>
          sendSocketNdjsonAsThread(
            guardSock,
            {
              v: 1,
              op: "request",
              wait: false,
              guard: "argv",
              command: [
                "fly",
                "ssh",
                "console",
                "-C",
                'PASSWORD="dummy first dummy second" ./deploy.sh',
              ],
              cwd: dir,
              thread_id: "thread-owner-A",
            },
            "thread-owner-A",
          ),
        );
        expect(flyQuotedReq.ok).toBe(true);
        const flyPending = broker
          .listPending()
          .find((p) => p.requestId === String(flyQuotedReq.request_id));
        expect(flyPending?.command).toEqual([
          "fly",
          "ssh",
          "console",
          "-C",
          "<redacted-remote-command>",
        ]);
        expect(flyPending?.command.join(" ")).not.toContain("dummy");
        broker.resolveRequest(String(flyQuotedReq.request_id), { decision: "deny" });

        // Legacy audit log lines: JSON commands are redacted on read; non-JSON plain-text lines are omitted.
        const auditLog = NodePath.join(dir, "legacy-overrides.log");
        NodeFS.writeFileSync(
          auditLog,
          [
            JSON.stringify({
              guard: "argv",
              command: ["curl", "--token", "legacySecret999", "https://api.example.com"],
            }),
            "curl --token plainTextSecret888 https://api.example.com",
          ].join("\n") + "\n",
        );
        const auditBroker = new GuardGrantBroker({ auditLogPath: auditLog });
        const auditEntries = auditBroker.readAuditTail(10);
        expect(auditEntries).toEqual([
          { guard: "argv", command: ["curl", "--token", "<redacted>", "https://api.example.com"] },
          { unparsed: true },
        ]);
        expect(JSON.stringify(auditEntries)).not.toContain("Secret");

        const approveQueued = yield* runHandler(handler, {
          method: "POST",
          url: `/api/devtools/guards/requests/${queuedId}/resolve`,
          body: { decision: "approve", reason: "verified curl" },
        });
        expect(approveQueued.status).toBe(200);

        // Attacker thread B cannot steal thread A's grant honestly OR by forging thread_id in JSON OR via grandchild env spoof
        const stolenCheck = yield* Effect.promise(() =>
          sendSocketNdjsonAsThread(
            guardSock,
            {
              v: 1,
              op: "check",
              guard: "argv",
              command: secretCurl,
              cwd: dir,
              thread_id: "thread-attacker-B",
            },
            "thread-attacker-B",
          ),
        );
        expect(stolenCheck.ok).toBe(false);

        const forgedThreadJsonCheck = yield* Effect.promise(() =>
          sendSocketNdjsonAsThread(
            guardSock,
            {
              v: 1,
              op: "check",
              guard: "argv",
              command: secretCurl,
              cwd: dir,
              thread_id: "thread-owner-A",
            },
            "thread-attacker-B",
          ),
        );
        expect(forgedThreadJsonCheck.ok).toBe(false);
        expect(forgedThreadJsonCheck.error).toBe("thread_id does not match caller process");

        const forgedGrandchildEnvCheck = yield* Effect.promise(() =>
          sendSocketNdjsonAsThread(
            guardSock,
            {
              v: 1,
              op: "check",
              guard: "argv",
              command: secretCurl,
              cwd: dir,
              thread_id: "thread-owner-A",
            },
            "thread-attacker-B",
            "thread-owner-A",
          ),
        );
        expect(forgedGrandchildEnvCheck.ok).toBe(false);
        expect(forgedGrandchildEnvCheck.error).toBe("thread_id does not match caller process");

        const forgedExternalCheck = yield* Effect.promise(() =>
          sendSocketNdjsonAsThread(
            guardSock,
            {
              v: 1,
              op: "check",
              guard: "argv",
              command: secretCurl,
              cwd: dir,
              thread_id: "thread-owner-A",
            },
            "",
          ),
        );
        expect(forgedExternalCheck.ok).toBe(false);
        expect(forgedExternalCheck.error).toBe("thread_id does not match caller process");

        // Unresolved thread (effectiveThreadId === "") MUST NOT enqueue or request grants (cannot mint unscoped grants)
        const unresolvedQueuedReq = yield* Effect.promise(() =>
          sendSocketNdjsonAsThread(
            guardSock,
            {
              v: 1,
              op: "request",
              wait: false,
              guard: "git",
              command: ["git", "push", "--force"],
              cwd: dir,
            },
            "",
          ),
        );
        expect(unresolvedQueuedReq.ok).toBe(false);
        expect(unresolvedQueuedReq.error).toBe("override requests require a verified thread_id");

        const unresolvedBlockingReq = yield* Effect.promise(() =>
          sendSocketNdjsonAsThread(
            guardSock,
            {
              v: 1,
              op: "request",
              wait: true,
              guard: "git",
              command: ["git", "push", "--force"],
              cwd: dir,
            },
            "",
          ),
        );
        expect(unresolvedBlockingReq.ok).toBe(false);
        expect(unresolvedBlockingReq.error).toBe("override requests require a verified thread_id");

        // Untagged direct child of server (not codex app-server) spawning a self-tagged grandchild MUST be rejected
        const untaggedAncestorSelfTagCheck = yield* Effect.promise(() =>
          sendSocketNdjsonAsThread(
            guardSock,
            {
              v: 1,
              op: "check",
              guard: "argv",
              command: secretCurl,
              cwd: dir,
              thread_id: "thread-owner-A",
            },
            "",
            "thread-owner-A",
          ),
        );
        expect(untaggedAncestorSelfTagCheck.ok).toBe(false);
        expect(untaggedAncestorSelfTagCheck.error).toBe("thread_id does not match caller process");

        // Untagged direct child spoofing argv=["codex", "app-server"] with a non-codex /proc/<pid>/exe MUST be rejected
        const spoofAppServerScript = NodePath.join(dir, "app-server");
        NodeFS.writeFileSync(
          spoofAppServerScript,
          [
            "import os, subprocess, sys",
            'gc = \'import socket, sys\\ns = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)\\ns.settimeout(5)\\ns.connect(sys.argv[1])\\ns.sendall((sys.argv[2] + "\\\\n").encode())\\nd = b""\\nwhile b"\\\\n" not in d:\\n c = s.recv(4096)\\n if not c: break\\n d += c\\ns.close()\\nsys.stdout.write(d.decode())\'',
            "env = dict(os.environ)",
            "env['T3CODE_THREAD_ID'] = 'thread-owner-A'",
            "sys.stdout.write(subprocess.check_output(['/usr/bin/python3', '-I', '-c', gc, sys.argv[1], sys.argv[2]], env=env, text=True))",
          ].join("\n"),
          "utf8",
        );
        const spoofedCodexArgvCheck = yield* Effect.promise(
          () =>
            new Promise<Record<string, unknown>>((resolve, reject) => {
              const launcher =
                "import os, sys; os.execv('/usr/bin/python3', ['codex', 'app-server', sys.argv[1], sys.argv[2]])";
              const payload = JSON.stringify({
                v: 1,
                op: "check",
                guard: "argv",
                command: secretCurl,
                cwd: dir,
                thread_id: "thread-owner-A",
              });
              const cleanEnv = { ...process.env };
              delete cleanEnv.T3CODE_THREAD_ID;
              NodeChildProcess.execFile(
                "/usr/bin/python3",
                ["-I", "-c", launcher, guardSock, payload],
                { cwd: dir, env: cleanEnv, timeout: 10_000 },
                (err, stdout) => {
                  if (err) {
                    reject(err);
                    return;
                  }
                  try {
                    resolve(JSON.parse(stdout.trim()) as Record<string, unknown>);
                  } catch (parseErr) {
                    reject(parseErr);
                  }
                },
              );
            }),
        );
        expect(spoofedCodexArgvCheck.ok).toBe(false);
        expect(spoofedCodexArgvCheck.error).toBe("thread_id does not match caller process");

        // Detached double-forked orphan outside server ancestry (even sharing cgroup with a live tagged child) MUST be rejected
        const liveTaggedChild = NodeChildProcess.spawn(
          "/usr/bin/python3",
          ["-I", "-c", "import time; time.sleep(10)"],
          { env: { ...process.env, T3CODE_THREAD_ID: "thread-owner-A" }, stdio: "ignore" },
        );
        try {
          const orphanCheck = yield* Effect.promise(
            () =>
              new Promise<Record<string, unknown>>((resolve, reject) => {
                const py = [
                  "import json, os, socket, sys",
                  "r_fd, w_fd = os.pipe()",
                  "pid1 = os.fork()",
                  "if pid1 == 0:",
                  "  os.close(r_fd)",
                  "  pid2 = os.fork()",
                  "  if pid2 > 0:",
                  "    os._exit(0)",
                  "  s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)",
                  "  s.settimeout(5)",
                  "  s.connect(sys.argv[1])",
                  "  s.sendall((sys.argv[2] + '\\n').encode('utf-8'))",
                  "  data = b''",
                  "  while b'\\n' not in data:",
                  "    chunk = s.recv(4096)",
                  "    if not chunk: break",
                  "    data += chunk",
                  "  s.close()",
                  "  os.write(w_fd, data)",
                  "  os.close(w_fd)",
                  "  os._exit(0)",
                  "os.close(w_fd)",
                  "os.waitpid(pid1, 0)",
                  "out = b''",
                  "while True:",
                  "  chunk = os.read(r_fd, 4096)",
                  "  if not chunk: break",
                  "  out += chunk",
                  "os.close(r_fd)",
                  "sys.stdout.write(out.decode('utf-8'))",
                ].join("\n");
                const payload = JSON.stringify({
                  v: 1,
                  op: "check",
                  guard: "argv",
                  command: secretCurl,
                  cwd: dir,
                  thread_id: "thread-owner-A",
                });
                NodeChildProcess.execFile(
                  "/usr/bin/python3",
                  ["-I", "-c", py, guardSock, payload],
                  { env: { ...process.env, T3CODE_THREAD_ID: "thread-owner-A" }, timeout: 10_000 },
                  (err, stdout) => {
                    if (err) {
                      reject(err);
                      return;
                    }
                    try {
                      resolve(JSON.parse(stdout.trim()) as Record<string, unknown>);
                    } catch (parseErr) {
                      reject(parseErr);
                    }
                  },
                );
              }),
          );
          expect(orphanCheck.ok).toBe(false);
          expect(orphanCheck.error).toBe("thread_id does not match caller process");
        } finally {
          liveTaggedChild.kill("SIGKILL");
        }

        // macOS (darwin) with default resolver MUST NOT bind socket or accept preapprovals
        const macDir = mkTempDir("t3-guard-mac-");
        const macSock = NodePath.join(macDir, "t3-guard-grant.sock");
        const macBroker = new GuardGrantBroker({ socketPath: macSock });
        yield* Effect.promise(() => macBroker.start("darwin"));
        try {
          expect(macBroker.listening).toBe(false);
          expect(NodeFS.existsSync(macSock)).toBe(false);
          const macPre = macBroker.preapprove({
            guard: "git",
            command: ["git", "status"],
            cwd: macDir,
          });
          expect(macPre.ok).toBe(false);
          const macHandler = DevtoolsHttp.makeHandler(
            macBroker,
            registry,
            undefined,
            undefined,
            nativeFleet,
          );
          const macHttpPre = yield* runHandler(macHandler, {
            method: "POST",
            url: "/api/devtools/guards/preapprove",
            body: { guard: "git", command: ["git", "status"], cwd: macDir },
          });
          expect(macHttpPre.status).toBe(503);
        } finally {
          yield* Effect.promise(() => macBroker.close());
        }

        // Failed peer verification MUST fail closed even for empty thread_id against an unscoped grant
        const unverifiedDir = mkTempDir("t3-guard-unverified-");
        const unverifiedSock = NodePath.join(unverifiedDir, "t3-guard-grant.sock");
        const unverifiedBroker = new GuardGrantBroker({
          socketPath: unverifiedSock,
          resolvePeerThreadId: async () => ({ verified: false, error: "peer check failed" }),
        });
        yield* Effect.promise(() => unverifiedBroker.start("linux"));
        try {
          expect(
            unverifiedBroker.preapprove({
              guard: "git",
              command: ["git", "status"],
              cwd: unverifiedDir,
            }).ok,
          ).toBe(true);
          const unverifiedResp = yield* Effect.promise(() =>
            sendSocketNdjson(unverifiedSock, {
              v: 1,
              op: "check",
              guard: "git",
              command: ["git", "status"],
              cwd: unverifiedDir,
            }),
          );
          expect(unverifiedResp.ok).toBe(false);
          expect(unverifiedResp.error).toBe("peer check failed");
        } finally {
          yield* Effect.promise(() => unverifiedBroker.close());
        }

        // Hook-before-shim consume_existing=false must NOT delete an approved grant
        const peekViaEnqueue = yield* Effect.promise(() =>
          sendSocketNdjsonAsThread(
            guardSock,
            {
              v: 1,
              op: "request",
              wait: false,
              consume_existing: false,
              guard: "argv",
              command: secretCurl,
              cwd: dir,
              thread_id: "thread-owner-A",
            },
            "thread-owner-A",
          ),
        );
        expect(peekViaEnqueue.ok).toBe(true);
        expect(peekViaEnqueue.already_approved).toBe(true);

        const ownerCheck = yield* Effect.promise(() =>
          sendSocketNdjsonAsThread(
            guardSock,
            {
              v: 1,
              op: "check",
              guard: "argv",
              command: secretCurl,
              cwd: dir,
              thread_id: "thread-owner-A",
            },
            "thread-owner-A",
          ),
        );
        expect(ownerCheck.ok).toBe(true);
        expect(ownerCheck.thread_id).toBe("thread-owner-A");
        expect(ownerCheck.approved_via).toBe("browser-session-cookie:test-user");

        // Read-only scope cannot call POST mutations or read privileged /guards/grants
        const forbiddenGrants = yield* runHandler(handler, {
          method: "GET",
          url: "/api/devtools/guards/grants",
          scopes: [AuthOrchestrationReadScope],
        });
        expect(forbiddenGrants.status).toBe(403);
        const forbiddenPost = yield* runHandler(handler, {
          method: "POST",
          url: "/api/devtools/guards/preapprove",
          body: { guard: "git", command: ["git", "status"], cwd: dir },
          scopes: [AuthOrchestrationReadScope],
        });
        expect(forbiddenPost.status).toBe(403);

        // Chunked body >64KB must return 413
        const chunkedTooLarge = yield* runHandler(handler, {
          method: "POST",
          url: "/api/devtools/guards/preapprove",
          rawBody: JSON.stringify({
            guard: "git",
            command: ["git", "commit", "-m", "a".repeat(70 * 1024)],
            cwd: dir,
          }),
          omitContentLength: true,
        });
        expect(chunkedTooLarge.status).toBe(413);

        // Control-char guard returns 400 (never 500)
        const badGuard = yield* runHandler(handler, {
          method: "POST",
          url: "/api/devtools/guards/preapprove",
          body: { guard: "\x01", command: ["git", "status"], cwd: dir },
        });
        expect(badGuard.status).toBe(400);

        // Playbook rejects unregistered workspace with 403
        const badWorkspace = yield* runHandler(handler, {
          method: "POST",
          url: "/api/devtools/playbook/run",
          body: { repoDir: "/etc", mode: "check" },
          allowedWorkspaceDir: dir,
        });
        expect(badWorkspace.status).toBe(403);

        // Capabilities return clean booleans without filesystem paths
        const caps = yield* runHandler(handler, {
          method: "GET",
          url: "/api/devtools/capabilities",
        });
        expect(caps.status).toBe(200);
        expect((caps.json as { guardBrokerListening: boolean }).guardBrokerListening).toBe(true);
        expect("guardSocketPath" in (caps.json as Record<string, unknown>)).toBe(false);

        // Native fleet serves allowed routes; the GitHub audit file is missing, so alerts stay silent.
        const snap = yield* runHandler(handler, {
          method: "GET",
          url: "/api/devtools/devdeck/snapshot?panels=alerts",
        });
        expect(snap.status).toBe(200);
        const snapAlerts = (snap.json as { alerts: { items: ReadonlyArray<{ name: string }> } })
          .alerts.items;
        expect(snapAlerts.map((item) => item.name)).toContain("Audit coverage");

        const forbidden = yield* runHandler(handler, {
          method: "GET",
          url: "/api/devtools/devdeck/not-allowed",
        });
        expect(forbidden.status).toBe(404);

        // Operator with only terminal:operate can poll GET /devdeck/actions/:id (not blocked by diagnostics:read)
        const kick = yield* runHandler(handler, {
          method: "POST",
          url: "/api/devtools/devdeck/sessions/proc%3A999999999/close",
          body: {},
        });
        expect(kick.status).toBe(202);
        const actionId = (kick.json as { action_id: string }).action_id;
        const actionStatus = yield* runHandler(handler, {
          method: "GET",
          url: `/api/devtools/devdeck/actions/${actionId}`,
          scopes: [AuthTerminalOperateScope],
        });
        expect(actionStatus.status).toBe(200);
        const missingAction = yield* runHandler(handler, {
          method: "GET",
          url: "/api/devtools/devdeck/actions/act_missing",
          scopes: [AuthTerminalOperateScope],
        });
        expect(missingAction.status).toBe(404);

        // SSE /guards/events + live resolve + session invalidation teardown
        const invalidateDeferred = Deferred.makeUnsafe<void>();
        const sseRes = yield* runHandler(
          handler,
          { method: "GET", url: "/api/devtools/guards/events" },
          Deferred.await(invalidateDeferred),
        );
        expect(sseRes.status).toBe(200);
        const webSse = HttpServerResponse.toWeb(sseRes.response!);
        const reader = webSse.body!.getReader();
        const decoder = new TextDecoder();
        const readData = async (): Promise<string> => {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) return "";
            const text = decoder.decode(chunk.value);
            if (text.includes("data:")) return text;
          }
        };

        expect(yield* Effect.promise(() => readData())).toContain('"type":"snapshot"');

        const addedPromise = waitForBrokerEvent(broker, (e) => e.type === "pending_added");
        const sockReq = sendSocketNdjsonAsThread(
          guardSock,
          {
            v: 1,
            op: "request",
            guard: "git",
            command: ["git", "reset", "--hard"],
            cwd: dir,
            thread_id: "thread-sse-live",
            timeout: 15,
          },
          "thread-sse-live",
        );

        const added = yield* Effect.promise(() => addedPromise);
        expect(added.type).toBe("pending_added");
        expect(yield* Effect.promise(() => readData())).toContain('"type":"pending_added"');

        const pendingRes = yield* runHandler(handler, {
          method: "GET",
          url: "/api/devtools/guards/pending",
        });
        const pendingList = (pendingRes.json as { pending: Array<{ requestId: string }> }).pending;
        expect(pendingList).toHaveLength(1);

        const resolveRes = yield* runHandler(handler, {
          method: "POST",
          url: `/api/devtools/guards/requests/${pendingList[0]!.requestId}/resolve`,
          body: { decision: "deny", reason: "nope" },
        });
        expect(resolveRes.status).toBe(200);

        expect(yield* Effect.promise(() => readData())).toContain('"type":"pending_resolved"');

        const sockReply = yield* Effect.promise(() => sockReq);
        expect(sockReply.ok).toBe(false);
        expect(sockReply.denied).toBe(true);

        yield* Deferred.succeed(invalidateDeferred, undefined);
        const endChunk = yield* Effect.promise(() => reader.read());
        expect(endChunk.done).toBe(true);
      }),
  );

  it.effect("runs /playbook/run in-process and gates the challenge and review-thread routes", () =>
    Effect.gen(function* () {
      const repoDir = NodePath.join(mkTempDir("t3-pb-run-"), "sample-repo");
      NodeFS.mkdirSync(NodePath.join(repoDir, "src"), { recursive: true });
      NodeFS.writeFileSync(
        NodePath.join(repoDir, "playbook.json"),
        JSON.stringify({
          contracts: {
            size: { command: `echo '{"src/a.ts": 2}'` },
            fleet: { file: "fleet.json", reads: "echo '{}'" },
            tools: { steps: [] },
            generations: { command: null },
            optimization: { none: "nothing to budget: no route, job or action" },
          },
        }),
      );
      NodeFS.writeFileSync(NodePath.join(repoDir, "src", "a.ts"), "export const a = 1;\n");
      for (const args of [
        ["init", "-q", "-b", "trunk"],
        ["remote", "add", "origin", "https://github.com/acme-fixture/sample-repo.git"],
        ["add", "-A"],
        [
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@example.com",
          "commit",
          "-q",
          "-m",
          "base",
        ],
      ]) {
        const res = NodeChildProcess.spawnSync("git", ["-C", repoDir, ...args], {
          encoding: "utf8",
        });
        expect(res.status).toBe(0);
      }
      const broker = new GuardGrantBroker({
        exceptionsPaths: [NodePath.join(repoDir, "none.json")],
      });
      const registry = JobRegistry.makeJobRegistry({ enableShipBridge: false });
      yield* Effect.addFinalizer(() => Effect.promise(() => registry.dispose()));
      const handler = DevtoolsHttp.makeHandler(broker, registry);

      const run = yield* runHandler(handler, {
        method: "POST",
        url: "/api/devtools/playbook/run",
        body: { repoDir, mode: "check", contracts: ["size"] },
        allowedWorkspaceDir: repoDir,
      });
      const report = run.json as {
        exitCode: number;
        data: { repo: string; results: Array<{ check: string; status: string }> };
      };
      expect(report.data.repo).toBe("sample-repo");
      expect(report.data.results.map((r) => `${r.check}:${r.status}`)).toEqual([
        "declaration:PASS",
        "ratchet:UNPROVEN",
        "size:PASS",
      ]);
      expect(report.exitCode).toBe(3);

      const doctor = yield* runHandler(handler, {
        method: "POST",
        url: "/api/devtools/playbook/run",
        body: { repoDir, mode: "doctor" },
        allowedWorkspaceDir: repoDir,
      });
      expect(doctor.json).toMatchObject({ ok: true, exitCode: 0 });

      const badContract = yield* runHandler(handler, {
        method: "POST",
        url: "/api/devtools/playbook/run",
        body: { repoDir, mode: "check", contracts: ["--ship"] },
        allowedWorkspaceDir: repoDir,
      });
      expect(badContract.status).toBe(400);

      const challenge = yield* runHandler(handler, {
        method: "POST",
        url: "/api/devtools/playbook/challenge",
        body: { repoDir },
        allowedWorkspaceDir: repoDir,
      });
      expect(challenge.status).toBe(503);

      const unregistered = yield* runHandler(handler, {
        method: "POST",
        url: "/api/devtools/playbook/challenge",
        body: { repoDir: "/etc" },
        allowedWorkspaceDir: repoDir,
      });
      expect(unregistered.status).toBe(403);

      const verify = yield* runHandler(handler, {
        method: "GET",
        url: "/api/devtools/review-threads/verify?threadId=thread-review-1",
      });
      expect(verify.status).toBe(503);
      const verifyReadOnly = yield* runHandler(handler, {
        method: "GET",
        url: "/api/devtools/review-threads/verify?threadId=thread-review-1",
        scopes: [AuthOrchestrationReadScope],
      });
      expect(verifyReadOnly.status).toBe(403);

      // Peer-link and MCP sessions never run repo commands or read review text.
      for (const [method, url, body] of [
        ["POST", "/api/devtools/playbook/run", { repoDir, mode: "check" }],
        ["POST", "/api/devtools/playbook/challenge", { repoDir }],
        ["GET", "/api/devtools/review-threads/verify?threadId=thread-review-1", undefined],
      ] as const) {
        const peer = yield* runHandler(handler, {
          method,
          url,
          ...(body ? { body } : {}),
          subject: "peer-link:full-access",
          allowedWorkspaceDir: repoDir,
        });
        expect(peer.status, url).toBe(403);
      }
    }),
  );

  it.effect("serves GET /playbook/declaration and normalized /guards/exceptions waivers", () =>
    Effect.gen(function* () {
      const dir = mkTempDir("t3-pb-decl-");
      const repoDir = NodePath.join(dir, "sample-repo");
      NodeFS.mkdirSync(NodePath.join(repoDir, "playbook"), { recursive: true });
      NodeFS.writeFileSync(
        NodePath.join(repoDir, "playbook.json"),
        JSON.stringify({
          contracts: {
            size: { baseline: "size-baseline.json", command: "playbook size" },
            tools: {
              steps: [{ name: "lint" }, { name: "test" }],
            },
          },
        }),
      );
      NodeFS.writeFileSync(
        NodePath.join(repoDir, "size-baseline.json"),
        JSON.stringify([
          { path: "a.ts", expires: "2026-12-31" },
          { path: "b.ts", expires: "2026-11-25" },
        ]),
      );
      NodeFS.writeFileSync(
        NodePath.join(repoDir, "playbook", "PLAYBOOK.md"),
        "## 0. Scope\n\n## 3. File Size\n\n## 14. Tool Gates\n",
      );
      const excPath = NodePath.join(dir, "exceptions.json");
      NodeFS.writeFileSync(
        excPath,
        JSON.stringify({
          repos: {
            "sample-repo": {
              playbook: {
                size: "Temporary waiver until refactor completes (#99) 2026-11-18",
              },
            },
            "other-repo": {
              guards: "Vendor checkout exempt 2026-10-01",
            },
          },
        }),
      );

      const broker = new GuardGrantBroker({ exceptionsPaths: [excPath] });
      const registry = JobRegistry.makeJobRegistry({ enableShipBridge: false });
      yield* Effect.addFinalizer(() => Effect.promise(() => registry.dispose()));
      const handler = DevtoolsHttp.makeHandler(broker, registry);

      const badRelative = yield* runHandler(handler, {
        method: "GET",
        url: "/api/devtools/playbook/declaration?repoDir=relative/path",
        allowedWorkspaceDir: repoDir,
      });
      expect(badRelative.status).toBe(400);

      const unreg = yield* runHandler(handler, {
        method: "GET",
        url: "/api/devtools/playbook/declaration?repoDir=/etc",
        allowedWorkspaceDir: repoDir,
      });
      expect(unreg.status).toBe(403);

      const decl = yield* runHandler(handler, {
        method: "GET",
        url: `/api/devtools/playbook/declaration?repoDir=${encodeURIComponent(repoDir)}`,
        allowedWorkspaceDir: repoDir,
      });
      expect(decl.status).toBe(200);
      const payload = decl.json as {
        repoName: string;
        hasPlaybookJson: boolean;
        contracts: Array<{
          name: string;
          baselineCount: number | null;
          nearestExpiry: string | null;
          status: string;
        }>;
        rules: Array<{ section: number; status: string }>;
      };
      expect(payload.repoName).toBe("sample-repo");
      expect(payload.hasPlaybookJson).toBe(true);
      const sizeContract = payload.contracts.find((c) => c.name === "size");
      expect(sizeContract).toMatchObject({
        baselineCount: 2,
        nearestExpiry: "2026-11-25",
        status: "waived",
      });
      const toolsContract = payload.contracts.find((c) => c.name === "tools");
      expect(toolsContract?.status).toBe("enforced");
      expect(payload.rules.map((r) => [r.section, r.status])).toEqual([
        [0, "enforced"],
        [3, "waived"],
        [14, "enforced"],
      ]);

      const excRes = yield* runHandler(handler, {
        method: "GET",
        url: "/api/devtools/guards/exceptions",
      });
      expect(excRes.status).toBe(200);
      const excJson = excRes.json as {
        waivers: Array<{ repo: string; scope: string; key: string; issueRef: string | null }>;
      };
      expect(excJson.waivers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            repo: "sample-repo",
            scope: "playbook",
            key: "size",
            issueRef: "#99",
          }),
          expect.objectContaining({
            repo: "other-repo",
            scope: "guards",
            key: "guards",
          }),
        ]),
      );
    }),
  );

  it.effect(
    "serves GET /ship-queue/deps and enforces human-only auth and validation on /ship-queue/deps/decide and /scan",
    () =>
      Effect.gen(function* () {
        const dir = mkTempDir("t3-sq-deps-");
        const createdSec = 1_795_000_000;

        // 1) Active holding repo with concrete package updates
        NodeFS.mkdirSync(NodePath.join(dir, "dependencies", "private-repo"), { recursive: true });
        NodeFS.writeFileSync(
          NodePath.join(dir, "dependencies", "private-repo", "state.json"),
          JSON.stringify({
            holding: true,
            report: {
              id: "private-repo:abc123",
              status: "pending",
              created: createdSec - 60,
              updates: [
                {
                  packageFile: "Cargo.toml",
                  depName: "serde",
                  currentValue: "1.0.210",
                  newValue: "1.0.215",
                },
              ],
              waiting: [{ depName: "tokio" }],
              held: [],
              incomplete: [],
            },
          }),
        );

        // 2) Inactive onboarding repo (not blocking shipping)
        NodeFS.mkdirSync(NodePath.join(dir, "dependencies", "exp"), { recursive: true });
        NodeFS.writeFileSync(
          NodePath.join(dir, "dependencies", "exp", "state.json"),
          JSON.stringify({
            holding: false,
            report: {
              id: "exp:def456",
              status: "pending",
              created: createdSec - 120,
              updates: [
                {
                  packageFile: "package.json",
                  depName: "vite",
                  currentValue: "^6.0.0",
                  newValue: "^6.0.0",
                  currentVersion: "6.0.1",
                  newVersion: "6.1.0",
                },
              ],
              held: [{ depName: "react" }],
              incomplete: [{ manager: "cargo" }],
            },
          }),
        );

        // 3) Superseded merged attempt report
        NodeFS.mkdirSync(NodePath.join(dir, "dependencies", "devtools"), { recursive: true });
        NodeFS.writeFileSync(
          NodePath.join(dir, "dependencies", "devtools", "state.json"),
          JSON.stringify({
            holding: true,
            report: {
              id: "devtools:old1",
              status: "pending",
              created: createdSec - 60,
              updates: [{ packageFile: "go.mod", depName: "x", currentValue: "1", newValue: "2" }],
            },
            attempt: {
              id: "devtools:att1",
              status: "merged",
              report: { id: "devtools:old1" },
            },
          }),
        );

        const broker = new GuardGrantBroker();
        const registry = JobRegistry.makeJobRegistry({ enableShipBridge: false });
        yield* Effect.addFinalizer(() => Effect.promise(() => registry.dispose()));
        const handler = DevtoolsHttp.makeHandler(broker, registry, undefined, dir);

        const listRes = yield* runHandler(handler, {
          method: "GET",
          url: "/api/devtools/ship-queue/deps",
          scopes: [AuthOrchestrationReadScope],
        });
        expect(listRes.status).toBe(200);
        const listJson = listRes.json as {
          repos: Array<{
            repo: string;
            holding: boolean;
            active: boolean;
            status: string;
            pendingCount: number;
            waitingCount: number;
            heldCount: number;
            failedCount: number;
            updates: Array<{ depName: string; currentValue: string; newValue: string }>;
          }>;
        };
        expect(listJson.repos.map((r) => r.repo)).toEqual(["devtools", "exp", "private-repo"]);
        const private-repo = listJson.repos.find((r) => r.repo === "private-repo")!;
        expect(private-repo.holding).toBe(true);
        expect(private-repo.pendingCount).toBe(1);
        expect(private-repo.waitingCount).toBe(1);
        expect(private-repo.updates[0]).toMatchObject({
          depName: "serde",
          currentValue: "1.0.210",
          newValue: "1.0.215",
        });

        const exp = listJson.repos.find((r) => r.repo === "exp")!;
        expect(exp.active).toBe(false);
        expect(exp.holding).toBe(false);
        expect(exp.heldCount).toBe(1);
        expect(exp.failedCount).toBe(1);
        expect(exp.updates[0]).toMatchObject({
          depName: "vite",
          currentValue: "6.0.1",
          newValue: "6.1.0",
        });

        const devtools = listJson.repos.find((r) => r.repo === "devtools")!;
        expect(devtools.status).toBe("superseded");
        expect(devtools.pendingCount).toBe(0);
        expect(devtools.updates).toEqual([]);

        // MCP / peer-link callers are rejected from /ship-queue/deps/decide
        const mcpRes = yield* runHandler(handler, {
          method: "POST",
          url: "/api/devtools/ship-queue/deps/decide",
          subject: "mcp-agent",
          body: { reportId: "private-repo:abc123", decision: "reject" },
        });
        expect(mcpRes.status).toBe(403);

        const peerRes = yield* runHandler(handler, {
          method: "POST",
          url: "/api/devtools/ship-queue/deps/decide",
          subject: "peer-link:remote",
          body: { reportId: "private-repo:abc123", decision: "approve" },
        });
        expect(peerRes.status).toBe(403);

        // Missing AuthAccessWriteScope is rejected
        const narrowScopeRes = yield* runHandler(handler, {
          method: "POST",
          url: "/api/devtools/ship-queue/deps/decide",
          scopes: [AuthTerminalOperateScope],
          body: { reportId: "private-repo:abc123", decision: "reject" },
        });
        expect(narrowScopeRes.status).toBe(403);

        // Input validation & offline broker fail closed
        const badReport = yield* runHandler(handler, {
          method: "POST",
          url: "/api/devtools/ship-queue/deps/decide",
          body: { reportId: "../bad", decision: "reject" },
        });
        expect(badReport.status).toBe(400);

        const badDecision = yield* runHandler(handler, {
          method: "POST",
          url: "/api/devtools/ship-queue/deps/decide",
          body: { reportId: "private-repo:abc123", decision: "merge" },
        });
        expect(badDecision.status).toBe(400);

        const brokerOff = yield* runHandler(handler, {
          method: "POST",
          url: "/api/devtools/ship-queue/deps/decide",
          body: { reportId: "private-repo:abc123", decision: "reject" },
        });
        expect(brokerOff.status).toBe(503);

        // /ship-queue/deps/scan validation & scope checks
        const scanNoScope = yield* runHandler(handler, {
          method: "POST",
          url: "/api/devtools/ship-queue/deps/scan",
          scopes: [AuthOrchestrationReadScope],
          body: { repo: "private-repo" },
        });
        expect(scanNoScope.status).toBe(403);

        const scanBadRepo = yield* runHandler(handler, {
          method: "POST",
          url: "/api/devtools/ship-queue/deps/scan",
          body: { repo: "../evil" },
        });
        expect(scanBadRepo.status).toBe(400);

        // The legacy DevDeck daemon start route is retired.
        const retiredStart = yield* runHandler(handler, {
          method: "POST",
          url: "/api/devtools/devdeck/start",
          body: {},
        });
        expect(retiredStart.status).toBe(404);
      }),
  );

  it("allows POST /api/sessions/<id>/close with ?node=<host> and rejects invalid POST queries", () => {
    expect(
      isAllowedFleetPath(
        "POST",
        "/api/sessions/process%3A1180298%3A26379999/close?node=dev-host-x",
      ),
    ).toBe(true);
    expect(
      isAllowedFleetPath("POST", "/api/sessions/process%3A1180298%3A26379999/close?panels=host"),
    ).toBe(false);
    expect(isAllowedFleetPath("POST", "/api/hosts/check?node=dev-host-x")).toBe(false);
    expect(
      isAllowedFleetPath("POST", "/api/sessions/process%3A1180298%3A26379999/close?node=../etc"),
    ).toBe(false);
  });

  it("registers layer cleanly in HttpRouter and forwards Layer-provided JobRegistry to /api/devtools/jobs", async () => {
    const now = DateTime.nowUnsafe();
    const tid = ThreadId.make("thread-exp-1");
    const registry = JobRegistry.makeJobRegistry({
      enableShipBridge: false,
      backgroundBridge: {
        localHostname: "dev-host-x",
        ciHostsPath: null,
        getShellSnapshot: async () => ({
          schemaVersion: 1,
          snapshotSequence: 0,
          threads: [],
          archivedThreads: [],
        }),
        getRunningCommandsForThread: async () => [],
        streamDomainEvents: Stream.make({
          id: EventId.make("ev-exp-1"),
          threadId: tid,
          occurredAt: now,
          type: "provider-thread.updated",
          payload: {
            id: ProviderThreadId.make("pt-exp"),
            driver: ProviderDriverKind.make("claudeAgent"),
            providerInstanceId: ProviderInstanceId.make("claudeAgent"),
            providerSessionId: null,
            appThreadId: tid,
            ownerNodeId: null,
            nativeThreadRef: null,
            nativeConversationHeadRef: null,
            status: "active",
            firstRunOrdinal: null,
            lastRunOrdinal: null,
            handoffIds: [],
            forkedFrom: null,
            pendingBackgroundTasks: [
              {
                taskId: "exp-build-1",
                kind: "command",
                description: "EXP shipping check",
                command: "cargo build --release",
              },
            ],
            contextUsage: null,
            nativeMetadata: null,
            goal: null,
            createdAt: now,
            updatedAt: now,
          },
        }),
        subscribeCommandOutput: () => Stream.empty,
        stopThread: async () => ({ ok: true }),
        isWorkspaceAllowed: async () => false,
      },
    });
    await expect.poll(async () => (await registry.listJobs()).length, { timeout: 2_000 }).toBe(1);

    const makeSession = () =>
      Effect.succeed({
        sessionId: "test-session",
        subject: "test-user",
        method: "browser-session-cookie" as const,
        scopes: [
          AuthOrchestrationReadScope,
          AuthDiagnosticsReadScope,
          AuthTerminalOperateScope,
          AuthAccessWriteScope,
        ],
        issuedAt: "2026-01-01T00:00:00.000Z",
        expiresAt: "2099-01-01T00:00:00.000Z",
      });

    const routeLayer = DevtoolsHttp.makeLayer({ startBroker: false }).pipe(
      // Mirror server.ts: JobRegistry is provided to the route layer via Layer.provide,
      // not via deps.jobRegistry and not merged into the outer HTTP runtime.
      Layer.provide(Layer.succeed(JobRegistry.JobRegistry, registry)),
      Layer.provideMerge(Layer.succeed(HostProcess.Platform, "linux")),
      Layer.provideMerge(Path.layer),
      Layer.provideMerge(
        Layer.succeed(EnvironmentAuth.EnvironmentAuth, {
          authenticateHttpRequest: makeSession,
          authenticateWebSocketUpgrade: makeSession,
        } as unknown as typeof EnvironmentAuth.EnvironmentAuth.Service),
      ),
      Layer.provideMerge(
        Layer.succeed(SessionStore.SessionStore, {
          cookieName: "t3_session",
          legacyCookieName: undefined,
          awaitSessionInvalidated: () => Effect.never,
        } as unknown as typeof SessionStore.SessionStore.Service),
      ),
      Layer.provide(HttpPlatform.layer),
      Layer.provide(Etag.layerWeak),
      Layer.provide(NodeServices.layer),
    );

    const { handler, dispose } = HttpRouter.toWebHandler(routeLayer, { disableLogger: true });
    try {
      const res = await handler(new Request("http://localhost/api/devtools/jobs"));
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        readonly jobs: ReadonlyArray<{ readonly title: string }>;
      };
      expect(json.jobs.some((j) => j.title === "EXP shipping check")).toBe(true);

      const capsRes = await handler(new Request("http://localhost/api/devtools/capabilities"));
      expect(capsRes.status).toBe(200);
      const capsJson = (await capsRes.json()) as {
        readonly services?: Record<string, string>;
      };
      expect(capsJson.services?.guardBroker).toBe("stopped");
      expect(["uninstalled", "stopped", "reachable", "error"]).toContain(
        capsJson.services?.devdeck,
      );

      const missingJobRes = await handler(
        new Request("http://localhost/api/devtools/jobs/bg:does-not-exist"),
      );
      expect(missingJobRes.status).toBe(404);
      const missingJobJson = (await missingJobRes.json()) as { readonly code?: string };
      expect(missingJobJson.code).toBe("not_found");
    } finally {
      await dispose();
      await registry.dispose();
    }
  });
});
