// @effect-diagnostics globalDate:off - Pure O(n) log line extractors and bounded min-max series ring buffer.
import type { GenericProgressMatch } from "./progressExtractor.ts";
import { isSafeMetricKey, type JobLogFormat, type JobMetricPoint } from "./types.ts";

const MAX_LINE_CHARS = 8_192;
const MAX_SERIES_POINTS = 500;
const MAX_TEMPLATES = 4;
const MAX_TEMPLATE_LEN = 256;

// Matches CSI/OSC ANSI escape sequences so kv & template extractors see clean text.
const ANSI_ESCAPE_RE = /\u001b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\))/g;

// Replaces bare Python JSON tokens (NaN, Infinity, -Infinity) outside quoted strings with tagged sentinel strings.
const NAN_SENTINEL = '"__T3_NAN__"';
const INF_SENTINEL = '"__T3_INF__"';

export interface ExtractedNumericValue {
  readonly value: number | null;
  readonly anomaly?: "nan" | "inf" | undefined;
}

export interface ExtractedLineRecord {
  readonly fields: ReadonlyMap<string, ExtractedNumericValue>;
  readonly strings: ReadonlyMap<string, string>;
  readonly genericProgress?: GenericProgressMatch | undefined;
}

type TemplateToken =
  | { readonly kind: "literal"; readonly text: string }
  | { readonly kind: "skip" }
  | {
      readonly kind: "capture";
      readonly name: string;
      readonly type: "int" | "float" | "str" | "json";
    };

export interface CompiledTemplate {
  readonly raw: string;
  readonly tokens: ReadonlyArray<TemplateToken>;
}

export function stripAnsi(line: string): string {
  return line.includes("\u001b") ? line.replace(ANSI_ESCAPE_RE, "") : line;
}

/**
 * Splits incoming text into lines using both `\n` and `\r` as terminators so `tqdm`-style
 * carriage-return progress bars never accumulate into multi-megabyte single lines.
 */
export function splitLogLines(
  pending: string,
  chunk: string,
): { readonly lines: ReadonlyArray<string>; readonly remainder: string } {
  const combined = pending + chunk;
  const lines: string[] = [];
  let start = 0;
  for (let i = 0; i < combined.length; i += 1) {
    const code = combined.charCodeAt(i);
    if (code === 10 || code === 13) {
      if (i > start) {
        const slice = combined.slice(start, Math.min(i, start + MAX_LINE_CHARS));
        if (slice.length > 0) lines.push(slice);
      }
      if (code === 13 && i + 1 < combined.length && combined.charCodeAt(i + 1) === 10) {
        i += 1;
      }
      start = i + 1;
    }
  }
  let remainder = start < combined.length ? combined.slice(start) : "";
  if (remainder.length > MAX_LINE_CHARS) {
    lines.push(remainder.slice(0, MAX_LINE_CHARS));
    remainder = "";
  }
  return { lines, remainder };
}

/**
 * Rewrites bare Python `NaN` / `Infinity` / `-Infinity` values outside quoted JSON strings
 * into sentinel strings so `JSON.parse` succeeds and anomaly alerts actually fire.
 */
function sanitizePythonJson(raw: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i]!;
    if (inString) {
      out += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      i += 1;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      i += 1;
      continue;
    }
    const prev = i > 0 ? raw[i - 1]! : "";
    const isBoundaryBefore = prev === "" || /[\s:,[{]/.test(prev);
    if (isBoundaryBefore) {
      if (raw.startsWith("NaN", i) && isJsonTokenEnd(raw[i + 3])) {
        out += NAN_SENTINEL;
        i += 3;
        continue;
      }
      if (raw.startsWith("-Infinity", i) && isJsonTokenEnd(raw[i + 9])) {
        out += INF_SENTINEL;
        i += 9;
        continue;
      }
      if (raw.startsWith("Infinity", i) && isJsonTokenEnd(raw[i + 8])) {
        out += INF_SENTINEL;
        i += 8;
        continue;
      }
    }
    out += ch;
    i += 1;
  }
  return out;
}

