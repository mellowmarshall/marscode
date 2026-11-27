/**
 * `playbook check dictionary`: the DB dictionary (PLAYBOOK §7).
 * Validates tables, columns, nullable/volume/protection metadata, boilerplate ratchets,
 * concepts/roles (via `dictionaryConcepts.ts`), findings against Baseline, and new migrations.
 */
import type { BaselineEntry } from "../baseline.ts";
import { changedFiles, readWorktreeFile, showFile } from "../git.ts";
import { failed, passed, type CheckResult } from "../result.ts";
import { isRecord, parseStrictJson } from "../strictJson.ts";
import {
  collectDictionaryFindings,
  conceptLoosenings,
  purposeOk,
  validateConceptsAndRoles,
} from "./dictionaryConcepts.ts";
import { judgeFindings } from "./findings.ts";
import { hiddenSchemaCreation, markerIssue, sqlMutations } from "./sqlLex.ts";

const CHECK = "dictionary";
const TIERS = new Set(["content", "member_state", "operational"]);
const PROTECTED = new Set(["content", "member_state"]);
const VOLUMES = new Set(["small", "large", "huge"]);
const BOILERPLATE_TABLE = /^Persistent storage and domain state for\b/i;
const BOILERPLATE_COLUMN =
  /^(?:Specifies\s+.*?\s+for\s+.*?\.|Primary unique identifier for .*? record\.|Timestamp when .*? occurred\.)$/i;

const hasWhy = (v: unknown) => typeof v === "string" && v.trim().length >= 5;

export function protectedTables(doc: Readonly<Record<string, unknown>>): ReadonlyArray<string> {
  const tables = isRecord(doc.tables) ? doc.tables : {};
  return Object.entries(tables)
    .filter(
      ([, t]) => isRecord(t) && isRecord(t.protection) && PROTECTED.has(String(t.protection.tier)),
    )
    .map(([name]) => name)
    .toSorted();
}

export function memberReferencedTables(
  doc: Readonly<Record<string, unknown>>,
): ReadonlySet<string> {
  const tables = isRecord(doc.tables) ? doc.tables : {};
  const initial = protectedTables(doc);
  const names = new Set(initial);
  for (const name of initial) {
    const t = tables[name];
    if (!isRecord(t) || !isRecord(t.columns)) continue;
    for (const col of Object.values(t.columns)) {
      if (isRecord(col) && isRecord(col.references) && typeof col.references.table === "string") {
        names.add(col.references.table);
      }
    }
  }
  return names;
}

