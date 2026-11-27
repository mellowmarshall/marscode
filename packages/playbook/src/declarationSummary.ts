// @effect-diagnostics nodeBuiltinImport:off - Read-only inspection of playbook.json and PLAYBOOK.md for the declaration view.
/**
 * The declaration view (DevTools' Playbook panel): each declared contract with
 * its evidence path, scoped exception count, and each PLAYBOOK.md section's
 * status (enforced, waived by the owner, or not declared).
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { matchesWaiverRepo, type NormalizedWaiver } from "./bypass.ts";
import { readPlaybookStandards } from "./challengePrompt.ts";
import { contractsOf, evidenceDirOf, loadDeclaration, optedOut } from "./declaration.ts";
import { parseConf } from "./git.ts";
import { isRecord } from "./strictJson.ts";

const MAX_READ_BYTES = 512 * 1024;

export interface DeclaredContractSummary {
  readonly name: string;
  readonly gate: string;
  readonly evidencePath: string | null;
  readonly exceptionCount: number;
  readonly status: "enforced" | "waived";
  readonly waivedReason: string | null;
}

export interface PlaybookRuleSection {
  readonly section: number;
  readonly title: string;
  readonly status: "enforced" | "waived" | "not-declared";
  readonly detail: string | null;
}

export interface PlaybookDeclarationPayload {
  readonly repoDir: string;
  readonly repoName: string;
  readonly hasPlaybookJson: boolean;
  readonly declarationErrors: ReadonlyArray<string>;
  readonly guardsExempt: NormalizedWaiver | null;
  readonly contracts: ReadonlyArray<DeclaredContractSummary>;
  readonly rules: ReadonlyArray<PlaybookRuleSection>;
  readonly playbookMdPath: string | null;
}

const SECTION_CONTRACT_MAP: Readonly<Record<number, ReadonlyArray<string>>> = {
  3: ["size"],
  4: ["generations"],
  5: ["intent"],
  6: ["fleet"],
  7: ["dictionary"],
  8: ["migrations"],
  9: ["actions"],
  10: ["design"],
  11: ["optimization"],
  12: ["maps"],
  13: ["tools"],
  14: ["ci"],
  15: ["docs"],
};
const ALWAYS_ENFORCED_SECTIONS = new Set([0, 1, 2]);

function safeReadUtf8(filePath: string): string | null {
  try {
    const st = NodeFS.lstatSync(filePath);
    if (!st.isFile() || st.size > MAX_READ_BYTES) return null;
    return NodeFS.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

function summarizeGate(
  name: string,
  spec: Readonly<Record<string, unknown>>,
  evidencePath: string | null,
): string {
  if (optedOut(spec)) return `none (${String(spec.none)})`;
  if (name === "intent" && isRecord(spec.contracts)) {
    const keys = Object.keys(spec.contracts);
    return `${keys.length} contracts (${keys.join(", ")})`;
  }
  if (typeof spec.engine === "string" && spec.engine.trim()) {
    return `${spec.engine.trim()} (${evidencePath ?? "evidence"})`;
  }
  if (typeof spec.choke === "string" && spec.choke.trim()) {
    return spec.choke.trim();
  }
  for (const key of ["evidence", "file", "dir"] as const) {
    const value = spec[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return evidencePath ?? "declared";
}

function readPlaybookMdSections(repoReal: string) {
  const found = readPlaybookStandards(repoReal);
  if (!found) {
    return { path: null, headings: [] as ReadonlyArray<{ section: number; title: string }> };
  }
  const headings = found.text.split("\n").flatMap((line) => {
    const m = /^##\s+(?:§)?(\d+)\.\s+(.+)$/.exec(line.trim());
    return m?.[1] && m[2] ? [{ section: Number(m[1]), title: m[2].trim() }] : [];
  });
  return { path: headings.length > 0 ? found.source : null, headings };
}

function inferRepoSlug(repoReal: string): string {
  const conf = parseConf(safeReadUtf8(NodePath.join(repoReal, ".tree-guard.conf")) ?? "");
  return conf.ship_repo?.[0]?.split(/\s+/)[0] || NodePath.basename(repoReal);
}

export function readPlaybookDeclaration(
  repoDir: string,
  allWaivers: ReadonlyArray<NormalizedWaiver>,
): PlaybookDeclarationPayload {
  let repoReal = repoDir;
  try {
    repoReal = NodeFS.realpathSync(repoDir);
  } catch {
    // keep the input
  }
  const repoName = inferRepoSlug(repoReal);
  const repoWaivers = allWaivers.filter((w) => matchesWaiverRepo(w.repo, repoName));
  const guardsExempt = repoWaivers.find((w) => w.scope === "guards") ?? null;
  const playbookWaivers = repoWaivers.filter((w) => w.scope === "playbook");
  const decl = loadDeclaration(repoReal);
  const evidenceDir = evidenceDirOf(decl.data);
  const rawContracts = contractsOf(decl.data);
  const entries: Array<[string, unknown]> = Object.entries(rawContracts);
  if (isRecord(decl.data?.ci)) entries.push(["ci", decl.data.ci]);

  const contracts: DeclaredContractSummary[] = entries.map(([name, raw]) => {
    const spec = isRecord(raw) ? raw : {};
    const evidencePath = optedOut(spec)
      ? null
      : typeof spec.evidence === "string"
        ? spec.evidence
        : NodePath.posix.join(evidenceDir, `${name}.json`);
    const exceptionCount = Array.isArray(spec.exceptions) ? spec.exceptions.length : 0;
    const waiver = playbookWaivers.find((w) => w.key.toLowerCase() === name.toLowerCase());
    return {
      name,
      gate: summarizeGate(name, spec, evidencePath),
      evidencePath,
      exceptionCount,
      status: waiver ? "waived" : "enforced",
      waivedReason: waiver?.reason ?? null,
    };
  });

  const declaredKeys = new Set(entries.filter(([, v]) => !optedOut(v)).map(([k]) => k));
  const md = readPlaybookMdSections(repoReal);
  const rules: PlaybookRuleSection[] = md.headings.map(({ section, title }) => {
    const mapped = SECTION_CONTRACT_MAP[section] ?? [];
    if (guardsExempt) {
      const ref = guardsExempt.issueRef ? ` (${guardsExempt.issueRef})` : "";
      return { section, title, status: "waived", detail: `Guards exempt${ref}` };
    }
    const direct = playbookWaivers.find((w) => {
      const k = w.key.trim().toLowerCase();
      return k === String(section) || k.startsWith(`${section}/`) || mapped.includes(k);
    });
    if (direct) {
      return {
        section,
        title,
        status: "waived",
        detail: `${direct.key}${direct.issueRef ? ` (${direct.issueRef})` : ""}`,
      };
    }
    if (ALWAYS_ENFORCED_SECTIONS.has(section))
      return { section, title, status: "enforced", detail: null };
    const hit = mapped.find((c) => declaredKeys.has(c));
    if (!hit) return { section, title, status: "not-declared", detail: null };
    const excCount = contracts.find((c) => c.name === hit)?.exceptionCount ?? 0;
    return {
      section,
      title,
      status: "enforced",
      detail: excCount > 0 ? `${excCount} exception(s)` : null,
    };
  });
  return {
    repoDir: repoReal,
    repoName,
    hasPlaybookJson: decl.data !== null,
    declarationErrors: decl.errors,
    guardsExempt,
    contracts,
    rules,
    playbookMdPath: md.path,
  };
}