function isJsonTokenEnd(ch: string | undefined): boolean {
  return ch === undefined || /[\s,}\]]/.test(ch);
}

function parseNumericToken(raw: string): ExtractedNumericValue | null {
  const lower = raw.trim().toLowerCase();
  if (!lower) return null;
  if (lower === "nan" || lower === "+nan" || lower === "-nan") {
    return { value: null, anomaly: "nan" };
  }
  if (
    lower === "inf" ||
    lower === "+inf" ||
    lower === "-inf" ||
    lower === "infinity" ||
    lower === "-infinity"
  ) {
    return { value: null, anomaly: "inf" };
  }
  const num = Number(lower);
  if (!Number.isFinite(num)) return null;
  return { value: num };
}

function ingestJsonObject(
  obj: Record<string, unknown>,
  fields: Map<string, ExtractedNumericValue>,
  strings: Map<string, string>,
  prefix = "",
  depth = 0,
): void {
  if (depth > 2) return;
  for (const [rawKey, val] of Object.entries(obj)) {
    const key = prefix ? `${prefix}/${rawKey}` : rawKey;
    if (!isSafeMetricKey(key)) continue;
    if (typeof val === "number") {
      if (Number.isNaN(val)) fields.set(key, { value: null, anomaly: "nan" });
      else if (!Number.isFinite(val)) fields.set(key, { value: null, anomaly: "inf" });
      else fields.set(key, { value: val });
    } else if (val === "__T3_NAN__") {
      fields.set(key, { value: null, anomaly: "nan" });
    } else if (val === "__T3_INF__") {
      fields.set(key, { value: null, anomaly: "inf" });
    } else if (typeof val === "string") {
      if (val.length <= 160) strings.set(key, val);
    } else if (val && typeof val === "object" && !Array.isArray(val)) {
      ingestJsonObject(val as Record<string, unknown>, fields, strings, key, depth + 1);
    }
  }
}

export function extractJsonlLine(rawLine: string): ExtractedLineRecord | null {
  const clean = stripAnsi(rawLine).trim();
  if (!clean.startsWith("{") || !clean.endsWith("}")) return null;
  try {
    const parsed = JSON.parse(sanitizePythonJson(clean)) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const fields = new Map<string, ExtractedNumericValue>();
    const strings = new Map<string, string>();
    ingestJsonObject(parsed as Record<string, unknown>, fields, strings);
    return fields.size > 0 || strings.size > 0 ? { fields, strings } : null;
  } catch {
    return null;
  }
}

/**
 * Linear O(n) scanner for `key=value` pairs (including embedded `key={json}` dicts such as
 * `val={"mrr": 0.9047, "composite": 0.8832}` in training logs).
 */
export function extractKvLine(rawLine: string): ExtractedLineRecord | null {
  const clean = stripAnsi(rawLine);
  const fields = new Map<string, ExtractedNumericValue>();
  const strings = new Map<string, string>();
  let i = 0;
  const len = clean.length;
  let failedJsonScans = 0;

  while (i < len) {
    // Advance to potential key start
    while (i < len && !/[A-Za-z0-9_./-]/.test(clean[i]!)) i += 1;
    const keyStart = i;
    while (i < len && /[A-Za-z0-9_./-]/.test(clean[i]!)) i += 1;
    const key = clean.slice(keyStart, i);
    if (i >= len || clean[i] !== "=" || !key) continue;
    i += 1; // skip '='
    if (i >= len) break;

    if (clean[i] === "{") {
      if (failedJsonScans < 4) {
        const jsonEnd = findBalancedJsonEnd(clean, i);
        if (jsonEnd !== -1) {
          const snippet = clean.slice(i, jsonEnd + 1);
          try {
            const parsed = JSON.parse(sanitizePythonJson(snippet)) as unknown;
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
              ingestJsonObject(parsed as Record<string, unknown>, fields, strings, key);
            }
          } catch {
            failedJsonScans += 1;
          }
          i = jsonEnd + 1;
          continue;
        }
        failedJsonScans += 1;
      }
    }

    const valStart = i;
    while (i < len && !/[\s,;|)\]]/.test(clean[i]!)) i += 1;
    const rawVal = clean.slice(valStart, i);
    if (!isSafeMetricKey(key) || !rawVal) continue;
    const parsedNum = parseNumericToken(rawVal);
    if (parsedNum) {
      fields.set(key, parsedNum);
    } else if (rawVal.length <= 120) {
      strings.set(key, rawVal);
    }
  }

  return fields.size > 0 || strings.size > 0 ? { fields, strings } : null;
}

