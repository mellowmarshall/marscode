// @effect-diagnostics nodeBuiltinImport:off - Real unit tests for native fleet alerts (port collisions, GitHub audit report).
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "@effect/vitest";

import { parseDockerPsLines, parseSsListeners } from "./DockerPsParser.ts";
import {
  buildFleetAlertsPanel,
  detectPortCollisions,
  readGitHubAuditAlerts,
} from "./FleetAlerts.ts";
import { FleetCachedPanel } from "./FleetCachedPanel.ts";
import type { FleetServerItem, FleetWorktreesPanel } from "./FleetTypes.ts";
import { NativeFleetService } from "./NativeFleetService.ts";

const AUDIT_AT = "2026-11-27T10:00:00Z";
const AUDIT_AT_MS = Date.parse(AUDIT_AT);
const MINUTE_MS = 60_000;

const tempDirs: string[] = [];
function mkTempDir(prefix: string): string {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tempDirs.length > 0) NodeFS.rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function devServer(pid: number, port: number, service: string): FleetServerItem {
  return {
    id: `dev:${pid}:${port}`,
    service,
    kind: "dev",
    port,
    ports: [{ port, proto: "http" }],
    state: "up",
    pid,
  };
}

function writeAudit(dir: string, report: Record<string, unknown>): string {
  const path = NodePath.join(dir, "report.json");
  NodeFS.writeFileSync(path, JSON.stringify(report));
  return path;
}

const HEALTHY_AUDIT = {
  schema: 1,
  at: AUDIT_AT,
  state: "findings",
  scope: "mellowmarshall",
  pending: 0,
  errors: [],
  repos: [{ name: "marscode" }, { name: "devtools" }],
  installation: { state: "verified", detail: "gh shim matches" },
  issues: [
    { repo: "mellowmarshall/marscode", number: 11, state: "unverified", detail: "no PR" },
    { repo: "mellowmarshall/marscode", number: 12, state: "unverified", detail: "no PR" },
    { repo: "mellowmarshall/marscode", number: 9, state: "verified", detail: "PR #30" },
    { repo: "private-repo", number: 4, state: "unverified", stale: true, detail: "" },
    {
      repo: "private-repo",
      number: 5,
      state: "unverified",
      detail: "Evidence check pending",
    },
  ],
};

describe("detectPortCollisions", () => {
  it("fires when a host listener shares a port that a running container publishes", () => {
    // Real `docker ps` and `ss -Hltnp` line shapes, run through the scanner's own parsers.
    const docker = parseDockerPsLines(
      "abc123\tpg\trunning\tUp 2 hours\tpostgres:17\tshop\tdb\tFalse\t/srv/shop\t0.0.0.0:5432->5432/tcp, [::]:5432->5432/tcp\n",
      new Map(),
    );
    const listeners = parseSsListeners(
      'LISTEN 0 244 127.0.0.1:5432 0.0.0.0:* users:(("postgres",pid=4242,fd=7))\n',
    );
    const items = detectPortCollisions(docker, listeners);
    expect(items).toEqual([
      {
        source: "local",
        name: "port collision",
        state: "firing",
        detail: "port 5432 is published by container pg and also held by postgres (PID 4242)",
      },
    ]);
  });

  it("fires when two running servers bind one port, and ignores one owner on many addresses", () => {
    const servers: FleetServerItem[] = [
      devServer(100, 3000, "web (node)"),
      devServer(200, 3000, "docs (vite)"),
      devServer(300, 4000, "api (node)"),
      { ...devServer(300, 4000, "api (node)"), id: "dev:300:4000-v6" },
      { ...devServer(400, 4000, "old (node)"), state: "stopped" },
    ];
    const items = detectPortCollisions(servers, []);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      state: "firing",
      detail: "port 3000 is bound by web (node) (PID 100) and docs (vite) (PID 200)",
    });
  });

  it("reports one ok item when no port collides", () => {
    const items = detectPortCollisions([devServer(1, 3000, "a"), devServer(2, 3001, "b")], []);
    expect(items).toEqual([
      { source: "local", name: "port collisions", state: "ok", detail: "2 host ports checked" },
    ]);
  });
});

