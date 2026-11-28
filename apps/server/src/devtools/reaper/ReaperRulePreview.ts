// @effect-diagnostics nodeBuiltinImport:off - Dry-run of the approved-policy sweep for one rule, measured before the user accepts it.
import type { ReaperRulePreview } from "@t3tools/contracts";

import type { ReaperPolicyRule } from "../ReaperPolicyToml.ts";
import { gitCheckoutAt, type GitTracksFiles } from "../ReaperRulePathChecks.ts";
import { sweepApprovedPolicy } from "./ReaperEphemeralSweep.ts";
import { PathGuard } from "./ReaperPathGuard.ts";
import { trustedScan, type ProcPathScan } from "./ReaperProcPaths.ts";

const DAY_MS = 86_400_000;

/** What the sweep would remove for `rule` right now, with the same guards a real pass uses. */
export async function previewRule(
  rule: Omit<ReaperPolicyRule, "enabled">,
  input: {
    readonly scan: ProcPathScan | null;
    readonly historyRoots: ReadonlyArray<string>;
    readonly uid: number;
    readonly nowMs: number;
    readonly homeDir: string;
    readonly tracksFiles: GitTracksFiles;
  },
): Promise<ReaperRulePreview> {
  const totals = await sweepApprovedPolicy(
    [{ ...rule, enabled: true }],
    {
      uid: input.uid,
      nowMs: input.nowMs,
      guard: new PathGuard([...(input.scan?.paths ?? []), ...input.historyRoots]),
      dryRun: true,
      log: () => undefined,
      homeDir: input.homeDir,
      historyRoots: input.historyRoots,
    },
    input.tracksFiles,
  );
  const ageDays = (mtimeMs: number | undefined) =>
    mtimeMs === undefined ? null : Math.round(((input.nowMs - mtimeMs) / DAY_MS) * 10) / 10;
  return {
    entries: totals.removed,
    bytes: totals.bytes,
    oldestAgeDays: ageDays(totals.oldestMtimeMs),
    newestAgeDays: ageDays(totals.newestMtimeMs),
    gitAncestor: gitCheckoutAt(rule.path) !== null,
    liveProcessCheck: trustedScan(input.scan),
  };
}
