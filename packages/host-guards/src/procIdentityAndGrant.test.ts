// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Real AppImage/proc identity, daemon spoof, and Unix-socket broker roundtrip tests using fixed epoch Date.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { loadHostConfig, type HostGuardsConfig } from "./hostConfig.ts";
import {
  createOverrideState,
  overrideHint,
  ownerAllowed,
  parseOverrideReason,
  recordRefusal,
  requestOverrideGrant,
} from "./override.ts";
import { REFUSALS_FILE } from "./overrideLog.ts";
import { isTrustedShipQueueSubmit } from "./shipQueueSubmitTrust.ts";
import type { ProcFsReader, ProcStatMeta } from "./procFs.ts";
import { resolveCallerIdentity } from "./procIdentity.ts";
import {
  isQueueDaemonInAncestry,
  isTrustedShipQueueProcess,
  isTrustedT3ServerProcess,
  resolveT3ServerPid,
  resolveT3ThreadId,
} from "./t3ServerTrust.ts";

const PKG_ROOT = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");

const FIXED_CLOCK = () => new Date("2026-11-27T12:00:00.000Z");

interface FakeProcEntry {
  readonly ppid: number;
  readonly comm: string;
  readonly exe: string;
  readonly argv: ReadonlyArray<string>;
  readonly env?: Readonly<Record<string, string>>;
  readonly cgroup?: string;
  readonly ttyNr?: number;
  readonly uid?: number;
  readonly starttime?: string;
  readonly exeStat?: { readonly dev: number; readonly ino: number };
  readonly fds?: Readonly<Record<string, string>>;
  readonly cwd?: string;
}

function makeFakeProcFs(options: {
  readonly selfPid: number;
  readonly uid?: number;
  readonly canonicalHome?: string;
  readonly mounts?: string;
  readonly unixTable?: string;
  readonly files?: Readonly<Record<string, string>>;
  readonly dirs?: Readonly<Record<string, ReadonlyArray<string>>>;
  readonly realpaths?: Readonly<Record<string, string>>;
  readonly fileStats?: Readonly<Record<string, ProcStatMeta>>;
  readonly procs: Readonly<Record<number, FakeProcEntry>>;
}): ProcFsReader {
  const uid = options.uid ?? 1000;
  const resolvePid = (pidStr: string): number | null => {
    if (pidStr === "self") return options.selfPid;
    const n = Number.parseInt(pidStr, 10);
    return Number.isInteger(n) ? n : null;
  };
  const files = options.files ?? {};
  const dirs = options.dirs ?? {};
  const realpaths = options.realpaths ?? {};
  const fileStats = options.fileStats ?? {};

  return {
    hasProc: () => true,
    selfPid: () => options.selfPid,
    currentUid: () => uid,
    readText: (filePath) => {
      if (filePath === "/proc/self/mounts") return options.mounts ?? "";
      if (filePath === "/proc/net/unix") return options.unixTable ?? "";
      if (filePath in files) return files[filePath]!;
      const m = /^\/proc\/([^/]+)\/(stat|cmdline|environ|cgroup)$/.exec(filePath);
      if (!m) return null;
      const pid = resolvePid(m[1]!);
      if (pid === null) return null;
      const entry = options.procs[pid];
      if (!entry) return null;
      if (m[2] === "stat") {
        // Fields after (comm): state ppid pgrp session tty_nr ... (20 fields up to starttime)
        const tty = entry.ttyNr ?? 0;
        const st = entry.starttime ?? "12345";
        return `${pid} (${entry.comm}) S ${entry.ppid} 1 1 ${tty} 0 0 0 0 0 0 0 0 0 0 0 0 0 0 ${st}`;
      }
      if (m[2] === "cmdline") {
        return entry.argv.length > 0 ? `${entry.argv.join("\0")}\0` : "";
      }
      if (m[2] === "environ") {
        const kv = Object.entries(entry.env ?? {}).map(([k, v]) => `${k}=${v}`);
        return kv.length > 0 ? `${kv.join("\0")}\0` : "";
      }
      if (m[2] === "cgroup") {
        return entry.cgroup ?? "0::/user.slice/user-1000.slice/session-2.scope\n";
      }
      return null;
    },
    readLink: (linkPath) => {
      const exeMatch = /^\/proc\/([^/]+)\/exe$/.exec(linkPath);
      if (exeMatch) {
        const pid = resolvePid(exeMatch[1]!);
        return pid !== null ? (options.procs[pid]?.exe ?? null) : null;
      }
      const cwdMatch = /^\/proc\/([^/]+)\/cwd$/.exec(linkPath);
      if (cwdMatch) {
        const pid = resolvePid(cwdMatch[1]!);
        return pid !== null ? (options.procs[pid]?.cwd ?? null) : null;
      }
      const fdMatch = /^\/proc\/([^/]+)\/fd\/([^/]+)$/.exec(linkPath);
      if (fdMatch) {
        const pid = resolvePid(fdMatch[1]!);
        return pid !== null ? (options.procs[pid]?.fds?.[fdMatch[2]!] ?? null) : null;
      }
      return null;
    },
    readDir: (dirPath) => {
      if (dirPath in dirs) return dirs[dirPath]!;
      const fdDir = /^\/proc\/([^/]+)\/fd$/.exec(dirPath);
      if (fdDir) {
        const pid = resolvePid(fdDir[1]!);
        const fds = pid !== null ? options.procs[pid]?.fds : undefined;
        return fds ? Object.keys(fds) : [];
      }
      return null;
    },
    stat: (filePath) => {
      if (filePath in fileStats) return fileStats[filePath]!;
      const procMatch = /^\/proc\/([^/]+)$/.exec(filePath);
      if (procMatch) {
        const pid = resolvePid(procMatch[1]!);
        const entry = pid !== null ? options.procs[pid] : undefined;
        if (!entry) return null;
        return { dev: 1, ino: pid!, uid: entry.uid ?? uid, mode: 0o040555, isFile: false };
      }
      const exeMatch = /^\/proc\/([^/]+)\/exe$/.exec(filePath);
      if (exeMatch) {
        const pid = resolvePid(exeMatch[1]!);
        const entry = pid !== null ? options.procs[pid] : undefined;
        if (!entry) return null;
        const meta = entry.exeStat ?? { dev: 2, ino: 100 + pid! };
        return { dev: meta.dev, ino: meta.ino, uid: 0, mode: 0o100755, isFile: true };
      }
      return null;
    },
    lstat: (filePath) => fileStats[filePath] ?? null,
    realpath: (p) => realpaths[p] ?? p,
    canonicalHome: () => options.canonicalHome ?? "/home/testuser",
  };
}

