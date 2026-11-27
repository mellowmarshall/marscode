// @effect-diagnostics nodeBuiltinImport:off - Canonical cryptographic digests for guard argv, bundled protected diffs, and non-diff targets.
import * as NodeCrypto from "node:crypto";

export const HEX_SHA256_RE = /^[0-9a-f]{64}$/;

export function sha256Hex(input: string | Buffer): string {
  return NodeCrypto.createHash("sha256").update(input).digest("hex");
}

export function argvSha256(command: ReadonlyArray<string>): string {
  return sha256Hex(Buffer.from(command.join("\0"), "utf8"));
}

/**
 * Canonical digest of a protected-file unified diff (`git diff --no-ext-diff --binary -- <sorted paths>`).
 */
export function canonicalProtectedDiffSha256(diffText: string): string {
  return sha256Hex(Buffer.from(diffText, "utf8"));
}

export interface BundleDigestInput {
  readonly repo: string;
  readonly branch: string;
  readonly prOrIssue: string;
  readonly guard: string;
  readonly gateIds: ReadonlyArray<string>;
  readonly protectedPaths: ReadonlyArray<string>;
  readonly protectedDiffSha256: string;
  readonly bodySha256: string;
}

/**
 * Normalizes repository identifiers (HTTPS/SSH URLs, trailing `.git`, uppercase) to canonical `owner/repo`.
 */
export function normalizeRepoSlug(raw: string): string {
  let s = raw.trim();
  if (!s) return "";
  // git@host:owner/repo(.git)
  const sshMatch = /^[^@\s]+@[^:\s]+:(.+)$/.exec(s);
  if (sshMatch?.[1]) {
    s = sshMatch[1];
  } else {
    // https://host/owner/repo(.git) or ssh://git@host/owner/repo(.git)
    const urlMatch = /^[a-z][a-z0-9+.-]*:\/\/[^/\s]+\/(.+)$/i.exec(s);
    if (urlMatch?.[1]) {
      s = urlMatch[1];
    }
  }
  s = s.replace(/^\/+|\/+$/g, "");
  if (s.toLowerCase().endsWith(".git")) {
    s = s.slice(0, -4);
  }
  return s.toLowerCase();
}

/**
 * Normalizes and sorts string sets deterministically so equivalent gate/path lists produce identical digests.
 */
export function normalizeSortedUnique(items: ReadonlyArray<string>): ReadonlyArray<string> {
  return Array.from(new Set(items.map((item) => item.trim()).filter(Boolean))).toSorted((a, b) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
}

/**
 * Deterministic key and canonical signing payload for a bundled protected-diff approval.
 * Any change to a protected file diff, gate set, body digest, repo, or branch yields a distinct digest.
 */
export function computeBundleKey(input: BundleDigestInput): string {
  const canonical = JSON.stringify({
    v: 1,
    repo: normalizeRepoSlug(input.repo),
    branch: input.branch.trim(),
    prOrIssue: input.prOrIssue.trim(),
    guard: input.guard.trim().toLowerCase(),
    gateIds: normalizeSortedUnique(input.gateIds),
    protectedPaths: normalizeSortedUnique(input.protectedPaths),
    protectedDiffSha256: input.protectedDiffSha256.trim().toLowerCase(),
    bodySha256: input.bodySha256.trim().toLowerCase(),
  });
  return sha256Hex(Buffer.from(canonical, "utf8"));
}

export function gitPushTargetDigest(input: {
  readonly remoteUrl: string;
  readonly refspec: string;
  readonly localSha: string;
  readonly force: boolean;
}): string {
  return sha256Hex(
    JSON.stringify({
      kind: "git-push",
      remoteUrl: input.remoteUrl.trim(),
      refspec: input.refspec.trim(),
      localSha: input.localSha.trim().toLowerCase(),
      force: input.force,
    }),
  );
}

export function depsDecideTargetDigest(input: {
  readonly reportContentSha256: string;
  readonly decision: "approve" | "reject" | "rollback";
}): string {
  return sha256Hex(
    JSON.stringify({
      kind: "deps-decide",
      reportContentSha256: input.reportContentSha256.trim().toLowerCase(),
      decision: input.decision,
    }),
  );
}

export function installTreeTargetDigest(treeSha256: string): string {
  return sha256Hex(
    JSON.stringify({
      kind: "install-tree",
      treeSha256: treeSha256.trim().toLowerCase(),
    }),
  );
}

export function flyDeployTargetDigest(input: {
  readonly app: string;
  readonly org: string;
  readonly artifactSha: string;
  readonly flyTomlSha256: string;
}): string {
  return sha256Hex(
    JSON.stringify({
      kind: "fly-deploy",
      app: input.app.trim(),
      org: input.org.trim(),
      artifactSha: input.artifactSha.trim().toLowerCase(),
      flyTomlSha256: input.flyTomlSha256.trim().toLowerCase(),
    }),
  );
}
