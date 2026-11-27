/**
 * The declaration ratchet: against the base's playbook.json a branch may tighten or adopt,
 * never loosen; the repo's own commands (REPORTED_SETTINGS) are reported, never refused.
 */
import { contractsOf, optedOut, type DeclarationData } from "./declaration.ts";
import { isRecord } from "./strictJson.ts";

const LIST_SETTINGS = new Set([
  "interactive",
  "style_properties",
  "client",
  "code",
  "truncate",
  "scripts",
  "slot_calls",
]);

const SET_TIGHTENS = new Set([
  "design.tokens",
  "design.ui",
  "design.slots",
  "generations.command",
  "migrations.dir",
  "migrations.list",
  "actions.floors",
  "migrations.protection",
]);

const REPLAY_FREE = new Set(["engine", "image", "database", "command"]);

const REPORTED_SETTINGS: ReadonlySet<string> = new Set([
  "tools.steps",
  "size.command",
  "migrations.lint",
  "migrations.render",
  "actions.evidence",
  "actions.chokepoint",
  "design.touch_calls",
  "design.command",
  "design.chokepoint",
  "design.content_values",
  "fleet.reads",
]);

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const show = (v: unknown) => (v === undefined ? "None" : JSON.stringify(v));
const asRecord = (v: unknown): Readonly<Record<string, unknown>> => (isRecord(v) ? v : {});
const asList = (v: unknown): ReadonlyArray<string> =>
  Array.isArray(v) ? v.map((x) => (typeof x === "string" ? x : JSON.stringify(x))) : [];

function inside(path: string, folder: string): boolean {
  const p = path.replace(/\/+$/, "");
  const f = folder.replace(/\/+$/, "");
  return p === f || p.startsWith(`${f}/`);
}

/** Whether the allowlist file READ gives holds entries (a first allowlist must start empty). */
export type ReadFile = (rel: string) => string | null;

function allowlistEntryCount(text: string | null): number {
  if (!text) return 0;
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#")).length;
}

function settingProblems(
  name: string,
  old: Readonly<Record<string, unknown>>,
  next: Readonly<Record<string, unknown>>,
  read: ReadFile,
): string[] {
  const problems: string[] = [];
  const keys = [...new Set([...Object.keys(old), ...Object.keys(next)])].toSorted();
  for (const key of keys) {
    const before = old[key];
    const after = next[key];
    if (same(before, after)) continue;
    const where = `${name}.${key}`;
    if (REPORTED_SETTINGS.has(where)) continue;
    if (name === "actions" && ["source", "ledger", "walk_baseline"].includes(key)) continue;
    if (key === "baseline" && before === undefined) continue;
    if (name === "actions" && key === "held_back" && before === undefined) continue;
    if (name === "design" && (key === "tokens" || key === "ui") && typeof before === "string") {
      if (typeof after === "string" && inside(after, before)) continue;
      const why = typeof after === "string" && inside(before, after) ? "it widens" : "a move";
      problems.push(`${where} widened or moved: ${before} -> ${String(after)} (${why})`);
    } else if (key === "baseline") {
      if (after === undefined) problems.push(`${where} removed: ${show(before)} -> None`);
    } else if (LIST_SETTINGS.has(key)) {
      const kept = new Set(asList(after));
      const dropped = asList(before).filter((x) => !kept.has(x));
      if (dropped.length > 0) problems.push(`${where} dropped: ${dropped.toSorted().join(", ")}`);
    } else if (name === "intent" && key === "contracts") {
      const b = asRecord(before);
      const a = asRecord(after);
      for (const item of [...new Set([...Object.keys(b), ...Object.keys(a)])].toSorted()) {
        if (b[item] !== undefined && !same(b[item], a[item])) {
          const verb = a[item] === undefined ? "removed" : "moved";
          problems.push(`intent.contracts.${item} ${verb}: ${show(b[item])} -> ${show(a[item])}`);
        }
      }
    } else if (
      (before === undefined || (before === false && after === true)) &&
      SET_TIGHTENS.has(where)
    ) {
      continue;
    } else if (name === "actions" && key === "floors") {
      const b = asRecord(before);
      const a = asRecord(after);
      for (const [pattern, floors] of Object.entries(b)) {
        if (!(pattern in a)) {
          problems.push(`${where}.${pattern} removed`);
          continue;
        }
        for (const [entity, count] of Object.entries(asRecord(floors))) {
          const now = asRecord(a[pattern])[entity];
          if (now === undefined) problems.push(`${where}.${pattern}.${entity} removed`);
          else if (typeof now === "number" && typeof count === "number" && now < count) {
            problems.push(`${where}.${pattern}.${entity} lowered: ${count} -> ${now}`);
          }
        }
      }
    } else if (name === "migrations" && key === "replay" && isRecord(after)) {
      const was = Object.fromEntries(
        Object.entries(asRecord(before)).filter(([k]) => k !== "command"),
      );
      const now = Object.fromEntries(Object.entries(after).filter(([k]) => k !== "command"));
      const freeFirst =
        Object.keys(was).length === 0 && Object.keys(now).every((k) => REPLAY_FREE.has(k));
      if (!same(was, now) && !freeFirst) {
        problems.push(`${where} changed: ${show(before)} -> ${show(after)}`);
      }
    } else if (name === "size" && key === "exempt") {
      const b = asRecord(before);
      const a = asRecord(after);
      const added = Object.keys(a)
        .filter((k) => !(k in b))
        .toSorted();
      const changed = Object.keys(a)
        .filter((k) => k in b && !same(a[k], b[k]))
        .toSorted();
      if (added.length > 0) {
        problems.push(`${where} adds exempt place(s): ${added.join(", ")} (the owner's call)`);
      }
      if (changed.length > 0)
        problems.push(`${where} changes the reason for: ${changed.join(", ")}`);
    } else if (before === undefined && name === "size" && key === "allowlist") {
      const count = typeof after === "string" ? allowlistEntryCount(read(after)) : 0;
      if (count > 0) problems.push(`${where} added: ${String(after)} must start empty (${count})`);
    } else {
      problems.push(`${where} changed: ${show(before)} -> ${show(after)}`);
    }
  }
  return problems;
}

/** How HEAD loosens BASE's declaration; empty when it only tightens or adopts. */
export function loosenedDeclaration(
  head: DeclarationData,
  base: DeclarationData,
  read: ReadFile = () => null,
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
    problems.push(...settingProblems(name, asRecord(old), asRecord(next), read));
  }
  return problems;
}

/** The repo's own commands that changed against the base: reported, never refused. */
export function reportedCommandChanges(
  head: DeclarationData,
  base: DeclarationData,
): ReadonlyArray<string> {
  const headContracts = contractsOf(head);
  const baseContracts = contractsOf(base);
  const out: string[] = [];
  for (const where of [...REPORTED_SETTINGS, "migrations.replay"].toSorted()) {
    const [name, key] = where.split(".") as [string, string];
    let before = asRecord(baseContracts[name])[key];
    let after = asRecord(headContracts[name])[key];
    let label = where;
    if (key === "replay") {
      before = asRecord(before).command;
      after = asRecord(after).command;
      label = "migrations.replay.command";
    }
    if (!same(before, after)) out.push(`${label}: ${show(before)} -> ${show(after)}`);
  }
  return out;
}
