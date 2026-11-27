// @effect-diagnostics nodeBuiltinImport:off - Headless playbook gate uses node:* directly without Effect.
/**
 * `playbook check generations`: one umbrella generator and honest `GENERATED from <source>` markers
 * (PLAYBOOK §4). `command: null` declares no generator and forbids any `GENERATED from` marker.
 */
import * as NodePath from "node:path";

import {
  firstSymlinkSegment,
  listedFiles,
  parseConf,
  readWorktreeFile,
  showFile,
  treeFiles,
  worktreePathExists,
} from "../git.ts";
import { failed, passed, unproven, type CheckResult } from "../result.ts";
import { runStep, tailLines } from "../steps.ts";
import { isRecord } from "../strictJson.ts";

const CHECK = "generations";
const MARKER_RE = /^\s*(?:\/\/|#|--|\/\*+|<!--|\*|;)\s*GENERATED from (\S+)/;
const EMITS_RE = /emits:\s*\[([^\]]*)\]/g;
const RUNNERS = new Set(["node", "bash", "sh", "python3", "python", "tsx", "deno", "bun"]);

function splitShellWords(command: string): string[] {
  const words: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (current) {
        words.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }
  if (current) words.push(current);
  return words;
}

/** The repo script file the umbrella command executes, or null when not resolvable. */
function entryScript(root: string, command: string): string | null {
  let words = splitShellWords(command);
  let scriptName: string | null = null;
  if (
    words.length >= 3 &&
    (words[0] === "pnpm" || words[0] === "npm" || words[0] === "yarn" || words[0] === "bun") &&
    words[1] === "run"
  ) {
    scriptName = words[2] ?? null;
  } else if (words.length === 2 && (words[0] === "pnpm" || words[0] === "yarn")) {
    scriptName = words[1] ?? null;
  }
  if (scriptName !== null) {
    const pkgText = readWorktreeFile(root, "package.json");
    if (!pkgText) return null;
    try {
      const pkg = JSON.parse(pkgText) as unknown;
      const script = isRecord(pkg) && isRecord(pkg.scripts) ? pkg.scripts[scriptName] : undefined;
      if (typeof script !== "string") return null;
      words = splitShellWords(script);
    } catch {
      return null;
    }
  }
  for (const word of words) {
    if (RUNNERS.has(word) || word.startsWith("-")) continue;
    const rel = NodePath.posix.normalize(word.replace(/^\.\//, ""));
    if (readWorktreeFile(root, rel) !== null) return rel;
  }
  return null;
}

/** Paths listed in `emits: ["a", "b"]` literals inside a script. */
function emittedPaths(text: string | null): ReadonlySet<string> {
  const out = new Set<string>();
  if (!text) return out;
  for (const match of text.matchAll(EMITS_RE)) {
    for (const item of match[1]!.matchAll(/"([^"]+)"/g)) {
      if (item[1]) out.add(item[1]);
    }
  }
  return out;
}

/** `(file, source)` for every listed worktree file carrying `GENERATED from <source>` in its first 5 lines. */
function findGeneratedMarkers(
  root: string,
  files?: ReadonlyArray<string>,
): ReadonlyArray<{ readonly file: string; readonly source: string }> {
  const list = files ?? listedFiles(root) ?? [];
  const out: Array<{ readonly file: string; readonly source: string }> = [];
  for (const rel of list) {
    const text = readWorktreeFile(root, rel);
    if (text === null) continue;
    const head = text.slice(0, 4096).split("\n").slice(0, 5);
    for (const line of head) {
      const match = MARKER_RE.exec(line);
      if (match?.[1]) {
        out.push({ file: rel, source: match[1].replace(/[.,;:)]+$/, "") });
        break;
      }
    }
  }
  return out;
}

