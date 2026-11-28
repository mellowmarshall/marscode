/**
 * The declaration ratchet: a branch may tighten, adopt, or remove scoped exceptions, never drop a
 * contract, widen CI ceilings, or add an unapproved exception. A new one-file size exception that
 * names an issue is returned apart: it needs no owner when the issue is open (§1.3).
 */ import { contractsOf, optedOut, type DeclarationData } from "./declaration.ts";
import { exceptionIssueRefs, type IssueRef } from "./exceptionIssues.ts";
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

/** A subject as one path: trimmed, without a leading ./, with no doubled slash. */
function normalizeSubject(subject: string): string {
  return subject
    .trim()
    .replace(/^(?:\.\/)+/, "")
    .replace(/\/{2,}/g, "/");
}

function exceptionMap(raw: unknown): ReadonlyMap<string, unknown> {
  const out = new Map<string, unknown>();
  if (!Array.isArray(raw)) return out;
  for (const item of raw) {
    if (isRecord(item) && typeof item.subject === "string") {
      out.set(normalizeSubject(item.subject), item);
    }
  }
  return out;
}

/** A new scoped size exception for one file that names an issue: accepted when the issue is open. */
export interface IssueBackedException {
  readonly where: string;
  readonly subject: string;
  readonly refs: ReadonlyArray<IssueRef>;
}

/** Why REL is not one tracked regular file at HEAD inside the repo; null when it is one. */
export type FileScope = (rel: string) => string | null;

/** A glob or regex metacharacter: such a subject could name more than one file. */
const PATTERN = /[*?[\]{}+()|^$!\\]/;

/** Why SUBJECT is not one file the ratchet can see; null when it names one tracked file. */
function notOneFile(subject: string, fileScope: FileScope | undefined): string | null {
  if (PATTERN.test(subject)) return "a pattern scope";
  if (subject === "" || subject === "." || subject.endsWith("/")) return "a directory scope";
  if (subject.startsWith("/") || subject.split("/").includes(".."))
    return "a path outside the repo";
  if (!fileScope) return "no way to see the file";
  return fileScope(subject);
}

interface ExceptionRules {
  readonly problems: string[];
  /** Where to put an issue-backed exception; absent: none is (every new one takes the owner). */
  readonly issueBacked?: IssueBackedException[] | undefined;
  readonly fileScope?: FileScope | undefined;
}

function checkScopedExceptions(
  where: string,
  before: unknown,
  after: unknown,
  rules: ExceptionRules,
): void {
  const { problems } = rules;
  const oldMap = exceptionMap(before);
  const newMap = exceptionMap(after);
  for (const [subject, entry] of [...newMap].toSorted(([a], [b]) => a.localeCompare(b))) {
    if (!oldMap.has(subject)) {
      if (!rules.issueBacked) {
        problems.push(
          `${where} adds scoped exception '${subject}' (requires owner override, §1.3)`,
        );
        continue;
      }
      const scope = notOneFile(subject, rules.fileScope);
      const refs = isRecord(entry) ? exceptionIssueRefs(entry) : [];
      if (scope !== null) {
        problems.push(
          `${where} adds scoped exception '${subject}' with ${scope} (requires owner override, §1.3)`,
        );
      } else if (refs.length === 0) {
        problems.push(
          `${where} adds scoped exception '${subject}' naming no issue (requires owner override, §1.3)`,
        );
      } else {
        rules.issueBacked.push({ where, subject, refs });
      }
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
  issueBacked: IssueBackedException[],
  fileScope: FileScope | undefined,
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
      checkScopedExceptions(where, before, after, {
        problems,
        issueBacked: name === "size" ? issueBacked : undefined,
        fileScope,
      });
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
  checkScopedExceptions("ci.exceptions", oldCi.exceptions, nextCi.exceptions, { problems });
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

export interface DeclarationRatchet {
  /** Each loosening the owner must approve. */
  readonly problems: ReadonlyArray<string>;
  /** New one-file size exceptions that name an issue: accepted without the owner when it is open. */
  readonly issueBacked: ReadonlyArray<IssueBackedException>;
}

/** How HEAD loosens BASE's declaration: what takes the owner, and what an open issue may carry. */
export function declarationRatchet(
  head: DeclarationData,
  base: DeclarationData,
  read?: ReadFile,
  readBase?: ReadFile,
  fileScope?: FileScope,
): DeclarationRatchet {
  const headContracts = contractsOf(head);
  const problems: string[] = [];
  const issueBacked: IssueBackedException[] = [];
  const baseContracts = contractsOf(base);
  // A contract new to the branch, or one the base opted out of, adopts its settings, but each
  // of its exceptions is new: it is held as one added to an empty list.
  for (const [name, next] of Object.entries(headContracts)) {
    const old = baseContracts[name];
    if (old !== undefined && !optedOut(old)) continue;
    checkScopedExceptions(`${name}.exceptions`, [], asRecord(next).exceptions, {
      problems,
      issueBacked: name === "size" ? issueBacked : undefined,
      fileScope,
    });
  }
  for (const [name, old] of Object.entries(baseContracts)) {
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
    problems.push(
      ...settingProblems(
        name,
        asRecord(old),
        asRecord(next),
        read,
        readBase,
        issueBacked,
        fileScope,
      ),
    );
  }
  if (isRecord(head.ci) && (!isRecord(base.ci) || optedOut(base.ci))) {
    checkScopedExceptions("ci.exceptions", [], head.ci.exceptions, { problems });
  }
  if (isRecord(base.ci)) {
    if (!isRecord(head.ci)) {
      problems.push("ci block removed");
    } else {
      problems.push(...ciProblems(base.ci, head.ci));
    }
  }
  return { problems, issueBacked };
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
