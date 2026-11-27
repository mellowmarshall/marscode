/**
 * `playbook check migrations`: migration history immutability, runner naming/ordering,
 * migrator list parity, destructive SQL markers, protection guards, and declared lint (PLAYBOOK §8).
 */
import { hashWorktreeFiles, listedFiles, readWorktreeFile, treeBlobs } from "../git.ts";
import { failed, passed, unproven, type CheckResult } from "../result.ts";
import { runStep, tailLines } from "../steps.ts";
import { isRecord, parseStrictJson } from "../strictJson.ts";
import { memberReferencedTables, protectedTables } from "./dictionaryGate.ts";
import { destructiveStatements, dynamicExecutes, markerIssue, stripSqlComments } from "./sqlLex.ts";

const CHECK = "migrations";
const NAMING: Readonly<Record<string, RegExp>> = {
  prisma: /^\d{14}_[A-Za-z0-9_]+\/migration\.sql$/,
  drizzle: /^\d{4}_[A-Za-z0-9_]+\.sql$/,
  raw: /^\d+_[A-Za-z0-9_.-]+\.sql$/,
  sqlx: /^\d+_[A-Za-z0-9_]+(?:\.up|\.down)?\.sql$/,
  flyway: /^[VRU]\d+(?:[._]\d+)*__[A-Za-z0-9_]+\.sql$/,
};
const DEFAULT_NAMING = /^\d+_[A-Za-z0-9_.-]+$/;
const TEXT_SORTED = new Set(["raw", "sqlx", "drizzle", "prisma"]);
const REGEX_CHECK_RE = /\bcheck\s*\([^;]*?(?:~|\bsimilar\s+to\b|\bregexp\b)/gi;

function migrationKeys(keys: ReadonlyMap<string, string>, migrator: string): string[] {
  const list = [...keys.keys()];
  if (migrator === "prisma")
    return list.filter((k) => /^[^/]+\/migration\.sql$/.test(k)).toSorted();
  if (["raw", "sqlx", "flyway", "drizzle"].includes(migrator)) {
    return list.filter((k) => !k.includes("/") && k.endsWith(".sql")).toSorted();
  }
  if (migrator === "alembic") {
    return list
      .filter(
        (k) =>
          !k.includes("/") && k.endsWith(".py") && !k.startsWith("__init__") && !k.startsWith(".#"),
      )
      .toSorted();
  }
  return list.filter((k) => !k.includes("/") && !k.startsWith(".")).toSorted();
}

function strayKeys(keys: ReadonlyMap<string, string>, migrator: string): string[] {
  const list = [...keys.keys()];
  if (migrator === "prisma") {
    return list
      .filter((k) => k !== "migration_lock.toml" && !/^[^/]+\/migration\.sql$/.test(k))
      .toSorted();
  }
  if (["raw", "sqlx", "flyway"].includes(migrator)) {
    return list.filter((k) => !k.endsWith(".sql") && !k.startsWith(".")).toSorted();
  }
  return [];
}

function namingProblems(key: string, migrator: string, last: string): string[] {
  const pattern = NAMING[migrator] ?? DEFAULT_NAMING;
  if (!pattern.test(key)) {
    return [`a new ${migrator} migration must match ${pattern.source} (its runner's naming)`];
  }
  const width = /^\d*/.exec(last)?.[0].length ?? 0;
  if (width > 0 && (TEXT_SORTED.has(migrator) || !(migrator in NAMING))) {
    const prefix = /^\d*/.exec(key)?.[0].length ?? 0;
    if (prefix !== width) {
      return [
        `a new migration's name opens with a ${width}-digit number, as ${last} does; the runner sorts names as text`,
      ];
    }
  }
  return [];
}

function judgeMigratorList(
  root: string,
  listedPath: string | null,
  tree: ReadonlyMap<string, string>,
  migrator: string,
  mdir: string,
): string[] {
  if (!listedPath) return [];
  const text = readWorktreeFile(root, listedPath);
  if (text === null) return [`${listedPath}: the migrator's list cannot be read`];
  let journal: unknown;
  try {
    journal = parseStrictJson(text);
  } catch (cause) {
    return [
      `${listedPath}: the migrator's list cannot be parsed (${cause instanceof Error ? cause.message : String(cause)})`,
    ];
  }
  const files = migrationKeys(tree, migrator);
  if (isRecord(journal) && "entries" in journal) {
    if (!Array.isArray(journal.entries)) return [`${listedPath}: 'entries' must be a JSON list`];
    const tags: string[] = [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const entry of journal.entries) {
      const rawTag = isRecord(entry) && typeof entry.tag === "string" ? entry.tag.trim() : "";
      if (!rawTag)
        return [`${listedPath}: every entry in 'entries' must have a non-empty string 'tag'`];
      const tag = rawTag.endsWith(".sql") ? rawTag.slice(0, -4) : rawTag;
      if (seen.has(tag)) out.push(`${mdir}/${tag}.sql: listed more than once in ${listedPath}`);
      else {
        seen.add(tag);
        tags.push(tag);
      }
    }
    const fileSet = new Set(files.map((k) => (k.endsWith(".sql") ? k.slice(0, -4) : k)));
    for (const tag of tags) {
      if (!fileSet.has(tag))
        out.push(`${mdir}/${tag}.sql: in ${listedPath} but the file is missing`);
    }
    for (const f of [...fileSet].toSorted()) {
      if (!seen.has(f))
        out.push(`${mdir}/${f}.sql: not in ${listedPath}, so drizzle never applies it`);
    }
    return out;
  }
  const items = Array.isArray(journal)
    ? journal
    : isRecord(journal) && Array.isArray(journal.migrations)
      ? journal.migrations
      : null;
  if (!items) {
    return [
      `${listedPath}: the migrator's list must be a JSON list or an object with 'entries' or 'migrations'`,
    ];
  }
  const keys: string[] = [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const raw =
      typeof item === "string"
        ? item
        : isRecord(item)
          ? (item.file ?? item.name ?? item.key)
          : null;
    if (typeof raw !== "string" || !raw.trim()) {
      return [`${listedPath}: every entry in the migrator's list must name a migration file`];
    }
    let key = raw.trim().replace(/^\.\//, "");
    if (key.startsWith(`${mdir}/`)) key = key.slice(mdir.length + 1);
    if (seen.has(key)) out.push(`${mdir}/${key}: listed more than once in ${listedPath}`);
    else {
      seen.add(key);
      keys.push(key);
    }
  }
  const fileSet = new Set(files);
  for (const k of keys) {
    if (!fileSet.has(k)) out.push(`${mdir}/${k}: in ${listedPath} but the file is missing`);
  }
  for (const f of [...fileSet].toSorted()) {
    if (!seen.has(f))
      out.push(`${mdir}/${f}: not in ${listedPath}, so the runner never applies it`);
  }
  return out;
}

function worktreeMigrationMap(
  root: string,
  mdir: string,
): {
  readonly map: ReadonlyMap<string, string>;
  readonly unreadable: ReadonlyArray<string>;
} | null {
  const all = listedFiles(root);
  if (all === null) return null;
  const prefix = `${mdir}/`;
  const matching: string[] = [];
  const unreadable: string[] = [];
  for (const rel of all) {
    if (!rel.startsWith(prefix)) continue;
    if (readWorktreeFile(root, rel) === null) {
      unreadable.push(`${rel}: migration file cannot be read (missing or symlink outside repo)`);
      continue;
    }
    matching.push(rel);
  }
  const hashes = hashWorktreeFiles(root, matching);
  const map = new Map<string, string>();
  for (const rel of matching) {
    const sha = hashes.get(rel);
    if (sha) map.set(rel.slice(prefix.length), sha);
  }
  return { map, unreadable };
}

function baseMigrationMap(
  root: string,
  base: string,
  mdir: string,
): ReadonlyMap<string, string> | null {
  const blobs = treeBlobs(root, base, mdir);
  if (blobs === null) return null;
  const prefix = `${mdir}/`;
  const out = new Map<string, string>();
  for (const [rel, sha] of blobs) {
    if (rel.startsWith(prefix)) out.set(rel.slice(prefix.length), sha);
  }
  return out;
}

function protectedWriteProblems(
  rel: string,
  sql: string,
  protectedSet: ReadonlySet<string>,
  overrideSetting: string,
): string[] {
  if (protectedSet.size === 0) return [];
  const code = stripSqlComments(sql);
  const hasOverride = code.includes(overrideSetting);
  if (hasOverride) return [];
  const out: string[] = [];
  for (const table of protectedSet) {
    const escaped = table.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(
      `\\b(?:delete\\s+from|update|truncate(?:\\s+table)?)\\s+(?:only\\s+)?(?:"?public"?\\.)?"?${escaped}"?\\b`,
      "i",
    );
    if (re.test(code)) {
      out.push(
        `${rel}: writes/truncates protected table '${table}' without setting ${overrideSetting}`,
      );
    }
  }
  for (const dyn of dynamicExecutes(sql)) {
    out.push(`${rel}: ${dyn}, which may write protected member data; set ${overrideSetting}`);
  }
  return out;
}

export async function migrationsGate(input: {
  readonly root: string;
  readonly settings: Readonly<Record<string, unknown>>;
  readonly declaration: Readonly<Record<string, unknown>>;
  readonly base: string | null;
  readonly ask: (reason: string) => Promise<boolean>;
  readonly signal?: AbortSignal | undefined;
}): Promise<ReadonlyArray<CheckResult>> {
  const mdirRaw = input.settings.dir;
  if (typeof mdirRaw !== "string" || !mdirRaw.trim()) {
    return [
      failed(CHECK, "contracts.migrations.dir is not declared", { files: ["playbook.json"] }),
    ];
  }
  const mdir = mdirRaw.replace(/\/+$/, "");
  const migrator = typeof input.settings.migrator === "string" ? input.settings.migrator : "raw";
  const listedPath = typeof input.settings.list === "string" ? input.settings.list : null;

  const scanned = worktreeMigrationMap(input.root, mdir);
  if (scanned === null) return [unproven(CHECK, `git cannot list ${mdir}`)];
  if (scanned.unreadable.length > 0) {
    return [
      failed(CHECK, `${scanned.unreadable.length} unreadable migration file(s) in ${mdir}`, {
        errors: scanned.unreadable,
        fix: "remove symlinks and keep every tracked migration a regular file inside the repo",
      }),
    ];
  }
  const tree = scanned.map;
  const baseMap = input.base ? baseMigrationMap(input.root, input.base, mdir) : null;
  if (input.base && baseMap === null) return [unproven(CHECK, `git cannot read ${mdir} at base`)];

  const historyProblems: string[] = [];
  const addedKeys: string[] = [];
  const treeKeys = new Set(migrationKeys(tree, migrator));
  const baseKeys = baseMap ? migrationKeys(baseMap, migrator) : [];
  for (const key of baseKeys) {
    const now = tree.get(key);
    if (now === undefined) {
      historyProblems.push(`${mdir}/${key}: merged migration deleted or renamed`);
    } else if (now !== baseMap!.get(key)) {
      historyProblems.push(
        `${mdir}/${key}: merged migration edited; applied databases keep the old text`,
      );
    } else if (!treeKeys.has(key)) {
      historyProblems.push(`${mdir}/${key}: merged migration is not a ${migrator} migration`);
    }
  }
  const last = baseKeys.at(-1) ?? "";
  for (const key of [...treeKeys].toSorted()) {
    if (baseMap && baseMap.has(key)) continue;
    addedKeys.push(key);
    const named = namingProblems(key, migrator, last);
    if (named.length > 0) {
      historyProblems.push(...named.map((why) => `${mdir}/${key}: ${why}`));
    } else if (last && key <= last) {
      historyProblems.push(
        `${mdir}/${key}: sorts before ${last} on the base; rename it to sort last`,
      );
    }
  }
  const listedRel =
    listedPath && listedPath.startsWith(`${mdir}/`) ? listedPath.slice(mdir.length + 1) : null;
  for (const stray of strayKeys(tree, migrator)) {
    if ((!baseMap || !baseMap.has(stray)) && stray !== listedRel) {
      historyProblems.push(`${mdir}/${stray}: not a migration file the ${migrator} runner applies`);
    }
  }

  const results: CheckResult[] = [];
  if (historyProblems.length > 0) {
    const reason = `migrations history: ${historyProblems.join("; ").slice(0, 360)}`;
    if (await input.ask(reason)) {
      results.push(
        passed(`${CHECK} history`, `${historyProblems.length} history change(s) under override`),
      );
    } else {
      results.push(
        failed(`${CHECK} history`, historyProblems[0]!, {
          errors: historyProblems,
          fix: "keep merged migrations immutable and name new migrations to sort last",
        }),
      );
    }
  }

  const listErrors = judgeMigratorList(input.root, listedPath, tree, migrator, mdir);
  if (listErrors.length > 0) {
    results.push(
      failed(`${CHECK} list`, `${listErrors.length} migrator list problem(s)`, {
        errors: listErrors,
      }),
    );
  }

  const contracts = isRecord(input.declaration.contracts) ? input.declaration.contracts : {};
  const dictPath =
    isRecord(contracts.dictionary) && typeof contracts.dictionary.file === "string"
      ? contracts.dictionary.file
      : null;
  let dictDoc: Readonly<Record<string, unknown>> | null = null;
  if (dictPath) {
    const dictText = readWorktreeFile(input.root, dictPath);
    if (dictText) {
      try {
        const parsed = parseStrictJson(dictText);
        if (isRecord(parsed)) dictDoc = parsed;
      } catch {
        // dictionaryGate reports malformed dictionary JSON
      }
    }
  }
  const protTables = new Set(dictDoc ? protectedTables(dictDoc) : []);
  const guardedTables = dictDoc ? memberReferencedTables(dictDoc) : new Set<string>();
  const protection = isRecord(input.settings.protection) ? input.settings.protection : null;
  const sqlProblems: string[] = [];
  if (protTables.size > 0 && !protection) {
    sqlProblems.push(
      `the dictionary protects ${protTables.size} table(s) but contracts.migrations.protection is not declared`,
    );
  }

  const renderCmd = typeof input.settings.render === "string" ? input.settings.render : null;
  const newPaths = addedKeys.map((k) => `${mdir}/${k}`);
  for (const rel of newPaths) {
    let sql: string | null = null;
    if (rel.endsWith(".sql")) {
      sql = readWorktreeFile(input.root, rel);
    } else if (renderCmd) {
      const rendered = await runStep(
        input.root,
        renderCmd,
        { PLAYBOOK_MIGRATION: rel, PLAYBOOK_BASE: input.base ?? "" },
        undefined,
        input.signal,
      );
      if (rendered.code === null) {
        results.push(unproven(CHECK, `migrations.render did not run on ${rel}: ${rendered.why}`));
        continue;
      }
      if (rendered.code !== 0) {
        sqlProblems.push(`${rel}: migrations.render exited ${rendered.code}`);
        continue;
      }
      sql = rendered.stdout;
    }
    if (sql === null) continue;
    const destructive = destructiveStatements(sql);
    if (destructive.length > 0 && !markerIssue(sql, "destructive-ok")) {
      for (const item of destructive) {
        sqlProblems.push(`${rel}: ${item.message} (requires -- destructive-ok #<issue>)`);
      }
    }
    for (const m of sql.matchAll(REGEX_CHECK_RE)) {
      sqlProblems.push(`${rel}: regex CHECK constraint (${m[0].slice(0, 60)}) is disallowed`);
    }
    if (protection && typeof protection.override === "string") {
      sqlProblems.push(...protectedWriteProblems(rel, sql, protTables, protection.override));
    }
  }

  const truncDirs = Array.isArray(input.settings.truncate)
    ? input.settings.truncate.filter((d): d is string => typeof d === "string")
    : Array.isArray(input.settings.code)
      ? input.settings.code.filter((d): d is string => typeof d === "string")
      : [];
  if (truncDirs.length > 0 && guardedTables.size > 0) {
    const allFiles = listedFiles(input.root) ?? [];
    for (const rel of allFiles) {
      if (!truncDirs.some((d) => rel === d || rel.startsWith(`${d.replace(/\/+$/, "")}/`)))
        continue;
      const content = readWorktreeFile(input.root, rel);
      if (!content) continue;
      for (const table of guardedTables) {
        const escaped = table.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        if (
          new RegExp(`\\btruncate\\s+(?:table\\s+)?(?:"?public"?\\.)?"?${escaped}"?\\b`, "i").test(
            content,
          )
        ) {
          sqlProblems.push(`${rel}: TRUNCATE on guarded table '${table}' is refused`);
        }
      }
    }
  }
  if (sqlProblems.length > 0) {
    results.push(
      failed(CHECK, `${sqlProblems.length} migration SQL problem(s)`, {
        errors: sqlProblems,
        fix: "add -- destructive-ok #<issue> for intentional destructive DDL and follow protection guards",
      }),
    );
  }

  const lintCmd = input.settings.lint;
  if (treeKeys.size > 0 && (typeof lintCmd !== "string" || !lintCmd.trim())) {
    results.push(
      failed(`${CHECK} lint`, "contracts.migrations.lint is not declared", {
        files: ["playbook.json"],
        fix: "declare contracts.migrations.lint (for example squawk) in playbook.json",
      }),
    );
  } else if (typeof lintCmd === "string" && lintCmd.trim()) {
    const ran = await runStep(
      input.root,
      lintCmd,
      { PLAYBOOK_BASE: input.base ?? "", PLAYBOOK_MIGRATIONS_NEW: newPaths.join("\n") },
      undefined,
      input.signal,
    );
    if (ran.code === null) {
      results.push(unproven(`${CHECK} lint`, `\`${lintCmd}\` did not run: ${ran.why}`));
    } else if (ran.code !== 0) {
      results.push(
        failed(`${CHECK} lint`, `\`${lintCmd}\` exited ${ran.code}`, {
          errors: tailLines(ran, 15),
        }),
      );
    }
  }

  if (results.length === 0) {
    results.push(
      passed(
        CHECK,
        `${treeKeys.size} migration(s) in ${mdir} (${addedKeys.length} new), history and rules hold`,
      ),
    );
  }
  return results;
}
