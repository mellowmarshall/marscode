import type { OutputHighlightingMode } from "@t3tools/contracts/settings";
import {
  normalizeTerminalOutput,
  TERMINAL_OUTPUT_TAIL_CHARS,
  TERMINAL_PALETTES,
  terminalOutputPlainText,
  terminalOutputSpans,
  type TerminalSpan,
  type TerminalSpanStyle,
} from "@t3tools/shared/terminalOutput";

export type TuiTerminalTokenRole =
  | "plain"
  | "prompt"
  | "cmd"
  | "flag"
  | "path"
  | "url"
  | "symbol"
  | "literal"
  | "ok"
  | "warn"
  | "err"
  | "info"
  | "timestamp"
  | "comment"
  | "header"
  | "diff-add"
  | "diff-del"
  | "diff-hunk"
  | "diff-meta";

export interface TerminalOutputSpan {
  readonly text: string;
  readonly style?: TerminalSpanStyle;
  readonly role?: TuiTerminalTokenRole;
}

export type TerminalDiffLineKind = "diff-add" | "diff-del" | "diff-hunk" | "diff-meta";

export interface TerminalOutputLine {
  readonly lineRole?: TerminalDiffLineKind;
  readonly spans: readonly TerminalOutputSpan[];
}

const ESC = "\u001b";
const BEL = "\u0007";
const ANSI_DETECT_PATTERN = new RegExp(
  `${ESC}(?:\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)|\\[[0-9:;?]*[@-~])`,
);

export function hasAnsiSequences(text: string): boolean {
  return text.includes(ESC) && ANSI_DETECT_PATTERN.test(text);
}

function normalizeLineText(text: string, preNormalized: boolean): string {
  const lf = text.replaceAll("\r\n", "\n");
  if (preNormalized || (!lf.includes(ESC) && !lf.includes("\r"))) {
    return lf;
  }
  return normalizeTerminalOutput(lf, Math.max(lf.length, TERMINAL_OUTPUT_TAIL_CHARS)).text;
}

export function stripAnsiSequences(text: string, preNormalized = false): string {
  const normalized = normalizeLineText(text, preNormalized);
  return terminalOutputPlainText(normalized);
}

const MAX_TERMINAL_SPANS = 2000;
const MAX_SEMANTIC_HIGHLIGHT_LINES = 500;
const MAX_SEMANTIC_LINE_LENGTH = 2000;

const DIFF_META_PREFIX_PATTERN =
  /^(?:diff --git |index [0-9a-f]+\.\.[0-9a-f]+|new file mode \d+|deleted file mode \d+|rename (?:from|to) |similarity index \d+%|--- (?:a\/|\/dev\/null)|[+]{3} (?:b\/|\/dev\/null))/;
const DIFF_HUNK_PATTERN = /^(@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@)(.*)$/;
const PROMPT_LINE_PATTERN = /^(\s*(?:\$|❯|%)\s+)(\S+)([\s\S]*)$/;
const HEADER_LINE_PATTERN = /^(?:MCP call|Output:|Stdout:|Stderr:|Command:|Exit code \d+)$/;

// Order matters: match specific URLs, timestamps, and log keywords before generic paths/flags.
const TERMINAL_INLINE_TOKEN_PATTERN = new RegExp(
  [
    String.raw`(?:\[\d{2}:\d{2}:\d{2}(?:\.\d+)?\]|\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\b)`,
    String.raw`(?:\b(?:ERROR|ERR|FATAL|PANIC|FAIL|FAILED|FAILURE)\b|\bexit code [1-9]\d*\b|\b(?:Type|Reference|Syntax|Range)Error(?=:|\b))`,
    String.raw`\b(?:WARN|WARNING|DEPRECATED|SKIP|SKIPPED)\b`,
    String.raw`(?:\b(?:PASS|PASSED|OK|SUCCESS|SUCCEEDED|DONE)\b|\bexit code 0\b|✓|✔)`,
    String.raw`\b(?:INFO|DEBUG|TRACE)\b`,
    String.raw`(?:✗|✘)`,
    String.raw`https?:\/\/[^\s"'\`<>()\[\]]+`,
    String.raw`(?:~\/|\.\.?\/|\/[A-Za-z0-9._-]+)(?:[A-Za-z0-9._\/-]*[A-Za-z0-9._-])?(?::\d+(?::\d+)?)?`,
    String.raw`\b[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+\.[A-Za-z0-9]{1,8}(?::\d+(?::\d+)?)?\b`,
    String.raw`\b[A-Za-z0-9._-]+\.(?:tsx?|jsx?|mjs|cjs|jsonc?|jsonl|css|scss|md|mdx|toml|ya?ml|rs|py|go|sh|sql|txt|log)(?::\d+(?::\d+)?)?\b`,
    String.raw`(?:\B--[A-Za-z0-9][A-Za-z0-9_.-]*(?:=[^\s,;)]+)?|\B-[A-Za-z][A-Za-z0-9]*\b|\b[A-Z][A-Z0-9_]{2,}=[^\s,;)]+)`,
    String.raw`(?:\b0x[0-9a-fA-F]+\b|\b\d+(?:\.\d+)?(?:ms|ns|us|µs|s|m|h|B|KB|MB|GB|%)?\b)`,
    String.raw`(?<=^|\s)#[^\n]*`,
  ].join("|"),
  "g",
);

