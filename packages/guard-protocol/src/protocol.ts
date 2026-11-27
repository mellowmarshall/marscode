// @effect-diagnostics nodeBuiltinImport:off - Shared wire schema, validation, and bundle eligibility rules for host-guard approvals.
import { argvSha256, HEX_SHA256_RE, normalizeRepoSlug, normalizeSortedUnique } from "./digests.ts";
import { redactArgvCommand } from "./redaction.ts";

export const GUARD_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;
export const MAX_GUARD_ARGS = 256;
export const MAX_BUNDLE_GATES = 32;
export const MAX_BUNDLE_PATHS = 128;

/**
 * Whole-commit gates judge the entire tree at HEAD (not isolated protected files).
 * Locked rule: these gates bind strictly to the exact commit SHA and ALWAYS require fresh
 * approval on any new commit — never carried over across resubmits.
 */
export const WHOLE_COMMIT_GATES: ReadonlySet<string> = new Set([
  "no-review",
  "unproven",
  "ci-run-judge",
]);

export function normalizeGateId(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-");
}

export function isWholeCommitGate(gateId: string): boolean {
  const normalized = normalizeGateId(gateId);
  for (const base of WHOLE_COMMIT_GATES) {
    if (normalized === base || normalized.startsWith(`${base}-`)) {
      return true;
    }
  }
  return false;
}

/**
 * Guards that are never eligible for reusable bundled approval.
 */
export const ALWAYS_ONCE_GUARDS: ReadonlySet<string> = new Set([
  "argv",
  "release-guard",
  "release_guard",
  "git-push",
  "git_push",
  "deps-decide",
  "deps_decide",
  "home-dev-install",
  "home_dev_install",
  "fly-deploy",
  "fly_deploy",
]);

export type GuardGrantScope = "once" | "bundle";

export interface GuardBundleGate {
  readonly gateId: string;
  readonly reason: string;
}

export interface GuardBundleSpec {
  readonly repo: string;
  readonly branch: string;
  readonly prOrIssue: string;
  readonly gates: ReadonlyArray<GuardBundleGate>;
  readonly protectedPaths: ReadonlyArray<string>;
  readonly protectedDiffSha256: string;
  readonly bodySha256: string;
  readonly commitSha: string;
  readonly diffPreview?: string | undefined;
  readonly summary: string;
}

export interface PendingGuardRequest {
  readonly requestId: string;
  readonly guard: string;
  readonly command: ReadonlyArray<string>;
  readonly argvSha256: string;
  readonly cwd: string;
  readonly refusal: string;
  readonly proposedReason: string;
  readonly threadId: string;
  readonly session: string;
  readonly pid: number;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly bundle?: GuardBundleSpec | undefined;
  readonly bundleEligible?: boolean | undefined;
  readonly wholeCommitGates?: ReadonlyArray<string> | undefined;
}

export interface ActiveGuardBundleGrant {
  readonly kind: "guard_bundle";
  readonly grantId: string;
  readonly threadId: string;
  readonly repo: string;
  readonly branch: string;
  readonly prOrIssue: string;
  readonly guard: string;
  readonly gateIds: ReadonlyArray<string>;
  readonly protectedPaths: ReadonlyArray<string>;
  readonly protectedDiffSha256: string;
  readonly bodySha256: string;
  readonly summary: string;
  readonly reason: string;
  readonly approvedVia: string;
  readonly createdAt: string;
  readonly expiresAt: string | null;
  readonly useCount: number;
  readonly lastUsedAt: string | null;
}

export interface ActiveSecretGrant {
  readonly kind: "secret_access";
  readonly grantId: string;
  readonly threadId: string;
  readonly projectId: string;
  readonly delivery: "secretRef" | "file";
  readonly summary: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export type UnifiedActiveGrant = ActiveGuardBundleGrant | ActiveSecretGrant;

export type GuardBrokerEvent =
  | {
      readonly type: "snapshot";
      readonly pending: ReadonlyArray<PendingGuardRequest>;
      readonly grants?: ReadonlyArray<UnifiedActiveGrant> | undefined;
    }
  | { readonly type: "pending_added"; readonly request: PendingGuardRequest }
  | {
      readonly type: "pending_resolved";
      readonly requestId: string;
      readonly decision: "approved" | "denied" | "expired" | "disconnected";
    }
  | {
      readonly type: "grants_changed";
      readonly grants: ReadonlyArray<UnifiedActiveGrant>;
    };

export function sanitizeText(value: unknown, maxLen: number): string {
  if (typeof value !== "string") return "";
  // Strip C0 control chars and Unicode bidi override chars to avoid spoofing in UI/logs.
  const cleaned = value.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, " ").trim();
  return cleaned.length > maxLen ? cleaned.slice(0, maxLen) : cleaned;
}

export function sanitizeMultilinePreview(value: unknown, maxLen: number): string {
  if (typeof value !== "string") return "";
  const cleaned = value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, "")
    .trim();
  return cleaned.length > maxLen ? `${cleaned.slice(0, maxLen - 1)}…` : cleaned;
}

