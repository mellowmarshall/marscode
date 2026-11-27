// @effect-diagnostics nodeBuiltinImport:off - CI needs evaluator: Playwright lockfile/fixture filter + waiver, compose services, and dynamic ship_ci_needs.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { CiHostsManifest } from "./ciHosts.ts";
import { parseToolSpec } from "./ciToolVersion.ts";
import { parseShipDeclaration, type ShipDeclaration } from "./declaration.ts";
import { resolveStepArgv } from "./stepRunner.ts";
import { buildToolchainEnv } from "./toolchainEnv.ts";
import type { ProcessRunner } from "./types.ts";

const LOCKFILE_RE =
  /(^|\/)(pnpm-lock\.yaml|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|bun\.lock)$/;
const IGNORED_FIXTURE_PATH_RE = /(^|\/)(\.repos|fixtures?|__fixtures__|vendor|third_party)\//;
const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?$/;
const SERVICE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export const COMPOSE_FILES: ReadonlyArray<string> = [
  "compose.yaml",
  "compose.yml",
  "docker-compose.yml",
  "docker-compose.yaml",
];
export const COMPOSE_OVERRIDES: ReadonlyArray<string> = [
  "compose.override.yml",
  "compose.override.yaml",
  "docker-compose.override.yml",
  "docker-compose.override.yaml",
];

interface SemverKey {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly release: number; // 0 for prerelease, 1 for stable
}

function parseSemverKey(version: string): SemverKey | null {
  const m = SEMVER_RE.exec(version);
  if (!m) return null;
  return {
    major: Number.parseInt(m[1]!, 10),
    minor: Number.parseInt(m[2]!, 10),
    patch: Number.parseInt(m[3]!, 10),
    release: m[4] ? 0 : 1,
  };
}

export function compareSemver(a: string, b: string): number {
  const ka = parseSemverKey(a);
  const kb = parseSemverKey(b);
  if (!ka || !kb) return a.localeCompare(b);
  if (ka.major !== kb.major) return ka.major - kb.major;
  if (ka.minor !== kb.minor) return ka.minor - kb.minor;
  if (ka.patch !== kb.patch) return ka.patch - kb.patch;
  return ka.release - kb.release;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parsePnpmLock(pkgName: string, text: string): Set<string> {
  if (!/^lockfileVersion:\s*['"]?\d/m.test(text)) {
    throw new Error("no lockfileVersion line: not a pnpm lockfile");
  }
  const re = new RegExp(`^\\s+['"]?/?${escapeRegExp(pkgName)}[@/]([^:'"(\\s_]*)`, "gm");
  const out = new Set<string>();
  for (const match of text.matchAll(re)) {
    out.add(match[1] ?? "");
  }
  return out;
}

function parseNpmLock(pkgName: string, text: string): Set<string> {
  const parsed = JSON.parse(text) as unknown;
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    typeof (parsed as Record<string, unknown>).lockfileVersion !== "number"
  ) {
    throw new Error("no lockfileVersion: not an npm lockfile");
  }
  const doc = parsed as Record<string, unknown>;
  const out = new Set<string>();
  const packages = doc.packages;
  if (packages && typeof packages === "object" && !Array.isArray(packages)) {
    for (const [key, val] of Object.entries(packages as Record<string, unknown>)) {
      if (
        (key === `node_modules/${pkgName}` || key.endsWith(`/node_modules/${pkgName}`)) &&
        val &&
        typeof val === "object"
      ) {
        out.add(String((val as Record<string, unknown>).version ?? ""));
      }
    }
  }
  const walkDeps = (deps: unknown) => {
    if (!deps || typeof deps !== "object" || Array.isArray(deps)) return;
    for (const [k, v] of Object.entries(deps as Record<string, unknown>)) {
      if (!v || typeof v !== "object" || Array.isArray(v)) continue;
      const rec = v as Record<string, unknown>;
      if (k === pkgName) out.add(String(rec.version ?? ""));
      walkDeps(rec.dependencies);
    }
  };
  walkDeps(doc.dependencies);
  return out;
}

function parseYarnLock(pkgName: string, text: string): Set<string> {
  if (!/^(# yarn lockfile v1|__metadata:)\s*$/m.test(text)) {
    throw new Error("neither the yarn v1 header nor __metadata: not a yarn lockfile");
  }
  const out = new Set<string>();
  let inside = false;
  for (const line of text.split(/\r?\n/)) {
    if (line.length > 0 && !/^\s/.test(line) && line.trimEnd().endsWith(":")) {
      if (inside) throw new Error(`an entry for ${pkgName} has no version`);
      const header = line.trimEnd().slice(0, -1);
      const specs = header.split(",").map((s) => s.trim().replace(/^["']|["']$/g, ""));
      inside = specs.some((spec) => {
        const body = spec.startsWith("@") ? spec.slice(1) : spec;
        const at = body.lastIndexOf("@");
        if (at < 0) return false;
        const namePart = (spec.startsWith("@") ? "@" : "") + body.slice(0, at);
        return namePart === pkgName;
      });
    } else if (inside) {
      const m = /^\s+version:?\s+"?([^"\s]+)"?\s*$/.exec(line);
      if (m?.[1]) {
        out.add(m[1]);
        inside = false;
      }
    }
  }
  if (inside) throw new Error(`an entry for ${pkgName} has no version`);
  return out;
}

function parseBunLock(pkgName: string, text: string): Set<string> {
  const cleaned = text.replace(/,(\s*[}\]])/g, "$1");
  const parsed = JSON.parse(cleaned) as unknown;
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    typeof (parsed as Record<string, unknown>).lockfileVersion !== "number"
  ) {
    throw new Error("no lockfileVersion: not a bun lockfile");
  }
  const packages = (parsed as Record<string, unknown>).packages;
  const out = new Set<string>();
  if (packages && typeof packages === "object" && !Array.isArray(packages)) {
    for (const [k, v] of Object.entries(packages as Record<string, unknown>)) {
      if (
        (k === pkgName || k.endsWith(`/${pkgName}`)) &&
        Array.isArray(v) &&
        typeof v[0] === "string"
      ) {
        const at = v[0].lastIndexOf("@");
        if (at > 0 && v[0].slice(0, at) === pkgName) {
          out.add(v[0].slice(at + 1));
        }
      }
    }
  }
  return out;
}

