import { TUI_OUTPUT_PALETTES, type TuiColorScheme } from "./tuiOutputPalette";
import type { OutputHighlightingMode } from "./tuiOutputPreferences";

export type TuiInlineCodeRole = "path" | "cmd" | "flag" | "symbol" | "literal" | "plain";

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

export type AnsiColorSpec =
  | { readonly kind: "indexed"; readonly index: number }
  | { readonly kind: "rgb"; readonly r: number; readonly g: number; readonly b: number };

export interface AnsiTextStyle {
  readonly fg?: AnsiColorSpec;
  readonly bg?: AnsiColorSpec;
  readonly bold?: boolean;
  readonly dim?: boolean;
  readonly italic?: boolean;
  readonly underline?: boolean;
  readonly strikethrough?: boolean;
  readonly reverse?: boolean;
}

export interface TerminalOutputSpan {
  readonly text: string;
  readonly ansi?: AnsiTextStyle;
  readonly role?: TuiTerminalTokenRole;
}

export type TerminalDiffLineKind = "diff-add" | "diff-del" | "diff-hunk" | "diff-meta";

export interface TerminalOutputLine {
  readonly lineRole?: TerminalDiffLineKind;
  readonly spans: readonly TerminalOutputSpan[];
}

const FILE_EXTENSIONS = new Set([
  "astro",
  "bash",
  "c",
  "cc",
  "cfg",
  "cjs",
  "conf",
  "cpp",
  "css",
  "csv",
  "d.ts",
  "diff",
  "env",
  "fish",
  "go",
  "graphql",
  "h",
  "hpp",
  "html",
  "ini",
  "java",
  "js",
  "json",
  "jsonc",
  "jsonl",
  "jsx",
  "kt",
  "less",
  "lock",
  "log",
  "lua",
  "map",
  "md",
  "mdx",
  "mjs",
  "nix",
  "patch",
  "php",
  "plist",
  "py",
  "rb",
  "rs",
  "sass",
  "scss",
  "sh",
  "sql",
  "svelte",
  "svg",
  "swift",
  "toml",
  "ts",
  "tsx",
  "txt",
  "vue",
  "wasm",
  "xml",
  "yaml",
  "yml",
  "zsh",
]);

const EXACT_FILENAMES = new Set([
  ".editorconfig",
  ".env",
  ".env.example",
  ".env.local",
  ".eslintrc",
  ".gitattributes",
  ".gitignore",
  ".npmrc",
  ".nvmrc",
  ".prettierrc",
  "Cargo.lock",
  "Cargo.toml",
  "Dockerfile",
  "Gemfile",
  "LICENSE",
  "Makefile",
  "Procfile",
  "README",
  "tsconfig.json",
]);

const NON_PATH_SLASH_PAIRS = new Set([
  "and/or",
  "dark/light",
  "false/true",
  "in/out",
  "input/output",
  "left/right",
  "light/dark",
  "n/a",
  "no/yes",
  "off/on",
  "on/off",
  "or/and",
  "pass/fail",
  "read/write",
  "true/false",
  "up/down",
  "yes/no",
]);

const MIME_TYPE_PATTERN =
  /^(?:application|audio|font|image|message|model|multipart|text|video)\/[a-z0-9.+-]+$/i;

const STANDALONE_CLI_BINARIES = new Set([
  "awk",
  "bun",
  "cargo",
  "claude",
  "codex",
  "curl",
  "docker",
  "eslint",
  "fzf",
  "gh",
  "git",
  "grep",
  "kitty",
  "kubectl",
  "npm",
  "npx",
  "pnpm",
  "pnpx",
  "prettier",
  "pytest",
  "rg",
  "ripgrep",
  "rustc",
  "sed",
  "ssh",
  "tmux",
  "tsc",
  "uv",
  "vite",
  "vitest",
  "vp",
  "yarn",
]);

const MULTI_WORD_CLI_BINARIES = new Set([
  ...STANDALONE_CLI_BINARIES,
  "ag",
  "apt",
  "bash",
  "brew",
  "cat",
  "cd",
  "chmod",
  "chown",
  "cp",
  "deno",
  "diff",
  "echo",
  "env",
  "export",
  "fd",
  "find",
  "head",
  "jq",
  "kill",
  "launchctl",
  "ln",
  "ls",
  "make",
  "mkdir",
  "mv",
  "node",
  "nohup",
  "open",
  "patch",
  "pip",
  "pkill",
  "ps",
  "pwd",
  "python",
  "python3",
  "rm",
  "rmdir",
  "rsync",
  "scp",
  "sh",
  "sort",
  "sudo",
  "systemctl",
  "tail",
  "tar",
  "tee",
  "touch",
  "tr",
  "tree",
  "tsx",
  "uname",
  "uniq",
  "unzip",
  "wc",
  "wget",
  "which",
  "xargs",
  "zip",
  "zsh",
]);

