/**
 * The declaration ratchet (evidence-only): against the base's playbook.json a branch may
 * tighten, adopt, or remove scoped exceptions, never silently drop a contract, widen CI
 * ceilings, or add unapproved scoped exceptions. Evidence path changes are reported, not refused.
 */
import { contractsOf, optedOut, type DeclarationData } from "./declaration.ts";
import { isRecord } from "./strictJson.ts";

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const show = (v: unknown) => (v === undefined ? "None" : JSON.stringify(v));
const asRecord = (v: unknown): Readonly<Record<string, unknown>> => (isRecord(v) ? v : {});

/** Read a file relative to the repo root (used for allowlist checks). */
export type ReadFile = (rel: string) => string | null;

function allowlistEntries(text: string | null): ReadonlySet<string> {
  if (!text) return new Set();
  return new Set(
    text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#")),
  );
}

function exceptionMap(raw: unknown): ReadonlyMap<string, unknown> {
  const out = new Map<string, unknown>();
  if (!Array.isArray(raw)) return out;
  for (const item of raw) {
    if (isRecord(item) && typeof item.subject === "string") {
      out.set(item.subject.trim(), item);
    }
  }
  return out;
}

function checkScopedExceptions(
  where: string,
  before: unknown,
  after: unknown,
  problems: string[],
): void {
  const oldMap = exceptionMap(before);
  const newMap = exceptionMap(after);
  for (const [subject, entry] of [...newMap].toSorted(([a], [b]) => a.localeCompare(b))) {
    if (!oldMap.has(subject)) {
      problems.push(`${where} adds scoped exception '${subject}' (requires owner override, §1.3)`);
    } else if (!same(oldMap.get(subject), entry)) {
      problems.push(
        `${where} modifies scoped exception '${subject}' (requires owner override, §1.3)`,
      );
    }
  }
}

function settingProblems(
  name: string,
  old: Readonly<Record<string, unknown>>,
  next: Readonly<Record<string, unknown>>,
  read: ReadFile | undefined,
  readBase: ReadFile | undefined,
): string[] {
  const problems: string[] = [];
  const keys = [...new Set([...Object.keys(old), ...Object.keys(next)])].toSorted();
  for (const key of keys) {
    const before = old[key];
    const after = next[key];
    if (name === "size" && key === "allowlist") {
      if (typeof after === "string") {
        if (before === undefined) {
          if (read) {
            const headText = read(after);
            if (headText === null) {
              problems.push(
                `size.allowlist added: '${after}' is missing, unreadable, or a symlink (§3.2)`,
              );
            } else {
              const count = allowlistEntries(headText).size;
              if (count > 0) {
                problems.push(`size.allowlist added: ${after} must start empty (${count})`);
              }
            }
          }
        } else if (typeof before === "string") {
          if (read) {
            const headText = read(after);
            if (headText === null) {
              problems.push(`size.allowlist file '${after}' is missing or unreadable (§3.2)`);
            } else {
              const baseSet = allowlistEntries(readBase ? readBase(before) : null);
              const added = [...allowlistEntries(headText)]
                .filter((entry) => !baseSet.has(entry))
                .toSorted();
              if (added.length > 0) {
                problems.push(
                  `size.allowlist added ${added.length} entry(ies): ${added.slice(0, 5).join(", ")} (§3.2)`,
                );
              }
            }
          }
          if (before !== after) {
            problems.push(`size.allowlist changed: ${show(before)} -> ${show(after)}`);
          }
        }
      } else if (before !== undefined && after !== undefined && !same(before, after)) {
        problems.push(`size.allowlist changed: ${show(before)} -> ${show(after)}`);
      }
      continue;
    }
    if (same(before, after)) continue;
    const where = `${name}.${key}`;
    if (key === "evidence" || key === "choke" || key === "engine" || key === "migrator") continue;
    if (key === "exceptions") {
      checkScopedExceptions(where, before, after, problems);
      continue;
    }
    if (name === "size" && key === "maxLines") {
      const b = typeof before === "number" ? before : 500;
      const a = typeof after === "number" ? after : 500;
      if (a > b) problems.push(`${where} raised: ${b} -> ${a}`);
      continue;
    }
    if (name === "intent" && key === "contracts") {
      const b = asRecord(before);
      const a = asRecord(after);
      for (const item of [...new Set([...Object.keys(b), ...Object.keys(a)])].toSorted()) {
        if (b[item] !== undefined && !same(b[item], a[item])) {
          const verb = a[item] === undefined ? "removed" : "moved";
          problems.push(`intent.contracts.${item} ${verb}: ${show(b[item])} -> ${show(a[item])}`);
        }
      }
      continue;
    }
    if (before === undefined && ["file", "dir", "snapshot", "user", "admin"].includes(key)) {
      continue;
    }
    problems.push(`${where} changed: ${show(before)} -> ${show(after)}`);
  }
  return problems;
}

