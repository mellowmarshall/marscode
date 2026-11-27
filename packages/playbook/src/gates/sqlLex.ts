/**
 * Migration SQL lexer and static analyzers (PLAYBOOK §7, §8):
 * top-level comment markers (`-- destructive-ok #N`, `-- schema-ok #N`),
 * unguarded DELETE/UPDATE, destructive DDL, dynamic EXECUTE, hidden DDL, and mutations.
 */

const DOLLAR_RE = /\$([A-Za-z_\u0080-\uFFFF][A-Za-z0-9_\u0080-\uFFFF]*)?\$/y;
const WORDCHAR_END = /[A-Za-z0-9_\u0080-\uFFFF]$/;

export interface SqlToken {
  readonly kind: "line" | "block" | "string" | "ident" | "dollar" | "code";
  readonly text: string;
  readonly start: number;
  readonly tag: string;
}

/** Lex SQL text with Postgres nested block comments, E'' strings, "" idents, and $tag$ bodies. */
function lexSql(sql: string): ReadonlyArray<SqlToken> {
  const tokens: SqlToken[] = [];
  let code = "";
  let codeStart = 0;
  const flush = (at: number) => {
    if (code.length > 0) tokens.push({ kind: "code", text: code, start: codeStart, tag: "" });
    code = "";
    codeStart = at;
  };
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const two = sql.slice(i, i + 2);
    if (two === "--") {
      flush(i);
      const nl = sql.indexOf("\n", i);
      const stop = nl < 0 ? n : nl;
      tokens.push({ kind: "line", text: sql.slice(i, stop), start: i, tag: "" });
      i = stop;
      codeStart = i;
      continue;
    }
    if (two === "/*") {
      flush(i);
      let depth = 0;
      let j = i;
      while (j < n) {
        if (sql.startsWith("/*", j)) {
          depth += 1;
          j += 2;
        } else if (sql.startsWith("*/", j)) {
          depth -= 1;
          j += 2;
          if (depth === 0) break;
        } else {
          j += 1;
        }
      }
      tokens.push({ kind: "block", text: sql.slice(i, j), start: i, tag: "" });
      i = j;
      codeStart = i;
      continue;
    }
    const ch = sql[i]!;
    if (ch === "'") {
      const tail = code.slice(-2);
      const escaped = /[eE]$/.test(tail) && !/[A-Za-z0-9_][eE]$/.test(tail);
      flush(i);
      let j = i + 1;
      while (j < n) {
        if (escaped && sql[j] === "\\") j += 2;
        else if (sql[j] === "'" && sql[j + 1] === "'") j += 2;
        else if (sql[j] === "'") {
          j += 1;
          break;
        } else j += 1;
      }
      const tag = escaped || /[uU]&$/.test(tail) ? "E" : "";
      tokens.push({ kind: "string", text: sql.slice(i, j), start: i, tag });
      i = j;
      codeStart = i;
      continue;
    }
    if (ch === '"') {
      flush(i);
      let j = i + 1;
      while (j < n) {
        if (sql[j] === '"' && sql[j + 1] === '"') j += 2;
        else if (sql[j] === '"') {
          j += 1;
          break;
        } else j += 1;
      }
      tokens.push({ kind: "ident", text: sql.slice(i, j), start: i, tag: "" });
      i = j;
      codeStart = i;
      continue;
    }
    if (ch === "$" && !(code.length > 0 && WORDCHAR_END.test(code))) {
      DOLLAR_RE.lastIndex = i;
      const match = DOLLAR_RE.exec(sql);
      if (match) {
        flush(i);
        const tag = match[0];
        const close = sql.indexOf(tag, i + tag.length);
        const stop = close < 0 ? n : close + tag.length;
        tokens.push({ kind: "dollar", text: sql.slice(i, stop), start: i, tag });
        i = stop;
        codeStart = i;
        continue;
      }
    }
    if (code.length === 0) codeStart = i;
    code += ch;
    i += 1;
  }
  flush(i);
  return tokens;
}