const LITERAL_KEYWORDS = new Set([
  "false",
  "False",
  "Infinity",
  "NaN",
  "None",
  "True",
  "nil",
  "null",
  "true",
  "undefined",
]);

const NEGATIVE_NUMBER_PATTERN = /^-\d+(?:\.\d+)?$/;
const FLAG_PATTERN = /^(?:--[a-zA-Z0-9][a-zA-Z0-9_.-]*(?:=[^\s]*)?|-[a-zA-Z][a-zA-Z0-9]*)$/;
const ENV_VAR_NAME_PATTERN = /^\$(?:\{[A-Za-z_][A-Za-z0-9_]*\}|[A-Za-z_][A-Za-z0-9_]*)$/;
const UPPER_ENV_SNAKE_PATTERN = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;
const ENV_ASSIGNMENT_PATTERN = /^[A-Z][A-Z0-9_]{1,}=[^\s]*$/;

const NUMERIC_OR_UNIT_PATTERN =
  /^-?(?:\d[\d_]*(?:\.\d+)?|0x[0-9a-fA-F_]+|0b[01_]+|0o[0-7_]+)(?:ms|ns|us|µs|s|m|h|d|B|KB|KiB|MB|MiB|GB|GiB|px|rem|em|vh|vw|%)?$/i;
const SEMVER_PATTERN = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{3,8}$/;
const PORT_OR_HOST_PATTERN = /^(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])?:\d{2,5}$/;
const GIT_SHA_PATTERN = /^[0-9a-f]{7,40}$/;

const FILE_WITH_LINE_COL_PATTERN = /^(.*?):(\d+)(?::(\d+))?$/;
const QUOTED_LITERAL_PATTERN = /^(?:"[^"\n]*"|'[^'\n]*'|`[^`\n]*`)$/;
const SCOPED_PACKAGE_PATTERN = /^@[a-z0-9._-]+\/[a-z0-9._-]+$/i;

function stripTrailingLineColumn(value: string): { base: string; hasLineRef: boolean } {
  const match = FILE_WITH_LINE_COL_PATTERN.exec(value);
  if (!match?.[1]) {
    return { base: value, hasLineRef: false };
  }
  return { base: match[1], hasLineRef: true };
}

function hasKnownFileExtension(filename: string): boolean {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".d.ts")) return true;
  const dotIndex = lower.lastIndexOf(".");
  if (dotIndex <= 0 || dotIndex === lower.length - 1) return false;
  const ext = lower.slice(dotIndex + 1);
  return FILE_EXTENSIONS.has(ext);
}

