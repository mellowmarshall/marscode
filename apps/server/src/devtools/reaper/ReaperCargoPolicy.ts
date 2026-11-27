// @effect-diagnostics nodeBuiltinImport:off - Host-local extra Cargo build roots from the `[cargo]` section of the reaper policy file.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { defaultReaperPolicyPath } from "../ReaperPolicy.ts";
import { readTomlSectionArrays } from "./ReaperDockerPolicy.ts";

const MAX_ROOTS = 32;

/** Absolute, normalized `[cargo] roots`; the filesystem root and relative paths are dropped. */
export function parseReaperCargoRoots(text: string): ReadonlyArray<string> {
  const roots = readTomlSectionArrays(text, "cargo").get("roots") ?? [];
  return roots
    .slice(0, MAX_ROOTS)
    .filter((root) => NodePath.isAbsolute(root))
    .map((root) => NodePath.normalize(root).replace(/\/+$/, ""))
    .filter((root) => root !== "");
}

export function readReaperCargoRootsSync(
  policyPath: string = defaultReaperPolicyPath(),
): ReadonlyArray<string> {
  try {
    return parseReaperCargoRoots(NodeFS.readFileSync(policyPath, "utf8"));
  } catch {
    return [];
  }
}
