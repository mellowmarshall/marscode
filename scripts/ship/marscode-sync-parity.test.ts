// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Tests the standalone sync installer against real CLIs on Node fs.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { atomicInstallNodeCli, installNodeClis } from "./marscode-sync-install.ts";
import { CliParityRefusal, PARITY_PROBES, WRAPPER_MARKER } from "./marscode-sync-parity.ts";
import { SYNC_BINARY_TARGETS, type SyncBinaryTarget } from "./marscode-sync-plan.ts";

const REPO = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "../..");

const target = (id: string): SyncBinaryTarget => {
  const t = SYNC_BINARY_TARGETS.find((x) => x.id === id);
  if (!t) throw new Error(`no sync target ${id}`);
  return t;
};

let tmp: string;
let binDir: string;
let libDir: string;
let logs: string[];
let worktrees = 0;

beforeEach(() => {
  tmp = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "sync-parity-")));
  binDir = NodePath.join(tmp, "prefix", "bin");
  libDir = NodePath.join(tmp, "prefix", "lib", "marscode-tools");
  NodeFS.mkdirSync(binDir, { recursive: true });
  logs = [];
});

afterEach(() => {
  NodeFS.rmSync(tmp, { recursive: true, force: true });
});

/**
 * A sync worktree whose built bundle for the target runs the given real CLI
 * entry point (node runs the TypeScript source as the bundle would).
 */
function worktreeRunning(t: SyncBinaryTarget, entry: string): string {
  worktrees += 1;
  const wt = NodePath.join(tmp, `wt-${t.id}-${worktrees}`);
  const bundle = NodePath.join(wt, t.pkgRel, "dist", "bin.mjs");
  NodeFS.mkdirSync(NodePath.dirname(bundle), { recursive: true });
  NodeFS.writeFileSync(bundle, `import ${JSON.stringify(NodeURL.pathToFileURL(entry).href)};\n`);
  return wt;
}

function install(t: SyncBinaryTarget, wt: string): void {
  atomicInstallNodeCli(wt, t, {
    binDir,
    libDir,
    nodeBin: process.execPath,
    log: (m) => logs.push(m),
  });
}

/** The original's install layout: the bin is a link into its own lib directory. */
function originalStyleLink(name: string): { link: string; script: string } {
  const lib = NodePath.join(tmp, "prefix", "lib", name);
  NodeFS.mkdirSync(lib, { recursive: true });
  const script = NodePath.join(lib, name);
  NodeFS.writeFileSync(script, "#!/bin/sh\necho original\n", { mode: 0o755 });
  const link = NodePath.join(binDir, name);
  NodeFS.symlinkSync(script, link);
  return { link, script };
}

function run(bin: string, args: ReadonlyArray<string>) {
  return NodeChildProcess.spawnSync(bin, [...args], { cwd: tmp, encoding: "utf8" });
}

const currentRunlog = NodePath.join(REPO, "packages/runlog/src/bin.ts");

/**
 * A real MarsCode CLI built where runlog's bundle belongs: it has no --ci-suite,
 * as a stale or wrong build would not.
 */
const noParityCli = NodePath.join(REPO, "packages/fleet/src/bin.ts");

