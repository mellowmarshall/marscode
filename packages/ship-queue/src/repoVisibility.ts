// @effect-diagnostics nodeBuiltinImport:off - Caches a repo's GitHub visibility in a job file across worker restarts.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { ProcessRunner, RepoVisibility } from "./types.ts";

const SLUG_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const KNOWN: ReadonlySet<string> = new Set(["public", "private", "internal"]);
const PROBE_TIMEOUT_MS = 30_000;

function isKnown(value: string): value is Exclude<RepoVisibility, "unknown"> {
  return KNOWN.has(value);
}

function readCache(cacheFile: string | undefined): RepoVisibility | null {
  if (!cacheFile) return null;
  try {
    const cached = NodeFS.readFileSync(cacheFile, "utf8").trim();
    return isKnown(cached) ? cached : null;
  } catch {
    return null;
  }
}

/**
 * GitHub visibility of `slug` through `gh api`, cached in `cacheFile` when given (a job's
 * lifetime). Anything but a clear answer is `unknown`, which callers treat as public.
 */
export async function readRepoVisibility(
  run: ProcessRunner,
  cwd: string,
  slug: string,
  cacheFile?: string,
): Promise<RepoVisibility> {
  const known = readCache(cacheFile);
  if (known) return known;
  if (!SLUG_RE.test(slug)) return "unknown";
  let answer = "";
  try {
    const res = await run({
      command: "gh",
      args: ["api", `repos/${slug}`, "--jq", ".visibility"],
      cwd,
      env: { GH_PROMPT_DISABLED: "1" },
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    if (res.exitCode === 0) answer = res.stdout.trim().toLowerCase();
  } catch {
    return "unknown";
  }
  if (!isKnown(answer)) return "unknown";
  if (cacheFile) {
    NodeFS.mkdirSync(NodePath.dirname(cacheFile), { recursive: true });
    NodeFS.writeFileSync(cacheFile, `${answer}\n`, "utf8");
  }
  return answer;
}

/** Private and internal repos are readable only inside the org; everything else is public. */
export function isPrivateVisibility(visibility: RepoVisibility): boolean {
  return visibility === "private" || visibility === "internal";
}
