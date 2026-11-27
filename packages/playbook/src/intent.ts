/**
 * Contract intent (PLAYBOOK §5): every item change of a declared contract file is declared
 * under `## Contract Intent` (`- ADD|REMOVE|MODIFY <contract> <item> (why)`), and only those.
 */
import { canonicalJson, isRecord } from "./strictJson.ts";

export const INTENT_CONTRACTS = ["surface", "fleet", "dictionary", "actions", "slots"] as const;
export type IntentContract = (typeof INTENT_CONTRACTS)[number];
const MIN_WHY = 5;
const LINE_RE = new RegExp(
  `^[-*]\\s+(ADD|REMOVE|MODIFY)\\s+(${INTENT_CONTRACTS.join("|")})\\s+(.+?)\\s+\\((.+)\\)$`,
);

export type IntentAction = "ADD" | "REMOVE" | "MODIFY";

export interface ContractChange {
  readonly contract: IntentContract;
  readonly action: IntentAction;
  readonly item: string;
}

export interface DeclaredIntent {
  readonly contract: IntentContract;
  readonly action: IntentAction;
  readonly item: string;
  readonly why: string;
}

type Items = Map<string, string>;
const entries = (obj: unknown): ReadonlyArray<[string, unknown]> =>
  isRecord(obj) ? Object.entries(obj) : [];

function surfaceItems(data: unknown, withAuth: boolean): Items {
  const out: Items = new Map();
  for (const [path, raw] of entries(isRecord(data) ? data.routes : undefined)) {
    const route = isRecord(raw) ? raw : {};
    const methods = Array.isArray(route.methods) ? route.methods : [route.method];
    for (const method of methods) {
      const auth = isRecord(route.auth) ? route.auth[String(method)] : route.auth;
      const value: Record<string, unknown> = { domain: route.domain, apiFile: route.apiFile };
      if (withAuth) value.auth = auth;
      out.set(`${String(method)} ${path}`, canonicalJson(value));
    }
  }
  return out;
}

function fleetItems(data: unknown): Items {
  const out: Items = new Map();
  for (const [section, value] of entries(data)) {
    if (isRecord(value)) {
      for (const [key, inner] of Object.entries(value))
        out.set(`${section}.${key}`, canonicalJson(inner));
    } else {
      out.set(section, canonicalJson(value));
    }
  }
  return out;
}

function dictionaryItems(data: unknown): Items {
  const doc = isRecord(data) ? data : {};
  const holders = new Map<string, string[]>(entries(doc.concepts).map(([k]) => [k, []]));
  const out: Items = new Map(
    entries(doc)
      .filter(([k]) => k.startsWith("max"))
      .map(([k, v]) => [k, canonicalJson(v)]),
  );
  for (const [table, rawSpec] of entries(doc.tables)) {
    const { columns, ...spec } = isRecord(rawSpec) ? rawSpec : {};
    out.set(table, canonicalJson(spec));
    for (const [column, rawValue] of entries(columns)) {
      const { concept, role, ...value } = isRecord(rawValue) ? rawValue : {};
      if (concept && !(String(concept).startsWith("ref:") && value.references)) {
        const list = holders.get(String(concept)) ?? [];
        list.push(role ? `${table}.${column} ${String(role)}` : `${table}.${column}`);
        holders.set(String(concept), list);
      }
      out.set(`${table}.${column}`, canonicalJson(value));
    }
  }
  if (doc.roles) out.set("roles", canonicalJson(doc.roles));
  for (const [key, held] of holders) {
    const concept = isRecord(doc.concepts) && isRecord(doc.concepts[key]) ? doc.concepts[key] : {};
    out.set(`concept:${key}`, canonicalJson({ ...concept, holders: held.toSorted() }));
  }
  return out;
}

function itemsOf(contract: IntentContract, data: unknown, withAuth: boolean): Items {
  const doc = isRecord(data) ? data : {};
  switch (contract) {
    case "surface":
      return surfaceItems(doc, withAuth);
    case "fleet":
      return fleetItems(doc);
    case "dictionary":
      return dictionaryItems(doc);
    case "actions":
      return new Map(entries(doc.actions).map(([k, v]) => [k, canonicalJson(v)]));
    case "slots":
      return new Map([
        ...entries(doc.slots).map(([k, v]) => [k, canonicalJson(v)] as [string, string]),
        ...entries(doc.treatments).map(
          ([k, v]) => [`treatment:${k}`, canonicalJson(v)] as [string, string],
        ),
      ]);
  }
}

