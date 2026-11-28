// @effect-diagnostics nodeBuiltinImport:off - headless CLI library on node:* builtins only.
/**
 * Run logs go to `<root>/runs`: SHIP_QUEUE_DATA_ROOT in CI, else the host storage
 * configuration's data root, else its source root (devtools' pb_storage_config:
 * environment, host-guards.conf, then storage.json). RUNLOG_ROOT is ignored.
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

export type Env = Readonly<Record<string, string | undefined>>;

const FORBIDDEN_ROOTS = new Set([
  "",
  "/",
  "/root",
  "/home",
  "/boot",
  "/bin",
  "/sbin",
  "/etc",
  "/dev",
  "/proc",
  "/sys",
  "/usr",
  "/var",
  "/tmp",
]);

export interface StorageRoots {
  readonly sourceRoot: string;
  /** null on a single-drive host. */
  readonly dataRoot: string | null;
}

function homeOf(env: Env): string {
  return env.HOME || NodeOS.homedir();
}

/** Python's os.path.expanduser for `~` and `~/...`. */
export function expandUser(p: string, env: Env): string {
  if (p === "~") return homeOf(env);
  if (p.startsWith("~/")) return NodePath.join(homeOf(env), p.slice(2));
  return p;
}

const UNSET = ["none", "null", ""];

/** An unset root: none, null or empty, in any case (not stripped, as the original reads it). */
function isUnset(p: string | null | undefined): p is null | undefined {
  return p === null || p === undefined || UNSET.includes(p.toLowerCase());
}

/** A root as the source/data comparison sees it: stripped, expanded and absolute; null when unset. */
function expandOpt(p: string | null, env: Env): string | null {
  if (p === null || UNSET.includes(p.trim().toLowerCase())) return null;
  return NodePath.resolve(expandUser(p.trim(), env));
}

/** realpath of the longest existing prefix, the rest appended: a root need not exist yet. */
function realpathLoose(p: string): string {
  const missing: string[] = [];
  let cur = p;
  for (;;) {
    try {
      return NodePath.join(NodeFS.realpathSync(cur), ...missing.reverse());
    } catch {
      const parent = NodePath.dirname(cur);
      if (parent === cur) return p;
      missing.push(NodePath.basename(cur));
      cur = parent;
    }
  }
}

/** Refuses a critical system directory or a bare HOME as a storage root. */
export function validateSafeRoot(p: string, name: string, env: Env): void {
  const canon = realpathLoose(NodePath.resolve(expandUser(p, env)));
  if (FORBIDDEN_ROOTS.has(canon)) {
    throw new Error(`refusing dangerous ${name}: '${canon}' is a critical system directory`);
  }
  if (canon === realpathLoose(homeOf(env))) {
    throw new Error(`refusing bare HOME as ${name}: '${canon}'`);
  }
}

function readHostGuardsConf(env: Env): Map<string, string> {
  const out = new Map<string, string>();
  const home = homeOf(env);
  for (const p of [
    NodePath.join(home, ".local/lib/host-guards.conf"),
    NodePath.join(home, ".local/lib/host-guards/host-guards.conf"),
  ]) {
    let text: string;
    try {
      if (!NodeFS.statSync(p).isFile()) continue;
      text = NodeFS.readFileSync(p, "utf8");
    } catch {
      continue;
    }
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      const eq = line.indexOf("=");
      if (eq < 0 || line.startsWith("#")) continue;
      out.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
    }
    break;
  }
  return out;
}

function configFilePath(env: Env): string {
  if (env.DEVTOOLS_STORAGE_CONFIG) return env.DEVTOOLS_STORAGE_CONFIG;
  const base = env.XDG_CONFIG_HOME || NodePath.join(homeOf(env), ".config");
  return NodePath.join(base, "devtools", "storage.json");
}

function readConfigFile(env: Env): Record<string, unknown> {
  try {
    const data: unknown = JSON.parse(NodeFS.readFileSync(configFilePath(env), "utf8"));
    return data !== null && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function resolveRoot(p: string, env: Env): string {
  return NodePath.resolve(expandUser(p, env));
}

/** The host's source and data roots. */
export function loadStorageRoots(env: Env = process.env): StorageRoots {
  const hg = readHostGuardsConf(env);
  let source =
    env.DEVTOOLS_SOURCE_ROOT ||
    env.HOST_GUARDS_SOURCE_ROOT ||
    hg.get("source_root") ||
    NodePath.join(homeOf(env), "Dev");
  let data: string | null =
    env.DEVTOOLS_DATA_ROOT || env.HOST_GUARDS_DATA_ROOT || hg.get("data_root") || null;
  if (data && expandOpt(data, env) === expandOpt(source, env)) data = null;
  const file = readConfigFile(env);
  if (typeof file.source_root === "string") source = file.source_root;
  if ("data_root" in file) data = typeof file.data_root === "string" ? file.data_root : null;
  if (env.DEVTOOLS_SOURCE_ROOT !== undefined) source = env.DEVTOOLS_SOURCE_ROOT;
  if (env.DEVTOOLS_DATA_ROOT !== undefined) data = env.DEVTOOLS_DATA_ROOT;
  validateSafeRoot(source, "source_root", env);
  if (isUnset(data)) {
    data = null;
  } else {
    validateSafeRoot(data, "data_root", env);
  }
  return {
    sourceRoot: resolveRoot(source, env),
    dataRoot: data === null ? null : resolveRoot(data, env),
  };
}

/** `<root>/runs`: the queue's SHIP_QUEUE_DATA_ROOT, else the data root, else the source root. */
export function logRoot(env: Env = process.env): string {
  const queue = env.SHIP_QUEUE_DATA_ROOT;
  if (queue) return NodePath.join(expandUser(queue, env), "runs");
  const roots = loadStorageRoots(env);
  return NodePath.join(roots.dataRoot ?? roots.sourceRoot, "runs");
}
