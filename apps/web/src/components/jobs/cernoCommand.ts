const CERNO_VALUE_FLAGS = new Set([
  "--log",
  "--tee",
  "--max-wait",
  "--stall-timeout",
  "--stall-sec",
  "--cwd",
  "--pid",
  "-n",
  "--lines",
  "--interval",
]);

export function flattenShellContinuations(rawCommand: string): string {
  return rawCommand.replace(/\\\r?\n\s*/gu, " ");
}

/**
 * Splits a shell command line into top-level command segments separated by unquoted
 * `&&`, `||`, `;`, `|`, or newlines, tokenizing each segment with basic quote stripping.
 */
function parseShellSegments(rawCommand: string): ReadonlyArray<ReadonlyArray<string>> {
  const flat = flattenShellContinuations(rawCommand);
  const segments: Array<Array<string>> = [];
  let currentSegment: Array<string> = [];
  let currentToken = "";
  let inToken = false;
  let quote: "'" | '"' | null = null;

  const pushToken = () => {
    if (inToken) {
      currentSegment.push(currentToken);
      currentToken = "";
      inToken = false;
    }
  };
  const pushSegment = () => {
    pushToken();
    if (currentSegment.length > 0) {
      segments.push(currentSegment);
      currentSegment = [];
    }
  };

  for (let i = 0; i < flat.length; i += 1) {
    const ch = flat[i]!;
    if (quote !== null) {
      if (ch === "\\" && quote === '"' && i + 1 < flat.length) {
        currentToken += flat[++i]!;
      } else if (ch === quote) {
        quote = null;
      } else {
        currentToken += ch;
      }
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      inToken = true;
      continue;
    }
    if (ch === "\\" && i + 1 < flat.length) {
      currentToken += flat[++i]!;
      inToken = true;
      continue;
    }
    if (ch === "\n" || ch === "\r" || ch === ";") {
      pushSegment();
      continue;
    }
    if (ch === "&" && flat[i + 1] === "&") {
      pushSegment();
      i += 1;
      continue;
    }
    if (ch === "|") {
      pushSegment();
      if (flat[i + 1] === "|") i += 1;
      continue;
    }
    if (/\s/u.test(ch)) {
      pushToken();
      continue;
    }
    currentToken += ch;
    inToken = true;
  }
  pushSegment();
  return segments;
}

function stripLeadingEnvPrefix(tokens: ReadonlyArray<string>): ReadonlyArray<string> {
  let idx = 0;
  while (idx < tokens.length) {
    const tok = tokens[idx]!;
    if (tok === "env" && idx + 1 < tokens.length) {
      idx += 1;
      while (idx < tokens.length && tokens[idx]!.startsWith("-")) idx += 1;
      continue;
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(tok)) {
      idx += 1;
      continue;
    }
    break;
  }
  return tokens.slice(idx);
}

function findCernoSegment(rawCommand: string): ReadonlyArray<string> | null {
  for (const segment of parseShellSegments(rawCommand)) {
    const rest = stripLeadingEnvPrefix(segment);
    if (rest.length < 2) continue;
    const head = rest[0]!.split("/").pop() ?? "";
    const sub = rest[1]!;
    if (head === "cerno" && (sub === "watch" || sub === "tail")) {
      return rest;
    }
  }
  return null;
}

function extractTailPositionalArg(tokens: ReadonlyArray<string>): string | null {
  let idx = 2;
  while (idx < tokens.length) {
    const tok = tokens[idx]!;
    if (tok === "--") {
      return idx + 1 < tokens.length ? tokens[idx + 1]! : null;
    }
    if (tok.startsWith("-")) {
      if (tok.includes("=")) {
        idx += 1;
      } else {
        idx += CERNO_VALUE_FLAGS.has(tok) ? 2 : 1;
      }
      continue;
    }
    return tok;
  }
  return null;
}

export function unwrapCernoTokens(tokens: ReadonlyArray<string>): ReadonlyArray<string> {
  const head = tokens[0]?.split("/").pop() ?? "";
  if (head !== "cerno") return tokens;
  const sub = tokens[1];
  if (sub === "watch") {
    const dashDash = tokens.indexOf("--", 2);
    if (dashDash >= 0 && dashDash + 1 < tokens.length) return tokens.slice(dashDash + 1);
    let idx = 2;
    while (idx < tokens.length && tokens[idx]!.startsWith("-")) {
      const tok = tokens[idx]!;
      idx += !tok.includes("=") && CERNO_VALUE_FLAGS.has(tok) ? 2 : 1;
    }
    return idx < tokens.length ? tokens.slice(idx) : tokens;
  }
  if (sub === "tail") {
    const file = extractTailPositionalArg(tokens);
    if (file) return ["tail", file];
  }
  return tokens;
}

export function isCernoCommand(rawCommand: string | null | undefined): boolean {
  if (!rawCommand) return false;
  return findCernoSegment(rawCommand) !== null;
}

export function extractCernoLogPath(rawCommand: string | null | undefined): string | null {
  if (!rawCommand) return null;
  const cernoTokens = findCernoSegment(rawCommand);
  if (!cernoTokens) return null;

  for (let idx = 2; idx < cernoTokens.length; idx += 1) {
    const tok = cernoTokens[idx]!;
    if (tok === "--") break;
    if (tok === "--log" || tok === "--tee") {
      return idx + 1 < cernoTokens.length ? cernoTokens[idx + 1]! : null;
    }
    if (tok.startsWith("--log=")) return tok.slice("--log=".length) || null;
    if (tok.startsWith("--tee=")) return tok.slice("--tee=".length) || null;
  }

  if (cernoTokens[1] === "tail") {
    return extractTailPositionalArg(cernoTokens);
  }
  return null;
}

export function normalizeShellCommand(value: string): string {
  return flattenShellContinuations(value).replace(/\s+/gu, " ").trim();
}

export function unwrapCernoCommand(rawCommand: string | null | undefined): string | null {
  if (!rawCommand) return null;
  const cernoTokens = findCernoSegment(rawCommand);
  if (!cernoTokens) return null;
  const unwrapped = unwrapCernoTokens(cernoTokens);
  if (unwrapped.length === 0) return null;
  return unwrapped.join(" ").replace(/\s+/gu, " ").trim();
}
