// @effect-diagnostics nodeBuiltinImport:off - Read/write ~/.config/reaper/policy.toml with allow-listed cleanup paths, hard-protected T3 history roots, and storage review input checks.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  MIN_AGE_DAYS,
  normalizeAgeDays,
  parseReaperPolicyToml,
  parseReaperPolicyTomlStrict,
  serializeReaperPolicyToml,
  type ReaperPolicyRule,
} from "./ReaperPolicyToml.ts";
import {
  dataProposalRefusal,
  gitRuleRefusal,
  type GitTracksFiles,
} from "./ReaperRulePathChecks.ts";

export interface ReaperPolicyDocument {
  readonly policyPath: string;
  readonly rules: ReadonlyArray<ReaperPolicyRule>;
  readonly protectedHistoryRoots: ReadonlyArray<string>;
}

export interface StorageReviewMountInput {
  readonly mount: string;
  readonly usedPct: number;
  readonly availBytes?: number;
}

const HOST_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;
const MOUNT_PATH_RE = /^\/[A-Za-z0-9._/@-]{0,128}$/;
const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/;
const MAX_REVIEW_MOUNTS = 16;

export function defaultReaperPolicyPath(homeDir: string = NodeOS.homedir()): string {
  return NodePath.join(homeDir, ".config", "reaper", "policy.toml");
}

function normalizePosixPath(raw: string, homeDir: string = NodeOS.homedir()): string {
  const trimmed = raw.trim();
  const expanded =
    trimmed.startsWith("~/") || trimmed === "~"
      ? NodePath.join(homeDir, trimmed.slice(1))
      : trimmed;
  const resolved = NodePath.resolve(expanded);
  return resolved.length > 1 ? resolved.replace(/\/+$/, "") : resolved;
}

/**
 * Resolve symlinks for `raw`, walking up to the nearest existing ancestor when
 * the target path itself does not yet exist on disk.
 */
function resolveCanonicalPath(raw: string, homeDir: string = NodeOS.homedir()): string {
  const normalized = normalizePosixPath(raw, homeDir);
  const tail: string[] = [];
  let cursor = normalized;
  while (true) {
    try {
      const real = NodeFS.realpathSync(cursor);
      const joined = tail.length > 0 ? NodePath.join(real, ...tail.toReversed()) : real;
      return joined.length > 1 ? joined.replace(/\/+$/, "") : joined;
    } catch {
      const parent = NodePath.dirname(cursor);
      if (parent === cursor) return normalized;
      tail.push(NodePath.basename(cursor));
      cursor = parent;
    }
  }
}

