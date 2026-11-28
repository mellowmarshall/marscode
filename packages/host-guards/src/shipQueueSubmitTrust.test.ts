import { describe, expect, it } from "vite-plus/test";

import type { ProcFsReader, ProcStatMeta } from "./procFs.ts";
import { isTrustedShipQueueSubmit, readInstalledShipQueue } from "./shipQueueSubmitTrust.ts";

const HOME = "/home/dev";
const NODE = "/home/dev/.nvm/versions/node/v24/bin/node";
const LINK_SCRIPT = "/home/dev/.local/lib/marscode-tools/ship-queue/dist/bin.mjs";
const REAL_SCRIPT = "/home/dev/.local/lib/marscode-tools/.releases/ship-queue.AbC/dist/bin.mjs";
const QUEUE = "/home/dev/.local/share/ship-queue";
const STAGED = `${QUEUE}/versions/v-1-abc/bin.mjs`;
const WRAPPER = `${HOME}/.local/bin/ship-queue`;
const wrapperText = (node = NODE, script = LINK_SCRIPT) =>
  [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    `node_bin='${node}'`,
    'if [ ! -x "$node_bin" ]; then',
    '  node_bin="$(command -v node)"',
    "fi",
    `exec "$node_bin" '${script}' "$@"`,
    "",
  ].join("\n");

interface Proc {
  readonly exe: string;
  readonly argv: ReadonlyArray<string>;
  readonly cwd?: string;
  readonly uid?: number;
  readonly env?: string;
}

function procFs(options: {
  readonly procs: Readonly<Record<number, Proc>>;
  readonly files?: Readonly<Record<string, string>>;
  readonly wrapperStat?: Partial<ProcStatMeta>;
}): ProcFsReader {
  const files: Record<string, string> = {
    [WRAPPER]: wrapperText(),
    [REAL_SCRIPT]: "// ship-queue bundle v1\n",
    [STAGED]: "// ship-queue bundle v1\n",
    [`${QUEUE}/versions/current.json`]: JSON.stringify({ version: "v-1-abc", entryPath: STAGED }),
    ...options.files,
  };
  const realpaths: Record<string, string> = {
    [LINK_SCRIPT]: REAL_SCRIPT,
    "/usr/bin/node-link": NODE,
  };
  const proc = (path: string) => {
    const m = /^\/proc\/(\d+)(?:\/(.*))?$/.exec(path);
    return m ? { entry: options.procs[Number(m[1])], part: m[2] ?? "" } : null;
  };
  return {
    hasProc: () => true,
    selfPid: () => 1,
    currentUid: () => 1000,
    readText: (path) => {
      const p = proc(path);
      if (p) {
        if (!p.entry) return null;
        if (p.part === "cmdline") return `${p.entry.argv.join("\0")}\0`;
        if (p.part === "environ") return p.entry.env ?? "PATH=/usr/bin\0";
        return null;
      }
      return files[path] ?? null;
    },
    readLink: (path) => {
      const p = proc(path);
      if (!p?.entry) return null;
      if (p.part === "exe") return p.entry.exe;
      if (p.part === "cwd") return p.entry.cwd ?? `${HOME}/src`;
      return null;
    },
    readDir: () => null,
    stat: (path) => {
      const p = proc(path);
      if (!p?.entry || p.part) return null;
      return { dev: 1, ino: 1, uid: p.entry.uid ?? 1000, mode: 0o040555, isFile: false };
    },
    lstat: (path) =>
      path === WRAPPER && files[WRAPPER] !== undefined
        ? { dev: 1, ino: 2, uid: 1000, mode: 0o100755, isFile: true, ...options.wrapperStat }
        : null,
    realpath: (path) => realpaths[path] ?? path,
    canonicalHome: () => HOME,
  };
}

const input = { queueRoot: QUEUE, worktree: `${HOME}/src/wt`, branch: "feat/74" };
const submit = (over: Partial<Proc> = {}): Proc => ({
  exe: NODE,
  argv: ["node", LINK_SCRIPT, "submit", "wt", "feat/74", "title", "body.md"],
  ...over,
});

