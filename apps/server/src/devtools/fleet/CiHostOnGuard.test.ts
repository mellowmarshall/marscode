// @effect-diagnostics nodeBuiltinImport:off - `ship-queue hosts on` through the real host-guard rule: owner-only for a host turned off with a reason.
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { runHostGuardCli } from "@t3tools/host-guards/cli";
import { runHostsSubcommand } from "@t3tools/ship-queue/cliSubcommands";
import type { CiHostGuardRunner } from "@t3tools/ship-queue/hostsToggle";
import { isHostOff, setCiHostAvailability } from "@t3tools/ship-queue/hostProbe";

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
) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runHostsSubcommand(
    ctx.queueRoot,
    ["on", "host-b"],
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
    // No approval window is reachable, and the agent cannot approve itself.
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
    expect(readCiToggleAudit(ctx.queueRoot).map((e) => e.outcome)).toEqual(["applied"]);
  });
});
