/**
 * `playbook amend <file>`: an amended PLAYBOOK.md must stay whole, and its diff
 * is the owner's call: a `playbook-amend` guard bundle, printed (collect) or sent to the broker.
 */
import { canonicalProtectedDiffSha256, sha256Hex } from "@t3tools/guard-protocol/digests";
import type { WireGuardBundle } from "@t3tools/guard-protocol/bundle-inspect";

import { standardsProblems } from "./challengePrompt.ts";
import {
  currentBranch,
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
}): AmendPlan {
  const rel = input.file.replace(/^\.\//, "");
  if (!AMENDABLE.has(rel)) {
    return {
      ok: false,
      problems: [`${rel}: only ${[...AMENDABLE].join(", ")} can be amended`],
    };
  }
  const text = readWorktreeFile(input.root, rel);
  if (text === null) return { ok: false, problems: [`${rel}: not a regular file in the worktree`] };
  const problems = standardsProblems(text);
  if (problems.length > 0) return { ok: false, problems };
  const baseSha = resolveCommit(input.root, input.base);
  if (!baseSha) return { ok: false, problems: [`base ${input.base} is not a commit here`] };
  const diff = git(input.root, [
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--binary",
    "--end-of-options",
    baseSha,
    "--",
    rel,
  ]).stdout;
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
