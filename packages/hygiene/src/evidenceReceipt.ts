// @effect-diagnostics nodeBuiltinImport:off - Writes the receipt file and probes the host text guard.
/**
 * PLAYBOOK §16.8 hygiene receipt (`playbook-evidence/v1`, section `hygiene`) bound to a tree.
 * Layers are recorded only when statically detected, so a receipt never claims a layer it lacks.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { git, showFile } from "./gitRead.ts";
import {
  HYGIENE_CLASSES,
  type HygieneClass,
  type HygieneLayer,
  type HygieneSurface,
} from "./hygieneCatalog.ts";
import { policyReceiptEntries } from "./hygienePolicy.ts";
import type { Finding, HygienePolicy } from "./hygieneTypes.ts";

/** The `playbook-evidence/v1` shape `@t3tools/playbook/evidence` validates. */
export interface HygieneReceipt {
  readonly schema: "playbook-evidence/v1";
  readonly section: "hygiene";
  readonly status: "pass" | "fail";
  readonly tree: string;
  readonly jobId?: string;
  readonly generatedAt: string;
  readonly summary: string;
  readonly durationMs: number;
  readonly checks: ReadonlyArray<{
    readonly name: HygieneClass;
    readonly status: "pass" | "fail";
    readonly durationMs: number;
    readonly detail?: string;
  }>;
  readonly measurements: Readonly<Record<string, unknown>>;
  readonly exceptions?: ReadonlyArray<{ subject: string; reason: string; issue: string }>;
}

const HYGIENE_BIN = String.raw`hygiene/src/bin\.ts["']?\s+`;

export interface HygieneRun {
  readonly findings: ReadonlyArray<Finding>;
  readonly surfaces: ReadonlyArray<HygieneSurface>;
  readonly durationMs: number;
  readonly denylistApplied: boolean;
}

export interface LayerProbes {
  /** True when the ship-queue gate is the writer of this receipt. */
  readonly shipGate: boolean;
  /** Whether the host text guard reports the `text-guard` capability. */
  readonly textGuard: () => boolean;
}

function declaredValue(conf: string, key: string): string {
  for (const raw of conf.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith(`${key}=`)) return line.slice(key.length + 1).trim();
  }
  return "";
}

/** Runs `marscode-host-guard capabilities`; a missing or failing command means no text guard. */
export function probeTextGuard(): boolean {
  const res = NodeChildProcess.spawnSync("marscode-host-guard", ["capabilities"], {
    encoding: "utf8",
    timeout: 10_000,
  });
  if (res.error || res.status !== 0) return false;
  return res.stdout.split("\n").some((line) => line.includes("text-guard"));
}

export function detectLayers(
  root: string,
  rev: string,
  probes: LayerProbes,
): ReadonlyArray<HygieneLayer> {
  const layers: HygieneLayer[] = [];
  const conf = showFile(root, rev, ".tree-guard.conf") ?? "";
  const hooksDir = declaredValue(conf, "ship_hooks_path") || ".githooks";
  const preCommit = showFile(root, rev, `${hooksDir}/pre-commit`) ?? "";
  if (new RegExp(`${HYGIENE_BIN}staged\\b`).test(preCommit)) layers.push("pre-commit");
  if (probes.shipGate) layers.push("ship-gate");
  const ciScript = declaredValue(conf, "ship_ci").split(/\s+/)[0] ?? "";
  const ci = ciScript ? (showFile(root, rev, ciScript) ?? "") : "";
  if (new RegExp(`${HYGIENE_BIN}tree\\b`).test(ci)) layers.push("ci");
  if (probes.textGuard()) layers.push("text-guard");
  return layers;
}

export function treeOf(root: string, rev: string): string {
  return git(root, ["rev-parse", `${rev}^{tree}`]).trim();
}

export function buildHygieneReceipt(input: {
  readonly tree: string;
  readonly jobId?: string | undefined;
  readonly generatedAt: string;
  readonly run: HygieneRun;
  readonly layers: ReadonlyArray<HygieneLayer>;
  readonly policy: HygienePolicy;
}): HygieneReceipt {
  const { run } = input;
  const checks = HYGIENE_CLASSES.map((classId) => {
    const count = run.findings.filter((finding) => finding.classId === classId).length;
    return count === 0
      ? { name: classId, status: "pass" as const, durationMs: run.durationMs }
      : {
          name: classId,
          status: "fail" as const,
          durationMs: run.durationMs,
          detail: `${count} finding(s)`,
        };
  });
  const failed = checks.filter((check) => check.status === "fail").length;
  const exceptions = policyReceiptEntries(input.policy);
  return {
    schema: "playbook-evidence/v1",
    section: "hygiene",
    status: failed === 0 ? "pass" : "fail",
    tree: input.tree,
    ...(input.jobId ? { jobId: input.jobId } : {}),
    generatedAt: input.generatedAt,
    summary: `${run.findings.length} finding(s) in ${failed} class(es)`,
    durationMs: run.durationMs,
    checks,
    measurements: {
      surfaces: [...run.surfaces],
      layers: [...input.layers],
      ...(run.denylistApplied ? { privateDenylist: "applied" } : {}),
      findings: run.findings.length,
    },
    ...(exceptions.length > 0 ? { exceptions } : {}),
  };
}

export function writeReceipt(path: string, receipt: HygieneReceipt): void {
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
  NodeFS.writeFileSync(path, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
}