describe("readGitHubAuditAlerts", () => {
  it("tallies unverified closed issues per repository and marks coverage ok when fresh", () => {
    const path = writeAudit(mkTempDir("t3-audit-"), HEALTHY_AUDIT);
    const items = readGitHubAuditAlerts(path, AUDIT_AT_MS + 10 * MINUTE_MS);
    expect(items.map((i) => [i.name, i.state])).toEqual([
      ["Audit coverage", "ok"],
      ["Installed gh shim", "ok"],
      ["private-repo", "silent"],
      ["mellowmarshall/marscode", "firing"],
    ]);
    expect(items[3]?.detail).toBe("2 closed issues without landing evidence (e.g. #11)");
    expect(items[3]?.url).toContain("github.com/mellowmarshall/marscode/issues");
    expect(items[2]?.detail).toBe("1 closed issues not checked or check failed");
  });

  it("never reports ok for a stale, future-dated, missing, or invalid report", () => {
    const dir = mkTempDir("t3-audit-");
    const path = writeAudit(dir, { ...HEALTHY_AUDIT, installation: { state: "drift" } });
    const stale = readGitHubAuditAlerts(path, AUDIT_AT_MS + 3 * 60 * MINUTE_MS);
    expect(stale.every((i) => i.state !== "ok")).toBe(true);
    expect(stale.find((i) => i.name === "Installed gh shim")?.state).toBe("silent");
    expect(stale[0]?.detail).toMatch(/^Stale audit: /);

    const future = readGitHubAuditAlerts(path, AUDIT_AT_MS - 10 * MINUTE_MS);
    expect(future[0]?.state).toBe("silent");

    const fresh = readGitHubAuditAlerts(path, AUDIT_AT_MS);
    expect(fresh.find((i) => i.name === "Installed gh shim")?.state).toBe("firing");

    expect(readGitHubAuditAlerts(NodePath.join(dir, "missing.json"), AUDIT_AT_MS)).toEqual([
      {
        source: "GitHub audit",
        name: "Audit coverage",
        state: "silent",
        detail: "No readable audit report",
      },
    ]);
    const invalid = writeAudit(mkTempDir("t3-audit-"), { schema: 2 });
    expect(readGitHubAuditAlerts(invalid, AUDIT_AT_MS)[0]?.detail).toBe("Audit report is invalid");
  });

  it("keeps coverage silent while checks are pending or errors are present", () => {
    const path = writeAudit(mkTempDir("t3-audit-"), {
      ...HEALTHY_AUDIT,
      pending: 3,
      errors: ["rate limited"],
    });
    const [coverage] = readGitHubAuditAlerts(path, AUDIT_AT_MS);
    expect(coverage?.state).toBe("silent");
    expect(coverage?.detail).toBe("3 checks pending; 2 repositories; mellowmarshall; rate limited");
  });

  it("refuses a symlinked, FIFO, directory, or oversized report without blocking", () => {
    const dir = mkTempDir("t3-audit-hard-");
    const real = writeAudit(dir, HEALTHY_AUDIT);
    const detailOf = (path: string) => readGitHubAuditAlerts(path, AUDIT_AT_MS)[0]?.detail;

    // A healthy report read through a symlink is still refused (O_NOFOLLOW).
    const link = NodePath.join(dir, "link.json");
    NodeFS.symlinkSync(real, link);
    expect(detailOf(link)).toBe("Audit report is not a regular file");

    // A FIFO with no writer would block a plain read forever; O_NONBLOCK + fstat refuse it.
    const fifo = NodePath.join(dir, "fifo.json");
    let fifoMade = false;
    try {
      NodeChildProcess.execFileSync("mkfifo", [fifo], { stdio: "ignore" });
      fifoMade = true;
    } catch {
      // mkfifo unavailable (non-POSIX host)
    }
    if (fifoMade) expect(detailOf(fifo)).toBe("Audit report is not a regular file");

    expect(detailOf(dir)).toBe("Audit report is not a regular file");

    // Just over 2 MiB, valid JSON throughout, is refused before parsing.
    const big = NodePath.join(dir, "big.json");
    const filler = "x".repeat(2 * 1024 * 1024);
    NodeFS.writeFileSync(big, JSON.stringify({ ...HEALTHY_AUDIT, filler }));
    expect(detailOf(big)).toBe("Audit report is too large");

    // Exactly at the cap is still read.
    const atCap = NodePath.join(dir, "at-cap.json");
    const base = JSON.stringify({ ...HEALTHY_AUDIT, filler: "" });
    const pad = 2 * 1024 * 1024 - base.length;
    NodeFS.writeFileSync(atCap, JSON.stringify({ ...HEALTHY_AUDIT, filler: "y".repeat(pad) }));
    expect(NodeFS.statSync(atCap).size).toBe(2 * 1024 * 1024);
    expect(readGitHubAuditAlerts(atCap, AUDIT_AT_MS)[0]?.state).toBe("ok");

    const garbage = NodePath.join(dir, "garbage.json");
    NodeFS.writeFileSync(garbage, "{not json");
    expect(detailOf(garbage)).toBe("Audit report is invalid");
  });

  it("combines port and audit items into one panel", () => {
    const path = writeAudit(mkTempDir("t3-audit-"), HEALTHY_AUDIT);
    const panel = buildFleetAlertsPanel({
      servers: [devServer(1, 3000, "a"), devServer(2, 3000, "b")],
      portShadows: [],
      githubAuditPath: path,
      nowMs: AUDIT_AT_MS,
    });
    expect(panel.items[0]?.name).toBe("port collision");
    expect(panel.items.some((i) => i.source === "GitHub audit")).toBe(true);
  });
});

