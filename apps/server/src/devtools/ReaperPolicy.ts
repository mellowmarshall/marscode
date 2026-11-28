// @effect-diagnostics nodeBuiltinImport:off - Read/write ~/.config/reaper/policy.toml with allow-listed cleanup paths, hard-protected T3 history roots, and storage review input checks.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { dataProposalRefusal, gitRuleRefusal } from "./ReaperRulePathChecks.ts";

export interface ReaperPolicyRule {
  readonly path: string;
  readonly maxAgeDays: number;
  readonly keepLatest: number;
  readonly enabled: boolean;
}

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
const MIN_AGE_DAYS = 1;

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

export function stripTomlCommentOutsideQuotes(line: string): string {
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if (quote === '"') {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        quote = null;
      }
      continue;
    }
    if (quote === "'") {
      if (ch === "'") quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === "#") {
      return line.slice(0, i).trim();
    }
  }
  return line.trim();
}

export function unquoteTomlString(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    return trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function quoteTomlString(raw: string): string {
  return `"${raw.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function normalizeAgeDays(val: number): number {
  const clamped = Math.max(MIN_AGE_DAYS, Math.min(3650, val));
  return Math.round(clamped * 100) / 100;
}

function parseReaperPolicyToml(text: string): ReadonlyArray<ReaperPolicyRule> {
  const rules: ReaperPolicyRule[] = [];
  let current: {
    path?: string;
    maxAgeDays?: number;
    keepLatest?: number;
    enabled?: boolean;
  } | null = null;

  const flush = () => {
    if (!current || !current.path) return;
    rules.push({
      path: current.path,
      maxAgeDays:
        typeof current.maxAgeDays === "number" &&
        Number.isFinite(current.maxAgeDays) &&
        current.maxAgeDays >= MIN_AGE_DAYS
          ? normalizeAgeDays(current.maxAgeDays)
          : 14,
      keepLatest:
        typeof current.keepLatest === "number" && Number.isFinite(current.keepLatest)
          ? Math.max(0, Math.min(1000, Math.round(current.keepLatest)))
          : 2,
      enabled: current.enabled === true,
    });
    current = null;
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const stripped = stripTomlCommentOutsideQuotes(rawLine);
    if (!stripped) continue;
    if (stripped === "[[approved]]") {
      flush();
      current = {};
      continue;
    }
    if (stripped.startsWith("[")) {
      flush();
      continue;
    }
    if (!current) continue;
    const eq = stripped.indexOf("=");
    if (eq <= 0) continue;
    const key = stripped.slice(0, eq).trim();
    const val = stripped.slice(eq + 1).trim();
    if (key === "path") current.path = unquoteTomlString(val);
    else if (key === "max_age_days") current.maxAgeDays = Number(val);
    else if (key === "keep_latest") current.keepLatest = Number(val);
    else if (key === "enabled") current.enabled = val === "true";
  }
  flush();
  return rules;
}

function preserveNonApprovedToml(existingText: string): string {
  const out: string[] = [];
  let skippingApproved = false;
  for (const rawLine of existingText.split(/\r?\n/)) {
    const stripped = stripTomlCommentOutsideQuotes(rawLine);
    if (stripped === "[[approved]]") {
      skippingApproved = true;
      continue;
    }
    if (stripped.startsWith("[")) {
      skippingApproved = false;
    }
    if (!skippingApproved) {
      out.push(rawLine);
    }
  }
  return out.join("\n").trimEnd();
}

function serializeReaperPolicyToml(
  rules: ReadonlyArray<ReaperPolicyRule>,
  existingText?: string,
): string {
  const preserved = existingText ? preserveNonApprovedToml(existingText) : "";
  const header = preserved
    ? [preserved, ""]
    : [
        "# Approved per-host cleanup policy for agent-tmp-reap.py.",
        "# Only rules with `enabled = true` are swept; T3 Code's manifest `history` paths",
        "# are always hard-protected regardless of rules listed here.",
        "",
      ];
  const lines = [...header];
  for (const rule of rules) {
    lines.push("[[approved]]");
    lines.push(`path = ${quoteTomlString(rule.path)}`);
    lines.push(`max_age_days = ${normalizeAgeDays(rule.maxAgeDays)}`);
    lines.push(`keep_latest = ${Math.max(0, Math.min(1000, Math.round(rule.keepLatest)))}`);
    lines.push(`enabled = ${rule.enabled ? "true" : "false"}`);
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function isRelativeSubpath(root: string, candidate: string, minDepth: number): boolean {
  const rel = NodePath.relative(root, candidate);
  if (!rel || rel.startsWith("..") || NodePath.isAbsolute(rel)) return false;
  return rel.split(NodePath.sep).filter(Boolean).length >= minDepth;
}

/** Allow-list safe cleanup roots matching `agent_reap_storage.py:_is_safe_reap_root` + user caches. */
function checkAllowedReaperPath(canonicalPath: string, canonicalHome: string): string | null {
  const gitRefusal = gitRuleRefusal(canonicalPath);
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
  homeDir: string = NodeOS.homedir(),
): string | null {
  return checkAllowedReaperPath(canonicalPath, resolveCanonicalPath(homeDir, homeDir));
}

export function validateReaperPolicyRules(
  rules: ReadonlyArray<ReaperPolicyRule>,
  protectedHistoryRoots: ReadonlyArray<string>,
  homeDir: string = NodeOS.homedir(),
  options: { readonly agentProposal?: boolean } = {},
):
  | { readonly ok: true; readonly rules: ReadonlyArray<ReaperPolicyRule> }
  | { readonly ok: false; readonly error: string } {
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
      checkAllowedReaperPath(canonical, canonicalHome) ??
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

export async function writeReaperPolicy(
  rules: ReadonlyArray<ReaperPolicyRule>,
  protectedHistoryRoots: ReadonlyArray<string>,
  policyPath: string = defaultReaperPolicyPath(),
  homeDir: string = NodeOS.homedir(),
): Promise<
  | { readonly ok: true; readonly document: ReaperPolicyDocument }
  | { readonly ok: false; readonly error: string }
> {
  const validated = validateReaperPolicyRules(rules, protectedHistoryRoots, homeDir);
  if (!validated.ok) return validated;
  let existingText: string | undefined;
  try {
    existingText = await NodeFSP.readFile(policyPath, "utf8");
  } catch {
    existingText = undefined;
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
