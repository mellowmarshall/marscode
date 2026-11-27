/**
 * DB dictionary closed concepts, roles, alias traps, canonical types, and concept loosenings
 * (PLAYBOOK §7). Domain seam extracted from `dictionaryGate.ts`.
 */
import { isRecord } from "../strictJson.ts";
import type { GateFinding } from "./findings.ts";

const GENERIC_WORDS = new Set(
  "user users type types status state id ids uuid name names data value values kind time date at on by of to the a an ref refs code key keys count amount flag info meta metadata item items record row text number label is has source target created updated".split(
    " ",
  ),
);
const CONCEPT_KEY_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const ROLE_RE = /^[a-z][a-z0-9_]*$/;
const ALIAS_RE = /^[a-z0-9]+( [a-z0-9]+)*$/;
const ISSUE_RE = /^#[1-9][0-9]*$/;
const TYPE_SYNONYMS: Readonly<Record<string, string>> = {
  "double precision": "float8",
  real: "float4",
  integer: "int4",
  int: "int4",
  bigint: "int8",
  smallint: "int2",
  boolean: "bool",
  "timestamp with time zone": "timestamptz",
  "timestamp without time zone": "timestamp",
  "character varying": "text",
  varchar: "text",
};

const canonicalType = (v: unknown) => {
  const s = String(v ?? "")
    .trim()
    .toLowerCase();
  return TYPE_SYNONYMS[s] ?? s;
};
const isRef = (c: unknown): c is string => typeof c === "string" && c.startsWith("ref:");
export const purposeOk = (v: unknown) =>
  typeof v === "string" && v.trim().length >= 5 && !/^\s*(?:TODO|FIXME)\b/i.test(v);

function nameWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function roleEntries(doc: Readonly<Record<string, unknown>>): ReadonlyArray<{
  readonly name: string;
  readonly approved: string | null;
}> {
  if (!Array.isArray(doc.roles)) return [];
  const out: Array<{ readonly name: string; readonly approved: string | null }> = [];
  for (const item of doc.roles) {
    if (typeof item === "string") out.push({ name: item, approved: null });
    else if (isRecord(item) && typeof item.name === "string") {
      out.push({
        name: item.name,
        approved: typeof item.approved === "string" ? item.approved : null,
      });
    }
  }
  return out;
}

