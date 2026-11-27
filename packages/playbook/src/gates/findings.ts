/**
 * Shared finding and Baseline matching for deterministic contract gates.
 * Subject rules (`fleet/`, `optimization/`) key by `(rule, file)` with count;
 * line/item rules key by `(rule, file, sha1(text))`.
 */
import { fingerprint, type BaselineEntry } from "../baseline.ts";

export interface GateFinding {
  readonly rule: string;
  readonly file: string;
  readonly text: string;
  readonly message: string;
  readonly where?: string | undefined;
}

const SUBJECT_PREFIXES = ["fleet/", "optimization/"];
const isSubjectRule = (rule: string) => SUBJECT_PREFIXES.some((p) => rule.startsWith(p));

export function findingIdentity(rule: string, file: string, text: string): string {
  const fp = isSubjectRule(rule) ? null : fingerprint(text);
  return JSON.stringify([rule, file, fp]);
}

function entryIdentity(entry: BaselineEntry): string {
  return JSON.stringify([
    entry.rule,
    entry.file,
    isSubjectRule(entry.rule) ? null : entry.fingerprint,
  ]);
}

function mergeBaseline(entries: ReadonlyArray<BaselineEntry>): ReadonlyMap<string, BaselineEntry> {
  const out = new Map<string, BaselineEntry>();
  for (const entry of entries) {
    const key = entryIdentity(entry);
    const prev = out.get(key);
    out.set(
      key,
      prev
        ? {
            ...prev,
            count: prev.count + entry.count,
            expires: prev.expires < entry.expires ? prev.expires : entry.expires,
          }
        : entry,
    );
  }
  return out;
}

export interface JudgeFindingsOptions {
  readonly baselinePath: string | null;
  readonly touched?: ReadonlySet<string> | undefined;
  readonly touchedNote?: string | undefined;
  readonly measuredValues?: ReadonlyMap<string, number> | undefined;
  readonly valueRules?: ReadonlySet<string> | undefined;
}

export interface JudgedFindings {
  readonly problems: ReadonlyArray<string>;
  readonly heldCount: number;
}

/** Match FINDINGS against Baseline ENTRIES, enforcing touched-file rules and shrink-only cleanup. */
export function judgeFindings(
  findings: ReadonlyArray<GateFinding>,
  entries: ReadonlyArray<BaselineEntry>,
  options: JudgeFindingsOptions,
): JudgedFindings {
  const touched = options.touched ?? new Set<string>();
  const note = options.touchedNote ?? " (touched in this change: touch it, fix it)";
  const byKey = new Map<string, GateFinding[]>();
  for (const finding of findings) {
    const key = findingIdentity(finding.rule, finding.file, finding.text);
    const list = byKey.get(key);
    if (list) list.push(finding);
    else byKey.set(key, [finding]);
  }
  const merged = mergeBaseline(entries);
  const problems: string[] = [];
  let heldCount = 0;

  for (const [key, list] of byKey) {
    const sample = list[0]!;
    const isTouched = touched.has(sample.file) || touched.has(key);
    const heldEntry = isTouched ? undefined : merged.get(key);
    const allowance = heldEntry?.count ?? 0;
    heldCount += Math.min(allowance, list.length);
    for (const item of list.slice(allowance)) {
      const loc = item.where ?? item.file;
      problems.push(`${loc} [${item.rule}]: ${item.message}${isTouched ? note : ""}`);
    }
  }

  if (options.baselinePath) {
    for (const [key, entry] of merged) {
      const foundList = byKey.get(key) ?? [];
      const isTouched = touched.has(entry.file) || touched.has(key);
      if (isTouched) {
        if (foundList.length === 0) {
          problems.push(
            `fixed: ${entry.file} [${entry.rule}] is found 0 time(s); remove its entry in ${options.baselinePath}`,
          );
        }
      } else if (foundList.length < entry.count) {
        const action =
          foundList.length === 0 ? "remove its entry" : `lower its count to ${foundList.length}`;
        problems.push(
          `fixed: ${entry.file} [${entry.rule}] is found ${foundList.length} time(s); ${action} in ${options.baselinePath}`,
        );
      } else if (options.valueRules?.has(entry.rule) && options.measuredValues) {
        const measured = options.measuredValues.get(`${entry.file}\0${entry.rule}`);
        if (measured !== undefined) {
          if (entry.value === null) {
            problems.push(
              `${entry.file} [${entry.rule}] is held with no value: record the measured ${measured}`,
            );
          } else if (measured > entry.value) {
            problems.push(
              `${entry.file} [${entry.rule}] got worse: measured ${measured}, held at ${entry.value}`,
            );
          } else if (measured < entry.value) {
            problems.push(
              `${entry.file} [${entry.rule}] improved to ${measured}: lower its value from ${entry.value} to ${measured}`,
            );
          }
        }
      }
    }
  }

  return { problems, heldCount };
}

export function findingCountsSummary(findings: ReadonlyArray<GateFinding>): string {
  const counts = new Map<string, number>();
  for (const f of findings) counts.set(f.rule, (counts.get(f.rule) ?? 0) + 1);
  return [...counts.entries()]
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([rule, count]) => `${rule}=${count}`)
    .join(", ");
}