/** Extracts every locked version of `packageName` from a supported lockfile; throws on unreadable lockfiles or non-release versions. */
export function extractLockedVersions(
  packageName: string,
  lockfilePath: string,
  text: string,
): ReadonlyArray<string> {
  const base = NodePath.posix.basename(lockfilePath.replaceAll("\\", "/"));
  let found: Set<string>;
  if (base === "pnpm-lock.yaml") found = parsePnpmLock(packageName, text);
  else if (base === "package-lock.json" || base === "npm-shrinkwrap.json") {
    found = parseNpmLock(packageName, text);
  } else if (base === "yarn.lock") found = parseYarnLock(packageName, text);
  else if (base === "bun.lock") found = parseBunLock(packageName, text);
  else throw new Error(`${lockfilePath} is not a supported lockfile`);

  const bad = [...found].filter((v) => parseSemverKey(v) === null).toSorted();
  if (bad.length > 0) {
    throw new Error(
      `${lockfilePath} locks ${packageName} at ${bad.map((b) => JSON.stringify(b)).join(", ")}, not a release number`,
    );
  }
  return [...found].toSorted(compareSemver);
}

/** Returns locked versions of `packageName` strictly older than `haveVersion`. */
export function findOlderLockedVersions(
  packageName: string,
  haveVersion: string,
  lockfilePath: string,
  text: string,
): ReadonlyArray<string> {
  if (!parseSemverKey(haveVersion)) {
    throw new Error(`invalid reference version: ${haveVersion}`);
  }
  return extractLockedVersions(packageName, lockfilePath, text).filter(
    (v) => compareSemver(v, haveVersion) < 0,
  );
}

/** Filters repo file paths to lockfiles eligible for Playwright version enforcement (excluding fixture/vendor trees). */
export function filterPlaywrightLockfiles(paths: ReadonlyArray<string>): ReadonlyArray<string> {
  return paths.filter((p) => LOCKFILE_RE.test(p) && !IGNORED_FIXTURE_PATH_RE.test(p));
}

