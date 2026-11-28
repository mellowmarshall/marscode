// @effect-diagnostics nodeBuiltinImport:off - Reads git's index and HEAD tree and the worktree to place an exception's file.
/**
 * Whether an issue-backed size exception (§1.3) passes without the owner: its subject is one
 * tracked regular file at HEAD, and its issue is an open issue of this same repository. Every
 * other answer (another repository, closed, unreadable, too slow, cancelled) is the owner's.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { ghIssueState, inBatches, showRef, type IssueLookup } from "./exceptionIssues.ts";
import { git, originSlug } from "./git.ts";
import type { IssueBackedException } from "./ratchet.ts";

/** At most this many gh calls at once, and this long for all of them. */
const PARALLEL = 4;
const DEADLINE_MS = 60_000;

/** Why REL is not one tracked regular file at HEAD inside ROOT; null when it is one. */
export function trackedFileScope(root: string, rel: string): string | null {
  const spec = `:(literal)${rel}`;
  if (git(root, ["ls-files", "--error-unmatch", "--", spec]).code !== 0) {
    return NodeFS.existsSync(NodePath.join(root, rel)) &&
      NodeFS.statSync(NodePath.join(root, rel)).isDirectory()
      ? "a directory scope"
      : "a file git does not track";
  }
  const entry = git(root, ["ls-tree", "-z", "HEAD", "--", spec]).stdout.replace(/\0$/, "");
  const mode = entry.split(" ")[0];
  if (!entry.endsWith(`\t${rel}`)) return "a file not at HEAD";
  if (mode === "040000") return "a directory scope";
  if (mode !== "100644" && mode !== "100755") return "not a regular file at HEAD";
  try {
    const top = NodeFS.realpathSync(root);
    const full = NodePath.join(top, rel);
    if (!NodeFS.lstatSync(full).isFile()) return "not a regular file";
    if (!NodeFS.realpathSync(full).startsWith(top + NodePath.sep)) return "a path outside the repo";
  } catch {
    return "a file missing from the worktree";
  }
  return null;
}

export interface IssueJudgement {
  readonly accepted: ReadonlyArray<string>;
  readonly problems: ReadonlyArray<string>;
}

/** Each issue-backed exception: accepted when its issue is an open issue of this repository. */
export async function judgeIssueBacked(
  root: string,
  entries: ReadonlyArray<IssueBackedException>,
  options: {
    readonly issueState?: IssueLookup | undefined;
    readonly env?: NodeJS.ProcessEnv | undefined;
    readonly signal?: AbortSignal | undefined;
  },
): Promise<IssueJudgement> {
  if (entries.length === 0) return { accepted: [], problems: [] };
  const lookup: IssueLookup =
    options.issueState ??
    ((repo, number, signal) => ghIssueState(repo, number, signal, options.env ?? process.env));
  const deadline = AbortSignal.timeout(DEADLINE_MS);
  const signal = options.signal ? AbortSignal.any([deadline, options.signal]) : deadline;
  const own = originSlug(root);
  const reasons = await inBatches(
    entries.map((entry) => async (): Promise<string[]> => {
      const why: string[] = [];
      for (const ref of entry.refs) {
        const repo = ref.repo ?? own;
        if (own === null) {
          why.push(`issue ${showRef(ref)} cannot be checked: the repo has no GitHub origin`);
        } else if (repo === null || repo.toLowerCase() !== own.toLowerCase()) {
          why.push(`issue ${showRef(ref)} is not in this repository (${own})`);
        } else if (signal.aborted) {
          why.push(`issue ${showRef(ref)} cannot be checked (the issue checks ran out of time)`);
        } else {
          const state = await lookup(own, ref.number, signal);
          if (state.kind === "closed") why.push(`issue ${showRef(ref)} is closed`);
          else if (state.kind === "unknown") {
            why.push(`issue ${showRef(ref)} cannot be checked (${state.why})`);
          }
        }
      }
      return why;
    }),
    PARALLEL,
  );
  const accepted: string[] = [];
  const problems: string[] = [];
  entries.forEach((entry, i) => {
    const why = reasons[i]!;
    if (why.length === 0)
      accepted.push(`'${entry.subject}' (${entry.refs.map(showRef).join(", ")})`);
    else {
      problems.push(
        `${entry.where} adds scoped exception '${entry.subject}': ${why.join("; ")} (requires owner override, §1.3)`,
      );
    }
  });
  return { accepted, problems };
}