export function validateConceptsAndRoles(
  doc: Readonly<Record<string, unknown>>,
  tables: Readonly<Record<string, unknown>>,
): string[] {
  const errors: string[] = [];
  if (!isRecord(doc.concepts)) {
    errors.push("dictionary: missing 'concepts' map (the closed list of column meanings).");
    return errors;
  }
  const owner = new Map<string, string>();
  for (const [key, rawC] of Object.entries(doc.concepts)) {
    const c = isRecord(rawC) ? rawC : {};
    if (!CONCEPT_KEY_RE.test(key)) {
      errors.push(`concept '${key}': name must be lowercase dotted words, like geo.latitude.`);
    }
    if (typeof c.purpose !== "string" || c.purpose.trim().length < 10) {
      errors.push(`concept '${key}': needs a purpose.`);
    }
    if (typeof c.canonicalType !== "string" || !c.canonicalType.trim()) {
      errors.push(`concept '${key}': needs a canonicalType.`);
    }
    if ("approved" in c && !ISSUE_RE.test(String(c.approved))) {
      errors.push(`concept '${key}': approved must be an issue like #123.`);
    }
    const extra = Object.keys(c).filter(
      (k) => !["purpose", "aliases", "canonicalType", "approved"].includes(k),
    );
    if (extra.length > 0) errors.push(`concept '${key}': unknown field ${extra.join(", ")}.`);
    if (!Array.isArray(c.aliases) || c.aliases.length === 0) {
      errors.push(`concept '${key}': needs at least one alias.`);
      continue;
    }
    for (const alias of c.aliases) {
      if (typeof alias !== "string" || !ALIAS_RE.test(alias)) {
        errors.push(
          `concept '${key}': alias '${String(alias)}' must be lowercase words separated by single spaces.`,
        );
      } else if (!alias.includes(" ") && GENERIC_WORDS.has(alias)) {
        errors.push(
          `concept '${key}': alias '${alias}' is a generic word; use a specific word sequence.`,
        );
      } else if (owner.has(alias) && owner.get(alias) !== key) {
        errors.push(`concept '${key}': alias '${alias}' already belongs to '${owner.get(alias)}'.`);
      } else {
        owner.set(alias, key);
      }
    }
  }
  if (!Array.isArray(doc.roles)) {
    errors.push("dictionary: 'roles' must be a list (the closed list a column's role comes from).");
  } else {
    const seen = new Set<string>();
    for (const item of doc.roles) {
      const name = isRecord(item) ? item.name : item;
      if (typeof name !== "string" || !ROLE_RE.test(name)) {
        errors.push(
          `dictionary: role ${JSON.stringify(item)} must be lowercase snake_case or {name, approved}.`,
        );
        continue;
      }
      if (isRecord(item)) {
        if ("approved" in item && !ISSUE_RE.test(String(item.approved))) {
          errors.push(`role '${name}': approved must be an issue like #123.`);
        }
        const extra = Object.keys(item).filter((k) => k !== "name" && k !== "approved");
        if (extra.length > 0) errors.push(`role '${name}': unknown field ${extra.join(", ")}.`);
      }
      if (seen.has(name)) errors.push(`role '${name}': listed twice.`);
      seen.add(name);
    }
  }
  const roleSet = new Set(roleEntries(doc).map((r) => r.name));
  const usedConcepts = new Set<string>();
  for (const [tname, raw] of Object.entries(tables)) {
    if (!isRecord(raw) || !isRecord(raw.columns)) continue;
    for (const [cname, rawCol] of Object.entries(raw.columns)) {
      const col = isRecord(rawCol) ? rawCol : {};
      const at = `${tname}.${cname}`;
      if (col.role !== undefined && (typeof col.role !== "string" || !ROLE_RE.test(col.role))) {
        errors.push(`${at}: role must be lowercase snake_case.`);
      }
      if (col.role !== undefined && col.concept === undefined)
        errors.push(`${at}: has a role but no concept.`);
      if (typeof col.role === "string" && !roleSet.has(col.role)) {
        errors.push(`${at}: role '${col.role}' is not in the roles list.`);
      }
      if (col.concept === undefined) continue;
      const refs = isRecord(col.references) ? col.references : null;
      if (isRef(col.concept)) {
        const target = col.concept.slice(4);
        if (refs && refs.table !== target) {
          errors.push(
            `${at}: references ${String(refs.table)}, so its concept is ref:${String(refs.table)}, not ${col.concept}.`,
          );
        } else if (!(target in tables)) {
          errors.push(`${at}: concept ${col.concept} names a table the dictionary does not have.`);
        }
      } else if (!(String(col.concept) in doc.concepts)) {
        errors.push(`${at}: concept '${String(col.concept)}' is not in the concepts list.`);
      } else {
        usedConcepts.add(String(col.concept));
      }
      if (refs && !isRef(col.concept))
        errors.push(`${at}: a foreign key's concept is ref:${String(refs.table)}.`);
    }
  }
  for (const key of Object.keys(doc.concepts)) {
    if (!usedConcepts.has(key)) {
      errors.push(`concept '${key}': no column holds it; a closed list has no unused entries.`);
    }
  }
  return errors;
}

function aliasTraps(
  doc: Readonly<Record<string, unknown>>,
  colName: string,
  declared: unknown,
): ReadonlyArray<readonly [string, string]> {
  const words = nameWords(colName);
  const concepts = isRecord(doc.concepts) ? doc.concepts : {};
  const sameWord = (part: string, word: string) =>
    part === word ||
    part === word.replace(/[0-9]+$/, "") ||
    `${part}s` === word ||
    `${part}es` === word;
  const spans: Array<{
    readonly start: number;
    readonly end: number;
    readonly alias: string;
    readonly concept: string;
  }> = [];
  for (const [concept, def] of Object.entries(concepts)) {
    if (!isRecord(def) || !Array.isArray(def.aliases)) continue;
    for (const rawAlias of def.aliases) {
      const alias = String(rawAlias);
      const parts = alias.split(" ");
      for (let i = 0; i <= words.length - parts.length; i += 1) {
        if (parts.every((p, j) => sameWord(p, words[i + j]!))) {
          spans.push({ start: i, end: i + parts.length, alias, concept });
        }
      }
    }
  }
  const own = spans.filter((s) => s.concept === declared);
  const best = new Map<string, string>();
  for (const s of spans) {
    if (s.concept === declared) continue;
    if (own.some((o) => o.start <= s.start && s.end <= o.end && o.end - o.start > s.end - s.start))
      continue;
    const prev = best.get(s.concept);
    if (!prev || s.alias.length > prev.length) best.set(s.concept, s.alias);
  }
  return [...best.entries()].map(([concept, alias]) => [alias, concept] as const);
}

