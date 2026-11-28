const CONTROL_KEYWORDS = new Set([
  "if",
  "then",
  "elif",
  "else",
  "fi",
  "for",
  "while",
  "until",
  "do",
  "done",
  "case",
  "esac",
  "function",
  "{",
  "}",
  "!",
]);

export const normalizePath = (rawPath: string, cwd: string): string => {
  const trimmed = rawPath.trim().replace(/^['"]|['"]$/g, "");
  const combined = trimmed.startsWith("/") ? trimmed : `${cwd}/${trimmed}`;
  const segments: Array<string> = [];
  for (const segment of combined.split("/")) {
    if (segment === "..") segments.pop();
    else if (segment !== "" && segment !== ".") segments.push(segment);
  }
  return `/${segments.join("/")}`;
};

export const basename = (value: string): string => value.split("/").at(-1) ?? value;

type ShellOp = "start" | "&&" | "||" | ";" | "|" | "\n";

interface RawShellSegment {
  readonly text: string;
  readonly opBefore: ShellOp;
  readonly opAfter: ShellOp;
  readonly heredocWrite?: { readonly path: string; readonly content: string };
}

const stripHeredocs = (
  command: string,
  cwd: string,
): {
  readonly script: string;
  readonly writesByLine: ReadonlyMap<number, { path: string; content: string }>;
} => {
  const writesByLine = new Map<number, { path: string; content: string }>();
  const lines = command.split("\n");
  const kept: Array<string> = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const heredoc = /<<-?\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z_][\w-]*))/.exec(line);
    if (!heredoc) {
      kept.push(line);
      continue;
    }
    const delimiter = heredoc[1] ?? heredoc[2] ?? heredoc[3]!;
    const redirect = /(?:^|\s)(?:>|tee\s+(?:-a\s+)?)\s*('[^']+'|"[^"]+"|[^\s;&|]+)/.exec(line);
    const bodyLines: Array<string> = [];
    let j = i + 1;
    while (j < lines.length && lines[j]!.trim() !== delimiter) {
      bodyLines.push(lines[j]!);
      j += 1;
    }
    const lineIndex = kept.length;
    if (redirect?.[1]) {
      writesByLine.set(lineIndex, {
        path: normalizePath(redirect[1], cwd),
        content: bodyLines.join("\n"),
      });
    }
    kept.push(line.replace(heredoc[0], ""));
    i = j;
  }
  return { script: kept.join("\n"), writesByLine };
};