function validateProtection(doc: Readonly<Record<string, unknown>>): string[] {
  const tables = isRecord(doc.tables) ? doc.tables : {};
  const errors: string[] = [];
  const owned = (name: string) => {
    const t = tables[name];
    const p = isRecord(t) && isRecord(t.protection) ? t.protection : null;
    return p && PROTECTED.has(String(p.tier)) && typeof p.owner === "string" ? p.owner : null;
  };
  for (const [name, raw] of Object.entries(tables)) {
    const table = isRecord(raw) ? raw : {};
    const p = table.protection;
    const cols = isRecord(table.columns) ? table.columns : {};
    if (!isRecord(p)) {
      errors.push(
        `Table '${name}' declares no protection tier (content, member_state or operational).`,
      );
      continue;
    }
    const tier = String(p.tier ?? "");
    if (!TIERS.has(tier)) {
      errors.push(`Table '${name}' has unknown protection tier '${tier}'.`);
      continue;
    }
    if (PROTECTED.has(tier)) {
      if (!("owner" in p) || (p.owner !== null && !(String(p.owner) in cols))) {
        errors.push(
          `Table '${name}' names owner column '${String(p.owner)}', which it does not have.`,
        );
      }
      if (!hasWhy(p.why)) errors.push(`Table '${name}' is ${tier} but does not say why.`);
      if ("guardDeletes" in p && typeof p.guardDeletes !== "boolean") {
        errors.push(`Table '${name}' has a non-boolean guardDeletes.`);
      }
      if (!Array.isArray(table.primaryKey) || table.primaryKey.length === 0) {
        errors.push(`Table '${name}' is ${tier} but has no primary key to name its rows by.`);
      }
      if (p.owner === null) {
        const via = Array.isArray(p.ownerVia) ? p.ownerVia : [];
        if (via.length === 0) {
          errors.push(
            `Table '${name}' has no owner column and no ownerVia saying how its members are found.`,
          );
        }
        for (const entry of via) {
          if (isRecord(entry) && typeof entry.column === "string") {
            const rawCol = cols[entry.column];
            const col = isRecord(rawCol) ? rawCol : null;
            const ref = col && isRecord(col.references) ? col.references : null;
            const refTable = ref && typeof ref.table === "string" ? ref.table : "";
            if (!ref || !owned(refTable)) {
              errors.push(
                `Table '${name}' ownerVia: ${entry.column} does not reference a protected table with an owner`,
              );
            }
          } else if (isRecord(entry) && typeof entry.child === "string") {
            const [child = "", column = ""] = entry.child.split(".", 2);
            const rawChild = tables[child];
            const childTable = isRecord(rawChild) ? rawChild : null;
            const childCols = childTable && isRecord(childTable.columns) ? childTable.columns : {};
            const rawCol = childCols[column];
            const col = isRecord(rawCol) ? rawCol : null;
            const ref = col && isRecord(col.references) ? col.references : null;
            if (!ref || ref.table !== name || !owned(child)) {
              errors.push(
                `Table '${name}' ownerVia: ${entry.child} is not a protected child with an owner referencing ${name}`,
              );
            }
          } else {
            errors.push(`Table '${name}' ownerVia: each entry names a column or a child`);
          }
        }
      }
    }
    if (typeof p.agentRead !== "boolean") {
      errors.push(
        `Table '${name}' does not say whether the agent role may read it (agentRead true or false).`,
      );
    } else if (!p.agentRead && !hasWhy(p.agentReadWhy)) {
      errors.push(`Table '${name}' hides itself from the agent role but does not say why.`);
    }
    for (const [cname, rawCol] of Object.entries(cols)) {
      const col = isRecord(rawCol) ? rawCol : {};
      if ("protection" in col && !TIERS.has(String(col.protection))) {
        errors.push(`${name}.${cname} has unknown protection tier '${String(col.protection)}'.`);
      }
      if ("agentRead" in col) {
        if (col.agentRead !== false || p.agentRead !== true) {
          errors.push(
            `${name}.${cname}: a column may only set agentRead to false, on a table the agent reads.`,
          );
        } else if (!hasWhy(col.agentReadWhy)) {
          errors.push(`${name}.${cname} hides itself from the agent role but does not say why.`);
        }
      }
    }
  }
  return errors;
}

function validateStructure(doc: Readonly<Record<string, unknown>>): string[] {
  if (!isRecord(doc.tables)) return ["the dictionary has no 'tables' map"];
  const errors: string[] = [];
  let totalCols = 0;
  let boilerT = 0;
  let boilerC = 0;
  for (const [tname, raw] of Object.entries(doc.tables)) {
    if (!isRecord(raw)) {
      errors.push(`table '${tname}' is not an object`);
      continue;
    }
    if (typeof raw.purpose === "string" && BOILERPLATE_TABLE.test(raw.purpose.trim())) boilerT += 1;
    if ("volume" in raw && !VOLUMES.has(String(raw.volume))) {
      errors.push(`table '${tname}' has volume '${String(raw.volume)}'; one of small, large, huge`);
    }
    if (!isRecord(raw.columns)) {
      errors.push(`table '${tname}' has no 'columns' map`);
      continue;
    }
    for (const [cname, rawCol] of Object.entries(raw.columns)) {
      totalCols += 1;
      const col = isRecord(rawCol) ? rawCol : {};
      if (typeof col.type !== "string") errors.push(`${tname}.${cname}: missing type`);
      if (typeof col.nullable !== "boolean")
        errors.push(`${tname}.${cname}: missing boolean 'nullable' property`);
      if (typeof col.purpose === "string" && BOILERPLATE_COLUMN.test(col.purpose.trim()))
        boilerC += 1;
    }
  }
  if ("tableCount" in doc && doc.tableCount !== Object.keys(doc.tables).length) {
    errors.push(
      `tableCount metadata mismatch: declared ${String(doc.tableCount)}, found ${Object.keys(doc.tables).length}`,
    );
  }
  if ("columnCount" in doc && doc.columnCount !== totalCols) {
    errors.push(
      `columnCount metadata mismatch: declared ${String(doc.columnCount)}, found ${totalCols}`,
    );
  }
  if (typeof doc.maxBoilerplateTables === "number" && boilerT > doc.maxBoilerplateTables) {
    errors.push(
      `boilerplate table ratchet exceeded: found ${boilerT}, max ${doc.maxBoilerplateTables}`,
    );
  }
  if (typeof doc.maxBoilerplateColumns === "number" && boilerC > doc.maxBoilerplateColumns) {
    errors.push(
      `boilerplate column ratchet exceeded: found ${boilerC}, max ${doc.maxBoilerplateColumns}`,
    );
  }
  errors.push(...validateProtection(doc));
  errors.push(...validateConceptsAndRoles(doc, doc.tables));
  return errors;
}

