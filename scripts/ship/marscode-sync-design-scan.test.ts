// @effect-diagnostics nodeBuiltinImport:off - Installs into real temp directories and runs the installed file with node.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { parseCliArgs } from "./marscode-sync-cli.ts";
import { designScanBundle, installDesignScan } from "./marscode-sync-design-scan.ts";
import { WRAPPER_MARKER } from "./marscode-sync-parity.ts";
import { SYNC_BINARY_TARGETS } from "./marscode-sync-plan.ts";
import { runSync } from "./marscode-sync.ts";

const MARKER_LINE = `// ${WRAPPER_MARKER.slice(2)}`;
// A built bundle's shape: one self-contained ES module that prints the scan's JSON.
const BUNDLE =
  'import path from "node:path";\nprocess.stdout.write(JSON.stringify({ findings: [], files: path.sep.length }));\n';

let tmp: string;
let worktree: string;
let dir: string;
let logs: string[];
let warnings: string[];

beforeEach(() => {
  tmp = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "sync-design-scan-")),
  );
  worktree = NodePath.join(tmp, "worktree");
  dir = NodePath.join(tmp, "prefix", "lib", "playbook");
  NodeFS.mkdirSync(NodePath.dirname(designScanBundle(worktree)), { recursive: true });
  NodeFS.writeFileSync(designScanBundle(worktree), BUNDLE);
  logs = [];
  warnings = [];
});

afterEach(() => {
  NodeFS.rmSync(tmp, { recursive: true, force: true });
});

const install = () =>
  installDesignScan(worktree, { dir, log: (m) => logs.push(m), warn: (m) => warnings.push(m) });
const dest = () => NodePath.join(dir, "pb_design_scan.mjs");

describe("marscode-sync design scan install", () => {
  it("installs the bundle, marked as MarsCode's, where repos run it, and it runs", () => {
    expect(install()).toBe("installed");
    expect(NodeFS.readFileSync(dest(), "utf8")).toBe(`${MARKER_LINE}\n${BUNDLE}`);
    const run = NodeChildProcess.spawnSync(process.execPath, [dest()], { encoding: "utf8" });
    expect(run.status, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({ findings: [], files: 1 });
    expect(logs).toEqual([`marscode-sync: installed ${dest()}`]);
  });

  it("replaces its own earlier install", () => {
    NodeFS.mkdirSync(dir, { recursive: true });
    NodeFS.writeFileSync(dest(), `${MARKER_LINE}\nold\n`);
    expect(install()).toBe("installed");
    expect(NodeFS.readFileSync(dest(), "utf8")).toBe(`${MARKER_LINE}\n${BUNDLE}`);
    expect(warnings).toEqual([]);
  });

  it("keeps another install's file or link, with one warning line", () => {
    NodeFS.mkdirSync(dir, { recursive: true });
    NodeFS.writeFileSync(dest(), "// another install's scan\n");
    expect(install()).toBe("kept");
    expect(NodeFS.readFileSync(dest(), "utf8")).toBe("// another install's scan\n");
    expect(warnings).toEqual([
      `marscode-sync: warning: skipped pb_design_scan.mjs: kept ${dest()} (a file another install wrote, not installed by marscode-sync); remove it to let marscode-sync install its design scan.`,
    ]);
    NodeFS.rmSync(dest());
    NodeFS.symlinkSync(NodePath.join(tmp, "elsewhere.mjs"), dest());
    expect(install()).toBe("kept");
    expect(warnings[1]).toContain(
      `(a link to ${NodePath.join(tmp, "elsewhere.mjs")}, not installed`,
    );
  });

  it("leaves its own current copy alone", () => {
    expect(install()).toBe("installed");
    const before = NodeFS.statSync(dest()).mtimeMs;
    logs = [];
    expect(install()).toBe("current");
    expect(logs).toEqual([]);
    expect(NodeFS.statSync(dest()).mtimeMs).toBe(before);
  });

  it("keeps a copy it cannot read, as another install's, with one warning line", () => {
    NodeFS.mkdirSync(dir, { recursive: true });
    NodeFS.writeFileSync(dest(), "// unreadable\n", { mode: 0o000 });
    expect(install()).toBe("kept");
    expect(warnings).toEqual([
      `marscode-sync: warning: skipped pb_design_scan.mjs: kept ${dest()} (a file marscode-sync cannot read, not installed by marscode-sync); remove it to let marscode-sync install its design scan.`,
    ]);
  });

  it("refuses to install from a worktree that holds no built bundle", () => {
    NodeFS.rmSync(designScanBundle(worktree));
    expect(install).toThrow(/missing built bundle .*pb_design_scan\.mjs/);
  });
});

describe("marscode-sync runs the design scan install on every sync", () => {
  it("installs a missing design scan when nothing needs a rebuild", () => {
    const primary = NodePath.join(tmp, "primary");
    NodeFS.mkdirSync(primary);
    const git = (args: ReadonlyArray<string>) =>
      NodeChildProcess.execFileSync("git", ["-C", primary, ...args], {
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "T",
          GIT_AUTHOR_EMAIL: "t@e",
          GIT_COMMITTER_NAME: "T",
          GIT_COMMITTER_EMAIL: "t@e",
        },
      }).trim();
    git(["init", "-q", "-b", "main"]);
    git(["commit", "-q", "--allow-empty", "-m", "base"]);
    const head = git(["rev-parse", "HEAD"]);
    const dataRoot = NodePath.join(tmp, "data");
    const prefix = NodePath.join(tmp, "prefix");
    const binDir = NodePath.join(prefix, "bin");
    NodeFS.mkdirSync(binDir, { recursive: true });
    for (const target of SYNC_BINARY_TARGETS)
      NodeFS.writeFileSync(NodePath.join(binDir, target.binName), "");
    const targets = Object.fromEntries(SYNC_BINARY_TARGETS.map((t) => [t.id, head]));
    NodeFS.mkdirSync(dataRoot, { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(dataRoot, ".sync-state.json"),
      JSON.stringify({ version: 1, installSha: head, targets }),
    );
    const syncWorktree = NodePath.join(dataRoot, "sync-worktree");
    NodeFS.mkdirSync(NodePath.dirname(designScanBundle(syncWorktree)), { recursive: true });
    NodeFS.writeFileSync(designScanBundle(syncWorktree), BUNDLE);
    const options = parseCliArgs(
      [
        "--primary",
        primary,
        "--data-root",
        dataRoot,
        "--prefix",
        prefix,
        "--target-sha",
        head,
        "--skip-app",
      ],
      primary,
    );
    runSync(options);
    expect(
      NodeFS.readFileSync(NodePath.join(prefix, "lib", "playbook", "pb_design_scan.mjs"), "utf8"),
    ).toBe(`${MARKER_LINE}\n${BUNDLE}`);
  });
});
