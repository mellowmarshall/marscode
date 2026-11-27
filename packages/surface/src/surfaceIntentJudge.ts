/**
 * Judges the PR body's `## Contract Intent` block against the contract changes: every
 * change is declared (`- ADD surface POST /v1/rooms (why)`), and only those. A table
 * line covers its columns; `- ADD <contract> * (why)` adds a new file whole.
 */
import { type ChangeAction, type ContractChange, routeMatches } from "./surfaceIntentItems.ts";
import { CONTRACT_NAMES, type ContractName } from "./surfaceLocate.ts";

const MIN_WHY = 5;
const LINE = new RegExp(
  `^[-*]\\s+(ADD|REMOVE|MODIFY)\\s+(${CONTRACT_NAMES.join("|")})\\s+(.+?)\\s+\\((.+)\\)$`,
);
const LEGACY =
  /^([+~-])\s*(?:(GET|POST|PUT|DELETE|PATCH)\s+)?([/a-zA-Z0-9_:*-]+)(?:\s*:\s*(.+))?$/i;
const LEGACY_ACTION: Readonly<Record<string, ChangeAction>> = {
  "+": "ADD",
  "-": "REMOVE",
  "~": "MODIFY",
};

export interface Declared {
  readonly action: ChangeAction;
  readonly contract: ContractName;
  readonly why: string;
  readonly item?: string;
  readonly legacy?: true;
  readonly path?: string;
  readonly method?: string | null;
}

export interface AuditedChange extends ContractChange {
  readonly why: string;
}

function section(
  text: string,
  title: string,
  isDecl: (s: string) => boolean,
  looksLike: (s: string) => boolean,
): string[] | null {
  const lines = text.split("\n");
  const heading = new RegExp(`^#{2,3}\\s+${title}\\s*$`, "i");
  const start = lines.findIndex((line) => heading.test(line.trim()));
  if (start < 0) return null;
  const block: string[] = [];
  let afterBlank = false;
  let tail = false;
  for (const raw of lines.slice(start + 1)) {
    const line = raw.trim();
    if (/^#{1,2}\s/.test(line)) break;
    if (!line) {
      afterBlank = block.length > 0;
      continue;
    }
    if (line.startsWith("#") || line.startsWith("<!--") || /^([-*_])(\s*\1){2,}$/.test(line))
      continue;
    if (afterBlank && !isDecl(line)) tail = true;
    afterBlank = false;
    if (tail && !looksLike(line)) continue;
    block.push(line);
  }
  return block;
}

/** The declared changes of a PR body, and its malformed lines. */
export function parseIntent(text: string | null): { declared: Declared[]; errors: string[] } {
  const declared: Declared[] = [];
  const errors: string[] = [];
  const body = text ?? "";
  const lines = section(
    body,
    "Contract\\s+Intent",
    (s) => /^[-*]\s/.test(s),
    (s) => /^(?:[-*+]|\d+[.)])?\s*(ADD|REMOVE|MODIFY)\b/i.test(s),
  );
  for (const line of lines ?? []) {
    const m = LINE.exec(line);
    if (!m) {
      errors.push(
        `Invalid Contract Intent line: "${line}". Expected: "- ADD|REMOVE|MODIFY <${CONTRACT_NAMES.join("|")}> <item> (why)".`,
      );
      continue;
    }
    declared.push({
      action: m[1] as ChangeAction,
      contract: m[2] as ContractName,
      item: (m[3] ?? "").trim(),
      why: (m[4] ?? "").trim(),
    });
  }
  const legacy = section(
    body,
    "Surface\\s+Intent",
    (s) => /^[+~-]/.test(s),
    (s) => /^[+~-]|^(GET|POST|PUT|DELETE|PATCH)\s/i.test(s),
  );
  for (const line of legacy ?? []) {
    const m = LEGACY.exec(line);
    if (!m) {
      errors.push(
        `Invalid Surface Intent line: "${line}". Write it under "## Contract Intent" as "- ADD|REMOVE|MODIFY surface METHOD /path (why)".`,
      );
      continue;
    }
    const raw = m[3] ?? "";
    declared.push({
      action: LEGACY_ACTION[m[1] ?? "~"] ?? "MODIFY",
      contract: "surface",
      legacy: true,
      path: raw.length > 1 ? raw.replace(/\/+$/, "") : raw,
      method: m[2] ? m[2].toUpperCase() : null,
      why: (m[4] ?? "").trim(),
    });
  }
  return { declared, errors };
}

