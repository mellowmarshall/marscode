// @effect-diagnostics nodeBuiltinImport:off - Real unit and HTTP/SSE integration tests for native T3 fleet telemetry.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthAccessWriteScope,
  AuthDiagnosticsReadScope,
  AuthOrchestrationReadScope,
  AuthTerminalOperateScope,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { validateCiHostsManifest } from "@t3tools/ship-queue/ciHosts";
import { readInMemoryNodeLoads } from "@t3tools/ship-queue/ciRouter";
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { HttpRouter } from "effect/http";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import * as SessionStore from "../../auth/SessionStore.ts";
import * as DevtoolsHttp from "../DevtoolsHttp.ts";
import * as JobRegistry from "../jobs/JobRegistry.ts";
import { handleNativeFleetRequest } from "./FleetRoutes.ts";
import { NativeFleetService } from "./NativeFleetService.ts";
import {
  NativeHostSampler,
  parseGpuLines,
  parseNvidiaSmiCsv,
  parseProcMeminfo,
  parseProcStat,
} from "./NativeHostSampler.ts";
import {
  parseDockerPorts,
  parseDockerPsLines,
  parseSizeBytes,
  parseSsListeners,
} from "./DockerPsParser.ts";
import { NativeServersScanner } from "./NativeServersScanner.ts";
import {
  parseEtimeSeconds,
  parsePsOutput,
  NativeSessionsScanner,
} from "./NativeSessionsScanner.ts";
import { parseRemoteProbeOutput } from "./RemoteProbeParser.ts";
import { RemoteNodeProber, sanitizePeerNodeState } from "./RemoteNodeProber.ts";

const FIXED_EPOCH_MS = 1_764_054_000_000;
const cleanupDirs: string[] = [];

function mkTempDir(prefix: string): string {
  const dir = NodeFS.mkdtempSync(NodePath.join("/tmp", prefix));
  NodeFS.chmodSync(dir, 0o700);
  cleanupDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (cleanupDirs.length > 0) {
    NodeFS.rmSync(cleanupDirs.pop()!, { recursive: true, force: true });
  }
});

