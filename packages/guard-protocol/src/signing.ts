// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Offline-verifiable Ed25519 signing for bundled guard grants.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

/** Upper safety ceiling for bundled protected-diff grants (also revoked immediately on PR merge or diff edit). */
export const BUNDLE_GRANT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface GuardSigningKeyPair {
  readonly privateKeyPem: string;
  readonly publicKeyPem: string;
}

export interface SignedBundleGrantPayload {
  readonly v: 1;
  readonly grantId: string;
  readonly bundleKey: string;
  readonly threadId?: string | undefined;
  readonly repo: string;
  readonly branch: string;
  readonly prOrIssue: string;
  readonly guard: string;
  readonly gateIds: ReadonlyArray<string>;
  readonly protectedPaths: ReadonlyArray<string>;
  readonly protectedDiffSha256: string;
  readonly bodySha256: string;
  readonly approvedAt: string;
  readonly expiresAt?: string | null | undefined;
  readonly approvedVia: string;
}

function canonicalPayloadBytes(payload: SignedBundleGrantPayload): Buffer {
  return Buffer.from(
    JSON.stringify({
      v: payload.v,
      grantId: payload.grantId,
      bundleKey: payload.bundleKey,
      ...(payload.threadId !== undefined ? { threadId: payload.threadId } : {}),
      repo: payload.repo,
      branch: payload.branch,
      prOrIssue: payload.prOrIssue,
      guard: payload.guard,
      gateIds: payload.gateIds,
      protectedPaths: payload.protectedPaths,
      protectedDiffSha256: payload.protectedDiffSha256,
      bodySha256: payload.bodySha256,
      approvedAt: payload.approvedAt,
      ...(payload.expiresAt !== undefined ? { expiresAt: payload.expiresAt } : {}),
      approvedVia: payload.approvedVia,
    }),
    "utf8",
  );
}

export function generateGuardSigningKeyPair(): GuardSigningKeyPair {
  const { privateKey, publicKey } = NodeCrypto.generateKeyPairSync("ed25519");
  return {
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

function statOrNull(filePath: string): NodeFS.Stats | null {
  try {
    return NodeFS.lstatSync(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Loads or initializes an owner-only (0600) Ed25519 keypair in `stateDir` so headless CI can verify
 * signed bundle grants offline using the matching public key.
 * Refuses symlinks, non-0600 private files, incomplete or mismatched pairs, or foreign ownership.
 */
export function ensureGuardSigningKeyPair(stateDir: string): GuardSigningKeyPair {
  const privPath = NodePath.join(stateDir, "guard-grant-ed25519.key");
  const pubPath = NodePath.join(stateDir, "guard-grant-ed25519.pub");

  const privStat = statOrNull(privPath);
  const pubStat = statOrNull(pubPath);

  if (privStat !== null || pubStat !== null) {
    if (privStat === null) {
      throw new Error(
        `Guard signing keypair in ${stateDir} is incomplete: public key exists without private key (refusing silent key rotation)`,
      );
    }
    if (!privStat.isFile()) {
      throw new Error(`Guard signing private key ${privPath} must be a regular file`);
    }
    if (typeof process.getuid === "function") {
      const uid = process.getuid();
      if (privStat.uid !== uid) {
        throw new Error(`Guard signing private key ${privPath} is not owned by uid ${uid}`);
      }
      if ((privStat.mode & 0o077) !== 0) {
        throw new Error(
          `Guard signing private key ${privPath} has overly broad permissions (must be 0600)`,
        );
      }
    }
    const privateKeyPem = NodeFS.readFileSync(privPath, "utf8");
    if (!privateKeyPem.includes("PRIVATE KEY")) {
      throw new Error(`Guard signing private key in ${stateDir} is malformed`);
    }
    const derivedPub = NodeCrypto.createPublicKey(privateKeyPem)
      .export({ type: "spki", format: "pem" })
      .toString();

    if (pubStat === null) {
      // Recover missing public key deterministically from the intact 0600 private key (no rotation).
      const tmpPub = `${pubPath}.${process.pid}.${NodeCrypto.randomBytes(4).toString("hex")}.tmp`;
      try {
        NodeFS.writeFileSync(tmpPub, derivedPub, { mode: 0o644, flag: "wx" });
        NodeFS.renameSync(tmpPub, pubPath);
      } finally {
        try {
          NodeFS.unlinkSync(tmpPub);
        } catch {
          // already renamed
        }
      }
      return { privateKeyPem, publicKeyPem: derivedPub };
    }

    if (!pubStat.isFile()) {
      throw new Error(`Guard signing public key ${pubPath} must be a regular file`);
    }
    const publicKeyPem = NodeFS.readFileSync(pubPath, "utf8");
    if (!publicKeyPem.includes("PUBLIC KEY")) {
      throw new Error(`Guard signing public key in ${stateDir} is malformed`);
    }
    if (derivedPub.trim() !== publicKeyPem.trim()) {
      throw new Error(`Guard signing public key does not match private key in ${stateDir}`);
    }
    return { privateKeyPem, publicKeyPem };
  }

  NodeFS.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const pair = generateGuardSigningKeyPair();
  const tmpPub = `${pubPath}.${process.pid}.${NodeCrypto.randomBytes(4).toString("hex")}.tmp`;
  const tmpPriv = `${privPath}.${process.pid}.${NodeCrypto.randomBytes(4).toString("hex")}.tmp`;
  try {
    // Write and rename public key first, then private key.
    NodeFS.writeFileSync(tmpPub, pair.publicKeyPem, { mode: 0o644, flag: "wx" });
    NodeFS.writeFileSync(tmpPriv, pair.privateKeyPem, { mode: 0o600, flag: "wx" });
    NodeFS.renameSync(tmpPub, pubPath);
    NodeFS.renameSync(tmpPriv, privPath);
  } finally {
    for (const p of [tmpPub, tmpPriv]) {
      try {
        NodeFS.unlinkSync(p);
      } catch {
        // already renamed
      }
    }
  }
  return pair;
}

export function signBundleGrant(payload: SignedBundleGrantPayload, privateKeyPem: string): string {
  const sig = NodeCrypto.sign(null, canonicalPayloadBytes(payload), privateKeyPem);
  return sig.toString("base64");
}

export function verifyBundleGrant(
  payload: SignedBundleGrantPayload,
  signatureBase64: string,
  publicKeyPem: string,
  nowMs = Date.now(),
): boolean {
  try {
    if (payload.expiresAt) {
      const expMs = Date.parse(payload.expiresAt);
      if (!Number.isFinite(expMs) || expMs <= nowMs) return false;
    }
    const sig = Buffer.from(signatureBase64, "base64");
    if (sig.byteLength !== 64) return false;
    return NodeCrypto.verify(null, canonicalPayloadBytes(payload), publicKeyPem, sig);
  } catch {
    return false;
  }
}
