// The declared `ship_ci_env` file in a step's shell, local and remote: its variables reach the
// install and CI steps, and the queue's own names (SHIP_QUEUE_*, PATH, secrets) keep their values.

/**
 * Bash that sources the env file at `fileExpr` (a shell word: quoted, or `"$1"`) with every
 * assignment exported, then restores each variable the shell had before, so the file adds names
 * and never replaces one the queue set. A file that is missing or fails stops the step (exit 1).
 */
export function ciEnvSourceShell(fileExpr: string): string {
  return [
    `sq_f=${fileExpr}`,
    `if [ ! -f "$sq_f" ]; then echo "ship-queue: the declared env file (ship_ci_env $sq_f) is not in the job's tree" >&2; exit 1; fi`,
    `sq_keep=$(export -p)`,
    `set -a`,
    `. "$sq_f" || { echo "ship-queue: the declared env file (ship_ci_env $sq_f) failed to load" >&2; exit 1; }`,
    `set +a`,
    `eval "$sq_keep" 2>/dev/null`,
    `unset sq_keep sq_f`,
  ].join("; ");
}

/** A local step's argv wrapped so its shell sources the env file at `absPath` first. */
export function wrapArgvWithCiEnv(
  absPath: string,
  argv: ReadonlyArray<string>,
): ReadonlyArray<string> {
  return [
    "bash",
    "-c",
    `${ciEnvSourceShell('"$1"')}; shift; exec "$@"`,
    "ship-queue-ci-env",
    absPath,
    ...argv,
  ];
}

/** Variable names a service run may give a step: shell names only. */
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function isStepEnvName(name: string): boolean {
  return ENV_NAME_RE.test(name);
}
