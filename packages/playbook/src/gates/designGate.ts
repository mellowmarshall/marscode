// @effect-diagnostics nodeBuiltinImport:off - Headless playbook gate uses node:* directly without Effect.
/**
 * `playbook check design`: appearance slots and the repo's design findings command (PLAYBOOK §10).
 * Validates settings (no symlink escapes in tokens/ui/system/content_values), checks appearance
 * slots both ways, runs `contracts.design.command` with JSON payload on stdin, and judges findings.
 */
import * as NodePath from "node:path";

import type { BaselineEntry } from "../baseline.ts";
import { firstSymlinkSegment, listedFiles, readWorktreeFile, worktreePathExists } from "../git.ts";
import { failed, passed, unproven, type CheckResult } from "../result.ts";
import { runStep, tailLines } from "../steps.ts";
import { isRecord, parseStrictJson } from "../strictJson.ts";
import { findingCountsSummary, judgeFindings, type GateFinding } from "./findings.ts";
import { trustedEmits } from "./generationsGate.ts";

const CHECK = "design";
const MISSING_COMMAND =
  "missing contracts.design.command in playbook.json; declare a repo command that emits the required design findings report.";
const FINDING_KEYS = new Set(["rule", "file", "line", "where", "text", "message"]);
const CLIENT_SCRIPT_RE = /\.(?:tsx?|jsx?|mts|cts|mjs|cjs|html)$/;
const NOT_CLIENT_RE =
  /(?:^|\/)(?:tests?|__tests__|__mocks__|fixtures)\/|\.(?:test|spec)\.[cm]?[jt]sx?$|\.d\.ts$/;

function isPlainRepoPath(raw: string): boolean {
  if (!raw || raw.includes("\0") || NodePath.isAbsolute(raw) || raw.includes("\\")) return false;
  const target = raw.replace(/\/+$/, "");
  if (!target) return false;
  return !target.split("/").some((p) => p === "" || p === "." || p === "..");
}