/** Checks whether `~/.local/lib/exceptions.json` waives Playwright checks for `repoName`. */
export function isPlaywrightWaived(
  repoName: string,
  exceptionsPath = NodePath.join(NodeOS.homedir(), ".local", "lib", "exceptions.json"),
): boolean {
  if (!repoName.trim() || !NodeFS.existsSync(exceptionsPath)) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(NodeFS.readFileSync(exceptionsPath, "utf8")) as unknown;
  } catch {
    return false;
  }
  const repos =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as { readonly repos?: unknown }).repos
      : null;
  if (!repos || typeof repos !== "object" || Array.isArray(repos)) return false;
  const target = repoName.trim().toLowerCase();
  const repoMap = repos as Record<string, unknown>;
  for (const key of ["*", target]) {
    const entry = repoMap[key];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const pb = (entry as { readonly playbook?: unknown }).playbook;
    if (!pb || typeof pb !== "object" || Array.isArray(pb)) continue;
    for (const [k, v] of Object.entries(pb as Record<string, unknown>)) {
      let nk = k.trim().toLowerCase();
      if (nk.startsWith("§") && /^\d+$/.test(nk.slice(1))) nk = nk.slice(1);
      if (
        (nk === "*" ||
          nk === "all" ||
          nk === "ci" ||
          nk === "ci-standards" ||
          nk === "15" ||
          nk === "playwright") &&
        typeof v === "string" &&
        v.trim().length > 0
      ) {
        return true;
      }
    }
  }
  return false;
}

export interface PlaywrightNeedsCheckResult {
  readonly ok: boolean;
  readonly waived?: boolean | undefined;
  readonly reason?: string | undefined;
  readonly lockfilesChecked: ReadonlyArray<string>;
}

