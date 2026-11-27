// @effect-diagnostics nodeBuiltinImport:off - Canonical ci-hosts.json loader, schema validator, and toolchain version evaluator.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { VERSION_RANGE_RE } from "./ciToolVersion.ts";
import { validateRootCommand } from "./rootGrant.ts";

const TOOL_NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;
const HOST_NAME_RE = /^[A-Za-z0-9._-]+$/;
const SAFE_HOST_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SAFE_SSH_ALIAS_RE = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$/;
const ROOT_PATH_RE = /^(\/[A-Za-z0-9._/-]+|~|~\/[A-Za-z0-9._/-]+)$/;
const SOURCE_DEV_ROOT_RE = /^(~|\/home\/[^/]+|\/Users\/[^/]+)\/+dev(\/|$)/i;

const MANIFEST_FIELDS = new Set(["schema", "note", "hosts", "toolchain", "guards"]);
const HOST_FIELDS = new Set([
  "name",
  "ssh",
  "role",
  "data_root",
  "priority",
  "wsl",
  "sudo",
  "on",
  "note",
]);
const TOOL_FIELDS = new Set([
  "version",
  "probe",
  "install",
  "base",
  "refresh",
  "optional",
  "os",
  "needs",
  "root",
  "note",
]);
const GUARDS_FIELDS = new Set(["install", "note"]);
const OS_NAMES = new Set(["linux", "darwin"]);

const ARCH_ALIASES: Readonly<Record<string, string>> = {
  arm64: "aarch64",
  amd64: "x86_64",
};

export interface CiHostEntry {
  readonly name: string;
  readonly ssh: string | null;
  readonly role: string;
  readonly data_root: string;
  readonly priority?: number | undefined;
  readonly wsl?: string | undefined;
  readonly sudo?: boolean | undefined;
  readonly on?: string | undefined;
  readonly note?: string | undefined;
}

export interface CiToolEntry {
  readonly version: string;
  readonly probe: string;
  readonly install: string | null;
  readonly base?: boolean | undefined;
  readonly refresh?: boolean | undefined;
  readonly optional?: boolean | undefined;
  readonly os?: ReadonlyArray<string> | undefined;
  readonly needs?: ReadonlyArray<string> | undefined;
  readonly root?: Readonly<Record<string, string>> | undefined;
  readonly note?: string | undefined;
}

export interface CiGuardsEntry {
  readonly install: string;
  readonly note?: string | undefined;
}

export interface CiHostsManifest {
  readonly schema: 1;
  readonly note?: string | undefined;
  readonly hosts: ReadonlyArray<CiHostEntry>;
  readonly toolchain: Readonly<Record<string, CiToolEntry>>;
  readonly guards?: CiGuardsEntry | undefined;
}

export interface ResolveCiHostsPathOptions {
  readonly overridePath?: string | undefined;
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  readonly homeDir?: string | undefined;
}

export interface ManifestValidationResult {
  readonly ok: boolean;
  readonly manifest?: CiHostsManifest | undefined;
  readonly errors: ReadonlyArray<string>;
  readonly warnings: ReadonlyArray<string>;
}

export function isValidSshAlias(alias: string): boolean {
  return SAFE_SSH_ALIAS_RE.test(alias);
}

export function isSafeHostName(name: string): boolean {
  return SAFE_HOST_RE.test(name);
}

export function normalizeArch(raw: string): string {
  const lowered = raw.trim().toLowerCase();
  return ARCH_ALIASES[lowered] ?? lowered;
}

export function expandDataRoot(declaredDataRoot: string, homeDir = NodeOS.homedir()): string {
  if (declaredDataRoot === "~") return homeDir;
  if (declaredDataRoot.startsWith("~/")) return NodePath.join(homeDir, declaredDataRoot.slice(2));
  return declaredDataRoot;
}

/**
 * Resolves `ci-hosts.json` in priority order: overridePath, env override,
 * MarsCode overlay (`~/.local/lib/marscode/ci-hosts.json`), then legacy paths.
 */