function isLikelyFilePath(trimmed: string): boolean {
  if (trimmed.length === 0 || /\s/.test(trimmed)) return false;
  if (/^https?:\/\//i.test(trimmed)) return false;
  if (MIME_TYPE_PATTERN.test(trimmed)) return false;
  if (NON_PATH_SLASH_PAIRS.has(trimmed.toLowerCase())) return false;
  if (/^\d+\/\d+$/.test(trimmed)) return false;
  if (SCOPED_PACKAGE_PATTERN.test(trimmed)) return false;

  const { base, hasLineRef } = stripTrailingLineColumn(trimmed);
  if (EXACT_FILENAMES.has(base)) return true;

  if (hasLineRef) {
    if (
      base.includes("/") ||
      base.includes("\\") ||
      hasKnownFileExtension(base) ||
      EXACT_FILENAMES.has(base)
    ) {
      return true;
    }
  }

  if (
    base.startsWith("~/") ||
    base.startsWith("./") ||
    base.startsWith("../") ||
    base.startsWith("/") ||
    /^[A-Za-z]:[\\/]/.test(base)
  ) {
    return base.length > 1;
  }

  if (base.includes("/") || base.includes("\\")) {
    const normalized = base.replaceAll("\\", "/");
    const segments = normalized.split("/").filter((segment) => segment.length > 0);
    if (segments.length >= 2) {
      const validSegments = segments.every((segment) => /^[A-Za-z0-9@._*+?{}[\]-]+$/.test(segment));
      if (!validSegments) return false;
      if (segments.length >= 3 || hasKnownFileExtension(base)) return true;
      // Avoid misclassifying short slash-paired prose/acronyms like `CI/CD`, `React/Next`, `HTTP/2`.
      const [first, second] = segments;
      if (!first || !second) return false;
      const isShortUpperOrDigit = (s: string) => /^[A-Z0-9._-]{1,6}$/.test(s);
      const isTitleWord = (s: string) => /^[A-Z][a-z]{1,}$/.test(s);
      if (
        (isShortUpperOrDigit(first) && isShortUpperOrDigit(second)) ||
        (isTitleWord(first) && isTitleWord(second))
      ) {
        return false;
      }
      if (/^[A-Z][A-Z0-9._-]*$/.test(first) && /^\d+$/.test(second)) {
        return false;
      }
      return true;
    }
  }

  return hasKnownFileExtension(base) && /^[A-Za-z0-9@._/-]+$/.test(base);
}

function isLikelyCommand(trimmed: string): boolean {
  if (/^(?:\$|❯|%)\s+\S+/.test(trimmed)) return true;

  // Shell chains / pipes like `cat foo | rg bar` or `pnpm test && pnpm build`
  if (/\s(?:\|\||&&|\|)\s/.test(trimmed) && /^[A-Za-z0-9_./~$-]/.test(trimmed)) {
    return true;
  }

  const tokens = trimmed.split(/\s+/);
  const firstToken = tokens[0] ?? "";

  if (tokens.length === 1) {
    return STANDALONE_CLI_BINARIES.has(firstToken);
  }

  // Leading ENV=val followed by a command token
  let commandToken = firstToken;
  if (ENV_ASSIGNMENT_PATTERN.test(firstToken) && tokens.length >= 2) {
    commandToken = tokens[1] ?? "";
  }

  const commandBasename = commandToken.split("/").pop() ?? commandToken;
  if (MULTI_WORD_CLI_BINARIES.has(commandBasename)) {
    return true;
  }

  // Command invocation with explicit --flag argument
  if (
    /^[a-zA-Z0-9._/-]+$/.test(commandToken) &&
    tokens.slice(1).some((token) => FLAG_PATTERN.test(token))
  ) {
    return true;
  }

  return false;
}

function isLikelySymbol(trimmed: string): boolean {
  if (/^<\/?[A-Za-z][A-Za-z0-9.-]*(?:\s*\/)?>$/.test(trimmed)) return true; // JSX/HTML tag

  if (/\s/.test(trimmed)) {
    if (/^[A-Za-z_$][A-Za-z0-9_$.]*\([^()\n]*\)$/.test(trimmed)) {
      return true;
    }
    return false;
  }

  if (SCOPED_PACKAGE_PATTERN.test(trimmed)) return true;
  if (/^[A-Za-z_$][A-Za-z0-9_$]*\([^()\n]*\)$/.test(trimmed)) return true;
  if (/^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)+$/.test(trimmed)) {
    return true;
  }
  if (/^[A-Za-z_][A-Za-z0-9_]*(?:::[A-Za-z_][A-Za-z0-9_]*)+$/.test(trimmed)) {
    return true;
  }
  if (/^[A-Z][a-z0-9]+(?:[A-Z][A-Za-z0-9]*)+$/.test(trimmed)) {
    return true;
  }
  if (/^[a-z][a-z0-9]*[A-Z][A-Za-z0-9]*$/.test(trimmed)) {
    return true;
  }
  if (/^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/.test(trimmed)) {
    return true;
  }
  if (/^\.[a-z][a-z0-9-]{2,}$/.test(trimmed)) {
    return true;
  }

  return false;
}

export function classifyInlineCodeRole(codeText: string): TuiInlineCodeRole {
  const trimmed = codeText.trim();
  if (trimmed.length === 0 || trimmed.length > 240) {
    return "plain";
  }

  if (
    ENV_VAR_NAME_PATTERN.test(trimmed) ||
    UPPER_ENV_SNAKE_PATTERN.test(trimmed) ||
    ENV_ASSIGNMENT_PATTERN.test(trimmed)
  ) {
    return "flag";
  }

  if (!NEGATIVE_NUMBER_PATTERN.test(trimmed) && FLAG_PATTERN.test(trimmed)) {
    return "flag";
  }

  if (
    LITERAL_KEYWORDS.has(trimmed) ||
    NUMERIC_OR_UNIT_PATTERN.test(trimmed) ||
    SEMVER_PATTERN.test(trimmed) ||
    HEX_COLOR_PATTERN.test(trimmed) ||
    PORT_OR_HOST_PATTERN.test(trimmed) ||
    QUOTED_LITERAL_PATTERN.test(trimmed) ||
    (GIT_SHA_PATTERN.test(trimmed) && /\d/.test(trimmed) && /[a-f]/.test(trimmed))
  ) {
    return "literal";
  }

  if (isLikelyFilePath(trimmed)) {
    return "path";
  }

  if (isLikelyCommand(trimmed)) {
    return "cmd";
  }

  if (isLikelySymbol(trimmed)) {
    return "symbol";
  }

  return "plain";
}

