// @effect-diagnostics nodeBuiltinImport:off - sha1 line fingerprints for Baseline entries.
/**
 * Baselines: accepted violations, each with an issue and an expiry at most 180 days out.
 * Against the base a Baseline only shrinks; adoption of the contract may add entries.
 */
import * as NodeCrypto from "node:crypto";

import { isRecord, parseStrictJson } from "./strictJson.ts";

const ENTRY_FIELDS = new Set([
  "rule",
  "file",
  "fingerprint",
  "count",
  "lines",
  "value",
  "issue",
  "expires",
]);
const REQUIRED = ["rule", "file", "issue", "expires"] as const;
const MAX_DAYS = 180;
const ISSUE_RE = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?#[1-9][0-9]*$/;
const SHA1_RE = /^[0-9a-f]{40}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UNSAFE_PATH = /^\/|(^|\/)\.\.(\/|$)/;
/** Rules whose findings are identified by rule and subject alone. */
const SUBJECT_RULES = ["fleet/", "optimization/"];

export interface BaselineEntry {
  readonly rule: string;
  readonly file: string;
  readonly issue: string;
  /** YYYY-MM-DD */
  readonly expires: string;
  readonly fingerprint: string | null;
  readonly lines: number | null;
  readonly count: number;
  readonly value: number | null;
}

const bySubject = (rule: string) => SUBJECT_RULES.some((p) => rule.startsWith(p));

function entryKey(e: Pick<BaselineEntry, "rule" | "file" | "fingerprint">): string {
  return JSON.stringify([e.rule, e.file, bySubject(e.rule) ? null : e.fingerprint]);
}

function entryLabel(e: BaselineEntry): string {
  const what = e.fingerprint ? ` line ${e.fingerprint.slice(0, 12)}` : "";
  const times = e.count > 1 ? ` x${e.count}` : "";
  return `${e.file} [${e.rule}]${what}${times} (${e.issue}, expires ${e.expires})`;
}

export function fingerprint(line: string): string {
  const normalized = line.split(/\s+/).filter(Boolean).join(" ");
  return NodeCrypto.createHash("sha1").update(normalized, "utf8").digest("hex");
}

const whole = (v: unknown, low: number): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= low;