export function resolveCiHostsPath(options: ResolveCiHostsPathOptions = {}): string | null {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? env.HOME ?? NodeOS.homedir();

  if (options.overridePath?.trim()) {
    const p = options.overridePath.trim();
    return isReadableFile(p) ? p : null;
  }

  const candidates: string[] = [];
  const sqEnv = env.SHIP_QUEUE_CI_HOSTS?.trim();
  if (sqEnv) candidates.push(sqEnv);
  const dtEnv = env.DEVTOOLS_CI_HOSTS?.trim();
  if (dtEnv) candidates.push(dtEnv);

  candidates.push(NodePath.join(homeDir, ".local", "lib", "marscode", "ci-hosts.json"));

  const libDir =
    env.SHIP_QUEUE_LIB_DIR?.trim() || NodePath.join(homeDir, ".local", "lib", "ship-queue");
  candidates.push(NodePath.join(libDir, "ci-hosts.json"));

  const mainCheckout = env.SHIP_QUEUE_MAIN_CHECKOUT?.trim();
  if (mainCheckout) {
    candidates.push(NodePath.join(mainCheckout, "ship-queue", "ci-hosts.json"));
  }

  for (const candidate of candidates) {
    if (isReadableFile(candidate)) return candidate;
  }
  return null;
}

