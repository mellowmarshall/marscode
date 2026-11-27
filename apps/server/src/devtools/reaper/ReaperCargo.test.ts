// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";

import { defaultCargoRoots, reapCargo, type CargoReapOptions } from "./ReaperCargo.ts";
import { parseReaperCargoRoots, readReaperCargoRootsSync } from "./ReaperCargoPolicy.ts";

const NOW_MS = Date.parse("2030-06-01T00:00:00.000Z");
const DAY = 86_400_000;
const uid = process.getuid!();
const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function tempDir(prefix: string): string {
  const dir = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), prefix)));
  cleanups.push(() => NodeFS.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function ageTree(root: string, ageMs: number): void {
  const seconds = (NOW_MS - ageMs) / 1000;
  for (const entry of NodeFS.readdirSync(root, { recursive: true, withFileTypes: true })) {
    NodeFS.lutimesSync(NodePath.join(entry.parentPath, entry.name), seconds, seconds);
  }
  NodeFS.utimesSync(root, seconds, seconds);
}

/** A real cargo layout: .rustc_info.json, debug/{deps,.fingerprint,build,incremental}, .cargo-lock. */
function makeBuildDir(root: string, name: string): string {
  const target = NodePath.join(root, name);
  const debug = NodePath.join(target, "debug");
  for (const sub of ["deps", ".fingerprint", "build/foo-1a2b", "incremental/foo-3c4d/s-x"]) {
    NodeFS.mkdirSync(NodePath.join(debug, sub), { recursive: true });
  }
  NodeFS.writeFileSync(NodePath.join(target, ".rustc_info.json"), "{}");
  NodeFS.writeFileSync(
    NodePath.join(target, "CACHEDIR.TAG"),
    "Signature: 8a477f597d28d172789f06886806bc55",
  );
  NodeFS.writeFileSync(NodePath.join(debug, ".cargo-lock"), "");
  NodeFS.writeFileSync(NodePath.join(debug, "deps", "libfoo.rlib"), Buffer.alloc(8192, 1));
  NodeFS.writeFileSync(
    NodePath.join(debug, "incremental", "foo-3c4d", "s-x", "query.bin"),
    Buffer.alloc(4096, 2),
  );
  return target;
}

const options = (
  roots: ReadonlyArray<string>,
  home: string,
  over: Partial<CargoReapOptions> = {},
): CargoReapOptions => ({
  roots,
  uid,
  platform: HostProcess.Platform.defaultValue(),
  homeDir: home,
  env: {},
  nowMs: NOW_MS,
  dryRun: false,
  log: () => undefined,
  processScan: async () => ({ paths: new Set(["/usr/bin/unrelated"]), otherProcesses: 3 }),
  namedPaths: { homeDir: home, unitSources: [], linkDirs: [], crontab: async () => "" },
  ...over,
});

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")("reapCargo", () => {
  it("empties a build folder unchanged for 14 days but keeps it and its .cargo-lock", async () => {
    const root = tempDir("t3-cargo-");
    const home = tempDir("t3-cargo-home-");
    const target = makeBuildDir(root, "app-target");
    ageTree(target, 20 * DAY);

    const result = await reapCargo(options([root], home));

    expect(result.build_dirs).toBe(1);
    expect(result.removed).toBe(1);
    expect(result.removed_bytes).toBeGreaterThan(0);
    expect(NodeFS.existsSync(NodePath.join(target, "debug", ".cargo-lock"))).toBe(true);
    expect(NodeFS.existsSync(NodePath.join(target, ".rustc_info.json"))).toBe(false);
    expect(NodeFS.existsSync(NodePath.join(target, "debug", "deps"))).toBe(false);
  });

  it("drops only incremental sessions older than 7 days in a folder built recently", async () => {
    const root = tempDir("t3-cargo-incr-");
    const home = tempDir("t3-cargo-home-");
    const target = makeBuildDir(root, "target");
    const fresh = NodePath.join(target, "debug", "incremental", "bar-9z8y");
    ageTree(target, 10 * DAY);
    NodeFS.mkdirSync(fresh);
    NodeFS.writeFileSync(NodePath.join(fresh, "q.bin"), "x");
    const recent = (NOW_MS - DAY) / 1000;
    NodeFS.utimesSync(NodePath.join(fresh, "q.bin"), recent, recent);
    NodeFS.utimesSync(fresh, recent, recent);
    NodeFS.utimesSync(NodePath.join(target, "debug", "deps", "libfoo.rlib"), recent, recent);
    const incrMtime = NodeFS.statSync(NodePath.join(target, "debug", "incremental")).mtimeMs;

    const result = await reapCargo(options([root], home));

    expect(result.removed).toBe(0);
    expect(result.incremental).toBe(1);
    expect(NodeFS.existsSync(NodePath.join(target, "debug", "incremental", "foo-3c4d"))).toBe(
      false,
    );
    expect(NodeFS.existsSync(fresh)).toBe(true);
    const kept = NodeFS.statSync(NodePath.join(target, "debug", "incremental")).mtimeMs;
    expect(Math.abs(kept - incrMtime)).toBeLessThan(1);
  });

  it("skips a folder a process, a systemd unit, the crontab or a command link uses", async () => {
    const root = tempDir("t3-cargo-use-");
    const home = tempDir("t3-cargo-home-");
    const units = tempDir("t3-cargo-units-");
    const links = tempDir("t3-cargo-links-");
    const byProcess = makeBuildDir(root, "a-target");
    const byUnit = makeBuildDir(root, "b-target");
    const byCron = makeBuildDir(root, "c-target");
    const byLink = makeBuildDir(root, "d-target");
    for (const dir of [byProcess, byUnit, byCron, byLink]) ageTree(dir, 30 * DAY);
    NodeFS.mkdirSync(NodePath.join(units, "api.service.d"));
    NodeFS.writeFileSync(
      NodePath.join(units, "api.service.d", "override.conf"),
      `[Service]\nExecStart=${byUnit}/debug/api --port=9\n`,
    );
    NodeFS.symlinkSync(
      NodePath.join(byLink, "debug", "deps", "libfoo.rlib"),
      NodePath.join(links, "foo"),
    );

    const result = await reapCargo(
      options([root], home, {
        processScan: async () => ({
          paths: new Set([NodePath.join(byProcess, "debug", ".cargo-lock")]),
          otherProcesses: 5,
        }),
        namedPaths: {
          homeDir: home,
          unitSources: [{ dir: units, suffix: ".service", dropIns: true }],
          linkDirs: [links],
          crontab: async () => `0 3 * * * ${byCron}/debug/nightly\n`,
        },
      }),
    );

    expect(result.skipped_in_use).toBe(4);
    expect(result.removed).toBe(0);
    for (const dir of [byProcess, byUnit, byCron, byLink]) {
      expect(NodeFS.existsSync(NodePath.join(dir, "debug", "deps", "libfoo.rlib"))).toBe(true);
    }
  });

  it("never treats a project folder as build output, and removes nothing when it reads no process", async () => {
    const root = tempDir("t3-cargo-proj-");
    const home = tempDir("t3-cargo-home-");
    const project = makeBuildDir(root, "crate");
    NodeFS.writeFileSync(NodePath.join(project, "Cargo.toml"), '[package]\nname = "crate"\n');
    const target = makeBuildDir(root, "other-target");
    ageTree(root, 30 * DAY);

    const blind = await reapCargo(
      options([root], home, { processScan: async () => ({ paths: new Set(), otherProcesses: 0 }) }),
    );
    expect(blind.build_dirs).toBe(1);
    expect(blind.aborted_reason).toBe("read no process but this one");
    expect(NodeFS.existsSync(NodePath.join(target, "debug", "deps"))).toBe(true);

    const dry = await reapCargo(options([root], home, { dryRun: true }));
    expect(dry.removed).toBe(1);
    expect(NodeFS.existsSync(NodePath.join(target, "debug", "deps"))).toBe(true);
    expect(NodeFS.existsSync(NodePath.join(project, "debug", "deps"))).toBe(true);
  });
});

describe("cargo roots from the policy file", () => {
  it("reads absolute [cargo] roots and adds existing ones to the built-in roots", async () => {
    const extra = tempDir("reaper-cargo-root-");
    const policy = NodePath.join(tempDir("reaper-cargo-policy-"), "policy.toml");
    NodeFS.writeFileSync(
      policy,
      [
        "[docker]",
        'roots = ["/ignored"]',
        "[cargo]",
        `roots = ["${extra}/", "relative/target", "/", "/missing-root-x"] # host-local`,
      ].join("\n"),
    );
    expect(readReaperCargoRootsSync(policy)).toEqual([extra, "/missing-root-x"]);
    expect(parseReaperCargoRoots("[docker]\nkeep_labels = []\n")).toEqual([]);
    expect(readReaperCargoRootsSync(NodePath.join(extra, "absent.toml"))).toEqual([]);
    const home = tempDir("reaper-cargo-home-");
    const roots = await defaultCargoRoots(home, {}, readReaperCargoRootsSync(policy));
    expect(roots).toContain(extra);
    expect(roots).not.toContain("/missing-root-x");
  });
});
