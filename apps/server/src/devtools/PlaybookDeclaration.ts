// @effect-diagnostics nodeBuiltinImport:off - Local read-only inspection of playbook.json, baselines, PLAYBOOK.md, and exceptions.json.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

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

export interface NormalizedWaiver {
  readonly repo: string;
  readonly scope: "guards" | "playbook";
  readonly key: string;
  readonly reason: string;
  readonly date: string | null;
  readonly issueRef: string | null;
}

export interface PlaybookDeclarationPayload {
  readonly repoDir: string;
  readonly repoName: string;
  readonly hasPlaybookJson: boolean;
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
  const candidate = NodePath.resolve(repoReal, relPath);
  try {
    const real = NodeFS.realpathSync(candidate);
    if (real !== repoReal && !real.startsWith(repoReal + NodePath.sep)) {
      return null;
    }
    return real;
  } catch {
    return null;
  }
}

function parseDateAndIssue(reason: string): {
  readonly date: string | null;
  readonly issueRef: string | null;
} {
  const dateMatch = /\b(20\d{2}-\d{2}-\d{2})\b/.exec(reason);
  const issueMatch = /(?:\b[a-z][a-z0-9_-]*#\d+|(?<![a-z0-9_])#\d+)\b/i.exec(reason);
  return {
    date: dateMatch?.[1] ?? null,
    issueRef: issueMatch?.[0] ?? null,
  };
}

export function normalizeExceptions(raw: {
  readonly path: string | null;
  readonly entries: unknown;
}): ReadonlyArray<NormalizedWaiver> {
  if (!raw.entries || typeof raw.entries !== "object" || Array.isArray(raw.entries)) {
    return [];
  }
  const repos = (raw.entries as { readonly repos?: unknown }).repos;
  if (!repos || typeof repos !== "object" || Array.isArray(repos)) {
    return [];
  }
  const out: NormalizedWaiver[] = [];
  for (const [repo, spec] of Object.entries(repos as Record<string, unknown>)) {
    if (!spec || typeof spec !== "object" || Array.isArray(spec)) continue;
    const obj = spec as Record<string, unknown>;
    if (typeof obj.guards === "string" && obj.guards.trim()) {
      const reason = obj.guards.trim();
      const { date, issueRef } = parseDateAndIssue(reason);
      out.push({ repo, scope: "guards", key: "guards", reason, date, issueRef });
    }
    if (obj.playbook && typeof obj.playbook === "object" && !Array.isArray(obj.playbook)) {
      for (const [key, val] of Object.entries(obj.playbook as Record<string, unknown>)) {
        if (typeof val !== "string" || !val.trim()) continue;
        const reason = val.trim();
        const { date, issueRef } = parseDateAndIssue(reason);
        out.push({ repo, scope: "playbook", key, reason, date, issueRef });
      }
    }
  }
  return out;
}

function summarizeGate(name: string, spec: Record<string, unknown>): string {
  if (name === "tools" && Array.isArray(spec.steps)) {
    const names = spec.steps
      .map((s) =>
        s && typeof s === "object" && typeof (s as { name?: unknown }).name === "string"
          ? (s as { name: string }).name
          : null,
      )
      .filter((s): s is string => s !== null);
    const preview = names.slice(0, 4).join(", ");
    const extra = names.length > 4 ? ` +${names.length - 4}` : "";
    return `${names.length} steps (${preview}${extra})`;
  }
  if (name === "intent" && spec.contracts && typeof spec.contracts === "object") {
    const keys = Object.keys(spec.contracts as Record<string, unknown>);
    return `${keys.length} contracts (${keys.join(", ")})`;
  }
  if (typeof spec.command === "string" && spec.command.trim()) {
    return spec.command.trim();
  }
  if (typeof spec.file === "string" && spec.file.trim()) {
    return spec.file.trim();
  }
  if (typeof spec.receipts === "string" && spec.receipts.trim()) {
    return spec.receipts.trim();
  }
  return "declared";
}

function inspectBaseline(
  repoReal: string,
  relPath: string | null,
): { readonly count: number | null; readonly nearestExpiry: string | null } {
  if (!relPath) return { count: null, nearestExpiry: null };
  const resolved = safeResolveInsideRepo(repoReal, relPath);
  if (!resolved) return { count: null, nearestExpiry: null };
  const text = safeReadUtf8(resolved);
  if (!text) return { count: null, nearestExpiry: null };
  try {
    const parsed = JSON.parse(text) as unknown;
    const items: ReadonlyArray<unknown> = Array.isArray(parsed)
      ? parsed
      : parsed &&
          typeof parsed === "object" &&
          Array.isArray((parsed as { entries?: unknown }).entries)
        ? (parsed as { entries: ReadonlyArray<unknown> }).entries
        : parsed && typeof parsed === "object"
          ? Object.values(parsed as Record<string, unknown>).filter(
              (v) => v && typeof v === "object",
            )
          : [];
    let nearest: string | null = null;
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      const exp = (item as { expires?: unknown }).expires;
      if (typeof exp === "string" && /^\d{4}-\d{2}-\d{2}/.test(exp)) {
        if (nearest === null || exp < nearest) {
          nearest = exp.slice(0, 10);
        }
      }
    }
    return { count: items.length, nearestExpiry: nearest };
  } catch {
    return { count: null, nearestExpiry: null };
  }
}

