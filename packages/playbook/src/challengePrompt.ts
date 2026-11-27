// @effect-diagnostics nodeBuiltinImport:off - Locates PLAYBOOK.md on disk.
/**
 * The challenge prompt: PLAYBOOK.md's full text (§0–§15, verified whole and in
 * order, owner waivers noted per section or rule) embedded in the strict
 * playbook-compliance framing template. No separate CHALLENGE.md file exists.
 */
import * as Schema from "effect/Schema";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { sectionBypassReason, sectionRuleReasons, type Bypasses } from "./bypass.ts";
import { DEFAULT_CHALLENGE_TEMPLATE } from "./challengeTemplate.ts";
import { readWorktreeFile, showFile } from "./git.ts";

declare const __BUNDLED_PLAYBOOK_MD__: string | undefined;

const BUNDLED_PLAYBOOK_MD = NodePath.resolve(import.meta.dirname, "..", "PLAYBOOK.md");

const PLAYBOOK_SECTIONS: ReadonlyArray<readonly [number, string]> = [
  [0, "Terms"],
  [1, "Contracts, Growth & Scoped Exceptions"],
  [2, "Ship queue"],
  [3, "File size ratchet"],
  [4, "Declarations and generations"],
  [5, "Contract changes"],
  [6, "Fleet shape"],
  [7, "DB dictionary"],
  [8, "Destructive gates"],
  [9, "User actions catalog"],
  [10, "Design rules"],
  [11, "Optimization budgets"],
  [12, "System maps"],
  [13, "Declared checks & Dead code"],
  [14, "CI standards and execution tiers"],
  [15, "Product docs"],
];
const REVIEWER_BULLET = "- **2.2 The reviewer";
// Rule label: bold lead with optional leading N.M item number, without closing colon or period.
const RULE_LABEL_RE = /^ *- \*\*(?:\d+\.\d+\s+)?(.+?)[:.]?\*\*/gm;

const PLACEHOLDERS = [
  "playbook",
  "base",
  "tip",
  "surfaces",
  "rises",
  "diff",
  "ci_checks",
  "body",
  "ci_output",
] as const;
export type PromptValues = Readonly<Record<(typeof PLACEHOLDERS)[number], string>>;

export class PromptSourceError extends Schema.TaggedError<PromptSourceError>()(
  "PromptSourceError",
  {
    detail: Schema.String,
  },
) {
  override get message(): string {
    return this.detail;
  }
}

