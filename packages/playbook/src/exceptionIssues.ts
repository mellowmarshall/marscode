// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - Asks GitHub (the gh CLI) whether an exception's issue is open.
/**
 * The issue a scoped size exception names (§1.3, its `issue` field: "#N" or "owner/repo#N"),
 * and whether GitHub says it is an open issue of that repository. Without a clear answer
 * from gh (missing, signed out, offline, too slow, moved), the owner decides (fail closed).
 */
import * as NodeChildProcess from "node:child_process";

export interface IssueRef {
  /** "owner/repo", or null for the repo's own issue. */
  readonly repo: string | null;
  readonly number: number;
}

export type IssueState =
  | { readonly kind: "open" }
  | { readonly kind: "closed" }
  | { readonly kind: "unknown"; readonly why: string };

/** Asks whether REPO#NUMBER ("owner/repo") is an open issue; SIGNAL stops the question. */
export type IssueLookup = (
  repo: string,
  number: number,
  signal: AbortSignal,
) => Promise<IssueState>;

const FIELD = /^(?:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+))?#([1-9][0-9]*)$/;
/** One gh call's limit. */
const CALL_MS = 20_000;

/** The issue an exception's `issue` field names; none when it has no such field. */
export function exceptionIssueRefs(
  entry: Readonly<Record<string, unknown>>,
): ReadonlyArray<IssueRef> {
  if (typeof entry.issue !== "string") return [];
  const m = FIELD.exec(entry.issue.trim());
  return m ? [{ repo: m[1] ?? null, number: Number(m[2]) }] : [];
}

export const showRef = (ref: IssueRef) => `${ref.repo ?? ""}#${ref.number}`;

/**
 * gh's answer for REPO#NUMBER, from the REST issue: a pull request (a `pull_request` key)
 * is not an issue, and one GitHub serves from another URL (moved or transferred) is unknown.
 */
export function ghIssueState(
  repo: string,
  number: number,
  signal: AbortSignal,
  env: NodeJS.ProcessEnv = process.env,
): Promise<IssueState> {
  const unknown = (why: string): IssueState => ({ kind: "unknown", why });
  return new Promise((done) => {
    if (signal.aborted) return done(unknown("the issue checks ran out of time"));
    let out = "";
    let err = "";
    const child = NodeChildProcess.spawn("gh", ["api", `repos/${repo}/issues/${number}`], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stop = () => child.kill("SIGKILL");
    const timer = setTimeout(stop, CALL_MS);
    signal.addEventListener("abort", stop, { once: true });
    child.stdout.on("data", (b: Buffer) => (out += b.toString("utf8")));
    child.stderr.on("data", (b: Buffer) => (err += b.toString("utf8")));
    const finish = (state: IssueState) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
      done(state);
    };
    child.on("error", (cause) => finish(unknown(`gh is unavailable (${cause.message})`)));
    child.on("close", (status, sig) => {
      if (sig !== null) return finish(unknown(`gh did not answer for ${repo}#${number} in time`));
      if (status !== 0) {
        const tail = (err || out).trim().split("\n").at(-1) ?? "";
        return finish(unknown(`gh could not read ${repo}#${number}${tail ? `: ${tail}` : ""}`));
      }
      let data: unknown;
      try {
        data = JSON.parse(out);
      } catch {
        return finish(unknown(`gh gave no JSON for ${repo}#${number}`));
      }
      const issue = (typeof data === "object" && data !== null ? data : {}) as Record<
        string,
        unknown
      >;
      if ("pull_request" in issue) return finish(unknown(`${repo}#${number} is a pull request`));
      const want = `https://github.com/${repo}/issues/${number}`;
      const url = typeof issue.html_url === "string" ? issue.html_url : "";
      if (url.toLowerCase() !== want.toLowerCase()) {
        return finish(unknown(`${repo}#${number} is served as ${url || "nothing"} (moved?)`));
      }
      if (issue.state === "open") return finish({ kind: "open" });
      if (issue.state === "closed") return finish({ kind: "closed" });
      finish(unknown(`gh gave the state ${JSON.stringify(issue.state)} for ${repo}#${number}`));
    });
  });
}

/** Run TASKS at most LIMIT at a time; each result in order. */
export async function inBatches<T>(
  tasks: ReadonlyArray<() => Promise<T>>,
  limit: number,
): Promise<T[]> {
  const out: T[] = Array.from({ length: tasks.length });
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const i = next;
      next += 1;
      out[i] = await tasks[i]!();
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return out;
}