function settingsProblem(root: string, s: Readonly<Record<string, unknown>>): string | null {
  const missing: string[] = [];
  if (typeof s.tokens !== "string" || !s.tokens.trim()) missing.push("tokens (the token module)");
  if (typeof s.ui !== "string" || !s.ui.trim()) missing.push("ui (the UI package)");
  const client = Array.isArray(s.client)
    ? s.client.filter((c): c is string => typeof c === "string")
    : [];
  if (client.length === 0) missing.push("client (the client code's paths)");
  if (missing.length > 0) return `contracts.design does not declare ${missing.join(", ")}`;

  for (const key of ["tokens", "ui", "system"] as const) {
    const val = s[key];
    if (typeof val !== "string") continue;
    if (!isPlainRepoPath(val)) {
      return `contracts.design.${key} must use a plain repository-relative path`;
    }
    const link = firstSymlinkSegment(root, val);
    if (link) return `contracts.design.${key} passes through the symlink ${link}`;
  }
  for (const raw of client) {
    if (!isPlainRepoPath(raw)) {
      return "contracts.design.client must use plain repository-relative paths";
    }
    const link = firstSymlinkSegment(root, raw);
    if (link) return `contracts.design.client entry ${raw} passes through the symlink ${link}`;
  }
  const contentValues = isRecord(s.content_values) ? s.content_values : null;
  const sources = contentValues && Array.isArray(contentValues.source) ? contentValues.source : [];
  for (const raw of sources) {
    if (typeof raw !== "string") continue;
    const target = raw.replace(/\/+$/, "");
    if (!isPlainRepoPath(raw)) {
      return "contracts.design.content_values.source must use plain repository paths";
    }
    if (!client.some((c) => raw === c || (c.endsWith("/") && raw.startsWith(c)))) {
      return `content value scope ${raw} must remain inside contracts.design.client`;
    }
    for (const key of ["ui", "tokens"] as const) {
      const owner = String(s[key]).replace(/\/+$/, "");
      if (target === owner || owner.startsWith(`${target}/`) || target.startsWith(`${owner}/`)) {
        return `content value scope ${raw} overlaps the ${key} owner; UI and tokens are not content data`;
      }
    }
    if (firstSymlinkSegment(root, target)) {
      return `content value scope ${raw} passes through a symlink`;
    }
  }
  return null;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function namesSlot(text: string, sid: string, calls: ReadonlyArray<string>): boolean {
  if (!text.includes(sid)) return false;
  const q = `\\{?\\s*["'\`]${escapeRe(sid)}["'\`]`;
  if (new RegExp(`(?:(?<!\\[)\\bdata-slot\\s*=\\s*|(?<![-_\\[])\\bslot\\s*=\\s*)${q}`).test(text))
    return true;
  if (new RegExp(`(?<!\\[)["']data-slot["']\\s*:\\s*${q}`).test(text)) return true;
  for (const m of text.matchAll(new RegExp(`(?<![-_\\[])\\bslot\\s*:\\s*${q}(\\s*[|;])?`, "g"))) {
    if (!m[1]) return true;
  }
  for (const call of calls) {
    if (new RegExp(`\\b${escapeRe(call)}\\s*\\([^);]*?["'\`]${escapeRe(sid)}["'\`]`).test(text))
      return true;
  }
  return false;
}

function checkSlots(
  root: string,
  rel: string,
  client: ReadonlyArray<string>,
  slotCalls: ReadonlyArray<string>,
): CheckResult {
  const check = `${CHECK} slots`;
  const text = readWorktreeFile(root, rel);
  if (text === null) {
    return failed(check, `contracts.design.slots names ${rel}, which does not exist`, {
      files: [rel],
      fix: `write ${rel}, or delete contracts.design.slots if the repo has no appearance slots`,
    });
  }
  let data: unknown;
  try {
    data = parseStrictJson(text);
  } catch (cause) {
    return failed(
      check,
      `${rel} cannot be read: ${cause instanceof Error ? cause.message : String(cause)}`,
      {
        files: [rel],
      },
    );
  }
  const slots = isRecord(data) && isRecord(data.slots) ? data.slots : null;
  if (!slots) {
    return failed(check, `${rel} has no slots object`, { files: [rel] });
  }
  const bad: string[] = [];
  for (const [sid, raw] of Object.entries(slots).toSorted(([a], [b]) => a.localeCompare(b))) {
    if (!isRecord(raw)) {
      bad.push(`${sid}: not an object`);
      continue;
    }
    for (const key of ["drawnBy", "paintedBy"] as const) {
      const list = Array.isArray(raw[key]) ? raw[key] : [];
      for (const p of list) {
        if (typeof p === "string" && !worktreePathExists(root, p)) {
          bad.push(`${sid}.${key}: ${p} does not exist`);
        }
      }
    }
  }
  const calls = [...slotCalls];
  if (isRecord(data) && Array.isArray(data.calls)) {
    for (const c of data.calls) if (typeof c === "string" && !calls.includes(c)) calls.push(c);
  }
  if (bad.length === 0 && client.length > 0) {
    const files = (listedFiles(root) ?? []).filter(
      (f) =>
        CLIENT_SCRIPT_RE.test(f) &&
        !NOT_CLIENT_RE.test(f) &&
        client.some((s) => (s.endsWith("/") ? f.startsWith(s) : f === s)),
    );
    const texts = new Map(files.map((f) => [f, readWorktreeFile(root, f) ?? ""] as const));
    for (const [sid, raw] of Object.entries(slots).toSorted(([a], [b]) => a.localeCompare(b))) {
      if (!isRecord(raw)) continue;
      const drawn = Array.isArray(raw.drawnBy)
        ? raw.drawnBy.filter((p): p is string => typeof p === "string")
        : [];
      const painted = new Set(
        Array.isArray(raw.paintedBy)
          ? raw.paintedBy.filter((p): p is string => typeof p === "string")
          : [],
      );
      for (const p of drawn) {
        const body = texts.get(p) ?? readWorktreeFile(root, p) ?? "";
        if (!namesSlot(body, sid, calls)) {
          bad.push(`${sid}.drawnBy: ${p} does not name the slot (write it as a literal: "${sid}")`);
        }
      }
      for (const f of files) {
        if (!drawn.includes(f) && !painted.has(f) && namesSlot(texts.get(f) ?? "", sid, calls)) {
          bad.push(`${sid}: ${f} names the slot but is not in its drawnBy`);
        }
      }
    }
  }
  if (bad.length > 0) {
    return failed(check, `${bad.length} slot problem(s) in ${rel}`, {
      errors: bad,
      files: [rel],
      fix: "point each slot at the files that draw and paint it; each drawnBy file names its slot as a literal",
    });
  }
  return passed(
    check,
    `${Object.keys(slots).length} slot(s) in ${rel}, each pointing at existing files${client.length > 0 ? " and named by exactly its drawnBy files" : ""}`,
  );
}

function workspacePackages(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rel of listedFiles(root) ?? []) {
    if (NodePath.posix.basename(rel) !== "package.json" || `/${rel}`.includes("/node_modules/"))
      continue;
    const text = readWorktreeFile(root, rel);
    if (!text) continue;
    try {
      const pkg = JSON.parse(text) as unknown;
      if (isRecord(pkg) && typeof pkg.name === "string" && pkg.name) {
        out[pkg.name] = NodePath.posix.dirname(rel) || ".";
      }
    } catch {
      // skip invalid package.json
    }
  }
  return out;
}

