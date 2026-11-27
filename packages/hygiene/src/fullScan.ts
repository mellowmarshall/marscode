// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Times one full scan with node:perf_hooks.
/** One §16.4 pass over every surface a caller can reach: tree, range, metadata, GitHub text. */
import * as NodePerfHooks from "node:perf_hooks";

import { scanRange } from "./commitScan.ts";
import type { HygieneRun } from "./evidenceReceipt.ts";
import type { HygieneSurface } from "./hygieneCatalog.ts";
import type { DenyRule, Finding, HygienePolicy } from "./hygieneTypes.ts";
import { scanText } from "./textScan.ts";
import { scanTree } from "./treeScan.ts";

export interface GithubText {
  readonly source: string;
  readonly text: string;
}

export function fullScan(input: {
  readonly root: string;
  readonly baseSha: string;
  readonly denylist: ReadonlyArray<DenyRule> | null;
  readonly policy: HygienePolicy;
  readonly githubTexts: ReadonlyArray<GithubText>;
}): HygieneRun {
  const started = NodePerfHooks.performance.now();
  const options = { denylist: input.denylist, policy: input.policy };
  const findings: Finding[] = [
    ...scanTree(input.root, options),
    ...scanRange(input.root, input.baseSha, options),
  ];
  const surfaces: HygieneSurface[] = ["tree", "history", "commit-metadata"];
  for (const item of input.githubTexts) {
    findings.push(
      ...scanText(item.text, { ...options, source: item.source, surface: "github-text" }),
    );
  }
  if (input.githubTexts.length > 0) surfaces.push("github-text");
  return {
    findings,
    surfaces,
    durationMs: Math.round(NodePerfHooks.performance.now() - started),
    denylistApplied: input.denylist !== null,
  };
}
