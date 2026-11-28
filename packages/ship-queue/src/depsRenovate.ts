// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Pinned Renovate CLI lookup: available dependency and tool-pin updates for one repo commit.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { DepUpdateItem } from "./depsTypes.ts";
import { nodeProcessRunner } from "./nodeProcess.ts";
import { buildRenovateCustomManagers, type PinsSpec, validatePinsSpec } from "./pins.ts";
import type { ProcessRunner } from "./types.ts";

const RENOVATE_TIMEOUT_MS = 30 * 60_000;
const PINS_PATH = "infra/ci-host/sq_pins.json";

/**
 * Drops the tool-pin updates `sq_pins.json` never offers: a new major, or a new minor of a 0.x
 * release, unless the pin sets `major`; and, for a `monthEnd` pin, any release that is not the
 * last build of its month (YYYY-MM-DD... versions).
 */
export function applyPinLimits(
  result: RenovateLookupResult,
  pins: PinsSpec | undefined,
): RenovateLookupResult {
  if (!pins) return result;
  const byDep = new Map(pins.pins.map((pin) => [`${pin.file}\0${pin.depName}`, pin]));
  const updates = result.updates.filter((update) => {
    const pin = byDep.get(`${update.packageFile}\0${update.depName}`);
    if (!pin) return true;
    const current = update.currentVersion ?? update.currentValue;
    const next = update.newVersion ?? update.newValue;
    if (!pin.major) {
      const [curMajor = "", curMinor = ""] = current.split(".");
      const [newMajor = "", newMinor = ""] = next.split(".");
      if (curMajor !== newMajor) return false;
      if (curMajor === "0" && curMinor !== newMinor) return false;
    }
    if (pin.monthEnd) {
      const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(next);
      if (!m) return false;
      const lastDay = new Date(Date.UTC(Number(m[1]), Number(m[2]), 0)).getUTCDate();
      if (Number(m[3]) !== lastDay) return false;
    }
    return true;
  });
  return { updates, incomplete: result.incomplete };
}

/**
 * Package rules so Renovate picks the newest release `sq_pins.json` allows (allowedVersions; no
 * new major or 0.x minor without `major`; monthEnd pins: last days of a month only), not a newer
 * one that `applyPinLimits` would then drop.
 */
export function buildPinPackageRules(pins: PinsSpec): ReadonlyArray<Record<string, unknown>> {
  const rules: Array<Record<string, unknown>> = [];
  for (const pin of pins.pins) {
    const match = { matchFileNames: [pin.file], matchDepNames: [pin.depName] };
    if (pin.allowedVersions) rules.push({ ...match, allowedVersions: pin.allowedVersions });
    // A later rule replaces an earlier one's allowedVersions, so the window applies only when
    // the pin declares no exact range of its own.
    if (pin.monthEnd && !pin.allowedVersions) {
      rules.push({ ...match, allowedVersions: "/^\\d{4}-\\d{2}-(28|29|30|31)-/" });
    }
    if (!pin.major) {
      // A patch candidate apart from a minor one, so a pin held off the next minor sees patches.
      rules.push({ ...match, separateMinorPatch: true });
      rules.push({ ...match, matchUpdateTypes: ["major"], enabled: false });
      rules.push({
        ...match,
        matchCurrentVersion: "/^v?0\\./",
        matchUpdateTypes: ["minor"],
        enabled: false,
      });
    }
  }
  return rules;
}

/** Skip reasons that are Renovate's deliberate choice, not a failed assessment. */
const DELIBERATE_SKIPS: ReadonlySet<string> = new Set([
  "unspecified-version",
  "internal-package",
  "file-dependency",
  "local-dependency",
  "path-dependency",
  "local",
  "file",
  "disabled",
  "ignored",
  "package-rules",
  "is-pinned",
  "lockfile-only",
]);

/** Renovate's records for a manifest or workspace file it could not parse, then dropped. */
const UNPARSED_MESSAGES: ReadonlySet<string> = new Set([
  "Invalid JSON",
  "Error parsing package.json",
  "Failed to parse pnpm-workspace.yaml",
  "Failed to parse pnpm-workspace.yaml file",
  // An unreadable .yarnrc.yml is a warning: its catalog and registry are then dropped.
  "Failed to load yarnrc file",
]);

/**
 * `unspecified-version` covers both a workspace reference and any version Renovate cannot use
 * (for example an external git reference): only `workspace:` and `catalog:` references, and a
 * pnpm override that removes a dependency (`-`), are deliberate.
 */
function isDeliberateSkip(skip: string, dep: { readonly currentValue?: string }): boolean {
  // A pnpm override of "-" removes that dependency on purpose.
  if (skip === "unspecified-version") {
    return /^(workspace|catalog):/.test(dep.currentValue ?? "") || dep.currentValue === "-";
  }
  return DELIBERATE_SKIPS.has(skip);
}

export interface RenovateLookupResult {
  readonly updates: ReadonlyArray<DepUpdateItem>;
  readonly incomplete: ReadonlyArray<string>;
}

