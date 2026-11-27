import type { ProcessRunner, ShipForge } from "./types.ts";

const PR_URL_NUMBER_RE = /\/pull\/(\d+)\s*$/;

async function gh(run: ProcessRunner, cwd: string, args: ReadonlyArray<string>, stdin?: string) {
  return run({ command: "gh", args, cwd, env: { GH_PROMPT_DISABLED: "1" }, stdin });
}

/** GitHub through the `gh` CLI, for the headless queue. */
export function ghForge(run: ProcessRunner): ShipForge {
  return {
    findOpenPullRequest: async ({ cwd, repo, head }) => {
      const res = await gh(run, cwd, [
        "pr",
        "list",
        "--repo",
        repo,
        "--head",
        head,
        "--state",
        "open",
        "--json",
        "number",
        "--limit",
        "1",
      ]);
      if (res.exitCode !== 0) throw new Error(`gh pr list failed: ${res.stderr.trim()}`);
      const rows = JSON.parse(res.stdout || "[]") as ReadonlyArray<{ readonly number?: unknown }>;
      const number = rows[0]?.number;
      return typeof number === "number" ? { number } : null;
    },
    createPullRequest: async ({ cwd, repo, head, base, title, body }) => {
      const res = await gh(
        run,
        cwd,
        [
          "pr",
          "create",
          "--repo",
          repo,
          "--head",
          head,
          "--base",
          base,
          "--title",
          title,
          "--body-file",
          "-",
        ],
        body,
      );
      const number = PR_URL_NUMBER_RE.exec(res.stdout.trim())?.[1];
      if (res.exitCode !== 0 || !number) {
        throw new Error(`gh pr create failed: ${res.stderr.trim() || res.stdout.trim()}`);
      }
      return { number: Number(number) };
    },
    isPullRequestMerged: async ({ cwd, repo, number }) => {
      const res = await gh(run, cwd, [
        "pr",
        "view",
        String(number),
        "--repo",
        repo,
        "--json",
        "state",
      ]);
      if (res.exitCode !== 0) throw new Error(`gh pr view failed: ${res.stderr.trim()}`);
      return (JSON.parse(res.stdout || "{}") as { readonly state?: unknown }).state === "MERGED";
    },
    mergePullRequest: async ({ cwd, repo, number, headSha, title }) => {
      const res = await gh(run, cwd, [
        "pr",
        "merge",
        String(number),
        "--repo",
        repo,
        "--squash",
        "--match-head-commit",
        headSha,
        "--subject",
        `${title} (#${number})`,
      ]);
      return { exitCode: res.exitCode, message: `${res.stdout}${res.stderr}`.trim() };
    },
  };
}
