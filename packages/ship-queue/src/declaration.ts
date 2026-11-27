// @effect-diagnostics nodeBuiltinImport:off - Repository ship declaration (`.tree-guard.conf` + `playbook.json`) parser.
import * as NodePath from "node:path";

import { normalizeArch } from "./ciHosts.ts";

const PLAYBOOK_FILE = "playbook.json";
const ARCHES = new Set(["x86_64", "aarch64", "riscv64"]);
const PASS_STAGES = new Set(["ci", "merge", "deploy"]);
const EVIDENCE_RE = /^[A-Za-z0-9._][A-Za-z0-9._/-]*$/;
const CI_PATH_RE = /^[A-Za-z0-9._-][A-Za-z0-9._/-]*$/;
const SETTING_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

const PLAYBOOK_CI_KEYS: Readonly<Record<string, string>> = {
  tools: "ship_ci_tool",
  services: "ship_ci_service",
  secrets: "ship_ci_secret",
  paths: "ship_ci_path",
  evidence: "ship_ci_evidence",
  settings: "ship_ci_setting",
  doppler: "ship_ci_doppler",
  arch: "ship_ci_arch",
};

const SCALAR_KEYS: Readonly<Record<string, keyof MutableDeclScalars>> = {
  base_ref: "baseRef",
  ship_repo: "repo",
  ship_gh_repo: "ghRepo",
  ship_worktree_root: "worktreeRoot",
  ship_body_check: "bodyCheck",
  ship_install: "install",
  ship_secret_scan: "secretScan",
  ship_ci: "ci",
  ship_ci_needs: "ciNeeds",
  ship_push_summary: "pushSummary",
  ship_merge: "merge",
  ship_merge_gate: "mergeGate",
  ship_post_merge: "postMerge",
  ship_pre_cleanup: "preCleanup",
  ship_idle: "idle",
  ship_deploy: "deploy",
  ship_deploy_gate: "deployGate",
};

interface MutableDeclScalars {
  baseRef: string;
  repo: string;
  ghRepo: string;
  worktreeRoot: string;
  bodyCheck: string;
  install: string;
  secretScan: string;
  ci: string;
  ciNeeds: string;
  pushSummary: string;
  merge: string;
  mergeGate: string;
  postMerge: string;
  preCleanup: string;
  idle: string;
  deploy: string;
  deployGate: string;
}

export interface ShipDeclaration extends Readonly<MutableDeclScalars> {
  readonly ciLocalOnly: boolean;
  readonly ciEnv: string;
  readonly hooksPath: string;
  readonly passDeployAs: string;
  readonly mergeWeight: "light" | "heavy";
  readonly preconditionWaitS: number;
  readonly cleanup: ReadonlyArray<string>;
  readonly ciSource: string;
  readonly intent: boolean;
  readonly resolvers: ReadonlyArray<string>;
  readonly preconditions: ReadonlyArray<string>;
  readonly stepTree: ReadonlyArray<string>;
  readonly junkAllow: ReadonlyArray<string>;
  readonly junkBad: ReadonlyArray<string>;
  readonly passStages: ReadonlyArray<"ci" | "merge" | "deploy">;
  readonly passExcludes: ReadonlyArray<string>;
  readonly ciTools: ReadonlyArray<string>;
  readonly ciSettings: ReadonlyArray<string>;
  readonly ciServices: ReadonlyArray<string>;
  readonly ciSecrets: ReadonlyArray<string>;
  readonly ciPaths: ReadonlyArray<string>;
  readonly ciDoppler: ReadonlyArray<string>;
  readonly ciEvidence: ReadonlyArray<string>;
  readonly ciArch: ReadonlyArray<string>;
  readonly warnings: ReadonlyArray<string>;
}

export function isValidCiRelativePath(rel: string): boolean {
  return (
    CI_PATH_RE.test(rel) &&
    !rel.includes("//") &&
    !rel.split("/").includes("..") &&
    !rel.split("/").includes(".")
  );
}

export function scriptOfCommand(cmdline: string): string {
  return cmdline.trim().split(/\s+/)[0] ?? "";
}

