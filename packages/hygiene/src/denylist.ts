// @effect-diagnostics nodeBuiltinImport:off - Reads the host-local private denylist; never copies or logs its contents.
/**
 * PLAYBOOK §16.3 host-local private denylist: `@class <id>` headers, then one case-insensitive
 * JavaScript regex per line. It lives outside every repo and must be readable by its owner only.
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { HYGIENE_CLASSES, type HygieneClass } from "./hygieneCatalog.ts";
import type { DenylistLoad, DenyRule } from "./hygieneTypes.ts";

const CLASS_IDS: ReadonlySet<string> = new Set(HYGIENE_CLASSES);

export function denylistPath(env: Readonly<Record<string, string | undefined>>): string {
  const explicit = env.MARSCODE_HYGIENE_DENYLIST?.trim();
  if (explicit) return explicit;
  const home = env.HOME?.trim() || NodeOS.homedir();
  const config = env.XDG_CONFIG_HOME?.trim() || NodePath.join(home, ".config");
  return NodePath.join(config, "marscode", "public-hygiene.denylist");
}

/** A path safe to print: the home directory (which names the owner) becomes `~`. */
export function displayPath(path: string, env: Readonly<Record<string, string | undefined>>) {
  const home = env.HOME?.trim() || NodeOS.homedir();
  return home && path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path;
}

type ParseResult =
  | { readonly kind: "loaded"; readonly rules: ReadonlyArray<DenyRule> }
  | { readonly kind: "invalid"; readonly line: number };

export function parseDenylist(text: string): ParseResult {
  const rules: DenyRule[] = [];
  let classId: HygieneClass | null = null;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? "").trim();
    if (!line || line.startsWith("#")) continue;
    const header = /^@class\s+(\S+)$/.exec(line);
    if (header) {
      const id = header[1] ?? "";
      if (!CLASS_IDS.has(id)) return { kind: "invalid", line: i + 1 };
      classId = id as HygieneClass;
      continue;
    }
    if (classId === null) return { kind: "invalid", line: i + 1 };
    try {
      rules.push({ classId, pattern: new RegExp(line, "i"), line: i + 1 });
    } catch {
      return { kind: "invalid", line: i + 1 };
    }
  }
  return { kind: "loaded", rules };
}

export function loadDenylist(
  env: Readonly<Record<string, string | undefined>> = process.env,
): DenylistLoad {
  const path = denylistPath(env);
  let stat: NodeFS.Stats;
  try {
    stat = NodeFS.statSync(path);
  } catch {
    return { kind: "missing", path };
  }
  if (!stat.isFile() || (stat.mode & 0o077) !== 0) return { kind: "invalid", path, line: 0 };
  let text: string;
  try {
    text = NodeFS.readFileSync(path, "utf8");
  } catch {
    return { kind: "invalid", path, line: 0 };
  }
  const parsed = parseDenylist(text);
  return parsed.kind === "loaded" ? parsed : { kind: "invalid", path, line: parsed.line };
}
