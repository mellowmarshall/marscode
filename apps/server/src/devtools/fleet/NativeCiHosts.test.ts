// @effect-diagnostics nodeBuiltinImport:off - Server NativeCiHosts direct @t3tools/ship-queue integration tests (zero shell-out).
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { decideShipQueueDeps, listShipQueueDeps } from "@t3tools/ship-queue/depsEngine";
import { SqliteDepsStore } from "@t3tools/ship-queue/depsStore";
import type { ProcessRunner } from "@t3tools/ship-queue/types";

import { NativeCiHosts, readCiHostsManifest } from "./NativeCiHosts.ts";

const tempDirs: string[] = [];

function mkTempDir(prefix: string): string {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
});

function spawnProcess(input: Parameters<ProcessRunner>[0]): ReturnType<ProcessRunner> {
  return new Promise((resolve) => {
    const child = NodeChildProcess.spawn(input.command, [...input.args], {
      cwd: input.cwd,
      env: input.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => {
      stdout += c.toString("utf8");
    });
    child.stderr.on("data", (c: Buffer) => {
      stderr += c.toString("utf8");
    });
    if (input.stdin !== undefined) {
      child.stdin.write(input.stdin);
    }
    child.stdin.end();
    child.on("close", (code) => resolve({ exitCode: code ?? 1, stdout, stderr }));
    child.on("error", (err) => resolve({ exitCode: 1, stdout, stderr: err.message }));
  });
}

describe("NativeCiHosts direct @t3tools/ship-queue integration (zero shell-out)", () => {
  it("runs check, setCi off/on, and provision natively via @t3tools/ship-queue without calling any ship-queue binary", async () => {
    const dir = mkTempDir("t3-native-cihosts-");
    const queueRoot = NodePath.join(dir, "sq");
    const stateFile = NodePath.join(dir, "hosts-check.json");
    const manifestPath = NodePath.join(dir, "ci-hosts.json");
    NodeFS.writeFileSync(
      manifestPath,
      JSON.stringify({
        schema: 1,
        hosts: [{ name: "local", ssh: null, role: "ci", data_root: "~/data" }],
        toolchain: {
          git: { version: ">=2.0", probe: "echo git version 2.45.0", install: null, base: true },
          vp: {
            version: ">=0.1",
            probe: "echo vp v0.1.18",
            install: "echo installed-vp",
            base: false,
          },
        },
      }),
    );

    // Confirm canonical reader parses the manifest.
    expect(readCiHostsManifest(manifestPath).map((h) => h.name)).toEqual(["local"]);

    const spawnedCommands: string[] = [];
    const trackedRunner: ProcessRunner = async (input) => {
      spawnedCommands.push(input.command);
      return spawnProcess(input);
    };

    const ciHosts = new NativeCiHosts({
      stateFile,
      queueRoot,
      manifestPath,
      hostExecDeps: {
        nowMs: () => 1_700_000_000_000,
        runLocal: trackedRunner,
      },
    });

    const checkRes = await ciHosts.check("local");
    expect(checkRes.ok).toBe(true);
    // Zero shell-outs to any `ship-queue` binary!
    expect(spawnedCommands.some((c) => c.includes("ship-queue"))).toBe(false);

    const offRes = await ciHosts.setCi("local", false);
    expect(offRes.ok).toBe(true);
    const panelOff = ciHosts.getPanel();
    expect(panelOff.report?.hosts[0]?.ci_off).toBe(true);

    const onRes = await ciHosts.setCi("local", true);
    expect(onRes.ok).toBe(true);
    const panelOn = ciHosts.getPanel();
    expect(panelOn.report?.hosts[0]?.ci_off).toBe(false);

    const provRes = await ciHosts.provision("local");
    expect(provRes.ok).toBe(true);
    expect(spawnedCommands.some((c) => c.includes("ship-queue"))).toBe(false);
  });

  it("lists manifest hosts with their live CI state before any hosts check, so CI switches show", async () => {
    const dir = mkTempDir("t3-native-cihosts-seed-");
    const queueRoot = NodePath.join(dir, "sq");
    const manifestPath = NodePath.join(dir, "ci-hosts.json");
    NodeFS.writeFileSync(
      manifestPath,
      JSON.stringify({
        schema: 1,
        hosts: [
          { name: "host-a", ssh: null },
          { name: "host-b", ssh: "host-b" },
        ],
      }),
    );
    const ciHosts = new NativeCiHosts({
      stateFile: NodePath.join(dir, "hosts-check.json"),
      queueRoot,
      manifestPath,
    });

    const before = ciHosts.getPanel().report?.hosts ?? [];
    expect(before.map((h) => [h.name, h.ci_off])).toEqual([
      ["host-a", false],
      ["host-b", false],
    ]);
    expect(before.every((h) => h.reached === undefined)).toBe(true);

    expect((await ciHosts.setCi("host-b", false)).ok).toBe(true);
    const off = ciHosts.getPanel().report?.hosts.find((h) => h.name === "host-b");
    expect(off).toMatchObject({ ci_off: true, ci_off_by: "t3code" });

    expect((await ciHosts.setCi("host-b", true)).ok).toBe(true);
    expect(ciHosts.getPanel().report?.hosts.find((h) => h.name === "host-b")?.ci_off).toBe(false);
  });

  it("wires server SQLite deps reads and pre-approval validated idempotent decisions end-to-end", async () => {
    const queueRoot = mkTempDir("t3-native-deps-");
    const fixedNow = 1_700_000_000;
    const store = new SqliteDepsStore(queueRoot);
    try {
      store.saveRepoState(
        {
          repo: "srv-repo",
          holding: true,
          holdingSince: fixedNow - 100,
          report: {
            id: "srv-repo:rep1",
            created: fixedNow - 10,
            status: "pending",
            files: { "package.json": "sha-a" },
            updates: [
              {
                packageFile: "package.json",
                depName: "effect",
                currentValue: "3.10.0",
                newValue: "3.11.0",
              },
            ],
          },
        },
        fixedNow,
      );
    } finally {
      store.close();
    }

    const listed = listShipQueueDeps(queueRoot, () => fixedNow);
    expect(listed.repos).toHaveLength(1);
    expect(listed.repos[0]!.repo).toBe("srv-repo");

    let brokerPreapprovals = 0;
    const res1 = await decideShipQueueDeps(
      {
        queueRoot,
        nowEpochSec: () => fixedNow,
        requestOwnerApproval: async () => {
          brokerPreapprovals += 1;
          return { ok: true, approvedBy: "human" };
        },
      },
      { reportId: "srv-repo:rep1", decision: "reject", cwd: queueRoot },
    );
    expect(res1.ok).toBe(true);
    expect(brokerPreapprovals).toBe(1);

    // Repeat call is idempotent and does NOT call owner approval again.
    const res2 = await decideShipQueueDeps(
      {
        queueRoot,
        nowEpochSec: () => fixedNow + 5,
        requestOwnerApproval: async () => {
          brokerPreapprovals += 1;
          return { ok: true, approvedBy: "human" };
        },
      },
      { reportId: "srv-repo:rep1", decision: "reject", cwd: queueRoot },
    );
    expect(res2.ok).toBe(true);
    expect(res2.idempotent).toBe(true);
    expect(brokerPreapprovals).toBe(1);
  });

  it("detects and reconciles non-root tool drift natively via NativeCiHosts without bypassing root approval", async () => {
    const dir = mkTempDir("t3-native-drift-");
    const queueRoot = NodePath.join(dir, "sq");
    const stateFile = NodePath.join(dir, "hosts-check.json");
    const manifestPath = NodePath.join(dir, "ci-hosts.json");
    const repoDir = NodePath.join(dir, "sample-repo");
    NodeFS.mkdirSync(repoDir, { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(repoDir, ".tree-guard.conf"),
      "ship_repo=acme-fixture/server-app\nship_ci_tool=vp@>=0.1\nship_ci_arch=x86_64\n",
    );
    NodeFS.writeFileSync(
      manifestPath,
      JSON.stringify({
        schema: 1,
        hosts: [
          { name: "ci-x86-1", ssh: null, role: "ci", data_root: "~/data" },
          { name: "ci-x86-2", ssh: "ci-x86-2", role: "ci", data_root: "~/data" },
        ],
        toolchain: {
          git: { version: ">=2.0", probe: "git --version", install: null, base: true },
          vp: { version: ">=0.1", probe: "vp --version", install: "ci-vp.sh", base: false },
        },
      }),
    );

    const state: Record<string, Record<string, string>> = {
      "ci-x86-1": {
        __os: "linux",
        __arch: "x86_64",
        __home: "/srv/ci",
        git: "2.45.0",
        vp: "0.1.18",
      },
      "ci-x86-2": {
        __os: "linux",
        __arch: "x86_64",
        __home: "/srv/ci",
        git: "2.45.0",
        vp: "missing",
      },
    };
    const exec = async (host: string, script: string) => {
      if (script.includes('printf "__os\\t%s\\n"')) {
        return {
          exitCode: 0,
          stdout: `${Object.entries(state[host]!)
            .map(([k, v]) => `${k}\t${v}`)
            .join("\n")}\n`,
          stderr: "",
        };
      }
      if (script.includes("ci-vp.sh")) {
        state[host]!.vp = "0.1.18";
        return { exitCode: 0, stdout: "installed vp\n", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const ciHosts = new NativeCiHosts({
      stateFile,
      queueRoot,
      manifestPath,
      repoDirs: [{ repo: "acme-fixture/server-app", primary: repoDir }],
      hostExecDeps: {
        nowMs: () => 1_760_000_000_000,
        nowIso: () => "2026-11-27T12:00:00.000Z",
        runLocal: async (input) => exec("ci-x86-1", input.args[1] ?? ""),
        runRemote: async (alias, script) => exec(alias, script),
      },
    });

    await ciHosts.check();
    // Verify HostCheckEntry records normalized arch so fallback to hosts-check.json preserves arch info.
    const checkedHosts = ciHosts.getPanel().report?.hosts ?? [];
    expect(checkedHosts.map((h) => h.arch)).toEqual(["x86_64", "x86_64"]);

    const before = ciHosts.getToolDriftReport("2026-11-27T12:00:00.000Z");
    expect(before?.hasSingleHostStranding).toBe(true);
    expect(before?.hosts.map((h) => h.host)).toEqual(["ci-x86-2"]);

    // Even if .probe files are removed, fallback to hosts-check.json still detects x86_64 stranding!
    NodeFS.rmSync(NodePath.join(queueRoot, "hosts", "ci-x86-1.probe"), { force: true });
    NodeFS.rmSync(NodePath.join(queueRoot, "hosts", "ci-x86-2.probe"), { force: true });
    const fallbackDrift = ciHosts.getToolDriftReport("2026-11-27T12:00:00.000Z");
    expect(fallbackDrift?.hasSingleHostStranding).toBe(true);
    expect(fallbackDrift?.hosts[0]?.arch).toBe("x86_64");

    let changedCount = 0;
    const rec = await ciHosts.reconcileToolDrift({ onChanged: () => (changedCount += 1) });
    expect(rec.ok).toBe(true);
    expect(rec.provisioned).toEqual([{ host: "ci-x86-2", tools: ["vp"] }]);
    expect(changedCount).toBe(1);

    const after = ciHosts.getToolDriftReport("2026-11-27T12:05:00.000Z");
    expect(after?.hasDrift).toBe(false);
    expect(after?.hasSingleHostStranding).toBe(false);
  });
});
