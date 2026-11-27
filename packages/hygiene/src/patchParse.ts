/** Added lines and new files of a `git diff -U0 --no-color` patch. */

export interface AddedLine {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

export interface ParsedPatch {
  readonly added: ReadonlyArray<AddedLine>;
  readonly newFiles: ReadonlyArray<string>;
}

function unquote(path: string): string {
  if (!path.startsWith('"')) return path;
  try {
    return JSON.parse(path) as string;
  } catch {
    return path.slice(1, -1);
  }
}

function headerTarget(raw: string): string {
  const quoted = raw.lastIndexOf(' "b/');
  if (quoted >= 0) return unquote(raw.slice(quoted + 1)).replace(/^b\//, "");
  return raw.slice(raw.lastIndexOf(" b/") + 3);
}

export function parsePatch(patch: string): ParsedPatch {
  const added: AddedLine[] = [];
  const newFiles: string[] = [];
  let file = "";
  let headerPath = "";
  let inHeader = false;
  let next = 0;
  for (const raw of patch.split("\n")) {
    if (raw.startsWith("diff --git ")) {
      file = "";
      headerPath = headerTarget(raw);
      inHeader = true;
      next = 0;
    } else if (inHeader && raw.startsWith("new file mode")) {
      newFiles.push(headerPath);
    } else if (inHeader && raw.startsWith("+++ ")) {
      const target = raw.slice(4);
      file = target === "/dev/null" ? "" : unquote(target).replace(/^b\//, "");
    } else if (raw.startsWith("@@")) {
      inHeader = false;
      const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
      next = hunk ? Number(hunk[1]) : 0;
    } else if (file && raw.startsWith("+")) {
      added.push({ file, line: next, text: raw.slice(1) });
      next += 1;
    } else if (file && raw.startsWith(" ")) {
      next += 1;
    }
  }
  return { added, newFiles };
}

export const PATCH_ARGS = [
  "-U0",
  "--no-color",
  "--no-ext-diff",
  "--no-renames",
  "--src-prefix=a/",
  "--dst-prefix=b/",
];