/** Issue reference from a top-level `-- <name> #N` line comment, or null. */
export function markerIssue(sql: string, name: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^--\\s*${escaped}\\s+#([1-9][0-9]*)\\b`);
  for (const token of lexSql(sql)) {
    if (token.kind !== "line") continue;
    const match = re.exec(token.text.trim());
    if (match?.[1]) return `#${match[1]}`;
  }
  return null;
}

function dollarBody(token: SqlToken): string {
  return token.text.slice(token.tag.length, token.text.length - token.tag.length);
}

/** SQL with line and nested block comments replaced by spaces (preserving newlines). */
export function stripSqlComments(sql: string): string {
  return lexSql(sql)
    .map((t) => (t.kind === "line" || t.kind === "block" ? t.text.replace(/[^\n]/g, " ") : t.text))
    .join("");
}

function uncommented(sql: string): string {
  return stripSqlComments(sql);
}

function executableSql(sql: string, keepStrings = false): string {
  const out: string[] = [];
  for (const t of lexSql(sql)) {
    if (t.kind === "code" || t.kind === "ident") out.push(t.text);
    else if (t.kind === "string") out.push(keepStrings ? t.text : " ''");
    else if (t.kind === "dollar") out.push(`;\n${executableSql(dollarBody(t), keepStrings)}\n;`);
    else out.push(" ");
  }
  return out.join("");
}

function statementFrom(text: string, index: number): string {
  let depth = 0;
  for (let i = index; i < text.length; i += 1) {
    const ch = text[i]!;
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      if (depth === 0) return text.slice(index, i);
      depth -= 1;
    } else if (ch === ";" && depth === 0) {
      return text.slice(index, i);
    }
  }
  return text.slice(index);
}

function outerClauses(statement: string): string {
  let text = statement.replace(/'(?:[^']|'')*'/g, "''");
  for (;;) {
    const next = text.replace(/\([^()]*\)/g, " ");
    if (next === text) return text;
    text = next;
  }
}

const shortSql = (statement: string, width = 120) =>
  statement.replace(/\s+/g, " ").trim().slice(0, width);

const TRIVIAL_WHERE =
  /\bwhere\s+(?:\(\s*)?(?:true|1\s*=\s*1|not\s+false|''\s*=\s*'')(?:\s*\))?\s*(?:returning\b|$)/i;
const WRITES_RE =
  /\b(delete\s+from|update)\s+(?:only\s+)?((?:"[^"]+"|[a-z_][a-z0-9_$]*)(?:\.(?:"[^"]+"|[a-z_][a-z0-9_$]*))?)/gi;

function unguardedWrites(sql: string): ReadonlyArray<string> {
  const text = executableSql(sql, true);
  const found: string[] = [];
  for (const match of text.matchAll(WRITES_RE)) {
    const start = match.index ?? 0;
    const stmt = statementFrom(text, start);
    if (match[1]!.toLowerCase().startsWith("update")) {
      if (!/\bset\b/i.test(stmt)) continue;
      if (/\b(?:for|do|key)\s+$/i.test(text.slice(Math.max(0, start - 12), start))) continue;
    }
    const own = outerClauses(stmt);
    const trivial = TRIVIAL_WHERE.test(stmt.replace(/'(?:[^']|'')*'/g, "''").trim());
    if (/\bwhere\b/i.test(own) && !trivial) continue;
    found.push(shortSql(stmt));
  }
  return found;
}

const DROPPED =
  "table|schema|database|type|domain|extension|function|procedure|aggregate|view|materialized\\s+view|trigger|policy|owned|sequence|rule|cast|operator|publication|subscription|role|user|routine|collation|conversion|statistics|server|language|transform|access\\s+method|event\\s+trigger|text\\s+search|foreign\\s+(?:table|data\\s+wrapper)";

