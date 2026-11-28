// @effect-diagnostics nodeBuiltinImport:off - `ship-queue hosts on` through the real host-guard rule: owner-only for a host turned off with a reason.
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { runHostGuardCli } from "@t3tools/host-guards/cli";
import { runHostsSubcommand } from "@t3tools/ship-queue/cliSubcommands";
import type { CiHostGuardRunner } from "@t3tools/ship-queue/hostsToggle";
import { ciToggleAuditPath } from "@t3tools/ship-queue/ciToggleAudit";
import { isHostOff, setCiHostAvailability } from "@t3tools/ship-queue/hostOffMarker";

import { GuardGrantBroker } from "../GuardGrantBroker.ts";
import { readCiToggleAudit } from "./CiToggleAudit.ts";

const OFF_AT = "2026-11-28T11:00:00.000Z";
const OFF_REASON = "runs a long simulation; keep CI off";
const tempDirs: string[] = [];
const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  for (const dir of tempDirs.splice(0)) NodeFS.rmSync(dir, { recursive: true, force: true });
});

function setup() {
  // Unix socket paths are short; keep the fixture under /tmp.
  const tmpRoot = NodeFS.existsSync("/tmp") ? "/tmp" : NodeOS.tmpdir();
  const dir = NodeFS.mkdtempSync(NodePath.join(tmpRoot, "sq-hosts-on-"));
  tempDirs.push(dir);
  const queueRoot = NodePath.join(dir, "sq");
  const manifestPath = NodePath.join(dir, "ci-hosts.json");
  NodeFS.writeFileSync(
    manifestPath,
    JSON.stringify({ schema: 1, hosts: [{ name: "host-b", ssh: "host-b" }] }),
  );
  const configPath = NodePath.join(dir, "host-guards.json");
  NodeFS.writeFileSync(
    configPath,
    JSON.stringify({
      orgs: ["example-org"],
      sourceRoot: NodePath.join(dir, "src"),
      dataRoot: NodePath.join(dir, "data"),
      stateDir: NodePath.join(dir, "state"),
      queueRoot,
    }),
  );
  return { dir, queueRoot, manifestPath, configPath };
}

function turnOff(queueRoot: string, manifestPath: string, reason: string): void {
  const res = setCiHostAvailability({
    queueRoot,
    hostName: "host-b",
    enabled: false,
    reason,
    actor: "owner",
    manifestPath,
    nowIso: () => OFF_AT,
  });
  expect(res.ok).toBe(true);
}