export function collectDictionaryFindings(
  doc: Readonly<Record<string, unknown>>,
): ReadonlyArray<GateFinding> {
  const out: GateFinding[] = [];
  const tables = isRecord(doc.tables) ? doc.tables : {};
  const concepts = isRecord(doc.concepts) ? doc.concepts : {};
  for (const [tname, raw] of Object.entries(tables)) {
    if (!isRecord(raw)) continue;
    if (!purposeOk(raw.purpose)) {
      out.push({
        rule: "dict/no-purpose",
        file: tname,
        text: tname,
        message: "has no purpose; say what the table holds",
      });
    }
    const cols = isRecord(raw.columns) ? raw.columns : {};
    const byMeaning = new Map<string, string[]>();
    for (const [cname, rawCol] of Object.entries(cols)) {
      const col = isRecord(rawCol) ? rawCol : {};
      const at = `${tname}.${cname}`;
      if (!purposeOk(col.purpose)) {
        out.push({
          rule: "dict/no-purpose",
          file: at,
          text: at,
          message: "has no purpose; say what the column holds",
        });
      }
      const concept = col.concept;
      if (concept === undefined) {
        out.push({
          rule: "dict/no-concept",
          file: at,
          text: at,
          message: "has no concept; give it one from the concepts list",
        });
        continue;
      }
      for (const [alias, hit] of aliasTraps(doc, cname, concept)) {
        out.push({
          rule: "dict/alias-trap",
          file: at,
          text: `${at} ${alias} ${String(concept)}`,
          message: `name holds '${alias}', an alias of ${hit}, but declares ${String(concept)}`,
        });
      }
      let expectedType: unknown;
      if (isRef(concept)) {
        const targetRaw = tables[concept.slice(4)];
        const target = isRecord(targetRaw) ? targetRaw : null;
        const targetCols = target && isRecord(target.columns) ? target.columns : {};
        const refs = isRecord(col.references) ? col.references : null;
        const pk = target && Array.isArray(target.primaryKey) ? target.primaryKey : [];
        const key =
          typeof refs?.column === "string" ? refs.column : pk.length === 1 ? String(pk[0]) : null;
        const keyCol = key ? targetCols[key] : undefined;
        expectedType = isRecord(keyCol) ? keyCol.type : undefined;
      } else {
        const def = concepts[String(concept)];
        expectedType = isRecord(def) ? def.canonicalType : undefined;
      }
      if (expectedType !== undefined && canonicalType(expectedType) !== canonicalType(col.type)) {
        out.push({
          rule: "dict/canonical-type",
          file: at,
          text: `${at} ${String(concept)} ${String(col.type)}`,
          message: `is ${String(col.type)}, but ${String(concept)} is ${canonicalType(expectedType)}`,
        });
      }
      if (isRef(concept)) continue;
      const meaning = `${String(concept)}${typeof col.role === "string" ? ` role ${col.role}` : ""}`;
      const list = byMeaning.get(meaning);
      if (list) list.push(cname);
      else byMeaning.set(meaning, [cname]);
    }
    for (const [meaning, list] of byMeaning) {
      for (const extra of list.slice(1)) {
        out.push({
          rule: "dict/same-concept",
          file: `${tname}.${extra}`,
          text: `${tname} ${meaning}`,
          message: `holds ${meaning}, which ${tname}.${list[0]} already holds`,
        });
      }
    }
  }
  return out;
}

export function conceptLoosenings(
  head: Readonly<Record<string, unknown>>,
  base: Readonly<Record<string, unknown>>,
): { readonly unapproved: string[]; readonly loosenings: string[] } {
  const unapproved: string[] = [];
  const loosenings: string[] = [];
  const headConcepts = isRecord(head.concepts) ? head.concepts : {};
  const baseConcepts = isRecord(base.concepts) ? base.concepts : {};
  for (const [key, raw] of Object.entries(headConcepts)) {
    if (!(key in baseConcepts) && !(isRecord(raw) && typeof raw.approved === "string")) {
      unapproved.push(`concept '${key}' is new; add "approved": "#N" naming the approval issue`);
    }
  }
  const baseRoles = new Set(roleEntries(base).map((r) => r.name));
  for (const role of roleEntries(head)) {
    if (!baseRoles.has(role.name) && !role.approved) {
      unapproved.push(
        `role '${role.name}' is new; write {"name": "${role.name}", "approved": "#N"}`,
      );
    }
  }
  for (const [key, before] of Object.entries(baseConcepts)) {
    if (!isRecord(before)) continue;
    const now = headConcepts[key];
    if (!isRecord(now)) {
      loosenings.push(`concept '${key}' removed`);
      continue;
    }
    const nowAliases = new Set(Array.isArray(now.aliases) ? now.aliases.map(String) : []);
    for (const alias of Array.isArray(before.aliases) ? before.aliases.map(String) : []) {
      if (!nowAliases.has(alias)) loosenings.push(`concept '${key}': alias '${alias}' removed`);
    }
    if (canonicalType(now.canonicalType) !== canonicalType(before.canonicalType)) {
      loosenings.push(
        `concept '${key}': canonicalType ${String(before.canonicalType)} -> ${String(now.canonicalType)}`,
      );
    }
  }
  return { unapproved, loosenings };
}