const ANSI_TOKEN_PATTERN = /\x1b(?:\][^\x07\x1b]*(?:\x07|\x1b\\)|\[([0-9:;?]*)([@-~]))/g;

function normalizeAnsiStyle(style: AnsiTextStyle): AnsiTextStyle | undefined {
  if (
    style.fg === undefined &&
    style.bg === undefined &&
    !style.bold &&
    !style.dim &&
    !style.italic &&
    !style.underline &&
    !style.strikethrough &&
    !style.reverse
  ) {
    return undefined;
  }
  return style;
}

function ansiStylesEqual(a: AnsiTextStyle | undefined, b: AnsiTextStyle | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.bold === b.bold &&
    a.dim === b.dim &&
    a.italic === b.italic &&
    a.underline === b.underline &&
    a.strikethrough === b.strikethrough &&
    a.reverse === b.reverse &&
    ansiColorEqual(a.fg, b.fg) &&
    ansiColorEqual(a.bg, b.bg)
  );
}

function ansiColorEqual(a: AnsiColorSpec | undefined, b: AnsiColorSpec | undefined): boolean {
  if (a === b) return true;
  if (!a || !b || a.kind !== b.kind) return false;
  if (a.kind === "indexed" && b.kind === "indexed") {
    return a.index === b.index;
  }
  if (a.kind === "rgb" && b.kind === "rgb") {
    return a.r === b.r && a.g === b.g && a.b === b.b;
  }
  return false;
}

function clampByte(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(255, Math.round(value)));
}

function parseSgrParameters(rawParams: string, current: AnsiTextStyle): AnsiTextStyle {
  if (rawParams.length === 0) {
    return {};
  }

  const tokens = rawParams.split(";");
  let next: {
    fg?: AnsiColorSpec;
    bg?: AnsiColorSpec;
    bold?: boolean;
    dim?: boolean;
    italic?: boolean;
    underline?: boolean;
    strikethrough?: boolean;
    reverse?: boolean;
  } = { ...current };

  const applyExtendedColor = (target: "fg" | "bg", subParts: readonly string[]): void => {
    const mode = Number.parseInt(subParts[0] ?? "", 10);
    if (mode === 5 && subParts[1] !== undefined) {
      const idx = Number.parseInt(subParts[1], 10);
      if (Number.isInteger(idx) && idx >= 0 && idx <= 255) {
        next[target] = { kind: "indexed", index: idx };
      }
    } else if (mode === 2) {
      const offset = subParts.length >= 5 ? 2 : 1;
      const r = Number.parseInt(subParts[offset] ?? "", 10);
      const g = Number.parseInt(subParts[offset + 1] ?? "", 10);
      const b = Number.parseInt(subParts[offset + 2] ?? "", 10);
      if (Number.isInteger(r) && Number.isInteger(g) && Number.isInteger(b)) {
        next[target] = {
          kind: "rgb",
          r: clampByte(r),
          g: clampByte(g),
          b: clampByte(b),
        };
      }
    }
  };

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";
    if (token.includes(":")) {
      const subParts = token.split(":");
      const head = Number.parseInt(subParts[0] ?? "", 10);
      if (head === 38) {
        applyExtendedColor("fg", subParts.slice(1));
        continue;
      }
      if (head === 48) {
        applyExtendedColor("bg", subParts.slice(1));
        continue;
      }
      if (head === 4) {
        next.underline = subParts[1] !== "0";
        continue;
      }
    }

    const code = token.length === 0 ? 0 : Number.parseInt(token, 10);
    if (!Number.isInteger(code)) continue;

    if (code === 0) {
      next = {};
    } else if (code === 1) {
      next.bold = true;
    } else if (code === 2) {
      next.dim = true;
    } else if (code === 3) {
      next.italic = true;
    } else if (code === 4) {
      next.underline = true;
    } else if (code === 7) {
      next.reverse = true;
    } else if (code === 9) {
      next.strikethrough = true;
    } else if (code === 22) {
      delete next.bold;
      delete next.dim;
    } else if (code === 23) {
      delete next.italic;
    } else if (code === 24) {
      delete next.underline;
    } else if (code === 27) {
      delete next.reverse;
    } else if (code === 29) {
      delete next.strikethrough;
    } else if (code >= 30 && code <= 37) {
      next.fg = { kind: "indexed", index: code - 30 };
    } else if (code === 39) {
      delete next.fg;
    } else if (code >= 40 && code <= 47) {
      next.bg = { kind: "indexed", index: code - 40 };
    } else if (code === 49) {
      delete next.bg;
    } else if (code >= 90 && code <= 97) {
      next.fg = { kind: "indexed", index: code - 90 + 8 };
    } else if (code >= 100 && code <= 107) {
      next.bg = { kind: "indexed", index: code - 100 + 8 };
    } else if (code === 38 || code === 48) {
      const target = code === 38 ? "fg" : "bg";
      const mode = Number.parseInt(tokens[index + 1] ?? "", 10);
      if (mode === 5) {
        const colorIndex = Number.parseInt(tokens[index + 2] ?? "", 10);
        if (Number.isInteger(colorIndex) && colorIndex >= 0 && colorIndex <= 255) {
          next[target] = { kind: "indexed", index: colorIndex };
        }
        index += 2;
      } else if (mode === 2) {
        const r = Number.parseInt(tokens[index + 2] ?? "", 10);
        const g = Number.parseInt(tokens[index + 3] ?? "", 10);
        const b = Number.parseInt(tokens[index + 4] ?? "", 10);
        if (Number.isInteger(r) && Number.isInteger(g) && Number.isInteger(b)) {
          next[target] = {
            kind: "rgb",
            r: clampByte(r),
            g: clampByte(g),
            b: clampByte(b),
          };
        }
        index += 4;
      }
    }
  }

  return next;
}