/** Collects every declared command script path and `ship_step_tree` directory to extract from base. */
export function declaredStepPaths(decl: ShipDeclaration): ReadonlyArray<string> {
  const cmds = [
    decl.bodyCheck,
    decl.install,
    decl.secretScan,
    decl.ci === "pre-push" ? "" : decl.ci,
    decl.ciNeeds,
    decl.pushSummary,
    decl.merge,
    decl.mergeGate,
    decl.postMerge,
    decl.preCleanup,
    decl.idle,
    decl.deploy,
    decl.deployGate,
    ...decl.preconditions,
    ...decl.resolvers.map((r) => r.trim().split(/\s+/).slice(1).join(" ")),
  ].filter((c) => c.trim().length > 0);

  const out = new Set<string>(decl.stepTree);
  for (const cmd of cmds) {
    const script = scriptOfCommand(cmd);
    if (!script) continue;
    const dir = NodePath.posix.dirname(script);
    out.add(dir === "." ? script : dir);
  }
  return [...out].toSorted();
}

/** Parses `.tree-guard.conf` and optional `playbook.json` read at the same base commit. */
export function parseShipDeclaration(
  confText: string,
  playbookText = "",
  declName = ".tree-guard.conf",
): ShipDeclaration {
  const scalars: MutableDeclScalars = {
    baseRef: "",
    repo: "",
    ghRepo: "",
    worktreeRoot: "",
    bodyCheck: "",
    install: "",
    secretScan: "",
    ci: "",
    ciNeeds: "",
    pushSummary: "",
    merge: "",
    mergeGate: "",
    postMerge: "",
    preCleanup: "",
    idle: "",
    deploy: "",
    deployGate: "",
  };
  let ciEnv = "";
  let hooksPath = "";
  let mergeWeight: "light" | "heavy" = "light";
  let preconditionWaitS = 2400;
  const cleanup = ["worktree", "branch", "remote"];
  let ciSource = declName;
  let intent = false;
  const resolvers: string[] = [];
  const preconditions: string[] = [];
  const stepTree: string[] = [];
  const junkAllow: string[] = [];
  const junkBad: string[] = [];
  const rawPassStages: Array<"ci" | "merge" | "deploy"> = [];
  const passExcludes: string[] = [];
  let ciTools: string[] = [];
  let ciSettings: string[] = [];
  let ciServices: string[] = [];
  let ciSecrets: string[] = [];
  let ciPaths: string[] = [];
  let ciDoppler: string[] = [];
  let ciEvidence: string[] = [];
  let ciArch: string[] = [];
  const retired: string[] = [];

  const pushUnique = (arr: string[], value: string) => {
    if (value && !arr.includes(value)) arr.push(value);
  };

  const applyKey = (key: string, value: string) => {
    const scalarKey = SCALAR_KEYS[key];
    if (scalarKey) {
      scalars[scalarKey] = value;
      return;
    }
    if (key === "ship_step_tree") {
      if (value) stepTree.push(value);
    } else if (key === "ship_resolver") {
      if (value) resolvers.push(value);
    } else if (key === "ship_precondition") {
      if (value) preconditions.push(value);
    } else if (key === "ship_junk_allow") {
      const sepIdx = value.indexOf(" -- ");
      if (sepIdx >= 0 && value.slice(sepIdx + 4).length >= 10) {
        junkAllow.push(value.slice(0, sepIdx));
      } else {
        junkBad.push(value);
      }
    } else if (key === "ship_gate_check") {
      // Retired and silently accepted.
    } else if (key === "ship_disposable") {
      pushUnique(retired, key);
    } else if (key === "ship_ci_setting") {
      if (value) ciSettings.push(value);
    } else if (key === "ship_ci_tool") {
      pushUnique(ciTools, value);
    } else if (key === "ship_ci_service") {
      pushUnique(ciServices, value);
    } else if (key === "ship_ci_secret") {
      pushUnique(ciSecrets, value);
    } else if (key === "ship_ci_doppler") {
      pushUnique(ciDoppler, value);
    } else if (key === "ship_ci_env") {
      if (!value.startsWith("/") && !value.includes("..")) ciEnv = value;
    } else if (key === "ship_ci_evidence") {
      const trimmed = value.endsWith("/") ? value.slice(0, -1) : value;
      if (EVIDENCE_RE.test(trimmed) && !trimmed.includes("..")) {
        pushUnique(ciEvidence, trimmed);
      } else {
        retired.push(`${key}=${value}`);
      }
    } else if (key === "ship_pass_record") {
      if (PASS_STAGES.has(value)) {
        const stage = value as "ci" | "merge" | "deploy";
        if (!rawPassStages.includes(stage)) rawPassStages.push(stage);
      } else {
        retired.push(`${key}=${value}`);
      }
    } else if (key === "ship_pass_exclude") {
      const trimmed = value.endsWith("/") ? value.slice(0, -1) : value;
      if (EVIDENCE_RE.test(trimmed) && !trimmed.includes("..")) {
        pushUnique(passExcludes, trimmed);
      } else {
        retired.push(`${key}=${value}`);
      }
    } else if (key === "ship_ci_arch") {
      const norm = normalizeArch(value);
      if (ARCHES.has(norm)) {
        pushUnique(ciArch, norm);
      } else {
        retired.push(`${key}=${value}`);
      }
    } else if (key === "ship_ci_path") {
      pushUnique(ciPaths, value.endsWith("/") ? value.slice(0, -1) : value);
    } else if (key === "ship_precondition_wait_s") {
      if (/^[0-9]+$/.test(value)) preconditionWaitS = Number.parseInt(value, 10);
    } else if (key === "ship_step_weight") {
      if (value === "merge:light") mergeWeight = "light";
      else if (value === "merge:heavy") mergeWeight = "heavy";
      else retired.push(`${key}=${value}`);
    } else if (key === "ship_hooks_path") {
      if (!value.startsWith("/") && !value.includes("..")) hooksPath = value;
    } else if (key === "ship_cleanup") {
      for (const w of value.split(/\s+/)) {
        if (w) cleanup.push(w);
      }
    }
  };

  for (const rawLine of confText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    applyKey(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
  }

  if (playbookText.trim().length > 0) {
    let parsedPb: unknown;
    try {
      parsedPb = JSON.parse(playbookText) as unknown;
    } catch (err) {
      retired.push(
        `playbook.json=not valid JSON (${(err instanceof Error ? err.message : String(err)).replaceAll("\n", " ")})`,
      );
      parsedPb = null;
    }
    if (parsedPb !== null) {
      if (!parsedPb || typeof parsedPb !== "object" || Array.isArray(parsedPb)) {
        retired.push("playbook.json=not a JSON object");
      } else {
        const doc = parsedPb as Record<string, unknown>;
        const contracts =
          doc.contracts && typeof doc.contracts === "object" && !Array.isArray(doc.contracts)
            ? (doc.contracts as Record<string, unknown>)
            : null;
        const intentObj =
          contracts?.intent &&
          typeof contracts.intent === "object" &&
          !Array.isArray(contracts.intent)
            ? (contracts.intent as Record<string, unknown>)
            : null;
        if (
          intentObj?.contracts &&
          typeof intentObj.contracts === "object" &&
          !Array.isArray(intentObj.contracts) &&
          Object.keys(intentObj.contracts as Record<string, unknown>).length > 0
        ) {
          intent = true;
        }
        if (doc.ci !== undefined && doc.ci !== null) {
          const parsedCi = parsePlaybookCiBlock(doc.ci);
          if (!parsedCi.ok) {
            retired.push(parsedCi.warning);
          } else {
            const hadConfCi =
              ciTools.length > 0 ||
              ciSettings.length > 0 ||
              ciServices.length > 0 ||
              ciSecrets.length > 0 ||
              ciPaths.length > 0 ||
              ciDoppler.length > 0 ||
              ciEvidence.length > 0 ||
              ciArch.length > 0;
            if (hadConfCi) retired.push("ship_ci_in_conf");
            ciTools = [];
            ciSettings = [];
            ciServices = [];
            ciSecrets = [];
            ciPaths = [];
            ciDoppler = [];
            ciEvidence = [];
            ciArch = [];
            ciSource = PLAYBOOK_FILE;
            for (const [k, v] of parsedCi.entries) applyKey(k, v);
          }
        }
      }
    }
  }

  const stageSteps: Record<"ci" | "merge" | "deploy", string> = {
    ci: scalars.ci === "pre-push" ? "" : scalars.ci,
    merge: scalars.mergeGate,
    deploy: scalars.deployGate,
  };
  const passStages: Array<"ci" | "merge" | "deploy"> = [];
  for (const s of rawPassStages) {
    if (!stageSteps[s]) {
      retired.push(`ship_pass_record=${s}:no_step`);
    } else if (s === "ci" && (ciSecrets.length > 0 || ciDoppler.length > 0)) {
      retired.push(`ship_pass_record=${s}:live`);
    } else {
      passStages.push(s);
    }
  }
  let passDeployAs = "";
  if (
    passStages.includes("merge") &&
    scalars.deployGate &&
    scalars.deployGate.trim().split(/\s+/).join(" ") ===
      scalars.mergeGate.trim().split(/\s+/).join(" ")
  ) {
    passDeployAs = "merge";
    if (!passStages.includes("deploy")) passStages.push("deploy");
  }

  return {
    ...scalars,
    ciLocalOnly: false,
    ciEnv,
    hooksPath,
    passDeployAs,
    mergeWeight,
    preconditionWaitS,
    cleanup,
    ciSource,
    intent,
    resolvers,
    preconditions,
    stepTree,
    junkAllow,
    junkBad,
    passStages,
    passExcludes: [...passExcludes].toSorted(),
    ciTools,
    ciSettings,
    ciServices,
    ciSecrets,
    ciPaths,
    ciDoppler,
    ciEvidence,
    ciArch,
    warnings: formatDeclWarnings(retired, declName),
  };
}

function parsePlaybookCiBlock(
  ci: unknown,
):
  | { readonly ok: true; readonly entries: ReadonlyArray<readonly [string, string]> }
  | { readonly ok: false; readonly warning: string } {
  if (!ci || typeof ci !== "object" || Array.isArray(ci)) {
    return { ok: false, warning: "playbook.json=ci is not an object" };
  }
  const obj = ci as Record<string, unknown>;
  const extra = Object.keys(obj)
    .filter((k) => !(k in PLAYBOOK_CI_KEYS))
    .toSorted();
  if (extra.length > 0) {
    return {
      ok: false,
      warning: `playbook.json=ci has unknown key ${extra.join(", ")} (allowed: ${Object.keys(PLAYBOOK_CI_KEYS).join(", ")})`,
    };
  }
  const entries: Array<readonly [string, string]> = [];
  for (const [k, confKey] of Object.entries(PLAYBOOK_CI_KEYS)) {
    const raw = obj[k];
    if (raw === undefined) continue;
    if (k === "settings") {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        return { ok: false, warning: "playbook.json=ci.settings is not an object of tool lists" };
      }
      for (const [name, list] of Object.entries(raw as Record<string, unknown>)) {
        if (
          !SETTING_NAME_RE.test(name) ||
          !Array.isArray(list) ||
          list.length === 0 ||
          !list.every((x) => typeof x === "string" && x.trim().length > 0 && !x.includes("\n"))
        ) {
          return {
            ok: false,
            warning: `playbook.json=ci.settings ${JSON.stringify(name)} is not NAME (a-z, 0-9 and -) with one tool or more`,
          };
        }
        for (const spec of list as string[]) {
          entries.push([confKey, `${name} ${spec.trim()}`]);
        }
      }
      continue;
    }
    if (
      !Array.isArray(raw) ||
      !raw.every((x) => typeof x === "string" && x.trim().length > 0 && !x.includes("\n"))
    ) {
      return { ok: false, warning: `playbook.json=ci.${k} is not a list of strings` };
    }
    for (const item of raw as string[]) entries.push([confKey, item.trim()]);
  }
  return { ok: true, entries };
}

function formatDeclWarnings(
  retired: ReadonlyArray<string>,
  declName: string,
): ReadonlyArray<string> {
  return retired.map((k) => {
    if (k.startsWith("ship_pass_record=") && k.endsWith(":no_step")) {
      const stage = k.slice("ship_pass_record=".length, -":no_step".length);
      return `WARNING: ship_pass_record=${stage} is ignored: no declared step to skip`;
    }
    if (k.startsWith("ship_pass_record=") && k.endsWith(":live")) {
      return `WARNING: ${k.slice(0, -":live".length)} is ignored: CI receives vendor tokens and never records`;
    }
    if (k === "ship_ci_in_conf") {
      return `WARNING: ship_ci_* keys in ${declName} are ignored because ${PLAYBOOK_FILE} declares a ci block`;
    }
    if (k.startsWith("playbook.json=")) {
      return `WARNING: ${PLAYBOOK_FILE} cannot be used: ${k.slice("playbook.json=".length)}`;
    }
    return `WARNING: ${k} is retired or invalid and ignored in ${declName}`;
  });
}