function findBalancedJsonEnd(text: string, openIdx: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  const maxEnd = Math.min(text.length, openIdx + 2_048);
  for (let i = openIdx; i < maxEnd; i += 1) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

const PLACEHOLDER_RE = /\{([A-Za-z0-9_./-]+):(int|float|str|json)\}|\{\.\.\.\}|\.\.\./g;

/**
 * Compiles a fill-in-the-blank template such as:
 *   `"[Ep {epoch:int}/{total_epochs:int} step {step:int}/{total_steps:int}] qa={qa:float} ... comp={comp:float} | {rate:float} it/s"`
 * into a strictly linear-time token sequence (zero regex backtracking, zero ReDoS).
 */
export function compileTemplate(raw: string): CompiledTemplate | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > MAX_TEMPLATE_LEN) return null;
  const tokens: TemplateToken[] = [];
  let cursor = 0;
  let hasCapture = false;
  PLACEHOLDER_RE.lastIndex = 0;

  for (const match of trimmed.matchAll(PLACEHOLDER_RE)) {
    const idx = match.index ?? 0;
    if (idx > cursor) {
      tokens.push({ kind: "literal", text: trimmed.slice(cursor, idx) });
    }
    const full = match[0]!;
    if (full === "..." || full === "{...}") {
      if (tokens.at(-1)?.kind !== "skip") {
        tokens.push({ kind: "skip" });
      }
    } else {
      const name = match[1]!;
      const type = match[2] as "int" | "float" | "str" | "json";
      if (!isSafeMetricKey(name)) return null;
      hasCapture = true;
      tokens.push({ kind: "capture", name, type });
    }
    cursor = idx + full.length;
  }
  if (cursor < trimmed.length) {
    tokens.push({ kind: "literal", text: trimmed.slice(cursor) });
  }
  if (!hasCapture) return null;
  return { raw: trimmed, tokens };
}

function readIntToken(
  line: string,
  pos: number,
): { readonly end: number; readonly raw: string } | null {
  let i = pos;
  while (i < line.length && line[i] === " ") i += 1;
  const start = i;
  if (i < line.length && (line[i] === "+" || line[i] === "-")) i += 1;
  const digitsStart = i;
  while (i < line.length && line.charCodeAt(i) >= 48 && line.charCodeAt(i) <= 57) i += 1;
  if (i === digitsStart) return null;
  return { end: i, raw: line.slice(start, i) };
}

