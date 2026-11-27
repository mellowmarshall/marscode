// @effect-diagnostics nodeBuiltinImport:off - Headless playbook gate uses node:* directly without Effect.
/**
 * `playbook check docs`: deterministic documentation contract gate.
 * Validates local relative links in tracked markdown documentation (refusing broken targets
 * and symlink escapes outside the repo) and verifies `GENERATED from <source>` doc markers.
 */
import * as NodePath from "node:path";

import { firstSymlinkSegment, listedFiles, readWorktreeFile, worktreePathExists } from "../git.ts";
import { failed, passed, unproven, type CheckResult } from "../result.ts";

const CHECK = "docs";
const DOC_LINK_RE = /(?<!!)\[[^\]]+\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const MARKER_RE = /^\s*(?:<!--|\/\/|#)\s*GENERATED from (\S+)/;
const DOC_ROOT_FILES = new Set([
  "README.md",
  "PLAYBOOK.md",
  "CHALLENGE.md",
  "AGENTS.md",
  "CLAUDE.md",
]);

function isDocFile(rel: string): boolean {
  if (!rel.endsWith(".md")) return false;
  return DOC_ROOT_FILES.has(rel) || rel.startsWith("docs/") || rel.startsWith("doc/");
}

function isExternalTarget(target: string): boolean {
  return (
    target.startsWith("#") ||
    target.startsWith("http://") ||
    target.startsWith("https://") ||
    target.startsWith("mailto:") ||
    target.startsWith("tel:") ||
    target.startsWith("data:") ||
    target.startsWith("file://") ||
    target.includes("<") ||
    target.includes("{")
  );
}

function stripFencedBlocks(
  markdown: string,
): ReadonlyArray<{ readonly line: number; readonly text: string }> {
  const out: Array<{ readonly line: number; readonly text: string }> = [];
  let inFence = false;
  const lines = markdown.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (/^\s*(?:```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) out.push({ line: i + 1, text: line });
  }
  return out;
}

export function docsGate(input: { readonly root: string }): CheckResult {
  const files = listedFiles(input.root);
  if (files === null) return unproven(CHECK, "git cannot list files for docs check");
  const docs = files.filter(isDocFile).toSorted();
  if (docs.length === 0) return passed(CHECK, "no documentation markdown files in scope");

  const problems: string[] = [];
  const badFiles = new Set<string>();

  for (const rel of docs) {
    const text = readWorktreeFile(input.root, rel);
    if (text === null) continue;
    const headLines = text.slice(0, 4096).split("\n").slice(0, 5);
    for (const h of headLines) {
      const marker = MARKER_RE.exec(h);
      if (marker?.[1]) {
        const src = marker[1].replace(/[.,;:)]+$/, "");
        if (!worktreePathExists(input.root, src)) {
          problems.push(`${rel}: GENERATED from ${src}, which does not exist`);
          badFiles.add(rel);
        }
        break;
      }
    }

    const dir = NodePath.posix.dirname(rel);
    for (const { line, text: row } of stripFencedBlocks(text)) {
      const withoutInlineCode = row.replace(/`[^`]*`/g, "");
      for (const match of withoutInlineCode.matchAll(DOC_LINK_RE)) {
        const rawTarget = match[1] ?? "";
        if (!rawTarget || isExternalTarget(rawTarget)) continue;
        const clean = rawTarget.split("#")[0]?.split("?")[0] ?? "";
        if (!clean) continue;
        if (clean.startsWith("/")) {
          const fromRoot = clean.slice(1);
          if (!worktreePathExists(input.root, fromRoot)) {
            problems.push(`${rel}:${line}: broken link target '${rawTarget}'`);
            badFiles.add(rel);
          }
          continue;
        }
        const resolved = NodePath.posix.normalize(
          dir === "." ? clean : NodePath.posix.join(dir, clean),
        );
        if (resolved === ".." || resolved.startsWith("../")) {
          problems.push(`${rel}:${line}: link target '${rawTarget}' escapes the repository root`);
          badFiles.add(rel);
          continue;
        }
        const symlink = firstSymlinkSegment(input.root, resolved);
        if (symlink) {
          problems.push(
            `${rel}:${line}: link target '${rawTarget}' passes through symlink ${symlink}`,
          );
          badFiles.add(rel);
          continue;
        }
        if (!worktreePathExists(input.root, resolved)) {
          problems.push(
            `${rel}:${line}: broken link target '${rawTarget}' (resolved to ${resolved})`,
          );
          badFiles.add(rel);
        }
      }
    }
  }

  if (problems.length > 0) {
    return failed(CHECK, `${problems.length} documentation link/marker problem(s)`, {
      errors: problems,
      files: [...badFiles].slice(0, 8),
      fix: "fix broken relative markdown links and missing GENERATED sources",
    });
  }
  return passed(
    CHECK,
    `${docs.length} documentation file(s) checked; all local links and markers valid`,
  );
}
