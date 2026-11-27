// @effect-diagnostics nodeBuiltinImport:off - Shared broker interfaces and key builders.
import type * as NodeNet from "node:net";

import { computeBundleKey } from "@t3tools/guard-protocol/digests";
import type {
  ActiveSecretGrant,
  GuardBundleSpec,
  PendingGuardRequest,
} from "@t3tools/guard-protocol/protocol";

import type {
  CreateGuardBundleGrantInput,
  GuardGrantEventRecord,
  StoredGuardBundleGrant,
} from "../persistence/GuardGrants.ts";
import type { PeerThreadResolution } from "./GuardPeerIdentity.ts";
import { canonicalCwd } from "./GuardSocketPath.ts";
import type { TrustedCodexAppServer } from "./TrustedProviderRegistry.ts";

export interface GuardBundlePersistence {
  readonly createBundleGrant: (input: CreateGuardBundleGrantInput) => Promise<void>;
  readonly findActiveByBundleKey: (
    bundleKey: string,
    threadId: string,
  ) => Promise<StoredGuardBundleGrant | null>;
  readonly recordBundleUse: (grantId: string, usedAt: string) => Promise<void>;
  readonly listActiveBundleGrants: () => Promise<ReadonlyArray<StoredGuardBundleGrant>>;
  readonly revokeBundleGrant: (
    grantId: string,
    revokedAt: string,
    revokedVia: string,
  ) => Promise<boolean>;
  readonly revokeByRepoBranch: (
    repo: string,
    branch: string,
    revokedAt: string,
    revokedVia: string,
  ) => Promise<number>;
  readonly revokeByRepoPr?: (
    repo: string,
    prNumber: number,
    revokedAt: string,
    revokedVia: string,
  ) => Promise<number>;
  readonly appendEvent: (event: GuardGrantEventRecord) => Promise<void>;
  readonly listRecentEvents: (limit: number) => Promise<ReadonlyArray<GuardGrantEventRecord>>;
}

export interface SecretGrantProvider {
  readonly listActiveGrants: () => Promise<ReadonlyArray<ActiveSecretGrant>>;
  readonly revokeGrant: (grantId: string) => Promise<boolean>;
  readonly subscribeGrants?: ((listener: () => void) => () => void) | undefined;
}

export interface GuardGrantBrokerOptions {
  readonly socketPath?: string | undefined;
  readonly defaultGrantTtlMs?: number | undefined;
  readonly defaultRequestTimeoutMs?: number | undefined;
  readonly maxPending?: number | undefined;
  readonly maxPreapproved?: number | undefined;
  readonly auditLogPath?: string | undefined;
  readonly exceptionsPaths?: ReadonlyArray<string> | undefined;
  readonly signingStateDir?: string | undefined;
  readonly bundlePersistence?: GuardBundlePersistence | undefined;
  readonly secretGrants?: SecretGrantProvider | undefined;
  readonly getTrustedCodexAppServers?: (() => ReadonlyArray<TrustedCodexAppServer>) | undefined;
  readonly resolvePeerThreadId?:
    | ((socket: NodeNet.Socket) => Promise<PeerThreadResolution>)
    | undefined;
}

export interface StoredOnceGrant {
  readonly grantId: string;
  readonly guard: string;
  readonly argvSha256: string;
  readonly cwd: string;
  readonly reason: string;
  readonly approvedBy: string;
  readonly approvedVia?: string | undefined;
  readonly threadId: string;
  readonly expiresAtMs: number;
}

export interface PendingEntry {
  readonly request: PendingGuardRequest;
  readonly coalesceKey: string;
  readonly sockets: Set<NodeNet.Socket>;
  readonly timer: ReturnType<typeof setTimeout>;
  settled: boolean;
}

export function onceGrantKey(guard: string, digest: string, cwd: string, threadId = ""): string {
  return `${guard}\0${digest}\0${canonicalCwd(cwd)}\0${threadId}`;
}

export function bundleKeyOf(guard: string, bundle: GuardBundleSpec): string {
  return computeBundleKey({
    repo: bundle.repo,
    branch: bundle.branch,
    prOrIssue: bundle.prOrIssue,
    guard,
    gateIds: bundle.gates.map((g) => g.gateId),
    protectedPaths: bundle.protectedPaths,
    protectedDiffSha256: bundle.protectedDiffSha256,
    bodySha256: bundle.bodySha256,
  });
}
