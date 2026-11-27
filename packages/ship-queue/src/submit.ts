// @effect-diagnostics nodeBuiltinImport:off - Submit gates: a branch's checks before it takes a place in its repo's queue.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  createJob,
  isEnded,
  listJobIds,
  mark,
  readJob,
  readRegistration,
  writeRegistration,
} from "./jobStore.ts";
import {
  currentBranch,
  isAncestor,
  primaryOf,
  remoteUrl,
  resolveBaseBranch,
  resolveRepoSlug,
  revParse,
  worktreeChanges,
} from "./gitQueries.ts";
import type { JobRecord, ShipQueueDeps } from "./types.ts";
import { readCurrentWorkerVersion, withVersionsLock } from "./workerVersion.ts";

// GitHub refuses bodies over 65,536 characters; the stamp's room is held back at submit.
const BODY_LIMIT = 65_536;
const BODY_STAMP_ROOM = 1_024;
const CLOSING_ISSUE_RE =
  /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+(?:[\w.-]+\/[\w.-]+)?#\d+\b/i;
/** Failures that judged the branch's own work; a cancel or a lost watcher never counts. */
const PREMISE_REASONS = ["rebase_conflict", "house", "push", "merge"];

export interface AgentIdentity {
  readonly session?: string | undefined;
  readonly thread?: string | undefined;
}

export interface SubmitInput {
  readonly worktree: string;
  readonly branch: string;
  readonly title: string;
  readonly body: string;
  readonly identity: AgentIdentity;
  readonly remote?: string | undefined;
}

export type SubmitResult =
  | {
      readonly ok: true;
      readonly id: string;
      readonly record: JobRecord;
      readonly warnings: string[];
    }
  | { readonly ok: false; readonly reason: string };

export function bodyProblem(body: string): string | null {
  const chars = Array.from(body).length;
  if (chars > BODY_LIMIT - BODY_STAMP_ROOM) {
    return `body is ${chars} characters; GitHub allows ${BODY_LIMIT} and the stamp needs ${BODY_STAMP_ROOM}`;
  }
  if (/\[no-issue\]/i.test(body)) {
    return "[no-issue] is not allowed; open an issue describing your changes and reference it with 'Closes #N'";
  }
  if (!CLOSING_ISSUE_RE.test(body)) {
    return "body names no issue; write 'Closes #N' for the issue this work completes";
  }
  return null;
}

/** The submitter's provenance, appended once so the PR and its merge commit never drop it. */
export function stampBody(body: string, identity: AgentIdentity): string {
  const lines: string[] = [];
  const session = identity.session?.trim();
  const thread = identity.thread?.trim();
  if (session && !body.includes(`Agent Session: ${session}`))
    lines.push(`Agent Session: ${session}`);
  if (thread && !body.includes(`Agent Thread: ${thread}`)) lines.push(`Agent Thread: ${thread}`);
  if (lines.length === 0) return body;
  return `${body.replace(/\s+$/, "")}\n\n${lines.join("\n")}\n`;
}

function premiseReasonKey(reason: string | undefined): string | null {
  if (!reason) return null;
  const head = reason.split(/[\s:]/)[0] ?? "";
  return PREMISE_REASONS.some((gate) => head === gate || head.startsWith(`${gate}_`))
    ? reason
    : null;
}

/**
 * Two ended jobs of a branch failing at one gate in a row: the third submit states the belief
 * behind its fix under `## Premise`.
 */