describe("FleetCachedPanel", () => {
  it("waits for the first load, then serves the held value and refreshes once past the TTL", async () => {
    let clock = 1_000;
    let loads = 0;
    const updates: number[] = [];
    const panel = new FleetCachedPanel<number | null>({
      load: async () => {
        loads += 1;
        return loads;
      },
      ttlMs: 100,
      initial: null,
      onUpdate: (value) => updates.push(value ?? -1),
      now: () => clock,
    });
    expect(await panel.read()).toBe(1);
    clock += 50;
    expect(await panel.read()).toBe(1);
    expect(loads).toBe(1);
    clock += 60;
    expect(await panel.read()).toBe(1);
    await expect.poll(() => updates).toEqual([1, 2]);
    expect(await panel.read()).toBe(2);
  });

  it("peek never waits: it serves the initial value and starts the first load", async () => {
    const panel = new FleetCachedPanel<string>({
      load: async () => "loaded",
      ttlMs: 1_000,
      initial: "pending",
      now: () => 0,
    });
    expect(panel.peek()).toBe("pending");
    await expect.poll(() => panel.peek()).toBe("loaded");
  });

  it("keeps the previous value when a refresh fails", async () => {
    let clock = 0;
    let fail = false;
    const panel = new FleetCachedPanel<string>({
      load: async () => {
        if (fail) throw new Error("git unavailable");
        return "first";
      },
      ttlMs: 10,
      initial: "none",
      now: () => clock,
    });
    expect(await panel.read()).toBe("first");
    fail = true;
    clock = 20;
    expect(await panel.read()).toBe("first");
    expect(await panel.read()).toBe("first");
  });
});

