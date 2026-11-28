// The `[[approved]]` rule tables of the reaper policy file: lenient and strict parsing, and serialization that keeps other sections.
export interface ReaperPolicyRule {
  readonly path: string;
  readonly maxAgeDays: number;
  readonly keepLatest: number;
  readonly enabled: boolean;
}

export const MIN_AGE_DAYS = 1;

export function stripTomlCommentOutsideQuotes(line: string): string {
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if (quote === '"') {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        quote = null;
      }
      continue;
    }
    if (quote === "'") {
      if (ch === "'") quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === "#") {
      return line.slice(0, i).trim();
    }
  }
  return line.trim();
}

const isQuoted = (raw: string) =>
  raw.length >= 2 &&
  ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'")));

export function unquoteTomlString(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    return trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function quoteTomlString(raw: string): string {
  return `"${raw.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function normalizeAgeDays(val: number): number {
  const clamped = Math.max(MIN_AGE_DAYS, Math.min(3650, val));
  return Math.round(clamped * 100) / 100;
}

interface PartialRule {
  path?: string;
  maxAgeDays?: number;
  keepLatest?: number;
  enabled?: boolean;
}

const KEY_FIELDS: Readonly<Record<string, keyof PartialRule>> = {
  path: "path",
  max_age_days: "maxAgeDays",
  keep_latest: "keepLatest",
  enabled: "enabled",
};

function finishRule(current: PartialRule & { path: string }): ReaperPolicyRule {
  return {
    path: current.path,
    maxAgeDays:
      typeof current.maxAgeDays === "number" &&
      Number.isFinite(current.maxAgeDays) &&
      current.maxAgeDays >= MIN_AGE_DAYS
        ? normalizeAgeDays(current.maxAgeDays)
        : 14,
    keepLatest:
      typeof current.keepLatest === "number" && Number.isFinite(current.keepLatest)
        ? Math.max(0, Math.min(1000, Math.round(current.keepLatest)))
        : 2,
    enabled: current.enabled === true,
  };
}

/**
 * Rules from the file text. Lenient mode skips what it cannot read; strict mode returns an
 * error instead, for writers that must never rebuild the file from a partial rule list.
 */
function parseRules(
  text: string,
  strict: boolean,
):
  | { readonly ok: true; readonly rules: ReadonlyArray<ReaperPolicyRule> }
  | { readonly ok: false; readonly error: string } {
  const rules: ReaperPolicyRule[] = [];
  let current: PartialRule | null = null;
  let error: string | null = null;
  const fail = (lineNo: number, why: string) => {
    error ??= `Reaper policy line ${lineNo}: ${why}`;
  };
  const flush = (lineNo: number) => {
    if (current === null) return;
    if (current.path === undefined) {
      if (strict) fail(lineNo, "an [[approved]] rule has no path");
    } else {
      rules.push(finishRule({ ...current, path: current.path }));
    }
    current = null;
  };

  const lines = text.split(/\r?\n/);
  for (const [index, rawLine] of lines.entries()) {
    const lineNo = index + 1;
    const stripped = stripTomlCommentOutsideQuotes(rawLine);
    if (!stripped) continue;
    if (stripped === "[[approved]]") {
      flush(lineNo);
      current = {};
      continue;
    }
    if (stripped.startsWith("[")) {
      flush(lineNo);
      continue;
    }
    if (current === null) continue;
    const rule: PartialRule = current;
    const eq = stripped.indexOf("=");
    if (eq <= 0) {
      if (strict) fail(lineNo, "expected key = value");
      continue;
    }
    const key = stripped.slice(0, eq).trim();
    const val = stripped.slice(eq + 1).trim();
    const number = val === "" ? Number.NaN : Number(val);
    if (strict && Object.hasOwn(KEY_FIELDS, key) && rule[KEY_FIELDS[key]!] !== undefined) {
      fail(lineNo, `duplicate key ${key}`);
    }
    if (key === "path") {
      if (strict && !isQuoted(val)) fail(lineNo, "path must be a quoted string");
      rule.path = unquoteTomlString(val);
    } else if (key === "max_age_days" || key === "keep_latest") {
      if (strict && !Number.isFinite(number)) fail(lineNo, `${key} must be a number`);
      if (key === "max_age_days") rule.maxAgeDays = number;
      else rule.keepLatest = number;
    } else if (key === "enabled") {
      if (strict && val !== "true" && val !== "false")
        fail(lineNo, "enabled must be true or false");
      rule.enabled = val === "true";
    } else if (strict) {
      fail(lineNo, `unknown key ${key} in an [[approved]] rule`);
    }
  }
  flush(lines.length);
  return error === null ? { ok: true, rules } : { ok: false, error };
}

export function parseReaperPolicyToml(text: string): ReadonlyArray<ReaperPolicyRule> {
  const parsed = parseRules(text, false);
  return parsed.ok ? parsed.rules : [];
}

export function parseReaperPolicyTomlStrict(text: string) {
  return parseRules(text, true);
}

function preserveNonApprovedToml(existingText: string): string {
  const out: string[] = [];
  let skippingApproved = false;
  for (const rawLine of existingText.split(/\r?\n/)) {
    const stripped = stripTomlCommentOutsideQuotes(rawLine);
    if (stripped === "[[approved]]") {
      skippingApproved = true;
      continue;
    }
    if (stripped.startsWith("[")) {
      skippingApproved = false;
    }
    if (!skippingApproved) {
      out.push(rawLine);
    }
  }
  return out.join("\n").trimEnd();
}

export function serializeReaperPolicyToml(
  rules: ReadonlyArray<ReaperPolicyRule>,
  existingText?: string,
): string {
  const preserved = existingText ? preserveNonApprovedToml(existingText) : "";
  const header = preserved
    ? [preserved, ""]
    : [
        "# Approved per-host cleanup policy for agent-tmp-reap.py.",
        "# Only rules with `enabled = true` are swept; T3 Code's manifest `history` paths",
        "# are always hard-protected regardless of rules listed here.",
        "",
      ];
  const lines = [...header];
  for (const rule of rules) {
    lines.push("[[approved]]");
    lines.push(`path = ${quoteTomlString(rule.path)}`);
    lines.push(`max_age_days = ${normalizeAgeDays(rule.maxAgeDays)}`);
    lines.push(`keep_latest = ${Math.max(0, Math.min(1000, Math.round(rule.keepLatest)))}`);
    lines.push(`enabled = ${rule.enabled ? "true" : "false"}`);
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}
