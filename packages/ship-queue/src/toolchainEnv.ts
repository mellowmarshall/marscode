// @effect-diagnostics nodeBuiltinImport:off - Unified toolchain PATH and environment builder shared by host probes and CI step execution.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

/** Relative `$HOME` directories prepended to `PATH` (including `~/.vite-plus/bin`). */
export const TOOLCHAIN_GNU_REL_DIR = ".local/share/ship-queue-ci/gnu/bin";

export const TOOLCHAIN_PREPEND_REL_DIRS: ReadonlyArray<string> = [
  ".local/bin",
  ".local/share/ship-queue-ci/npm/bin",
  ".local/share/ship-queue-ci/bin",
  ".vite-plus/bin",
  ".cargo/bin",
];

/** Relative directory under `$HOME` appended last so system/managed Node wins unless absent. */
export const TOOLCHAIN_APPEND_REL_DIRS: ReadonlyArray<string> = [
  ".local/share/ship-queue-ci/node/bin",
];

export const TOOLCHAIN_VP_HOME_REL_DIR = ".local/share/ship-queue-ci/vite-plus";

export const DEFAULT_SCCACHE_CACHE_SIZE = "20G";
export const DEFAULT_SCCACHE_IDLE_TIMEOUT = "60";
export const SCCACHE_VERBATIM_ENV_DEPS = "CARGO_MANIFEST_DIR,CARGO_MANIFEST_PATH";

/**
 * Tools this module wires into every CI step's environment. Each one must have an entry in the
 * tracked catalog (`infra/ci-host/ci-hosts.json`), so a host that lacks it shows as drift and
 * provisioning installs it everywhere, instead of the env quietly skipping it on one host.
 */
export const TOOLCHAIN_ENV_TOOLS: ReadonlyArray<string> = ["node", "pnpm", "sccache", "uv", "vp"];

export const TOOLCHAIN_STATIC_ENV: Readonly<Record<string, string>> = {
  FLY_NO_UPDATE_CHECK: "1",
  UV_PYTHON_PREFERENCE: "only-managed",
};

export interface ToolchainEnvOptions {
  readonly homeDir?: string | undefined;
  readonly dataRoot?: string | undefined;
  readonly worktreeDir?: string | undefined;
  readonly sccacheSocketPath?: string | undefined;
  readonly includeGnuDir?: boolean | undefined;
  readonly hasSccache?: boolean | undefined;
  readonly pathSeparator?: string | undefined;
}

function joinHomeRel(homeDir: string, rel: string): string {
  return NodePath.posix.join(homeDir.replaceAll("\\", "/"), rel);
}

function hasExecutableInPath(pathValue: string, binName: string, sep: string): boolean {
  for (const dir of pathValue.split(sep)) {
    const trimmed = dir.trim();
    if (!trimmed) continue;
    const candidate = NodePath.join(trimmed, binName);
    try {
      NodeFS.accessSync(candidate, NodeFS.constants.X_OK);
      return true;
    } catch {
      // continue searching PATH
    }
  }
  return false;
}

/**
 * Builds the canonical `PATH` string for local execution from the same directory list
 * that `buildToolchainShellSetup` emits for remote shells and host probes.
 */
export function buildToolchainPath(
  existingPath: string | undefined,
  options: ToolchainEnvOptions = {},
): string {
  const homeDir = options.homeDir ?? NodeOS.homedir();
  const sep = options.pathSeparator ?? NodePath.delimiter;
  const gnuDir = joinHomeRel(homeDir, TOOLCHAIN_GNU_REL_DIR);
  const hasGnu = options.includeGnuDir ?? NodeFS.existsSync(gnuDir);

  const prepend = [
    ...(hasGnu ? [gnuDir] : []),
    ...TOOLCHAIN_PREPEND_REL_DIRS.map((rel) => joinHomeRel(homeDir, rel)),
  ];
  const append = TOOLCHAIN_APPEND_REL_DIRS.map((rel) => joinHomeRel(homeDir, rel));

  const managed = new Set<string>([gnuDir, ...prepend]);
  const existingEntries = (existingPath ?? "")
    .split(sep)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0 && !managed.has(entry));

  const result: string[] = [...prepend, ...existingEntries];
  for (const dir of append) {
    if (!result.includes(dir)) result.push(dir);
  }
  return result.join(sep);
}

