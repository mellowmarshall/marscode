// @effect-diagnostics nodeBuiltinImport:off - Reads the owner's installed exceptions file.
/**
 * The owner's exceptions file (host-guards/exceptions.json, installed at
 * ~/.local/lib/exceptions.json): the single parser for its section, rule and contract waivers.
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { isRecord } from "./strictJson.ts";

export const EXCEPTIONS_SOURCE = "host-guards/exceptions.json";

const SECTION_NAMES: Readonly<Record<number, ReadonlyArray<string>>> = {
  0: ["terms"],
  1: ["ratchet", "contracts"],
  2: ["challenge"],
  3: ["size"],
  4: ["generations"],
  5: ["intent"],
  6: ["fleet"],
  7: ["dictionary"],
  8: ["migrations"],
  9: ["actions"],
  10: ["design"],
  11: ["optimization"],
  12: ["maps"],
  13: ["tools"],
  14: ["ci"],
  15: ["docs"],
};

const ALIASES: Readonly<Record<string, string>> = {
  "*": "*",
  all: "*",
  "declaration ratchet": "ratchet",
  declaration: "ratchet",
  "ship-queue": "challenge",
  "declaration-challenge": "challenge",
  "system-maps": "maps",
  "ci-standards": "ci",
};

const NAME_TO_NUM: ReadonlyMap<string, number> = new Map(
  Object.entries(SECTION_NAMES).flatMap(([num, names]) => names.map((n) => [n, Number(num)])),
);

export interface NormalizedWaiver {
  readonly repo: string;
  readonly scope: "guards" | "playbook";
  readonly key: string;
  readonly reason: string;
  readonly date: string | null;
  readonly issueRef: string | null;
}

export interface RepoExceptions {
  readonly playbook: Readonly<Record<string, string>>;
  readonly guards: string;
}

/** Waiver key -> reason for one repo. */
export type Bypasses = Readonly<Record<string, string>>;

function normKey(raw: string): string {
  const k = raw.trim().toLowerCase();
  if (k in ALIASES) return ALIASES[k]!;
  if (k.startsWith("§") && /^\d+$/.test(k.slice(1))) return k.slice(1);
  return k;
}

const words = (text: string) => text.toLowerCase().split(/\s+/).filter(Boolean).join(" ");

/** The installed file; a suite's own copy (DEVTOOLS_EXCEPTIONS) only under HOST_GUARDS_TEST. */
export function installedExceptionsPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.DEVTOOLS_EXCEPTIONS?.trim();
  if (env.HOST_GUARDS_TEST && override) return override;
  return NodePath.join(NodeOS.homedir(), ".local", "lib", "exceptions.json");
}

/** The file's repos; anything malformed is dropped. */
function exceptionEntries(data: unknown): ReadonlyMap<string, RepoExceptions> {
  const out = new Map<string, RepoExceptions>();
  const repos = isRecord(data) ? data.repos : undefined;
  if (!isRecord(repos)) return out;
  for (const [repo, entry] of Object.entries(repos)) {
    if (!isRecord(entry)) continue;
    const book: Record<string, string> = {};
    if (isRecord(entry.playbook)) {
      for (const [key, value] of Object.entries(entry.playbook)) {
        if (typeof value === "string" && value.trim()) book[key] = value.trim();
      }
    }
    out.set(repo.trim().toLowerCase(), {
      playbook: book,
      guards: typeof entry.guards === "string" ? entry.guards.trim() : "",
    });
  }
  return out;
}

export function readExceptionsFile(path: string): unknown {
  try {
    return JSON.parse(NodeFS.readFileSync(path, "utf8")) as unknown;
  } catch {
    return null;
  }
}

/** REPO's playbook waivers ("*" applies to every repo), from parsed exceptions DATA. */
export function repoBypasses(data: unknown, repo: string): Bypasses {
  const repos = exceptionEntries(data);
  return {
    ...repos.get("*")?.playbook,
    ...repos.get(repo.toLowerCase())?.playbook,
  };
}

