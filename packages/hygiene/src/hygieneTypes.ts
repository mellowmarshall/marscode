import type { HygieneClass } from "./hygieneCatalog.ts";

/** One hit. Never carries the matched text: only where it is and which rule fired. */
export interface Finding {
  readonly classId: HygieneClass;
  readonly source: string;
  readonly line: number;
  /** `public:<ruleId>` or `private:<classId>`. */
  readonly rule: string;
}

/** One host-local denylist pattern; `line` is its line in the denylist file. */
export interface DenyRule {
  readonly classId: HygieneClass;
  readonly pattern: RegExp;
  readonly line: number;
}

export type DenylistLoad =
  | { readonly kind: "loaded"; readonly rules: ReadonlyArray<DenyRule> }
  | { readonly kind: "missing"; readonly path: string }
  | { readonly kind: "invalid"; readonly path: string; readonly line: number };

export interface ScopedException {
  readonly classId: HygieneClass;
  readonly file: string;
  readonly reason: string;
  readonly issue: string;
}

export interface PathExclusion {
  readonly path: string;
  readonly reason: string;
  readonly issue: string;
}

export interface UpstreamName {
  readonly name: string;
  readonly reason: string;
  readonly issue: string;
}

/** The repo's tracked `hygiene.exceptions.json`, validated. */
export interface HygienePolicy {
  readonly exclusions: ReadonlyArray<PathExclusion>;
  readonly upstreamNames: ReadonlyArray<UpstreamName>;
  readonly exceptions: ReadonlyArray<ScopedException>;
}

export const EMPTY_POLICY: HygienePolicy = { exclusions: [], upstreamNames: [], exceptions: [] };

export interface ScanOptions {
  /** Loaded denylist rules, or `null` to run the public rules only. */
  readonly denylist: ReadonlyArray<DenyRule> | null;
  readonly policy?: HygienePolicy | undefined;
}
