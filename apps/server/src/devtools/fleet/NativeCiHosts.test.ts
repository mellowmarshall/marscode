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
});