function validateDesignFinding(item: unknown, idx: number): string | null {
  if (!isRecord(item)) return `findings[${idx}] is not an object`;
  const extra = Object.keys(item)
    .filter((k) => !FINDING_KEYS.has(k))
    .toSorted();
  if (extra.length > 0) return `findings[${idx}] has unexpected field(s): ${extra.join(", ")}`;
  for (const k of ["rule", "file", "message"] as const) {
    if (typeof item[k] !== "string" || !item[k].trim())
      return `findings[${idx}].${k} must be a nonblank string`;
  }
  if (typeof item.text !== "string") return `findings[${idx}].text must be a string`;
  if (
    "line" in item &&
    (typeof item.line !== "number" || !Number.isInteger(item.line) || item.line < 1)
  ) {
    return `findings[${idx}].line must be a positive integer`;
  }
  if ("where" in item && (typeof item.where !== "string" || !item.where.trim())) {
    return `findings[${idx}].where must be a nonblank string`;
  }
  return null;
}

export async function designGate(input: {
  readonly root: string;
  readonly settings: Readonly<Record<string, unknown>>;
  readonly declaration: Readonly<Record<string, unknown>>;
  readonly entries: ReadonlyArray<BaselineEntry>;
  readonly base: string | null;
  readonly signal?: AbortSignal | undefined;
}): Promise<ReadonlyArray<CheckResult>> {
  const s = input.settings;
  const client = Array.isArray(s.client)
    ? s.client.filter((c): c is string => typeof c === "string")
    : [];
  const slotCalls = Array.isArray(s.slot_calls)
    ? s.slot_calls.filter((c): c is string => typeof c === "string")
    : [];
  const out: CheckResult[] = [];
  if (typeof s.slots === "string") {
    out.push(checkSlots(input.root, s.slots, client, slotCalls));
  }

  const command = typeof s.command === "string" && s.command.trim() ? s.command : null;
  const why = settingsProblem(input.root, s);
  if (why) {
    out.push(
      failed(CHECK, `${why}, so the rules cannot look`, {
        errors: command ? [] : [MISSING_COMMAND],
        files: ["playbook.json"],
        fix: "declare the design settings and contracts.design.command in contracts.design",
      }),
    );
    return out;
  }
  if (!command) {
    out.push(
      failed(CHECK, MISSING_COMMAND, {
        files: ["playbook.json"],
        fix: 'declare contracts.design.command in playbook.json (must exit 0 and print {"findings": [...]})',
      }),
    );
    return out;
  }

  const contracts = isRecord(input.declaration.contracts) ? input.declaration.contracts : {};
  const genCmd =
    isRecord(contracts.generations) && typeof contracts.generations.command === "string"
      ? contracts.generations.command
      : null;
  const genFiles = [...trustedEmits(input.root, input.base, genCmd)].toSorted();
  const payload = JSON.stringify({
    root: input.root,
    generated: genFiles,
    settings: {
      tokens: s.tokens,
      ui: s.ui,
      client,
      interactive: Array.isArray(s.interactive) ? s.interactive : [],
      style_properties: Array.isArray(s.style_properties) ? s.style_properties : [],
      system: typeof s.system === "string" ? s.system : null,
      touch_calls: Array.isArray(s.touch_calls) ? s.touch_calls : [],
      content_values: isRecord(s.content_values) ? s.content_values : {},
      chokepoint: Boolean(s.chokepoint),
      packages: workspacePackages(input.root),
    },
  });

  const ran = await runStep(
    input.root,
    command,
    { PLAYBOOK_BASE: input.base ?? "" },
    undefined,
    input.signal,
    payload,
  );
  if (ran.code === null) {
    out.push(unproven(CHECK, `the design command \`${command}\` did not run: ${ran.why}`));
    return out;
  }
  if (ran.code !== 0) {
    out.push(
      failed(CHECK, `the design command \`${command}\` exited ${ran.code}`, {
        errors: tailLines(ran, 15),
        files: ["playbook.json"],
      }),
    );
    return out;
  }
  const raw = ran.stdout.trim();
  if (!raw) {
    out.push(
      failed(CHECK, `contracts.design.command \`${command}\` produced empty output on stdout`, {
        files: ["playbook.json"],
      }),
    );
    return out;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (cause) {
    out.push(
      failed(
        CHECK,
        `contracts.design.command \`${command}\` printed invalid JSON (${String(cause)})`,
        {
          errors: tailLines(ran, 5),
          files: ["playbook.json"],
        },
      ),
    );
    return out;
  }
  if (!isRecord(parsed)) {
    out.push(
      failed(CHECK, `contracts.design.command \`${command}\` did not print a JSON object`, {
        files: ["playbook.json"],
      }),
    );
    return out;
  }
  const extraTop = Object.keys(parsed)
    .filter((k) => k !== "findings" && k !== "files")
    .toSorted();
  if (extraTop.length > 0) {
    out.push(
      failed(
        CHECK,
        `contracts.design.command output has unexpected top-level field(s): ${extraTop.join(", ")}`,
        { files: ["playbook.json"] },
      ),
    );
    return out;
  }
  if (!Array.isArray(parsed.findings)) {
    out.push(
      failed(CHECK, 'contracts.design.command output is missing required list field "findings"', {
        files: ["playbook.json"],
      }),
    );
    return out;
  }
  if (
    "files" in parsed &&
    (typeof parsed.files !== "number" || !Number.isInteger(parsed.files) || parsed.files < 0)
  ) {
    out.push(
      failed(
        CHECK,
        'contracts.design.command output field "files" must be a non-negative integer',
        { files: ["playbook.json"] },
      ),
    );
    return out;
  }
  const badItems = parsed.findings
    .map((item, idx) => validateDesignFinding(item, idx))
    .filter((e): e is string => e !== null);
  if (badItems.length > 0) {
    out.push(
      failed(
        CHECK,
        `contracts.design.command output is not in the design findings shape: ${badItems[0]}`,
        { errors: badItems.slice(0, 10), files: ["playbook.json"] },
      ),
    );
    return out;
  }
  if (parsed.files === 0) {
    out.push(
      failed(CHECK, "no client files were found to scan (contracts.design.client)", {
        files: ["playbook.json"],
      }),
    );
    return out;
  }

  const skip = new Set(genFiles);
  const findings: GateFinding[] = (parsed.findings as ReadonlyArray<Record<string, unknown>>)
    .filter((f) => !skip.has(String(f.file)))
    .map((f) => ({
      rule: String(f.rule),
      file: String(f.file),
      text: String(f.text),
      message: String(f.message),
      where:
        typeof f.where === "string"
          ? f.where
          : typeof f.line === "number"
            ? `${String(f.file)}:${f.line}`
            : String(f.file),
    }));
  const baselinePath = typeof s.baseline === "string" ? s.baseline : null;
  const judged = judgeFindings(findings, input.entries, { baselinePath });
  const filesPrefix = typeof parsed.files === "number" ? `${parsed.files} client file(s); ` : "";
  if (judged.problems.length > 0) {
    out.push(
      failed(CHECK, `${judged.problems.length} design finding(s)`, {
        errors: judged.problems,
        fix: "use a token from the token module or a component from the UI package",
      }),
    );
  } else {
    const heldNote =
      findings.length > 0 ? `, ${findings.length} held (${findingCountsSummary(findings)})` : "";
    out.push(
      passed(
        CHECK,
        `${filesPrefix}${findings.length === 0 ? "0 findings" : `0 new findings${heldNote}`}`,
      ),
    );
  }
  return out;
}
