// @effect-diagnostics nodeBuiltinImport:off - PLAYBOOK §16 text guard: collects every text a forge CLI call would send, inline or from files.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { GH_API_OTHER_VALUE_FLAGS, matchGhValueFlag } from "./ghArgParse.ts";

const MAX_TEXT_BYTES = 1024 * 1024;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const UTF8 = new TextDecoder("utf-8", { fatal: true });

// Commands that read or address GitHub but post no text another person can read.
const READ_ONLY_COMMANDS = new Set(
  "alias attestation auth browse cache codespace completion config extension gpg-key help search secret ssh-key status version --version --help -h".split(
    " ",
  ),
);
const READ_ONLY_SUBS = new Set(
  "view list ls status diff checks clone checkout download watch".split(" "),
);
const TARGET_FLAGS = new Set(["-R", "--repo", "--hostname"]);
const BODY_FILE_COMMANDS = new Set(["issue", "pr", "release"]);

export interface PostedText {
  readonly source: string;
  readonly text: string;
}

/** Text a call would post, plus whatever the guard could not read and so must refuse. */
export interface CollectedText {
  readonly texts: PostedText[];
  readonly unreadable: string[];
  editor: boolean;
}

export interface TextReadOptions {
  /** Reads the command's stdin once; absent where stdin belongs to someone else (the hook). */
  readonly readStdin?: (() => string) | undefined;
}

const emptyCollected = (): CollectedText => ({ texts: [], unreadable: [], editor: false });

/** Adds a referenced file (`-` for stdin); anything not a small regular file is unreadable. */
function addFile(
  out: CollectedText,
  source: string,
  ref: string,
  cwd: string,
  options: TextReadOptions,
): string | null {
  if (ref === "-") {
    if (!options.readStdin) {
      out.unreadable.push(`${source} (stdin)`);
      return null;
    }
    const text = options.readStdin();
    out.texts.push({ source, text });
    return text;
  }
  try {
    const stat = NodeFS.statSync(NodePath.resolve(cwd, ref));
    if (!stat.isFile() || stat.size > MAX_TEXT_BYTES) {
      out.unreadable.push(`${source} (not a regular file under ${MAX_TEXT_BYTES} bytes)`);
      return null;
    }
    const text = NodeFS.readFileSync(NodePath.resolve(cwd, ref), "utf8");
    out.texts.push({ source, text });
    return text;
  } catch {
    out.unreadable.push(`${source} (missing)`);
    return null;
  }
}

/** Any value of 16+ base64 characters that decodes to UTF-8 text is also scanned decoded. */
function addMaybeBase64(out: CollectedText, source: string, value: string): void {
  out.texts.push({ source, text: value });
  const compact = value.replace(/\s+/g, "");
  if (compact.length < 16 || !BASE64_RE.test(compact)) return;
  try {
    const text = UTF8.decode(Buffer.from(compact, "base64"));
    out.texts.push({ source: `${source}(base64)`, text });
  } catch {
    // Not UTF-8 text: binary data carries no prose to scan.
  }
}

function addJsonStrings(out: CollectedText, source: string, value: unknown): void {
  if (typeof value === "string") addMaybeBase64(out, source, value);
  else if (Array.isArray(value))
    value.forEach((item, i) => addJsonStrings(out, `${source}.${i}`, item));
  else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) addJsonStrings(out, `${source}.${key}`, item);
  }
}

function addApiInput(out: CollectedText, raw: string | null): void {
  if (raw === null) return;
  try {
    addJsonStrings(out, "input", JSON.parse(raw) as unknown);
  } catch {
    // A raw (non-JSON) body is already scanned as the file text.
  }
}

