// @effect-diagnostics nodeBuiltinImport:off - headless CLI library on node:* builtins only.
/**
 * Where a repo's fleet shape is: the file its playbook.json declares
 * (`contracts.fleet.file`), else a usual place.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

export const FLEET_LOCATIONS: ReadonlyArray<string> = [
  "fleet-shape.json",
  NodePath.join("deploy", "fleet-shape.json"),
  NodePath.join("scripts", "gates", "fleet-shape.json"),
  NodePath.join("config", "fleet-shape.json"),
];

function isFile(p: string): boolean {
  try {
    return NodeFS.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** The git work tree containing `start`, else the nearest directory with a .git; null outside one. */
export function findRepoRoot(start: string): string | null {
  const res = NodeChildProcess.spawnSync("git", ["-C", start, "rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  });
  if (res.status === 0 && res.stdout.trim()) return res.stdout.trim();
  let cur = NodePath.resolve(start);
  for (;;) {
    if (NodeFS.existsSync(NodePath.join(cur, ".git"))) return cur;
    const parent = NodePath.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

/** The fleet file playbook.json declares, if it exists. */
function declaredFleetFile(repoRoot: string): string | null {
  try {
    const data: unknown = JSON.parse(
      NodeFS.readFileSync(NodePath.join(repoRoot, "playbook.json"), "utf8"),
    );
    const contracts = (data as { contracts?: { fleet?: { file?: unknown } } } | null)?.contracts;
    const file = contracts?.fleet?.file;
    return typeof file === "string" && isFile(NodePath.join(repoRoot, file))
      ? NodePath.join(repoRoot, file)
      : null;
  } catch {
    return null;
  }
}

/** The repo's fleet shape file, absolute; null when it declares none. */
export function findFleetDeclaration(repoRoot: string): string | null {
  const declared = declaredFleetFile(repoRoot);
  if (declared) return declared;
  for (const loc of FLEET_LOCATIONS) {
    const full = NodePath.join(repoRoot, loc);
    if (isFile(full)) return full;
  }
  return null;
}
