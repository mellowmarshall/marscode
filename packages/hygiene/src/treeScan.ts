// @effect-diagnostics nodeBuiltinImport:off - Reads tracked files of the checkout from disk.
/** PLAYBOOK §16.4 `tree` surface: every tracked file's path and text, plus ignore coverage. */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { git, nulList } from "./gitRead.ts";
import { isExcepted, isExcludedPath, readPolicyFile } from "./hygienePolicy.ts";
import type { Finding, HygienePolicy, ScanOptions } from "./hygieneTypes.ts";
import { ignoreCoverageFindings, localOnlyPathFindings } from "./localFiles.ts";
import { scanName, scanText } from "./textScan.ts";

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const BINARY_PROBE_BYTES = 8000;

/** File text, or `null` for a binary, oversized, missing, or non-regular file. */
export function readTextFile(path: string): string | null {
  try {
    const stat = NodeFS.lstatSync(path);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return null;
    const buf = NodeFS.readFileSync(path);
    if (buf.subarray(0, BINARY_PROBE_BYTES).includes(0)) return null;
    return buf.toString("utf8");
  } catch {
    return null;
  }
}

export function pathFindings(
  path: string,
  options: ScanOptions & { readonly policy: HygienePolicy },
): ReadonlyArray<Finding> {
  const local = localOnlyPathFindings(path).filter(
    (finding) => !isExcepted(options.policy, finding.classId, path),
  );
  const named = scanName(path, "path", {
    surface: "tree",
    denylist: options.denylist,
    policy: options.policy,
    file: path,
  });
  return [...local, ...named];
}

export function scanTree(root: string, options: ScanOptions): ReadonlyArray<Finding> {
  const policy = options.policy ?? readPolicyFile(root);
  const scoped = { ...options, policy };
  const out: Finding[] = [];
  for (const file of nulList(git(root, ["ls-files", "-z", "--cached"]))) {
    if (isExcludedPath(policy, file)) continue;
    out.push(...pathFindings(file, scoped));
    const text = readTextFile(NodePath.join(root, file));
    if (text === null) continue;
    out.push(
      ...scanText(text, { source: file, surface: "tree", denylist: options.denylist, policy }),
    );
  }
  out.push(...ignoreCoverageFindings(root));
  return out;
}