describe("NativeHostSampler parsers and sampling", () => {
  it("parses /proc/stat, /proc/meminfo, sysfs DRM, and nvidia-smi CSV accurately", () => {
    const stat = parseProcStat(
      [
        "cpu  1000 100 500 8000 400 0 0 0 0 0",
        "cpu0 500 50 250 4000 200 0 0 0 0 0",
        "cpu1 500 50 250 4000 200 0 0 0 0 0",
      ].join("\n"),
    );
    expect(stat).toEqual({ idle: 8400, total: 10000, cpus: 2 });

    const mem = parseProcMeminfo(
      [
        "MemTotal:       16384000 kB",
        "MemFree:         2000000 kB",
        "MemAvailable:    6384000 kB",
      ].join("\n"),
    );
    expect(mem).toEqual({ used: 10000000 * 1024, total: 16384000 * 1024 });

    const gpuMulti = parseGpuLines(["SYSFS 12 1000 4000", "NV 45 2048 10240"].join("\n"));
    expect(gpuMulti).toEqual({
      busy_pct: 45,
      vram_used: 2048 * 1024 * 1024,
      vram_total: 10240 * 1024 * 1024,
    });

    const nv = parseNvidiaSmiCsv("37, 1500, 10240\n");
    expect(nv).toEqual({
      busy_pct: 37,
      vram_used: 1500 * 1024 * 1024,
      vram_total: 10240 * 1024 * 1024,
    });
  });

  it("samples synthetic proc/drm directories, seeds from HostResources, and accumulates history", async () => {
    const root = mkTempDir("t3-host-sampler-");
    const procDir = NodePath.join(root, "proc");
    const drmDir = NodePath.join(root, "drm");
    const card0 = NodePath.join(drmDir, "card0", "device");
    NodeFS.mkdirSync(procDir, { recursive: true });
    NodeFS.mkdirSync(card0, { recursive: true });

    NodeFS.writeFileSync(
      NodePath.join(procDir, "stat"),
      "cpu  100 0 100 800 0 0 0 0\ncpu0 50 0 50 400 0 0 0 0\ncpu1 50 0 50 400 0 0 0 0\n",
    );
    NodeFS.writeFileSync(
      NodePath.join(procDir, "meminfo"),
      "MemTotal:       8000000 kB\nMemAvailable:   3000000 kB\n",
    );
    NodeFS.writeFileSync(NodePath.join(card0, "gpu_busy_percent"), "62\n");
    NodeFS.writeFileSync(NodePath.join(card0, "mem_info_vram_used"), "1073741824\n");
    NodeFS.writeFileSync(NodePath.join(card0, "mem_info_vram_total"), "8589934592\n");

    const sampler = new NativeHostSampler({
      hostname: "test-host",
      platform: "linux",
      procRoot: procDir,
      drmRoot: drmDir,
      mounts: [{ path: root, label: "tmp" }],
      readHostResources: async () => ({
        sampledAt: FIXED_EPOCH_MS,
        cpuUtilization: 0.25,
        cpuCount: 2,
        availableMemoryBytes: 3_000_000 * 1024,
        totalMemoryBytes: 8_000_000 * 1024,
      }),
      readDesktopPower: async () => ({
        source: "electron-main",
        idle: "false",
        idleSeconds: 0,
        locked: "false",
        suspended: false,
        onBattery: "false",
        lowPowerMode: "false",
        thermalState: "nominal",
        stale: false,
        updatedAt: DateTime.makeUnsafe(FIXED_EPOCH_MS),
      }),
    });

    const first = await sampler.sample();
    expect(first.host.name).toBe("test-host");
    expect(first.host.cpus).toBe(2);
    expect(first.host.cpu_pct).toBe(25);
    expect(first.host.cpu_hist).toEqual([25]);
    expect(first.host.gpu?.busy_pct).toBe(62);
    expect(first.host.gpu?.vram_total).toBe(8589934592);
    expect(first.host.disks.length).toBe(1);
    expect(first.power.power).toBe("ac");

    // Advance /proc/stat by 500 busy + 500 idle = 50% CPU
    NodeFS.writeFileSync(
      NodePath.join(procDir, "stat"),
      "cpu  400 0 300 1300 0 0 0 0\ncpu0 200 0 150 650 0 0 0 0\ncpu1 200 0 150 650 0 0 0 0\n",
    );
    const second = await sampler.sample({ preferFastLinux: true });
    expect(second.host.cpu_pct).toBe(50);
    expect(second.host.cpu_hist).toEqual([25, 50]);
    expect(second.host.gpu?.busy_hist).toEqual([62, 62]);
  });
});

describe("NativeServersScanner and NativeSessionsScanner parsers & self-protection", () => {
  it("parses Docker ps output, ports, sizes, ss listeners, and ps process rows", () => {
    expect(parseSizeBytes("256MiB")).toBe(256 * 1024 * 1024);
    expect(parseDockerPorts("127.0.0.1:5432->5432/tcp, 0.0.0.0:3000->3000/tcp")).toEqual([
      { port: 5432, to: 5432, proto: "http", url: "http://127.0.0.1:5432" },
      { port: 3000, to: 3000, proto: "http", url: "http://127.0.0.1:3000" },
    ]);

    const rows = parseDockerPsLines(
      [
        "abc123456789\tmyapp-web-1\trunning\tUp 2 hours\tnode:24\tmyapp\tweb\tfalse\t/work/myapp\t127.0.0.1:3000->3000/tcp",
        "def987654321\tmyapp-run-1\texited\tExited (0)\tnode:24\tmyapp\tweb\ttrue\t/work/myapp\t",
      ].join("\n"),
      new Map([["abc123456789", { cpuPct: 4.5, memBytes: 128 * 1024 * 1024 }]]),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: "myapp/web",
      project: "myapp",
      service: "web",
      state: "up",
      port: 3000,
      cpu_pct: 4.5,
      uptime_s: 7200,
    });

    const listeners = parseSsListeners(
      'LISTEN 0 511 127.0.0.1:5173 0.0.0.0:* users:(("node",pid=4242,fd=21))\n',
    );
    expect(listeners).toEqual([{ port: 5173, pid: 4242, procName: "node" }]);

    expect(parseEtimeSeconds("1-02:03:04")).toBe(86400 + 7200 + 180 + 4);
    const procs = parsePsOutput(
      [
        " 1234     1 42.5 524288 05:10 R node server.js",
        " 9999   100  5.0 600000 10:00 S /Applications/T3 Code.app/Contents/MacOS/T3 Code --no-sandbox",
      ].join("\n"),
    );
    expect(procs).toHaveLength(2);
    expect(procs[0]).toMatchObject({
      pid: 1234,
      cpuPct: 42.5,
      memBytes: 524288 * 1024,
      ageSeconds: 310,
      comm: "node",
    });
    expect(procs[1]?.args).toContain("T3 Code.app");
  });

  it("refuses to stop T3's own PID, arbitrary unscanned containers, or non-Linux sessions", async () => {
    const scanner = new NativeServersScanner("linux");
    const res = await scanner.controlServer("stop", `dev:${process.pid}:3000`, {
      pid: process.pid,
    });
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/protected/i);

    // Arbitrary container name not in scanned list must be rejected
    const bogus = await scanner.controlServer("stop", "bogus/svc", {
      container: "arbitrary-unscanned-container",
    });
    expect(bogus.ok).toBe(false);

    // Non-Linux session close must be refused
    const darwinSessions = new NativeSessionsScanner("darwin");
    const darwinRes = await darwinSessions.closeSession("proc:9999");
    expect(darwinRes.ok).toBe(false);
    expect(darwinRes.message).toMatch(/Linux only/i);
  });
});