function readPlaybookMdSections(repoReal: string): {
  readonly path: string | null;
  readonly headings: ReadonlyArray<{ readonly section: number; readonly title: string }>;
} {
  const home = NodeOS.homedir();
  const candidates = [
    NodePath.join(repoReal, "playbook", "PLAYBOOK.md"),
    NodePath.join(home, ".local", "lib", "playbook", "PLAYBOOK.md"),
  ];
  for (const cand of candidates) {
    const text = safeReadUtf8(cand);
    if (!text) continue;
    const headings: Array<{ readonly section: number; readonly title: string }> = [];
    for (const line of text.split("\n")) {
      const m = /^##\s+(?:§)?(\d+)\.\s+(.+)$/.exec(line.trim());
      if (m?.[1] && m[2]) {
        headings.push({ section: Number(m[1]), title: m[2].trim() });
      }
    }
    if (headings.length > 0) {
      return { path: cand, headings };
    }
  }
  return { path: null, headings: [] };
}

function inferRepoSlug(repoReal: string): string {
  // Check .tree-guard.conf ship_gh_repo or fallback to folder basename.
  const conf = safeReadUtf8(NodePath.join(repoReal, ".tree-guard.conf"));
  if (conf) {
    const m = /^ship_repo\s*=\s*(\S+)/m.exec(conf);
    if (m?.[1]) return m[1].trim();
  }
  return NodePath.basename(repoReal);
}

function matchesWaiverRepo(waiverRepo: string, repoName: string): boolean {
  if (waiverRepo === "*") return true;
  const lower = waiverRepo.toLowerCase();
  const target = repoName.toLowerCase();
  return lower === target || lower.endsWith(`/${target}`);
}

export function readPlaybookDeclaration(
  repoDir: string,
  allWaivers: ReadonlyArray<NormalizedWaiver>,
): PlaybookDeclarationPayload {
  let repoReal = repoDir;
  try {
    repoReal = NodeFS.realpathSync(repoDir);
  } catch {
    // keep input
  }
  const repoName = inferRepoSlug(repoReal);
  const repoWaivers = allWaivers.filter((w) => matchesWaiverRepo(w.repo, repoName));
  const guardsExempt = repoWaivers.find((w) => w.scope === "guards") ?? null;
  const playbookWaivers = repoWaivers.filter((w) => w.scope === "playbook");

  const pbPath = NodePath.join(repoReal, "playbook.json");
  const pbText = safeReadUtf8(pbPath);
  let rawContracts: Record<string, unknown> = {};
  let hasPlaybookJson = false;
  if (pbText) {
    try {
      const parsed = JSON.parse(pbText) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        hasPlaybookJson = true;
        const c = (parsed as { contracts?: unknown }).contracts;
        if (c && typeof c === "object" && !Array.isArray(c)) {
          rawContracts = c as Record<string, unknown>;
        }
      }
    } catch {
      // ignore malformed
    }
  }

  const declaredNames = new Set(Object.keys(rawContracts));
  const contracts: DeclaredContractSummary[] = [];
  for (const [name, rawSpec] of Object.entries(rawContracts)) {
    const spec =
      rawSpec && typeof rawSpec === "object" && !Array.isArray(rawSpec)
        ? (rawSpec as Record<string, unknown>)
        : {};
    const baselinePath = typeof spec.baseline === "string" ? spec.baseline : null;
    const baseline = inspectBaseline(repoReal, baselinePath);
    const matchingWaiver = playbookWaivers.find((w) => w.key.toLowerCase() === name.toLowerCase());
    contracts.push({
      name,
      gate: summarizeGate(name, spec),
      baselinePath,
      baselineCount: baseline.count,
      nearestExpiry: baseline.nearestExpiry,
      status: matchingWaiver ? "waived" : "enforced",
      waivedReason: matchingWaiver?.reason ?? null,
    });
  }

  const md = readPlaybookMdSections(repoReal);
  const rules: PlaybookRuleSection[] = md.headings.map(({ section, title }) => {
    const sectionPrefix = `${section}/`;
    const directWaivers = playbookWaivers.filter((w) => {
      const k = w.key.trim().toLowerCase();
      if (k === String(section) || k.startsWith(sectionPrefix)) return true;
      const mapped = SECTION_CONTRACT_MAP[section] ?? [];
      return mapped.includes(k);
    });
    if (guardsExempt) {
      return {
        section,
        title,
        status: "waived",
        detail: `Guards exempt${guardsExempt.issueRef ? ` (${guardsExempt.issueRef})` : ""}`,
      };
    }
    if (directWaivers.length > 0) {
      const first = directWaivers[0]!;
      const suffix = first.issueRef ? ` (${first.issueRef})` : "";
      return {
        section,
        title,
        status: "waived",
        detail: `${first.key}${suffix}`,
      };
    }
    if (ALWAYS_ENFORCED_SECTIONS.has(section)) {
      return { section, title, status: "enforced", detail: null };
    }
    const mapped = SECTION_CONTRACT_MAP[section] ?? [];
    const hit = mapped.find((c) => declaredNames.has(c));
    if (hit) {
      const contract = contracts.find((c) => c.name === hit);
      const detail =
        contract?.baselineCount && contract.baselineCount > 0
          ? `baseline ${contract.baselineCount}`
          : null;
      return { section, title, status: "enforced", detail };
    }
    return { section, title, status: "not-declared", detail: null };
  });

  return {
    repoDir: repoReal,
    repoName,
    hasPlaybookJson,
    guardsExempt,
    contracts,
    rules,
    playbookMdPath: md.path,
  };
}