function readRegularFile(path: string): string | null {
  try {
    if (!NodeFS.lstatSync(path).isFile()) return null;
    return NodeFS.readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * Read PLAYBOOK.md safely: explicit path, repo playbook/ or packages/playbook/
 * (from baseRef commit when given so an unreviewed branch cannot weaken standards,
 * or symlink-safe worktree read for UI summaries), embedded bundle text, then host install.
 */
export function readPlaybookStandards(
  root: string,
  options: { readonly explicit?: string | undefined; readonly baseRef?: string | undefined } = {},
): { readonly source: string; readonly text: string } | null {
  if (options.explicit) {
    const text = readRegularFile(options.explicit);
    return text !== null ? { source: options.explicit, text } : null;
  }
  const repoPaths = ["playbook/PLAYBOOK.md", "packages/playbook/PLAYBOOK.md"] as const;
  if (options.baseRef) {
    for (const rel of repoPaths) {
      const text = showFile(root, options.baseRef, rel);
      if (text !== null) return { source: `${options.baseRef.slice(0, 12)}:${rel}`, text };
    }
  } else {
    for (const rel of repoPaths) {
      const text = readWorktreeFile(root, rel);
      if (text !== null) return { source: NodePath.join(root, rel), text };
    }
  }
  if (typeof __BUNDLED_PLAYBOOK_MD__ === "string" && __BUNDLED_PLAYBOOK_MD__.length > 0) {
    return { source: "bundled:PLAYBOOK.md", text: __BUNDLED_PLAYBOOK_MD__ };
  }
  for (const fallback of [
    BUNDLED_PLAYBOOK_MD,
    NodePath.join(NodeOS.homedir(), ".local", "lib", "playbook", "PLAYBOOK.md"),
  ]) {
    const text = readRegularFile(fallback);
    if (text !== null) return { source: fallback, text };
  }
  return null;
}

/** Split PLAYBOOK.md into its numbered `## N. Title` sections. */
function playbookSections(text: string): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  for (const part of text.split(/^(?=## \d+\. )/m)) {
    const m = /^## (\d+)\. (.*)/.exec(part);
    if (m) out.set(`${Number(m[1])}|${m[2]!.trim()}`, part.trimEnd());
  }
  return out;
}

/** Every structural problem with PLAYBOOK.md text (a missing section or the reviewer bullet). */
export function standardsProblems(text: string): ReadonlyArray<string> {
  const sections = playbookSections(text);
  const problems = PLAYBOOK_SECTIONS.filter(([n, t]) => !sections.has(`${n}|${t}`)).map(
    ([n, t]) => `PLAYBOOK.md has no section §${n} ${t}`,
  );
  const reviewer = sections.get("2|Ship queue");
  if (reviewer !== undefined && !reviewer.split("\n").some((l) => l.startsWith(REVIEWER_BULLET))) {
    problems.push(`PLAYBOOK.md §2 has no bullet ${REVIEWER_BULLET}`);
  }
  return problems;
}

/** PLAYBOOK.md's text for the reviewer, with the owner's waivers noted. Throws on a broken file. */
export function playbookStandards(text: string, bypasses: Bypasses): string {
  const problems = standardsProblems(text);
  if (problems.length > 0) throw new PromptSourceError({ detail: problems.join("; ") });
  const sections = playbookSections(text);
  const out: string[] = [];
  for (const [num, title] of PLAYBOOK_SECTIONS) {
    const body = sections.get(`${num}|${title}`)!;
    const whole = num !== 2 ? sectionBypassReason(bypasses, num) : null;
    if (whole) {
      out.push(
        `## ${num}. ${title}\n\nBypassed by owner (${whole}): this section is waived for this repository and must not be enforced or flagged.`,
      );
      continue;
    }
    const labels = [...body.matchAll(RULE_LABEL_RE)].map((m) => m[1]!);
    const rules = num !== 2 ? sectionRuleReasons(bypasses, num, labels) : [];
    if (rules.length > 0) {
      const notes = rules
        .map(
          ([label, why]) =>
            `- **${label}** is waived by the owner for this repository (${why}): it must not be enforced or flagged. The rest of this section applies.`,
        )
        .join("\n");
      out.push(`${body}\n\nOwner exceptions for this section:\n${notes}`);
    } else {
      out.push(body);
    }
  }
  return out.join("\n\n");
}

/** Every placeholder the template lacks. */
export function templateProblems(template: string): ReadonlyArray<string> {
  const t = template.replaceAll("{{", "{").replaceAll("}}", "}");
  return PLACEHOLDERS.filter((k) => !t.includes(`{${k}}`)).map(
    (k) => `challenge prompt template has no placeholder {${k}}`,
  );
}

/** Substitute VALUES into TEMPLATE in a single pass (a value holding `{tip}` stays literal). */
export function renderChallengePrompt(template: string, values: PromptValues): string {
  const problems = templateProblems(template);
  if (problems.length > 0) throw new PromptSourceError({ detail: problems.join("; ") });
  const t = template.replaceAll("{{", "{").replaceAll("}}", "}");
  const re = new RegExp(`\\{(${PLACEHOLDERS.join("|")})\\}`, "g");
  return t.replace(re, (_match, key: keyof PromptValues) => values[key]);
}

/** Built-in framing template (or explicit override path for tests). */
export function readChallengeTemplate(path?: string | null): string {
  if (!path) return DEFAULT_CHALLENGE_TEMPLATE;
  return NodeFS.readFileSync(path, "utf8");
}