/** Verifies that committed non-fixture lockfiles do not lock a `playwright-core` older than the CI host's version. */
export function checkPlaywrightNeeds(input: {
  readonly repoName: string;
  readonly files: Readonly<Record<string, string>>;
  readonly ciPlaywrightVersion: string | null;
  readonly exceptionsPath?: string | undefined;
}): PlaywrightNeedsCheckResult {
  if (isPlaywrightWaived(input.repoName, input.exceptionsPath)) {
    return { ok: true, waived: true, lockfilesChecked: [] };
  }
  const candidates = filterPlaywrightLockfiles(Object.keys(input.files).toSorted());
  const lockingFiles: string[] = [];
  for (const relPath of candidates) {
    try {
      const versions = extractLockedVersions(
        "playwright-core",
        relPath,
        input.files[relPath] ?? "",
      );
      if (versions.length > 0) lockingFiles.push(relPath);
    } catch (err) {
      return {
        ok: false,
        lockfilesChecked: candidates,
        reason: `the lockfile ${relPath} cannot be read for its playwright-core: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
  if (lockingFiles.length === 0) {
    return { ok: true, lockfilesChecked: candidates };
  }
  if (!input.ciPlaywrightVersion || !/^\d+\.\d+\.\d+$/.test(input.ciPlaywrightVersion)) {
    return {
      ok: false,
      lockfilesChecked: lockingFiles,
      reason: `unproven: the repo locks playwright-core (${lockingFiles.join(" ")}), and this host's CI playwright-core has no readable version`,
    };
  }
  const older: string[] = [];
  for (const relPath of lockingFiles) {
    const oldVers = findOlderLockedVersions(
      "playwright-core",
      input.ciPlaywrightVersion,
      relPath,
      input.files[relPath] ?? "",
    );
    for (const v of oldVers) older.push(`${relPath}:${v}`);
  }
  if (older.length > 0) {
    return {
      ok: false,
      lockfilesChecked: lockingFiles,
      reason: `the repo locks a playwright-core older than ${input.ciPlaywrightVersion}: ${older.join(" ")}`,
    };
  }
  return { ok: true, lockfilesChecked: lockingFiles };
}

/** Returns setting -> tool specs map from a declaration. */
export function declarationSettingMap(
  decl: ShipDeclaration,
): ReadonlyMap<string, ReadonlyArray<string>> {
  const map = new Map<string, string[]>();
  for (const raw of decl.ciSettings) {
    const parts = raw.trim().split(/\s+/);
    const name = parts[0];
    const spec = parts.slice(1).join(" ");
    if (!name || !spec) continue;
    const arr = map.get(name) ?? [];
    arr.push(spec);
    map.set(name, arr);
  }
  return map;
}

/** Evaluates a repository's dynamic `ship_ci_needs` script to compute extra tool specs for a job. */
export async function evaluateJobCiNeeds(input: {
  readonly decl: ShipDeclaration;
  readonly manifest: CiHostsManifest;
  readonly stepTree: string;
  readonly worktree: string;
  readonly baseRef: string;
  readonly run: ProcessRunner;
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
}): Promise<
  | {
      readonly ok: true;
      readonly settings: ReadonlyArray<string>;
      readonly toolSpecs: ReadonlyArray<string>;
    }
  | { readonly ok: false; readonly reason: string }
> {
  if (!input.decl.ciNeeds) {
    return { ok: true, settings: [], toolSpecs: [] };
  }
  const argvRes = resolveStepArgv(input.stepTree, input.decl.ciNeeds);
  if (!argvRes.ok) {
    return { ok: false, reason: `ship_ci_needs: ${argvRes.error}` };
  }
  const [command, ...args] = argvRes.argv;
  const env = buildToolchainEnv(input.env ?? process.env);
  env.SHIP_QUEUE_BASE_REF = input.baseRef;
  env.SHIP_QUEUE_BASE_TREE = input.stepTree;
  const res = await input.run({ command: command!, args, cwd: input.worktree, env });
  if (res.exitCode !== 0) {
    return { ok: false, reason: `ship_ci_needs exited ${res.exitCode}; the CI was not routed` };
  }

  const settingMap = declarationSettingMap(input.decl);
  const settings: string[] = [];
  const specs = new Set<string>();
  const lines = res.stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  for (const name of lines) {
    const toolList = settingMap.get(name);
    if (!toolList) {
      return {
        ok: false,
        reason: `ship_ci_needs output refused: '${name}' is not a declared CI setting`,
      };
    }
    if (settings.includes(name)) {
      return {
        ok: false,
        reason: `ship_ci_needs output refused: ${name} is printed more than once`,
      };
    }
    settings.push(name);
    for (const spec of toolList) {
      const parsed = parseToolSpec(spec, input.manifest.toolchain);
      if (!parsed.ok) {
        return {
          ok: false,
          reason: `ship_ci_needs output refused: setting ${name}: ${parsed.error}`,
        };
      }
      specs.add(spec);
    }
  }
  return { ok: true, settings, toolSpecs: [...specs] };
}

/** Resolves compose files present in a set of committed repo files. */
export function resolveComposeFiles(
  committedFiles: ReadonlySet<string>,
):
  | { readonly ok: true; readonly files: ReadonlyArray<string> }
  | { readonly ok: false; readonly reason: string } {
  const base = COMPOSE_FILES.find((f) => committedFiles.has(f));
  if (!base) {
    return { ok: false, reason: `it commits no compose file (${COMPOSE_FILES.join(" ")})` };
  }
  const override = COMPOSE_OVERRIDES.find((f) => committedFiles.has(f));
  return { ok: true, files: override ? [base, override] : [base] };
}

/** Merges base declaration services with branch additions/removals and validates against compose services. */
export function resolveJobCiServices(input: {
  readonly baseDecl: ShipDeclaration;
  readonly tipConfText: string;
  readonly tipPlaybookText?: string | undefined;
  readonly composeServices: ReadonlySet<string>;
}):
  | {
      readonly ok: true;
      readonly services: ReadonlyArray<string>;
      readonly added: ReadonlyArray<string>;
      readonly dropped: ReadonlyArray<string>;
    }
  | { readonly ok: false; readonly reason: string } {
  const tipDecl = parseShipDeclaration(input.tipConfText, input.tipPlaybookText ?? "");
  const added: string[] = [];
  for (const s of tipDecl.ciServices) {
    if (input.baseDecl.ciServices.includes(s) || added.includes(s)) continue;
    if (!SERVICE_NAME_RE.test(s)) {
      return {
        ok: false,
        reason: `ship_ci_service '${s}' added by branch is not a valid service name`,
      };
    }
    added.push(s);
  }
  const dropped: string[] = [];
  for (const s of input.baseDecl.ciServices) {
    if (input.composeServices.has(s)) continue;
    if (!tipDecl.ciServices.includes(s)) {
      dropped.push(s);
      continue;
    }
    return { ok: false, reason: `ship_ci_service '${s}' is not defined in compose configuration` };
  }
  for (const s of added) {
    if (!input.composeServices.has(s)) {
      return {
        ok: false,
        reason: `ship_ci_service '${s}' added by branch is not defined in compose configuration`,
      };
    }
  }
  const services = [...input.baseDecl.ciServices.filter((s) => !dropped.includes(s)), ...added];
  return { ok: true, services, added, dropped };
}
