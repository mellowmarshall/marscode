// @effect-diagnostics nodeBuiltinImport:off - Validation and pinned base step-tree extraction for parsed ship declarations.
import * as NodeFS from "node:fs";

import type { CiHostsManifest } from "./ciHosts.ts";
import { parseToolSpec } from "./ciToolVersion.ts";
import {
  declaredStepPaths,
  isValidCiRelativePath,
  scriptOfCommand,
  type ShipDeclaration,
} from "./declaration.ts";
import { CI_SECRET_NAMES } from "./dopplerBroker.ts";
import type { ProcessRunner } from "./types.ts";

const SERVICE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SETTING_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
const REPO_NAME_RE = /^[A-Za-z0-9._-]+$/;
const GH_REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const DOPPLER_PAIR_RE = /^[a-z0-9][a-z0-9_-]*\/[a-z0-9][a-z0-9_-]*$/;

export interface DeclarationValidationOptions {
  readonly manifest?: CiHostsManifest | undefined;
  readonly existingFiles?: ReadonlySet<string> | undefined;
}

export interface DeclarationValidationResult {
  readonly ok: boolean;
  readonly errors: ReadonlyArray<string>;
  readonly warnings: ReadonlyArray<string>;
}

/** Validates a parsed declaration against repository constraints and the CI hosts manifest. */
export function validateShipDeclaration(
  decl: ShipDeclaration,
  options: DeclarationValidationOptions = {},
): DeclarationValidationResult {
  const errors: string[] = [];

  if (!decl.repo || !REPO_NAME_RE.test(decl.repo)) {
    errors.push(`ship_repo '${decl.repo}' is missing or invalid`);
  }
  if (decl.ghRepo && !GH_REPO_RE.test(decl.ghRepo)) {
    errors.push(`ship_gh_repo '${decl.ghRepo}' must be OWNER/NAME`);
  }
  if (decl.junkBad.length > 0) {
    errors.push(
      `ship_junk_allow entries must include ' -- ' followed by a 10+ char reason: ${decl.junkBad.join(", ")}`,
    );
  }
  for (const secret of decl.ciSecrets) {
    if (!CI_SECRET_NAMES.has(secret)) {
      errors.push(`ship_ci_secret '${secret}' is not an allowed CI secret`);
    }
  }
  for (const pair of decl.ciDoppler) {
    if (!DOPPLER_PAIR_RE.test(pair)) {
      errors.push(`ship_ci_doppler '${pair}' is not PROJECT/CONFIG`);
    }
  }
  for (const service of decl.ciServices) {
    if (!SERVICE_NAME_RE.test(service)) {
      errors.push(`ship_ci_service '${service}' is not a valid compose service name`);
    }
  }
  for (const p of decl.ciPaths) {
    if (p.startsWith("/")) {
      errors.push(`ship_ci_path '${p}' is absolute; declare it relative to $SHIP_QUEUE_DATA_ROOT`);
    } else if (!isValidCiRelativePath(p)) {
      errors.push(`ship_ci_path '${p}' is not a safe relative directory path`);
    }
  }

  const settingSpecs = new Map<string, string[]>();
  for (const rawSetting of decl.ciSettings) {
    const parts = rawSetting.trim().split(/\s+/);
    const name = parts[0] ?? "";
    const spec = parts.slice(1).join(" ");
    if (!SETTING_NAME_RE.test(name) || !spec) {
      errors.push(`ship_ci_setting '${rawSetting}' is not NAME TOOL[@RANGE]`);
      continue;
    }
    const list = settingSpecs.get(name) ?? [];
    list.push(spec);
    settingSpecs.set(name, list);
  }

  if (settingSpecs.size > 0 && !decl.ciNeeds) {
    errors.push(
      `declares CI settings (${[...settingSpecs.keys()].join(", ")}) without ship_ci_needs`,
    );
  }
  if (settingSpecs.size === 0 && decl.ciNeeds) {
    errors.push("declares ship_ci_needs without any ship_ci_setting");
  }

  if (options.manifest) {
    const seenTools = new Set<string>();
    for (const toolSpec of decl.ciTools) {
      const parsed = parseToolSpec(toolSpec, options.manifest.toolchain);
      if (!parsed.ok) {
        errors.push(`ship_ci_tool '${toolSpec}': ${parsed.error}`);
      } else if (seenTools.has(parsed.name)) {
        errors.push(`ship_ci_tool '${parsed.name}' is declared more than once`);
      } else {
        seenTools.add(parsed.name);
      }
    }
    for (const [settingName, specs] of settingSpecs) {
      for (const spec of specs) {
        const parsed = parseToolSpec(spec, options.manifest.toolchain);
        if (!parsed.ok) {
          errors.push(`ship_ci_setting ${settingName}: ${parsed.error}`);
        }
      }
    }
  }

  const commandFields: ReadonlyArray<readonly [string, string]> = [
    ["ship_body_check", decl.bodyCheck],
    ["ship_install", decl.install],
    ["ship_secret_scan", decl.secretScan],
    ["ship_ci", decl.ci === "pre-push" ? "" : decl.ci],
    ["ship_ci_needs", decl.ciNeeds],
    ["ship_push_summary", decl.pushSummary],
    ["ship_merge", decl.merge],
    ["ship_merge_gate", decl.mergeGate],
    ["ship_post_merge", decl.postMerge],
    ["ship_pre_cleanup", decl.preCleanup],
    ["ship_idle", decl.idle],
    ["ship_deploy", decl.deploy],
    ["ship_deploy_gate", decl.deployGate],
  ];
  for (const [field, cmdline] of commandFields) {
    if (!cmdline) continue;
    const script = scriptOfCommand(cmdline);
    if (script.startsWith("/") || script.split("/").includes("..")) {
      errors.push(`${field} script '${script}' must be repo-relative without '..'`);
    } else if (options.existingFiles && !options.existingFiles.has(script)) {
      errors.push(`${field} script '${script}' is not committed at the base SHA`);
    }
  }

  if (
    decl.ciServices.length > 0 &&
    options.existingFiles &&
    !options.existingFiles.has("compose.yaml") &&
    !options.existingFiles.has("compose.yml") &&
    !options.existingFiles.has("docker-compose.yml") &&
    !options.existingFiles.has("docker-compose.yaml")
  ) {
    errors.push("ship_ci_service declared, but base commit has no compose file");
  }

  return { ok: errors.length === 0, errors, warnings: decl.warnings };
}

