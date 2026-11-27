// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Resolves a repo's GitHub visibility through the real gh and caches it in the guard state dir.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { HostGuardsConfig } from "./hostConfig.ts";

export type RepoVisibility = "public" | "private" | "internal" | "unknown";

const SLUG_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const KNOWN: ReadonlySet<string> = new Set(["public", "private", "internal"]);
const CACHE_TTL_MS = 10 * 60_000;
const PROBE_TIMEOUT_MS = 15_000;

type CacheFile = Record<string, { readonly visibility: string; readonly at: number }>;

function cachePath(config: HostGuardsConfig): string {
  return NodePath.join(config.stateDir, "repo-visibility.json");
}

function readCache(config: HostGuardsConfig): CacheFile {
  try {
    const parsed = JSON.parse(NodeFS.readFileSync(cachePath(config), "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as CacheFile)
      : {};
  } catch {
    return {};
  }
}

function writeCache(config: HostGuardsConfig, cache: CacheFile): void {
  try {
    NodeFS.mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
    const tmp = `${cachePath(config)}.${process.pid}.tmp`;
    NodeFS.writeFileSync(tmp, JSON.stringify(cache), { mode: 0o600 });
    NodeFS.renameSync(tmp, cachePath(config));
  } catch {
    // A cache that cannot be written only costs another probe.
  }
}

/**
 * GitHub visibility of `slug` from `gh api repos/<slug>`, cached for a few minutes because every
 * guarded `gh` call is a fresh process. Anything but a clear answer is `unknown` (treat as public).
 */
export function resolveRepoVisibility(
  slug: string,
  config: HostGuardsConfig,
  env: NodeJS.ProcessEnv,
  now: number = Date.now(),
): RepoVisibility {
  const key = slug.toLowerCase();
  if (!SLUG_RE.test(key)) return "unknown";
  const cache = readCache(config);
  const hit = cache[key];
  if (hit && KNOWN.has(hit.visibility) && now - hit.at < CACHE_TTL_MS) {
    return hit.visibility as RepoVisibility;
  }
  const res = NodeChildProcess.spawnSync(
    config.realGh,
    ["api", `repos/${key}`, "--jq", ".visibility"],
    {
      encoding: "utf8",
      timeout: PROBE_TIMEOUT_MS,
      env: { ...env, GH_PROMPT_DISABLED: "1" },
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  const answer = res.status === 0 ? (res.stdout ?? "").trim().toLowerCase() : "";
  if (!KNOWN.has(answer)) return "unknown";
  writeCache(config, { ...cache, [key]: { visibility: answer, at: now } });
  return answer as RepoVisibility;
}

/** Private and internal repos are readable only inside the org; everything else is public. */
export function isPrivateVisibility(visibility: RepoVisibility): boolean {
  return visibility === "private" || visibility === "internal";
}