function isReadableFile(filePath: string): boolean {
  try {
    return NodeFS.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

/**
 * Lenient host-list reader shared by MarsCode fleet discovery, host-config sync, and job-host
 * inference. Tolerates minimal manifests (e.g., unit-test fixtures that only declare `hosts`).
 */
export function readCiHostEntries(
  options: ResolveCiHostsPathOptions = {},
): ReadonlyArray<CiHostEntry> {
  const filePath = options.overridePath?.trim() || resolveCiHostsPath(options);
  if (!filePath) return [];
  try {
    const raw = JSON.parse(NodeFS.readFileSync(filePath, "utf8")) as unknown;
    return extractCiHostEntries(raw);
  } catch {
    return [];
  }
}

export function extractCiHostEntries(raw: unknown): ReadonlyArray<CiHostEntry> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const hostsRaw = (raw as { readonly hosts?: unknown }).hosts;
  if (!Array.isArray(hostsRaw)) return [];
  const out: CiHostEntry[] = [];
  for (const item of hostsRaw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const rec = item as Record<string, unknown>;
    const name = typeof rec.name === "string" ? rec.name.trim() : "";
    if (!name) continue;
    const ssh = typeof rec.ssh === "string" && rec.ssh.trim() ? rec.ssh.trim() : null;
    if (ssh !== null && !isValidSshAlias(ssh)) continue;
    const role = typeof rec.role === "string" && rec.role.trim() ? rec.role.trim() : "ci";
    const defaultDataRoot = ssh === null ? "/data/Dev" : "~/Dev-data";
    const data_root =
      typeof rec.data_root === "string" && rec.data_root.trim()
        ? rec.data_root.trim()
        : defaultDataRoot;
    out.push({
      name,
      ssh,
      role,
      data_root,
      ...(typeof rec.priority === "number" && Number.isInteger(rec.priority) && rec.priority >= 1
        ? { priority: rec.priority }
        : {}),
      ...(typeof rec.wsl === "string" && rec.wsl.trim() ? { wsl: rec.wsl.trim() } : {}),
      ...(rec.sudo === true ? { sudo: true } : {}),
      ...(typeof rec.on === "string" && rec.on.trim() ? { on: rec.on.trim() } : {}),
      ...(typeof rec.note === "string" ? { note: rec.note } : {}),
    });
  }
  return out;
}

/** Strict closed-schema validator for `ci-hosts.json` (schema v1). */
export function validateCiHostsManifest(
  raw: unknown,
  sourceLabel = "ci-hosts.json",
): ManifestValidationResult {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, errors: ["the manifest is not a JSON object"], warnings: [] };
  }
  const obj = raw as Record<string, unknown>;
  const errors: string[] = [];
  const warnings: string[] = [];

  const checkClosed = (target: unknown, allowed: ReadonlySet<string>, where: string): boolean => {
    if (!target || typeof target !== "object" || Array.isArray(target)) {
      errors.push(`${where} is not an object`);
      return false;
    }
    for (const k of Object.keys(target as Record<string, unknown>)) {
      if (!allowed.has(k)) {
        errors.push(
          `${where} has unknown field ${JSON.stringify(k)} (allowed: ${[...allowed].toSorted().join(", ")})`,
        );
      }
    }
    return true;
  };

  checkClosed(obj, MANIFEST_FIELDS, "the manifest");
  if (obj.schema !== 1) errors.push("schema is not 1");

  const rawHosts = Array.isArray(obj.hosts) && obj.hosts.length > 0 ? obj.hosts : null;
  if (!rawHosts) errors.push("hosts is not a non-empty list");

  const hosts: CiHostEntry[] = [];
  const names = new Set<string>();
  let localCount = 0;

  for (const [i, item] of (rawHosts ?? []).entries()) {
    if (!checkClosed(item, HOST_FIELDS, `hosts[${i}]`)) continue;
    const h = item as Record<string, unknown>;
    const name = typeof h.name === "string" ? h.name : "";
    if (!name || !HOST_NAME_RE.test(name)) {
      errors.push(`hosts[${i}] has no valid name`);
    } else if (names.has(name)) {
      errors.push(`host ${name} is declared twice`);
    }
    if (name) names.add(name);

    let ssh: string | null = null;
    if (!("ssh" in h)) {
      errors.push(`host ${name}: ssh is required (null: this host)`);
    } else if (h.ssh === null) {
      localCount += 1;
      ssh = null;
    } else if (typeof h.ssh !== "string" || !isValidSshAlias(h.ssh)) {
      errors.push(`host ${name}: ssh is not a host name`);
    } else {
      ssh = h.ssh;
    }

    if (h.role !== "ci") errors.push(`host ${name}: role is not ci`);
    if ("wsl" in h && (typeof h.wsl !== "string" || !HOST_NAME_RE.test(h.wsl))) {
      errors.push(`host ${name}: wsl is not a WSL distro name`);
    }
    if ("sudo" in h && (h.sudo !== true || "wsl" in h || h.ssh === null)) {
      errors.push(
        `host ${name}: sudo is true, for another machine's Linux guest whose CI user has sudo with no password, and never with wsl`,
      );
    }
    if (
      "on" in h &&
      (typeof h.on !== "string" || !HOST_NAME_RE.test(h.on) || h.on === name || h.ssh === null)
    ) {
      errors.push(`host ${name}: on is the name of the machine this guest runs on`);
    }
    if (
      "priority" in h &&
      (typeof h.priority !== "number" || !Number.isInteger(h.priority) || h.priority < 1)
    ) {
      errors.push(`host ${name}: priority is not a positive integer`);
    }

    let dataRoot: string;
    if (!("data_root" in h)) {
      dataRoot = h.ssh === null ? "/data/Dev" : "~/Dev-data";
      warnings.push(
        `WARNING: ci host ${name} declares no data_root; it is taken as ${dataRoot}; declare it in ${sourceLabel}`,
      );
    } else if (typeof h.data_root === "string") {
      dataRoot = h.data_root;
    } else {
      dataRoot = "";
    }
    const segs = dataRoot.split("/");
    if (!ROOT_PATH_RE.test(dataRoot) || segs.includes("..") || segs.includes(".")) {
      errors.push(`host ${name}: data_root is not an absolute directory or ~/DIR`);
    } else if (SOURCE_DEV_ROOT_RE.test(dataRoot)) {
      errors.push(`host ${name}: data_root is in the source root ~/Dev`);
    }

    hosts.push({
      name,
      ssh,
      role: "ci",
      data_root: dataRoot,
      ...(typeof h.priority === "number" ? { priority: h.priority } : {}),
      ...(typeof h.wsl === "string" ? { wsl: h.wsl } : {}),
      ...(h.sudo === true ? { sudo: true } : {}),
      ...(typeof h.on === "string" ? { on: h.on } : {}),
      ...(typeof h.note === "string" ? { note: h.note } : {}),
    });
  }

  if (localCount !== 1) {
    errors.push(`exactly one host has ssh null (this host); found ${localCount}`);
  }

  const rawToolchain =
    obj.toolchain && typeof obj.toolchain === "object" && !Array.isArray(obj.toolchain)
      ? (obj.toolchain as Record<string, unknown>)
      : null;
  if (!rawToolchain || Object.keys(rawToolchain).length === 0) {
    errors.push("toolchain is not a non-empty object");
  }

  const toolchain: Record<string, CiToolEntry> = {};
  const toolEntries = rawToolchain ? Object.entries(rawToolchain) : [];
  for (const [toolName, rawTool] of toolEntries) {
    if (!TOOL_NAME_RE.test(toolName)) {
      errors.push(`tool ${JSON.stringify(toolName)}: not a tool name`);
    }
    if (!checkClosed(rawTool, TOOL_FIELDS, `tool ${toolName}`)) continue;
    const t = rawTool as Record<string, unknown>;
    if (typeof t.version !== "string" || !VERSION_RANGE_RE.test(t.version)) {
      errors.push(`tool ${toolName}: version is not a range`);
    }
    if (typeof t.probe !== "string" || !t.probe.trim()) {
      errors.push(`tool ${toolName}: probe is required`);
    }
    if (
      !("install" in t) ||
      !(t.install === null || (typeof t.install === "string" && t.install.trim().length > 0))
    ) {
      errors.push(`tool ${toolName}: install is a command or null`);
    }
    for (const flag of ["base", "refresh", "optional"] as const) {
      if (flag in t && typeof t[flag] !== "boolean") {
        errors.push(`tool ${toolName}: ${flag} is not true/false`);
      }
    }
    if (t.optional === true && (t.base === true || t.refresh === true || t.install !== null)) {
      errors.push(
        `tool ${toolName}: an optional tool is neither a base tool nor provisioned nor refreshed (install null)`,
      );
    }
    if ("needs" in t) {
      const needs = t.needs;
      if (
        !Array.isArray(needs) ||
        needs.length === 0 ||
        new Set(needs).size !== needs.length ||
        !needs.every(
          (d) => typeof d === "string" && rawToolchain && d in rawToolchain && d !== toolName,
        )
      ) {
        errors.push(`tool ${toolName}: needs is a list of other tools of the toolchain, each once`);
      }
    }
    if ("os" in t) {
      const oses = t.os;
      if (
        !Array.isArray(oses) ||
        oses.length === 0 ||
        new Set(oses).size !== oses.length ||
        !oses.every((o) => typeof o === "string" && OS_NAMES.has(o))
      ) {
        errors.push(`tool ${toolName}: os is a list of the systems it applies to, each once`);
      }
    }
    if ("root" in t) {
      const rootObj = t.root;
      if (
        !rootObj ||
        typeof rootObj !== "object" ||
        Array.isArray(rootObj) ||
        Object.keys(rootObj).length === 0
      ) {
        errors.push(`tool ${toolName}: root is an object of system -> command (darwin, linux)`);
      } else {
        for (const [osKey, cmd] of Object.entries(rootObj as Record<string, unknown>)) {
          const allowedOses = Array.isArray(t.os) ? t.os : null;
          if (!OS_NAMES.has(osKey) || (allowedOses && !allowedOses.includes(osKey))) {
            errors.push(
              `tool ${toolName}: root names ${JSON.stringify(osKey)}, not a system the tool applies to`,
            );
            continue;
          }
          const why = validateRootCommand(cmd);
          if (why) errors.push(`tool ${toolName}: root command for ${osKey} ${why}`);
        }
      }
    }
    toolchain[toolName] = {
      version: typeof t.version === "string" ? t.version : "*",
      probe: typeof t.probe === "string" ? t.probe : "",
      install: typeof t.install === "string" ? t.install : null,
      ...(t.base === true ? { base: true } : {}),
      ...(t.refresh === true ? { refresh: true } : {}),
      ...(t.optional === true ? { optional: true } : {}),
      ...(Array.isArray(t.os) ? { os: t.os as string[] } : {}),
      ...(Array.isArray(t.needs) ? { needs: t.needs as string[] } : {}),
      ...(t.root && typeof t.root === "object" && !Array.isArray(t.root)
        ? { root: t.root as Record<string, string> }
        : {}),
      ...(typeof t.note === "string" ? { note: t.note } : {}),
    };
  }

  let guards: CiGuardsEntry | undefined;
  if (obj.guards !== undefined && obj.guards !== null) {
    if (checkClosed(obj.guards, GUARDS_FIELDS, "guards")) {
      const g = obj.guards as Record<string, unknown>;
      if (typeof g.install !== "string") {
        errors.push("guards: install is required");
      } else {
        guards = {
          install: g.install,
          ...(typeof g.note === "string" ? { note: g.note } : {}),
        };
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors, warnings };
  return {
    ok: true,
    manifest: {
      schema: 1,
      ...(typeof obj.note === "string" ? { note: obj.note } : {}),
      hosts,
      toolchain,
      ...(guards ? { guards } : {}),
    },
    errors: [],
    warnings,
  };
}

/** Loads and strictly validates a `ci-hosts.json` manifest from disk. */
export function loadCiHostsManifest(
  options: ResolveCiHostsPathOptions = {},
): ManifestValidationResult & { readonly path: string | null } {
  const filePath = options.overridePath?.trim() || resolveCiHostsPath(options);
  if (!filePath) {
    return {
      ok: false,
      path: null,
      errors: ["ci-hosts.json not found"],
      warnings: [],
    };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(NodeFS.readFileSync(filePath, "utf8")) as unknown;
  } catch (err) {
    return {
      ok: false,
      path: filePath,
      errors: [`not readable JSON (${err instanceof Error ? err.message : String(err)})`],
      warnings: [],
    };
  }
  return { ...validateCiHostsManifest(raw, filePath), path: filePath };
}