function declaredGenerators(conf: Readonly<Record<string, ReadonlyArray<string>>>): string[] {
  const out: string[] = [];
  for (const line of conf.surface_generators ?? []) {
    for (const raw of line.split(",")) {
      const trimmed = raw.trim().replace(/^\.\//, "");
      if (trimmed) out.push(NodePath.posix.normalize(trimmed));
    }
  }
  return out;
}

/** Files the base umbrella already emitted that still carry a GENERATED marker (trusted for design gate skip). */
export function trustedEmits(
  root: string,
  base: string | null,
  command: string | null,
): ReadonlySet<string> {
  if (!command) return new Set();
  const entry = entryScript(root, command);
  if (!entry) return new Set();
  const marked = new Set(findGeneratedMarkers(root).map((m) => m.file));
  const listed = new Set(
    [...emittedPaths(readWorktreeFile(root, entry))].filter((p) => marked.has(p)),
  );
  if (!base) return listed;
  const baseEntry = showFile(root, base, entry);
  if (baseEntry === null) return new Set();
  const baseSet = emittedPaths(baseEntry);
  return new Set([...listed].filter((p) => baseSet.has(p)));
}

export async function generationsGate(input: {
  readonly root: string;
  readonly settings: Readonly<Record<string, unknown>>;
  readonly declaration: Readonly<Record<string, unknown>>;
  readonly base: string | null;
  readonly ask: (reason: string) => Promise<boolean>;
  readonly signal?: AbortSignal | undefined;
}): Promise<ReadonlyArray<CheckResult>> {
  const command = input.settings.command;
  const markers = findGeneratedMarkers(input.root);
  if (command === null) {
    if (markers.length > 0) {
      return [
        failed(
          CHECK,
          `${markers.length} file(s) carry a GENERATED marker, but contracts.generations.command is null`,
          {
            errors: markers.map((m) => `${m.file}: GENERATED from ${m.source}`),
            fix: "declare the umbrella command in contracts.generations.command, or remove the markers",
          },
        ),
      ];
    }
    return [passed(CHECK, "no generator declared, and no file carries a GENERATED marker")];
  }
  if (typeof command !== "string" || !command.trim()) {
    return [failed(CHECK, "contracts.generations.command must be a non-empty string or null")];
  }

  const out: CheckResult[] = [];
  const ran = await runStep(
    input.root,
    `${command} --check`,
    { PLAYBOOK_BASE: input.base ?? "" },
    undefined,
    input.signal,
  );
  if (ran.code === null) {
    return [unproven(CHECK, `${command} --check did not run: ${ran.why}`)];
  }
  if (ran.code !== 0) {
    out.push(
      failed(CHECK, `${command} --check exited ${ran.code}: a generated copy is stale`, {
        errors: tailLines(ran, 8),
        fix: command,
      }),
    );
  }

  const entry = entryScript(input.root, command);
  if (entry === null) {
    if (markers.length > 0) {
      out.push(
        unproven(
          CHECK,
          `cannot find the file ${command} runs, so ${markers.length} GENERATED marker(s) cannot be held to the umbrella`,
          { fix: "name a script file in contracts.generations.command" },
        ),
      );
    }
  } else {
    const conf = parseConf(readWorktreeFile(input.root, ".tree-guard.conf") ?? "");
    const genValues = conf.surface_generators ?? [];
    const extraGens = declaredGenerators(conf);
    const contracts = isRecord(input.declaration.contracts) ? input.declaration.contracts : {};
    const design = isRecord(contracts.design) ? contracts.design : {};
    const clientScopes = Array.isArray(design.client)
      ? design.client
          .filter((c): c is string => typeof c === "string")
          .map((c) => c.replace(/\/+$/, ""))
      : [];
    const bad: string[] = [];
    if (genValues.length > 1) {
      bad.push(
        ".tree-guard.conf declares surface_generators more than once: list them comma-separated",
      );
    }
    const validExtras: string[] = [];
    for (const rel of extraGens) {
      if (NodePath.isAbsolute(rel) || rel.split("/")[0] === "..") {
        bad.push(`surface_generators: ${rel} is outside the repo`);
        continue;
      }
      const link = firstSymlinkSegment(input.root, rel);
      if (link) {
        bad.push(`surface_generators: ${rel} passes through symlink ${link}`);
        continue;
      }
      const text = readWorktreeFile(input.root, rel);
      if (text === null) {
        bad.push(`surface_generators: ${rel} does not exist`);
        continue;
      }
      if (clientScopes.some((c) => rel === c || rel.startsWith(`${c}/`))) {
        bad.push(
          `surface_generators: ${rel} is client code (contracts.design.client), not a generator`,
        );
      }
      if (emittedPaths(text).has(rel)) {
        bad.push(`surface_generators: ${rel} lists itself in its emits`);
      }
      validExtras.push(rel);
    }
    const scripts = [entry, ...validExtras];
    const umbrellaText = scripts.map((s) => readWorktreeFile(input.root, s) ?? "").join("\n");
    for (const m of markers) {
      if (!worktreePathExists(input.root, m.source)) {
        bad.push(`${m.file}: its source ${m.source} does not exist`);
      }
      if (m.file !== entry && !umbrellaText.includes(m.file)) {
        bad.push(
          `${m.file}: carries the GENERATED marker, but ${entry} names no generator that emits it`,
        );
      }
    }
    if (bad.length > 0) {
      out.push(
        failed(CHECK, `${bad.length} GENERATED marker problem(s)`, {
          errors: bad,
          files: [entry],
          fix: `add the file's generator to ${entry}, or remove the marker`,
        }),
      );
    } else if (input.base) {
      const baseList = treeFiles(input.root, input.base);
      if (baseList !== null) {
        const had = new Set(baseList);
        const before = new Set(emittedPaths(showFile(input.root, input.base, entry)));
        const nowEmits = new Set<string>();
        for (const s of scripts) {
          for (const p of emittedPaths(readWorktreeFile(input.root, s))) nowEmits.add(p);
        }
        const markedSet = new Set(markers.map((m) => m.file));
        const widened = [...nowEmits]
          .filter((rel) => markedSet.has(rel) && had.has(rel) && !before.has(rel))
          .toSorted();
        if (widened.length > 0) {
          const reason = `generations: emits list widens over hand-written files: ${widened.join(", ").slice(0, 300)}`;
          if (!(await input.ask(reason))) {
            out.push(
              failed(
                CHECK,
                `the umbrella's emits list widens over ${widened.length} file(s) the base had and did not generate`,
                {
                  errors: widened.slice(0, 20),
                  fix: "write generated output to a new path; hand-written base files stay hand-written",
                },
              ),
            );
          }
        }
      }
    }
  }

  if (out.length === 0) {
    out.push(
      passed(
        CHECK,
        `${command} --check passed; ${markers.length} marked file(s)${entry ? `, each backed by ${entry}` : ""}`,
      ),
    );
  }
  return out;
}
