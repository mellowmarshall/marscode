// The declared `ship_ci_env` file read as data in a step's shell, local and remote: its variables reach the
// install and CI steps, and the queue's own names (SHIP_QUEUE_*, PATH, secrets) keep their values.

/**
 * Bash that reads the branch's env file at `fileExpr` as data, never as code: only comments,
 * `NAME=value`, `export NAME=value` and `unset NAME…` with a literal value. Any other line exits
 * 1, and a variable the shell already had keeps its value.
 */
export function ciEnvSourceShell(fileExpr: string): string {
  return [
    `sq_f=${fileExpr}`,
    `if [ ! -f "$sq_f" ]; then echo "ship-queue: the declared env file (ship_ci_env $sq_f) is not in the job's tree" >&2; exit 1; fi`,
    `sq_keep=$(export -p)`,
    `sq_blank='^[[:space:]]*(#.*)?$'`,
    `sq_set='^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)=("[^"$\`\\\\]*"|'"'"'[^'"'"']*'"'"'|[A-Za-z0-9_./:@%+,=-]*)[[:space:]]*$'`,
    `sq_unset='^[[:space:]]*unset(([[:space:]]+[A-Za-z_][A-Za-z0-9_]*)+)[[:space:]]*$'`,
    `while IFS= read -r sq_l || [ -n "$sq_l" ]; do if [[ "$sq_l" =~ $sq_blank ]]; then continue; elif [[ "$sq_l" =~ $sq_set ]]; then sq_n=\${BASH_REMATCH[2]}; sq_v=\${BASH_REMATCH[3]}; case "$sq_v" in \\"*\\"|\\'*\\') sq_v=\${sq_v:1:\${#sq_v}-2} ;; esac; export "$sq_n=$sq_v"; elif [[ "$sq_l" =~ $sq_unset ]]; then unset \${BASH_REMATCH[1]}; else echo "ship-queue: the declared env file (ship_ci_env $sq_f) has a line that is not NAME=value, export NAME=value or unset NAME: $sq_l" >&2; exit 1; fi; done < "$sq_f"`,
    `eval "$sq_keep" 2>/dev/null`,
    `unset sq_keep sq_f sq_l sq_n sq_v sq_blank sq_set sq_unset`,
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
