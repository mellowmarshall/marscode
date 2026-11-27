// @effect-diagnostics nodeBuiltinImport:off - headless CLI library on node:* builtins only.
/**
 * Where a repo's feature surface and contracts are: playbook.json
 * (`contracts.intent.contracts`), else `.tree-guard.conf`'s `surface_contract`,
 * else a usual place. surface runs no repo code: it reads what the repo's own
 * generate command wrote.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

export const DEFAULT_CONTRACT = NodePath.join("config", "contracts", "feature-surfaces.json");
const CANDIDATES: ReadonlyArray<string> = [
  DEFAULT_CONTRACT,
  NodePath.join("packages", "http-contracts", "feature-surfaces.json"),
  NodePath.join("contracts", "feature-surfaces.json"),
  ".feature-surfaces.json",
];
/** The contracts whose changes need a declared intent. */
export const CONTRACT_NAMES = ["surface", "fleet", "dictionary", "actions", "slots"] as const;
export type ContractName = (typeof CONTRACT_NAMES)[number];

type Json = Record<string, unknown>;

function asObject(v: unknown): Json {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {};
}

function isFile(p: string): boolean {
  try {
    return NodeFS.statSync(p).isFile();
  } catch {
    return false;
  }
}

export function findRepoRoot(cwd: string): string | null {
  const res = NodeChildProcess.spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    encoding: "utf8",
  });
  return res.status === 0 && res.stdout.trim() ? res.stdout.trim() : null;
}

/** `key=value` lines of the repo's .tree-guard.conf. */
export function readTreeGuardConf(repoRoot: string): Map<string, string> {
  const conf = new Map<string, string>();
  let text: string;
  try {
    text = NodeFS.readFileSync(NodePath.join(repoRoot, ".tree-guard.conf"), "utf8");
  } catch {
    return conf;
  }
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const eq = line.indexOf("=");
    if (!line || line.startsWith("#") || eq < 0) continue;
    conf.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
  }
  return conf;
}

export function readDeclaration(repoRoot: string): Json {
  try {
    return asObject(
      JSON.parse(NodeFS.readFileSync(NodePath.join(repoRoot, "playbook.json"), "utf8")),
    );
  } catch {
    return {};
  }
}

/** The contract files playbook.json declares for intent: {surface: path, ...}. */
export function declaredContracts(repoRoot: string): Partial<Record<ContractName, string>> {
  const files = asObject(asObject(asObject(readDeclaration(repoRoot).contracts).intent).contracts);
  const out: Partial<Record<ContractName, string>> = {};
  for (const name of CONTRACT_NAMES) {
    const path = files[name];
    if (typeof path === "string" && path) out[name] = path;
  }
  return out;
}

/** The surface file the repo declares: playbook.json first, then .tree-guard.conf. */
export function declaredSurface(repoRoot: string): string | null {
  return (
    declaredContracts(repoRoot).surface ??
    readTreeGuardConf(repoRoot).get("surface_contract") ??
    null
  );
}

/** The surface file, absolute; null when there is none. */
export function findContractPath(repoRoot: string): string | null {
  const declared = declaredSurface(repoRoot);
  for (const rel of [...(declared ? [declared] : []), ...CANDIDATES]) {
    const full = NodePath.join(repoRoot, rel);
    if (isFile(full)) return full;
  }
  return null;
}

/** The repo's generate command, which writes the surface file. */
export function generateCommand(repoRoot: string): string {
  const gen = asObject(asObject(readDeclaration(repoRoot).contracts).generations);
  return typeof gen.command === "string" && gen.command ? gen.command : "pnpm run generate";
}
