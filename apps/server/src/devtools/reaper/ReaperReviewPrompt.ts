/** The Agent cleanup review's instructions: find safe cleanup targets and propose them as Reaper rules. */
import type { StorageReviewMountInput } from "../ReaperPolicy.ts";
import type { StorageManifest } from "../StorageManifest.ts";

export const REAPER_PROPOSE_TOOL = "t3_reaper_propose_rules";

export function buildStorageCleanupReviewPrompt(input: {
  readonly host: string;
  /** Rules land in this server's own policy, so only a review of this machine proposes them. */
  readonly isLocalHost: boolean;
  readonly mounts?: ReadonlyArray<StorageReviewMountInput>;
  readonly manifest?: StorageManifest | null;
}): string {
  const mountSummary =
    input.mounts && input.mounts.length > 0
      ? input.mounts.map((m) => `- \`${m.mount}\`: ${m.usedPct.toFixed(1)}% used`).join("\n")
      : "- Run `df -h` and inspect `/` and `/data` (or `/Users` on macOS).";
  const protectedList = (input.manifest?.entries ?? [])
    .filter((e) => e.trust === "history")
    .map((e) => `- \`${e.path}\` (${e.provider})`)
    .slice(0, 12)
    .join("\n");

  const output = input.isLocalHost
    ? [
        `5. Finish by calling the \`${REAPER_PROPOSE_TOOL}\` tool with one rule per recurring \`garbage\` or \`safe\` directory. For each rule give \`path\`, \`maxAgeDays\`, \`keepLatest\`, and, in plain words for the user, \`deletes\` (what it deletes) and \`safeBecause\` (why that is safe: who owns it, how it comes back). The user sees a measured preview, accepts or rejects each rule in the Reaper tab, and turns accepted rules on; nothing is deleted before that.`,
        "6. If the tool refuses a rule, read the reason and either fix the path (target a subdirectory) or drop the rule. Then tell the user, in a short summary, which rules wait for them in the Reaper tab.",
      ]
    : [
        `5. This review targets a remote machine, and \`${REAPER_PROPOSE_TOOL}\` adds rules only to this machine. Do not call it. List your proposed rules (path, max age, keep latest, what it deletes, why it is safe) in the report instead.`,
      ];

  return [
    `Review disk usage on host **${input.host}** and find directories the Reaper can clean safely. You only inspect and propose. Never delete, move, or truncate anything yourself, even if it looks like garbage.`,
    "",
    "Current mount pressure:",
    mountSummary,
    "",
    "Instructions:",
    "1. Find the largest consumers with read-only commands (`du -xh --max-depth=2`, `ls -la`, `stat`). Use SSH for a remote host.",
    "2. For each candidate, check these four things before you call it safe:",
    "   - **Ownership**: which tool or project writes it (a cache dir name, a lockfile, a `target/` next to `Cargo.toml`). Unknown owner means `check`.",
    "   - **Age**: when entries were last written (`find <dir> -maxdepth 1 -mtime +N`). Recent writes mean something still uses it.",
    "   - **Regenerability**: build caches, package caches, temp files, and leftovers of merged worktrees come back by themselves. Data, models you trained, and anything without a source do not.",
    "   - **Protection**: never propose a repo or worktree root (a directory with `.git`), version-control history, T3 Code or agent history, a live database, credentials, backups, or the user's own documents and data.",
    "   - **Inside a checkout or under `/data`**: propose only build output (`target`, `node_modules`, `dist`, `build`, `.next`, `.turbo`, `.cache`, `out`, `coverage`, `__pycache__`, `.venv`) or tmp and cache directories. The tool refuses anything else there.",
    "3. Classify every notable consumer into exactly one bucket:",
    "   - **`garbage`**: dead caches, stale temp or build output, leftovers of merged worktrees.",
    "   - **`safe`**: reproducible artifacts that rebuild with small cost.",
    "   - **`check`**: large data, checkpoints, or active project output that needs the owner first.",
    "   - **`preserve`**: active repos, history, databases, credentials, backups, user data (NEVER delete).",
    "4. Present a short Markdown table: Path, Size, Bucket, Reason.",
    ...output,
    ...(protectedList
      ? ["", "Hard-protected T3 history roots (always `preserve`):", protectedList]
      : []),
  ].join("\n");
}
