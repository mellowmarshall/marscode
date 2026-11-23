export type TuiInlineCodeRole = "path" | "cmd" | "flag" | "symbol" | "literal" | "plain";

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

  if (/\s(?:\|\||&&|\|)\s/.test(trimmed) && /^[A-Za-z0-9_./~$-]/.test(trimmed)) {
    return true;
  }

  const tokens = trimmed.split(/\s+/);
  const firstToken = tokens[0] ?? "";

  if (tokens.length === 1) {
    return STANDALONE_CLI_BINARIES.has(firstToken);
  }

  let commandToken = firstToken;
  if (ENV_ASSIGNMENT_PATTERN.test(firstToken) && tokens.length >= 2) {
    commandToken = tokens[1] ?? "";
  }

  const commandBasename = commandToken.split("/").pop() ?? commandToken;
  if (MULTI_WORD_CLI_BINARIES.has(commandBasename)) {
    return true;
  }

  if (
    /^[a-zA-Z0-9._/-]+$/.test(commandToken) &&
    tokens.slice(1).some((token) => FLAG_PATTERN.test(token))
  ) {
    return true;
  }

  return false;
}

function isLikelySymbol(trimmed: string): boolean {
  if (/^<\/?[A-Za-z][A-Za-z0-9.-]*(?:\s*\/)?>$/.test(trimmed)) return true;

  if (/\s/.test(trimmed)) {
    return /^[A-Za-z_$][A-Za-z0-9_$.]*\([^()\n]*\)$/.test(trimmed);
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

/** Classifies a short markdown inline code snippet into a semantic palette role. */
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