function pathsOverlap(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

function isRelativeSubpath(root: string, candidate: string, minDepth: number): boolean {
  const rel = NodePath.relative(root, candidate);
  if (!rel || rel.startsWith("..") || NodePath.isAbsolute(rel)) return false;
  return rel.split(NodePath.sep).filter(Boolean).length >= minDepth;
}

/** Allow-list safe cleanup roots matching `agent_reap_storage.py:_is_safe_reap_root` + user caches. */
async function checkAllowedReaperPath(
  canonicalPath: string,
  canonicalHome: string,
  tracksFiles: GitTracksFiles,
): Promise<string | null> {
  const gitRefusal = await gitRuleRefusal(canonicalPath, tracksFiles);
  if (gitRefusal) return gitRefusal;
  // Evaluate $HOME rules first so an ephemeral/test $HOME under /tmp still enforces $HOME allow-listing.
  if (canonicalPath === canonicalHome || isRelativeSubpath(canonicalHome, canonicalPath, 1)) {
    const cacheExactOrSub = [
      NodePath.join(canonicalHome, ".npm", "_cacache"),
      NodePath.join(canonicalHome, ".cargo", "registry"),
      NodePath.join(canonicalHome, ".cargo", "git"),
      NodePath.join(canonicalHome, ".pnpm-store"),
      NodePath.join(canonicalHome, ".local", "share", "Trash"),
    ].map((p) => resolveCanonicalPath(p, canonicalHome));
    if (
      cacheExactOrSub.some((r) => canonicalPath === r || isRelativeSubpath(r, canonicalPath, 1)) ||
      isRelativeSubpath(
        resolveCanonicalPath(NodePath.join(canonicalHome, ".cache"), canonicalHome),
        canonicalPath,
        1,
      ) ||
      isRelativeSubpath(
        resolveCanonicalPath(NodePath.join(canonicalHome, "Dev"), canonicalHome),
        canonicalPath,
        2,
      )
    ) {
      return null;
    }
    return `Refusing cleanup rule inside $HOME outside allowed cache/Dev subpaths: ${canonicalPath}`;
  }
  if (
    [
      resolveCanonicalPath("/tmp", canonicalHome),
      resolveCanonicalPath("/var/tmp", canonicalHome),
    ].some((r) => isRelativeSubpath(r, canonicalPath, 1))
  ) {
    return null;
  }
  const dataDevRoot = resolveCanonicalPath("/data/Dev", canonicalHome);
  if (canonicalPath === dataDevRoot || isRelativeSubpath(dataDevRoot, canonicalPath, 1)) {
    return isRelativeSubpath(dataDevRoot, canonicalPath, 2)
      ? null
      : `Refusing repository root cleanup rule (target a subdirectory inside the repo): ${canonicalPath}`;
  }
  if (isRelativeSubpath(resolveCanonicalPath("/data", canonicalHome), canonicalPath, 2)) {
    return null;
  }
  return `Refusing cleanup rule outside allowed roots (/tmp/*, /var/tmp/*, ~/.cache/*, /data/*/*, ~/Dev/*/*): ${canonicalPath}`;
}

/** The allow-list and git checks again, at sweep time, for a rule saved earlier. */
export function sweepTimeRuleRefusal(
  canonicalPath: string,
  homeDir: string,
  tracksFiles: GitTracksFiles,
): Promise<string | null> {
  return checkAllowedReaperPath(canonicalPath, resolveCanonicalPath(homeDir, homeDir), tracksFiles);
}

export async function validateReaperPolicyRules(
  rules: ReadonlyArray<ReaperPolicyRule>,
  protectedHistoryRoots: ReadonlyArray<string>,
  homeDir: string,
  tracksFiles: GitTracksFiles,
  options: { readonly agentProposal?: boolean } = {},
): Promise<
  | { readonly ok: true; readonly rules: ReadonlyArray<ReaperPolicyRule> }
  | { readonly ok: false; readonly error: string }
> {
  const canonicalHome = resolveCanonicalPath(homeDir, homeDir);
  const canonicalProtected = protectedHistoryRoots.map((root) => ({
    raw: root,
    canonical: resolveCanonicalPath(root, homeDir),
  }));
  const seen = new Set<string>();
  const cleaned: ReaperPolicyRule[] = [];

  for (const raw of rules) {
    const trimmed = raw.path.trim();
    if (!trimmed || (!trimmed.startsWith("/") && !trimmed.startsWith("~/"))) {
      return { ok: false, error: `Cleanup rule path must be absolute: "${trimmed || "(empty)"}"` };
    }
    if (CONTROL_CHAR_RE.test(trimmed)) {
      return { ok: false, error: "Cleanup rule path contains invalid control characters" };
    }
    const normalized = normalizePosixPath(trimmed, homeDir);
    try {
      if (NodeFS.lstatSync(normalized).isSymbolicLink()) {
        return { ok: false, error: `Refusing symlink cleanup rule path: ${normalized}` };
      }
    } catch {
      // Path may not exist yet; canonical ancestor check still runs below.
    }
    const canonical = resolveCanonicalPath(trimmed, homeDir);
    const disallowedReason =
      (await checkAllowedReaperPath(canonical, canonicalHome, tracksFiles)) ??
      (options.agentProposal ? dataProposalRefusal(canonical) : null);
    if (disallowedReason) {
      return { ok: false, error: disallowedReason };
    }
    for (const root of canonicalProtected) {
      if (pathsOverlap(canonical, root.canonical)) {
        return {
          ok: false,
          error: `Cleanup rule "${canonical}" overlaps hard-protected T3 history path "${root.raw}"`,
        };
      }
    }
    if (seen.has(canonical)) {
      return { ok: false, error: `Duplicate cleanup rule path: ${canonical}` };
    }
    seen.add(canonical);
    const maxAgeDays = Number(raw.maxAgeDays);
    const keepLatest = Number(raw.keepLatest);
    if (!Number.isFinite(maxAgeDays) || maxAgeDays < MIN_AGE_DAYS || maxAgeDays > 3650) {
      return {
        ok: false,
        error: `maxAgeDays out of range (${MIN_AGE_DAYS}..3650) for ${canonical}`,
      };
    }
    if (!Number.isFinite(keepLatest) || keepLatest < 0 || keepLatest > 1000) {
      return { ok: false, error: `keepLatest out of range (0..1000) for ${canonical}` };
    }
    cleaned.push({
      path: canonical,
      maxAgeDays: normalizeAgeDays(maxAgeDays),
      keepLatest: Math.round(keepLatest),
      enabled: raw.enabled === true,
    });
  }
  return { ok: true, rules: cleaned };
}

export function validateStorageReviewInput(input: {
  readonly host: unknown;
  readonly defaultHost: string;
  readonly mounts?: unknown;
}):
  | {
      readonly ok: true;
      readonly host: string;
      readonly mounts?: ReadonlyArray<StorageReviewMountInput>;
    }
  | { readonly ok: false; readonly error: string } {
  const hostRaw =
    input.host === undefined || input.host === null || input.host === ""
      ? input.defaultHost
      : typeof input.host === "string"
        ? input.host.trim()
        : null;
  if (!hostRaw || !HOST_NAME_RE.test(hostRaw)) {
    return { ok: false, error: "Invalid host name (allowed: 1-64 chars of A-Za-z0-9._-)" };
  }

  if (input.mounts === undefined) {
    return { ok: true, host: hostRaw };
  }
  if (!Array.isArray(input.mounts)) {
    return { ok: false, error: "mounts must be an array" };
  }
  // Drop malformed or non-standard mount entries (e.g. macOS volume names with spaces)
  // rather than failing the whole review launch.
  const mounts: StorageReviewMountInput[] = [];
  for (const item of input.mounts) {
    if (mounts.length >= MAX_REVIEW_MOUNTS) break;
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const row = item as Record<string, unknown>;
    const mount = typeof row.mount === "string" ? row.mount.trim() : "";
    const usedPct = typeof row.usedPct === "number" ? row.usedPct : Number(row.used_pct ?? NaN);
    if (!MOUNT_PATH_RE.test(mount)) continue;
    if (!Number.isFinite(usedPct) || usedPct < 0 || usedPct > 100) continue;
    const availBytes =
      typeof row.availBytes === "number" && Number.isFinite(row.availBytes) && row.availBytes >= 0
        ? row.availBytes
        : undefined;
    mounts.push({
      mount,
      usedPct,
      ...(availBytes !== undefined ? { availBytes } : {}),
    });
  }
  return mounts.length > 0 ? { ok: true, host: hostRaw, mounts } : { ok: true, host: hostRaw };
}

/** Lenient: an unreadable or malformed file reads as no rules, which can only sweep less. */
export function readReaperPolicySync(
  protectedHistoryRoots: ReadonlyArray<string>,
  policyPath: string = defaultReaperPolicyPath(),
): ReaperPolicyDocument {
  let rules: ReadonlyArray<ReaperPolicyRule> = [];
  try {
    const text = NodeFS.readFileSync(policyPath, "utf8");
    rules = parseReaperPolicyToml(text);
  } catch {
    rules = [];
  }
  return { policyPath, rules, protectedHistoryRoots };
}

const isMissing = (cause: unknown) => (cause as NodeJS.ErrnoException)?.code === "ENOENT";

/**
 * Strict, for writers that add to the rules: a file that cannot be read or parsed is an error,
 * so a rewrite never starts from an empty or partial list. A missing file holds no rules.
 */
export async function readReaperPolicyStrict(
  protectedHistoryRoots: ReadonlyArray<string>,
  policyPath: string,
): Promise<
  | { readonly ok: true; readonly document: ReaperPolicyDocument }
  | { readonly ok: false; readonly error: string }
> {
  let text: string;
  try {
    text = await NodeFSP.readFile(policyPath, "utf8");
  } catch (cause) {
    if (isMissing(cause))
      return { ok: true, document: { policyPath, rules: [], protectedHistoryRoots } };
    return { ok: false, error: `Could not read the reaper policy ${policyPath}: ${String(cause)}` };
  }
  const parsed = parseReaperPolicyTomlStrict(text);
  if (!parsed.ok) {
    return { ok: false, error: `Could not parse the reaper policy ${policyPath}: ${parsed.error}` };
  }
  return { ok: true, document: { policyPath, rules: parsed.rules, protectedHistoryRoots } };
}

export async function writeReaperPolicy(
  rules: ReadonlyArray<ReaperPolicyRule>,
  protectedHistoryRoots: ReadonlyArray<string>,
  policyPath: string,
  homeDir: string,
  tracksFiles: GitTracksFiles,
): Promise<
  | { readonly ok: true; readonly document: ReaperPolicyDocument }
  | { readonly ok: false; readonly error: string }
> {
  const validated = await validateReaperPolicyRules(
    rules,
    protectedHistoryRoots,
    homeDir,
    tracksFiles,
  );
  if (!validated.ok) return validated;
  // The file's other sections are kept, so one that cannot be read is not overwritten.
  let existingText: string | undefined;
  try {
    existingText = await NodeFSP.readFile(policyPath, "utf8");
  } catch (cause) {
    if (!isMissing(cause)) {
      return {
        ok: false,
        error: `Could not read the reaper policy ${policyPath}: ${String(cause)}`,
      };
    }
  }
  await NodeFSP.mkdir(NodePath.dirname(policyPath), { recursive: true });
  const tmpPath = `${policyPath}.tmp.${process.pid}.${NodeCrypto.randomUUID()}`;
  await NodeFSP.writeFile(tmpPath, serializeReaperPolicyToml(validated.rules, existingText), {
    encoding: "utf8",
    mode: 0o644,
  });
  await NodeFSP.rename(tmpPath, policyPath);
  return {
    ok: true,
    document: { policyPath, rules: validated.rules, protectedHistoryRoots },
  };
}

export function nextStorageReviewRequestId(): string {
  return `storage-review:${NodeCrypto.randomUUID()}`;
}
