/**
 * User actions evidence runner, selector matching, and oracle checks (PLAYBOOK §9).
 * Domain seam extracted from `actionsGate.ts`.
 */
import { failed, unproven, type CheckResult } from "../result.ts";
import { runStep, tailLines } from "../steps.ts";
import { isRecord } from "../strictJson.ts";

const CHECK = "actions";
const SHELL_ORACLE_RE = /-(?:container|wrapper|section|scroll|page|view|shell|root|layout)$/;
const EVIDENCE_TEST_KEYS = new Set(["file", "line", "title", "kind", "actions", "selectors"]);

export interface EvidenceTest {
  readonly file: string;
  readonly line: number;
  readonly title: string;
  readonly kind: "e2e" | "component";
  readonly actions: ReadonlyArray<string>;
  readonly selectors: ReadonlyArray<string>;
}

export function patternRegex(pattern: string): RegExp {
  const body = pattern
    .split(/\$\{[^}]+\}/)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".+");
  return new RegExp(`^${body}$`);
}

export function parseOracle(
  oracle: unknown,
): { readonly kind: string; readonly value: string } | null {
  if (typeof oracle !== "string") return null;
  const m = /^(visible|gone|navigatesTo|request): (.+)$/.exec(oracle);
  return m ? { kind: m[1]!, value: m[2]! } : null;
}

export function isVacuousOracle(oracle: unknown, level: unknown): boolean {
  if (level !== "journey") return false;
  const parsed = parseOracle(oracle);
  return parsed?.kind === "visible" && SHELL_ORACLE_RE.test(parsed.value);
}

const targetOf = (action: Readonly<Record<string, unknown>>) =>
  String(action.testID ?? action.instance ?? "");

function regexMatches(action: Readonly<Record<string, unknown>>, source: string): boolean {
  try {
    return new RegExp(source).test(targetOf(action));
  } catch {
    return false;
  }
}

export function selectsAction(
  action: Readonly<Record<string, unknown>>,
  selector: string,
  others: ReadonlyArray<Readonly<Record<string, unknown>>>,
): boolean {
  const unique = (source: string) =>
    regexMatches(action, source) &&
    !others.some((o) => targetOf(o) !== targetOf(action) && regexMatches(o, source));
  const regex = /^\/(.+)\/$/.exec(selector);
  if (regex?.[1]) return unique(regex[1]);
  if (typeof action.testID === "string") {
    if (selector === action.testID) return true;
    return /[.*+[\]]/.test(selector) && unique(`^${selector}$`);
  }
  if (selector === action.instance) return true;
  if (typeof action.testIDPattern !== "string" || action.testIDPattern.startsWith("${"))
    return false;
  if (/[.*+[\]]/.test(selector)) return unique(`^${selector}$`);
  try {
    return patternRegex(action.testIDPattern).test(selector);
  } catch {
    return false;
  }
}

export async function runActionsEvidence(input: {
  readonly root: string;
  readonly settings: Readonly<Record<string, unknown>>;
  readonly base: string | null;
  readonly signal?: AbortSignal | undefined;
}): Promise<
  | {
      readonly ok: true;
      readonly tests: ReadonlyArray<EvidenceTest>;
      readonly problems: ReadonlyArray<string>;
    }
  | { readonly ok: false; readonly result: CheckResult }
> {
  const ev = isRecord(input.settings.evidence) ? input.settings.evidence : null;
  const command = ev && typeof ev.run === "string" && ev.run.trim() ? ev.run : null;
  if (!command) {
    return {
      ok: false,
      result: failed(
        CHECK,
        'missing contracts.actions.evidence.run in playbook.json; declare a repo command printing {"tests": [...]}',
        { files: ["playbook.json"] },
      ),
    };
  }
  const ran = await runStep(
    input.root,
    command,
    { PLAYBOOK_BASE: input.base ?? "" },
    undefined,
    input.signal,
  );
  if (ran.code === null) {
    return {
      ok: false,
      result: unproven(CHECK, `the action evidence \`${command}\` did not run: ${ran.why}`),
    };
  }
  if (ran.code !== 0) {
    return {
      ok: false,
      result: failed(CHECK, `the action evidence \`${command}\` exited ${ran.code}`, {
        errors: tailLines(ran, 10),
        files: ["playbook.json"],
      }),
    };
  }
  if (!ran.stdout.trim()) {
    return {
      ok: false,
      result: failed(CHECK, `the action evidence \`${command}\` produced empty output on stdout`, {
        files: ["playbook.json"],
      }),
    };
  }
  let data: unknown;
  try {
    data = JSON.parse(ran.stdout) as unknown;
  } catch (cause) {
    return {
      ok: false,
      result: failed(
        CHECK,
        `the action evidence \`${command}\` printed no JSON (${String(cause)})`,
        { files: ["playbook.json"] },
      ),
    };
  }
  if (!isRecord(data)) {
    return {
      ok: false,
      result: failed(CHECK, `the action evidence \`${command}\` did not print a JSON object`, {
        files: ["playbook.json"],
      }),
    };
  }
  const bad: string[] = [];
  const extraTop = Object.keys(data)
    .filter((k) => k !== "tests" && k !== "problems")
    .toSorted();
  if (extraTop.length > 0) bad.push(`unexpected top-level field(s): ${extraTop.join(", ")}`);
  const rawTests = data.tests;
  if (!Array.isArray(rawTests)) bad.push('missing "tests" list');
  const testsPattern = ev && typeof ev.tests === "string" ? ev.tests : "$^";
  let testsRe: RegExp;
  try {
    testsRe = new RegExp(testsPattern);
  } catch {
    testsRe = /$^/;
  }
  const validTests: EvidenceTest[] = [];
  for (let i = 0; i < (Array.isArray(rawTests) ? rawTests.length : 0); i += 1) {
    const t = (rawTests as unknown[])[i];
    if (
      !isRecord(t) ||
      Object.keys(t).length !== EVIDENCE_TEST_KEYS.size ||
      Object.keys(t).some((k) => !EVIDENCE_TEST_KEYS.has(k)) ||
      typeof t.file !== "string" ||
      !t.file.trim() ||
      typeof t.title !== "string" ||
      !t.title.trim() ||
      typeof t.line !== "number" ||
      !Number.isInteger(t.line) ||
      t.line < 1 ||
      (t.kind !== "e2e" && t.kind !== "component") ||
      !Array.isArray(t.actions) ||
      !t.actions.every((x): x is string => typeof x === "string" && x.trim().length > 0) ||
      !Array.isArray(t.selectors) ||
      !t.selectors.every((x): x is string => typeof x === "string" && x.trim().length > 0)
    ) {
      bad.push(`tests[${i}] is not {file, line, title, kind, actions, selectors}`);
      continue;
    }
    if (!testsRe.test(t.file)) {
      bad.push(
        `tests[${i}] is in ${t.file}, which evidence.tests (${testsPattern}) does not match`,
      );
      continue;
    }
    validTests.push(t as unknown as EvidenceTest);
  }
  const rawProblems = data.problems ?? [];
  if (
    !Array.isArray(rawProblems) ||
    !rawProblems.every((p): p is string => typeof p === "string")
  ) {
    bad.push('"problems" is not a list of strings');
  }
  if (bad.length > 0) {
    return {
      ok: false,
      result: failed(
        CHECK,
        `the action evidence \`${command}\` is not in the evidence shape: ${bad[0]}`,
        {
          errors: bad.slice(0, 10),
          files: ["playbook.json"],
        },
      ),
    };
  }
  return { ok: true, tests: validTests, problems: rawProblems as ReadonlyArray<string> };
}
