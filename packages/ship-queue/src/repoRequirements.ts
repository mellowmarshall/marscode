// @effect-diagnostics nodeBuiltinImport:off - Discovers registered repositories and hot-reads their declared CI tool requirements.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { serviceToolSpecs } from "./ciServicesPlan.ts";
import { loadRepoDeclarationFromDir } from "./policyReload.ts";

export interface RegisteredRepoCheckout {
  readonly repo: string;
  readonly primary: string;
}

export interface RepoToolRequirement {
  readonly repo: string;
  readonly primary?: string | undefined;
  readonly requiredTools: ReadonlyArray<string>;
  readonly requiredArch?: ReadonlyArray<string> | undefined;
  readonly ciLocalOnly?: boolean | undefined;
}

/** Discovers registered repository checkouts under `<queueRoot>/repos/*` (both `registration.json` and legacy `primary`). */
export function discoverRegisteredRepos(queueRoot: string): ReadonlyArray<RegisteredRepoCheckout> {
  const reposDir = NodePath.join(queueRoot, "repos");
  if (!NodeFS.existsSync(reposDir)) return [];
  const byPrimary = new Map<string, RegisteredRepoCheckout>();
  let entries: NodeFS.Dirent[];
  try {
    entries = NodeFS.readdirSync(reposDir, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = NodePath.join(reposDir, entry.name);
    let primary = "";
    const regFile = NodePath.join(dir, "registration.json");
    if (NodeFS.existsSync(regFile)) {
      try {
        const parsed = JSON.parse(NodeFS.readFileSync(regFile, "utf8")) as Record<string, unknown>;
        if (typeof parsed.primary === "string") primary = parsed.primary.trim();
      } catch {
        // fall through to legacy primary file
      }
    }
    if (!primary) {
      const legacyPrimary = NodePath.join(dir, "primary");
      if (NodeFS.existsSync(legacyPrimary)) {
        try {
          primary = NodeFS.readFileSync(legacyPrimary, "utf8").trim();
        } catch {
          primary = "";
        }
      }
    }
    if (!primary || !NodePath.isAbsolute(primary)) continue;
    try {
      if (!NodeFS.statSync(primary).isDirectory()) continue;
    } catch {
      continue;
    }
    const resolved = NodePath.resolve(primary);
    if (!byPrimary.has(resolved)) {
      byPrimary.set(resolved, { repo: entry.name, primary: resolved });
    }
  }
  return [...byPrimary.values()].toSorted((a, b) => a.repo.localeCompare(b.repo));
}

/** Hot-reads `.tree-guard.conf` and `playbook.json` across configured repos to collect declared CI tool requirements. */
export function collectRepoToolRequirements(input: {
  readonly queueRoot: string;
  readonly extraRepoDirs?:
    | ReadonlyArray<{ readonly repo?: string | undefined; readonly primary: string }>
    | undefined;
  readonly filterRepo?: string | undefined;
}): ReadonlyArray<RepoToolRequirement> {
  const candidates = new Map<string, { readonly repo: string; readonly primary: string }>();
  for (const reg of discoverRegisteredRepos(input.queueRoot)) {
    candidates.set(reg.primary, reg);
  }
  for (const extra of input.extraRepoDirs ?? []) {
    const resolved = NodePath.resolve(extra.primary);
    try {
      if (!NodeFS.statSync(resolved).isDirectory()) continue;
    } catch {
      continue;
    }
    if (!candidates.has(resolved)) {
      candidates.set(resolved, {
        repo: extra.repo?.trim() || NodePath.basename(resolved),
        primary: resolved,
      });
    }
  }

  const filter = input.filterRepo?.trim().toLowerCase();
  const out: RepoToolRequirement[] = [];
  for (const item of [...candidates.values()].toSorted((a, b) => a.repo.localeCompare(b.repo))) {
    const loaded = loadRepoDeclarationFromDir(item.primary);
    const decl = loaded.declaration;
    const repoName = decl.repo || item.repo;
    if (filter) {
      const matches =
        repoName.toLowerCase() === filter ||
        item.repo.toLowerCase() === filter ||
        NodePath.basename(item.primary).toLowerCase() === filter;
      if (!matches) continue;
    }
    out.push({
      repo: repoName,
      primary: item.primary,
      requiredTools: serviceToolSpecs(decl.ciTools, decl.ciServices),
      requiredArch: decl.ciArch,
      ciLocalOnly: decl.ciLocalOnly,
    });
  }
  return out;
}