/** The pinned Renovate CLI that `infra/ci-host/deps-install.sh` installs on the queue host. */
export function defaultRenovateBin(homeDir: string = NodeOS.homedir()): string {
  return NodePath.join(
    homeDir,
    ".local",
    "share",
    "ship-queue-ci",
    "renovate",
    "node_modules",
    ".bin",
    "renovate",
  );
}

interface RenovateDep {
  readonly depName?: string;
  readonly currentValue?: string;
  readonly currentVersion?: string;
  readonly skipReason?: string;
  readonly warnings?: ReadonlyArray<unknown>;
  readonly updates?: ReadonlyArray<{
    readonly newValue?: string;
    readonly newVersion?: string;
    readonly releaseTimestamp?: string | null;
  }>;
}

interface RenovatePackageFile {
  readonly packageFile?: string;
  readonly deps?: ReadonlyArray<RenovateDep>;
}

/**
 * Reads Renovate's JSON log and returns the updates of its single "packageFiles with updates"
 * record. Throws when Renovate logged an error, did not finish, or the record is missing or
 * ambiguous, so a failed lookup never reads as "no updates".
 */
export function parseRenovateLookupLog(logText: string): RenovateLookupResult {
  return parseLookupLog(logText).result;
}

/** Each dependency Renovate assessed, by `file\0depName`, with the value it read. */
type AssessedDeps = ReadonlyMap<string, string>;

function parseLookupLog(logText: string): {
  readonly result: RenovateLookupResult;
  readonly assessed: AssessedDeps;
} {
  const records: Array<Record<string, unknown>> = [];
  for (const line of logText.split("\n")) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      // Renovate writes only JSON lines to its log file; skip anything else.
    }
  }
  const errors = records
    .filter((r) => typeof r.level === "number" && r.level >= 50)
    .map((r) => String(r.msg ?? "Renovate error"));
  if (errors.length > 0) throw new Error(`Renovate failed: ${errors.join("; ")}`);
  if (!records.some((r) => r.msg === "Repository finished")) {
    throw new Error("Renovate did not finish the repository");
  }
  // A manifest the extractor could not parse is dropped from the lookup without an error.
  const unreadable = records
    .filter((r) => typeof r.msg === "string" && UNPARSED_MESSAGES.has(r.msg))
    .map((r) => {
      const file =
        r.packageFile ?? r.fileName ?? (/yarnrc/.test(String(r.msg)) ? ".yarnrc.yml" : null);
      return `${String(file ?? "a package file")}: could not be parsed`;
    });
  const found = records.filter((r) => r.msg === "packageFiles with updates");
  if (found.length !== 1) throw new Error("Renovate lookup output is missing or ambiguous");
  const byManager = (found[0]?.config ?? {}) as Record<string, ReadonlyArray<RenovatePackageFile>>;

  const updates: DepUpdateItem[] = [];
  const incomplete: string[] = [...new Set(unreadable)];
  const assessed = new Map<string, string>();
  for (const packageFiles of Object.values(byManager)) {
    for (const pkg of packageFiles ?? []) {
      const packageFile = pkg.packageFile ?? "unknown";
      for (const dep of pkg.deps ?? []) {
        const depName = dep.depName ?? "unknown";
        assessed.set(`${packageFile}\0${depName}`, dep.currentValue ?? dep.currentVersion ?? "");
        // Only Renovate's deliberate skips (workspace and local references, disabled or ignored
        // deps) are skips; any other skip reason, or a warning, is a failed assessment.
        const skip = dep.skipReason;
        if ((dep.warnings && dep.warnings.length > 0) || (skip && !isDeliberateSkip(skip, dep))) {
          incomplete.push(`${packageFile}: ${depName}${skip ? ` (${skip})` : ""}`);
          continue;
        }
        for (const update of dep.updates ?? []) {
          updates.push({
            packageFile,
            depName,
            currentValue: dep.currentValue ?? dep.currentVersion ?? "",
            newValue: update.newValue ?? update.newVersion ?? "",
            ...(dep.currentVersion ? { currentVersion: dep.currentVersion } : {}),
            ...(update.newVersion ? { newVersion: update.newVersion } : {}),
            releaseTimestamp: update.releaseTimestamp ?? null,
          });
        }
      }
    }
  }
  return { result: { updates, incomplete }, assessed };
}

/**
 * A declared tool pin Renovate never reported is not assessed: its file is missing from the
 * commit, its pattern no longer matches, or Renovate read another value than the pattern does.
 * Each such pin makes the report incomplete, so it is never clean or approvable.
 */