/**
 * Builds a complete environment map for local probes and local CI steps.
 * Guarantees probes and CI steps observe identical `PATH`, `VP_HOME`, `UV_PYTHON_PREFERENCE`,
 * `FLY_NO_UPDATE_CHECK`, and shared pnpm store settings.
 */
export function buildToolchainEnv(
  baseEnv: Readonly<Record<string, string | undefined>>,
  options: ToolchainEnvOptions = {},
): Record<string, string> {
  const homeDir = options.homeDir ?? baseEnv.HOME ?? NodeOS.homedir();
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(baseEnv)) {
    if (v !== undefined) out[k] = v;
  }
  out.PATH = buildToolchainPath(baseEnv.PATH, { ...options, homeDir });
  for (const [k, v] of Object.entries(TOOLCHAIN_STATIC_ENV)) {
    out[k] = v;
  }
  out.VP_HOME = joinHomeRel(homeDir, TOOLCHAIN_VP_HOME_REL_DIR);
  if (options.dataRoot) {
    const dataRootPosix = options.dataRoot.replaceAll("\\", "/");
    // Pin all shared cache directories onto the declared data root so CI stays off `/`.
    out.SHIP_QUEUE_DATA_ROOT = options.dataRoot;
    out.npm_config_store_dir = NodePath.posix.join(dataRootPosix, "pnpm-store");
    out.TURBO_CACHE_DIR = NodePath.posix.join(dataRootPosix, "turbo-cache");
    out.UV_CACHE_DIR = NodePath.posix.join(dataRootPosix, "uv-cache");
    const customWrapper = Boolean(out.RUSTC_WRAPPER && out.RUSTC_WRAPPER !== "sccache");
    const sccacheAvailable =
      !customWrapper &&
      (options.hasSccache ??
        hasExecutableInPath(out.PATH, "sccache", options.pathSeparator ?? NodePath.delimiter));
    if (sccacheAvailable) {
      const worktreePosix = options.worktreeDir?.replaceAll("\\", "/");
      out.RUSTC_WRAPPER = "sccache";
      out.SCCACHE_DIR = NodePath.posix.join(dataRootPosix, "sccache");
      out.SCCACHE_CACHE_SIZE = out.SCCACHE_CACHE_SIZE || DEFAULT_SCCACHE_CACHE_SIZE;
      out.SCCACHE_IDLE_TIMEOUT = DEFAULT_SCCACHE_IDLE_TIMEOUT;
      out.SCCACHE_CLIENT_SIDE = "1";
      out.SCCACHE_BASEDIRS =
        worktreePosix && worktreePosix !== dataRootPosix
          ? `${worktreePosix}:${dataRootPosix}`
          : dataRootPosix;
      out.SCCACHE_BASEDIRS_VERBATIM_ENV_DEPS = SCCACHE_VERBATIM_ENV_DEPS;
      if (options.sccacheSocketPath) {
        out.SCCACHE_SERVER_UDS = options.sccacheSocketPath;
      }
    }
  }
  return out;
}

const SAFE_DECLARED_DATA_ROOT_RE = /^(\/[A-Za-z0-9._/-]+|~|~\/[A-Za-z0-9._/-]+)$/;
const SAFE_DATA_ROOT_SHELL_RE = /^(\$HOME(\/[A-Za-z0-9._/-]+)?|\/[A-Za-z0-9._/-]+)$/;

function hasDotSegment(pathText: string): boolean {
  const segs = pathText.split("/");
  return segs.includes("..") || segs.includes(".");
}

/**
 * Expands a declared `data_root` (absolute or `~/...`) into a validated shell expression
 * evaluated on the target host where `$HOME` is the remote CI user's home.
 */