describe("NativeFleetService alerts + worktrees panels", () => {
  it("serves native alerts and the injected worktrees reader in /api/snapshot panels", async () => {
    const dir = mkTempDir("t3-fleet-panels-");
    const worktrees: FleetWorktreesPanel = {
      total: 1,
      dirty: 1,
      stale: 0,
      merged: 0,
      stuck: 0,
      repos: [
        {
          repo: "marscode",
          root: "/data/Dev/marscode/main",
          items: [
            {
              path: "/data/Dev/marscode/wt",
              branch: "feat/x",
              dirty: true,
              stale: false,
              last_commit_at: AUDIT_AT,
            },
          ],
        },
      ],
    };
    const fleet = new NativeFleetService({
      hostname: "fleet-panels-host",
      stateDir: dir,
      manifestPath: NodePath.join(dir, "missing-ci-hosts.json"),
      githubAuditPath: writeAudit(dir, HEALTHY_AUDIT),
      enableBackgroundPolling: false,
      readWorktrees: async () => worktrees,
    });
    try {
      const updates: unknown[] = [];
      const stream = fleet.createEventStream(
        new AbortController().signal,
        "/api/events?panels=worktrees",
      );
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      const pump = (async () => {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) return;
          updates.push(decoder.decode(chunk.value));
        }
      })();

      // The first snapshot does not wait for the Git pass; the event and later snapshots carry it.
      const snap = await fleet.getSnapshot(new Set(["alerts", "worktrees"]));
      expect(Object.keys(snap).toSorted()).toEqual(["alerts", "worktrees"]);
      await expect
        .poll(async () => (await fleet.getSnapshot(new Set(["worktrees"]))).worktrees)
        .toEqual(worktrees);
      await expect
        .poll(() => updates.some((u) => String(u).startsWith("event: worktrees\n")))
        .toBe(true);
      await reader.cancel();
      await pump;
      const alertNames = (snap.alerts as { items: ReadonlyArray<{ source: string }> }).items.map(
        (i) => i.source,
      );
      expect(alertNames).toContain("GitHub audit");

      // Without the worktrees panel requested, the reader is not consulted.
      const hostOnly = await fleet.getSnapshot(new Set(["hosts"]));
      expect("worktrees" in hostOnly).toBe(false);
    } finally {
      fleet.close();
    }
  });

  it("refreshes worktrees on the live scan loop once the TTL expires and streams the update", async () => {
    const dir = mkTempDir("t3-fleet-ttl-");
    let clock = 1_000_000;
    let loads = 0;
    const panelFor = (n: number): FleetWorktreesPanel => ({
      total: n,
      dirty: 0,
      stale: 0,
      merged: 0,
      stuck: 0,
      repos: [],
    });
    const fleet = new NativeFleetService({
      hostname: "fleet-ttl-host",
      stateDir: dir,
      manifestPath: NodePath.join(dir, "missing-ci-hosts.json"),
      githubAuditPath: NodePath.join(dir, "missing-audit.json"),
      enableBackgroundPolling: false,
      activeScansIntervalMs: 20,
      now: () => clock,
      readWorktrees: async () => {
        loads += 1;
        return panelFor(loads);
      },
    });
    const ctrl = new AbortController();
    const reader = fleet.createEventStream(ctrl.signal, "/api/events?panels=worktrees").getReader();
    const decoder = new TextDecoder();
    const totals: number[] = [];
    const pump = (async () => {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) return;
        for (const block of decoder.decode(chunk.value).split("\n\n")) {
          const match = /^event: worktrees\ndata: (.*)$/s.exec(block);
          if (match?.[1]) totals.push((JSON.parse(match[1]) as FleetWorktreesPanel).total);
        }
      }
    })();
    try {
      await expect.poll(() => totals, { timeout: 5_000 }).toEqual([1]);
      // Inside the TTL the loop keeps serving the held panel: no second load.
      clock += 30_000;
      await expect.poll(() => loads, { timeout: 500 }).toBe(1);
      // Past the 60 s TTL the next loop tick refreshes and the live stream gets the new panel.
      clock += 31_000;
      await expect.poll(() => totals, { timeout: 5_000 }).toEqual([1, 2]);
    } finally {
      ctrl.abort();
      await reader.cancel().catch(() => undefined);
      await pump.catch(() => undefined);
      fleet.close();
    }
  });
});
