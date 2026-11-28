/**
 * `playbook db-dict <term>` (PLAYBOOK §7): an agent finds the existing column before it
 * adds one. It searches the declared dictionary's concepts (key, purpose, aliases),
 * tables and columns (name, purpose, concept), and prints what holds each concept.
 * Exit 0 with matches, 1 with none, 2 with no dictionary declared.
 */
import { contractSettings, loadDeclaration } from "./declaration.ts";
import { readWorktreeFile } from "./git.ts";
import { EXIT_FAIL, EXIT_USAGE } from "./result.ts";
import { isRecord } from "./strictJson.ts";

type Json = Readonly<Record<string, unknown>>;

const asRecord = (v: unknown): Json => (isRecord(v) ? v : {});

/** Python's str() of a JSON value, so a line reads as the original printed it. */
function pyStr(v: unknown): string {
  if (v === null || v === undefined) return "None";
  if (typeof v === "boolean") return v ? "True" : "False";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/** The value of KEY, or FALLBACK when the key is absent (an explicit null stays null). */
function get(obj: Json, key: string, fallback: unknown): unknown {
  return key in obj ? obj[key] : fallback;
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.map(pyStr) : [];
}

/** Every column that holds CONCEPT, with its role. */
function holders(tables: Json, concept: string): string[] {
  const out: string[] = [];
  for (const [tname, table] of Object.entries(tables)) {
    for (const [cname, col] of Object.entries(asRecord(asRecord(table).columns))) {
      if (!isRecord(col) || col.concept !== concept) continue;
      out.push(`${tname}.${cname}${col.role ? ` (role ${pyStr(col.role)})` : ""}`);
    }
  }
  return out;
}

/** The concepts, tables and columns whose name or purpose holds TERM. */
function dictionaryLookup(dictionary: Json, term: string): string[] {
  const t = term.toLowerCase().trim();
  const lines: string[] = [];
  const tables = asRecord(dictionary.tables);
  for (const [key, raw] of Object.entries(asRecord(dictionary.concepts))) {
    const c = asRecord(raw);
    const aliases = strings(c.aliases);
    const hay = [key, pyStr(get(c, "purpose", "")), aliases.join(" ")].join(" ").toLowerCase();
    if (!hay.includes(t)) continue;
    const held = holders(tables, key);
    lines.push(
      `concept ${key} (${pyStr(c.canonicalType)}): ${pyStr(c.purpose)} aliases: ${aliases.join(", ")}; ` +
        `${held.length} column(s): ${held.slice(0, 8).join(", ")}${held.length > 8 ? " ..." : ""}`,
    );
  }
  for (const [tname, rawTable] of Object.entries(tables)) {
    const table = asRecord(rawTable);
    const purpose = pyStr(get(table, "purpose", ""));
    if (tname.toLowerCase().includes(t) || purpose.toLowerCase().includes(t)) {
      lines.push(`table ${tname}: ${purpose}`);
    }
    for (const [cname, rawCol] of Object.entries(asRecord(table.columns))) {
      const col = asRecord(rawCol);
      const colPurpose = pyStr(get(col, "purpose", ""));
      if (
        cname.toLowerCase().includes(t) ||
        colPurpose.toLowerCase().includes(t) ||
        pyStr(get(col, "concept", ""))
          .toLowerCase()
          .includes(t)
      ) {
        lines.push(
          `column ${tname}.${cname} ${pyStr(get(col, "type", "?"))} concept=${pyStr(get(col, "concept", "-"))}: ${colPurpose}`,
        );
      }
    }
  }
  return lines;
}

interface Io {
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
}

export function cmdDbDict(root: string, args: ReadonlyArray<string>, io: Io): number {
  const term = args.find((a) => !a.startsWith("-"));
  if (term === undefined || args.length !== 1) {
    io.err(
      term === undefined
        ? "playbook db-dict: error: the following arguments are required: term"
        : `playbook db-dict: error: unrecognized arguments: ${args.filter((a) => a !== term).join(" ")}`,
    );
    return EXIT_USAGE;
  }
  const path = contractSettings(loadDeclaration(root).data, "dictionary").file;
  if (typeof path !== "string" || !path) {
    io.err("playbook db-dict: playbook.json declares no dictionary (contracts.dictionary.file)");
    return EXIT_USAGE;
  }
  const text = readWorktreeFile(root, path);
  let data: unknown;
  try {
    if (text === null) throw new Error("no such file");
    data = JSON.parse(text);
  } catch (cause) {
    io.err(
      `playbook db-dict: ${path} cannot be read: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    return EXIT_USAGE;
  }
  const lines = dictionaryLookup(asRecord(data), term);
  for (const line of lines) io.out(line);
  if (lines.length === 0) {
    io.out(
      `playbook db-dict: nothing in ${path} names '${term}'; a new column needs a concept (-- schema-ok #N)`,
    );
    return EXIT_FAIL;
  }
  return 0;
}