export function formatDataRootShell(declaredDataRoot: string): string {
  if (!SAFE_DECLARED_DATA_ROOT_RE.test(declaredDataRoot) || hasDotSegment(declaredDataRoot)) {
    throw new Error(`unsafe data_root path: ${JSON.stringify(declaredDataRoot)}`);
  }
  if (declaredDataRoot === "~") return "$HOME";
  if (declaredDataRoot.startsWith("~/")) return `$HOME/${declaredDataRoot.slice(2)}`;
  return declaredDataRoot;
}

/**
 * Emits a POSIX bash setup snippet (containing NO single quotes so it embeds safely inside
 * single-quoted remote commands) used by BOTH host probes AND remote/shell CI step execution.
 */
export function buildToolchainShellSetup(options?: {
  readonly dataRootShell?: string | undefined;
}): string {
  if (
    options?.dataRootShell !== undefined &&
    (!SAFE_DATA_ROOT_SHELL_RE.test(options.dataRootShell) || hasDotSegment(options.dataRootShell))
  ) {
    throw new Error(`unsafe dataRootShell expression: ${JSON.stringify(options.dataRootShell)}`);
  }
  const gnuExpr = `"$HOME/${TOOLCHAIN_GNU_REL_DIR}"`;
  const prependExprs = TOOLCHAIN_PREPEND_REL_DIRS.map((rel) => `"$HOME/${rel}"`);
  const appendExprs = TOOLCHAIN_APPEND_REL_DIRS.map((rel) => `"$HOME/${rel}"`);
  const prependColon = TOOLCHAIN_PREPEND_REL_DIRS.map((rel) => `$HOME/${rel}`).join(":");
  const staticExports = Object.entries(TOOLCHAIN_STATIC_ENV)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");

  const parts: string[] = [
    `sq_path=":$PATH:"`,
    `sq_gnu=${gnuExpr}`,
    `for sq_path_dir in "$sq_gnu" ${prependExprs.join(" ")}; do while case "$sq_path" in *":$sq_path_dir:"*) true ;; *) false ;; esac; do sq_path=\${sq_path/":$sq_path_dir:"/:}; done; done`,
    `sq_path=\${sq_path#:}`,
    `sq_path=\${sq_path%:}`,
    `[ -d "$sq_gnu" ] || sq_gnu=""`,
    `PATH="\${sq_gnu:+$sq_gnu:}${prependColon}\${sq_path:+:$sq_path}"`,
  ];

  for (const appendExpr of appendExprs) {
    const bare = appendExpr.slice(1, -1);
    parts.push(`case ":$PATH:" in *":${bare}:"*) ;; *) PATH="$PATH:${bare}" ;; esac`);
  }

  parts.push(
    `unset sq_path sq_path_dir sq_gnu`,
    `export PATH ${staticExports} VP_HOME="$HOME/${TOOLCHAIN_VP_HOME_REL_DIR}"`,
  );

  if (options?.dataRootShell) {
    parts.push(
      `export SHIP_QUEUE_DATA_ROOT="${options.dataRootShell}" npm_config_store_dir="${options.dataRootShell}/pnpm-store" TURBO_CACHE_DIR="${options.dataRootShell}/turbo-cache" UV_CACHE_DIR="${options.dataRootShell}/uv-cache"`,
      `if [ -z "\${RUSTC_WRAPPER:-}" ] || [ "\${RUSTC_WRAPPER:-}" = sccache ]; then if command -v sccache >/dev/null 2>&1; then export RUSTC_WRAPPER=sccache SCCACHE_DIR="${options.dataRootShell}/sccache" SCCACHE_CACHE_SIZE="\${SCCACHE_CACHE_SIZE:-${DEFAULT_SCCACHE_CACHE_SIZE}}" SCCACHE_IDLE_TIMEOUT="${DEFAULT_SCCACHE_IDLE_TIMEOUT}" SCCACHE_CLIENT_SIDE=1 SCCACHE_BASEDIRS="${options.dataRootShell}" SCCACHE_BASEDIRS_VERBATIM_ENV_DEPS="${SCCACHE_VERBATIM_ENV_DEPS}"; fi; fi`,
    );
  }

  return parts.join("; ");
}