export function xterm256IndexToRgb(index: number): string {
  const clamped = Math.max(0, Math.min(255, Math.round(index)));
  if (clamped < 16) {
    return `var(--tui-ansi-${clamped})`;
  }
  if (clamped >= 232) {
    const shade = 8 + (clamped - 232) * 10;
    return `rgb(${shade} ${shade} ${shade})`;
  }
  const offset = clamped - 16;
  const rStep = Math.floor(offset / 36);
  const gStep = Math.floor((offset % 36) / 6);
  const bStep = offset % 6;
  const toChannel = (step: number) => (step === 0 ? 0 : 55 + step * 40);
  return `rgb(${toChannel(rStep)} ${toChannel(gStep)} ${toChannel(bStep)})`;
}

type RgbTuple = readonly [number, number, number];

function parseRgbTuple(color: string): RgbTuple | undefined {
  if (color.startsWith("#") && color.length === 7) {
    return [
      Number.parseInt(color.slice(1, 3), 16),
      Number.parseInt(color.slice(3, 5), 16),
      Number.parseInt(color.slice(5, 7), 16),
    ];
  }
  const match = /^rgb\((\d+)[ ,]+(\d+)[ ,]+(\d+)\)$/.exec(color);
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function ansiSpecToRgbTuple(color: AnsiColorSpec, theme: TuiColorScheme): RgbTuple | undefined {
  if (color.kind === "rgb") {
    return [color.r, color.g, color.b];
  }
  if (color.index < 16) {
    const paletteHex = TUI_OUTPUT_PALETTES.default[theme].ansi[color.index];
    return paletteHex ? parseRgbTuple(paletteHex) : undefined;
  }
  return parseRgbTuple(xterm256IndexToRgb(color.index));
}

function relativeLuminance([r, g, b]: RgbTuple): number {
  const channel = (value: number) => {
    const scaled = value / 255;
    return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrastRatioRgb(a: RgbTuple, b: RgbTuple): number {
  const lumA = relativeLuminance(a);
  const lumB = relativeLuminance(b);
  return (Math.max(lumA, lumB) + 0.05) / (Math.min(lumA, lumB) + 0.05);
}

export function resolveAnsiBadgeContrastColor(
  bg: AnsiColorSpec,
  fg: AnsiColorSpec | undefined,
  theme: TuiColorScheme,
): string | undefined {
  const bgRgb = ansiSpecToRgbTuple(bg, theme);
  if (!bgRgb) return undefined;
  if (fg) {
    const fgRgb = ansiSpecToRgbTuple(fg, theme);
    if (fgRgb && contrastRatioRgb(fgRgb, bgRgb) >= 3) {
      return undefined;
    }
  }
  return relativeLuminance(bgRgb) > 0.35 ? "#1f2328" : "#ffffff";
}

export function ansiColorToCss(color: AnsiColorSpec): string {
  if (color.kind === "indexed") {
    return xterm256IndexToRgb(color.index);
  }
  return `rgb(${color.r} ${color.g} ${color.b})`;
}

export function hasAnsiSequences(text: string): boolean {
  if (!text.includes("\u001b")) return false;
  ANSI_TOKEN_PATTERN.lastIndex = 0;
  const matched = ANSI_TOKEN_PATTERN.test(text);
  ANSI_TOKEN_PATTERN.lastIndex = 0;
  return matched;
}

function normalizeCarriageReturns(line: string): string {
  if (!line.includes("\r")) return line;
  const parts = line.split("\r");
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    const part = parts[i];
    if (part !== undefined && part.length > 0) {
      return part;
    }
  }
  return "";
}

export function stripAnsiSequences(text: string): string {
  return text
    .replaceAll("\r\n", "\n")
    .replace(ANSI_TOKEN_PATTERN, "")
    .split("\n")
    .map(normalizeCarriageReturns)
    .join("\n");
}

const MAX_TERMINAL_SPANS = 2000;

export function parseAnsiLines(text: string): TerminalOutputLine[] {
  const normalized = text.replaceAll("\r\n", "\n");
  const rawLines = normalized.split("\n");
  const lines: TerminalOutputLine[] = [];
  let activeStyle: AnsiTextStyle = {};
  let totalSpans = 0;

  for (const unnormalizedLine of rawLines) {
    const rawLine = normalizeCarriageReturns(unnormalizedLine);
    if (totalSpans >= MAX_TERMINAL_SPANS) {
      const plain = rawLine.replace(ANSI_TOKEN_PATTERN, "");
      lines.push({ spans: plain.length > 0 ? [{ text: plain }] : [] });
      continue;
    }
    const spans: TerminalOutputSpan[] = [];
    let lastIndex = 0;
    ANSI_TOKEN_PATTERN.lastIndex = 0;

    const pushSegment = (segmentText: string) => {
      if (segmentText.length === 0) return;
      const normalizedStyle = normalizeAnsiStyle(activeStyle);
      const previous = spans[spans.length - 1];
      if (previous && ansiStylesEqual(previous.ansi, normalizedStyle)) {
        spans[spans.length - 1] = {
          text: previous.text + segmentText,
          ...(normalizedStyle ? { ansi: normalizedStyle } : {}),
        };
      } else {
        spans.push({
          text: segmentText,
          ...(normalizedStyle ? { ansi: normalizedStyle } : {}),
        });
      }
    };

    let match: RegExpExecArray | null;
    while ((match = ANSI_TOKEN_PATTERN.exec(rawLine)) !== null) {
      if (match.index > lastIndex) {
        pushSegment(rawLine.slice(lastIndex, match.index));
      }
      const params = match[1];
      const finalByte = match[2];
      if (finalByte === "m" && params !== undefined && !params.startsWith("?")) {
        activeStyle = parseSgrParameters(params, activeStyle);
      }
      lastIndex = match.index + match[0].length;
    }

    if (lastIndex < rawLine.length) {
      pushSegment(rawLine.slice(lastIndex));
    }

    totalSpans += spans.length;
    lines.push({ spans });
  }

  return lines;
}

const MAX_SEMANTIC_HIGHLIGHT_LINES = 500;
const MAX_SEMANTIC_LINE_LENGTH = 2000;

const DIFF_META_PREFIX_PATTERN =
  /^(?:diff --git |index [0-9a-f]+\.\.[0-9a-f]+|new file mode \d+|deleted file mode \d+|rename (?:from|to) |similarity index \d+%|--- (?:a\/|\/dev\/null)|[+]{3} (?:b\/|\/dev\/null))/;
const DIFF_HUNK_PATTERN = /^(@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@)(.*)$/;
const PROMPT_LINE_PATTERN = /^(\s*(?:\$|❯|%)\s+)(\S+)([\s\S]*)$/;
const HEADER_LINE_PATTERN = /^(?:MCP call|Output:|Stdout:|Stderr:|Command:|Exit code \d+)$/;

// Order matters: more specific tokens before general tokens.
const TERMINAL_INLINE_TOKEN_PATTERN = new RegExp(
  [
    // ISO timestamps or bracketed clock timestamps
    String.raw`(?:\[\d{2}:\d{2}:\d{2}(?:\.\d+)?\]|\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\b)`,
    // Error log tokens & error names
    String.raw`(?:\b(?:ERROR|ERR|FATAL|PANIC|FAIL|FAILED|FAILURE)\b|\bexit code [1-9]\d*\b|\b(?:Type|Reference|Syntax|Range)Error(?=:|\b))`,
    // Warning log tokens
    String.raw`\b(?:WARN|WARNING|DEPRECATED|SKIP|SKIPPED)\b`,
    // Pass / OK log tokens
    String.raw`(?:\b(?:PASS|PASSED|OK|SUCCESS|SUCCEEDED|DONE)\b|\bexit code 0\b|✓|✔)`,
    // Info / Debug log tokens
    String.raw`\b(?:INFO|DEBUG|TRACE)\b`,
    // Error/failure cross glyphs
    String.raw`(?:✗|✘)`,
    // HTTP(S) URLs
    String.raw`https?:\/\/[^\s"'\`<>()\[\]]+`,
    // File paths with optional :line(:col)
    String.raw`(?:~\/|\.\.?\/|\/[A-Za-z0-9._-]+)(?:[A-Za-z0-9._\/-]*[A-Za-z0-9._-])?(?::\d+(?::\d+)?)?`,
    // Relative workspace file paths with extension or multi-segment folder path + optional :line(:col)
    String.raw`\b[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+\.[A-Za-z0-9]{1,8}(?::\d+(?::\d+)?)?\b`,
    String.raw`\b[A-Za-z0-9._-]+\.(?:tsx?|jsx?|mjs|cjs|jsonc?|jsonl|css|scss|md|mdx|toml|ya?ml|rs|py|go|sh|sql|txt|log)(?::\d+(?::\d+)?)?\b`,
    // CLI flags & env vars
    String.raw`(?:\B--[A-Za-z0-9][A-Za-z0-9_.-]*(?:=[^\s,;)]+)?|\B-[A-Za-z][A-Za-z0-9]*\b|\b[A-Z][A-Z0-9_]{2,}=[^\s,;)]+)`,
    // Durations & numbers & hex SHAs
    String.raw`(?:\b0x[0-9a-fA-F]+\b|\b\d+(?:\.\d+)?(?:ms|ns|us|µs|s|m|h|B|KB|MB|GB|%)?\b)`,
    // Comments starting with ` # ...`
    String.raw`(?<=^|\s)#[^\n]*`,
  ].join("|"),
  "g",
);

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

function tokenizePlainSegment(text: string, ansi: AnsiTextStyle | undefined): TerminalOutputSpan[] {
  if (text.length === 0) return [];
  if (text.length > MAX_SEMANTIC_LINE_LENGTH) {
    return [{ text, ...(ansi ? { ansi } : {}), role: "plain" }];
  }

  const result: TerminalOutputSpan[] = [];
  let lastIndex = 0;
  TERMINAL_INLINE_TOKEN_PATTERN.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = TERMINAL_INLINE_TOKEN_PATTERN.exec(text)) !== null) {
    if (match.index > lastIndex) {
      result.push({
        text: text.slice(lastIndex, match.index),
        ...(ansi ? { ansi } : {}),
        role: "plain",
      });
    }
    const token = match[0];
    result.push({
      text: token,
      ...(ansi ? { ansi } : {}),
      role: classifyTerminalMatchedToken(token),
    });
    lastIndex = match.index + token.length;
  }

  if (lastIndex < text.length) {
    result.push({
      text: text.slice(lastIndex),
      ...(ansi ? { ansi } : {}),
      role: "plain",
    });
  }

  return result;
}