describe("isTrustedShipQueueSubmit", () => {
  it("trusts only the installer's pinned node running the installer's script", () => {
    const fs = procFs({
      procs: {
        800: submit(),
        801: submit({
          argv: ["node", REAL_SCRIPT, "submit", "--no-start", `${HOME}/src/wt`, "feat/74"],
        }),
        802: submit({ exe: "/usr/bin/node-link" }),
        // Probes: any other node, an agent-writable copy of the script, flags, or another shape.
        810: submit({ exe: "/usr/bin/node" }),
        811: submit({
          argv: ["node", `${HOME}/.local/lib/marscode/bin.mjs`, "submit", "wt", "feat/74"],
        }),
        812: submit({
          argv: ["node", `${QUEUE}/versions/v-1-abc/bin.mjs`, "submit", "wt", "feat/74"],
        }),
        813: submit({
          argv: ["node", "--require", "/x.js", LINK_SCRIPT, "submit", "wt", "feat/74"],
        }),
        814: submit({ argv: ["node", LINK_SCRIPT, "submit", "wt", "feat/other"] }),
        815: submit({ argv: ["node", LINK_SCRIPT, "submit", "other-wt", "feat/74"] }),
        816: submit({ argv: ["node", LINK_SCRIPT, "work"] }),
        817: submit({ env: "NODE_OPTIONS=--require /tmp/x.js\0" }),
        818: submit({ exe: "/tmp/node" }),
        819: submit({ uid: 1001 }),
        820: submit({
          exe: `${HOME}/.local/bin/ship-queue`,
          argv: ["ship-queue", "submit", "wt", "feat/74"],
        }),
        821: submit({ exe: `${NODE} (deleted)` }),
        822: submit({ argv: ["node"] }),
      },
    });
    expect(isTrustedShipQueueSubmit(800, input, fs)).toBe(true);
    expect(isTrustedShipQueueSubmit(801, input, fs)).toBe(true);
    expect(isTrustedShipQueueSubmit(802, input, fs)).toBe(true);
    for (const pid of [810, 811, 812, 813, 814, 815, 816, 817, 818, 819, 820, 821, 822, 999]) {
      expect(isTrustedShipQueueSubmit(pid, input, fs), String(pid)).toBe(false);
    }
  });

  it("fails closed when the script hash, staged version, or wrapper does not check out", () => {
    const procs = { 800: submit() };
    const cases: ReadonlyArray<Parameters<typeof procFs>[0]> = [
      { procs, files: { [REAL_SCRIPT]: "// tampered\n" } },
      { procs, files: { [`${QUEUE}/versions/current.json`]: "{" } },
      {
        procs,
        files: {
          [`${QUEUE}/versions/current.json`]: JSON.stringify({ entryPath: REAL_SCRIPT }),
        },
      },
      {
        procs,
        files: {
          [WRAPPER]: wrapperText().replace(/^node_bin=.*$/m, 'node_bin="$(command -v node)"'),
        },
      },
      { procs, files: { [WRAPPER]: wrapperText("node") } },
      { procs, files: { [WRAPPER]: wrapperText(NODE, "/tmp/bin.mjs") } },
      { procs, wrapperStat: { mode: 0o100777 } },
      { procs, wrapperStat: { uid: 1001 } },
      { procs, wrapperStat: { isFile: false } },
    ];
    for (const [i, c] of cases.entries()) {
      expect(isTrustedShipQueueSubmit(800, input, procFs(c)), String(i)).toBe(false);
    }
  });

  it("reads the installed wrapper the way the installer writes it", () => {
    expect(readInstalledShipQueue(procFs({ procs: {} }))).toEqual({
      nodeBin: NODE,
      script: REAL_SCRIPT,
    });
    const quoted = procFs({
      procs: {},
      files: { [WRAPPER]: wrapperText("/opt/it'\\''s/node", LINK_SCRIPT) },
    });
    expect(readInstalledShipQueue(quoted)?.nodeBin).toBe("/opt/it's/node");
  });
});
