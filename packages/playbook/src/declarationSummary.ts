// @effect-diagnostics nodeBuiltinImport:off - Read-only inspection of playbook.json, Baselines and PLAYBOOK.md for the declaration view.
/**
 * The declaration view (DevTools' Playbook panel): each declared contract with
 * its gate, Baseline size and nearest expiry, and each PLAYBOOK.md section's
 * status (enforced, waived by the owner, or not declared). It reads
 * playbook.json through the engine's single loader.
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { matchesWaiverRepo, type NormalizedWaiver } from "./bypass.ts";
import { contractsOf, loadDeclaration } from "./declaration.ts";
import { parseConf } from "./git.ts";
import { isRecord } from "./strictJson.ts";

const MAX_READ_BYTES = 512 * 1024;

export interface DeclaredContractSummary {
  readonly name: string;
  readonly gate: string;
  readonly baselinePath: string | null;
  readonly baselineCount: number | null;
  readonly nearestExpiry: string | null;
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
  8: ["migrations", "dictionary"],
  9: ["actions"],
  10: ["design"],
  11: ["optimization"],
  14: ["tools"],
};
const ALWAYS_ENFORCED_SECTIONS = new Set([0, 1, 2, 12, 13, 15]);

function safeReadUtf8(filePath: string): string | null {
  try {
    const st = NodeFS.lstatSync(filePath);
    if (!st.isFile() || st.size > MAX_READ_BYTES) return null;
    return NodeFS.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

function safeResolveInsideRepo(repoReal: string, relPath: string): string | null {
  if (!relPath || relPath.startsWith("/") || relPath.includes("\0")) return null;
  try {
    const real = NodeFS.realpathSync(NodePath.resolve(repoReal, relPath));
    return real === repoReal || real.startsWith(repoReal + NodePath.sep) ? real : null;
  } catch {
    return null;
  }
}

function summarizeGate(name: string, spec: Readonly<Record<string, unknown>>): string {
  if (name === "tools" && Array.isArray(spec.steps)) {
    const names = spec.steps.flatMap((s) =>
      isRecord(s) && typeof s.name === "string" ? [s.name] : [],
    );
    const extra = names.length > 4 ? ` +${names.length - 4}` : "";
    return `${names.length} steps (${names.slice(0, 4).join(", ")}${extra})`;
  }
  if (name === "intent" && isRecord(spec.contracts)) {
    const keys = Object.keys(spec.contracts);
    return `${keys.length} contracts (${keys.join(", ")})`;
  }
  for (const key of ["command", "file", "receipts"] as const) {
    const value = spec[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "declared";
}

function inspectBaseline(repoReal: string, relPath: string | null) {
  const empty = { count: null, nearestExpiry: null };
  const resolved = relPath ? safeResolveInsideRepo(repoReal, relPath) : null;
  const text = resolved ? safeReadUtf8(resolved) : null;
  if (!text) return empty;
  try {
    const parsed = JSON.parse(text) as unknown;
    const items: ReadonlyArray<unknown> = Array.isArray(parsed)
      ? parsed
      : isRecord(parsed) && Array.isArray(parsed.entries)
        ? parsed.entries
        : isRecord(parsed)
          ? Object.values(parsed).filter(isRecord)
          : [];
    let nearest: string | null = null;
    for (const item of items) {
      const exp = isRecord(item) ? item.expires : undefined;
      if (
        typeof exp === "string" &&
        /^\d{4}-\d{2}-\d{2}/.test(exp) &&
        (nearest === null || exp < nearest)
      ) {
        nearest = exp.slice(0, 10);
      }
    }
    return { count: items.length, nearestExpiry: nearest };
  } catch {
    return empty;
  }
}

function readPlaybookMdSections(repoReal: string) {
  for (const cand of [
    NodePath.join(repoReal, "playbook", "PLAYBOOK.md"),
    NodePath.join(NodeOS.homedir(), ".local", "lib", "playbook", "PLAYBOOK.md"),
  ]) {
    const text = safeReadUtf8(cand);
    if (!text) continue;
    const headings = text.split("\n").flatMap((line) => {
      const m = /^##\s+(?:§)?(\d+)\.\s+(.+)$/.exec(line.trim());
      return m?.[1] && m[2] ? [{ section: Number(m[1]), title: m[2].trim() }] : [];
    });
    if (headings.length > 0) return { path: cand, headings };
  }
  return { path: null, headings: [] as ReadonlyArray<{ section: number; title: string }> };
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
  const rawContracts = contractsOf(decl.data);
  const contracts: DeclaredContractSummary[] = Object.entries(rawContracts).map(([name, raw]) => {
    const spec = isRecord(raw) ? raw : {};
    const baselinePath = typeof spec.baseline === "string" ? spec.baseline : null;
    const baseline = inspectBaseline(repoReal, baselinePath);
    const waiver = playbookWaivers.find((w) => w.key.toLowerCase() === name.toLowerCase());
    return {
      name,
      gate: summarizeGate(name, spec),
      baselinePath,
      baselineCount: baseline.count,
      nearestExpiry: baseline.nearestExpiry,
      status: waiver ? "waived" : "enforced",
      waivedReason: waiver?.reason ?? null,
    };
  });
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
    const hit = mapped.find((c) => c in rawContracts);
    if (!hit) return { section, title, status: "not-declared", detail: null };
    const count = contracts.find((c) => c.name === hit)?.baselineCount ?? 0;
    return { section, title, status: "enforced", detail: count > 0 ? `baseline ${count}` : null };
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