export function premiseProblem(
  root: string,
  repo: string,
  branch: string,
  body: string,
): string | null {
  const ended = listJobIds(root)
    .map((id) => readJob(root, id))
    .filter((job): job is JobRecord => job !== null && job.repo === repo && job.branch === branch)
    .filter(isEnded);
  const lastTwo = ended.slice(-2);
  if (lastTwo.length < 2 || lastTwo.some((job) => job.state !== "failed")) return null;
  const [a, b] = lastTwo.map((job) => premiseReasonKey(job.reason));
  if (!a || a !== b) return null;
  if (/^## Premise\s*$/m.test(body)) return null;
  return `the last two jobs of ${branch} failed with "${a}"; state the premise of this fix under '## Premise' (Premise:, Test:, Result:)`;
}

function openJobs(root: string): JobRecord[] {
  return listJobIds(root, { open: true })
    .map((id) => readJob(root, id))
    .filter((job): job is JobRecord => job !== null && !isEnded(job));
}

async function stackedOn(
  deps: ShipQueueDeps,
  worktree: string,
  branch: string,
  repo: string,
  baseRef: string,
): Promise<string | null> {
  for (const other of openJobs(deps.root)) {
    if (other.repo !== repo || other.branch === branch || !other.head_sha) continue;
    if (await isAncestor(deps.run, worktree, other.head_sha, baseRef)) continue;
    if (await isAncestor(deps.run, worktree, other.head_sha, branch)) return other.branch;
  }
  return null;
}

export async function submitJob(deps: ShipQueueDeps, input: SubmitInput): Promise<SubmitResult> {
  const refuse = (reason: string): SubmitResult => ({ ok: false, reason });
  const remote = input.remote ?? "origin";
  const worktree = NodePath.resolve(input.worktree);
  const dotGit = NodePath.join(worktree, ".git");
  if (!NodeFS.existsSync(dotGit)) return refuse(`not a git checkout: ${worktree}`);
  if (!NodeFS.statSync(dotGit).isFile()) {
    return refuse(
      `${worktree} is a primary checkout, not a worktree: ship from your own worktree on its own branch`,
    );
  }
  if (!input.title.trim()) return refuse("empty title");
  const bodyWhy = bodyProblem(input.body);
  if (bodyWhy) return refuse(bodyWhy);

  const repo = await resolveRepoSlug(deps.run, worktree, remote);
  if (!repo) return refuse(`cannot resolve the repository from remote '${remote}' of ${worktree}`);
  const baseBranch = await resolveBaseBranch(deps.run, worktree, remote);
  if ([baseBranch, "main", "master"].includes(input.branch)) {
    return refuse(`a job is one branch on its own worktree, never ${input.branch}`);
  }
  const onBranch = await currentBranch(deps.run, worktree);
  if (onBranch !== input.branch) return refuse(`${worktree} is not on ${input.branch}`);
  if ((await worktreeChanges(deps.run, worktree)).length > 0) {
    return refuse(`${worktree} has uncommitted changes`);
  }
  const headSha = await revParse(deps.run, worktree, input.branch);
  if (!headSha) return refuse(`cannot resolve ${input.branch} in ${worktree}`);
  const primary = await primaryOf(deps.run, worktree);
  const url = await remoteUrl(deps.run, worktree, remote);
  if (!primary || !url) return refuse(`cannot read the primary checkout or remote of ${worktree}`);

  const reg = readRegistration(deps.root, repo);
  if (reg && reg.primary !== primary) {
    return refuse(
      `${repo} is registered to ${reg.primary}, not ${primary}: another checkout already ships under that name`,
    );
  }
  if (reg && reg.remoteUrl !== url)
    return refuse(`${repo} is registered to the remote ${reg.remoteUrl}, not ${url}`);

  if (openJobs(deps.root).some((job) => job.repo === repo && job.branch === input.branch)) {
    return refuse(`${repo} ${input.branch} is already queued or running`);
  }
  const baseRef = (await revParse(deps.run, worktree, `${remote}/${baseBranch}`)) ?? baseBranch;
  const stacked = await stackedOn(deps, worktree, input.branch, repo, baseRef);
  if (stacked) {
    return refuse(
      `${input.branch} carries the unmerged commits of ${stacked}: stacked branches do not ship; ship that one first`,
    );
  }
  const premiseWhy = premiseProblem(deps.root, repo, input.branch, input.body);
  if (premiseWhy) return refuse(premiseWhy);

  const warnings: string[] = [];
  if (!input.identity.session?.trim() && !input.identity.thread?.trim()) {
    warnings.push(
      "the PR carries no agent stamp: no agent session or thread is known for this submit",
    );
  }
  writeRegistration(deps.root, repo, { primary, remoteUrl: url });
  const stampedBody = stampBody(input.body, input.identity);
  const created = withVersionsLock(
    deps.root,
    { self: deps.self, isAlive: deps.isProcessAlive },
    () => {
      const pinnedVersion = deps.workerVersion ?? readCurrentWorkerVersion(deps.root);
      return createJob(
        deps.root,
        {
          repo,
          primary,
          worktree,
          branch: input.branch,
          base_branch: baseBranch,
          remote,
          title: input.title.trim(),
          head_sha: headSha,
          ...(input.identity.thread?.trim() ? { thread_id: input.identity.thread.trim() } : {}),
          ...(pinnedVersion
            ? { worker_version: pinnedVersion.version, worker_entry: pinnedVersion.entryPath }
            : {}),
        },
        stampedBody,
        deps.clock,
      );
    },
  );
  if (!created.acquired) {
    return refuse("queue versions lock is held by another live process; retry submit");
  }
  const { id, record } = created.value;
  mark(
    deps.root,
    id,
    `QUEUED job=${id} branch=${input.branch} worktree=${worktree} at=${record.submitted_at}`,
  );
  return { ok: true, id, record, warnings };
}