const DESTRUCTIVE_DDL: ReadonlyArray<readonly [RegExp, string]> = [
  [new RegExp(`\\bdrop\\s+(?:${DROPPED})\\b`, "gi"), "drops an object"],
  [
    /\balter\s+table\b[^;]*?\bdrop\s+(?!constraint\b|default\b|not\s+null\b|identity\b|expression\b|trigger\b)(?:column\s+)?/gi,
    "drops a column",
  ],
  [/\balter\s+(?:table|domain)\b[^;]*?\bdrop\s+constraint\b/gi, "drops a constraint"],
  [
    /\brename\s+(?:column\s+|constraint\s+|attribute\s+|value\s+)?(?:"[^"]+"|'[^']*'|[a-z_][a-z0-9_]*)\s+to\b|\brename\s+to\b/gi,
    "renames",
  ],
  [
    /\balter\s+(?:column\s+)?(?:"[^"]+"|[a-z_][a-z0-9_]*)\s+(?:set\s+data\s+)?type\b/gi,
    "changes a column type",
  ],
  [/\bset\s+not\s+null\b/gi, "sets NOT NULL on existing rows"],
  [/\btruncate\s+(?!on\b|or\b)(?:table\b|only\b|"|[a-z_])/gi, "truncates"],
  [
    /\bdisable\s+(?:trigger|rule|row\s+level\s+security)\b|\bno\s+force\s+row\s+level\s+security\b/gi,
    "disables a guard",
  ],
  [/\balter\s+type\b[^;]*?\bdrop\s+attribute\b/gi, "drops a type attribute"],
  [/\bmerge\s+into\b[^;]*?\bthen\s+delete\b/gi, "deletes through MERGE"],
];

const EXECUTE_RE =
  /\bexecute\s+(?!function\b|procedure\b)('(?:[^']|'')*'\s*(?=;|$|\binto\b|\busing\b|\bend\b))?/gi;

export function dynamicExecutes(sql: string): ReadonlyArray<string> {
  const text = executableSql(sql, true);
  const found: string[] = [];
  for (const match of text.matchAll(EXECUTE_RE)) {
    if (match[1] === undefined) {
      found.push(`dynamic EXECUTE: ${shortSql(statementFrom(text, match.index ?? 0))}`);
    }
  }
  return found;
}

const NAMES_RE =
  /\b(?:table|from|update|truncate|into|on|function|procedure|trigger|policy|view|type|domain|schema|extension|sequence)\s+(?:(?:only|table)\s+)*(?:if\s+exists\s+)?((?:"[^"]+"|[a-z_][a-z0-9_$]*)(?:\.(?:"[^"]+"|[a-z_][a-z0-9_$]*))?)/gi;
const SKIP_NAMES =
  /^(?:if|only|exists|select|set|table|row|each|statement|to|the|public|conflict|delete|update|insert|or|and|on|as|of|not|null|for|when|then|else|end|begin|execute|using|into|new|old|referencing|before|after|instead|truncate|cascade|restrict)$/i;