function makeTempConfig(dir: string): HostGuardsConfig {
  const cfgPath = NodePath.join(dir, "host-guards.json");
  NodeFS.writeFileSync(
    cfgPath,
    JSON.stringify({
      orgs: ["example-org"],
      sourceRoot: NodePath.join(dir, "src"),
      dataRoot: NodePath.join(dir, "data"),
      stateDir: NodePath.join(dir, "state"),
      queueRoot: NodePath.join(dir, "queue"),
    }),
    "utf8",
  );
  return loadHostConfig({ configPath: cfgPath });
}

async function startMockBroker(
  socketPath: string,
  handler: (req: Record<string, unknown>) => Record<string, unknown>,
): Promise<{
  readonly close: () => Promise<void>;
  readonly received: Array<Record<string, unknown>>;
}> {
  const received: Array<Record<string, unknown>> = [];
  const server = NodeNet.createServer((socket) => {
    let buf = "";
    socket.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      const req = JSON.parse(line) as Record<string, unknown>;
      received.push(req);
      const reply = handler(req);
      socket.end(`${JSON.stringify(reply)}\n`);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      NodeFS.chmodSync(socketPath, 0o600);
      resolve();
    });
  });

  return {
    received,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          try {
            NodeFS.unlinkSync(socketPath);
          } catch {
            // already removed
          }
          resolve();
        });
      }),
  };
}

