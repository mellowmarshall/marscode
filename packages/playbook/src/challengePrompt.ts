// @effect-diagnostics nodeBuiltinImport:off - Locates PLAYBOOK.md and CHALLENGE.md on disk.
/**
 * The challenge prompt: PLAYBOOK.md's full text (§§0-15, verified whole and in
 * order, owner waivers noted per section or rule) substituted into the
 * CHALLENGE.md template. No prompt instructions live in the engine's code
 * beyond the shipped default template.
 */
import * as Schema from "effect/Schema";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { sectionBypassReason, sectionRuleReasons, type Bypasses } from "./bypass.ts";
import { DEFAULT_CHALLENGE_TEMPLATE } from "./challengeTemplate.ts";

const PLAYBOOK_SECTIONS: ReadonlyArray<readonly [number, string]> = [
  [0, "Terms"],
  [1, "What counts as a contract"],
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
  [12, "Host guards"],
  [13, "System maps"],
  [14, "Declared checks"],
  [15, "CI standards and execution tiers"],
];
const REVIEWER_BULLET = "- **The reviewer**";
const RULE_LABEL_RE = /^ *- \*\*(.+?)[:.]?\*\*/gm;

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

/** The first readable file among the repo's playbook/<NAME>, then the host install. */
export function findPlaybookFile(
  root: string,
  name: "PLAYBOOK.md" | "CHALLENGE.md",
  explicit?: string | undefined,
): string | null {
  const candidates = explicit
    ? [explicit]
    : [
        NodePath.join(root, "playbook", name),
        NodePath.join(NodeOS.homedir(), ".local", "lib", "playbook", name),
      ];
  for (const candidate of candidates) {
    try {
      if (NodeFS.statSync(candidate).isFile()) return candidate;
    } catch {
      continue;
    }
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
    (k) => `CHALLENGE.md has no placeholder {${k}}`,
  );
}

/** Substitute VALUES into TEMPLATE in a single pass (a value holding `{tip}` stays literal). */
export function renderChallengePrompt(template: string, values: PromptValues): string {
  const problems = templateProblems(template);
  if (problems.length > 0) throw new PromptSourceError({ detail: problems.join("; ") });
  const t = template.replaceAll("{{", "{").replaceAll("}}", "}");
  const re = new RegExp(`\\{(${PLACEHOLDERS.join("|")})\\}`, "g");
  return t.replace(re, (_, key: (typeof PLACEHOLDERS)[number]) => values[key]);
}

export function readChallengeTemplate(path: string | null): string {
  if (path === null) return DEFAULT_CHALLENGE_TEMPLATE;
  return NodeFS.readFileSync(path, "utf8");
}