function civilToDays(y: number, m: number, d: number): number {
  const yy = m <= 2 ? y - 1 : y;
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

function realDate(iso: string): boolean {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  if (m < 1 || m > 12 || d < 1) return false;
  const next = m === 12 ? civilToDays(y + 1, 1, 1) : civilToDays(y, m + 1, 1);
  return d <= next - civilToDays(y, m, 1);
}

function daysBetween(fromIso: string, toIso: string): number {
  const [fy, fm, fd] = fromIso.split("-").map(Number) as [number, number, number];
  const [ty, tm, td] = toIso.split("-").map(Number) as [number, number, number];
  return civilToDays(ty, tm, td) - civilToDays(fy, fm, fd);
}

function parseEntry(
  item: unknown,
  where: string,
): { entry: BaselineEntry | null; errors: string[] } {
  if (!isRecord(item)) return { entry: null, errors: [`${where}: must be an object`] };
  const errors: string[] = [];
  const unknown = Object.keys(item).filter((k) => !ENTRY_FIELDS.has(k));
  if (unknown.length > 0) {
    errors.push(`${where}: unknown key ${unknown.map((k) => `'${k}'`).join(", ")}`);
  }
  const missing = REQUIRED.filter((k) => typeof item[k] !== "string" || !item[k]);
  for (const key of missing) errors.push(`${where}: '${key}' is required (a non-empty string)`);
  if (missing.length > 0) return { entry: null, errors };
  const file = item.file as string;
  const issue = item.issue as string;
  const expires = item.expires as string;
  if (UNSAFE_PATH.test(file)) errors.push(`${where}: file '${file}' must be repo-relative`);
  if (!ISSUE_RE.test(issue)) errors.push(`${where}: issue '${issue}' must look like #123`);
  if (!DATE_RE.test(expires)) errors.push(`${where}: expires '${expires}' is not YYYY-MM-DD`);
  else if (!realDate(expires)) errors.push(`${where}: expires '${expires}' is not a real date`);
  const fp = item.fingerprint;
  if (fp !== undefined && (typeof fp !== "string" || !SHA1_RE.test(fp))) {
    errors.push(`${where}: fingerprint must be a 40-character sha1 hex`);
  }
  const { lines, value } = item;
  if (lines !== undefined && !whole(lines, 0))
    errors.push(`${where}: lines must be a whole number`);
  if (value !== undefined && !whole(value, 0))
    errors.push(`${where}: value must be a whole number`);
  const count = item.count ?? 1;
  if (!whole(count, 1)) errors.push(`${where}: count must be a whole number of at least 1`);
  else if (count > 1 && fp === undefined && !bySubject(item.rule as string)) {
    errors.push(`${where}: count applies only to a line rule (an entry with a fingerprint)`);
  }
  if (fp !== undefined && lines !== undefined) {
    errors.push(`${where}: an entry is a line rule (fingerprint) or a file rule (lines), not both`);
  }
  if (value !== undefined && (fp !== undefined || lines !== undefined)) {
    errors.push(`${where}: value is a measured number: not with a fingerprint or lines`);
  }
  if (errors.length > 0) return { entry: null, errors };
  return {
    entry: {
      rule: item.rule as string,
      file,
      issue,
      expires,
      fingerprint: typeof fp === "string" ? fp : null,
      lines: typeof lines === "number" ? lines : null,
      count: count as number,
      value: typeof value === "number" ? value : null,
    },
    errors,
  };
}

export interface ParsedBaseline {
  readonly entries: ReadonlyArray<BaselineEntry>;
  readonly errors: ReadonlyArray<string>;
}

export function parseBaseline(text: string, where = "baseline"): ParsedBaseline {
  let data: unknown;
  try {
    data = parseStrictJson(text);
  } catch (cause) {
    return {
      entries: [],
      errors: [`${where}: not valid JSON: ${String((cause as Error).message)}`],
    };
  }
  if (!isRecord(data) || Object.keys(data).some((k) => k !== "entries")) {
    return { entries: [], errors: [`${where}: must be an object with one key 'entries'`] };
  }
  const raw = data.entries ?? [];
  if (!Array.isArray(raw)) return { entries: [], errors: [`${where}: 'entries' must be a list`] };
  const entries: BaselineEntry[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  raw.forEach((item, i) => {
    const parsed = parseEntry(item, `${where} entries[${i}]`);
    errors.push(...parsed.errors);
    if (!parsed.entry) return;
    const key = entryKey(parsed.entry);
    if (seen.has(key) && !bySubject(parsed.entry.rule)) {
      errors.push(`${where} entries[${i}]: repeats an earlier entry; use one entry with count`);
    }
    seen.add(key);
    entries.push(parsed.entry);
  });
  return { entries, errors };
}

export const expiredEntries = (entries: ReadonlyArray<BaselineEntry>, today: string) =>
  entries.filter((e) => e.expires < today);

export const tooFarEntries = (entries: ReadonlyArray<BaselineEntry>, today: string) =>
  entries.filter((e) => daysBetween(today, e.expires) > MAX_DAYS);

/** Entries by identity; several of one identity are one, counts summed, earliest expiry. */
function mergedEntries(entries: ReadonlyArray<BaselineEntry>): ReadonlyMap<string, BaselineEntry> {
  const out = new Map<string, BaselineEntry>();
  for (const e of entries) {
    const key = entryKey(e);
    const old = out.get(key);
    out.set(
      key,
      old
        ? {
            ...old,
            count: old.count + e.count,
            expires: old.expires < e.expires ? old.expires : e.expires,
          }
        : e,
    );
  }
  return out;
}

/** How the change loosened the Baseline; adoption may add entries (not for files new on the branch). */
export function baselineGrowth(
  current: ReadonlyArray<BaselineEntry>,
  base: ReadonlyArray<BaselineEntry>,
  options: { readonly adopting: boolean; readonly addedFiles?: ReadonlySet<string> },
): ReadonlyArray<string> {
  const before = mergedEntries(base);
  const problems: string[] = [];
  for (const [key, entry] of mergedEntries(current)) {
    const old = before.get(key);
    if (!old) {
      if (options.adopting && options.addedFiles?.has(entry.file)) {
        problems.push(`added: ${entryLabel(entry)} (a brand-new file cannot be baselined)`);
      } else if (!options.adopting) {
        problems.push(`added: ${entryLabel(entry)}`);
      }
      continue;
    }
    const tag = `${entry.file} [${entry.rule}]`;
    if (entry.count > old.count) problems.push(`count grew: ${tag} ${old.count} -> ${entry.count}`);
    if (old.lines !== null && entry.lines === null)
      problems.push(`lines dropped: ${tag} had ${old.lines}`);
    else if (entry.lines !== null && (old.lines === null || entry.lines > old.lines)) {
      problems.push(`grew: ${tag} ${old.lines} -> ${entry.lines} lines`);
    }
    if (old.value !== null && entry.value === null)
      problems.push(`value dropped: ${tag} had ${old.value}`);
    else if (entry.value !== null && (old.value === null || entry.value > old.value)) {
      problems.push(`grew: ${tag} value ${old.value} -> ${entry.value}`);
    }
    if (entry.expires > old.expires) {
      problems.push(`expiry moved later: ${tag} ${old.expires} -> ${entry.expires}`);
    }
    if (entry.issue !== old.issue)
      problems.push(`issue changed: ${tag} ${old.issue} -> ${entry.issue}`);
  }
  return problems;
}