function pathOf(change: ContractChange): string {
  const parts = change.item.split(" ");
  return parts.length > 1 ? (parts[1] ?? "") : "";
}

function legacyMatches(decl: Declared, change: ContractChange): boolean {
  const path = pathOf(change);
  return (
    change.contract === "surface" && (decl.path === path || routeMatches(path, decl.path ?? ""))
  );
}

function covers(
  decl: Declared,
  change: ContractChange,
  whole: Set<string>,
  fresh: Set<string>,
): boolean {
  if (decl.contract !== change.contract) return false;
  if (decl.item === "*") {
    return (
      !decl.legacy && decl.action === "ADD" && change.action === "ADD" && fresh.has(change.contract)
    );
  }
  if (decl.legacy) {
    return (
      legacyMatches(decl, change) && (decl.action === change.action || decl.action === "MODIFY")
    );
  }
  if (decl.action !== change.action) return false;
  return (
    decl.item === change.item ||
    (whole.has(`${change.action} ${decl.item}`) && change.item.startsWith(`${decl.item}.`))
  );
}

export function describe(e: ContractChange | Declared): string {
  const item = e.item ?? `${("method" in e && e.method) || "*"} ${("path" in e && e.path) || ""}`;
  return `${e.action} ${e.contract} ${item}`;
}

/** (issues, audited): what is undeclared, unexplained or declared but unchanged; and each declared change. */
export function judgeIntent(
  changes: ReadonlyArray<ContractChange>,
  body: string,
  fresh: Set<string>,
): { issues: string[]; audited: AuditedChange[] } {
  const { declared, errors } = parseIntent(body);
  const issues = [...errors];
  const used = new Set<number>();
  const audited: AuditedChange[] = [];
  const whole = new Set(
    changes
      .filter(
        (c) =>
          c.contract === "dictionary" &&
          c.action !== "MODIFY" &&
          !c.item.includes(".") &&
          !c.item.startsWith("max"),
      )
      .map((c) => `${c.action} ${c.item}`),
  );
  for (const change of changes) {
    // A line naming the change itself wins over a new table's line that covers its columns.
    let idx = declared.findIndex(
      (d) =>
        !d.legacy &&
        d.contract === change.contract &&
        d.action === change.action &&
        d.item === change.item,
    );
    if (idx < 0) idx = declared.findIndex((d) => !d.legacy && covers(d, change, whole, fresh));
    if (idx < 0) idx = declared.findIndex((d) => covers(d, change, whole, fresh));
    if (idx < 0) {
      issues.push(
        `Undeclared contract change: ${describe(change)}. Add "- ${describe(change)} (why)" under "## Contract Intent" in the PR body.`,
      );
      continue;
    }
    used.add(idx);
    const why = declared[idx]?.why ?? "";
    if (why.length < MIN_WHY)
      issues.push(`Say why for ${describe(change)}: "${why}" is not a reason.`);
    else audited.push({ ...change, why });
  }
  declared.forEach((d, i) => {
    const methodChanged =
      !d.legacy ||
      !d.method ||
      changes.some((c) => legacyMatches(d, c) && c.item.split(" ")[0] === d.method);
    if (!used.has(i) || !methodChanged) issues.push(`Declared but not changed: ${describe(d)}.`);
  });
  return { issues, audited };
}
