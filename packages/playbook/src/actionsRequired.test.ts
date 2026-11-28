// @effect-diagnostics nodeBuiltinImport:off - Drives the real `playbook` bin over real temp git repositories.
/**
 * `playbook actions required`, ported from the original playbook's actions tests: each case
 * runs the real bin (src/bin.ts) on a real git repository with a declared walks file, a
 * catalog and a closure command. With PLAYBOOK_ORIGINAL set to the original's `playbook`
 * script, every run is also made with it and must match byte for byte (stdout, stderr, code).
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { cleanupTempDirs, makeTempDir } from "./testing/fixtureRepo.ts";

afterEach(cleanupTempDirs);

const BIN = NodeURL.fileURLToPath(new URL("./bin.ts", import.meta.url));
const ORIGINAL = process.env.PLAYBOOK_ORIGINAL;

interface Run {
  readonly code: number | null;
  readonly out: string;
  readonly err: string;
}

function env(dir: string): NodeJS.ProcessEnv {
  const noGh = NodePath.join(dir, "no-gh");
  NodeFS.mkdirSync(noGh, { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(noGh, "gh"),
    '#!/bin/sh\necho "gh is not reachable in tests" >&2\nexit 1\n',
    {
      mode: 0o755,
    },
  );
  const clean = Object.fromEntries(
    Object.entries(process.env).filter(
      ([k]) => !k.startsWith("SHIP_QUEUE_") && k !== "HOST_GUARD_OVERRIDE" && k !== "COLUMNS",
    ),
  );
  return { ...clean, PATH: `${noGh}:${process.env.PATH ?? ""}` };
}

function spawn(
  cmd: string,
  args: ReadonlyArray<string>,
  cwd: string,
  extra: NodeJS.ProcessEnv = {},
): Run {
  const res = NodeChildProcess.spawnSync(cmd, [...args], {
    cwd,
    encoding: "utf8",
    env: { ...env(NodePath.dirname(cwd)), ...extra },
  });
  return { code: res.status, out: res.stdout, err: res.stderr };
}

/** The port's run of ARGS in DIR; the original's too (and equal to it) when PLAYBOOK_ORIGINAL is set. */
function playbook(
  dir: string,
  args: ReadonlyArray<string>,
  inDir = true,
  extra: NodeJS.ProcessEnv = {},
): Run {
  const argv = inDir ? ["-C", dir, ...args] : args;
  const port = spawn(process.execPath, [BIN, ...argv], dir, extra);
  if (ORIGINAL) expect(spawn(ORIGINAL, argv, dir, extra)).toEqual(port);
  return port;
}

const names = (run: Run) => run.out.split("\n").filter((l) => l !== "");

function git(root: string, args: ReadonlyArray<string>): string {
  const res = NodeChildProcess.spawnSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "T",
      GIT_AUTHOR_EMAIL: "t@e",
      GIT_COMMITTER_NAME: "T",
      GIT_COMMITTER_EMAIL: "t@e",
    },
  });
  if (res.status !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr}`);
  return res.stdout.trim();
}

/** The original's minimal declaration (every repo's required contracts), with CONTRACTS merged in. */
function declaration(contracts: object): object {
  return {
    contracts: {
      size: { command: "echo '{}'" },
      fleet: { file: "fleet.json", reads: "echo '{}'" },
      tools: { steps: [] },
      generations: { command: null },
      optimization: { none: "nothing to budget: no route, job or action" },
      ...contracts,
    },
    ci: {
      parallel: 2,
      full: [],
      always: [],
      select: 'echo \'{"suites": [], "full": false, "reason": "nothing to test"}\'',
    },
  };
}

interface Repo {
  readonly root: string;
  readonly write: (rel: string, text: string) => void;
  readonly json: (rel: string, value: unknown) => void;
  readonly edit: (rel: string, change: (value: Record<string, any>) => void) => void;
  /** Commit everything and make the commit origin/main. */
  readonly base: (message: string) => void;
  readonly restore: () => void;
}

/** A git repository whose closure command digests src/<file>.js for each action of FILES. */
function repo(files: Readonly<Record<string, string>>): Repo {
  const root = NodePath.join(makeTempDir("pb-actions-"), "repo");
  NodeFS.mkdirSync(root, { recursive: true });
  git(root, ["init", "-q", "-b", "main"]);
  const write = (rel: string, text: string) => {
    NodeFS.mkdirSync(NodePath.dirname(NodePath.join(root, rel)), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(root, rel), text);
  };
  const json = (rel: string, value: unknown) => write(rel, `${JSON.stringify(value, null, 1)}\n`);
  for (const f of Object.values(files)) write(`src/${f}.js`, `export const ${f} = 1;\n`);
  write(
    "closure.mjs",
    `import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