describe("procIdentity and MarsCode AppImage server verification", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("verifies MarsCode-main.AppImage mounted at /tmp/.mount_MarsCo* with RO mount and socket ownership", () => {
    const mountDir = "/tmp/.mount_MarsCo9xAb12";
    const sockPath = "/run/user/1000/t3-guard-grant.sock";
    const procFs = makeFakeProcFs({
      selfPid: 500,
      mounts: `MarsCode-main.AppImage ${mountDir} fuse.MarsCode-main.AppImage ro,nosuid,nodev 0 0\n`,
      unixTable: `Num RefCount Protocol Flags Type St Inode Path\n0000: 00000002 00000000 00010000 0001 01 778899 ${sockPath}\n`,
      files: {
        "/home/testuser/.t3/userdata/server-runtime.json": JSON.stringify({ pid: 200 }),
      },
      fileStats: {
        "/home/testuser/.t3/userdata/server-runtime.json": {
          dev: 1,
          ino: 42,
          uid: 1000,
          mode: 0o100600,
          isFile: true,
        },
      },
      procs: {
        200: {
          ppid: 1,
          comm: "marscode",
          exe: `${mountDir}/marscode`,
          argv: [
            `${mountDir}/marscode`,
            `${mountDir}/resources/app.asar.unpacked/apps/server/dist/bin.mjs`,
          ],
          exeStat: { dev: 99, ino: 555 },
          fds: { "12": "socket:[778899]" },
        },
        300: {
          ppid: 200,
          comm: "marscode",
          exe: `${mountDir}/marscode`,
          argv: [`${mountDir}/marscode`, "process-launcher.mjs"],
          // Untagged helper sharing server binary (dev, ino)
          exeStat: { dev: 99, ino: 555 },
        },
        400: {
          ppid: 300,
          comm: "bash",
          exe: "/usr/bin/bash",
          argv: ["/usr/bin/bash"],
          env: { T3CODE_THREAD_ID: "thread-marscode-48" },
        },
        500: {
          ppid: 400,
          comm: "node",
          exe: "/usr/bin/node",
          argv: ["node", "marscode-host-guard"],
        },
      },
    });

    expect(isTrustedT3ServerProcess(200, { procFs, socketPath: sockPath })).toBe(true);
    expect(resolveT3ServerPid({ procFs, socketPath: sockPath })).toBe(200);
    expect(resolveT3ThreadId({}, { procFs, socketPath: sockPath })).toBe("thread-marscode-48");
  });

  it("rejects writable /tmp/.mount_* or untrusted /tmp server binaries and agent cgroups", () => {
    const rwMount = "/tmp/.mount_MarsCoRW";
    const procFs = makeFakeProcFs({
      selfPid: 500,
      mounts: `fake ${rwMount} fuse.fake rw,nosuid 0 0\n`,
      procs: {
        201: {
          ppid: 1,
          comm: "marscode",
          exe: `${rwMount}/marscode`,
          argv: [`${rwMount}/marscode`, "/apps/server/dist/bin.mjs"],
        },
        202: {
          ppid: 1,
          comm: "t3code",
          exe: "/tmp/t3code",
          argv: ["/tmp/t3code", "/apps/server/dist/bin.mjs"],
        },
        203: {
          ppid: 1,
          comm: "node",
          exe: "/usr/bin/node",
          argv: ["/usr/bin/node", "/opt/marscode/apps/server/dist/bin.mjs"],
          cgroup: "0::/user.slice/app-t3code-agents-deadbeef.slice/t3code-claude-1234.scope\n",
        },
      },
    });

    expect(isTrustedT3ServerProcess(201, { procFs })).toBe(false);
    expect(isTrustedT3ServerProcess(202, { procFs })).toBe(false);
    expect(isTrustedT3ServerProcess(203, { procFs })).toBe(false);
  });

  it("supports codex app-server hop when resolving t3ThreadId and rejects untagged unrelated binaries", () => {
    const procFs = makeFakeProcFs({
      selfPid: 600,
      files: {
        "/home/testuser/.t3/userdata/server-runtime.json": JSON.stringify({ pid: 100 }),
      },
      fileStats: {
        "/home/testuser/.t3/userdata/server-runtime.json": {
          dev: 1,
          ino: 77,
          uid: 1000,
          mode: 0o100600,
          isFile: true,
        },
      },
      procs: {
        100: {
          ppid: 1,
          comm: "node",
          exe: "/usr/bin/node",
          argv: ["/usr/bin/node", "/opt/marscode/apps/server/dist/bin.mjs"],
          exeStat: { dev: 10, ino: 20 },
        },
        200: {
          ppid: 100,
          comm: "codex",
          exe: "/usr/local/bin/codex",
          argv: ["/usr/local/bin/codex", "app-server"],
          cgroup: "0::/user.slice/app-t3code-agents-abc123.slice/t3code-codex-1.scope\n",
        },
        600: {
          ppid: 200,
          comm: "bash",
          exe: "/usr/bin/bash",
          argv: ["bash", "-c", "git push"],
          env: { T3CODE_THREAD_ID: "thread-codex-99" },
        },
      },
    });

    expect(resolveT3ThreadId({}, { procFs })).toBe("thread-codex-99");
  });

  it("handles real Unix grant socket roundtrips: blocking approve, blocking deny, non-blocking enqueue, and ownerAllowed", async () => {
    const tmpRoot = NodeFS.existsSync("/tmp") ? "/tmp" : NodeOS.tmpdir();
    const dir = NodeFS.mkdtempSync(NodePath.join(tmpRoot, "hg-grant-"));
    tempDirs.push(dir);
    const config = makeTempConfig(dir);
    const sockPath = NodePath.join(dir, "guard.sock");
    let mode: "approve" | "deny" | "enqueue" | "preapproved" = "approve";

    const broker = await startMockBroker(sockPath, (req) => {
      if (req.op === "use") {
        if (mode === "preapproved") {
          return {
            ok: true,
            grant_id: "grant-pre-1",
            reason: "preapproved reason text",
            approved_by: "human",
            approved_via: "t3-modal",
            thread_id: "thread-1",
          };
        }
        return { ok: false, error: "no grant" };
      }
      if (req.op === "request") {
        if (req.wait === false && mode === "enqueue") {
          return { ok: true, queued: true };
        }
        if (mode === "deny") {
          return { ok: false, denied: true, error: "owner clicked deny" };
        }
        return {
          ok: true,
          grant_id: "grant-modal-42",
          reason: "owner approved via modal",
          approved_by: "human",
          approved_via: "t3-modal",
          thread_id: "thread-1",
        };
      }
      return { ok: false };
    });

    try {
      const env: NodeJS.ProcessEnv = {
        T3CODE_THREAD_ID: "thread-1",
        HOST_GUARD_OVERRIDE: "approved emergency hotfix rollout",
      };
      const errs: string[] = [];
      const runtime = {
        config,
        env,
        socketPath: sockPath,
        allowTestOverride: true,
        allowEnvThreadId: true,
        now: FIXED_CLOCK,
        writeErr: (line: string) => errs.push(line),
      };

      expect(parseOverrideReason({ HOST_GUARD_OVERRIDE: "1" })).toBeNull();
      expect(parseOverrideReason(env)).toBe("approved emergency hotfix rollout");

      // 1. Blocking request -> approved
      mode = "approve";
      const state = createOverrideState();
      const granted = await requestOverrideGrant(
        {
          guard: "git",
          command: ["git", "push", "origin", "main"],
          cwd: dir,
          refusal: "refusing push to main",
          allowBlocking: true,
        },
        runtime,
        state,
      );
      expect(granted).toBe(true);
      const logPath = NodePath.join(config.stateDir, "overrides.log");
      expect(NodeFS.existsSync(logPath)).toBe(true);
      expect(NodeFS.statSync(logPath).mode & 0o777).toBe(0o600);
      const logRec = JSON.parse(NodeFS.readFileSync(logPath, "utf8").trim()) as Record<
        string,
        unknown
      >;
      expect(logRec.via).toBe("t3-input-request");
      expect(logRec.grant_id).toBe("grant-modal-42");

      // 2. Non-blocking enqueue (PreToolUse hook mode: allowBlocking: false)
      mode = "enqueue";
      const enqueued = await requestOverrideGrant(
        {
          guard: "git",
          command: ["git", "push", "origin", "main"],
          cwd: dir,
          refusal: "refusing push to main",
          allowBlocking: false,
        },
        runtime,
        state,
      );
      expect(enqueued).toBe(false);
      expect(broker.received.some((r) => r.op === "request" && r.wait === false)).toBe(true);

      // 3. Blocking request -> owner denied
      mode = "deny";
      const denied = await requestOverrideGrant(
        {
          guard: "git",
          command: ["git", "push", "origin", "main"],
          cwd: dir,
          refusal: "refusing push to main",
          allowBlocking: true,
        },
        runtime,
        state,
      );
      expect(denied).toBe(false);
      expect(state.lastDeniedInProc).toBe(true);
      expect(overrideHint(dir, runtime, state)).toContain("denied by the owner");

      recordRefusal(
        { guard: "git", command: ["git", "push"], cwd: dir, refusal: "refusing push" },
        runtime,
        state,
      );
      const refusalsPath = NodePath.join(config.stateDir, REFUSALS_FILE);
      const refRec = JSON.parse(NodeFS.readFileSync(refusalsPath, "utf8").trim()) as Record<
        string,
        unknown
      >;
      expect(refRec.denied_by_owner).toBe(true);

      // 4. ownerAllowed over Unix socket
      mode = "approve";
      const ownerOk = await ownerAllowed("approve-deps", dir, runtime, {
        command: ["ship-queue", "deps", "decide"],
        state,
      });
      expect(ownerOk).toBe(true);

      // 5. Secrets are redacted across ALL guards before broker modal, overrides.log, and refusals.jsonl
      mode = "approve";
      const flySecretCmd = [
        "fly",
        "secrets",
        "set",
        "DB_PASSWORD=supersecret",
        "-a",
        "example-api",
      ];
      const dopplerSecretCmd = [
        "doppler",
        "secrets",
        "set",
        "API_KEY",
        "supersecret",
        "-p",
        "example-api",
      ];
      expect(
        await requestOverrideGrant(
          {
            guard: "fly-deploy",
            command: flySecretCmd,
            cwd: dir,
            refusal: "refusing direct fly secrets set",
            allowBlocking: true,
          },
          runtime,
          state,
        ),
      ).toBe(true);
      recordRefusal(
        {
          guard: "cloud-cli",
          command: dopplerSecretCmd,
          cwd: dir,
          refusal: "refusing direct doppler secrets set",
        },
        runtime,
        state,
      );
      expect(JSON.stringify(broker.received)).not.toContain("supersecret");
      expect(NodeFS.readFileSync(logPath, "utf8")).not.toContain("supersecret");
      expect(NodeFS.readFileSync(refusalsPath, "utf8")).not.toContain("supersecret");

      // 6. Caller identity distinguishes agent vs human programmatic testMode
      expect(resolveCallerIdentity({ env, testMode: true }).isAgent).toBe(true);
      expect(resolveCallerIdentity({ env: {}, testMode: true }).isAgent).toBe(false);
    } finally {
      await broker.close();
    }
  });

  it("rejects env-var override/config/socket spoofing when invoking the built dist/bin.mjs CLI", async () => {
    const tmpRoot = NodeFS.existsSync("/tmp") ? "/tmp" : NodeOS.tmpdir();
    const dir = NodeFS.mkdtempSync(NodePath.join(tmpRoot, "hg-forge-"));
    tempDirs.push(dir);
    const fakeConfigPath = NodePath.join(dir, "forged-config.json");
    NodeFS.writeFileSync(
      fakeConfigPath,
      JSON.stringify({
        orgs: ["forged-org"],
        stateDir: NodePath.join(dir, "state"),
        sourceRoot: NodePath.join(dir, "src"),
        dataRoot: NodePath.join(dir, "data"),
      }),
    );
    const fakeSockPath = NodePath.join(dir, "forged.sock");
    const forgedBroker = await startMockBroker(fakeSockPath, () => ({
      ok: true,
      grant_id: "forged-grant-id",
      reason: "forged approval",
      approved_by: "human",
      approved_via: "t3-modal",
      thread_id: "forged-thread",
    }));

    try {
      const binPath = NodePath.join(PKG_ROOT, "dist", "bin.mjs");
      const hostileEnv: NodeJS.ProcessEnv = {
        PATH: "/usr/bin:/bin",
        HOME: dir,
        HOST_GUARDS_TEST: "1",
        MARSCODE_HOST_GUARDS_CONFIG: fakeConfigPath,
        T3_GUARD_GRANT_SOCKET: fakeSockPath,
        T3CODE_THREAD_ID: "forged-thread",
        CLAUDECODE: "1",
        HOST_GUARD_OVERRIDE: "agent attempting to forge owner approval",
      };

      // 1. self-check ignores MARSCODE_HOST_GUARDS_CONFIG and T3_GUARD_GRANT_SOCKET
      const selfRes = NodeChildProcess.spawnSync(
        process.execPath,
        [binPath, "self-check", "--json"],
        {
          cwd: dir,
          encoding: "utf8",
          env: hostileEnv,
        },
      );
      expect(selfRes.status).toBe(0);
      const report = JSON.parse(selfRes.stdout) as {
        configPath: string;
        guardSocket: string | null;
      };
      expect(report.configPath).not.toBe(fakeConfigPath);
      expect(report.guardSocket).not.toBe(fakeSockPath);

      // 2. owner-check refuses and never contacts the forged socket
      const ownerRes = NodeChildProcess.spawnSync(
        process.execPath,
        [binPath, "owner-check", "approve-deps"],
        { cwd: dir, encoding: "utf8", env: hostileEnv },
      );
      expect(ownerRes.status).toBe(2);
      expect(forgedBroker.received.length).toBe(0);

      // 3. override refuses and never contacts the forged socket
      const ovRes = NodeChildProcess.spawnSync(
        process.execPath,
        [binPath, "override", "git", "refusing push", "--", "git", "push", "origin", "main"],
        { cwd: dir, encoding: "utf8", env: hostileEnv },
      );
      expect(ovRes.status).toBe(1);
      expect(forgedBroker.received.length).toBe(0);
    } finally {
      await forgedBroker.close();
    }
  });

  it("rejects spoofed /tmp, agent-cgroup, transient-service, NODE_OPTIONS, or unrecorded ship-queue workers while trusting lock-recorded installed worker", () => {
    const queueRoot = "/home/testuser/Dev-data/.ship-queue";
    const marscodeQueueRoot = "/home/testuser/.local/share/ship-queue";
    const activeReleaseDir = "/home/testuser/.local/lib/marscode-tools/.releases/ship-queue.3sXIpq";
    const activeBin = `${activeReleaseDir}/dist/bin.mjs`;
    const spoofedProcFs = makeFakeProcFs({
      selfPid: 900,
      files: {
        [`${queueRoot}/daemon.pid`]: "700\n",
        [`${marscodeQueueRoot}/workers/v1.json`]: JSON.stringify({
          pid: 704,
          startTicks: "77777",
          token: "tok",
        }),
        [`${marscodeQueueRoot}/workers/stale.json`]: JSON.stringify({
          pid: 710,
          startTicks: "99999",
          token: "tok2",
        }),
      },
      dirs: {
        [`${marscodeQueueRoot}/workers`]: ["v1.json", "stale.json"],
      },
      realpaths: {
        "/home/testuser/.local/lib/marscode-tools/ship-queue": activeReleaseDir,
      },
      procs: {
        700: {
          ppid: 1,
          comm: "node",
          exe: "/usr/bin/node",
          argv: ["node", "/tmp/ship-queue-x.js", "daemon"],
        },
        701: {
          ppid: 1,
          comm: "node",
          exe: "/usr/bin/node",
          argv: ["node", "/home/testuser/.local/lib/marscode/ship-queue/bin.mjs", "work"],
          cgroup: "0::/user.slice/app-t3code-agents-deadbeef.slice/t3code-claude-1.scope\n",
        },
        702: {
          ppid: 1,
          comm: "node",
          exe: "/usr/bin/node",
          argv: ["node", "/home/testuser/.local/lib/marscode/ship-queue/bin.mjs", "work"],
          uid: 2000,
        },
        703: {
          ppid: 1,
          comm: "node",
          exe: "/usr/bin/node",
          argv: ["node", "/home/testuser/.local/lib/marscode/ship-queue/bin.mjs", "work"],
        },
        704: {
          ppid: 1,
          comm: "node",
          exe: "/usr/bin/node",
          argv: ["node", activeBin, "work"],
          starttime: "77777",
          cgroup: "0::/user.slice/user-1000.slice/user@1000.service/app.slice/run-r1234.scope\n",
        },
        705: {
          ppid: 1,
          comm: "node",
          exe: "/usr/bin/node",
          argv: [
            "node",
            "/home/testuser/.local/lib/marscode-tools/.releases/playbook.abc123/dist/bin.mjs",
            "work",
          ],
        },
        // Attack 1: systemd-run --user creates run-u*.service with ppid=1
        706: {
          ppid: 1,
          comm: "node",
          exe: "/usr/bin/node",
          argv: ["node", activeBin, "work"],
          cgroup: "0::/user.slice/user-1000.slice/user@1000.service/app.slice/run-u9999.service\n",
        },
        // Attack 2: NODE_OPTIONS, LD_AUDIT, or GIT_SSH_COMMAND injection on an otherwise valid worker
        707: {
          ppid: 1,
          comm: "node",
          exe: "/usr/bin/node",
          argv: ["node", activeBin, "work"],
          env: { NODE_OPTIONS: "--require=/tmp/evil.js" },
          cgroup: "0::/user.slice/user-1000.slice/user@1000.service/app.slice/run-r1235.scope\n",
        },
        712: {
          ppid: 1,
          comm: "node",
          exe: "/usr/bin/node",
          argv: ["node", activeBin, "work"],
          env: { LD_AUDIT: "/tmp/evil.so" },
          cgroup: "0::/user.slice/user-1000.slice/user@1000.service/app.slice/run-r1240.scope\n",
        },
        713: {
          ppid: 1,
          comm: "node",
          exe: "/usr/bin/node",
          argv: ["node", activeBin, "work"],
          env: { GIT_SSH_COMMAND: "/tmp/evil.sh #=" },
          cgroup: "0::/user.slice/user-1000.slice/user@1000.service/app.slice/run-r1241.scope\n",
        },
        714: {
          ppid: 1,
          comm: "node",
          exe: "/usr/bin/node",
          argv: ["node", activeBin, "work"],
          env: { NODE_OPTIONS: "--require=/tmp/evil.js --title=" },
          cgroup: "0::/user.slice/user-1000.slice/user@1000.service/app.slice/run-r1242.scope\n",
        },
        715: {
          ppid: 1,
          comm: "node",
          exe: "/usr/bin/node",
          argv: ["node", activeBin, "work"],
          env: { GIT_CONFIG_SYSTEM: "/tmp/evil.cfg" },
          cgroup: "0::/user.slice/user-1000.slice/user@1000.service/app.slice/run-r1243.scope\n",
        },
        716: {
          ppid: 1,
          comm: "node",
          exe: "/usr/bin/node",
          argv: ["node", activeBin, "work"],
          env: { SSH_ASKPASS: "/tmp/evil.sh" },
          cgroup: "0::/user.slice/user-1000.slice/user@1000.service/app.slice/run-r1244.scope\n",
        },
        // Attack 3: Extra trailing argument (`work x`)
        708: {
          ppid: 1,
          comm: "node",
          exe: "/usr/bin/node",
          argv: ["node", activeBin, "work", "x"],
          cgroup: "0::/user.slice/user-1000.slice/user@1000.service/app.slice/run-r1236.scope\n",
        },
        // Attack 4: Arbitrary unlinked `.releases/ship-queue.fake` directory (not current symlink)
        709: {
          ppid: 1,
          comm: "node",
          exe: "/usr/bin/node",
          argv: [
            "node",
            "/home/testuser/.local/lib/marscode-tools/.releases/ship-queue.fake/dist/bin.mjs",
            "work",
          ],
          cgroup: "0::/user.slice/user-1000.slice/user@1000.service/app.slice/run-r1237.scope\n",
        },
        // Attack 5: Lock file exists for PID 710, but kernel starttime mismatches (PID reuse)
        710: {
          ppid: 1,
          comm: "node",
          exe: "/usr/bin/node",
          argv: ["node", activeBin, "work"],
          starttime: "55555",
          cgroup: "0::/user.slice/user-1000.slice/user@1000.service/app.slice/run-r1238.scope\n",
        },
        // Attack 6: Valid-looking scope worker with NO lock file recorded
        711: {
          ppid: 1,
          comm: "node",
          exe: "/usr/bin/node",
          argv: ["node", activeBin, "work"],
          starttime: "88888",
          cgroup: "0::/user.slice/user-1000.slice/user@1000.service/app.slice/run-r1239.scope\n",
        },
        900: {
          ppid: 700,
          comm: "git",
          exe: "/usr/bin/git",
          argv: ["git", "push"],
        },
        901: {
          ppid: 704,
          comm: "git",
          exe: "/usr/bin/git",
          argv: ["git", "-c", "core.hooksPath=/dev/null", "rebase", "origin/main"],
        },
        902: {
          ppid: 706,
          comm: "git",
          exe: "/usr/bin/git",
          argv: ["git", "push"],
        },
        903: {
          ppid: 710,
          comm: "git",
          exe: "/usr/bin/git",
          argv: ["git", "push"],
        },
        904: {
          ppid: 711,
          comm: "git",
          exe: "/usr/bin/git",
          argv: ["git", "push"],
        },
      },
    });

    // Spoofed `/tmp/ship-queue-x.js daemon` written to daemon.pid is rejected!
    expect(isTrustedShipQueueProcess(700, queueRoot, spoofedProcFs)).toBe(false);
    expect(isQueueDaemonInAncestry(queueRoot, 900, spoofedProcFs)).toBe(false);

    // Agent-cgroup, foreign-UID, non-ship-queue tool, transient .service, NODE_OPTIONS, extra args, and unlinked release dir are rejected!
    expect(isTrustedShipQueueProcess(701, queueRoot, spoofedProcFs)).toBe(false);
    expect(isTrustedShipQueueProcess(702, queueRoot, spoofedProcFs)).toBe(false);
    expect(isTrustedShipQueueProcess(705, queueRoot, spoofedProcFs)).toBe(false);
    expect(isTrustedShipQueueProcess(706, queueRoot, spoofedProcFs)).toBe(false);
    expect(isTrustedShipQueueProcess(707, queueRoot, spoofedProcFs)).toBe(false);
    expect(isTrustedShipQueueProcess(712, queueRoot, spoofedProcFs)).toBe(false);
    expect(isTrustedShipQueueProcess(713, queueRoot, spoofedProcFs)).toBe(false);
    expect(isTrustedShipQueueProcess(714, queueRoot, spoofedProcFs)).toBe(false);
    expect(isTrustedShipQueueProcess(715, queueRoot, spoofedProcFs)).toBe(false);
    expect(isTrustedShipQueueProcess(716, queueRoot, spoofedProcFs)).toBe(false);
    expect(isTrustedShipQueueProcess(708, queueRoot, spoofedProcFs)).toBe(false);
    expect(isTrustedShipQueueProcess(709, queueRoot, spoofedProcFs)).toBe(false);

    // Transient .service, mismatched startTicks, and unrecorded scope worker NEVER satisfy ancestry trust!
    expect(isQueueDaemonInAncestry(queueRoot, 902, spoofedProcFs)).toBe(false);
    expect(isQueueDaemonInAncestry(queueRoot, 903, spoofedProcFs)).toBe(false);
    expect(isQueueDaemonInAncestry(queueRoot, 904, spoofedProcFs)).toBe(false);

    // Legitimate installed MarsCode ship-queue worker with matching lock `{ pid, startTicks }` is accepted!
    expect(isTrustedShipQueueProcess(703, queueRoot, spoofedProcFs)).toBe(true);
    expect(isTrustedShipQueueProcess(704, queueRoot, spoofedProcFs)).toBe(true);
    expect(isQueueDaemonInAncestry(queueRoot, 901, spoofedProcFs)).toBe(true);
  });

  it("accepts a job bind only from the installed ship-queue submit for that worktree and branch", () => {
    const bin = "/home/dev/.local/lib/marscode/bin.mjs";
    const submit = (over: Partial<FakeProcEntry> = {}): FakeProcEntry => ({
      ppid: 1,
      comm: "node",
      exe: "/usr/bin/node",
      argv: ["node", bin, "submit", "wt", "feat/74", "title", "body.md"],
      cwd: "/home/dev/src",
      ...over,
    });
    const procFs = makeFakeProcFs({
      selfPid: 1,
      canonicalHome: "/home/dev",
      procs: {
        800: submit(),
        801: submit({ argv: ["node", bin, "submit", "--no-start", "/home/dev/src/wt", "feat/74"] }),
        802: submit({ argv: ["node", bin, "submit", "wt", "feat/other"] }),
        803: submit({ argv: ["node", bin, "submit", "other-wt", "feat/74"] }),
        804: submit({ argv: ["node", "/home/dev/evil/bin.mjs", "submit", "wt", "feat/74"] }),
        805: submit({ argv: ["node", bin, "work"] }),
        806: submit({ env: { NODE_OPTIONS: "--require /tmp/x.js" } }),
        807: submit({ exe: "/tmp/node" }),
        808: submit({ uid: 1001 }),
        809: submit({
          exe: "/usr/bin/bash",
          argv: ["bash", "-c", `node ${bin} submit wt feat/74`],
        }),
      },
    });
    const input = {
      queueRoot: "/home/dev/.local/share/ship-queue",
      worktree: "/home/dev/src/wt",
      branch: "feat/74",
    };
    expect(isTrustedShipQueueSubmit(800, input, procFs)).toBe(true);
    expect(isTrustedShipQueueSubmit(801, input, procFs)).toBe(true);
    for (const pid of [802, 803, 804, 805, 806, 807, 808, 809, 999]) {
      expect(isTrustedShipQueueSubmit(pid, input, procFs), String(pid)).toBe(false);
    }
  });
});
