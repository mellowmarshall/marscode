// @effect-diagnostics nodeBuiltinImport:off - Headless playbook gate uses node:* directly without Effect.
/**
 * `playbook check py-deps`: deterministic Python dependency hygiene and lockfile gate.
 * Checks tracked Python manifests (`pyproject.toml`, `requirements*.txt`, `Pipfile`) and
 * lockfiles (`uv.lock`, `poetry.lock`, `Pipfile.lock`) for duplicate pins, unsafe local paths,
 * lockfile presence, and `contracts.tools.steps` `deps` coverage.
 */
import * as NodePath from "node:path";

import { listedFiles, readWorktreeFile } from "../git.ts";
import { failed, passed, unproven, type CheckResult } from "../result.ts";
import { isRecord } from "../strictJson.ts";

const CHECK = "py-deps";
const PY_LOCKS = new Set(["uv.lock", "poetry.lock", "Pipfile.lock"]);
const REQ_FILE_RE = /(?:^|\/)requirements(?:[-_a-z0-9]*)?\.txt$/i;
const REQ_PKG_RE = /^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[^\]]+\])?\s*(.*)$/;
const PINNED_OP_RE = /^(?:===|==|@)/;
const UNSAFE_LOCAL_RE = /(?:^|\s)(?:file:\/\/|\.\.\/|\/[A-Za-z0-9_.-])/;

function normalizePkgName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, "-");
}

function pyprojectHasDependencies(toml: string): boolean {
  const depsArray = /\bdependencies\s*=\s*\[([^\]]*)\]/s.exec(toml);
  if (depsArray && /["'][^"']+["']/.test(depsArray[1] ?? "")) return true;
  if (/^\[tool\.poetry\.dependencies\]/m.test(toml)) {
    const section = toml.split(/^\[tool\.poetry\.dependencies\]/m)[1]?.split(/^\[/m)[0] ?? "";
    return section.split("\n").some((line) => {
      const clean = line.trim();
      return (
        clean.length > 0 &&
        !clean.startsWith("#") &&
        !/^python\s*=/.test(clean) &&
        clean.includes("=")
      );
    });
  }
  return false;
}

function checkRequirementsFile(
  rel: string,
  text: string,
  hasLockfile: boolean,
): ReadonlyArray<string> {
  const problems: string[] = [];
  const seen = new Map<string, number>();
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i]!.replace(/#.*$/, "").trim();
    if (!raw || raw.startsWith("-r ") || raw.startsWith("--requirement") || raw.startsWith("-c "))
      continue;
    if (raw.startsWith("-e ") || raw.startsWith("--editable")) {
      if (UNSAFE_LOCAL_RE.test(raw)) {
        problems.push(`${rel}:${i + 1}: editable requirement uses unsafe path '${raw}'`);
      }
      continue;
    }
    if (raw.startsWith("-")) continue;
    if (UNSAFE_LOCAL_RE.test(raw)) {
      problems.push(`${rel}:${i + 1}: requirement uses local/absolute path '${raw}'`);
      continue;
    }
    const match = REQ_PKG_RE.exec(raw);
    if (!match) continue;
    const pkg = normalizePkgName(match[1]!);
    const spec = (match[2] ?? "").split(";")[0]?.trim() ?? "";
    const prevLine = seen.get(pkg);
    if (prevLine !== undefined) {
      problems.push(
        `${rel}:${i + 1}: duplicate Python dependency '${match[1]}' (first declared on line ${prevLine})`,
      );
    } else {
      seen.set(pkg, i + 1);
    }
    if (!hasLockfile && !PINNED_OP_RE.test(spec)) {
      problems.push(
        `${rel}:${i + 1}: unpinned Python dependency '${match[1]}' with no lockfile (pin with == or commit uv.lock/poetry.lock)`,
      );
    }
  }
  return problems;
}

export function pyDepsGate(input: {
  readonly root: string;
  readonly declaration: Readonly<Record<string, unknown>>;
}): CheckResult {
  const files = listedFiles(input.root);
  if (files === null) return unproven(CHECK, "git cannot list files for py-deps check");
  const pyManifests = files
    .filter((f) => {
      const base = NodePath.posix.basename(f);
      return base === "pyproject.toml" || base === "Pipfile" || REQ_FILE_RE.test(f);
    })
    .toSorted();
  const pyLocks = files.filter((f) => PY_LOCKS.has(NodePath.posix.basename(f))).toSorted();

  if (pyManifests.length === 0 && pyLocks.length === 0) {
    return passed(CHECK, "no Python dependency manifests or lockfiles in repo");
  }

  const problems: string[] = [];
  const badFiles = new Set<string>();
  const locksByDir = new Set(pyLocks.map((l) => NodePath.posix.dirname(l)));

  for (const rel of pyManifests) {
    const text = readWorktreeFile(input.root, rel);
    if (text === null) {
      problems.push(`${rel}: cannot be read (missing or symlink outside repo)`);
      badFiles.add(rel);
      continue;
    }
    const dir = NodePath.posix.dirname(rel);
    const hasDirLock = locksByDir.has(dir) || locksByDir.has(".");
    const base = NodePath.posix.basename(rel);
    if (base === "pyproject.toml") {
      if (pyprojectHasDependencies(text) && !hasDirLock) {
        problems.push(
          `${rel}: declares Python dependencies with no committed lockfile (uv.lock or poetry.lock)`,
        );
        badFiles.add(rel);
      }
      if (/["']file:\/\//.test(text)) {
        problems.push(`${rel}: contains local file:// dependency URL`);
        badFiles.add(rel);
      }
    } else if (REQ_FILE_RE.test(rel)) {
      const reqProblems = checkRequirementsFile(rel, text, hasDirLock);
      if (reqProblems.length > 0) {
        problems.push(...reqProblems);
        badFiles.add(rel);
      }
    }
  }

  const contracts = isRecord(input.declaration.contracts) ? input.declaration.contracts : {};
  const tools = isRecord(contracts.tools) ? contracts.tools : {};
  const steps = Array.isArray(tools.steps) ? tools.steps.filter(isRecord) : [];
  if (pyLocks.length > 0 && steps.length > 0 && !steps.some((s) => s.class === "deps")) {
    problems.push(
      `playbook.json: tracks Python lockfile (${pyLocks.slice(0, 3).join(", ")}) with no 'deps' step in contracts.tools.steps`,
    );
    badFiles.add("playbook.json");
  }

  if (problems.length > 0) {
    return failed(CHECK, `${problems.length} Python dependency problem(s)`, {
      errors: problems,
      files: [...badFiles].slice(0, 8),
      fix: "commit a lockfile (uv.lock/poetry.lock) or exact == pins, remove duplicate/local paths, and declare a deps step",
    });
  }
  return passed(
    CHECK,
    `${pyManifests.length} Python manifest(s) and ${pyLocks.length} lockfile(s) valid`,
  );
}