const names = ${JSON.stringify(files)};
const digest = (f) => createHash("sha256").update(readFileSync(\`src/\${f}.js\`)).digest("hex");
console.log(JSON.stringify(Object.fromEntries(Object.entries(names).map(([k, f]) => [k, digest(f)]))));
`,
  );
  write("catalog.schema.json", '{"type": "object"}\n');
  write(
    "fleet.json",
    '{"why":["t"],"apps":{},"roles":{},"env":{},"stores":{},"permissions":{},"providers":{}}\n',
  );
  return {
    root,
    write,
    json,
    edit: (rel, change) => {
      const value = JSON.parse(NodeFS.readFileSync(NodePath.join(root, rel), "utf8"));
      change(value);
      json(rel, value);
    },
    base: (message) => {
      git(root, ["add", "-A"]);
      git(root, ["commit", "-qm", message]);
      git(root, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
      git(root, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
    },
    restore: () => {
      git(root, ["checkout", "-q", "--", "."]);
      git(root, ["clean", "-qfd"]);
    },
  };
}

const act = (testID: string, platform?: string) => ({
  testID,
  ...(platform ? { platform } : {}),
  level: "journey",
  interaction: "tap",
  oracle: `visible: ${testID}-card`,
});

/** The original's walks fixture: three walks and a standalone action, proved by evidence. */
function walksRepo(): Repo {
  const r = repo({ "a:one": "one", "a:two": "two", "a:three": "three" });
  r.json(
    "playbook.json",
    declaration({
      actions: {
        file: "catalog.json",
        walks: "walks.json",
        closure: "node closure.mjs",
        evidence: { run: "node evidence.mjs", tests: "^tests/" },
      },
      intent: { contracts: { actions: "catalog.json" } },
    }),
  );
  r.json("catalog.json", {
    actions: { "a:one": act("one"), "a:two": act("two"), "a:three": act("three") },
  });
  r.json("walks.json", {
    walks: [
      { name: "w-core", actions: ["a:one"], core: true, maxSeconds: 30 },
      { name: "w-two", actions: ["a:two", "a:one"], core: false, maxSeconds: 30 },
      { name: "w-three", actions: ["a:one"], core: false, maxSeconds: 30 },
    ],
    standalone: { "a:three": "its retry shows only after a forced stream failure" },
  });
  r.base("base");
  return r;
}

/** The original's per-platform fixture: web and shared by the merge gate, mobile by evidence, one device action. */
function perPlatformRepo(): Repo {
  const r = repo({ "w:one": "w1", "s:one": "s1", "m:one": "m1", "w:airplay": "ap" });
  r.json(
    "playbook.json",
    declaration({
      actions: {
        file: "catalog.json",
        walks: "walks.json",
        closure: "node closure.mjs",
        measuredBy: { web: "merge-gate", shared: "merge-gate", mobile: "evidence" },
        evidence: { run: "node evidence.mjs", tests: "^tests/" },
      },
      intent: { contracts: { actions: "catalog.json" } },
    }),
  );
  r.json("catalog.json", {
    actions: {
      "w:one": act("w1", "web"),
      "s:one": act("s1", "shared"),
      "m:one": act("m1", "mobile"),
      "w:airplay": act("ap", "web"),
    },
  });
  r.json("walks.json", {
    walks: [
      { name: "web-core", actions: ["w:one", "s:one"], core: true, maxSeconds: 30 },
      { name: "mob-flow", actions: ["m:one"], core: false, maxSeconds: 60 },
    ],
    device: { "w:airplay": "needs an AirPlay target that headless CI lacks" },
    by: "walks/run.mjs",
  });
  r.write(".tree-guard.conf", "ship_merge_gate=bash scripts/gate.sh\nship_pass_record=merge\n");
  r.write("scripts/gate.sh", "node walks/run.mjs\n");
  r.write("walks/run.mjs", "\n");
  r.base("base");
  return r;
}

describe("playbook actions required", () => {
  it("requires the core walk and the walks holding an action whose closure changed, not the others", () => {
    const r = walksRepo();
    const clean = playbook(r.root, ["actions", "required", "--base", "origin/main"]);
    expect(clean).toEqual({ code: 0, out: "w-core\n", err: "w-core: core\n" });
    r.write("src/two.js", "export const two = 2;\n");
    const run = playbook(r.root, ["actions", "required", "--base", "origin/main"]);
    expect(run.code).toBe(0);
    expect(names(run)).toEqual(["w-core", "w-two"]);
    expect(run.err).toBe("w-core: core\nw-two: the closure of a:two changed\n");
    r.restore();
    r.write("src/three.js", "export const three = 3;\n");
    expect(playbook(r.root, ["actions", "required", "--base", "origin/main"]).err).toBe(
      "w-core: core\nstandalone:a:three: its closure changed\n",
    );
  });

  it("names a changed or new walk, a changed standalone entry, and every walk when the closure command changes", () => {
    const r = walksRepo();
    r.edit("walks.json", (w) => {
      w.walks[2].maxSeconds = 40;
      w.walks.push({ name: "w-four", actions: ["a:two"], core: false, maxSeconds: 5 });
      w.standalone["a:three"] = "its retry needs a refused stream first";
    });
    expect(playbook(r.root, ["actions", "required", "--base", "origin/main"])).toEqual({
      code: 0,
      out: "w-core\nw-three\nw-four\nstandalone:a:three\n",
      err: "w-core: core\nw-three: its declaration changed\nw-four: a new walk\nstandalone:a:three: its entry changed\n",
    });
    r.restore();
    r.edit("playbook.json", (p) => {
      p.contracts.actions.closure = "node ./closure.mjs";
    });
    const all = playbook(r.root, ["actions", "required", "--base", "origin/main"]);
    const why =
      "every walk is required: contracts.actions.closure changed, so no earlier proof holds";
    expect(all).toEqual({
      code: 0,
      out: "w-core\nw-two\nw-three\nstandalone:a:three\n",
      err: `w-core: core; ${why}\nw-two: ${why}\nw-three: ${why}\nstandalone:a:three: ${why}\n`,
    });
  });

  it("requires every walk, saying why, when the closure cannot run at the base", () => {
    const r = walksRepo();
    r.edit("playbook.json", (p) => {
      p.contracts.actions.closure = "node closure.mjs || exit 3";
    });
    r.write("closure.mjs", 'console.error("closure: no toolchain here"); process.exit(4);\n');
    r.base("a base whose closure fails");
    r.write(
      "closure.mjs",
      `console.log(JSON.stringify({"a:one": "1", "a:two": "2", "a:three": "3"}));\n`,
    );
    const sha = git(r.root, ["rev-parse", "HEAD"]).slice(0, 12);
    const run = playbook(r.root, ["actions", "required", "--base", "origin/main"]);
    const why = `every walk is required: actions/closure: \`node closure.mjs || exit 3\` exited 3: closure: no toolchain here at the base ${sha}`;
    expect(run).toEqual({
      code: 0,
      out: "w-core\nw-two\nw-three\nstandalone:a:three\n",
      err: `w-core: core; ${why}\nw-two: ${why}\nw-three: ${why}\nstandalone:a:three: ${why}\n`,
    });
  });

  it("splits per-platform walks by mode: merge-gate by default, evidence and all on request; device never", () => {
    const r = perPlatformRepo();
    r.write("src/m1.js", "export const m1 = 2;\n");
    const gate = playbook(r.root, ["actions", "required", "--base", "origin/main"]);
    const ev = playbook(r.root, [
      "actions",
      "required",
      "--base",
      "origin/main",
      "--mode",
      "evidence",
    ]);
    const all = playbook(r.root, ["actions", "required", "--base", "origin/main", "--mode", "all"]);
    expect([gate.code, ev.code, all.code]).toEqual([0, 0, 0]);
    expect(names(gate)).toEqual(["web-core"]);
    expect(names(ev)).toEqual(["mob-flow"]);
    expect(names(all)).toEqual(["web-core", "mob-flow"]);
    expect(ev.err).toBe("mob-flow: the closure of m:one changed\n");
  });

  it("names actions that move from evidence to merge-gate as entered merge-gate", () => {
    const r = perPlatformRepo();
    r.edit("playbook.json", (p) => {
      p.contracts.actions.measuredBy.mobile = "merge-gate";
    });
    const run = playbook(r.root, ["actions", "required", "--base", "origin/main"]);
    expect(run).toEqual({
      code: 0,
      out: "web-core\nmob-flow\n",
      err: "web-core: core\nmob-flow: m:one entered merge-gate\n",
    });
  });

  it("refuses a merge-gate walks file that names no harness, as the actions check does", () => {
    const r = repo({ "w:one": "w1", "m:one": "m1" });
    r.json(
      "playbook.json",
      declaration({
        actions: {
          file: "catalog.json",
          walks: "walks.json",
          closure: "node closure.mjs",
          measuredBy: { web: "evidence", mobile: "evidence" },
          evidence: { run: "node evidence.mjs", tests: "^tests/" },
        },
        intent: { contracts: { actions: "catalog.json" } },
      }),
    );
    r.json("catalog.json", {
      actions: { "w:one": act("w1", "web"), "m:one": act("m1", "mobile") },
    });
    r.json("walks.json", {
      walks: [
        { name: "web-core", actions: ["w:one"], core: true, maxSeconds: 30 },
        { name: "mob-flow", actions: ["m:one"], core: false, maxSeconds: 60 },
      ],
    });
    r.base("base");
    r.edit("playbook.json", (p) => {
      p.contracts.actions.measuredBy.web = "merge-gate";
    });
    expect(playbook(r.root, ["actions", "required", "--base", "origin/main"])).toEqual({
      code: 1,
      out: "",
      err: 'playbook actions required: the check refuses walks.json: actions/walks-settings: contracts.actions.measuredBy uses merge-gate, but walks.json names no harness: set "by" to the walk harness the merge gate runs\n',
    });
  });

  it("refuses what it cannot decide: static rule failures, a bad declaration, no walks, an unknown base", () => {
    const r = walksRepo();
    r.edit("walks.json", (w) => {
      w.walks[1].actions = ["a:one", "a:ghost"];
      w.standalone["a:three"] = " ";
    });
    expect(playbook(r.root, ["actions", "required", "--base", "origin/main"]).err).toBe(
      "playbook actions required: the check refuses walks.json: actions/walk-unknown-action: walk w-two names a:ghost, which is not in catalog.json: catalog it or remove it from the walk; actions/standalone-reason: standalone a:three gives no reason: say which fault its test sets up first; actions/walk-uncovered: a:two is in no walk of walks.json and is not standalone or device: add it to the walk that reaches it, or mark it standalone or device with the reason\n",
    );
    r.restore();
    r.write("playbook.json", '{"contracts": {"actions": {"file": "a"}, "actions": {}}}\n');
    expect(playbook(r.root, ["actions", "required", "--base", "origin/main"])).toEqual({
      code: 1,
      out: "",
      err: "playbook actions required: playbook.json is invalid: playbook.json is not valid JSON: duplicate key 'actions'\n",
    });
    r.write("playbook.json", '{"contracts": {"actions": {"file": "a",}}}\n');
    expect(playbook(r.root, ["actions", "required", "--base", "origin/main"]).err).toBe(
      "playbook actions required: playbook.json is invalid: playbook.json is not valid JSON: Illegal trailing comma before end of object: line 1 column 39 (char 38)\n",
    );
    r.json(
      "playbook.json",
      declaration({ actions: { file: "catalog.json", measuredBy: { Web: 3 }, extra: 1 } }),
    );
    expect(playbook(r.root, ["actions", "required", "--base", "origin/main"]).err).toBe(
      "playbook actions required: playbook.json is invalid: contracts.actions: unknown key 'extra' (allowed: file, baseline, source, ledger, walk_baseline, held_back, chokepoint, floors, evidence, walks, closure, measuredBy); contracts.actions.measuredBy.Web: 'Web' does not match ^[a-z][a-z0-9-]*$; contracts.actions.measuredBy.Web: 3 is not one of: merge-gate, evidence\n",
    );
    r.json("playbook.json", declaration({ actions: { file: "catalog.json" } }));
    expect(playbook(r.root, ["actions", "required", "--base", "origin/main"]).err).toBe(
      "playbook actions required: playbook.json declares no contracts.actions.walks\n",
    );
    r.restore();
    expect(playbook(r.root, ["actions", "required", "--base", "no-such-ref"])).toEqual({
      code: 1,
      out: "",
      err: "playbook actions required: no-such-ref is not a commit here (git fetch origin)\n",
    });
    git(r.root, ["symbolic-ref", "--delete", "refs/remotes/origin/HEAD"]);
    expect(playbook(r.root, ["actions", "required"]).err).toBe(
      "playbook actions required: no base to compare against: pass --base REF, or git fetch origin\n",
    );
  });

  it("reports a closure that fails on the tree", () => {
    const r = walksRepo();
    r.write("closure.mjs", 'console.log("[1, 2]");\n');
    expect(playbook(r.root, ["actions", "required", "--base", "origin/main"]).err).toBe(
      'playbook actions required: actions/closure: `node closure.mjs` did not print {"<action id>": "<digest>"} on the tree\n',
    );
    r.write("closure.mjs", 'console.log("{\\"a:one\\": ");\n');
    expect(playbook(r.root, ["actions", "required", "--base", "origin/main"]).err).toBe(
      "playbook actions required: actions/closure: `node closure.mjs` printed no JSON (Expecting value: line 2 column 1 (char 11)) on the tree\n",
    );
  });

  it("parses its arguments as the original's argparse does", () => {
    const dir = makeTempDir("pb-actions-args-");
    const usage =
      "usage: playbook actions required [-h] [--base BASE]\n                                 [--mode {merge-gate,evidence,all}]\n";
    const help = playbook(dir, ["actions", "required", "--help"]);
    expect(help.code).toBe(0);
    expect(help.out).toContain("  --base BASE           the base ref (default: the gate's base)\n");
    expect(playbook(dir, ["actions"])).toEqual({
      code: 2,
      out: "",
      err: "usage: playbook actions [-h] {required} ...\nplaybook actions: error: the following arguments are required: actions_cmd\n",
    });
    expect(playbook(dir, ["actions", "walks"]).err).toBe(
      "usage: playbook actions [-h] {required} ...\nplaybook actions: error: argument actions_cmd: invalid choice: 'walks' (choose from required)\n",
    );
    expect(playbook(dir, ["actions", "required", "--mode", "bogus"]).err).toBe(
      `${usage}playbook actions required: error: argument --mode: invalid choice: 'bogus' (choose from merge-gate, evidence, all)\n`,
    );
    expect(playbook(dir, ["actions", "required", "--ba"]).err).toBe(
      `${usage}playbook actions required: error: argument --base: expected one argument\n`,
    );
    const extra = playbook(dir, ["actions", "required", "--foo", "x"]);
    expect(extra.code).toBe(2);
    expect(extra.err).toMatch(
      /^usage: playbook \[-h\] \[-C DIR\]\n.*\nplaybook: error: unrecognized arguments: --foo x\n$/s,
    );
    expect(playbook(dir, ["actions", "required", "--m=all", "--b", "HEAD"]).err).toBe(
      "playbook actions required: playbook.json is invalid: playbook.json is missing\n",
    );
    expect(
      playbook(dir, ["-C", NodePath.join(dir, "missing"), "actions", "required"], false),
    ).toEqual({
      code: 2,
      out: "",
      err: `playbook: ${NodePath.join(dir, "missing")} is not a directory\n`,
    });
  });

  it("takes a value that starts like a negative number, and names -C DIR as typed", () => {
    const dir = makeTempDir("pb-actions-neg-");
    expect(playbook(dir, ["actions", "required", "--base", "-1x"]).err).toBe(
      "playbook actions required: playbook.json is invalid: playbook.json is missing\n",
    );
    expect(playbook(dir, ["-C", "no-such-dir", "actions", "required"], false)).toEqual({
      code: 2,
      out: "",
      err: "playbook: no-such-dir is not a directory\n",
    });
  });

  it("reads the gate's base from its environment, and a base catalog that is not UTF-8 as empty", () => {
    const r = perPlatformRepo();
    const base = git(r.root, ["rev-parse", "HEAD"]);
    NodeFS.writeFileSync(NodePath.join(r.root, "catalog.json"), Buffer.from([0x7b, 0xff, 0x7d]));
    r.base("a catalog that is not UTF-8");
    r.json("catalog.json", {
      actions: {
        "w:one": act("w1", "web"),
        "s:one": act("s1", "shared"),
        "m:one": act("m1", "mobile"),
        "w:airplay": act("ap", "web"),
      },
    });
    const run = playbook(r.root, ["actions", "required"], true, {
      SHIP_QUEUE_BASE_SHA: git(r.root, ["rev-parse", "HEAD"]),
    });
    expect(run).toEqual({
      code: 0,
      out: "web-core\n",
      err: "web-core: core; s:one, w:one entered merge-gate\n",
    });
    expect(base).not.toBe("");
  });

  it("names a closure that cannot start as Python does, and keeps a step limit past setTimeout's", () => {
    const r = walksRepo();
    const tools = makeTempDir("pb-actions-tools-");
    for (const tool of ["git", "python3"]) {
      const found = NodeChildProcess.spawnSync("sh", ["-c", `command -v ${tool}`], {
        encoding: "utf8",
      }).stdout.trim();
      if (found) NodeFS.symlinkSync(found, NodePath.join(tools, tool));
    }
    const noBash = playbook(r.root, ["actions", "required", "--base", "origin/main"], true, {
      PATH: tools,
    });
    expect(noBash.err).toBe(
      "playbook actions required: actions/closure: `node closure.mjs` did not run: it could not start: [Errno 2] No such file or directory: 'bash' on the tree\n",
    );
    // The port alone: the original fails with a traceback on a limit this long.
    const long = spawn(
      process.execPath,
      [BIN, "-C", r.root, "actions", "required", "--base", "origin/main"],
      r.root,
      {
        PLAYBOOK_STEP_SECONDS: "3000000",
      },
    );
    expect(long).toEqual({ code: 0, out: "w-core\n", err: "w-core: core\n" });
  });

  it("refuses an evidence regex as Python's re does: look-behind width, \\z, \\N{...}", () => {
    const r = walksRepo();
    const refusal = (tests: string) => {
      r.edit("playbook.json", (p) => {
        p.contracts.actions.evidence.tests = tests;
      });
      return playbook(r.root, ["actions", "required", "--base", "origin/main"]).err;
    };
    const lead =
      "playbook actions required: playbook.json is invalid: contracts.actions.evidence.tests:";
    expect(refusal("(?<=a+)b")).toBe(
      `${lead} '(?<=a+)b' is not a valid regex (look-behind requires fixed-width pattern)\n`,
    );
    expect(refusal("^tests/.*\\z")).toBe(
      `${lead} '^tests/.*\\\\z' is not a regex Python and bash read the same: \\z is not an ERE escape (write a bracket class such as [0-9])\n`,
    );
    expect(refusal("\\N{LATIN SMALL LETTER A}")).toBe(
      `${lead} '\\\\N{LATIN SMALL LETTER A}' is not a regex Python and bash read the same: \\N is not an ERE escape (write a bracket class such as [0-9])\n`,
    );
    expect(refusal("\\N{not a name!}")).toBe(
      `${lead} '\\\\N{not a name!}' is not a valid regex (undefined character name 'not a name!' at position 0)\n`,
    );
  });
});
