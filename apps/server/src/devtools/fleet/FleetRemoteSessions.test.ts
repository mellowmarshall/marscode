import { describe, expect, it } from "@effect/vitest";

import {
  MAX_REMOTE_SESSIONS,
  redactPeerSessions,
  sanitizeRemoteSessions,
} from "./FleetPeerWire.ts";
import { buildSelfNodeState } from "./FleetSelfNode.ts";
import type { FleetSessionItem } from "./FleetTypes.ts";
import { NativeHostSampler } from "./NativeHostSampler.ts";
import { RemoteNodeProber, sanitizePeerNodeState } from "./RemoteNodeProber.ts";
import { REMOTE_PROBE_SCRIPT, parseRemoteProbeOutput } from "./RemoteProbeParser.ts";
import { parseRemoteProcs } from "./RemoteProcsParser.ts";

const SECRET = "hunter2-not-a-real-token";

const localSession: FleetSessionItem = {
  id: "proc:4242:998877",
  kind: "process",
  name: "vitest",
  project: "marscode",
  age_s: 120,
  mem_bytes: 512 * 1024 * 1024,
  cpu_pct: 93.4,
  high: true,
  runaway: true,
  close_allowed: true,
  command: `node vitest --token=${SECRET}`,
  pid: 4242,
  cwd: "/home/someone/Dev/marscode",
};

function expectNoLocalDetail(session: FleetSessionItem): void {
  const rec = session as unknown as Record<string, unknown>;
  expect(rec.pid).toBeUndefined();
  expect(rec.command).toBeUndefined();
  expect(rec.cwd).toBeUndefined();
  expect(JSON.stringify(session)).not.toContain(SECRET);
  expect(JSON.stringify(session)).not.toContain("4242");
  expect(session.close_allowed).toBe(false);
}

const peerHost = {
  name: "host-x",
  uptime_s: 4000,
  cpus: 16,
  cpu_pct: 40,
  cpu_hist: [40],
  mem: { used: 1, total: 2 },
  disks: [],
  ts: "2026-11-25T07:00:00Z",
};

describe("Fleet peer session redaction", () => {
  it("redacts PIDs, command lines, and paths from sessions a peer link may see", () => {
    const [redacted] = redactPeerSessions([localSession]);
    expect(redacted).toBeDefined();
    expectNoLocalDetail(redacted!);
    expect(redacted).toMatchObject({
      kind: "process",
      name: "vitest",
      project: "marscode",
      cpu_pct: 93.4,
      mem_bytes: 512 * 1024 * 1024,
      runaway: true,
    });
    expect(redacted!.close_blocked_reason).toBeTruthy();
  });

  it("includes redacted sessions in the peer self node state, and full sessions locally", () => {
    const sources = {
      hostname: "dev-host-x",
      hostSampler: new NativeHostSampler({ hostname: "dev-host-x", platform: "linux" }),
      servers: [],
      sessions: [localSession],
    };
    const peer = buildSelfNodeState(sources, { includeSessions: true, redactPeer: true });
    expect(peer.sessions).toHaveLength(1);
    expectNoLocalDetail(peer.sessions![0]!);

    const local = buildSelfNodeState(sources, { includeSessions: true, redactPeer: false });
    expect(local.sessions).toEqual([localSession]);

    const routing = buildSelfNodeState(sources, { includeSessions: false, forRouting: true });
    expect(routing.sessions).toBeUndefined();
  });

  it("sanitizes untrusted session lists: drops bad rows and unknown keys, strips control characters, caps size", () => {
    const rows: unknown[] = [
      null,
      "string-row",
      [1, 2],
      { kind: "process" },
      { name: "  ", cpu_pct: 10 },
      { name: "evil\u001b[31m\nname", cpu_pct: -5, mem_bytes: Number.NaN, injected: "x" },
      ...Array.from({ length: MAX_REMOTE_SESSIONS + 10 }, (_, i) => ({ name: `p${i}` })),
    ];
    const out = sanitizeRemoteSessions(rows);
    expect(out).toHaveLength(MAX_REMOTE_SESSIONS);
    const first = out[0]!;
    expect(first.name).toBe("evil [31m name");
    expect(first.cpu_pct).toBeUndefined();
    expect(first.mem_bytes).toBeUndefined();
    expect("injected" in (first as unknown as Record<string, unknown>)).toBe(false);
    expect(new Set(out.map((s) => s.id)).size).toBe(out.length);
    expect(sanitizeRemoteSessions({ not: "an array" })).toEqual([]);
  });

  it("bounds huge numbers, strips C1 controls, and trims a cut label", () => {
    const [big] = sanitizeRemoteSessions([
      { name: `\u009b${"x".repeat(63)} tail`, cpu_pct: 2e307, mem_bytes: 1e308, age_s: 9e300 },
    ]);
    expect(Number.isFinite(big!.cpu_pct)).toBe(true);
    expect(big!.cpu_pct).toBeLessThanOrEqual(100_000);
    expect(big!.mem_bytes).toBe(Number.MAX_SAFE_INTEGER);
    expect(big!.age_s).toBe(Number.MAX_SAFE_INTEGER);
    expect(big!.name).toBe("x".repeat(63));
    expect(big!.name).not.toMatch(/[\u0080-\u009f]/);
  });
});