/** A grant broker that approves every owner request, as the owner's approval window does. */
async function approvingBroker(socketPath: string): Promise<Array<Record<string, unknown>>> {
  const received: Array<Record<string, unknown>> = [];
  const server = NodeNet.createServer((socket) => {
    let buf = "";
    socket.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      const req = JSON.parse(buf.slice(0, nl)) as Record<string, unknown>;
      received.push(req);
      const reply =
        req.op === "request"
          ? {
              ok: true,
              grant_id: "grant-1",
              reason: "owner approved in the window",
              approved_by: "human",
              approved_via: "t3-modal",
              thread_id: "thread-1",
            }
          : { ok: false, error: "no grant" };
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
  closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return received;
}

/** The real `marscode-host-guard ci-host-on-check`, in process, with the test's config and socket. */
function realGuard(configPath: string, socketPath: string): CiHostGuardRunner {
  return async (input) => {
    const errs: string[] = [];
    const exitCode = await runHostGuardCli(
      ["ci-host-on-check", "--queue-root", input.queueRoot, "--cwd", input.cwd, "--", input.host],
      {
        cwd: input.cwd,
        env: { ...input.env },
        out: () => {},
        err: (text) => errs.push(text),
        configPath,
        socketPath,
        allowTestOverride: true,
        allowEnvThreadId: true,
      },
    );
    return { exitCode, stderr: errs.join("\n") };
  };
}

async function hostsOn(
  ctx: ReturnType<typeof setup>,
  env: Record<string, string>,
  guard: CiHostGuardRunner,
  host = "host-b",
) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runHostsSubcommand(
    ctx.queueRoot,
    ["on", host],
    {
      stdout: (t) => out.push(t),
      stderr: (t) => err.push(t),
      env: { SHIP_QUEUE_CI_HOSTS: ctx.manifestPath, ...env },
      cwd: ctx.dir,
    },
    undefined,
    guard,
  );
  return { code, out: out.join(""), err: err.join("") };
}

// An agent session: a thread id in the environment and no owner at a terminal.
const AGENT_ENV = { T3CODE_THREAD_ID: "thread-1" };

describe("ship-queue hosts on for a host turned off with a reason", () => {
  it("refuses an agent's hosts on, naming the reason, who set it and when", async () => {
    const ctx = setup();
    turnOff(ctx.queueRoot, ctx.manifestPath, OFF_REASON);
    // No broker is reachable here, so neither request can reach the owner.
    for (const env of [
      AGENT_ENV,
      { ...AGENT_ENV, HOST_GUARD_OVERRIDE: "agent wants CI back on" },
    ]) {
      const res = await hostsOn(ctx, env, realGuard(ctx.configPath, ""));
      expect(res.code).not.toBe(0);
      expect(res.err).toContain(OFF_REASON);
      expect(res.err).toContain("owner");
      expect(res.err).toContain(OFF_AT);
      expect(isHostOff(ctx.queueRoot, "host-b")).toBe(true);
    }
    const audit = readCiToggleAudit(ctx.queueRoot);
    expect(audit.map((e) => [e.outcome, e.client, e.confirmed])).toEqual([
      ["refused", "ship-queue-cli", false],
      ["refused", "ship-queue-cli", false],
    ]);
    expect(audit[0]).toMatchObject({ host: "host-b", on: true, reason: OFF_REASON });
  });

  it("a reachable broker never lets an agent's own HOST_GUARD_OVERRIDE turn the host on", async () => {
    const ctx = setup();
    turnOff(ctx.queueRoot, ctx.manifestPath, OFF_REASON);
    const socketPath = NodePath.join(ctx.dir, "real-guard.sock");
    const pendingIds: string[] = [];
    let onPending: (() => void) | null = null;
    const broker = new GuardGrantBroker({
      socketPath,
      signingStateDir: ctx.dir,
      resolvePeerThreadId: async () => ({ verified: true, threadId: "thread-1", peerPid: 4300 }),
    });
    broker.subscribe((ev) => {
      if (ev.type !== "pending_added") return;
      pendingIds.push(ev.request.requestId);
      onPending?.();
    });
    await broker.start("linux");
    closers.push(async () => broker.close());
    const pending = new Promise<void>((resolve) => {
      onPending = resolve;
    });

    const run = hostsOn(
      ctx,
      { ...AGENT_ENV, HOST_GUARD_OVERRIDE: "agent wants CI back on now" },
      realGuard(ctx.configPath, socketPath),
    );
    // The agent's override only asks the owner; while the owner has not answered, CI stays off.
    await pending;
    expect(isHostOff(ctx.queueRoot, "host-b")).toBe(true);
    expect(broker.listPending().map((r) => r.guard)).toEqual(["ci-host-on"]);
    broker.resolveRequest(pendingIds[0]!, { decision: "deny", reason: "keep it off" });

    const res = await run;
    expect(res.code).not.toBe(0);
    expect(res.err).toContain(OFF_REASON);
    expect(isHostOff(ctx.queueRoot, "host-b")).toBe(true);
    const audit = readCiToggleAudit(ctx.queueRoot);
    expect(audit.map((e) => e.outcome)).toEqual(["refused"]);
    expect(audit.some((e) => e.outcome === "requested" || e.outcome === "applied")).toBe(false);
  });

  it("turns the host on after the owner approves the override, and audits it", async () => {
    const ctx = setup();
    turnOff(ctx.queueRoot, ctx.manifestPath, OFF_REASON);
    const socketPath = NodePath.join(ctx.dir, "guard.sock");
    const received = await approvingBroker(socketPath);

    const res = await hostsOn(
      ctx,
      { ...AGENT_ENV, HOST_GUARD_OVERRIDE: "owner asked to resume CI on this host" },
      realGuard(ctx.configPath, socketPath),
    );
    expect(res.code).toBe(0);
    expect(res.out).toContain("CI enabled on host-b");
    expect(isHostOff(ctx.queueRoot, "host-b")).toBe(false);
    expect(received.some((r) => r.op === "request" && r.guard === "ci-host-on")).toBe(true);
    expect(NodeFS.existsSync(NodePath.join(ctx.dir, "state", "overrides.log"))).toBe(true);

    const audit = readCiToggleAudit(ctx.queueRoot);
    expect(audit.map((e) => [e.outcome, e.confirmed])).toEqual([
      ["requested", true],
      ["applied", true],
    ]);
    expect(audit[1]).toMatchObject({
      host: "host-b",
      on: true,
      client: "ship-queue-cli",
      reason: OFF_REASON,
      prior: { by: "owner", at: OFF_AT, reason: OFF_REASON },
    });
  });

  it("turns a host with a no-reason marker on directly, without the guard", async () => {
    const ctx = setup();
    turnOff(ctx.queueRoot, ctx.manifestPath, "");
    let guardCalls = 0;
    const res = await hostsOn(ctx, AGENT_ENV, async () => {
      guardCalls += 1;
      return { exitCode: 2, stderr: "" };
    });
    expect(res.code).toBe(0);
    expect(guardCalls).toBe(0);
    expect(isHostOff(ctx.queueRoot, "host-b")).toBe(false);
    // Recorded before the marker is removed, then the outcome.
    expect(readCiToggleAudit(ctx.queueRoot).map((e) => e.outcome)).toEqual([
      "requested",
      "applied",
    ]);
  });

  it("trims the host name once and uses that same name for the read, the guard and the change", async () => {
    const ctx = setup();
    turnOff(ctx.queueRoot, ctx.manifestPath, OFF_REASON);
    const guardHosts: string[] = [];
    const refusing: CiHostGuardRunner = async (input) => {
      guardHosts.push(input.host);
      return realGuard(ctx.configPath, "")(input);
    };
    const res = await hostsOn(ctx, AGENT_ENV, refusing, " host-b ");
    expect(res.code).not.toBe(0);
    expect(guardHosts).toEqual(["host-b"]);
    expect(isHostOff(ctx.queueRoot, "host-b")).toBe(true);

    let calls = 0;
    const bad = await hostsOn(
      ctx,
      AGENT_ENV,
      async () => {
        calls += 1;
        return { exitCode: 0, stderr: "" };
      },
      "host-b/../host-b",
    );
    expect(bad.code).toBe(64);
    expect(calls).toBe(0);
    expect(isHostOff(ctx.queueRoot, "host-b")).toBe(true);
  });

  it("changes nothing and exits non-zero when the audit cannot be written before a turn-on", async () => {
    const ctx = setup();
    turnOff(ctx.queueRoot, ctx.manifestPath, "");
    // A directory where the audit file goes makes every append fail.
    NodeFS.mkdirSync(ciToggleAuditPath(ctx.queueRoot), { recursive: true });
    const res = await hostsOn(ctx, AGENT_ENV, async () => ({ exitCode: 0, stderr: "" }));
    expect(res.code).not.toBe(0);
    expect(res.err).toContain("audit cannot be written");
    expect(isHostOff(ctx.queueRoot, "host-b")).toBe(true);
  });
});