export function reconcileDeclaredPins(
  pins: PinsSpec,
  files: ReadonlyMap<string, Uint8Array>,
  assessed: AssessedDeps,
): ReadonlyArray<string> {
  const missing: string[] = [];
  for (const pin of pins.pins) {
    const label = `${pin.file}: ${pin.depName}`;
    const blob = files.get(pin.file);
    if (!blob) {
      missing.push(`${label} (the pin's file is not in the commit)`);
      continue;
    }
    let matched: string | undefined;
    try {
      const found = new RegExp(pin.match, "m").exec(new TextDecoder().decode(blob));
      matched = found?.groups?.currentValue ?? found?.groups?.currentDigest;
    } catch {
      matched = undefined;
    }
    if (!matched) {
      missing.push(`${label} (the pin's pattern matches no version)`);
      continue;
    }
    const read = assessed.get(`${pin.file}\0${pin.depName}`);
    if (read === undefined) missing.push(`${label} (Renovate reported no lookup for this pin)`);
    else if (read !== matched)
      missing.push(`${label} (Renovate read ${read}, the pin says ${matched})`);
  }
  return missing;
}

/**
 * Runs the pinned Renovate CLI in lookup mode over a commit's dependency files (npm manifests and
 * the repo's `sq_pins.json` tool pins, as regex managers). It reads `tree`, the directory the
 * reader extracted the exact digested bytes into, so the checkout's working tree never matters.
 */
export async function renovateLookup(input: {
  /** A directory holding each dependency file's exact digested bytes, by repo path. */
  readonly tree: string;
  /** The dependency files in `tree`. */
  readonly paths: ReadonlyArray<string>;
  readonly pinsText?: string | undefined;
  readonly renovateBin?: string | undefined;
  readonly run?: ProcessRunner | undefined;
}): Promise<RenovateLookupResult> {
  // No dependency files: nothing to look up.
  if (input.paths.length === 0) return { updates: [], incomplete: [] };
  const run = input.run ?? nodeProcessRunner;
  const renovateBin = input.renovateBin ?? defaultRenovateBin();
  if (!NodeFS.existsSync(renovateBin)) {
    throw new Error(
      `Renovate is not installed (${renovateBin}); run infra/ci-host/deps-install.sh`,
    );
  }
  const work = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "sq-renovate-"));
  try {
    const tree = input.tree;

    const pins = input.pinsText
      ? validatePinsSpec(JSON.parse(input.pinsText), PINS_PATH)
      : undefined;
    const customManagers = pins ? buildRenovateCustomManagers(pins) : [];
    const config = {
      platform: "local",
      dryRun: "lookup",
      onboarding: false,
      requireConfig: "ignored",
      automerge: false,
      dependencyDashboard: false,
      baseDir: NodePath.join(work, "base"),
      enabledManagers: ["npm", ...(customManagers.length > 0 ? ["custom.regex"] : [])],
      customManagers,
      packageRules: pins ? buildPinPackageRules(pins) : [],
    };
    const globalConfig = NodePath.join(work, "global.json");
    NodeFS.writeFileSync(globalConfig, "{}\n");
    const logFile = NodePath.join(work, "renovate.jsonl");
    // No gh, or no login, means no token: Renovate still runs, and rate-limited lookups come
    // back as warnings, which make the report incomplete rather than clean.
    const token = await run({
      command: "gh",
      args: ["auth", "token"],
      cwd: work,
      timeoutMs: 30_000,
    }).catch(() => ({ exitCode: 127, stdout: "", stderr: "gh is not installed" }));
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined && !key.startsWith("RENOVATE_") && !key.startsWith("LOG_")) {
        env[key] = value;
      }
    }
    Object.assign(env, {
      // Renovate logs JSON to stdout; the shell sends it to a file, past the runner's output cap.
      LOG_LEVEL: "debug",
      LOG_FORMAT: "json",
      RENOVATE_CONFIG: JSON.stringify(config),
      RENOVATE_CONFIG_FILE: globalConfig,
      ...(token.exitCode === 0 && token.stdout.trim()
        ? { RENOVATE_TOKEN: token.stdout.trim(), GITHUB_COM_TOKEN: token.stdout.trim() }
        : {}),
    });
    const res = await run({
      command: "bash",
      args: ["-c", 'exec "$0" > "$1" 2>&1', renovateBin, logFile],
      cwd: tree,
      env,
      replaceEnv: true,
      timeoutMs: RENOVATE_TIMEOUT_MS,
    });
    const logText = NodeFS.existsSync(logFile) ? NodeFS.readFileSync(logFile, "utf8") : "";
    if (res.exitCode !== 0) {
      const tail = (res.stderr || logText).trim().split("\n").slice(-3).join(" | ").slice(0, 600);
      throw new Error(`Renovate exited ${res.exitCode}${tail ? `: ${tail}` : ""}`);
    }
    const { result, assessed } = parseLookupLog(logText);
    // The pins' source files are a few small fixed files; read only those.
    const pinFiles = new Map<string, Uint8Array>();
    for (const file of new Set(pins?.pins.map((pin) => pin.file) ?? [])) {
      if (input.paths.includes(file))
        pinFiles.set(file, NodeFS.readFileSync(NodePath.join(tree, file)));
    }
    const unassessed = pins ? reconcileDeclaredPins(pins, pinFiles, assessed) : [];
    return applyPinLimits(
      unassessed.length > 0
        ? { updates: result.updates, incomplete: [...result.incomplete, ...unassessed] }
        : result,
      pins,
    );
  } finally {
    NodeFS.rmSync(work, { recursive: true, force: true });
  }
}