function ciProblems(
  oldCi: Readonly<Record<string, unknown>>,
  nextCi: Readonly<Record<string, unknown>>,
): string[] {
  const problems: string[] = [];
  if (optedOut(oldCi)) return problems;
  if (optedOut(nextCi)) {
    problems.push("ci opted out: the base declares CI standards (§14)");
    return problems;
  }
  checkScopedExceptions("ci.exceptions", oldCi.exceptions, nextCi.exceptions, problems);
  if (
    typeof oldCi.parallel === "number" &&
    typeof nextCi.parallel === "number" &&
    nextCi.parallel < oldCi.parallel
  ) {
    problems.push(`ci.parallel lowered: ${oldCi.parallel} -> ${nextCi.parallel} (§14.2)`);
  }
  for (const cap of ["granularThresholdMs", "maxTier1Ms", "maxTier2Ms", "maxTier3Ms"] as const) {
    const b = oldCi[cap];
    const a = nextCi[cap];
    if (typeof b === "number" && (a === undefined || (typeof a === "number" && a > b))) {
      problems.push(`ci.${cap} loosened: ${b} -> ${show(a)} (§14.2)`);
    }
  }
  if (Array.isArray(oldCi.always)) {
    if (!Array.isArray(nextCi.always)) {
      problems.push("ci.always removed (§14.2)");
    } else {
      const nextSet = new Set(nextCi.always.map(String));
      const removed = oldCi.always.map(String).filter((g) => !nextSet.has(g));
      if (removed.length > 0) {
        problems.push(`ci.always removed mandatory gate(s): ${removed.join(", ")} (§14.2)`);
      }
    }
  }
  if (
    (oldCi.select !== undefined || nextCi.select !== undefined) &&
    !same(oldCi.select, nextCi.select)
  ) {
    problems.push(`ci.select changed: ${show(oldCi.select)} -> ${show(nextCi.select)} (§14.2)`);
  }
  if (Array.isArray(oldCi.full)) {
    if (!Array.isArray(nextCi.full)) {
      problems.push("ci.full removed (§14.2)");
    } else {
      const nextSet = new Set(nextCi.full.map(String));
      const removed = oldCi.full.map(String).filter((g) => !nextSet.has(g));
      if (removed.length > 0) {
        problems.push(`ci.full removed trigger(s): ${removed.join(", ")} (§14.2)`);
      }
    }
  }
  return problems;
}

/** How HEAD loosens BASE's declaration; empty when it only tightens or adopts. */
export function loosenedDeclaration(
  head: DeclarationData,
  base: DeclarationData,
  read?: ReadFile,
  readBase?: ReadFile,
): ReadonlyArray<string> {
  const headContracts = contractsOf(head);
  const problems: string[] = [];
  for (const [name, old] of Object.entries(contractsOf(base))) {
    if (!(name in headContracts)) {
      problems.push(`contract ${name} removed`);
      continue;
    }
    const next = headContracts[name];
    if (optedOut(old)) continue;
    if (optedOut(next)) {
      problems.push(`contract ${name} opted out: the base declares it`);
      continue;
    }
    problems.push(...settingProblems(name, asRecord(old), asRecord(next), read, readBase));
  }
  if (isRecord(base.ci)) {
    if (!isRecord(head.ci)) {
      problems.push("ci block removed");
    } else {
      problems.push(...ciProblems(base.ci, head.ci));
    }
  }
  return problems;
}

/** Evidence path changes against the base: reported, never refused. */
export function reportedCommandChanges(
  head: DeclarationData,
  base: DeclarationData,
): ReadonlyArray<string> {
  const headContracts = contractsOf(head);
  const baseContracts = contractsOf(base);
  const out: string[] = [];
  for (const name of [
    ...new Set([...Object.keys(baseContracts), ...Object.keys(headContracts)]),
  ].toSorted()) {
    const before = asRecord(baseContracts[name]).evidence;
    const after = asRecord(headContracts[name]).evidence;
    if (!same(before, after)) out.push(`${name}.evidence: ${show(before)} -> ${show(after)}`);
  }
  const ciBefore = asRecord(base.ci).evidence;
  const ciAfter = asRecord(head.ci).evidence;
  if (!same(ciBefore, ciAfter)) out.push(`ci.evidence: ${show(ciBefore)} -> ${show(ciAfter)}`);
  return out;
}
