// @effect-diagnostics nodeBuiltinImport:off - Reads and, once approved, writes PLAYBOOK.md in the real worktree.
/**
 * `playbook amend <file> [text-file]`: an amended PLAYBOOK.md must stay whole, and its diff
 * is the owner's call: a `playbook-amend` guard bundle, printed (collect) or sent to the broker.
 * With a text file (the original CLI's form), the approval is of that text (normalized),
 * and it is written over the file only once the owner approves it.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { canonicalProtectedDiffSha256, sha256Hex } from "@t3tools/guard-protocol/digests";
import type { WireGuardBundle } from "@t3tools/guard-protocol/bundle-inspect";

import { standardsProblems } from "./challengePrompt.ts";
import {
  currentBranch,
  diffWithText,
  git,
  originSlug,
  readWorktreeFile,
  repoName,
  resolveCommit,
} from "./git.ts";

const AMEND_GATE = "playbook-amend";
const AMENDABLE = new Set(["PLAYBOOK.md", "playbook/PLAYBOOK.md", "packages/playbook/PLAYBOOK.md"]);

export interface AmendDescriptor {
  readonly file: string;
  readonly command: ReadonlyArray<string>;
  readonly refusal: string;
  readonly bundle: WireGuardBundle;
}

export type AmendPlan =
  | { readonly ok: true; readonly descriptor: AmendDescriptor; readonly unchanged: boolean }
  | { readonly ok: false; readonly problems: ReadonlyArray<string> };

/** Validate the amended FILE in the real worktree and build its override descriptor against BASE. */
export function planAmend(input: {
  readonly root: string;
  readonly file: string;
  readonly base: string;
  readonly issue?: string | undefined;
  /** The proposed text, in place of the worktree's. */
  readonly text?: string | undefined;
}): AmendPlan {
  const rel = input.file.replace(/^\.\//, "");
  if (!AMENDABLE.has(rel)) {
    return {
      ok: false,
      problems: [`${rel}: only ${[...AMENDABLE].join(", ")} can be amended`],
    };
  }
  const text = input.text ?? readWorktreeFile(input.root, rel);
  if (text === null) return { ok: false, problems: [`${rel}: not a regular file in the worktree`] };
  const problems = standardsProblems(text);
  if (problems.length > 0) return { ok: false, problems };
  const baseSha = resolveCommit(input.root, input.base);
  if (!baseSha) return { ok: false, problems: [`base ${input.base} is not a commit here`] };
  const diff =
    input.text === undefined
      ? git(input.root, [
          "diff",
          "--no-ext-diff",
          "--no-textconv",
          "--binary",
          "--end-of-options",
          baseSha,
          "--",
          rel,
        ]).stdout
      : diffWithText(input.root, baseSha, rel, input.text);
  if (diff === null) return { ok: false, problems: [`${rel}: cannot diff the proposed text`] };
  const head = resolveCommit(input.root, "HEAD") ?? "";
  const command = ["playbook", "amend", rel];
  return {
    ok: true,
    unchanged: diff.length === 0,
    descriptor: {
      file: rel,
      command,
      refusal: `change ${rel}`,
      bundle: {
        repo: originSlug(input.root) ?? repoName(input.root),
        branch: currentBranch(input.root),
        pr_or_issue: input.issue ?? "",
        gates: [{ gate_id: AMEND_GATE, reason: `${rel.split("/").at(-1)} amended` }],
        protected_paths: [rel],
        protected_diff_sha256: canonicalProtectedDiffSha256(diff),
        body_sha256: sha256Hex(""),
        commit_sha: head,
        diff_preview: diff.slice(0, 4_000),
        summary: `Amend ${rel} against ${baseSha.slice(0, 12)}`,
      },
    },
  };
}

/** The original's normal form: line endings, trailing whitespace and trailing blank lines never count. */
function normalizeAmendText(text: string): string {
  const body = text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n+$/, "");
  return body ? `${body}\n` : "";
}

export type ProposedAmend =
  | {
      readonly ok: true;
      readonly text: string;
      /** Writes the text over the file checked before the approval; a problem when it is not that file now. */
      readonly write: () => string | null;
    }
  | { readonly ok: false; readonly problem: string };

/**
 * Writes TEXT into the file at TARGET only when it is still the regular file
 * (same device and inode) that was checked before the approval: opened with
 * O_NOFOLLOW, verified on the open descriptor, then truncated and written
 * through it, so a link or another file swapped in meanwhile is never written.
 */
function writeCheckedFile(target: string, checked: NodeFS.Stats, text: string): string | null {
  let fd: number;
  try {
    fd = NodeFS.openSync(target, NodeFS.constants.O_WRONLY | NodeFS.constants.O_NOFOLLOW);
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    return code === "ELOOP"
      ? `${target} became a link after the approval; nothing written`
      : `cannot open ${target}: ${code ?? String(cause)}; nothing written`;
  }
  try {
    const now = NodeFS.fstatSync(fd);
    if (!now.isFile() || now.dev !== checked.dev || now.ino !== checked.ino) {
      return `${target} is not the file that was approved; nothing written`;
    }
    NodeFS.ftruncateSync(fd, 0);
    NodeFS.writeSync(fd, text, 0, "utf8");
    return null;
  } finally {
    NodeFS.closeSync(fd);
  }
}

/** SOURCE's whole text (normalized) proposed for FILE; `write` puts it in the worktree. */
export function proposeAmendText(root: string, file: string, source: string): ProposedAmend {
  const rel = file.replace(/^\.\//, "");
  if (!AMENDABLE.has(rel)) {
    return { ok: false, problem: `${rel} is not one of ${[...AMENDABLE].join(", ")}` };
  }
  if (readWorktreeFile(root, rel) === null) {
    return {
      ok: false,
      problem: `${rel} is not a regular file in the checkout (a link, or outside it); refusing to write through it`,
    };
  }
  let next: string;
  try {
    next = new TextDecoder("utf-8", { fatal: true }).decode(NodeFS.readFileSync(source));
  } catch (cause) {
    return {
      ok: false,
      problem: `cannot read ${source} as UTF-8: ${cause instanceof Error ? cause.message : String(cause)}`,
    };
  }
  const text = normalizeAmendText(next);
  const target = NodePath.join(NodeFS.realpathSync(root), rel);
  const checked = NodeFS.lstatSync(target);
  if (!checked.isFile()) {
    return {
      ok: false,
      problem: `${rel} is not a regular file in the checkout; refusing to write through it`,
    };
  }
  return { ok: true, text, write: () => writeCheckedFile(target, checked, text) };
}
