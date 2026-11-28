// @effect-diagnostics nodeBuiltinImport:off - Host-local Docker reap rules from the `[docker]` section of the reaper policy file.
import * as NodeFS from "node:fs";

import { defaultReaperPolicyPath } from "../ReaperPolicy.ts";
import { stripTomlCommentOutsideQuotes, unquoteTomlString } from "../ReaperPolicyToml.ts";

/** Patterns capture the owner PID in group 1. */
export interface DockerReapRules {
  readonly keepLabels: ReadonlyArray<string>;
  readonly containerPidPatterns: ReadonlyArray<RegExp>;
  readonly networkPidPatterns: ReadonlyArray<RegExp>;
}

export const EMPTY_DOCKER_REAP_RULES: DockerReapRules = {
  keepLabels: [],
  containerPidPatterns: [],
  networkPidPatterns: [],
};

const LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const MAX_ENTRIES = 32;

function tomlStringArray(raw: string): ReadonlyArray<string> {
  const body = raw.trim();
  if (!body.startsWith("[") || !body.endsWith("]")) return [];
  return [...body.slice(1, -1).matchAll(/"(?:[^"\\]|\\.)*"|'[^']*'/g)].map((m) =>
    unquoteTomlString(m[0]),
  );
}

/** Wrapped as `^(?:...)$` so a top-level alternation cannot escape the anchors. */
function compilePidPattern(raw: string): RegExp | null {
  const source = raw.replace(/^\^/, "").replace(/(?<!\\)\$$/, "");
  try {
    const re = new RegExp(`^(?:${source})$`);
    const groups = new RegExp(`${source}|`).exec("")!.length - 1;
    return groups >= 1 ? re : null;
  } catch {
    return null;
  }
}

function pidPatterns(values: ReadonlyArray<string> | undefined): ReadonlyArray<RegExp> {
  return (values ?? [])
    .slice(0, MAX_ENTRIES)
    .map(compilePidPattern)
    .filter((re): re is RegExp => re !== null);
}

/** String-array values of one `[section]` of the reaper policy TOML, by key. */
export function readTomlSectionArrays(
  text: string,
  section: string,
): ReadonlyMap<string, ReadonlyArray<string>> {
  const values = new Map<string, ReadonlyArray<string>>();
  let inSection = false;
  let pending: { key: string; text: string } | null = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripTomlCommentOutsideQuotes(rawLine);
    if (!line) continue;
    if (pending) {
      pending.text += ` ${line}`;
      if (line.endsWith("]")) {
        values.set(pending.key, tomlStringArray(pending.text));
        pending = null;
      }
      continue;
    }
    if (line.startsWith("[")) {
      inSection = line === `[${section}]`;
      continue;
    }
    if (!inSection) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const val = line.slice(eq + 1).trim();
    if (val.startsWith("[") && !val.endsWith("]")) pending = { key, text: val };
    else values.set(key, tomlStringArray(val));
  }
  return values;
}

export function parseReaperDockerRules(text: string): DockerReapRules {
  const values = readTomlSectionArrays(text, "docker");
  return {
    keepLabels: (values.get("keep_labels") ?? [])
      .slice(0, MAX_ENTRIES)
      .filter((l) => LABEL_RE.test(l)),
    containerPidPatterns: pidPatterns(values.get("container_pid_patterns")),
    networkPidPatterns: pidPatterns(values.get("network_pid_patterns")),
  };
}

export function readReaperDockerRulesSync(
  policyPath: string = defaultReaperPolicyPath(),
): DockerReapRules {
  try {
    return parseReaperDockerRules(NodeFS.readFileSync(policyPath, "utf8"));
  } catch {
    return EMPTY_DOCKER_REAP_RULES;
  }
}