function parseDateAndIssue(reason: string): {
  readonly date: string | null;
  readonly issueRef: string | null;
} {
  const dateMatch = /\b(20\d{2}-\d{2}-\d{2})\b/.exec(reason);
  const issueMatch = /(?:\b[a-z][a-z0-9_-]*#\d+|(?<![a-z0-9_])#\d+)\b/i.exec(reason);
  return { date: dateMatch?.[1] ?? null, issueRef: issueMatch?.[0] ?? null };
}

/** Every waiver of the file, flattened for display (the DevTools UI and the declaration view). */
export function normalizeExceptions(data: unknown): ReadonlyArray<NormalizedWaiver> {
  const source = isRecord(data) && "entries" in data ? data.entries : data;
  const out: NormalizedWaiver[] = [];
  const repos = isRecord(source) ? source.repos : undefined;
  if (!isRecord(repos)) return out;
  for (const [repo, spec] of Object.entries(repos)) {
    if (!isRecord(spec)) continue;
    if (typeof spec.guards === "string" && spec.guards.trim()) {
      const reason = spec.guards.trim();
      out.push({ repo, scope: "guards", key: "guards", reason, ...parseDateAndIssue(reason) });
    }
    if (!isRecord(spec.playbook)) continue;
    for (const [key, value] of Object.entries(spec.playbook)) {
      if (typeof value !== "string" || !value.trim()) continue;
      const reason = value.trim();
      out.push({ repo, scope: "playbook", key, reason, ...parseDateAndIssue(reason) });
    }
  }
  return out;
}

export function matchesWaiverRepo(waiverRepo: string, repoName: string): boolean {
  if (waiverRepo === "*") return true;
  const lower = waiverRepo.toLowerCase();
  const target = repoName.toLowerCase();
  return lower === target || lower.endsWith(`/${target}`);
}

/** Sections 12..15 were renumbered in playbook v8; bare numeric keys are refused to prevent silent misdirection. */
const RENUMBERED_SECTIONS = new Set(["12", "13", "14", "15"]);

function normalized(bypasses: Bypasses): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  for (const [k, v] of Object.entries(bypasses)) {
    if (!v) continue;
    const nk = normKey(k);
    if (RENUMBERED_SECTIONS.has(nk)) continue;
    out.set(nk, v);
  }
  return out;
}

/** The reason if TARGET (a contract, check, or section number) is waived, else null. */
export function bypassReason(bypasses: Bypasses, target: string): string | null {
  const bp = normalized(bypasses);
  if (bp.size === 0) return null;
  if (bp.has("*")) return bp.get("*")!;
  const key = normKey(target);
  if (bp.has(key)) return bp.get(key)!;
  const num = NAME_TO_NUM.get(key);
  if (num !== undefined && bp.has(String(num))) return bp.get(String(num))!;
  if (/^\d+$/.test(key)) {
    for (const alias of SECTION_NAMES[Number(key)] ?? []) {
      if (bp.has(alias)) return bp.get(alias)!;
    }
  }
  return null;
}

/** The reason PLAYBOOK.md section NUM (0..15) is waived as a whole, else null. */
export function sectionBypassReason(bypasses: Bypasses, num: number): string | null {
  const bp = normalized(bypasses);
  if (bp.size === 0) return null;
  if (bp.has("*")) return bp.get("*")!;
  if (bp.has(String(num))) return bp.get(String(num))!;
  const aliases = SECTION_NAMES[num] ?? [];
  if (num !== 1) {
    for (const alias of aliases) if (bp.has(alias)) return bp.get(alias)!;
  } else if (aliases.every((a) => bp.has(a))) {
    return bp.get("ratchet") ?? null;
  }
  return null;
}

/** Each rule key "<section>/<rule>": (section number or null, the rule's words, reason). */
function ruleKeys(
  bypasses: Bypasses,
): ReadonlyArray<{ readonly section: number | null; readonly rule: string; readonly why: string }> {
  const out: Array<{ section: number | null; rule: string; why: string }> = [];
  for (const [raw, why] of Object.entries(bypasses)) {
    if (!why || !raw.includes("/")) continue;
    const idx = raw.indexOf("/");
    const section = normKey(raw.slice(0, idx));
    if (RENUMBERED_SECTIONS.has(section)) continue;
    out.push({
      section: /^\d+$/.test(section) ? Number(section) : (NAME_TO_NUM.get(section) ?? null),
      rule: words(raw.slice(idx + 1)),
      why,
    });
  }
  return out;
}

/** The waived rules of section NUM among LABELS (its bold bullet labels): [label, reason]. */
export function sectionRuleReasons(
  bypasses: Bypasses,
  num: number,
  labels: ReadonlyArray<string>,
): ReadonlyArray<readonly [string, string]> {
  const byLabel = new Map(labels.map((label) => [words(label), label] as const));
  const out: Array<readonly [string, string]> = [];
  for (const { section, rule, why } of ruleKeys(bypasses)) {
    const label = section === num ? byLabel.get(rule) : undefined;
    if (label && !out.some(([seen]) => seen === label)) out.push([label, why]);
  }
  return out;
}

/** Every leaf value of the file by its dotted path: what any reader may act on. */
function exceptionLeaves(data: unknown, path = ""): ReadonlyMap<string, unknown> {
  const out = new Map<string, unknown>();
  if (isRecord(data) && Object.keys(data).length > 0) {
    for (const [k, v] of Object.entries(data)) {
      for (const [leaf, value] of exceptionLeaves(v, path ? `${path}.${k}` : k)) {
        out.set(leaf, value);
      }
    }
    return out;
  }
  if (path) out.set(path, data);
  return out;
}

/** The exception values HEAD adds or changes against BASE (removals are free). */
export function exceptionChanges(head: unknown, base: unknown): ReadonlyArray<string> {
  const before = exceptionLeaves(base);
  const problems: string[] = [];
  for (const [key, value] of [...exceptionLeaves(head)].toSorted(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (key === "_doc") continue;
    const old = before.get(key);
    if (!before.has(key) || JSON.stringify(old) !== JSON.stringify(value)) {
      problems.push(`${key}: ${JSON.stringify(old ?? null)} -> ${JSON.stringify(value)}`);
    }
  }
  return problems;
}
