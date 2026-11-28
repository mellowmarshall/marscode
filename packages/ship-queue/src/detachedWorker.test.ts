// @effect-diagnostics nodeBuiltinImport:off - Out-of-process proof that a queue job outlives its submitter and its first watcher.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { runShipQueueCli } from "./cli.ts";
import { readJob, readLog } from "./jobStore.ts";
import { workerLockPath } from "./processLocks.ts";
import { withoutAppImageLibraries } from "./workerLauncher.ts";

const CLI = NodePath.join(import.meta.dirname, "cli.ts");
const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

// A stand-in for `gh` on PATH: pull requests as files, squash merges into the bare fixture remote.
const FAKE_GH = String.raw`#!/usr/bin/env bash
set -euo pipefail
state=$FAKE_GH_STATE; remote=$FAKE_GH_REMOTE
mkdir -p "$state/prs" "$state/bodies"
sub="$1 $2"; shift 2
first=""; head=""; base=""; title=""; match=""; subject=""
while [ $# -gt 0 ]; do case "$1" in
  --head) head=$2; shift 2 ;; --base) base=$2; shift 2 ;; --title) title=$2; shift 2 ;;
  --match-head-commit) match=$2; shift 2 ;; --subject) subject=$2; shift 2 ;;
  --repo|--state|--json|--limit|--body-file) shift 2 ;; --squash) shift ;;
  *) [ -n "$first" ] || first=$1; shift ;;
esac; done
g() { git -c core.hooksPath=/dev/null -c commit.gpgsign=false "$@"; }
case "$sub" in
  "pr list")
    for f in "$state"/prs/*; do
      [ -e "$f" ] || continue
      if [ "$(sed -n 1p "$f")" = "$head" ] && [ "$(sed -n 4p "$f")" = open ]; then echo "[{\"number\":$(basename "$f")}]"; exit 0; fi
    done
    echo "[]" ;;
  "pr create")
    n=$(( $(ls "$state/prs" | wc -l) + 1 ))
    printf '%s\n%s\n%s\nopen\n' "$head" "$base" "$title" > "$state/prs/$n"
    cat > "$state/bodies/$n"
    echo "https://github.com/acme-fixture/sample-repo/pull/$n" ;;
  "pr view")
    if [ "$(sed -n 4p "$state/prs/$first")" = merged ]; then echo '{"state":"MERGED"}'; else echo '{"state":"OPEN"}'; fi ;;
  "pr merge")
    n=$first; f="$state/prs/$n"; head=$(sed -n 1p "$f"); base=$(sed -n 2p "$f"); c="$state/clone"
    if [ ! -d "$c" ]; then
      g clone -q "$remote" "$c"; g -C "$c" config user.name "Fixture Forge"; g -C "$c" config user.email forge@example.invalid
    fi
    g -C "$c" fetch -q origin
    [ "$(g -C "$c" rev-parse "origin/$head")" = "$match" ] || { echo "head moved" >&2; exit 1; }
    g -C "$c" checkout -q -B "$base" "origin/$base"
    g -C "$c" merge -q --squash "origin/$head"
    { printf '%s\n\n' "$subject"; cat "$state/bodies/$n"; } > "$state/msg"
    g -C "$c" commit -q -F "$state/msg"
    g -C "$c" push -q origin "HEAD:refs/heads/$base"
    sed -i 4s/open/merged/ "$f"
    echo "merged #$n" ;;
  "api repos/"*) echo private ;;
  *) echo "fake gh: unsupported $sub" >&2; exit 2 ;;
esac
`;