describe("marscode-sync flag-parity guard", () => {
  it("replaces another install's runlog link with a runlog that passes --ci-suite parity", () => {
    const { link, script } = originalStyleLink("runlog");
    install(target("runlog"), worktreeRunning(target("runlog"), currentRunlog));
    const stat = NodeFS.lstatSync(link);
    expect(stat.isSymbolicLink()).toBe(false);
    expect(NodeFS.readFileSync(link, "utf8")).toContain(WRAPPER_MARKER);
    // The other install's own files are left alone.
    expect(NodeFS.readFileSync(script, "utf8")).toBe("#!/bin/sh\necho original\n");
    const r = run(link, ["--ci-suite", "after", "--", "true"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^ci-suite: begin after pid=\d+ by=runlog\nci-suite: end after pass/);
  });

  it("refuses to replace it with a runlog that has no --ci-suite, and leaves everything in place", () => {
    const { link, script } = originalStyleLink("runlog");
    const wt = worktreeRunning(target("runlog"), noParityCli);
    let refusal: unknown;
    try {
      install(target("runlog"), wt);
    } catch (err) {
      refusal = err;
    }
    expect(refusal).toBeInstanceOf(CliParityRefusal);
    // A real refusal is final until the probe or the bin changes.
    expect((refusal as CliParityRefusal).retry).toBe(false);
    const message = (refusal as Error).message;
    expect(message).toContain(`marscode-sync: warning: skipped runlog: kept ${link}`);
    expect(message.split("\n")).toHaveLength(1);
    expect(message).toContain(`a link to ${script}`);
    expect(message).toContain("runlog --ci-suite x -- true");
    expect(message).toMatch(/it exited [1-9]/);
    expect(message).toContain("; remove it to let marscode-sync install its runlog.");
    expect(NodeFS.readlinkSync(link)).toBe(script);
    expect(run(link, []).stdout).toBe("original\n");
    // No release was left behind for the refused CLI.
    expect(NodeFS.existsSync(NodePath.join(libDir, "runlog"))).toBe(false);
    const releases = NodePath.join(libDir, ".releases");
    expect(NodeFS.existsSync(releases) ? NodeFS.readdirSync(releases) : []).toEqual([]);
  });

  it("never replaces another install's playbook: the port has no parity check for it", () => {
    const { link, script } = originalStyleLink("playbook");
    const t = target("playbook");
    expect(() =>
      install(t, worktreeRunning(t, NodePath.join(REPO, "packages/playbook/src/bin.ts"))),
    ).toThrow(/the MarsCode playbook has no flag-parity check/);
    expect(NodeFS.readlinkSync(link)).toBe(script);
  });

  it("always installs ship-queue, which MarsCode owns, over a file another install wrote", () => {
    const shipQueue = NodePath.join(binDir, "ship-queue");
    NodeFS.writeFileSync(shipQueue, "#!/bin/sh\necho mine\n", { mode: 0o755 });
    const t = target("ship-queue");
    const installed: string[] = [];
    const warnings: string[] = [];
    const skipped = installNodeClis(worktreeRunning(t, currentRunlog), [t], {
      binDir,
      libDir,
      nodeBin: process.execPath,
      log: (m) => logs.push(m),
      warn: (m) => warnings.push(m),
      // The sync stages the ship-queue version here.
      onInstalled: (done) => installed.push(done.id),
    });
    expect(skipped).toEqual([]);
    expect(warnings).toEqual([]);
    expect(installed).toEqual(["ship-queue"]);
    expect(NodeFS.readFileSync(shipQueue, "utf8")).toContain(WRAPPER_MARKER);
  });

  it("takes only a whole marker line as MarsCode's, as the host installer's grep -x does", () => {
    const own = NodePath.join(binDir, "playbook");
    NodeFS.writeFileSync(own, `#!/bin/sh\necho '${WRAPPER_MARKER}'\n`, { mode: 0o755 });
    const t = target("playbook");
    expect(() =>
      install(t, worktreeRunning(t, NodePath.join(REPO, "packages/playbook/src/bin.ts"))),
    ).toThrow(/kept .*playbook \(a file another install wrote, not installed by marscode-sync\)/);
    expect(NodeFS.readFileSync(own, "utf8")).toBe(`#!/bin/sh\necho '${WRAPPER_MARKER}'\n`);
  });

  it("marks a skip whose probe did not finish for a retry, and leaves the old CLI", () => {
    const { link, script } = originalStyleLink("runlog");
    // The real runlog, whose probe command `true` hangs here past the probe's timeout.
    const slow = NodePath.join(tmp, "slow-bin");
    NodeFS.mkdirSync(slow);
    NodeFS.writeFileSync(NodePath.join(slow, "true"), "#!/bin/sh\nsleep 5\n", { mode: 0o755 });
    const savedPath = process.env.PATH;
    process.env.PATH = `${slow}:${savedPath ?? ""}`;
    let refusal: unknown;
    try {
      atomicInstallNodeCli(worktreeRunning(target("runlog"), currentRunlog), target("runlog"), {
        binDir,
        libDir,
        nodeBin: process.execPath,
        log: (m) => logs.push(m),
        probeTimeoutMs: 1_500,
      });
    } catch (err) {
      refusal = err;
    } finally {
      process.env.PATH = savedPath;
    }
    expect(refusal).toBeInstanceOf(CliParityRefusal);
    expect((refusal as CliParityRefusal).retry).toBe(true);
    expect((refusal as Error).message).toMatch(
      /its flag-parity check did not run \(.*ETIMEDOUT.*\); the next sync tries again\.$/,
    );
    expect(NodeFS.readlinkSync(link)).toBe(script);
  });

  it("reinstalls over its own wrappers, older ones without the marker too, with no parity check", () => {
    const t = target("runlog");
    const old = NodePath.join(binDir, "runlog");
    // A wrapper as earlier marscode-sync releases wrote it: it names the release link's bundle.
    NodeFS.writeFileSync(
      old,
      `#!/usr/bin/env bash\nexec node '${NodePath.join(libDir, "runlog", "dist", "bin.mjs")}' "$@"\n`,
      { mode: 0o755 },
    );
    // Even a CLI without parity replaces a wrapper marscode-sync wrote.
    install(t, worktreeRunning(t, noParityCli));
    expect(NodeFS.readFileSync(old, "utf8")).toContain(WRAPPER_MARKER);
    install(t, worktreeRunning(t, currentRunlog));
    expect(run(old, ["--ci-suite", "again", "--", "true"]).status).toBe(0);
    expect(logs.filter((m) => m.startsWith("marscode-sync: installed"))).toHaveLength(2);
  });

  it("passes every parity probe with this tree's own CLIs", () => {
    for (const [name, probe] of Object.entries(PARITY_PROBES)) {
      const entry = NodePath.join(REPO, "packages", name, "src", "bin.ts");
      const r = NodeChildProcess.spawnSync(process.execPath, [entry, ...probe.args], {
        cwd: tmp,
        encoding: "utf8",
      });
      expect(probe.judge({ status: r.status, stdout: r.stdout }), name).toBeNull();
    }
  });

  it("skips a refused CLI with one warning line and still installs the others", () => {
    const { link, script } = originalStyleLink("playbook");
    const playbook = target("playbook");
    const runlog = target("runlog");
    const fleet = target("fleet");
    // One worktree holding all three built bundles, as the sync's build leaves it.
    const wt = NodePath.join(tmp, "wt-all");
    for (const [t, entry] of [
      [playbook, "packages/playbook/src/bin.ts"],
      [runlog, "packages/runlog/src/bin.ts"],
      [fleet, "packages/fleet/src/bin.ts"],
    ] as const) {
      const file = NodePath.join(wt, t.pkgRel, "dist", "bin.mjs");
      NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
      const href = NodeURL.pathToFileURL(NodePath.join(REPO, entry)).href;
      NodeFS.writeFileSync(file, `import ${JSON.stringify(href)};\n`);
    }
    const warnings: string[] = [];
    const installed: string[] = [];
    const skipped = installNodeClis(wt, [playbook, runlog, fleet], {
      binDir,
      libDir,
      nodeBin: process.execPath,
      log: (m) => logs.push(m),
      warn: (m) => warnings.push(m),
      onInstalled: (t) => installed.push(t.id),
    });
    expect(skipped.map((s) => [s.target.id, s.retry])).toEqual([["playbook", false]]);
    expect(installed).toEqual(["runlog", "fleet"]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(
      /^marscode-sync: warning: skipped playbook: kept .*playbook \(a link to .*\) because the MarsCode playbook has no flag-parity check; remove it to let marscode-sync install its playbook\.$/,
    );
    expect(NodeFS.readlinkSync(link)).toBe(script);
    expect(run(NodePath.join(binDir, "runlog"), ["--ci-suite", "x", "--", "true"]).status).toBe(0);
    expect(run(NodePath.join(binDir, "fleet"), ["--help"]).status).toBe(0);
  });

  it("installs where nothing is installed yet", () => {
    const t = target("runlog");
    install(t, worktreeRunning(t, currentRunlog));
    expect(run(NodePath.join(binDir, "runlog"), ["--ci-suite", "x", "--", "false"]).status).toBe(1);
  });
});
