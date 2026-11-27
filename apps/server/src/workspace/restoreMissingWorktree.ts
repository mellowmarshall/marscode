import { ThreadId, type ProjectId, type TerminalCwdNotFoundError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import { scratchFolderRoot } from "../project/ManagedProjectFolders.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { makeIsManagedWorktreePath } from "../worktreesDirectory.ts";
import { isWithinRoot } from "./KnownWorkspaces.ts";
import { withWorkspaceLease } from "./workspaceLease.ts";
import * as TaskFolders from "./TaskFolders.ts";
import { TerminalCwdRecovery } from "../terminal/Manager.ts";

export class WorktreeRecreateError extends Schema.TaggedError<WorktreeRecreateError>()(
  "WorktreeRecreateError",
  {
    worktreePath: Schema.String,
    branch: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Could not recreate the worktree for branch '${this.branch}' at ${this.worktreePath}.`;
  }
}

// `git worktree remove` skips pnpm junctions on Windows, leaving these behind without a checkout.
const LEFTOVER_WORKTREE_ENTRIES = new Set(["node_modules", ".next"]);

export interface RestoreWorktreeResult {
  readonly outcome: "unchanged" | "restored" | "detached";
  readonly fallbackCwd?: string;
}

const UNCHANGED_RESULT: RestoreWorktreeResult = { outcome: "unchanged" };

interface WorktreeThread {
  readonly id: ThreadId;
  readonly projectId: ProjectId;
  readonly worktreePath: string | null;
  readonly branch: string | null;
}

export const findBranchRestoreSource = Effect.fn("restoreMissingWorktree.findBranchRestoreSource")(
  function* (
    gitWorkflow: GitWorkflowService.GitWorkflowService["Service"],
    cwd: string,
    branch: string,
  ) {
    const localBranchNames = yield* gitWorkflow.listLocalBranchNames(cwd);
    if (localBranchNames.includes(branch)) {
      return { kind: "local" as const };
    }
    const remoteName = yield* gitWorkflow
      .resolvePrimaryRemoteName(cwd)
      .pipe(Effect.orElseSucceed(() => null));
    // Push keeps the tracking ref current, so recovery reads it without fetching.
    const pushedRef = remoteName === null ? null : `refs/remotes/${remoteName}/${branch}`;
    if (pushedRef !== null && (yield* gitWorkflow.hasCommit({ cwd, refName: pushedRef }))) {
      return { kind: "remote" as const, pushedRef };
    }
    return { kind: "missing" as const };
  },
);

export const makeRestoreMissingWorktree = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;
  const projects = yield* ProjectService.ProjectService;
  const isManagedWorktreePath = yield* makeIsManagedWorktreePath;
  const serverConfig = yield* ServerConfig.ServerConfig;

  // Storage cleanup prunes idle No project folders, which have no branch to restore from.
  // An empty folder, only directly inside the No project's own root, lets the thread run again.
  const recreateScratchFolder = Effect.fn("restoreMissingWorktree.recreateScratchFolder")(
    function* (thread: WorktreeThread, folder: string) {
      if (path.resolve(folder) !== folder || (yield* fileSystem.exists(folder)))
        return UNCHANGED_RESULT;
      const project = Option.getOrUndefined(yield* projects.getById(thread.projectId));
      if (project === undefined || path.dirname(folder) !== path.resolve(project.workspaceRoot))
        return UNCHANGED_RESULT;
      const root = scratchFolderRoot(serverConfig.baseDir, path);
      const realRoot = yield* fileSystem.realPath(root).pipe(Effect.orElseSucceed(() => root));
      if (path.dirname(folder) !== root && path.dirname(folder) !== realRoot)
        return UNCHANGED_RESULT;
      yield* Effect.logWarning("recreating missing scratch folder", {
        threadId: thread.id,
        folder,
      });
      yield* fileSystem.makeDirectory(folder, { recursive: true });
      return { outcome: "restored" } satisfies RestoreWorktreeResult;
    },
    // Turn start reports a folder that is still missing.
    Effect.orElseSucceed(() => UNCHANGED_RESULT),
  );

  // Only folders holding nothing but leftovers are cleared, never user files.
  const isLeftoverFolder = (worktreePath: string) =>
    fileSystem.exists(path.join(worktreePath, ".git")).pipe(
      Effect.flatMap((hasGit) =>
        hasGit
          ? Effect.succeed(false)
          : fileSystem.readDirectory(worktreePath).pipe(
              Effect.flatMap((entries) =>
                Effect.forEach(entries, (entry) =>
                  LEFTOVER_WORKTREE_ENTRIES.has(entry)
                    ? fileSystem
                        .stat(path.join(worktreePath, entry))
                        .pipe(Effect.map((info) => info.type === "Directory"))
                    : Effect.succeed(false),
                ),
              ),
              Effect.map((leftovers) => leftovers.every(Boolean)),
            ),
      ),
      Effect.orElseSucceed(() => false),
    );
  // `git worktree add` refuses a non-empty target but accepts an empty one. Keep the folder
  // itself: Windows cannot remove a folder that is still a terminal's or provider's cwd.
  const clearLeftovers = (worktreePath: string) =>
    fileSystem
      .readDirectory(worktreePath)
      .pipe(
        Effect.flatMap((entries) =>
          Effect.forEach(
            entries,
            (entry) => fileSystem.remove(path.join(worktreePath, entry), { recursive: true }),
            { discard: true },
          ),
        ),
      );
  const taskFolders = yield* TaskFolders.TaskFolders;

  const recreateMissingWorktree = Effect.fn("restoreMissingWorktree.recreate")(function* (input: {
    readonly cwd: string;
    readonly worktreePath: string;
    readonly branch: string;
    readonly clearLeftover?: boolean;
  }) {
    const { cwd, worktreePath, branch } = input;
    yield* gitWorkflow.pruneWorktrees({ cwd });
    const source = yield* findBranchRestoreSource(gitWorkflow, cwd, branch);
    if (source.kind === "local") {
      if (input.clearLeftover) yield* clearLeftovers(worktreePath);
      yield* gitWorkflow.createWorktree({ cwd, refName: branch, path: worktreePath });
      return "restored" as const;
    }
    if (source.kind === "remote") {
      if (input.clearLeftover) yield* clearLeftovers(worktreePath);
      yield* gitWorkflow.createWorktree({
        cwd,
        refName: source.pushedRef,
        newRefName: branch,
        path: worktreePath,
      });
      return "restored" as const;
    }
    return "detached" as const;
  });

  return Effect.fn("restoreMissingWorktree")(function* (
    thread: WorktreeThread,
  ): Effect.fn.Return<RestoreWorktreeResult, WorktreeRecreateError> {
    const { worktreePath, branch } = thread;
    if (worktreePath === null) return UNCHANGED_RESULT;
    if (branch === null) return yield* recreateScratchFolder(thread, worktreePath);
    // A task folder can miss one repository's worktree while the thread's own folder is there.
    const taskFolder = yield* taskFolders.find(worktreePath).pipe(Effect.orElseSucceed(() => null));
    if (taskFolder !== null) {
      yield* taskFolders
        .restore({
          taskFolder,
          branch,
          recreate: (checkout) =>
            isLeftoverFolder(checkout.worktreePath).pipe(
              Effect.flatMap((leftover) =>
                recreateMissingWorktree({
                  cwd: checkout.repositoryPath,
                  worktreePath: checkout.worktreePath,
                  branch,
                  clearLeftover: leftover,
                }),
              ),
              Effect.tap((outcome) =>
                outcome === "restored"
                  ? Effect.logWarning("recreated missing worktree", {
                      threadId: thread.id,
                      worktreePath: checkout.worktreePath,
                      branch,
                    })
                  : Effect.logInfo("skipping task-folder worktree whose branch was removed", {
                      threadId: thread.id,
                      worktreePath: checkout.worktreePath,
                      branch,
                    }),
              ),
              Effect.asVoid,
            ),
        })
        .pipe(
          Effect.mapError((cause) => new WorktreeRecreateError({ worktreePath, branch, cause })),
        );
      return UNCHANGED_RESULT;
    }
    const exists = yield* fileSystem.exists(worktreePath).pipe(Effect.orElseSucceed(() => true));
    const leftover = exists && (yield* isLeftoverFolder(worktreePath));
    if ((exists && !leftover) || !(yield* isManagedWorktreePath(worktreePath)))
      return UNCHANGED_RESULT;
    const project = yield* projects.getById(thread.projectId).pipe(
      Effect.map(Option.getOrUndefined),
      Effect.orElseSucceed(() => undefined),
    );
    if (project === undefined) return UNCHANGED_RESULT;
    const outcome = yield* recreateMissingWorktree({
      cwd: project.workspaceRoot,
      worktreePath,
      branch,
      clearLeftover: leftover,
    }).pipe(Effect.mapError((cause) => new WorktreeRecreateError({ worktreePath, branch, cause })));
    if (outcome === "detached") {
      yield* Effect.logInfo("detaching thread whose worktree and branch were removed", {
        threadId: thread.id,
        worktreePath,
        branch,
      });
      return { outcome: "detached", fallbackCwd: project.workspaceRoot };
    }
    yield* Effect.logWarning("recreated missing worktree", {
      threadId: thread.id,
      worktreePath,
      branch,
    });
    return { outcome: "restored" };
  });
});

export class ThreadWorktreeRestore extends Context.Service<
  ThreadWorktreeRestore,
  {
    readonly restore: (
      thread: WorktreeThread,
    ) => Effect.Effect<RestoreWorktreeResult, WorktreeRecreateError>;
  }
>()("t3/workspace/restoreMissingWorktree/ThreadWorktreeRestore") {}

// Turn start restores under the same lease, so concurrent restores see each other's worktree.
export const layerThreadWorktreeRestore = Layer.effect(
  ThreadWorktreeRestore,
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const restore = yield* makeRestoreMissingWorktree;
    return {
      restore: Effect.fn("ThreadWorktreeRestore.restore")(function* (thread: WorktreeThread) {
        return yield* thread.worktreePath === null
          ? restore(thread)
          : withWorkspaceLease(path.resolve(thread.worktreePath), restore(thread));
      }),
    };
  }),
);

// Worktree setup uses terminals, so recovery must stay outside TerminalManager.
export const makePrepareTerminalLaunch = Effect.fn(
  "restoreMissingWorktree.makePrepareTerminalLaunch",
)(function* <LookupError>(
  getThreadShell: (threadId: ThreadId) => Effect.Effect<WorktreeThread | null, LookupError>,
  onDetached?: (thread: WorktreeThread) => Effect.Effect<void>,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;
  const projects = yield* ProjectService.ProjectService;
  const taskFolders = yield* TaskFolders.TaskFolders;
  const isManagedWorktreePath = yield* makeIsManagedWorktreePath;
  const restoreMissingWorktree = yield* makeRestoreMissingWorktree;
  return Effect.fn("restoreMissingWorktree.prepareTerminalLaunch")(function* <
    Input extends {
      readonly threadId: string;
      readonly cwd?: string | undefined;
      readonly worktreePath?: string | null | undefined;
    },
  >(input: Input) {
    const thread = yield* getThreadShell(ThreadId.make(input.threadId)).pipe(
      Effect.orElseSucceed(() => null),
    );
    const worktreePath = thread?.worktreePath ?? null;
    if (
      thread === null ||
      worktreePath === null ||
      !isWithinRoot(path, path.resolve(input.cwd ?? worktreePath), worktreePath)
    ) {
      return { input, recover: TerminalCwdRecovery.defaultValue() };
    }
    const taskFolder = yield* taskFolders.find(worktreePath).pipe(Effect.orElseSucceed(() => null));
    if (
      taskFolder === null &&
      thread.branch !== null &&
      !(yield* fileSystem.exists(worktreePath).pipe(Effect.orElseSucceed(() => true))) &&
      (yield* isManagedWorktreePath(worktreePath))
    ) {
      const project = yield* projects.getById(thread.projectId).pipe(
        Effect.map(Option.getOrUndefined),
        Effect.orElseSucceed(() => undefined),
      );
      if (project !== undefined) {
        const source = yield* findBranchRestoreSource(
          gitWorkflow,
          project.workspaceRoot,
          thread.branch,
        ).pipe(Effect.orElseSucceed(() => null));
        if (source?.kind === "missing") {
          if (onDetached) {
            yield* onDetached(thread).pipe(Effect.ignoreCause);
          }
          return {
            input: { ...input, cwd: project.workspaceRoot, worktreePath: null },
            recover: TerminalCwdRecovery.defaultValue(),
          };
        }
      }
    }
    const recover = (error: TerminalCwdNotFoundError) =>
      restoreMissingWorktree(thread).pipe(
        Effect.flatMap((result) =>
          result.outcome === "detached"
            ? (onDetached ? onDetached(thread).pipe(Effect.ignoreCause) : Effect.void).pipe(
                Effect.andThen(Effect.fail(error)),
              )
            : Effect.void,
        ),
        Effect.catch((cause) =>
          Effect.logWarning("failed to recreate missing worktree", {
            threadId: thread.id,
            worktreePath,
            cause,
          }).pipe(Effect.andThen(Effect.fail(error))),
        ),
      );
    // The lease must cover the worktree root, even when the terminal opens in a subdirectory.
    return { input: { ...input, worktreePath }, recover };
  });
});
