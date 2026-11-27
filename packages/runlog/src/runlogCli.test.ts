// @effect-diagnostics nodeBuiltinImport:off - CLI integration tests drive the real bin with node:child_process.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { parseArgs } from "./cli.ts";
import { NAME_MAX, shortName, utcStamp } from "./runlogPaths.ts";
import { readLog } from "./runlogProcess.ts";
import { report } from "./runlogSummary.ts";

const BIN = NodeURL.fileURLToPath(new URL("./bin.ts", import.meta.url));
const has = (tool: string) => NodeChildProcess.spawnSync("which", [tool]).status === 0;

let tmp: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  tmp = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "runlog-test-")));
  env = { ...process.env, SHIP_QUEUE_DATA_ROOT: tmp, RUNLOG_ROOT: NodePath.join(tmp, "unused") };
});

afterEach(() => {
  NodeFS.rmSync(tmp, { recursive: true, force: true });
});

interface Run {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function runlog(args: string[], cwd = tmp, extraEnv: NodeJS.ProcessEnv = {}): Run {
  const res = NodeChildProcess.spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    env: { ...env, ...extraEnv },
    encoding: "utf8",
    timeout: 300_000,
  });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

function logOf(r: { stdout: string }): string {
  const line = r.stdout.split("\n").find((s) => s.startsWith("log: ")) ?? "";
  return line.slice(5);
}

/** Waits (in a shell, not a timer) until a pid is gone; true when it went. */
function gone(pid: number): boolean {
  const script = `for i in $(seq 1 80); do kill -0 ${pid} 2>/dev/null || exit 0; sleep 0.05; done; exit 1`;
  return NodeChildProcess.spawnSync("bash", ["-c", script]).status === 0;
}