function readFloatToken(
  line: string,
  pos: number,
): { readonly end: number; readonly raw: string } | null {
  let i = pos;
  while (i < line.length && line[i] === " ") i += 1;
  const start = i;
  const lower = line.slice(i, i + 10).toLowerCase();
  for (const special of [
    "-infinity",
    "+infinity",
    "infinity",
    "-inf",
    "+inf",
    "inf",
    "-nan",
    "+nan",
    "nan",
  ]) {
    if (lower.startsWith(special)) {
      const after = line[i + special.length];
      if (!after || !/[A-Za-z0-9_]/.test(after)) {
        return { end: i + special.length, raw: line.slice(start, i + special.length) };
      }
    }
  }
  if (i < line.length && (line[i] === "+" || line[i] === "-")) i += 1;
  let sawDigit = false;
  while (i < line.length && line.charCodeAt(i) >= 48 && line.charCodeAt(i) <= 57) {
    sawDigit = true;
    i += 1;
  }
  if (i < line.length && line[i] === ".") {
    i += 1;
    while (i < line.length && line.charCodeAt(i) >= 48 && line.charCodeAt(i) <= 57) {
      sawDigit = true;
      i += 1;
    }
  }
  if (!sawDigit) return null;
  if (i < line.length && (line[i] === "e" || line[i] === "E")) {
    let j = i + 1;
    if (j < line.length && (line[j] === "+" || line[j] === "-")) j += 1;
    const expStart = j;
    while (j < line.length && line.charCodeAt(j) >= 48 && line.charCodeAt(j) <= 57) j += 1;
    if (j > expStart) i = j;
  }
  return { end: i, raw: line.slice(start, i) };
}

function matchLiteralFlexibleSpace(line: string, pos: number, lit: string): number {
  let i = pos;
  let j = 0;
  while (j < lit.length) {
    if (lit[j] === " ") {
      // Collapse any run of spaces in both template and log line (handles padded columns like `step  300/1953`).
      while (j < lit.length && lit[j] === " ") j += 1;
      if (i >= line.length || (line[i] !== " " && line[i] !== "\t")) return -1;
      while (i < line.length && (line[i] === " " || line[i] === "\t")) i += 1;
      continue;
    }
    if (i >= line.length || line[i] !== lit[j]) return -1;
    i += 1;
    j += 1;
  }
  return i;
}

function findNextLiteral(
  line: string,
  from: number,
  lit: string,
): { readonly idx: number; readonly end: number } | null {
  const firstChar = lit[0];
  if (firstChar === undefined) return { idx: from, end: from };
  let searchFrom = from;
  while (searchFrom < line.length) {
    const hit =
      firstChar === " " ? line.indexOf(" ", searchFrom) : line.indexOf(firstChar, searchFrom);
    if (hit === -1) return null;
    const end = matchLiteralFlexibleSpace(line, hit, lit);
    if (end !== -1) return { idx: hit, end };
    searchFrom = hit + 1;
  }
  return null;
}

export function matchCompiledTemplate(
  compiled: CompiledTemplate,
  rawLine: string,
): ExtractedLineRecord | null {
  const line = stripAnsi(rawLine);
  const fields = new Map<string, ExtractedNumericValue>();
  const strings = new Map<string, string>();
  let pos = 0;
  const tokens = compiled.tokens;

  for (let tIdx = 0; tIdx < tokens.length; tIdx += 1) {
    const tok = tokens[tIdx]!;
    if (tok.kind === "literal") {
      if (tIdx === 0) {
        const hit = findNextLiteral(line, pos, tok.text);
        if (!hit) return null;
        pos = hit.end;
      } else {
        const end = matchLiteralFlexibleSpace(line, pos, tok.text);
        if (end === -1) return null;
        pos = end;
      }
      continue;
    }

    if (tok.kind === "skip") {
      const nextTok = tokens[tIdx + 1];
      if (!nextTok) break;
      if (nextTok.kind === "literal") {
        const hit = findNextLiteral(line, pos, nextTok.text);
        if (!hit) return null;
        pos = hit.end;
        tIdx += 1; // consumed next literal
      }
      continue;
    }

    // Capture token
    if (tok.type === "int") {
      const hit = readIntToken(line, pos);
      if (!hit) return null;
      const num = Number.parseInt(hit.raw, 10);
      if (!Number.isFinite(num)) return null;
      fields.set(tok.name, { value: num });
      pos = hit.end;
    } else if (tok.type === "float") {
      const hit = readFloatToken(line, pos);
      if (!hit) return null;
      const parsed = parseNumericToken(hit.raw);
      if (!parsed) return null;
      fields.set(tok.name, parsed);
      pos = hit.end;
    } else if (tok.type === "json") {
      while (pos < line.length && line[pos] === " ") pos += 1;
      if (line[pos] !== "{") return null;
      const jsonEnd = findBalancedJsonEnd(line, pos);
      if (jsonEnd === -1) return null;
      try {
        const parsed = JSON.parse(sanitizePythonJson(line.slice(pos, jsonEnd + 1))) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
        ingestJsonObject(parsed as Record<string, unknown>, fields, strings, tok.name);
      } catch {
        return null;
      }
      pos = jsonEnd + 1;
    } else {
      const nextTok = tokens[tIdx + 1];
      let end = line.length;
      if (nextTok?.kind === "literal") {
        const hit = findNextLiteral(line, pos, nextTok.text);
        if (!hit) return null;
        end = hit.idx;
      } else {
        let i = pos;
        while (i < line.length && !/\s/.test(line[i]!)) i += 1;
        end = i;
      }
      const text = line.slice(pos, end).trim();
      if (!text) return null;
      strings.set(tok.name, text.slice(0, 160));
      pos = end;
    }
  }

  return fields.size > 0 || strings.size > 0 ? { fields, strings } : null;
}