const UNPREFIXED_COMMAND_LINE_PATTERN =
  /^((?:\/(?:usr\/)?(?:local\/)?bin\/(?:ba|z)?sh|pnpm|npm|npx|yarn|bun|git|gh|cargo|vp|vitest|rg|pytest|uv|docker|kubectl|eslint|prettier|tsc|node|python3?)\b)([\s\S]*)$/;

function hasExplicitAnsiColor(span: TerminalOutputSpan): boolean {
  return span.style?.color !== undefined || span.style?.backgroundColor !== undefined;
}

function splitTerminalSpansByLine(spans: ReadonlyArray<TerminalSpan>): TerminalOutputLine[] {
  const lines: Array<{ spans: TerminalOutputSpan[] }> = [{ spans: [] }];
  for (const span of spans) {
    const style = span.style ?? undefined;
    const parts = span.text.split("\n");
    for (let index = 0; index < parts.length; index += 1) {
      if (index > 0) {
        lines.push({ spans: [] });
      }
      const part = parts[index]!;
      if (part.length > 0) {
        lines[lines.length - 1]!.spans.push({
          text: part,
          ...(style ? { style } : {}),
        });
      }
    }
  }
  return lines;
}

function classifyTerminalMatchedToken(token: string): TuiTerminalTokenRole {
  if (token.startsWith("#")) return "comment";
  if (/^https?:\/\//i.test(token)) return "url";
  if (token.startsWith("[") || /^\d{4}-\d{2}-\d{2}[T ]/.test(token)) return "timestamp";

  if (
    /^(?:ERROR|ERR|FATAL|PANIC|FAIL|FAILED|FAILURE|✗|✘)$/.test(token) ||
    /^exit code [1-9]\d*$/.test(token) ||
    /^(?:Type|Reference|Syntax|Range)Error$/.test(token)
  ) {
    return "err";
  }

  if (/^(?:WARN|WARNING|DEPRECATED|SKIP|SKIPPED)$/.test(token)) {
    return "warn";
  }

  if (/^(?:PASS|PASSED|OK|SUCCESS|SUCCEEDED|DONE|✓|✔)$/.test(token) || token === "exit code 0") {
    return "ok";
  }

  if (/^(?:INFO|DEBUG|TRACE)$/.test(token)) {
    return "info";
  }

  if (
    token.startsWith("~/") ||
    token.startsWith("./") ||
    token.startsWith("../") ||
    token.startsWith("/") ||
    token.includes("/") ||
    /\.[A-Za-z0-9]{1,8}(?::\d+(?::\d+)?)?$/.test(token)
  ) {
    return "path";
  }

  if (token.startsWith("-") || /^[A-Z][A-Z0-9_]{2,}=/.test(token)) {
    return "flag";
  }

  return "literal";
}

function tokenizePlainSegment(
  text: string,
  style: TerminalSpanStyle | undefined,
): TerminalOutputSpan[] {
  if (text.length === 0) return [];
  if (text.length > MAX_SEMANTIC_LINE_LENGTH) {
    return [{ text, ...(style ? { style } : {}), role: "plain" }];
  }

  const result: TerminalOutputSpan[] = [];
  let lastIndex = 0;
  TERMINAL_INLINE_TOKEN_PATTERN.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = TERMINAL_INLINE_TOKEN_PATTERN.exec(text)) !== null) {
    if (match.index > lastIndex) {
      result.push({
        text: text.slice(lastIndex, match.index),
        ...(style ? { style } : {}),
        role: "plain",
      });
    }
    const token = match[0];
    result.push({
      text: token,
      ...(style ? { style } : {}),
      role: classifyTerminalMatchedToken(token),
    });
    lastIndex = match.index + token.length;
  }

  if (lastIndex < text.length) {
    result.push({
      text: text.slice(lastIndex),
      ...(style ? { style } : {}),
      role: "plain",
    });
  }

  return result;
}