describe("Fleet RemoteNodeProber remote sessions", () => {
  it("keeps sanitized peer sessions instead of dropping them", () => {
    const node = sanitizePeerNodeState(
      {
        host: peerHost,
        servers: [],
        sessions: [{ ...localSession, close_allowed: true }, { bogus: true }],
      },
      { name: "host-x", ssh: "host-x-wsl" },
    );
    expect(node?.sessions).toHaveLength(1);
    expectNoLocalDetail(node!.sessions![0]!);
    expect(node!.sessions![0]!.name).toBe("vitest");
  });

  it("returns peer sessions through probeTarget with zero SSH calls", async () => {
    let sshCalls = 0;
    const prober = new RemoteNodeProber({
      listPeerLinks: async () => [
        {
          environmentId: "env-msi",
          label: "host-x-wsl WSL",
          resolve: async () => ({ url: "https://msi.example", token: "tok" }),
        },
      ],
      fetchJson: async () => ({ host: peerHost, servers: [], sessions: [localSession] }),
      runSshProbe: async () => {
        sshCalls += 1;
        return null;
      },
    });
    const node = await prober.probeTarget({ name: "host-x", ssh: "host-x-wsl" });
    expect(sshCalls).toBe(0);
    expect(node.sessions?.map((s) => s.name)).toEqual(["vitest"]);
    expect(prober.getCachedNodes()["host-x"]?.sessions).toHaveLength(1);
  });
});

describe("Fleet SSH probe hot processes", () => {
  it("asks ps for the executable name only, never argv", () => {
    expect(REMOTE_PROBE_SCRIPT).toContain("---PROCS---");
    expect(REMOTE_PROBE_SCRIPT).toContain("ps -A -ww -o pid=,ppid=,pcpu=,rss=,etime=,stat=,comm=");
    expect(REMOTE_PROBE_SCRIPT).not.toContain("args=");
    expect(REMOTE_PROBE_SCRIPT).toContain("head -n 30");
  });

  it("parses hot processes, keeps macOS names with spaces, dedupes PIDs, and skips the probe itself", () => {
    const procs = [
      "  812     1 95.0  204800 01:02:03 R    cargo",
      "  900   812 20.0 1048576    00:30 S    /Applications/T3 Code.app/Contents/MacOS/T3 Code",
      "  901   900  1.0    1024    00:01 S    sleepy",
      "  902   900  0.0  409600    05:00 S    postgres",
      "  903   900 50.0    2048    00:01 R    ps",
      "  904   900 30.0    2048    00:01 S    sshd",
      "  905   900 40.0    4096    00:02 S    /usr/bin/top",
      "  812     1 95.0  204800 01:02:03 R    cargo",
    ].join("\n");
    const sessions = parseRemoteProcs(procs);
    expect(sessions.map((s) => s.name)).toEqual(["cargo", "T3 Code", "postgres"]);
    expect(sessions[0]).toMatchObject({ runaway: true, orphaned: true, cpu_pct: 95 });
    expect(sessions[1]!.mem_bytes).toBe(1048576 * 1024);
    for (const s of sessions) expectNoLocalDetail(s);
  });

  it("fills node sessions from the PROCS section of a full probe", () => {
    const out = [
      "---OS---",
      "Linux",
      "---CPUS---",
      "8",
      "---PROCS---",
      "  777     1 88.0  10240 10:00 R    python3",
      "---CPU---",
      "---DOCKER---",
      "---END---",
    ].join("\n");
    const node = parseRemoteProbeOutput("ci-box", out, "ci-box");
    expect(node.sessions?.map((s) => s.name)).toEqual(["python3"]);
    expect(node.sessions?.[0]?.close_allowed).toBe(false);
  });
});