function tokenizePromptLine(
  lineText: string,
  ansi: AnsiTextStyle | undefined,
): TerminalOutputSpan[] | null {
  const match = PROMPT_LINE_PATTERN.exec(lineText);
  if (!match) return null;
  const promptSigil = match[1] ?? "";
  const cmdName = match[2] ?? "";
  const rest = match[3] ?? "";

  const spans: TerminalOutputSpan[] = [
    { text: promptSigil, ...(ansi ? { ansi } : {}), role: "prompt" },
    { text: cmdName, ...(ansi ? { ansi } : {}), role: "cmd" },
  ];
  if (rest.length > 0) {
    spans.push(...tokenizePlainSegment(rest, ansi));
  }
  return spans;
}

const UNPREFIXED_COMMAND_LINE_PATTERN =
  /^((?:\/(?:usr\/)?(?:local\/)?bin\/(?:ba|z)?sh|pnpm|npm|npx|yarn|bun|git|gh|cargo|vp|vitest|rg|pytest|uv|docker|kubectl|eslint|prettier|tsc|node|python3?)\b)([\s\S]*)$/;

function tokenizeLeadingCommandLine(
  lineText: string,
  ansi: AnsiTextStyle | undefined,
): TerminalOutputSpan[] | null {
  const match = UNPREFIXED_COMMAND_LINE_PATTERN.exec(lineText);
  if (!match) return null;
  const cmdName = match[1] ?? "";
  const rest = match[2] ?? "";
  if (rest.length > 0 && !/^\s/.test(rest)) return null;

  const spans: TerminalOutputSpan[] = [{ text: cmdName, ...(ansi ? { ansi } : {}), role: "cmd" }];
  if (rest.length > 0) {
    spans.push(...tokenizePlainSegment(rest, ansi));
  }
  return spans;
}