describe("RemoteNodeProber peer-first and SSH fallback", () => {
  it("prefers T3 PeerLink /api/devtools/fleet/self with zero SSH calls", async () => {
    let sshCalls = 0;
    const prober = new RemoteNodeProber({
      listPeerLinks: async () => [
        {
          environmentId: "env-msi",
          label: "host-x-wsl WSL",
          resolve: async () => ({ url: "https://host-x.ts.net", token: "tok_123" }),
        },
      ],
      fetchJson: async (url, token) => {
        expect(url).toBe("https://host-x.ts.net/api/devtools/fleet/self");
        expect(token).toBe("tok_123");
        return {
          host: {
            name: "host-x",
            uptime_s: 4000,
            load1: 0.75,
            cpus: 16,
            cpu_pct: 12.5,
            cpu_hist: [10, 12.5],
            mem: { used: 4_000_000_000, total: 12_000_000_000 },
            disks: [{ mount: "/", label: "root (/home)", used: 100, total: 1000 }],
            gpu: { busy_pct: 20, busy_hist: [20], vram_used: 1024, vram_total: 10240 },
            ts: "2026-11-25T07:00:00Z",
          },
          servers: [],
          status: "up",
          updated_at: "2026-11-25T07:00:00Z",
        };
      },
      runSshProbe: async () => {
        sshCalls += 1;
        return null;
      },
    });

    const node = await prober.probeTarget({ name: "host-x", ssh: "host-x-wsl" });
    expect(sshCalls).toBe(0);
    expect(node.status).toBe("up");
    expect(node.host.cpus).toBe(16);
    expect(node.host.cpu_pct).toBe(12.5);
    expect(node.host.gpu?.vram_total).toBe(10240);

    // Malformed peer payloads (missing cpu_hist, non-array disks, injected keys) never throw or leak
    const sanitized = sanitizePeerNodeState(
      {
        host: { name: "bad-peer", cpus: 4, cpu_hist: "not-an-array", disks: null },
        injectedKey: "evil",
      },
      { name: "bad-peer", ssh: "bad-peer" },
    );
    expect(sanitized).not.toBeNull();
    expect(sanitized?.host.cpu_hist).toEqual([]);
    expect(sanitized?.host.disks).toEqual([]);
    expect("injectedKey" in (sanitized as unknown as Record<string, unknown>)).toBe(false);
  });

  it("parses Linux and macOS SSH fallback probes accurately", () => {
    const linuxOut = [
      "---OS---",
      "Linux",
      "---LOAD---",
      "1.42",
      "---CPUS---",
      "12",
      "---UPTIME---",
      "9001.55",
      "---MEMINFO---",
      "MemTotal: 16000000 kB",
      "MemAvailable: 6000000 kB",
      "---DISK---",
      "Filesystem 1024-blocks Used Available Capacity Mounted on",
      "/dev/nvme0n1p2 1000000 400000 600000 40% /",
      "---GPU---",
      "NV 30 2000 8000",
      "---CPU---",
      "cpu  100 0 100 800 0 0 0 0",
      "cpu  200 0 200 1200 0 0 0 0",
      "---DOCKER---",
      "---END---",
    ].join("\n");

    const linuxNode = parseRemoteProbeOutput("dev-host-x", linuxOut, "dev-host-x");
    expect(linuxNode.status).toBe("up");
    expect(linuxNode.host.cpus).toBe(12);
    expect(linuxNode.host.cpu_pct).toBe(33.3);
    expect(linuxNode.host.load1).toBe(1.42);
    expect(linuxNode.host.gpu?.busy_pct).toBe(30);
    expect(linuxNode.host.disks[0]?.mount).toBe("/");

    const darwinOut = [
      "---OS---",
      "Darwin",
      "---LOAD---",
      "2.15",
      "---CPUS---",
      "10",
      "---BOOT---",
      String(Math.floor(FIXED_EPOCH_MS / 1000) - 3600),
      "---VMSTAT---",
      "16384",
      String(24 * 1024 ** 3),
      "Pages free: 100000.",
      "Pages inactive: 200000.",
      "Pages speculative: 10000.",
      "---DISK---",
      "Filesystem 1024-blocks Used Available Capacity Mounted on",
      "/dev/disk3s5 500000000 200000000 300000000 40% /System/Volumes/Data",
      "---POWER---",
      "Now drawing from 'Battery Power'",
      "---CPU---",
      "CPU usage: 10.0% user, 5.0% sys, 85.0% idle",
      "CPU usage: 22.5% user, 7.5% sys, 70.0% idle",
      "---DOCKER---",
      "---END---",
    ].join("\n");

    const macNode = parseRemoteProbeOutput("host-x", darwinOut, "host-x");
    expect(macNode.host.cpus).toBe(10);
    expect(macNode.host.cpu_pct).toBe(30);
    expect(macNode.power).toBe("battery");
    expect(macNode.host.disks[0]?.label).toBe("macOS");
  });
});