/** Every `-f`/`-F` field value and every string in `--input` of a writing `gh api` call. */
export function collectApiTexts(
  args: ReadonlyArray<string>,
  apiIdx: number,
  cwd: string,
  options: TextReadOptions,
): CollectedText {
  const out = emptyCollected();
  const copy = [...args];
  for (let i = 0; i < copy.length; i += 1) {
    if (i === apiIdx) continue;
    const a = copy[i]!;
    if (a === "--") break;
    const eq = a.startsWith("-") ? a.indexOf("=") : -1;
    if (GH_API_OTHER_VALUE_FLAGS.has(eq === -1 ? a : a.slice(0, eq))) {
      if (eq === -1) i += 1;
      continue;
    }
    const input = matchGhValueFlag(copy, i, null, "--input");
    if (input) {
      addApiInput(out, addFile(out, "input", input.value, cwd, options));
      i += input.step;
      continue;
    }
    const raw = matchGhValueFlag(copy, i, "-f", "--raw-field");
    const typed = raw ? null : matchGhValueFlag(copy, i, "-F", "--field");
    const field = raw ?? typed;
    if (!field) continue;
    i += field.step;
    const sep = field.value.indexOf("=");
    const key = sep === -1 ? field.value : field.value.slice(0, sep);
    const value = sep === -1 ? "" : field.value.slice(sep + 1);
    const source = `field.${key}`;
    out.texts.push({ source: `${source}.key`, text: key });
    if (typed && value.startsWith("@")) {
      const text = addFile(out, source, value.slice(1), cwd, options);
      if (text !== null) addMaybeBase64(out, `${source}.file`, text);
    } else addMaybeBase64(out, source, value);
  }
  return out;
}

function flagSource(flag: string): string {
  const name = flag.replace(/^-+/, "");
  const short: Readonly<Record<string, string>> = {
    t: "title",
    b: "body",
    n: "notes",
    d: "desc",
    F: "body-file",
  };
  return flag.startsWith("--") ? name : (short[name] ?? name);
}

/** The text-file reference a flag carries, if any. */
function fileRefFlag(cmd: string, flag: string, value: string): string | null {
  if (flag === "--input" || flag.endsWith("-file")) return value;
  if (flag !== "-F" && flag !== "--field") return null;
  if (BODY_FILE_COMMANDS.has(cmd)) return value;
  const sep = value.indexOf("=");
  return sep !== -1 && value.slice(sep + 1).startsWith("@") ? value.slice(sep + 2) : null;
}

/** Flags that take no value, so the next argument is a positional (often a local file path). */
const VALUELESS_FLAGS = new Set([
  "--clobber",
  "--draft",
  "--fill",
  "--generate-notes",
  "--latest",
  "--merge",
  "--prerelease",
  "--private",
  "--public",
  "--rebase",
  "--squash",
  "--verify-tag",
  "--web",
]);

const isPlainFlag = (a: string) => /^-{1,2}[A-Za-z][A-Za-z0-9-]*$/.test(a);

/**
 * A positional that names a local file posts its contents and basename, never the local path
 * GitHub does not see; a non-regular file (FIFO, device) is refused; anything else is text.
 */
function addPositional(
  out: CollectedText,
  source: string,
  arg: string,
  cwd: string,
  options: TextReadOptions,
  textOnly = false,
): void {
  if (arg === "-") {
    addFile(out, source, arg, cwd, options);
    return;
  }
  const abs = NodePath.resolve(cwd, arg);
  let stat: NodeFS.Stats | null = null;
  try {
    stat = NodeFS.statSync(abs);
  } catch {
    stat = null;
  }
  if (stat === null) {
    out.texts.push({ source, text: arg });
    return;
  }
  out.texts.push({ source: "file-name", text: NodePath.basename(abs) });
  if (stat.isDirectory()) return;
  if (!stat.isFile() || !isBinaryFile(abs)) {
    addFile(out, "file", abs, cwd, options);
    return;
  }
  if (textOnly || stat.size > MAX_BINARY_BYTES) {
    out.unreadable.push(
      `file (binary${textOnly ? " gist file" : ` over ${MAX_BINARY_BYTES} bytes`})`,
    );
    return;
  }
  out.texts.push({ source: "file(strings)", text: printableRuns(NodeFS.readFileSync(abs)) });
}

const MAX_BINARY_BYTES = 512 * 1024 * 1024;

