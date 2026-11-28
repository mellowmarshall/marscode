// @effect-diagnostics nodeBuiltinImport:off globalDate:off - In-memory batch (plan) grants: each approved command usable once, per thread and cwd.
import { argvSha256 } from "@t3tools/guard-protocol/digests";

import type { StoredOnceGrant } from "./GuardBrokerTypes.ts";
import { canonicalCwd } from "./GuardSocketPath.ts";

export const PLAN_KEY_PREFIX = "plan\0";

function planKey(digest: string, cwd: string, threadId: string): string {
  return `${PLAN_KEY_PREFIX}${digest}\0${canonicalCwd(cwd)}\0${threadId}`;
}

/**
 * A plan entry matches by exact argv digest whatever guard refused the command, since one owner
 * approval covered the whole list. It never matches without a thread or in another cwd.
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
    readonly commands: ReadonlyArray<ReadonlyArray<string>>;
    readonly cwd: string;
    readonly threadId: string;
    readonly reason: string;
    readonly approvedVia?: string | undefined;
    readonly expiresAtMs: number;
  }): void {
    if (!input.threadId) return;
    for (const command of input.commands) {
      const digest = argvSha256(command);
      this.entries.set(planKey(digest, input.cwd, input.threadId), {
        grantId: input.grantId,
        guard: "plan",
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
    digest: string,
    cwd: string,
    threadId: string,
  ): { readonly key: string; readonly grant: StoredOnceGrant } | null {
    if (!threadId) return null;
    this.pruneExpired();
    const key = planKey(digest, cwd, threadId);
    const grant = this.entries.get(key);
    return grant ? { key, grant } : null;
  }

  delete(key: string): boolean {
    return this.entries.delete(key);
  }
}