function tokenizePromptLine(
  lineText: string,
  style: TerminalSpanStyle | undefined,
): TerminalOutputSpan[] | null {
  const match = PROMPT_LINE_PATTERN.exec(lineText);
  if (!match) return null;
  const promptSigil = match[1] ?? "";
  const cmdName = match[2] ?? "";
  const rest = match[3] ?? "";

  const spans: TerminalOutputSpan[] = [
    { text: promptSigil, ...(style ? { style } : {}), role: "prompt" },
    { text: cmdName, ...(style ? { style } : {}), role: "cmd" },
  ];
  if (rest.length > 0) {
    spans.push(...tokenizePlainSegment(rest, style));
  }
  return spans;
}

function tokenizeLeadingCommandLine(
  lineText: string,
  style: TerminalSpanStyle | undefined,
): TerminalOutputSpan[] | null {
  const match = UNPREFIXED_COMMAND_LINE_PATTERN.exec(lineText);
  if (!match) return null;
  const cmdName = match[1] ?? "";
  const rest = match[2] ?? "";
  if (rest.length > 0 && !/^\s/.test(rest)) return null;

  const spans: TerminalOutputSpan[] = [{ text: cmdName, ...(style ? { style } : {}), role: "cmd" }];
  if (rest.length > 0) {
    spans.push(...tokenizePlainSegment(rest, style));
  }
  return spans;
}

function tokenizeJsonKeyLine(
  lineText: string,
  style: TerminalSpanStyle | undefined,
): TerminalOutputSpan[] | null {
  const match = /^(\s*)("(?:[^"\\]|\\.)*")(\s*:\s*)(.*)$/.exec(lineText);
  if (!match) return null;
  const indent = match[1] ?? "";
  const key = match[2] ?? "";
  const colon = match[3] ?? "";
  const rest = match[4] ?? "";

  const spans: TerminalOutputSpan[] = [];
  if (indent.length > 0) {
    spans.push({ text: indent, ...(style ? { style } : {}), role: "plain" });
  }
  spans.push({ text: key, ...(style ? { style } : {}), role: "symbol" });
  spans.push({ text: colon, ...(style ? { style } : {}), role: "plain" });

  const trimmedRest = rest.replace(/,\s*$/, "");
  const trailingComma = rest.slice(trimmedRest.length);
  if (
    /^"(?:[^"\\]|\\.)*"$/.test(trimmedRest) ||
    /^(?:true|false|null|-?\d+(?:\.\d+)?)$/.test(trimmedRest)
  ) {
    spans.push({ text: trimmedRest, ...(style ? { style } : {}), role: "literal" });
    if (trailingComma.length > 0) {
      spans.push({ text: trailingComma, ...(style ? { style } : {}), role: "plain" });
    }
  } else if (rest.length > 0) {
    spans.push(...tokenizePlainSegment(rest, style));
  }

  return spans;
}

export interface TokenizeTerminalOutputOptions {
  readonly mode?: OutputHighlightingMode;
  readonly palette?: ReadonlyArray<string>;
  readonly preNormalized?: boolean;
}

