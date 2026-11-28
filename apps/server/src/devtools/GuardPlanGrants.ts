// @effect-diagnostics nodeBuiltinImport:off globalDate:off - In-memory batch (plan) grants: each approved command usable once, per thread and cwd.
import { planEntryDigest } from "@t3tools/guard-protocol/plan";
import type { GuardPlanEntry } from "@t3tools/guard-protocol/protocol";

import type { StoredOnceGrant } from "./GuardBrokerTypes.ts";
import { canonicalCwd } from "./GuardSocketPath.ts";

export const PLAN_KEY_PREFIX = "plan\0";

function planKey(guard: string, digest: string, cwd: string, threadId: string): string {
  return `${PLAN_KEY_PREFIX}${guard}\0${digest}\0${canonicalCwd(cwd)}\0${threadId}`;
}

/**
 * A plan entry matches one guard and its grant key (shown and exact argv digests), in the thread and cwd that asked.
 * Bundle-gated guards never get plan entries (the plan parser refuses them).
 */
export class GuardPlanGrants {
  private readonly entries = new Map<string, StoredOnceGrant>();

  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }

  pruneExpired(nowMs = Date.now()): void {
    for (const [key, grant] of this.entries) {
      if (grant.expiresAtMs <= nowMs) this.entries.delete(key);
    }
  }

  put(input: {
    readonly grantId: string;
    readonly entries: ReadonlyArray<GuardPlanEntry>;
    readonly cwd: string;
    readonly threadId: string;
    readonly reason: string;
    readonly approvedVia?: string | undefined;
    readonly expiresAtMs: number;
  }): void {
    if (!input.threadId) return;
    for (const entry of input.entries) {
      const digest = planEntryDigest(entry);
      if (digest === null) continue;
      this.entries.set(planKey(entry.guard, digest, input.cwd, input.threadId), {
        grantId: input.grantId,
        guard: entry.guard,
        argvSha256: digest,
        cwd: canonicalCwd(input.cwd),
        reason: input.reason,
        approvedBy: "human",
        approvedVia: input.approvedVia,
        threadId: input.threadId,
        expiresAtMs: input.expiresAtMs,
      });
    }
  }

  lookup(
    guard: string,
    digest: string,
    cwd: string,
    threadId: string,
  ): { readonly key: string; readonly grant: StoredOnceGrant } | null {
    if (!threadId) return null;
    this.pruneExpired();
    const key = planKey(guard, digest, cwd, threadId);
    const grant = this.entries.get(key);
    return grant ? { key, grant } : null;
  }

  delete(key: string): boolean {
    return this.entries.delete(key);
  }
}