const splitShellSegments = (
  script: string,
  writesByLine: ReadonlyMap<number, { path: string; content: string }>,
): ReadonlyArray<RawShellSegment> => {
  const raw: Array<RawShellSegment> = [];
  let current = "";
  let opBefore: ShellOp = "start";
  let lineIndex = 0;
  let segmentLine = 0;
  let quote: "'" | '"' | null = null;

  const push = (opAfter: ShellOp) => {
    const text = current.trim();
    if (text !== "") {
      const heredocWrite = writesByLine.get(segmentLine);
      raw.push({
        text,
        opBefore,
        opAfter,
        ...(heredocWrite ? { heredocWrite } : {}),
      });
    }
    current = "";
    opBefore = opAfter;
    segmentLine = lineIndex;
  };

  for (let i = 0; i < script.length; i += 1) {
    const ch = script[i]!;
    const next = script[i + 1];
    if (quote === "'") {
      current += ch;
      if (ch === "\n") lineIndex += 1;
      if (ch === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (ch === "\\" && next !== undefined) {
        current += ch + next;
        if (next === "\n") lineIndex += 1;
        i += 1;
        continue;
      }
      current += ch;
      if (ch === "\n") lineIndex += 1;
      if (ch === '"') quote = null;
      continue;
    }
    if (ch === "\\" && next !== undefined) {
      current += ch + next;
      if (next === "\n") lineIndex += 1;
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"') {
      if (current.trim() === "") segmentLine = lineIndex;
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "#" && (current.length === 0 || /\s/.test(current.at(-1)!))) {
      while (i < script.length && script[i] !== "\n") i += 1;
      lineIndex += 1;
      push("\n");
      continue;
    }
    if (ch === "\n") {
      lineIndex += 1;
      push("\n");
      continue;
    }
    if (ch === ";") {
      push(";");
      continue;
    }
    if (ch === "&" && next === "&") {
      push("&&");
      i += 1;
      continue;
    }
    if (ch === "|" && next === "|") {
      push("||");
      i += 1;
      continue;
    }
    if (ch === "|") {
      push("|");
      continue;
    }
    if (current.trim() === "" && !/\s/.test(ch)) segmentLine = lineIndex;
    current += ch;
  }
  push("start");
  return raw;
};

const tokenizeSegment = (segment: string): ReadonlyArray<string> => {
  const words: Array<string> = [];
  let token = "";
  let hasToken = false;
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < segment.length; i += 1) {
    const ch = segment[i]!;
    const next = segment[i + 1];
    if (quote === "'") {
      if (ch === "'") quote = null;
      else token += ch;
      continue;
    }
    if (quote === '"') {
      if (ch === "\\" && next !== undefined) {
        token += next;
        i += 1;
      } else if (ch === '"') {
        quote = null;
      } else {
        token += ch;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      hasToken = true;
      continue;
    }
    if (ch === "\\" && next !== undefined) {
      token += next;
      hasToken = true;
      i += 1;
      continue;
    }
    if (/\s/.test(ch)) {
      if (hasToken) {
        words.push(token);
        token = "";
        hasToken = false;
      }
      continue;
    }
    token += ch;
    hasToken = true;
  }
  if (hasToken) words.push(token);
  return words;
};

export interface ShellStatement {
  readonly env: ReadonlyMap<string, string>;
  readonly argv: ReadonlyArray<string>;
  readonly provenSucceeded: boolean;
  readonly write?: { readonly path: string; readonly content: string };
}

const isSetErrexit = (argv: ReadonlyArray<string>): boolean =>
  argv[0] === "set" && argv.slice(1).some((arg) => /^-[A-Za-z]*e[A-Za-z]*$/.test(arg));

export const parseShellStatements = (
  command: string,
  cwd: string,
  callSucceeded: boolean,
): ReadonlyArray<ShellStatement> => {
  const { script, writesByLine } = stripHeredocs(command, cwd);
  const segments = splitShellSegments(script, writesByLine);

  // Split into top-level lists separated by `;` or `\n`. A statement inside a list is proven to
  // have executed and succeeded only when the call succeeded, the list uses only `&&` (no `||`,
  // `|`, or shell control keywords), and either it is the final list or `set -e` is active.
  const lists: Array<Array<RawShellSegment>> = [];
  let currentList: Array<RawShellSegment> = [];
  for (const seg of segments) {
    currentList.push(seg);
    if (seg.opAfter === ";" || seg.opAfter === "\n" || seg.opAfter === "start") {
      lists.push(currentList);
      currentList = [];
    }
  }
  if (currentList.length > 0) lists.push(currentList);

  const parsed: Array<ShellStatement> = [];
  let errexit = false;
  for (let listIndex = 0; listIndex < lists.length; listIndex += 1) {
    const list = lists[listIndex]!;
    const isFinalList = listIndex === lists.length - 1;
    const tokenizedList = list.map((seg) => {
      const rawWords = tokenizeSegment(seg.text);
      const cleaned: Array<string> = [];
      let redirectTarget: string | null = null;
      for (let i = 0; i < rawWords.length; i += 1) {
        const word = rawWords[i]!;
        if (/^(?:\d?>{1,2}|<)$/.test(word)) {
          if (/^>{1,2}$/.test(word) && rawWords[i + 1]) redirectTarget = rawWords[i + 1]!;
          i += 1;
          continue;
        }
        if (/^(?:\d?>{1,2}\S+|<\S+|\d>&\d)$/.test(word)) {
          const out = /^>{1,2}(\S+)$/.exec(word);
          if (out?.[1]) redirectTarget = out[1];
          continue;
        }
        cleaned.push(word);
      }
      const env = new Map<string, string>();
      let idx = 0;
      if (cleaned[idx] === "env") idx += 1;
      while (idx < cleaned.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(cleaned[idx]!)) {
        const eq = cleaned[idx]!.indexOf("=");
        env.set(cleaned[idx]!.slice(0, eq), cleaned[idx]!.slice(eq + 1));
        idx += 1;
      }
      const argv = cleaned.slice(idx);
      let write = seg.heredocWrite;
      if (!write && redirectTarget !== null && (argv[0] === "echo" || argv[0] === "printf")) {
        const payload = argv.slice(1).find((arg) => arg.trimStart().startsWith("{"));
        if (payload !== undefined) {
          write = { path: normalizePath(redirectTarget, cwd), content: payload };
        }
      }
      return { seg, env, argv, write };
    });

    const listHasAmbiguousFlow = tokenizedList.some(
      ({ seg, argv }, idx) =>
        (idx > 0 && seg.opBefore !== "&&") ||
        (idx < tokenizedList.length - 1 && seg.opAfter !== "&&") ||
        argv.some((word) => CONTROL_KEYWORDS.has(word)),
    );
    const listProven = callSucceeded && !listHasAmbiguousFlow && (isFinalList || errexit);
    for (const { env, argv, write } of tokenizedList) {
      if (argv.length > 0 || env.size > 0 || write !== undefined) {
        parsed.push({
          env,
          argv,
          provenSucceeded: listProven,
          ...(write ? { write } : {}),
        });
      }
      if (!listHasAmbiguousFlow && isSetErrexit(argv)) errexit = true;
    }
  }
  return parsed;
};