export function tokenizeTerminalOutputLines(
  text: string,
  options: TokenizeTerminalOutputOptions = {},
): TerminalOutputLine[] {
  const { mode = "semantic", palette = TERMINAL_PALETTES.dark, preNormalized = false } = options;
  const normalized = normalizeLineText(text, preNormalized);

  if (mode === "off") {
    return terminalOutputPlainText(normalized)
      .split("\n")
      .map((line) => ({
        spans: line.length > 0 ? [{ text: line, role: "plain" }] : [],
      }));
  }

  const ansiLines = splitTerminalSpansByLine(
    terminalOutputSpans(normalized, palette, MAX_TERMINAL_SPANS),
  );
  if (mode === "ansi") {
    return ansiLines;
  }

  const result: TerminalOutputLine[] = [];
  let inDiffBlock = false;
  let emittedSpans = 0;

  const pushSemanticLine = (outLine: TerminalOutputLine) => {
    emittedSpans += outLine.spans.length;
    result.push(outLine);
  };

  for (let lineIndex = 0; lineIndex < ansiLines.length; lineIndex += 1) {
    const line = ansiLines[lineIndex]!;
    if (lineIndex >= MAX_SEMANTIC_HIGHLIGHT_LINES || emittedSpans >= MAX_TERMINAL_SPANS) {
      if (emittedSpans >= MAX_TERMINAL_SPANS) {
        const plain = line.spans.map((span) => span.text).join("");
        result.push({ spans: plain.length > 0 ? [{ text: plain, role: "plain" }] : [] });
      } else {
        pushSemanticLine(line);
      }
      continue;
    }

    const plainLine = line.spans.map((span) => span.text).join("");
    const lineHasExplicitAnsi = line.spans.some(hasExplicitAnsiColor);

    if (DIFF_META_PREFIX_PATTERN.test(plainLine)) {
      inDiffBlock = true;
      pushSemanticLine({
        lineRole: "diff-meta",
        spans: line.spans.map((span) =>
          hasExplicitAnsiColor(span) ? span : { ...span, role: "diff-meta" },
        ),
      });
      continue;
    }

    const hunkMatch = DIFF_HUNK_PATTERN.exec(plainLine);
    if (hunkMatch) {
      inDiffBlock = true;
      if (lineHasExplicitAnsi) {
        pushSemanticLine({ lineRole: "diff-hunk", spans: line.spans });
      } else {
        const hunkHeader = hunkMatch[1] ?? plainLine;
        const contextTail = hunkMatch[2] ?? "";
        const singleStyle = line.spans[0]?.style;
        pushSemanticLine({
          lineRole: "diff-hunk",
          spans: [
            { text: hunkHeader, ...(singleStyle ? { style: singleStyle } : {}), role: "diff-hunk" },
            ...(contextTail.length > 0
              ? [
                  {
                    text: contextTail,
                    ...(singleStyle ? { style: singleStyle } : {}),
                    role: "comment" as const,
                  },
                ]
              : []),
          ],
        });
      }
      continue;
    }

    if (inDiffBlock) {
      if (plainLine.startsWith("+") && !plainLine.startsWith("+++ ")) {
        pushSemanticLine({
          lineRole: "diff-add",
          spans: line.spans.map((span) =>
            hasExplicitAnsiColor(span) ? span : { ...span, role: "diff-add" },
          ),
        });
        continue;
      }
      if (plainLine.startsWith("-") && !plainLine.startsWith("--- ")) {
        pushSemanticLine({
          lineRole: "diff-del",
          spans: line.spans.map((span) =>
            hasExplicitAnsiColor(span) ? span : { ...span, role: "diff-del" },
          ),
        });
        continue;
      }
      if (
        !plainLine.startsWith(" ") &&
        plainLine.trim().length > 0 &&
        !plainLine.startsWith("\\")
      ) {
        inDiffBlock = false;
      }
    }

    if (line.spans.length === 1 && !hasExplicitAnsiColor(line.spans[0]!)) {
      const onlySpan = line.spans[0]!;
      if (HEADER_LINE_PATTERN.test(plainLine.trim())) {
        pushSemanticLine({
          spans: [
            {
              text: onlySpan.text,
              ...(onlySpan.style ? { style: onlySpan.style } : {}),
              role: "header",
            },
          ],
        });
        continue;
      }
      const promptSpans = tokenizePromptLine(onlySpan.text, onlySpan.style);
      if (promptSpans) {
        pushSemanticLine({ spans: promptSpans });
        continue;
      }
      if (lineIndex === 0) {
        const leadingCmdSpans = tokenizeLeadingCommandLine(onlySpan.text, onlySpan.style);
        if (leadingCmdSpans) {
          pushSemanticLine({ spans: leadingCmdSpans });
          continue;
        }
      }
      const jsonSpans = tokenizeJsonKeyLine(onlySpan.text, onlySpan.style);
      if (jsonSpans) {
        pushSemanticLine({ spans: jsonSpans });
        continue;
      }
    }

    const tokenizedSpans: TerminalOutputSpan[] = [];
    for (const span of line.spans) {
      if (hasExplicitAnsiColor(span)) {
        tokenizedSpans.push(span);
      } else {
        tokenizedSpans.push(...tokenizePlainSegment(span.text, span.style));
      }
    }
    pushSemanticLine({ spans: tokenizedSpans });
  }

  return result;
}