function sh(cwd: string, args: ReadonlyArray<string>): string {
  const res = NodeChildProcess.spawnSync(
    "git",
    ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf8" },
  );
  if (res.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${res.stderr}`);
  return res.stdout.trim();
}

/** Resolves once `file` no longer exists, on directory events rather than a timer. */
function gone(file: string): Promise<void> {
  return new Promise((resolve) => {
    const watcher = NodeFS.watch(NodePath.dirname(file), () => {
      if (!NodeFS.existsSync(file)) {
        watcher.close();
        resolve();
      }
    });
    if (!NodeFS.existsSync(file)) {
      watcher.close();
      resolve();
    }
  });
}

/** Resolves with the child's output once it prints `needle` or exits. */
function outputUntil(child: NodeChildProcess.ChildProcess, needle: string): Promise<string> {
  return new Promise((resolve) => {
    let text = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      text += chunk.toString("utf8");
      if (text.includes(needle)) resolve(text);
    });
    child.on("close", () => resolve(text));
  });
}

describe("detached worker", () => {
  it("lands a job after its submitter and first watcher are gone, and a new watch reattaches", async () => {
    const tmp = NodeFS.realpathSync(
      NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ship-queue-detached-")),
    );
    cleanups.push(() => NodeFS.rmSync(tmp, { recursive: true, force: true }));
    const remote = NodePath.join(tmp, "remotes", "acme-fixture", "sample-repo.git");
    NodeFS.mkdirSync(remote, { recursive: true });
    sh(remote, ["init", "-q", "--bare", "-b", "main"]);
    const primary = NodePath.join(tmp, "sample-repo");
    sh(tmp, ["clone", "-q", remote, primary]);
    sh(primary, ["config", "user.name", "Fixture Lane"]);
    sh(primary, ["config", "user.email", "lane@example.invalid"]);
    NodeFS.writeFileSync(NodePath.join(primary, "README.md"), "# sample\n");
    sh(primary, ["add", "README.md"]);
    sh(primary, ["commit", "-q", "-m", "init"]);
    sh(primary, ["push", "-q", "origin", "HEAD:refs/heads/main"]);
    const wt = NodePath.join(tmp, "worktrees", "feat-20-detached");
    sh(primary, ["worktree", "add", "-q", "-b", "feat/20-detached", wt, "origin/main"]);
    NodeFS.writeFileSync(NodePath.join(wt, "z.txt"), "z\n");
    sh(wt, ["add", "z.txt"]);
    sh(wt, ["commit", "-q", "-m", "add z"]);

    const bin = NodePath.join(tmp, "bin");
    NodeFS.mkdirSync(bin);
    NodeFS.writeFileSync(NodePath.join(bin, "gh"), FAKE_GH, { mode: 0o755 });
    // Shadows the host's playbook so the advisory challenge never reaches a live reviewer.
    NodeFS.writeFileSync(
      NodePath.join(bin, "playbook"),
      '#!/usr/bin/env bash\nwhile [ $# -gt 0 ]; do [ "$1" = --out ] && printf "PLAYBOOK REVIEW: PASS\\n" > "$2"; shift; done\n',
      { mode: 0o755 },
    );
    NodeFS.writeFileSync(NodePath.join(tmp, "body.md"), "Adds z.\n\nCloses #20\n");
    const root = NodePath.join(tmp, "queue");
    const env = {
      ...process.env,
      PATH: `${bin}${NodePath.delimiter}${process.env.PATH ?? ""}`,
      SHIP_QUEUE_ROOT: root,
      // Never reach the live guard broker from a test.
      T3_GUARD_GRANT_SOCKET: "",
      FAKE_GH_STATE: NodePath.join(tmp, "gh-state"),
      FAKE_GH_REMOTE: remote,
    };

    const submitter = NodeChildProcess.spawnSync(
      process.execPath,
      [CLI, "submit", wt, "feat/20-detached", "Add z", "body.md"],
      { cwd: tmp, env, encoding: "utf8" },
    );
    expect(submitter.stderr).not.toMatch(/refused/);
    expect(submitter.status).toBe(0);
    const id = /^job=(\d+)/m.exec(submitter.stdout)?.[1] ?? "";
    expect(submitter.stdout).toMatch(/^worker=(systemd-scope|detached)$/m);
    expect(id).not.toBe("");

    const firstWatch = NodeChildProcess.spawn(process.execPath, [CLI, "watch", id], {
      cwd: tmp,
      env,
      stdio: ["ignore", "pipe", "ignore"],
    });
    expect(await outputUntil(firstWatch, `STARTED job=${id}`)).toContain(`STARTED job=${id}`);
    firstWatch.kill("SIGKILL");

    const printed: string[] = [];
    const code = await runShipQueueCli(["watch", id], {
      io: { stdout: (t) => printed.push(t), stderr: (t) => printed.push(t), env, cwd: tmp },
    });
    const lines = printed.join("").trim().split("\n");
    expect(code, readLog(root, id)).toBe(0);
    expect(lines[0]).toMatch(new RegExp(`^QUEUED job=${id} branch=feat/20-detached`));
    expect(lines).toEqual(expect.arrayContaining(["PUSH_EXIT=0", "PR=1", "MERGE_EXIT=0"]));
    expect(lines.findLast((line) => line.startsWith("DONE "))).toMatch(
      new RegExp(`^DONE job=${id} pr=1 at=`),
    );

    const job = readJob(root, id);
    expect(job?.state).toBe("done");
    expect(job?.worker?.pid).not.toBe(submitter.pid);
    expect(job?.worker?.pid).not.toBe(process.pid);
    expect(job?.worker?.startTicks).toMatch(/^\d+$/);
    expect(sh(remote, ["log", "--format=%s", "-1", "main"])).toBe("Add z (#1)");
    expect(sh(remote, ["log", "--format=%b", "-1", "main"])).toContain("Closes #20");
    expect(NodeFS.existsSync(wt)).toBe(false);

    // The worker releases its claim once the queue is empty, and wrote no failure of its own.
    await gone(workerLockPath(root));
    expect(NodeFS.existsSync(NodePath.join(root, "worker.log"))).toBe(false);
  });
});

describe("worker environment", () => {
  it("drops the library paths of the AppImage MarsCode runs from, keeping the rest", () => {
    expect(
      withoutAppImageLibraries({
        PATH: "/usr/bin",
        LD_LIBRARY_PATH: "/tmp/.mount_MarsCoOBCFJe/usr/lib:/opt/cuda/lib64",
      }),
    ).toEqual({ PATH: "/usr/bin", LD_LIBRARY_PATH: "/opt/cuda/lib64" });
    expect(
      withoutAppImageLibraries({
        PATH: "/usr/bin",
        LD_LIBRARY_PATH: "/tmp/.mount_MarsCoX/usr/lib",
      }),
    ).toEqual({ PATH: "/usr/bin" });
  });
});