export function createLineExtractor(
  format: JobLogFormat,
  templates?: ReadonlyArray<string>,
): (line: string) => ExtractedLineRecord | null {
  if (format === "jsonl") return extractJsonlLine;
  if (format === "kv") return extractKvLine;
  const compiled = (templates ?? [])
    .slice(0, MAX_TEMPLATES)
    .map(compileTemplate)
    .filter((t): t is CompiledTemplate => t !== null);
  return (line: string) => {
    for (const tpl of compiled) {
      const hit = matchCompiledTemplate(tpl, line);
      if (hit) return hit;
    }
    return null;
  };
}

/**
 * Appends a point to a bounded ring buffer (<= MAX_SERIES_POINTS).
 * When the buffer exceeds capacity, decimates 2:1 preserving local min/max extrema and anomalies
 * so spikes and NaNs are never silently dropped.
 */
export function appendMetricPoint(
  points: JobMetricPoint[],
  next: JobMetricPoint,
  maxPoints = MAX_SERIES_POINTS,
): void {
  points.push(next);
  if (points.length <= maxPoints) return;
  const compacted: JobMetricPoint[] = [];
  // Keep first point, decimate middle in buckets of 4 preserving min + max (2:1 reduction), keep tail.
  const keepTail = Math.min(32, Math.floor(maxPoints / 8));
  const bodyEnd = points.length - keepTail;
  if (points[0]) compacted.push(points[0]);
  for (let i = 1; i < bodyEnd; i += 4) {
    const slice = points.slice(i, Math.min(i + 4, bodyEnd));
    let minPt: JobMetricPoint | null = null;
    let maxPt: JobMetricPoint | null = null;
    let anomalyPt: JobMetricPoint | null = null;
    for (const pt of slice) {
      if (pt.anomaly) {
        anomalyPt = pt;
        continue;
      }
      if (pt.v === null) continue;
      if (minPt === null || (minPt.v !== null && pt.v < minPt.v)) minPt = pt;
      if (maxPt === null || (maxPt.v !== null && pt.v > maxPt.v)) maxPt = pt;
    }
    const chosen: JobMetricPoint[] = [];
    if (anomalyPt) chosen.push(anomalyPt);
    if (minPt) chosen.push(minPt);
    if (maxPt && maxPt !== minPt) chosen.push(maxPt);
    if (chosen.length === 0 && slice[0]) chosen.push(slice[0]);
    chosen.sort((a, b) => a.t - b.t);
    for (const pt of chosen) compacted.push(pt);
  }
  for (let i = bodyEnd; i < points.length; i += 1) {
    compacted.push(points[i]!);
  }
  points.length = 0;
  for (const pt of compacted.slice(-maxPoints)) {
    points.push(pt);
  }
}