/** Spawns runlog and blocks on a FIFO until the command writes a pid into it. */
function startWithPid(script: (fifo: string) => string): {
  child: NodeChildProcess.ChildProcess;
  pid: number;
  done: Promise<{ code: number | null; stdout: string }>;
} {
  const fifo = NodePath.join(tmp, "pid.fifo");
  NodeChildProcess.execFileSync("mkfifo", [fifo]);
  const child = NodeChildProcess.spawn(process.execPath, [BIN, "--", "bash", "-c", script(fifo)], {
    cwd: tmp,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  const done = new Promise<{ code: number | null; stdout: string }>((resolve) => {
    child.on("close", (code) => resolve({ code, stdout }));
  });
  const pid = Number.parseInt(NodeFS.readFileSync(fifo, "utf8").trim(), 10);
  return { child, pid, done };
}

describe("runlog CLI", () => {
  it("keeps the exit code, writes the log and shows an unknown output's tail", () => {
    const script = NodePath.join(tmp, "noisy.sh");
    NodeFS.writeFileSync(
      script,
      "for i in $(seq 1 100); do echo line $i; done\necho oops >&2\nexit 3\n",
    );
    const r = runlog(["--name", "my run", "--", "bash", script]);
    expect(r.status).toBe(3);
    const log = logOf(r);
    // Not a git repository: the directory's name; the name made path-safe.
    expect(NodePath.dirname(log)).toBe(NodePath.join(tmp, "runs", NodePath.basename(tmp)));
    expect(NodePath.basename(log)).toMatch(/^my-run-\d{8}T\d{6}Z\.log$/);
    const text = NodeFS.readFileSync(log, "utf8");
    expect(text).toContain("line 57\n");
    expect(text.endsWith("oops\n")).toBe(true);
    const out = r.stdout.trimEnd().split("\n");
    expect(out[0]).toMatch(/^runlog: FAIL exit 3 in [\d.]+s$/);
    expect(out[2]).toBe("output not recognised; its last lines:");
    expect(out.slice(3)).toEqual([
      ...Array.from({ length: 11 }, (_, i) => `  line ${i + 90}`),
      "  oops",
    ]);
    expect(out).toHaveLength(15);
    expect(NodeFS.existsSync(NodePath.join(tmp, "unused"))).toBe(false);
  });

  it("names the log directory by the repository, from a linked worktree too", () => {
    const repo = NodePath.join(tmp, "myrepo");
    const wt = NodePath.join(tmp, "elsewhere", "issue-9");
    const git = (...args: string[]) => NodeChildProcess.execFileSync("git", args, { env });
    git("init", "-q", "-b", "main", repo);
    git(
      "-C",
      repo,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "x",
    );
    git("-C", repo, "worktree", "add", "-q", "-b", "issue-9", wt);
    const r = runlog(["--", "true"], wt);
    expect(r.status).toBe(0);
    expect(NodePath.basename(NodePath.dirname(logOf(r)))).toBe("myrepo");
    expect(NodePath.basename(logOf(r))).toMatch(/^true-\d{8}T\d{6}Z\.log$/);
    expect(runlog(["list"], wt).stdout.trim()).toBe(logOf(r));
  });

  it("reports a signal as 128 plus its number", () => {
    expect(runlog(["--", "bash", "-c", "kill -TERM $$"]).status).toBe(143);
  });

  it("forwards a TERM to the command", async () => {
    const { child, pid, done } = startWithPid((fifo) => `echo $$ > ${fifo}; exec sleep 60`);
    child.kill("SIGTERM");
    const { code, stdout } = await done;
    expect(code).toBe(143);
    expect(stdout.startsWith("runlog: FAIL exit 143")).toBe(true);
    expect(gone(pid)).toBe(true);
  });

  it("forwards a TERM to grandchildren the runner does not signal", async () => {
    // bash waiting on a background job dies on TERM and leaves the job
    // running: only a signal to the whole process group stops it.
    const { child, pid, done } = startWithPid((fifo) => `sleep 60 & echo $! > ${fifo}; wait`);
    child.kill("SIGTERM");
    const { code } = await done;
    expect(code).toBe(143);
    const stopped = gone(pid);
    if (!stopped) process.kill(pid, "SIGKILL");
    expect(stopped).toBe(true);
  });

  it("gives a long command a short, distinct name", () => {
    const script = `echo ${"x".repeat(400)}`;
    const r = runlog(["--", "bash", "-c", script]);
    expect(r.status).toBe(0);
    const name = NodePath.basename(logOf(r));
    expect(name).toMatch(/^bash-echo-x+-[0-9a-f]{8}-\d{8}T\d{6}Z\.log$/);
    expect(name.replace(/-\d{8}T\d{6}Z\.log$/, "").length).toBeLessThanOrEqual(NAME_MAX);
    const other = NodePath.basename(logOf(runlog(["--", "bash", "-c", `${script}y`])));
    expect(name.slice(0, NAME_MAX)).not.toBe(other.slice(0, NAME_MAX));
  });

  it("keeps each run's own log when runs start in the same second", async () => {
    const runs = Array.from(
      { length: 6 },
      (_, i) =>
        new Promise<string>((resolve) => {
          const child = NodeChildProcess.spawn(
            process.execPath,
            [BIN, "--name", "same", "--", "echo", String(i)],
            { cwd: tmp, env, stdio: ["ignore", "pipe", "ignore"] },
          );
          let out = "";
          child.stdout.on("data", (c: Buffer) => {
            out += c.toString();
          });
          child.on("close", () => resolve(logOf({ stdout: out })));
        }),
    );
    const logs = await Promise.all(runs);
    expect(new Set(logs).size).toBe(6);
    expect(logs.map((l) => NodeFS.readFileSync(l, "utf8")).sort()).toEqual(
      Array.from({ length: 6 }, (_, i) => `${i}\n`),
    );
  });

  it("fails an exit of 0 that has failed tests", () => {
    const r = runlog([
      "--",
      "bash",
      "-c",
      "echo 'ok   one'; echo 'FAIL two'; echo 'x: 1 passed, 1 failed'",
    ]);
    expect(r.status).toBe(0);
    expect(r.stdout.split("\n")[0]).toMatch(
      /^runlog: FAIL \(exit 0, 1 failed\) in [\d.]+s \(bash-test\)$/,
    );
  });

  it("reports a command that cannot start as 127", () => {
    const r = runlog(["--", "no-such-program-for-runlog"]);
    expect(r.status).toBe(127);
    expect(NodeFS.readFileSync(logOf(r), "utf8")).toContain(
      "runlog: cannot run no-such-program-for-runlog",
    );
  });

  it("summarises a large log from its tail", () => {
    const log = NodePath.join(tmp, "big.log");
    const body = Array.from({ length: 200_000 }, (_, i) => `noise line ${i}\n`).join("");
    NodeFS.writeFileSync(log, `${body}ok   last\nx: 1 passed, 0 failed\n`);
    const { text, lines, cut } = readLog(log, 1 << 16);
    expect(lines).toBe(200_002);
    expect(cut).toBe(true);
    expect(text.length).toBeLessThanOrEqual(1 << 16);
    expect(text.split("\n")[0]).toMatch(/^noise line \d+$/);
    expect(report({ rc: 0, seconds: 1, logPath: log, text })[1]).toBe("tests: 1 passed, 0 failed");
  });

  it("summarises a log written earlier", () => {
    const log = NodePath.join(tmp, "earlier.log");
    NodeFS.writeFileSync(log, "ok   one\nFAIL two\nx: 1 passed, 1 failed\n");
    const r = runlog(["summarize", log, "--exit", "1"]);
    expect(r.status).toBe(1);
    expect(r.stdout.split("\n").slice(0, 4)).toEqual([
      "runlog: FAIL exit 1 (bash-test)",
      "tests: 1 passed, 1 failed",
      "failing:",
      "  two",
    ]);
    NodeFS.writeFileSync(log, "ok   one\nx: 1 passed, 0 failed\n");
    expect(runlog(["summarize", log]).status).toBe(0);
  });

  it("refuses bad usage with exit 2 and prints help with exit 0", () => {
    expect(runlog(["echo", "x"]).status).toBe(2);
    expect(runlog(["--"]).status).toBe(2);
    expect(runlog(["summarize"]).status).toBe(2);
    expect(runlog(["list", "zero"]).status).toBe(2);
    const help = runlog(["--help"]);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("runlog [--name NAME] -- COMMAND [ARGS...]");
  });

  it.skipIf(!has("node"))(
    "reads node --test in both reporters, naming the innermost failure",
    () => {
      NodeFS.writeFileSync(
        NodePath.join(tmp, "t.test.mjs"),
        "import test from 'node:test';\nimport assert from 'node:assert';\n" +
          "test('adds', () => assert.equal(1 + 1, 2));\n" +
          "test('group', async (t) => {\n  await t.test('inner breaks', () => assert.equal(1, 2));\n});\n",
      );
      for (const reporter of ["tap", "spec"]) {
        const r = runlog(["--", "node", "--test", `--test-reporter=${reporter}`, "t.test.mjs"]);
        const out = r.stdout.split("\n");
        expect(r.status, reporter).toBe(1);
        expect(out.slice(1, 4), reporter).toEqual([
          "tests: 1 passed, 2 failed",
          "failing:",
          "  inner breaks",
        ]);
        expect(
          out.some((s) => s.includes("1 == 2")),
          reporter,
        ).toBe(true);
        expect(NodePath.basename(logOf(r))).toMatch(/^node-t\.test\.mjs-/);
      }
    },
  );

  it("reads a live bash suite", () => {
    const suite = NodePath.join(tmp, "x.test.sh");
    NodeFS.writeFileSync(
      suite,
      'pass=0; fail=0\ncheck() { local name=$1; shift; if "$@"; then pass=$((pass + 1)); echo "ok   $name"; ' +
        'else fail=$((fail + 1)); echo "FAIL $name"; fi; }\n' +
        'check "true is true" true\ncheck "false is true" false\n' +
        'echo "x: $pass passed, $fail failed"\n[ "$fail" = 0 ]\n',
    );
    const r = runlog(["--", "bash", suite]);
    expect(r.status).toBe(1);
    expect(r.stdout.split("\n").slice(1, 4)).toEqual([
      "tests: 1 passed, 1 failed",
      "failing:",
      "  false is true",
    ]);
  });

  it.skipIf(!has("python3"))("reads live Python unittest", () => {
    NodeFS.writeFileSync(
      NodePath.join(tmp, "test_u.py"),
      "import unittest\nclass A(unittest.TestCase):\n    def test_ok(self): pass\n" +
        "    def test_bad(self): self.assertEqual(1, 2)\n" +
        "    @unittest.skip('x')\n    def test_skip(self): pass\nunittest.main()\n",
    );
    const r = runlog(["--", "python3", "test_u.py"]);
    const out = r.stdout.trimEnd().split("\n");
    expect(r.status).toBe(1);
    expect(out.slice(1, 4)).toEqual([
      "tests: 1 passed, 1 failed, 1 skipped",
      "failing:",
      "  __main__.A.test_bad",
    ]);
    expect(out.at(-1)).toBe("  AssertionError: 1 != 2");
  });

  it.skipIf(!has("go"))("reads live go test with and without -v", () => {
    const mod = NodePath.join(tmp, "gomod");
    NodeFS.mkdirSync(mod);
    NodeFS.writeFileSync(NodePath.join(mod, "go.mod"), "module example.com/m\n\ngo 1.21\n");
    NodeFS.writeFileSync(
      NodePath.join(mod, "m_test.go"),
      'package m\n\nimport "testing"\n\nfunc TestGood(t *testing.T) {}\n\n' +
        'func TestBad(t *testing.T) {\n\tt.Log("context")\n\tt.Fatalf("want 2, got %d", 3)\n}\n',
    );
    const goEnv = { GOFLAGS: "-count=1", GOTOOLCHAIN: "local" };
    let r = runlog(["--", "go", "test", "-v", "./..."], mod, goEnv);
    let out = r.stdout.split("\n");
    expect(r.status).toBe(1);
    expect(out[0]).toMatch(/^runlog: FAIL exit 1 in [\d.]+s \(go-test\)$/);
    expect(out.slice(1, 4)).toEqual(["tests: 1 passed, 1 failed", "failing:", "  TestBad"]);
    expect(out.some((s) => s.includes("want 2, got 3"))).toBe(true);
    r = runlog(["--", "go", "test", "./..."], mod, goEnv);
    out = r.stdout.split("\n");
    expect(out.slice(1, 4)).toEqual(["packages: 0 passed, 1 failed", "failing:", "  TestBad"]);
  });

  it.skipIf(!has("cargo"))("reads live cargo test and a compile failure", () => {
    const crate = NodePath.join(tmp, "crate");
    NodeFS.mkdirSync(NodePath.join(crate, "src"), { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(crate, "Cargo.toml"),
      '[package]\nname = "c"\nversion = "0.1.0"\nedition = "2021"\n',
    );
    const lib = NodePath.join(crate, "src", "lib.rs");
    NodeFS.writeFileSync(
      lib,
      '#[test] fn good() {}\n#[test] fn bad() { assert_eq!(1, 2, "one is two"); }\n#[test] #[ignore] fn later() {}\n',
    );
    const cargoEnv = { CARGO_TARGET_DIR: NodePath.join(tmp, "target"), CARGO_TERM_COLOR: "never" };
    const args = ["--", "cargo", "test", "--offline", "--lib"];
    let r = runlog(args, crate, cargoEnv);
    let out = r.stdout.split("\n");
    expect(r.status).toBe(101);
    expect(out.slice(1, 4)).toEqual(["tests: 1 passed, 1 failed, 1 skipped", "failing:", "  bad"]);
    expect(out).toContain("  ---- bad stdout ----");
    NodeFS.writeFileSync(lib, '#[test] fn good() { let x: u8 = "no"; }\n');
    r = runlog(args, crate, cargoEnv);
    out = r.stdout.split("\n");
    expect(r.status).toBe(101);
    expect(out.slice(2, 4)).toEqual(["failing:", "  could not compile c (lib test)"]);
    expect(out[out.indexOf("first failure:") + 1]).toBe("  error[E0308]: mismatched types");
  });
});

describe("runlog log root", () => {
  function sandbox(): { home: string; source: string; repo: string; env: NodeJS.ProcessEnv } {
    const home = NodePath.join(tmp, "home");
    const source = NodePath.join(home, "source root");
    const repo = NodePath.join(source, "sample");
    NodeFS.mkdirSync(repo, { recursive: true });
    NodeChildProcess.execFileSync("git", ["init", "-q", "-b", "main", repo]);
    const clean = Object.fromEntries(
      Object.entries(process.env).filter(
        ([k]) => !/^(DEVTOOLS_|HOST_GUARDS_|SHIP_QUEUE_|RUNLOG_)/.test(k),
      ),
    );
    return {
      home,
      source,
      repo,
      env: {
        ...clean,
        HOME: home,
        XDG_CONFIG_HOME: NodePath.join(home, ".config"),
        RUNLOG_ROOT: NodePath.join(tmp, "unexpected"),
      },
    };
  }

  function configure(home: string, values: Record<string, unknown>): void {
    const file = NodePath.join(home, ".config/devtools/storage.json");
    NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
    NodeFS.writeFileSync(file, JSON.stringify(values));
  }

  function runIn(box: ReturnType<typeof sandbox>): string {
    const res = NodeChildProcess.spawnSync(
      process.execPath,
      [BIN, "--", "git", "rev-parse", "--git-dir"],
      {
        cwd: box.repo,
        env: box.env,
        encoding: "utf8",
      },
    );
    expect(res.status, res.stderr).toBe(0);
    expect(NodeFS.existsSync(NodePath.join(tmp, "unexpected"))).toBe(false);
    return NodePath.dirname(NodePath.dirname(logOf(res)));
  }

  it("uses the configured data root", () => {
    const box = sandbox();
    configure(box.home, {
      source_root: box.source,
      data_root: NodePath.join(box.home, "Dev-data"),
    });
    expect(runIn(box)).toBe(NodePath.join(box.home, "Dev-data", "runs"));
  });

  it("uses the source root on a single-drive host", () => {
    const box = sandbox();
    configure(box.home, { source_root: box.source, data_root: null });
    expect(runIn(box)).toBe(NodePath.join(box.source, "runs"));
  });

  it("uses ~/Dev on an unconfigured host", () => {
    expect(runIn(sandbox())).toMatch(/\/home\/Dev\/runs$/);
  });

  it("reads host-guards.conf when there is no storage.json", () => {
    const box = sandbox();
    const conf = NodePath.join(box.home, ".local/lib/host-guards.conf");
    NodeFS.mkdirSync(NodePath.dirname(conf), { recursive: true });
    NodeFS.writeFileSync(conf, `source_root=${box.source}\ndata_root=${box.home}/Dev-data\n`);
    expect(runIn(box)).toBe(NodePath.join(box.home, "Dev-data", "runs"));
  });

  it("takes the queue root first and expands ~", () => {
    const box = sandbox();
    configure(box.home, {
      source_root: box.source,
      data_root: NodePath.join(box.home, "other data"),
    });
    box.env.SHIP_QUEUE_DATA_ROOT = "~/Dev-data";
    expect(runIn(box)).toBe(NodePath.join(box.home, "Dev-data", "runs"));
    expect(NodeFS.existsSync(NodePath.join(box.home, "other data"))).toBe(false);
  });

  it("refuses a system directory as a root", () => {
    const box = sandbox();
    configure(box.home, { source_root: box.source, data_root: "/usr" });
    const res = NodeChildProcess.spawnSync(process.execPath, [BIN, "--", "true"], {
      cwd: box.repo,
      env: box.env,
      encoding: "utf8",
    });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("refusing dangerous data_root");
  });
});

describe("runlog naming and arguments", () => {
  it("stamps logs in UTC", () => {
    expect(utcStamp(1795753887450)).toBe("20261127T043127Z");
  });

  it("keeps short names and hashes long ones", () => {
    expect(shortName("go test ./...")).toBe("go-test");
    const long = shortName("y".repeat(100));
    expect(long).toHaveLength(NAME_MAX);
    expect(long).toMatch(/^y+-[0-9a-f]{8}$/);
  });

  it("parses --name in both forms", () => {
    expect(parseArgs(["--name=a b", "--", "x"])).toEqual({ kind: "run", name: "a b", cmd: ["x"] });
    expect(parseArgs(["--name", "n", "--", "x", "--y"])).toEqual({
      kind: "run",
      name: "n",
      cmd: ["x", "--y"],
    });
  });
});