function tokenizeJsonKeyLine(
  lineText: string,
  ansi: AnsiTextStyle | undefined,
): TerminalOutputSpan[] | null {
  const match = /^(\s*)("(?:[^"\\]|\\.)*")(\s*:\s*)(.*)$/.exec(lineText);
  if (!match) return null;
  const indent = match[1] ?? "";
  const key = match[2] ?? "";
  const colon = match[3] ?? "";
  const rest = match[4] ?? "";

  const spans: TerminalOutputSpan[] = [];
  if (indent.length > 0) {
    spans.push({ text: indent, ...(ansi ? { ansi } : {}), role: "plain" });
  }
  spans.push({ text: key, ...(ansi ? { ansi } : {}), role: "symbol" });
  spans.push({ text: colon, ...(ansi ? { ansi } : {}), role: "plain" });

  const trimmedRest = rest.replace(/,\s*$/, "");
  const trailingComma = rest.slice(trimmedRest.length);
  if (
    /^"(?:[^"\\]|\\.)*"$/.test(trimmedRest) ||
    /^(?:true|false|null|-?\d+(?:\.\d+)?)$/.test(trimmedRest)
  ) {
    spans.push({ text: trimmedRest, ...(ansi ? { ansi } : {}), role: "literal" });
    if (trailingComma.length > 0) {
      spans.push({ text: trailingComma, ...(ansi ? { ansi } : {}), role: "plain" });
    }
  } else if (rest.length > 0) {
    spans.push(...tokenizePlainSegment(rest, ansi));
  }

  return spans;
}