/** Printable ASCII runs of 6+ bytes, one per line: what a reader of the asset could extract. */
function printableRuns(bytes: Buffer): string {
  const runs: string[] = [];
  let start = -1;
  for (let i = 0; i <= bytes.length; i += 1) {
    const b = i < bytes.length ? bytes[i]! : 0;
    const printable = (b >= 0x20 && b < 0x7f) || b === 0x09;
    if (printable && start === -1) start = i;
    else if (!printable && start !== -1) {
      if (i - start >= 6) runs.push(bytes.toString("latin1", start, i));
      start = -1;
    }
  }
  return runs.join("\n");
}

/** A NUL byte in the first 8 KiB marks a binary file (archive, image, AppImage). */
function isBinaryFile(abs: string): boolean {
  const fd = NodeFS.openSync(abs, "r");
  try {
    const head = Buffer.alloc(8192);
    const read = NodeFS.readSync(fd, head, 0, head.length, 0);
    return head.subarray(0, read).includes(0);
  } finally {
    NodeFS.closeSync(fd);
  }
}

/**
 * Every argv value after the command words of a high-level forge call, plus every text file it
 * references. Target-only values (`-R`, `--hostname`) and bare flags or numbers are skipped.
 */
export function collectArgvTexts(
  args: ReadonlyArray<string>,
  words: ReadonlyArray<{ readonly index: number; readonly word: string }>,
  cwd: string,
  options: TextReadOptions,
): CollectedText | null {
  const cmd = words[0]?.word ?? "";
  const sub = words[1]?.word ?? "";
  if (READ_ONLY_COMMANDS.has(cmd) || READ_ONLY_SUBS.has(sub)) return null;
  const out = emptyCollected();
  const wordIdx = new Set(words.slice(0, 2).map((w) => w.index));
  const gistEdit = cmd === "gist" && sub === "edit";
  let gistEditText = false;
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i]!;
    if (wordIdx.has(i) || a === "--") continue;
    if (TARGET_FLAGS.has(a)) {
      i += 1;
      continue;
    }
    const eq = a.startsWith("--") ? a.indexOf("=") : -1;
    const flag = eq === -1 ? a : a.slice(0, eq);
    if (TARGET_FLAGS.has(flag) || /^-R./.test(a)) continue;
    if (flag === "--editor" || (flag === "-e" && (cmd === "issue" || cmd === "pr"))) {
      out.editor = true;
      continue;
    }
    if (gistEdit && ["-a", "--add", "-d", "--desc"].includes(flag)) gistEditText = true;
    // `-bTEXT`: a short flag with its value attached.
    if (/^-[A-Za-z]./.test(a) && !a.startsWith("--")) {
      const attachedRef = fileRefFlag(cmd, a.slice(0, 2), a.slice(2).replace(/^=/, ""));
      if (attachedRef !== null) addFile(out, flagSource(a.slice(0, 2)), attachedRef, cwd, options);
      else out.texts.push({ source: flagSource(a.slice(0, 2)), text: a.slice(2) });
      continue;
    }
    const separate = eq === -1 && isPlainFlag(a) && i + 1 < args.length;
    const value = eq !== -1 ? a.slice(eq + 1) : separate ? args[i + 1]! : null;
    const fileRef = value === null ? null : fileRefFlag(cmd, flag, value);
    if (fileRef !== null) {
      addFile(out, flagSource(flag), fileRef, cwd, options);
      if (separate) i += 1;
    } else if (eq !== -1) {
      out.texts.push({ source: flagSource(flag), text: value! });
    } else if (!isPlainFlag(a) && !/^\d+$/.test(a)) {
      const prev = args[i - 1] ?? "";
      // After a flag this may be the flag's posted value, so its raw text is always scanned.
      if (isPlainFlag(prev) && !VALUELESS_FLAGS.has(prev)) {
        out.texts.push({ source: flagSource(prev), text: a });
      }
      addPositional(
        out,
        isPlainFlag(prev) ? flagSource(prev) : "arg",
        a,
        cwd,
        options,
        cmd === "gist",
      );
    }
  }
  if (gistEdit && !gistEditText) out.editor = true;
  return out;
}