describe("NativeFleetService + DevtoolsHttp integration + in-memory routing parity", () => {
  it("serves capabilities, /fleet/self, /devdeck/snapshot, SSE, and feeds ship-queue routing in memory without writing fleet-nodes.json", async () => {
    const stateDir = mkTempDir("t3-fleet-state-");
    const fleet = new NativeFleetService({
      hostname: "ci-host-primary",
      stateDir,
      enableBackgroundPolling: false,
      readHostResources: async () => ({
        sampledAt: FIXED_EPOCH_MS,
        cpuUtilization: 0.2,
        cpuCount: 16,
        availableMemoryBytes: 32 * 1024 ** 3,
        totalMemoryBytes: 64 * 1024 ** 3,
      }),
    });

    try {
      const snap = await fleet.getSnapshot();
      expect((snap.host as { name: string; cpus: number }).name).toBe("ci-host-primary");
      expect((snap.host as { cpus: number }).cpus).toBe(16);

      // Legacy fleet-nodes.json file handoff is retired.
      const nodesPath = NodePath.join(stateDir, "fleet-nodes.json");
      expect(NodeFS.existsSync(nodesPath)).toBe(false);

      // Verify in-memory telemetry provider feeds `@t3tools/ship-queue/ciRouter` directly.
      const validated = validateCiHostsManifest({
        schema: 1,
        hosts: [{ name: "ci-host-primary", ssh: null, role: "ci", data_root: "/data/ci" }],
        toolchain: {
          git: { version: ">=2.40", probe: "git --version", install: null, base: true },
        },
      });
      expect(validated.ok).toBe(true);
      const loads = readInMemoryNodeLoads({
        manifest: validated.manifest!,
        telemetry: fleet.getTelemetryProvider(),
        hostNames: ["ci-host-primary"],
        nowEpochSec: Math.floor(Date.parse((snap.host as { ts: string }).ts) / 1000),
      });
      const reading = loads.get("ci-host-primary");
      expect(reading).toBeDefined();
      expect(reading?.cores).toBe(16);
      expect(reading?.onBattery).toBe(false);

      // Verify native route dispatcher
      const kickRes = await handleNativeFleetRequest(fleet, "POST", "/api/nodes/ci-worker-1/kick");
      expect(kickRes.status).toBe(200);

      // Verify DevtoolsHttp serves nativeFleet without DevDeck running
      const reg = JobRegistry.makeJobRegistry({ enableShipBridge: false });
      const scopes: ReadonlyArray<AuthEnvironmentScope> = [
        AuthDiagnosticsReadScope,
        AuthOrchestrationReadScope,
        AuthTerminalOperateScope,
        AuthAccessWriteScope,
      ];
      const testLayer = DevtoolsHttp.makeLayer({ startBroker: false, nativeFleet: fleet }).pipe(
        Layer.provide(Layer.succeed(JobRegistry.JobRegistry, reg)),
        Layer.provideMerge(Layer.succeed(HostProcess.Platform, "linux")),
        Layer.provideMerge(Layer.succeed(HostProcess.Hostname, "ci-host-primary")),
        Layer.provideMerge(Path.layer),
        Layer.provideMerge(
          Layer.succeed(EnvironmentAuth.EnvironmentAuth, {
            authenticateHttpRequest: () =>
              Effect.succeed({
                sessionId: "sess-1",
                subject: "owner-local",
                method: "browser-session-cookie" as const,
                scopes,
                issuedAt: "2026-01-01T00:00:00.000Z",
                expiresAt: "2099-01-01T00:00:00.000Z",
              }),
            authenticateWebSocketUpgrade: () =>
              Effect.succeed({
                sessionId: "sess-1",
                subject: "owner-local",
                method: "browser-session-cookie" as const,
                scopes,
                issuedAt: "2026-01-01T00:00:00.000Z",
                expiresAt: "2099-01-01T00:00:00.000Z",
              }),
          } as unknown as typeof EnvironmentAuth.EnvironmentAuth.Service),
        ),
        Layer.provideMerge(
          Layer.succeed(SessionStore.SessionStore, {
            cookieName: "t3_session",
            legacyCookieName: undefined,
            awaitInvalidation: () => Effect.never,
          } as unknown as typeof SessionStore.SessionStore.Service),
        ),
        Layer.provide(HttpPlatform.layer),
        Layer.provide(Etag.layerWeak),
        Layer.provide(NodeServices.layer),
      );
      const { handler, dispose } = HttpRouter.toWebHandler(testLayer, { disableLogger: true });

      try {
        const capsRes = await handler(new Request("http://127.0.0.1/api/devtools/capabilities"));
        expect(capsRes.status).toBe(200);
        const caps = (await capsRes.json()) as {
          nativeFleet: boolean;
          devdeckReachable: boolean;
          devdeckPassiveSupported: boolean;
          services: { devdeck: string };
        };
        expect(caps.nativeFleet).toBe(true);
        expect(caps.devdeckReachable).toBe(true);
        expect(caps.devdeckPassiveSupported).toBe(true);
        expect(caps.services.devdeck).toBe("reachable");

        const selfRes = await handler(new Request("http://127.0.0.1/api/devtools/fleet/self"));
        expect(selfRes.status).toBe(200);
        const selfBody = (await selfRes.json()) as {
          host: { name: string };
          servers: Array<Record<string, unknown>>;
          sessions?: Array<Record<string, unknown>>;
        };
        expect(selfBody.host.name).toBe("ci-host-primary");
        expect(Array.isArray(selfBody.sessions)).toBe(true);
        for (const s of selfBody.sessions ?? []) {
          expect(s.pid).toBeUndefined();
          expect(s.command).toBeUndefined();
          expect(s.cwd).toBeUndefined();
          expect(s.close_allowed).toBe(false);
        }
        for (const s of selfBody.servers) {
          expect(s.pid).toBeUndefined();
          expect(s.cwd).toBeUndefined();
        }

        const snapRes = await handler(
          new Request("http://127.0.0.1/api/devtools/devdeck/snapshot"),
        );
        expect(snapRes.status).toBe(200);
        const snapBody = (await snapRes.json()) as {
          host: { name: string };
          nodes: Record<string, unknown>;
        };
        expect(snapBody.host.name).toBe("ci-host-primary");
        expect(snapBody.nodes["ci-host-primary"]).toBeDefined();
      } finally {
        await dispose();
      }
    } finally {
      fleet.close();
    }
  });
});