export function tokenizeTerminalOutputLines(
  text: string,
  mode: OutputHighlightingMode = "semantic",
): TerminalOutputLine[] {
  if (mode === "off") {
    const plainLines = stripAnsiSequences(text).split("\n");
    return plainLines.map((line) => ({
      spans: line.length > 0 ? [{ text: line, role: "plain" }] : [],
    }));
  }

  const ansiLines = parseAnsiLines(text);
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
    const hasExplicitAnsiFg = line.spans.some((span) => span.ansi?.fg !== undefined);

    if (DIFF_META_PREFIX_PATTERN.test(plainLine)) {
      inDiffBlock = true;
      pushSemanticLine({
        lineRole: "diff-meta",
        spans: line.spans.map((span) => (span.ansi?.fg ? span : { ...span, role: "diff-meta" })),
      });
      continue;
    }

    const hunkMatch = DIFF_HUNK_PATTERN.exec(plainLine);
    if (hunkMatch) {
      inDiffBlock = true;
      if (hasExplicitAnsiFg) {
        pushSemanticLine({ lineRole: "diff-hunk", spans: line.spans });
      } else {
        const hunkHeader = hunkMatch[1] ?? plainLine;
        const contextTail = hunkMatch[2] ?? "";
        const singleAnsi = line.spans[0]?.ansi;
        pushSemanticLine({
          lineRole: "diff-hunk",
          spans: [
            { text: hunkHeader, ...(singleAnsi ? { ansi: singleAnsi } : {}), role: "diff-hunk" },
            ...(contextTail.length > 0
              ? [
                  {
                    text: contextTail,
                    ...(singleAnsi ? { ansi: singleAnsi } : {}),
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
          spans: line.spans.map((span) => (span.ansi?.fg ? span : { ...span, role: "diff-add" })),
        });
        continue;
      }
      if (plainLine.startsWith("-") && !plainLine.startsWith("--- ")) {
        pushSemanticLine({
          lineRole: "diff-del",
          spans: line.spans.map((span) => (span.ansi?.fg ? span : { ...span, role: "diff-del" })),
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

    if (line.spans.length === 1 && !line.spans[0]!.ansi?.fg) {
      const onlySpan = line.spans[0]!;
      if (HEADER_LINE_PATTERN.test(plainLine.trim())) {
        pushSemanticLine({
          spans: [
            {
              text: onlySpan.text,
              ...(onlySpan.ansi ? { ansi: onlySpan.ansi } : {}),
              role: "header",
            },
          ],
        });
        continue;
      }
      const promptSpans = tokenizePromptLine(onlySpan.text, onlySpan.ansi);
      if (promptSpans) {
        pushSemanticLine({ spans: promptSpans });
        continue;
      }
      if (lineIndex === 0) {
        const leadingCmdSpans = tokenizeLeadingCommandLine(onlySpan.text, onlySpan.ansi);
        if (leadingCmdSpans) {
          pushSemanticLine({ spans: leadingCmdSpans });
          continue;
        }
      }
      const jsonSpans = tokenizeJsonKeyLine(onlySpan.text, onlySpan.ansi);
      if (jsonSpans) {
        pushSemanticLine({ spans: jsonSpans });
        continue;
      }
    }

    const tokenizedSpans: TerminalOutputSpan[] = [];
    for (const span of line.spans) {
      if (span.ansi?.fg) {
        tokenizedSpans.push(span);
      } else {
        tokenizedSpans.push(...tokenizePlainSegment(span.text, span.ansi));
      }
    }
    pushSemanticLine({ spans: tokenizedSpans });
  }

  return result;
}