export function validateGuardAndCommand(
  rawGuard: unknown,
  rawCommand: unknown,
  suppliedDigest?: unknown,
):
  | {
      readonly ok: true;
      readonly guard: string;
      readonly displayCommand: ReadonlyArray<string>;
      readonly digest: string;
    }
  | { readonly ok: false; readonly error: string } {
  if (typeof rawGuard !== "string" || !GUARD_NAME_RE.test(rawGuard)) {
    return { ok: false, error: "invalid guard name" };
  }
  if (!Array.isArray(rawCommand) || rawCommand.length === 0) {
    return { ok: false, error: "command must be a non-empty string array" };
  }
  if (rawCommand.length > MAX_GUARD_ARGS) {
    return { ok: false, error: `command exceeds max ${MAX_GUARD_ARGS} arguments` };
  }
  const command: string[] = [];
  for (const item of rawCommand) {
    if (typeof item !== "string") {
      return { ok: false, error: "command arguments must be strings" };
    }
    if (item.includes("\0")) {
      return { ok: false, error: "command arguments must not contain NUL bytes" };
    }
    command.push(item);
  }
  const computed = argvSha256(command);
  if (suppliedDigest !== undefined && suppliedDigest !== "") {
    if (
      typeof suppliedDigest !== "string" ||
      !HEX_SHA256_RE.test(suppliedDigest) ||
      suppliedDigest !== computed
    ) {
      return { ok: false, error: "argv_sha256 mismatch" };
    }
  }
  const displayCommand = rawGuard === "argv" ? redactArgvCommand(command) : command;
  return { ok: true, guard: rawGuard, displayCommand, digest: computed };
}

export function parseBundleSpec(
  raw: unknown,
  guard: string,
):
  | {
      readonly ok: true;
      readonly bundle: GuardBundleSpec | undefined;
      readonly bundleEligible: boolean;
      readonly wholeCommitGates: ReadonlyArray<string>;
    }
  | { readonly ok: false; readonly error: string } {
  if (raw === undefined || raw === null) {
    return { ok: true, bundle: undefined, bundleEligible: false, wholeCommitGates: [] };
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "invalid bundle object" };
  }
  const obj = raw as Record<string, unknown>;
  const repo = normalizeRepoSlug(sanitizeText(obj.repo, 200));
  const branch = sanitizeText(obj.branch, 200);
  const prOrIssue = sanitizeText(obj.pr_or_issue ?? obj.prOrIssue, 64);
  const commitSha = sanitizeText(obj.commit_sha ?? obj.commitSha, 64).toLowerCase();
  const protectedDiffSha256 = sanitizeText(
    obj.protected_diff_sha256 ?? obj.protectedDiffSha256,
    64,
  ).toLowerCase();
  const bodySha256 = sanitizeText(obj.body_sha256 ?? obj.bodySha256, 64).toLowerCase();

  if (!repo || !branch) {
    return { ok: false, error: "bundle requires repo and branch" };
  }
  if (protectedDiffSha256 && !HEX_SHA256_RE.test(protectedDiffSha256)) {
    return { ok: false, error: "invalid protected_diff_sha256" };
  }
  if (bodySha256 && !HEX_SHA256_RE.test(bodySha256)) {
    return { ok: false, error: "invalid body_sha256" };
  }

  const rawGates = Array.isArray(obj.gates) ? obj.gates : [];
  if (rawGates.length === 0 || rawGates.length > MAX_BUNDLE_GATES) {
    return { ok: false, error: `bundle requires 1..${MAX_BUNDLE_GATES} gates` };
  }
  const gates: GuardBundleGate[] = [];
  for (const item of rawGates) {
    if (typeof item === "string") {
      const id = sanitizeText(item, 64);
      if (id) gates.push({ gateId: id, reason: "" });
      continue;
    }
    if (item && typeof item === "object" && !Array.isArray(item)) {
      const rec = item as Record<string, unknown>;
      const id = sanitizeText(rec.gate_id ?? rec.gateId ?? rec.id, 64);
      const reason = sanitizeText(rec.reason, 240);
      if (id) gates.push({ gateId: id, reason });
    }
  }
  if (gates.length === 0) {
    return { ok: false, error: "bundle has no valid gates" };
  }

  const rawPaths = Array.isArray(obj.protected_paths ?? obj.protectedPaths)
    ? ((obj.protected_paths ?? obj.protectedPaths) as ReadonlyArray<unknown>)
    : [];
  if (rawPaths.length > MAX_BUNDLE_PATHS) {
    return { ok: false, error: `bundle exceeds max ${MAX_BUNDLE_PATHS} protected paths` };
  }
  const protectedPaths = normalizeSortedUnique(
    rawPaths.map((p) => sanitizeText(p, 260)).filter(Boolean),
  );

  const wholeCommitGates = normalizeSortedUnique(
    gates.map((g) => normalizeGateId(g.gateId)).filter((id) => isWholeCommitGate(id)),
  );
  // If protected files are listed, the bundle MUST anchor on protected_diff_sha256 (body digest alone is insufficient).
  const hasDigestAnchor =
    protectedPaths.length > 0
      ? protectedDiffSha256.length === 64
      : protectedDiffSha256.length === 64 || bodySha256.length === 64;
  const normalizedGuard = guard.trim().toLowerCase();
  const bundleEligible =
    !ALWAYS_ONCE_GUARDS.has(normalizedGuard) && wholeCommitGates.length === 0 && hasDigestAnchor;

  const diffPreview = sanitizeMultilinePreview(obj.diff_preview ?? obj.diffPreview, 2400);
  const gateSummary = gates.map((g) => g.gateId).join(", ");
  const pathSummary =
    protectedPaths.length > 0
      ? ` (${protectedPaths.slice(0, 3).join(", ")}${protectedPaths.length > 3 ? ` +${protectedPaths.length - 3}` : ""})`
      : "";
  const summary =
    sanitizeText(obj.summary, 180) || sanitizeText(`${gateSummary}${pathSummary}`, 180);

  return {
    ok: true,
    bundle: {
      repo,
      branch,
      prOrIssue,
      gates,
      protectedPaths,
      protectedDiffSha256,
      bodySha256,
      commitSha,
      ...(diffPreview ? { diffPreview } : {}),
      summary,
    },
    bundleEligible,
    wholeCommitGates,
  };
}
