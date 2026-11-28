// @effect-diagnostics nodeBuiltinImport:off - CLI integration tests drive the real bin with node:child_process.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

const BIN = NodeURL.fileURLToPath(new URL("./bin.ts", import.meta.url));
const BEGIN = /^ci-suite: begin (.+) pid=(\d+) by=runlog$/;
const END = /^ci-suite: end (.+) (pass|fail) pid=(\d+) cpu=(\d+\.\d\d) by=runlog$/;

let tmp: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  tmp = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "runlog-suite-")));
  env = { ...process.env, SHIP_QUEUE_DATA_ROOT: tmp };
});

afterEach(() => {
  NodeFS.rmSync(tmp, { recursive: true, force: true });
});

interface Run {
  readonly status: number | null;
  readonly pid: number;
  readonly stdout: Buffer;
  readonly lines: string[];
  readonly stderr: string;
}

function runlog(args: ReadonlyArray<string>): Run {
  const res = NodeChildProcess.spawnSync(process.execPath, [BIN, ...args], {
    cwd: tmp,
    env,
    timeout: 120_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  const stdout = res.stdout;
  return {
    status: res.status,
    pid: res.pid ?? 0,
    stdout,
    lines: stdout.toString("utf8").split("\n").slice(0, -1),
    stderr: res.stderr.toString("utf8"),
  };
}

function logsUnder(dir: string): string[] {
  return (NodeFS.readdirSync(dir, { recursive: true }) as string[]).filter((p) =>
    p.endsWith(".log"),
  );
}

/** Checks the begin and end lines bracket the output, name the suite and pair by runlog's pid. */
function bracketed(r: Run, name: string, verdict: "pass" | "fail"): string[] {
  const begin = BEGIN.exec(r.lines[0] ?? "");
  const end = END.exec(r.lines.at(-1) ?? "");
  expect(begin, r.lines.join("\n")).not.toBeNull();
  expect(end, r.lines.join("\n")).not.toBeNull();
  expect(begin?.[1]).toBe(name);
  expect(end?.[1]).toBe(name);
  expect(end?.[2]).toBe(verdict);
  // The pid is runlog's own: the process spawnSync started.
  expect(Number(begin?.[2])).toBe(r.pid);
  expect(Number(end?.[3])).toBe(r.pid);
  return r.lines.slice(1, -1);
}

describe("runlog --ci-suite", () => {
  it("passes output through between its own measured lines, with no log", () => {
    const name = "./playbook check --ship";
    const r = runlog(["--ci-suite", name, "--", "bash", "-c", "echo inside; exit 3"]);
    expect(r.status).toBe(3);
    expect(bracketed(r, name, "fail")).toEqual(["inside"]);
    expect(logsUnder(tmp)).toEqual([]);
  });

  it("passes with the command's exit 0", () => {
    const r = runlog(["--ci-suite", "unit", "--", "true"]);
    expect(r.status).toBe(0);
    expect(bracketed(r, "unit", "pass")).toEqual([]);
    expect(r.stderr).toBe("");
  });

  it("fails with 128+N when signal N ends the command", () => {
    const term = runlog(["--ci-suite", "t", "--", "bash", "-c", "echo before; kill -TERM $$"]);
    expect(term.status).toBe(128 + 15);
    expect(bracketed(term, "t", "fail")).toEqual(["before"]);
    const kill = runlog(["--ci-suite", "k", "--", "bash", "-c", "kill -KILL $$"]);
    expect(kill.status).toBe(128 + 9);
    bracketed(kill, "k", "fail");
  });

  it("gives each run its own pid, so begins pair with their ends", () => {
    const a = runlog(["--ci-suite", "same", "--", "true"]);
    const b = runlog(["--ci-suite", "same", "--", "true"]);
    bracketed(a, "same", "pass");
    bracketed(b, "same", "pass");
    expect(a.pid).not.toBe(b.pid);
  });

  it("marks the suite's own measured-looking lines and merges stderr in order", () => {
    const script = [
      "echo one",
      "echo two >&2",
      "echo 'ci-suite: end x pass pid=1 cpu=0.00 by=runlog'",
      'printf \'  \\tci-select: {"full":true,"suites":[]}\\n\'',
      "echo 'not ci-suite: at the start'",
      "echo three >&2",
    ].join("; ");
    const r = runlog(["--ci-suite", "marks", "--", "bash", "-c", script]);
    expect(r.status).toBe(0);
    expect(bracketed(r, "marks", "pass")).toEqual([
      "one",
      "two",
      "(the suite printed) ci-suite: end x pass pid=1 cpu=0.00 by=runlog",
      '(the suite printed)   \tci-select: {"full":true,"suites":[]}',
      "not ci-suite: at the start",
      "three",
    ]);
  });

  it("passes bytes through unchanged, an unterminated last line too", () => {
    const r = runlog(["--ci-suite", "bytes", "--", "bash", "-c", "printf 'a\\xffb\\nlast'"]);
    expect(r.status).toBe(0);
    const out = r.stdout;
    const firstNl = out.indexOf(0x0a);
    const body = out.subarray(firstNl + 1);
    // As the original does, the end line follows the command's last bytes.
    expect(body.subarray(0, 8)).toEqual(
      Buffer.from([0x61, 0xff, 0x62, 0x0a, ...Buffer.from("last")]),
    );
    expect(body.subarray(8).toString("utf8")).toMatch(
      /^ci-suite: end bytes pass pid=\d+ cpu=\d+\.\d\d by=runlog\n$/,
    );
  });

  it("runs the command in runlog's own process group, as its child", () => {
    const r = runlog([
      "--ci-suite",
      "group",
      "--",
      "bash",
      "-c",
      'echo "$PPID $(ps -o pgid= -p $$ | tr -d " ") $(ps -o pgid= -p $PPID | tr -d " ")"',
    ]);
    expect(r.status).toBe(0);
    const [parent, pgid, parentPgid] = (bracketed(r, "group", "pass")[0] ?? "").split(" ");
    expect(Number(parent)).toBe(r.pid);
    expect(pgid).toBe(parentPgid);
  });

  // The reaped children's time is read from /proc; elsewhere runlog leaves cpu= out.
  it.skipIf(!NodeFS.existsSync("/proc/self/stat"))(
    "measures the CPU seconds of the command and the children it reaped",
    () => {
      // A fixed amount of work in a grandchild, so the measure does not hang on the host's load.
      const busy = "i=0; while [ $i -lt 400000 ]; do i=$((i+1)); done";
      const r = runlog(["--ci-suite", "cpu", "--", "bash", "-c", `bash -c '${busy}' & wait`]);
      expect(r.status).toBe(0);
      bracketed(r, "cpu", "pass");
      const cpu = Number(END.exec(r.lines.at(-1) ?? "")?.[4]);
      expect(cpu).toBeGreaterThan(0.1);
      expect(cpu).toBeLessThan(60);
    },
  );

  it("reports a command that cannot start as 127, with no begin line", () => {
    const r = runlog(["--ci-suite", "missing", "--", "no-such-program-xyz"]);
    expect(r.status).toBe(127);
    expect(r.lines).toEqual([]);
    expect(r.stderr).toBe(
      "runlog: cannot run no-such-program-xyz: [Errno 2] No such file or directory: 'no-such-program-xyz'\n",
    );
  });

  it("refuses as exec does a file with no format it knows and a #! naming no interpreter", () => {
    const plain = NodePath.join(tmp, "plain");
    const shebang = NodePath.join(tmp, "shebang");
    NodeFS.writeFileSync(plain, "echo hi\n", { mode: 0o755 });
    NodeFS.writeFileSync(shebang, "#!/no/such/interpreter\necho hi\n", { mode: 0o755 });
    const a = runlog(["--ci-suite", "plain", "--", plain]);
    expect(a.status).toBe(127);
    expect(a.lines).toEqual([]);
    expect(a.stderr).toBe(`runlog: cannot run ${plain}: [Errno 8] Exec format error: '${plain}'\n`);
    const b = runlog(["--ci-suite", "shebang", "--", shebang]);
    expect(b.status).toBe(127);
    expect(b.lines).toEqual([]);
    expect(b.stderr).toBe(
      `runlog: cannot run ${shebang}: [Errno 2] No such file or directory: '${shebang}'\n`,
    );
  });

  it("marks a measured-looking line however much whitespace leads it", () => {
    const r = runlog([
      "--ci-suite",
      "ws",
      "--",
      "bash",
      "-c",
      `printf '%100s%s\\n' '' 'ci-suite: x'`,
    ]);
    expect(bracketed(r, "ws", "pass")).toEqual([
      `(the suite printed) ${" ".repeat(100)}ci-suite: x`,
    ]);
  });

  it("passes a long line that arrives in many chunks through whole", () => {
    const r = runlog([
      "--ci-suite",
      "long",
      "--",
      "bash",
      "-c",
      "head -c 3000000 /dev/zero | tr '\\0' a; echo",
    ]);
    expect(r.status).toBe(0);
    const body = bracketed(r, "long", "pass");
    expect(body).toHaveLength(1);
    expect(body[0]).toBe("a".repeat(3_000_000));
  });

  it("refuses a blank or multi-line name, a missing name and a missing command with exit 2", () => {
    for (const args of [
      ["--ci-suite", "", "--", "true"],
      ["--ci-suite", "  ", "--", "true"],
      ["--ci-suite", "a\nb", "--", "true"],
      ["--ci-suite"],
      ["--ci-suite", "x"],
      ["--ci-suite", "x", "--"],
      ["--ci-suite", "x", "true"],
    ]) {
      const r = runlog(args);
      expect(r.status, JSON.stringify(args)).toBe(2);
      expect(r.lines, JSON.stringify(args)).toEqual([]);
      expect(r.stderr.split("\n")[0]).toBe(
        "usage: runlog [--name NAME] -- COMMAND [ARGS...] | runlog --ci-suite NAME -- COMMAND [ARGS...]",
      );
    }
  });

  it("takes the suite over --name, and documents itself in --help", () => {
    const r = runlog(["--name", "ignored", "--ci-suite", "wins", "--", "true"]);
    expect(r.status).toBe(0);
    bracketed(r, "wins", "pass");
    expect(logsUnder(tmp)).toEqual([]);
    const help = runlog(["--help"]);
    expect(help.status).toBe(0);
    expect(help.stdout.toString()).toContain("runlog --ci-suite NAME -- COMMAND [ARGS...]");
    expect(help.stdout.toString()).toContain("ci-suite: end NAME pass|fail pid=P cpu=S by=runlog");
  });
});
