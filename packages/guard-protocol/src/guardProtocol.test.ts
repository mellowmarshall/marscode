// @effect-diagnostics nodeBuiltinImport:off - Pure Node guard-protocol package test.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import {
  argvSha256,
  canonicalProtectedDiffSha256,
  computeBundleKey,
  depsDecideTargetDigest,
  flyDeployTargetDigest,
  gitPushTargetDigest,
  installTreeTargetDigest,
  normalizeRepoSlug,
} from "./digests.ts";
import { parseBundleSpec, validateGuardAndCommand } from "./protocol.ts";
import { redactArgvCommand } from "./redaction.ts";
import {
  ensureGuardSigningKeyPair,
  generateGuardSigningKeyPair,
  signBundleGrant,
  verifyBundleGrant,
  type SignedBundleGrantPayload,
} from "./signing.ts";

describe("@t3tools/guard-protocol", () => {
  it("computes deterministic bundle keys insensitive to gate/path order and sensitive to protected diff changes", () => {
    const diffA = canonicalProtectedDiffSha256(
      "diff --git a/host-guards/exceptions.json\n+marscode",
    );
    const diffB = canonicalProtectedDiffSha256(
      "diff --git a/host-guards/exceptions.json\n+marscode\n+extra",
    );

    const key1 = computeBundleKey({
      repo: "private-repo",
      branch: "issue-1352",
      prOrIssue: "#1352",
      guard: "ship-queue",
      gateIds: ["allowlist", "playbook-waiver"],
      protectedPaths: ["host-guards/exceptions.json", ".gitleaks.toml"],
      protectedDiffSha256: diffA,
      bodySha256: "",
    });
    const key2 = computeBundleKey({
      repo: "private-repo",
      branch: "issue-1352",
      prOrIssue: "#1352",
      guard: "ship-queue",
      gateIds: ["playbook-waiver", "allowlist", "allowlist"],
      protectedPaths: [".gitleaks.toml", "host-guards/exceptions.json"],
      protectedDiffSha256: diffA,
      bodySha256: "",
    });
    const keyChanged = computeBundleKey({
      repo: "private-repo",
      branch: "issue-1352",
      prOrIssue: "#1352",
      guard: "ship-queue",
      gateIds: ["allowlist", "playbook-waiver"],
      protectedPaths: ["host-guards/exceptions.json", ".gitleaks.toml"],
      protectedDiffSha256: diffB,
      bodySha256: "",
    });

    expect(key1).toBe(key2);
    expect(keyChanged).not.toBe(key1);
  });

  it("forces whole-commit gates (no-review, unproven, ci-run-judge) to be non-bundle-eligible", () => {
    const diffSha = canonicalProtectedDiffSha256("+marscode");
    const ok = parseBundleSpec(
      {
        repo: "private-repo",
        branch: "issue-1352",
        gates: [{ gateId: "allowlist", reason: "exceptions.json modified" }],
        protectedPaths: ["host-guards/exceptions.json"],
        protectedDiffSha256: diffSha,
      },
      "ship-queue",
    );
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.bundleEligible).toBe(true);
      expect(ok.wholeCommitGates).toEqual([]);
    }

    const wholeCommit = parseBundleSpec(
      {
        repo: "private-repo",
        branch: "issue-1352",
        gates: [
          { gateId: "allowlist", reason: "exceptions.json modified" },
          { gateId: "no-review", reason: "missing adversarial review" },
        ],
        protectedPaths: ["host-guards/exceptions.json"],
        protectedDiffSha256: diffSha,
      },
      "ship-queue",
    );
    expect(wholeCommit.ok).toBe(true);
    if (wholeCommit.ok) {
      expect(wholeCommit.bundleEligible).toBe(false);
      expect(wholeCommit.wholeCommitGates).toEqual(["no-review"]);
    }
  });

  it("signs and offline-verifies bundle grants with Ed25519 and rejects tampering", () => {
    const tmpDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "guard-proto-sign-"));
    try {
      const pair = ensureGuardSigningKeyPair(tmpDir);
      const reloaded = ensureGuardSigningKeyPair(tmpDir);
      expect(reloaded.publicKeyPem).toBe(pair.publicKeyPem);

      const payload: SignedBundleGrantPayload = {
        v: 1,
        grantId: "t3g_0123456789abcdef",
        bundleKey: "a".repeat(64),
        repo: "private-repo",
        branch: "issue-1352",
        prOrIssue: "#1352",
        guard: "ship-queue",
        gateIds: ["allowlist"],
        protectedPaths: ["host-guards/exceptions.json"],
        protectedDiffSha256: "b".repeat(64),
        bodySha256: "",
        approvedAt: "2026-11-27T00:00:00.000Z",
        approvedVia: "t3-input-request",
      };

      const sig = signBundleGrant(payload, pair.privateKeyPem);
      expect(verifyBundleGrant(payload, sig, pair.publicKeyPem)).toBe(true);
      expect(
        verifyBundleGrant(
          { ...payload, protectedDiffSha256: "c".repeat(64) },
          sig,
          pair.publicKeyPem,
        ),
      ).toBe(false);

      const otherKey = generateGuardSigningKeyPair();
      expect(verifyBundleGrant(payload, sig, otherKey.publicKeyPem)).toBe(false);
    } finally {
      NodeFS.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("redacts HTTP bearer tokens, URL credentials, and fly ssh commands while verifying exact argv hash", () => {
    const cmd = [
      "curl",
      "-H",
      "Authorization: Bearer secret-token-123",
      "https://u:p@example.com?token=abc",
    ];
    const digest = argvSha256(cmd);
    const validated = validateGuardAndCommand("argv", cmd, digest);
    expect(validated.ok).toBe(true);
    if (validated.ok) {
      expect(validated.displayCommand).toEqual([
        "curl",
        "-H",
        "<redacted>",
        "https://<redacted>@example.com?token=<redacted>",
      ]);
    }
    expect(redactArgvCommand(["fly", "ssh", "console", "-C", "printenv SECRET"])).toEqual([
      "fly",
      "ssh",
      "console",
      "-C",
      "<redacted-remote-command>",
    ]);
  });

  it("produces distinct target-bound digests for non-diff guards", () => {
    expect(
      gitPushTargetDigest({
        remoteUrl: "git@github.com:mellowmarshall/marscode.git",
        refspec: "HEAD:refs/heads/main",
        localSha: "a".repeat(40),
        force: false,
      }),
    ).not.toBe(
      gitPushTargetDigest({
        remoteUrl: "git@github.com:mellowmarshall/marscode.git",
        refspec: "HEAD:refs/heads/main",
        localSha: "a".repeat(40),
        force: true,
      }),
    );
    expect(
      depsDecideTargetDigest({ reportContentSha256: "1".repeat(64), decision: "approve" }),
    ).not.toBe(depsDecideTargetDigest({ reportContentSha256: "1".repeat(64), decision: "reject" }));
    expect(installTreeTargetDigest("2".repeat(64))).toHaveLength(64);
    expect(
      flyDeployTargetDigest({
        app: "demo",
        org: "personal",
        artifactSha: "3".repeat(40),
        flyTomlSha256: "4".repeat(64),
      }),
    ).toHaveLength(64);
  });

  it("enforces ALWAYS_ONCE_GUARDS, protected_diff requirement, normalized whole-commit gates, repo slug normalization, and strict 0600 keypair verification", () => {
    const bodySha = "a".repeat(64);
    const diffSha = "b".repeat(64);
    // All non-diff / always-once guards are ineligible for bundle grants even with a valid digest anchor.
    for (const guard of [
      "git-push",
      "git_push",
      "deps-decide",
      "deps_decide",
      "home-dev-install",
      "home_dev_install",
      "fly-deploy",
      "fly_deploy",
      "argv",
      "release-guard",
    ]) {
      const parsed = parseBundleSpec(
        {
          repo: "https://github.com/MellowMarshall/MarsCode.git",
          branch: "feat/test",
          gates: [{ gate_id: "allowlist", reason: "test" }],
          body_sha256: bodySha,
          protected_diff_sha256: diffSha,
          protected_paths: ["host-guards/exceptions.json"],
        },
        guard,
      );
      expect(parsed.ok).toBe(true);
      if (parsed.ok) {
        expect(parsed.bundleEligible).toBe(false);
        expect(parsed.bundle?.repo).toBe("mellowmarshall/marscode");
      }
    }

    // Non-empty protected_paths cannot be anchored by body_sha256 alone.
    const bodyOnly = parseBundleSpec(
      {
        repo: "git@github.com:MellowMarshall/MarsCode.git",
        branch: "feat/test",
        gates: [{ gate_id: "allowlist", reason: "test" }],
        protected_paths: ["host-guards/exceptions.json"],
        body_sha256: bodySha,
      },
      "ship-queue",
    );
    expect(bodyOnly.ok).toBe(true);
    if (bodyOnly.ok) {
      expect(bodyOnly.bundleEligible).toBe(false);
    }

    // Normalized whole-commit gates (spaces, underscores, suffixes) are always whole-commit.
    for (const gateId of ["no review", "No_Review ", "ci-run-judge-v2", "UNPROVEN_CHECK"]) {
      const parsed = parseBundleSpec(
        {
          repo: "mellowmarshall/marscode",
          branch: "feat/test",
          gates: [{ gate_id: gateId, reason: "test" }],
          protected_diff_sha256: diffSha,
        },
        "ship-queue",
      );
      expect(parsed.ok).toBe(true);
      if (parsed.ok) {
        expect(parsed.bundleEligible).toBe(false);
        expect(parsed.wholeCommitGates.length).toBeGreaterThan(0);
      }
    }

    expect(normalizeRepoSlug("https://github.com/Owner/Repo.git")).toBe("owner/repo");
    expect(normalizeRepoSlug("git@github.com:Owner/Repo.git")).toBe("owner/repo");
    expect(normalizeRepoSlug("Owner/Repo")).toBe("owner/repo");

    // Keypair hardening: reject non-0600 permissions and partial keypair; verify expiry check.
    const tmpDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "guard-key-harden-"));
    try {
      const pair = ensureGuardSigningKeyPair(tmpDir);
      const privPath = NodePath.join(tmpDir, "guard-grant-ed25519.key");
      const pubPath = NodePath.join(tmpDir, "guard-grant-ed25519.pub");

      // Expired signature rejected.
      const expiredPayload = {
        v: 1 as const,
        grantId: "t3g_exp",
        bundleKey: "a".repeat(64),
        threadId: "t1",
        repo: "owner/repo",
        branch: "b",
        prOrIssue: "#1",
        guard: "ship-queue",
        gateIds: ["allowlist"],
        protectedPaths: ["a.json"],
        protectedDiffSha256: diffSha,
        bodySha256: "",
        approvedAt: "2026-11-01T00:00:00.000Z",
        expiresAt: "2026-11-02T00:00:00.000Z",
        approvedVia: "test",
      };
      const sig = signBundleGrant(expiredPayload, pair.privateKeyPem);
      expect(
        verifyBundleGrant(
          expiredPayload,
          sig,
          pair.publicKeyPem,
          Date.parse("2026-11-01T12:00:00.000Z"),
        ),
      ).toBe(true);
      expect(
        verifyBundleGrant(
          expiredPayload,
          sig,
          pair.publicKeyPem,
          Date.parse("2026-11-03T00:00:00.000Z"),
        ),
      ).toBe(false);

      // Overly broad mode (0644) must throw instead of silently accepting or rotating.
      NodeFS.chmodSync(privPath, 0o644);
      expect(() => ensureGuardSigningKeyPair(tmpDir)).toThrow(/0600/);
      NodeFS.chmodSync(privPath, 0o600);

      // Missing public key with valid 0600 private key deterministically re-derives the exact public key (no rotation).
      NodeFS.unlinkSync(pubPath);
      const recovered = ensureGuardSigningKeyPair(tmpDir);
      expect(recovered.publicKeyPem.trim()).toBe(pair.publicKeyPem.trim());
      expect(NodeFS.existsSync(pubPath)).toBe(true);

      // Missing private key with orphaned public key must throw instead of silently rotating.
      NodeFS.unlinkSync(privPath);
      expect(() => ensureGuardSigningKeyPair(tmpDir)).toThrow(/incomplete/);
    } finally {
      NodeFS.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
