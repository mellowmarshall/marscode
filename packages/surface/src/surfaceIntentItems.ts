/**
 * Contract items by key (a port of devtools' pb_intent, PLAYBOOK §5): each
 * contract file is a map of item key to canonical value, so a change is an
 * item added, removed, or modified. A surface item is `METHOD /path`.
 */
import type { ContractName } from "./surfaceLocate.ts";

type Json = Record<string, unknown>;
export type ChangeAction = "ADD" | "REMOVE" | "MODIFY";

/** (contract, action, item) of one contract change. */
export interface ContractChange {
  readonly contract: ContractName;
  readonly action: ChangeAction;
  readonly item: string;
}

function asObject(v: unknown): Json {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {};
}

function entries(v: unknown): Array<[string, unknown]> {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? Object.entries(v) : [];
}

/** JSON with object keys sorted, so key order is never a change. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical((value as Json)[k])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/** Whether a surface file records the auth level of its routes. */
export function recordsAuth(data: Json): boolean {
  return entries(data.routes).some(([, r]) => r !== null && typeof r === "object" && "auth" in r);
}

function routeAuth(route: Json, method: unknown): unknown {
  const auth = route.auth;
  return auth !== null && typeof auth === "object" ? asObject(auth)[String(method)] : auth;
}

export function surfaceItems(data: Json, withAuth = false): Map<string, string> {
  const out = new Map<string, string>();
  for (const [path, raw] of entries(data.routes)) {
    const route = asObject(raw);
    const methods =
      Array.isArray(route.methods) && route.methods.length > 0 ? route.methods : [route.method];
    for (const method of methods) {
      const value: Json = { domain: route.domain ?? null, apiFile: route.apiFile ?? null };
      if (withAuth) value.auth = routeAuth(route, method) ?? null;
      out.set(`${String(method ?? null)} ${path}`, canonical(value));
    }
  }
  return out;
}

export function fleetItems(data: Json): Map<string, string> {
  const out = new Map<string, string>();
  for (const [section, value] of entries(data)) {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      for (const [key, inner] of Object.entries(value))
        out.set(`${section}.${key}`, canonical(inner));
    } else {
      out.set(section, canonical(value));
    }
  }
  return out;
}

export function dictionaryItems(data: Json): Map<string, string> {
  const holders = new Map<string, string[]>(entries(data.concepts).map(([k]) => [k, []]));
  const out = new Map<string, string>();
  for (const [k, v] of entries(data)) if (k.startsWith("max")) out.set(k, canonical(v));
  for (const [table, rawSpec] of entries(data.tables)) {
    const { columns, ...spec } = asObject(rawSpec);
    out.set(table, canonical(spec));
    for (const [column, rawValue] of entries(columns)) {
      const { concept, role, ...value } = asObject(rawValue);
      if (concept && !(String(concept).startsWith("ref:") && value.references)) {
        const held = holders.get(String(concept)) ?? [];
        held.push(role ? `${table}.${column} ${String(role)}` : `${table}.${column}`);
        holders.set(String(concept), held);
      }
      out.set(`${table}.${column}`, canonical(value));
    }
  }
  if (data.roles) out.set("roles", canonical(data.roles));
  const concepts = asObject(data.concepts);
  for (const [key, held] of holders) {
    out.set(`concept:${key}`, canonical({ ...asObject(concepts[key]), holders: [...held].sort() }));
  }
  return out;
}

export function actionItems(data: Json): Map<string, string> {
  return new Map(entries(data.actions).map(([k, v]) => [k, canonical(v)]));
}

export function slotItems(data: Json): Map<string, string> {
  const out = new Map(entries(data.slots).map(([k, v]) => [k, canonical(v)]));
  for (const [k, v] of entries(data.treatments)) out.set(`treatment:${k}`, canonical(v));
  return out;
}

const ITEMS: Readonly<
  Record<Exclude<ContractName, "surface">, (data: Json) => Map<string, string>>
> = {
  fleet: fleetItems,
  dictionary: dictionaryItems,
  actions: actionItems,
  slots: slotItems,
};

/** (before, after): item key to canonical value on each side. */
export function contractValues(
  contract: ContractName,
  base: Json,
  head: Json,
): [Map<string, string>, Map<string, string>] {
  if (contract === "surface") {
    const auth = recordsAuth(base);
    return [surfaceItems(base, auth), surfaceItems(head, auth)];
  }
  return [ITEMS[contract](base), ITEMS[contract](head)];
}

/** Each change from base to head, in the head's order, then the removed items. */
export function contractDiff(contract: ContractName, base: Json, head: Json): ContractChange[] {
  const [before, after] = contractValues(contract, base, head);
  const out: ContractChange[] = [];
  for (const k of after.keys()) if (!before.has(k)) out.push({ contract, action: "ADD", item: k });
  for (const [k, v] of after) {
    if (before.has(k) && before.get(k) !== v) out.push({ contract, action: "MODIFY", item: k });
  }
  for (const k of before.keys())
    if (!after.has(k)) out.push({ contract, action: "REMOVE", item: k });
  const order = new Map(
    [...after.keys(), ...[...before.keys()].filter((k) => !after.has(k))].map((k, i) => [k, i]),
  );
  return out.sort((a, b) => (order.get(a.item) ?? 0) - (order.get(b.item) ?? 0));
}

/** `field: old -> new` for each field of an item that differs. */
export function modifiedFields(before: string, after: string): string[] {
  const b: unknown = JSON.parse(before);
  const a: unknown = JSON.parse(after);
  if (!(b && typeof b === "object" && a && typeof a === "object")) return [`${before} -> ${after}`];
  const bo = b as Json;
  const ao = a as Json;
  return [...new Set([...Object.keys(bo), ...Object.keys(ao)])]
    .sort()
    .filter((k) => canonical(bo[k]) !== canonical(ao[k]))
    .map((k) => `${k}: ${canonical(bo[k])} -> ${canonical(ao[k])}`);
}

/** `:param` and a trailing `*` match any segment. */
export function routeMatches(call: string, template: string): boolean {
  if (call === template) return true;
  const cp = call.split("/").filter(Boolean);
  const tp = template.split("/").filter(Boolean);
  if (tp.length > 0 && tp.at(-1) === "*") {
    const fixed: string[] = [];
    for (const p of tp) {
      if (p.startsWith(":") || p === "*") break;
      fixed.push(p);
    }
    if (cp.length < fixed.length || fixed.some((p, i) => cp[i] !== p)) return false;
    for (let i = fixed.length; i < tp.length; i += 1) {
      const t = tp[i] ?? "";
      if (t === "*") return true;
      if (i >= cp.length) return false;
      const c = cp[i] ?? "";
      if (t.startsWith(":") || c.startsWith(":")) continue;
      if (t !== c) return false;
    }
    return true;
  }
  if (cp.length !== tp.length) return false;
  return tp.every((t, i) => {
    const c = cp[i] ?? "";
    return t.startsWith(":") || t === "*" || c.startsWith(":") || c === "*" || t === c;
  });
}