function namesInSql(statement: string): ReadonlyArray<string> {
  const out: string[] = [];
  for (const match of statement.matchAll(NAMES_RE)) {
    const name = match[1]!.replace(/"/g, "").replace(/^public\./i, "");
    if (!SKIP_NAMES.test(name)) out.push(name.toLowerCase());
  }
  return out;
}

export interface DestructiveFinding {
  readonly message: string;
  readonly objects: ReadonlyArray<string>;
}

export function destructiveStatements(sql: string): ReadonlyArray<DestructiveFinding> {
  const out: DestructiveFinding[] = [];
  for (const s of unguardedWrites(sql))
    out.push({ message: `no WHERE: ${s}`, objects: namesInSql(s) });
  const text = executableSql(sql, true);
  for (const [pattern, why] of DESTRUCTIVE_DDL) {
    for (const match of text.matchAll(pattern)) {
      const stmt = statementFrom(text, match.index ?? 0);
      out.push({ message: `${why}: ${shortSql(stmt)}`, objects: namesInSql(stmt) });
    }
  }
  for (const message of dynamicExecutes(sql)) out.push({ message, objects: [] });
  return out;
}

function collectDollarBodies(sql: string): string[] {
  const out: string[] = [];
  for (const token of lexSql(sql)) {
    if (token.kind !== "dollar") continue;
    const body = dollarBody(token);
    out.push(body);
    out.push(...collectDollarBodies(body));
  }
  return out;
}

export function hiddenSchemaCreation(sql: string): ReadonlyArray<string> {
  const found: string[] = [];
  for (const body of collectDollarBodies(sql)) {
    const text = executableSql(body, true);
    for (const m of text.matchAll(
      /\bcreate\s+(?!(?:global\s+|local\s+)?temp(?:orary)?\b)(?:unlogged\s+)?table\b/gi,
    )) {
      found.push(
        `creates a table in a dollar-quoted body: ${shortSql(statementFrom(text, m.index ?? 0), 100)}`,
      );
    }
    for (const m of text.matchAll(
      /\balter\s+table\b[^;]*?\badd\s+(?!constraint\b|primary\b|unique\b|foreign\b|check\b|exclude\b)/gi,
    )) {
      found.push(
        `adds a column in a dollar-quoted body: ${shortSql(statementFrom(text, m.index ?? 0), 100)}`,
      );
    }
  }
  const top = lexSql(sql)
    .map((t) =>
      t.kind === "code" || t.kind === "ident"
        ? t.text
        : t.kind === "string"
          ? " ''"
          : t.kind === "dollar"
            ? ";"
            : " ",
    )
    .join("");
  for (const m of top.matchAll(
    /\bselect\b[^;]*?\binto\s+(?!temp(?:orary)?\b)(?:unlogged\s+)?(?:table\s+)?("[^"]+"|[a-z_][a-z0-9_$.]*)/gi,
  )) {
    found.push(`SELECT INTO creates table ${m[1]}`);
  }
  return found;
}

const IDENT_SRC = '"[^"]+"|[a-zA-Z_][a-zA-Z0-9_$]*';
const QUALIFIED_SRC = `(?:(${IDENT_SRC})\\.)?(${IDENT_SRC})`;
const ELEMENT_KEYWORD = /^(?:constraint|primary|unique|foreign|check|exclude|like)$/i;

const unquoteIdent = (name: string) => (name.startsWith('"') ? name.slice(1, -1) : name);
const foldIdent = (name: string) => (name.startsWith('"') ? name.slice(1, -1) : name.toLowerCase());
const qualifiedTable = (schema: string | undefined, name: string) =>
  schema && foldIdent(schema) !== "public"
    ? `${foldIdent(schema)}.${foldIdent(name)}`
    : foldIdent(name);

export interface SqlMutation {
  readonly type: "add_column" | "create_table" | "drop_column" | "rename_column" | "drop_table";
  readonly table: string;
  readonly line: number;
  readonly column?: string | undefined;
  readonly raw?: string | undefined;
  readonly columns?: ReadonlyArray<readonly [string, string]> | undefined;
}

function listColumnItems(sql: string, openAt: number): string[] {
  const items: string[] = [];
  let depth = 0;
  let current = "";
  let quoted: string | null = null;
  for (let i = openAt; i < sql.length; i += 1) {
    const ch = sql[i]!;
    if (quoted) {
      current += ch;
      if (ch === quoted) quoted = null;
      continue;
    }
    if (ch === "'" || ch === '"') quoted = ch;
    if (ch === "(") {
      depth += 1;
      if (depth === 1) continue;
    }
    if (ch === ")") {
      depth -= 1;
      if (depth === 0) break;
    }
    if (ch === "," && depth === 1) {
      items.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) items.push(current.trim());
  return items;
}

export function sqlMutations(sql: string): ReadonlyArray<SqlMutation> {
  const clean = uncommented(sql);
  const lineAt = (offset: number) => clean.slice(0, offset).split("\n").length;
  const out: SqlMutation[] = [];

  const alterRe = new RegExp(
    `alter\\s+table\\s+(?:if\\s+exists\\s+)?(?:only\\s+)?${QUALIFIED_SRC}[\\s\\S]*?(?:;|$)`,
    "gi",
  );
  const addColRe = new RegExp(
    `\\badd\\s+(?:column\\s+)?(?:if\\s+not\\s+exists\\s+)?(${IDENT_SRC})`,
    "gi",
  );
  const dropColRe = new RegExp(`\\bdrop\\s+(?:column\\s+)?(if\\s+exists\\s+)?(${IDENT_SRC})`, "gi");
  const renameColRe = new RegExp(
    `\\brename\\s+(?:column\\s+)?(${IDENT_SRC})\\s+to\\s+(${IDENT_SRC})`,
    "gi",
  );

  for (const am of clean.matchAll(alterRe)) {
    const table = qualifiedTable(am[1], am[2]!);
    const body = am[0];
    const base = am.index ?? 0;
    for (const m of body.matchAll(addColRe)) {
      if (/^(?:constraint|primary|foreign|check|unique|index|exclude)$/i.test(m[1]!)) continue;
      out.push({
        type: "add_column",
        table,
        line: lineAt(base + (m.index ?? 0)),
        column: foldIdent(m[1]!),
        raw: unquoteIdent(m[1]!),
      });
    }
    for (const m of body.matchAll(dropColRe)) {
      if (/^(?:constraint|default|not|identity|expression|trigger)$/i.test(m[2]!)) continue;
      out.push({
        type: "drop_column",
        table,
        line: lineAt(base + (m.index ?? 0)),
        column: foldIdent(m[2]!),
      });
    }
    for (const m of body.matchAll(renameColRe)) {
      if (m[1]!.toLowerCase() === "constraint") continue;
      const line = lineAt(base + (m.index ?? 0));
      out.push({ type: "rename_column", table, line, column: foldIdent(m[1]!) });
      out.push({
        type: "add_column",
        table,
        line,
        column: foldIdent(m[2]!),
        raw: unquoteIdent(m[2]!),
      });
    }
  }

  const dropTableRe = new RegExp(
    `drop\\s+table\\s+(?:if\\s+exists\\s+)?((?:(?:${IDENT_SRC})(?:\\.(?:${IDENT_SRC}))?\\s*,\\s*)*(?:${IDENT_SRC})(?:\\.(?:${IDENT_SRC}))?)`,
    "gi",
  );
  const fullQualRe = new RegExp(`^${QUALIFIED_SRC}$`);
  for (const dm of clean.matchAll(dropTableRe)) {
    for (const part of dm[1]!.split(",")) {
      const qm = fullQualRe.exec(part.trim());
      if (qm)
        out.push({
          type: "drop_table",
          table: qualifiedTable(qm[1], qm[2]!),
          line: lineAt(dm.index ?? 0),
        });
    }
  }

  const createRe = new RegExp(
    `\\bcreate\\s+(?:(?:global|local)\\s+)?(?:(temp|temporary)\\s+)?(?:(virtual)\\s+)?(?:unlogged\\s+)?table\\s+(?:if\\s+not\\s+exists\\s+)?${QUALIFIED_SRC}(?:\\s+using\\s+[A-Za-z_][A-Za-z0-9_]*)?`,
    "gi",
  );
  const identStartRe = new RegExp(`^(${IDENT_SRC})`);
  for (const cm of clean.matchAll(createRe)) {
    if (cm[1] || (cm[3] && (foldIdent(cm[3]) === "temp" || foldIdent(cm[3]) === "pg_temp")))
      continue;
    const virtual = Boolean(cm[2]);
    const after = clean.slice((cm.index ?? 0) + cm[0].length);
    if (/^\s*partition\s+of\b/i.test(after)) continue;
    const cols: Array<readonly [string, string]> = [];
    if (/^\s*\(/.test(after)) {
      for (const item of listColumnItems(after, after.indexOf("("))) {
        if (virtual && (item.includes("=") || /^tokenize\s+/i.test(item))) continue;
        const nm = identStartRe.exec(item);
        if (nm && !ELEMENT_KEYWORD.test(nm[1]!))
          cols.push([foldIdent(nm[1]!), unquoteIdent(nm[1]!)]);
      }
    }
    out.push({
      type: "create_table",
      table: qualifiedTable(cm[3], cm[4]!),
      line: lineAt(cm.index ?? 0),
      columns: cols,
    });
  }
  return out;
}
