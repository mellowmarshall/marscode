// @effect-diagnostics nodeBuiltinImport:off - Hashes path labels with node:crypto.
/** Line-level text scanning: public rules for the surface, then the private denylist. */
import * as NodeCrypto from "node:crypto";

import type { HygieneSurface } from "./hygieneCatalog.ts";
import { isExcepted } from "./hygienePolicy.ts";
import { EMPTY_POLICY, type DenyRule, type Finding, type HygienePolicy } from "./hygieneTypes.ts";
import { rulesFor } from "./publicRules.ts";

export interface TextScanOptions {
  readonly source: string;
  readonly surface: HygieneSurface;
  readonly denylist: ReadonlyArray<DenyRule> | null;
  readonly policy?: HygienePolicy | undefined;
  /** Repo-relative file the text came from, for scoped exceptions; defaults to `source`. */
  readonly file?: string | undefined;
}

export interface NumberedLine {
  readonly line: number;
  readonly text: string;
}

/** `<classId> <source>:<line> (<rule>)`: the only shape a finding is ever printed in. */
export function formatFinding(finding: Finding): string {
  return `${finding.classId} ${finding.source}:${finding.line} (${finding.rule})`;
}

export function scanLines(
  lines: Iterable<NumberedLine>,
  options: TextScanOptions,
): ReadonlyArray<Finding> {
  const policy = options.policy ?? EMPTY_POLICY;
  const file = options.file ?? options.source;
  const rules = rulesFor(options.surface);
  const seen = new Set<string>();
  const out: Finding[] = [];
  const push = (finding: Finding) => {
    if (isExcepted(policy, finding.classId, file)) return;
    const key = `${finding.classId}\0${finding.line}\0${finding.rule}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(finding);
  };
  for (const { line, text } of lines) {
    if (!text) continue;
    for (const rule of rules) {
      if (rule.hints && !rule.hints.some((hint) => text.includes(hint))) continue;
      for (const match of text.matchAll(rule.pattern)) {
        if (!rule.flags(match, policy, text)) continue;
        push({ classId: rule.classId, source: options.source, line, rule: `public:${rule.id}` });
        break;
      }
    }
    for (const deny of options.denylist ?? []) {
      if (!deny.pattern.test(text)) continue;
      push({
        classId: deny.classId,
        source: options.source,
        line,
        rule: `private:${deny.classId}`,
      });
    }
  }
  return out;
}

function* numbered(text: string): Generator<NumberedLine> {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) yield { line: i + 1, text: lines[i] ?? "" };
}

export function scanText(text: string, options: TextScanOptions): ReadonlyArray<Finding> {
  return scanLines(numbered(text), options);
}

/**
 * A label for a path or ref name that may itself hold the private value: a private hit on it
 * must not print it, so the source becomes a short digest the owner can match locally.
 */
export function opaqueLabel(kind: string, value: string): string {
  return `${kind}@sha256:${NodeCrypto.createHash("sha256").update(value).digest("hex").slice(0, 12)}`;
}

/** Scans a path or ref name as text; a path with any private hit gets an opaque source on every finding. */
export function scanName(
  name: string,
  kind: string,
  options: Omit<TextScanOptions, "source">,
): ReadonlyArray<Finding> {
  const findings = scanLines([{ line: 0, text: name }], {
    ...options,
    source: opaqueLabel(kind, name),
  });
  // One private hit makes the whole path secret, so no finding on it may print it.
  if (kind !== "path" || findings.some((finding) => finding.rule.startsWith("private:"))) {
    return findings;
  }
  return findings.map((finding) => ({ ...finding, source: name }));
}
