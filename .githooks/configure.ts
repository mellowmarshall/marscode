// @effect-diagnostics nodeBuiltinImport:off - `prepare` step: points git at the tracked hooks directory.
// The host guard allows core.hooksPath only for a tracked directory of hooks, which this is.
import * as NodeChildProcess from "node:child_process";

const HOOKS_DIR = ".githooks";

function git(args: ReadonlyArray<string>) {
  return NodeChildProcess.spawnSync("git", [...args], { encoding: "utf8" });
}

if (process.env.VP_GIT_HOOKS !== "0" && git(["rev-parse", "--is-inside-work-tree"]).status === 0) {
  const current = git(["config", "--get", "core.hooksPath"]).stdout.trim();
  if (current !== HOOKS_DIR && git(["config", "core.hooksPath", HOOKS_DIR]).status !== 0) {
    process.stderr.write(
      `prepare: could not set core.hooksPath=${HOOKS_DIR}; run \`git config core.hooksPath ${HOOKS_DIR}\` once it is committed\n`,
    );
  }
}