const recordsAuth = (data: unknown) =>
  entries(isRecord(data) ? data.routes : undefined).some(([, r]) => isRecord(r) && "auth" in r);

/** Each change of CONTRACT's items between BASE and HEAD, in the head's order. */
export function contractDiff(
  contract: IntentContract,
  base: unknown,
  head: unknown,
): ReadonlyArray<ContractChange> {
  const auth = contract === "surface" && recordsAuth(base);
  const before = itemsOf(contract, base, auth);
  const after = itemsOf(contract, head, auth);
  const out: ContractChange[] = [];
  for (const [k, v] of after) {
    if (!before.has(k)) out.push({ contract, action: "ADD", item: k });
    else if (before.get(k) !== v) out.push({ contract, action: "MODIFY", item: k });
  }
  for (const k of before.keys()) {
    if (!after.has(k)) out.push({ contract, action: "REMOVE", item: k });
  }
  return out;
}

function intentSection(text: string): ReadonlyArray<string> {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => /^#{2,3}\s+Contract\s+Intent\s*$/i.test(l.trim()));
  if (start < 0) return [];
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
    if (afterBlank && !/^[-*]\s/.test(line)) tail = true;
    afterBlank = false;
    if (tail && !/^(?:[-*+]|\d+[.)])?\s*(ADD|REMOVE|MODIFY)\b/i.test(line)) continue;
    block.push(line);
  }
  return block;
}

function parseContractIntent(text: string | null): {
  readonly declared: ReadonlyArray<DeclaredIntent>;
  readonly errors: ReadonlyArray<string>;
} {
  const declared: DeclaredIntent[] = [];
  const errors: string[] = [];
  for (const line of intentSection(text ?? "")) {
    const m = LINE_RE.exec(line);
    if (!m) {
      errors.push(
        `Invalid Contract Intent line: "${line}". Expected: "- ADD|REMOVE|MODIFY <${INTENT_CONTRACTS.join("|")}> <item> (why)".`,
      );
      continue;
    }
    declared.push({
      action: m[1] as IntentAction,
      contract: m[2] as IntentContract,
      item: m[3]!.trim(),
      why: m[4]!.trim(),
    });
  }
  return { declared, errors };
}

const describe = (c: { action: string; contract: string; item: string }) =>
  `${c.action} ${c.contract} ${c.item}`;

/** (problems, audited changes) of CHANGES against BODY's Contract Intent block. */
export function judgeContractIntent(
  changes: ReadonlyArray<ContractChange>,
  body: string,
  newContracts: ReadonlySet<string>,
): {
  readonly issues: ReadonlyArray<string>;
  readonly audited: ReadonlyArray<ContractChange & { readonly why: string }>;
} {
  const { declared, errors } = parseContractIntent(body);
  const issues = [...errors];
  const used = new Set<number>();
  const audited: Array<ContractChange & { why: string }> = [];
  const whole = new Set(
    changes
      .filter((c) => c.contract === "dictionary" && c.action !== "MODIFY")
      .filter((c) => !c.item.includes(".") && !c.item.startsWith("max"))
      .map((c) => `${c.action} ${c.item}`),
  );
  const covers = (d: DeclaredIntent, c: ContractChange) => {
    if (d.contract !== c.contract) return false;
    if (d.item === "*")
      return d.action === "ADD" && c.action === "ADD" && newContracts.has(c.contract);
    if (d.action !== c.action) return false;
    return (
      d.item === c.item || (whole.has(`${c.action} ${d.item}`) && c.item.startsWith(`${d.item}.`))
    );
  };
  for (const change of changes) {
    let idx = declared.findIndex(
      (d) => d.contract === change.contract && d.action === change.action && d.item === change.item,
    );
    if (idx < 0) idx = declared.findIndex((d) => covers(d, change));
    if (idx < 0) {
      issues.push(
        `Undeclared contract change: ${describe(change)}. Add "- ${describe(change)} (why)" under "## Contract Intent" in the PR body.`,
      );
      continue;
    }
    used.add(idx);
    const why = declared[idx]!.why;
    if (why.length < MIN_WHY)
      issues.push(`Say why for ${describe(change)}: "${why}" is not a reason.`);
    else audited.push({ ...change, why });
  }
  declared.forEach((d, i) => {
    if (!used.has(i)) issues.push(`Declared but not changed: ${describe(d)}.`);
  });
  return { issues, audited };
}