/** Extracts the pinned base SHA's step directories into `destDir` using `git archive`. */
export async function extractBaseStepTree(input: {
  readonly run: ProcessRunner;
  readonly primary: string;
  readonly baseSha: string;
  readonly decl: ShipDeclaration;
  readonly destDir: string;
}): Promise<{ readonly ok: boolean; readonly error?: string | undefined }> {
  const paths = declaredStepPaths(input.decl);
  if (paths.length === 0) {
    NodeFS.mkdirSync(input.destDir, { recursive: true });
    return { ok: true };
  }
  const tmpDir = `${input.destDir}.tmp.${process.pid}`;
  NodeFS.rmSync(tmpDir, { recursive: true, force: true });
  NodeFS.mkdirSync(tmpDir, { recursive: true });
  const extract = await input.run({
    command: "bash",
    args: [
      "-c",
      'set -euo pipefail; git -C "$1" archive --format=tar "$2" -- "${@:4}" | tar -x -C "$3"',
      "--",
      input.primary,
      input.baseSha,
      tmpDir,
      ...paths,
    ],
    cwd: input.primary,
  });
  if (extract.exitCode !== 0) {
    NodeFS.rmSync(tmpDir, { recursive: true, force: true });
    return {
      ok: false,
      error: extract.stderr.trim() || `base tree extract exited ${extract.exitCode}`,
    };
  }
  NodeFS.rmSync(input.destDir, { recursive: true, force: true });
  NodeFS.renameSync(tmpDir, input.destDir);
  return { ok: true };
}
