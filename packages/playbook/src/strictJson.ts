/**
 * JSON.parse that refuses a key repeated in one object: the second copy would
 * otherwise win unseen (a declaration or Baseline could hide an entry).
 */
import * as Schema from "effect/Schema";

export class StrictJsonError extends Schema.TaggedError<StrictJsonError>()("StrictJsonError", {
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}

function skipString(text: string, start: number): { readonly end: number; readonly value: string } {
  let i = start + 1;
  let value = "";
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === "\\") {
      value += text.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (ch === '"') return { end: i + 1, value };
    value += ch;
    i += 1;
  }
  return { end: i, value };
}

function findDuplicateKey(text: string): string | null {
  const stack: Array<{ readonly kind: "object" | "array"; readonly keys: Set<string> }> = [];
  let expectKey = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '"') {
      const { end, value } = skipString(text, i);
      const top = stack.at(-1);
      if (top?.kind === "object" && expectKey) {
        const key = JSON.parse(`"${value}"`) as string;
        if (top.keys.has(key)) return key;
        top.keys.add(key);
        expectKey = false;
      }
      i = end;
      continue;
    }
    if (ch === "{") {
      stack.push({ kind: "object", keys: new Set() });
      expectKey = true;
    } else if (ch === "[") {
      stack.push({ kind: "array", keys: new Set() });
    } else if (ch === "}" || ch === "]") {
      stack.pop();
      expectKey = false;
    } else if (ch === ",") {
      expectKey = stack.at(-1)?.kind === "object";
    }
    i += 1;
  }
  return null;
}

export function parseStrictJson(text: string): unknown {
  let data: unknown;
  try {
    data = JSON.parse(text) as unknown;
  } catch (cause) {
    throw new StrictJsonError({ detail: cause instanceof Error ? cause.message : String(cause) });
  }
  const dup = findDuplicateKey(text);
  if (dup !== null) throw new StrictJsonError({ detail: `duplicate key ${JSON.stringify(dup)}` });
  return data;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