export async function dictionaryGate(input: {
  readonly root: string;
  readonly settings: Readonly<Record<string, unknown>>;
  readonly declaration: Readonly<Record<string, unknown>>;
  readonly entries: ReadonlyArray<BaselineEntry>;
  readonly base: string | null;
  readonly ask: (reason: string) => Promise<boolean>;
}): Promise<ReadonlyArray<CheckResult>> {
  const file = input.settings.file;
  if (typeof file !== "string" || !file.trim()) {
    return [
      failed(CHECK, "contracts.dictionary.file is not declared", { files: ["playbook.json"] }),
    ];
  }
  const text = readWorktreeFile(input.root, file);
  if (text === null) {
    return [failed(CHECK, `${file} cannot be read`, { files: [file], fix: `create ${file}` })];
  }
  let parsed: unknown;
  try {
    parsed = parseStrictJson(text);
  } catch (cause) {
    return [
      failed(
        CHECK,
        `${file} is not valid strict JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
        {
          files: [file],
        },
      ),
    ];
  }
  if (!isRecord(parsed)) {
    return [failed(CHECK, `${file} must be a JSON object`, { files: [file] })];
  }
  const structErrors = validateStructure(parsed);
  if (structErrors.length > 0) {
    return [
      failed(CHECK, `${structErrors.length} structure error(s) in ${file}`, {
        errors: structErrors,
        files: [file],
      }),
    ];
  }

  const fails: string[] = [];
  const contracts = isRecord(input.declaration.contracts) ? input.declaration.contracts : {};
  const mig = isRecord(contracts.migrations) ? contracts.migrations : {};
  const migDir = typeof mig.dir === "string" ? mig.dir.replace(/\/+$/, "") : null;
  if (input.base && migDir) {
    const added = (changedFiles(input.root, input.base, "HEAD") ?? []).filter(
      (c) => c.status === "A" && c.path.startsWith(`${migDir}/`) && c.path.endsWith(".sql"),
    );
    const tables = isRecord(parsed.tables) ? parsed.tables : {};
    for (const item of added) {
      const sql = readWorktreeFile(input.root, item.path);
      if (sql === null) {
        fails.push(`${item.path}: cannot be read (missing or symlink outside repo)`);
        continue;
      }
      const muts = sqlMutations(sql);
      const readded = new Set(
        muts.flatMap((m) =>
          m.type === "add_column" && m.column
            ? [`${m.table}.${m.column}`]
            : m.type === "create_table"
              ? [m.table]
              : [],
        ),
      );
      for (const m of muts) {
        const rawEntry = tables[m.table];
        const entry = isRecord(rawEntry) ? rawEntry : null;
        const cols = entry && isRecord(entry.columns) ? entry.columns : {};
        if (
          (m.type === "drop_column" || m.type === "rename_column") &&
          m.column &&
          !readded.has(`${m.table}.${m.column}`) &&
          m.column in cols
        ) {
          fails.push(
            `${item.path}:${m.line}: drops/renames ${m.table}.${m.column}, but the dictionary still lists it`,
          );
        } else if (m.type === "drop_table" && !readded.has(m.table) && m.table in tables) {
          fails.push(
            `${item.path}:${m.line}: drops table ${m.table}, but the dictionary still lists it`,
          );
        } else if (m.type === "add_column" && m.column) {
          const rawCol = cols[m.column];
          const col = isRecord(rawCol) ? rawCol : null;
          if (!entry)
            fails.push(
              `${item.path}:${m.line}: adds ${m.table}.${m.column}, but table ${m.table} is not in the dictionary`,
            );
          else if (!col || !purposeOk(col.purpose)) {
            fails.push(
              `${item.path}:${m.line}: adds ${m.table}.${m.column}, but the dictionary has no entry with a purpose`,
            );
          } else if (
            typeof col.purpose === "string" &&
            BOILERPLATE_COLUMN.test(col.purpose.trim())
          ) {
            fails.push(
              `${item.path}:${m.line}: newly added column ${m.table}.${m.column} has a boilerplate purpose`,
            );
          }
        } else if (m.type === "create_table") {
          if (!entry || !purposeOk(entry.purpose)) {
            fails.push(
              `${item.path}:${m.line}: creates table ${m.table}, but the dictionary has no entry with a purpose`,
            );
          } else if (
            typeof entry.purpose === "string" &&
            BOILERPLATE_TABLE.test(entry.purpose.trim())
          ) {
            fails.push(
              `${item.path}:${m.line}: newly created table ${m.table} has a boilerplate purpose`,
            );
          }
          for (const [cname] of m.columns ?? []) {
            const rawCol = cols[cname];
            const col = isRecord(rawCol) ? rawCol : null;
            if (entry && (!col || !purposeOk(col.purpose))) {
              fails.push(
                `${item.path}:${m.line}: column ${m.table}.${cname} has no dictionary purpose`,
              );
            }
          }
        }
      }
      const created = muts.filter((m) => m.type === "add_column" || m.type === "create_table");
      const hidden = hiddenSchemaCreation(sql);
      if ((created.length > 0 || hidden.length > 0) && !markerIssue(sql, "schema-ok")) {
        for (const h of hidden) fails.push(`${item.path}: ${h}, without -- schema-ok #N`);
        for (const m of created) {
          const what =
            m.type === "add_column"
              ? `adds column ${m.table}.${m.column}`
              : `creates table ${m.table}`;
          fails.push(`${item.path}:${m.line}: ${what} without -- schema-ok #<issue>`);
        }
      }
    }
  }

  if (input.base) {
    const baseText = showFile(input.root, input.base, file);
    if (baseText) {
      try {
        const baseDoc = parseStrictJson(baseText);
        if (isRecord(baseDoc)) {
          const diff = conceptLoosenings(parsed, baseDoc);
          fails.push(...diff.unapproved);
          if (diff.loosenings.length > 0) {
            const reason = `dictionary concepts: ${diff.loosenings.join("; ").slice(0, 360)}`;
            if (!(await input.ask(reason))) {
              fails.push(...diff.loosenings);
            }
          }
        }
      } catch {
        // invalid base dictionary is treated as adoption
      }
    }
  }

  const findings = collectDictionaryFindings(parsed);
  const baselinePath = typeof input.settings.baseline === "string" ? input.settings.baseline : null;
  const judged = judgeFindings(findings, input.entries, { baselinePath });
  fails.push(...judged.problems);

  if (fails.length > 0) {
    return [
      failed(CHECK, `${fails.length} dictionary problem(s) in ${file}`, {
        errors: fails,
        files: [file],
        fix: `update ${file} or baseline existing debt in contracts.dictionary.baseline`,
      }),
    ];
  }
  const tableCount = Object.keys(isRecord(parsed.tables) ? parsed.tables : {}).length;
  return [passed(CHECK, `${tableCount} table(s) valid in ${file}`)];
}
