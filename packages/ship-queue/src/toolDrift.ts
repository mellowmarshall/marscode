// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Eligible-host CI tool drift detection and single-host stranding analysis.
import * as NodePath from "node:path";

import {
  loadCiHostsManifest,
  normalizeArch,
  type CiHostEntry,
  type CiHostsManifest,
} from "./ciHosts.ts";
import {
  computeHostLacks,
  evaluateToolState,
  isToolOutOfScope,
  parseToolSpec,
  type ToolCheckState,
} from "./ciToolVersion.ts";
import { probeCiHost, readProbeFile, type HostExecDeps } from "./hostProbe.ts";
import { isHostOff } from "./hostOffMarker.ts";
import { collectRepoToolRequirements, type RepoToolRequirement } from "./repoRequirements.ts";
import { rootCommandOf } from "./rootGrant.ts";

export interface MissingToolDetail {
  readonly tool: string;
  readonly spec: string;
  readonly range: string;
  readonly have: string;
  readonly state: ToolCheckState;
  readonly autoProvisionable: boolean;
  readonly requiresRoot: boolean;
}

export interface HostToolDrift {
  readonly host: string;
  readonly arch: string;
  readonly os: string;
  readonly missing: ReadonlyArray<MissingToolDetail>;
  readonly autoProvisionableTools: ReadonlyArray<string>;
  readonly rootRequiredTools: ReadonlyArray<string>;
  readonly affectedRepos: ReadonlyArray<string>;
}

export interface RepoStrandingStatus {
  readonly repo: string;
  readonly requiredTools: ReadonlyArray<string>;
  readonly requiredArch: ReadonlyArray<string>;
  readonly eligibleHosts: ReadonlyArray<string>;
  readonly satisfyingHosts: ReadonlyArray<string>;
  readonly driftedSameArchHosts: ReadonlyArray<string>;
  readonly strandedOnSingleHost: boolean;
  readonly zeroSatisfyingHosts: boolean;
  readonly strandedHost?: string | undefined;
}

export interface ToolDriftReport {
  readonly schema: 1;
  readonly at: string;
  readonly requiredToolsUnion: ReadonlyArray<string>;
  readonly hasDrift: boolean;
  readonly hasSingleHostStranding: boolean;
  readonly repos: ReadonlyArray<RepoStrandingStatus>;
  readonly hosts: ReadonlyArray<HostToolDrift>;
  readonly unreachableHosts: ReadonlyArray<string>;
  readonly offHosts: ReadonlyArray<string>;
}

/** Reads cached `<queueRoot>/hosts/<host>.probe` files for every host in `manifest`. */
export function readCachedProbesByHost(
  queueRoot: string,
  manifest: CiHostsManifest,
): Readonly<Record<string, Readonly<Record<string, string>> | null>> {
  const out: Record<string, Readonly<Record<string, string>> | null> = {};
  for (const host of manifest.hosts) {
    out[host.name] = readProbeFile(NodePath.join(queueRoot, "hosts", `${host.name}.probe`));
  }
  return out;
}

interface ProbedHostInfo {
  readonly entry: CiHostEntry;
  readonly probe: Readonly<Record<string, string>>;
  readonly arch: string;
  readonly os: string;
}

function repoExcludedByToolOs(
  manifest: CiHostsManifest,
  requiredTools: ReadonlyArray<string>,
  hostOs: string,
): boolean {
  if (!hostOs) return false;
  for (const spec of requiredTools) {
    const parsed = parseToolSpec(spec, manifest.toolchain);
    if (!parsed.ok) continue;
    const tool = manifest.toolchain[parsed.name];
    if (tool && isToolOutOfScope(tool, hostOs)) return true;
  }
  return false;
}

function mergeVersionRanges(a: string, b: string): string {
  if (a === b) return a;
  const terms = [...new Set(`${a} ${b}`.split(/\s+/).filter((t) => t && t !== "*"))];
  return terms.length > 0 ? terms.join(" ") : "*";
}

function buildMissingToolDetail(
  manifest: CiHostsManifest,
  probe: Readonly<Record<string, string>>,
  lackLine: string,
  rangeOverride?: string,
): MissingToolDetail {
  const head = lackLine.split(" (", 1)[0] ?? lackLine;
  const atIdx = head.indexOf("@");
  const toolName = atIdx >= 0 ? head.slice(0, atIdx) : head;
  const range =
    rangeOverride ??
    (atIdx >= 0 ? head.slice(atIdx + 1) : (manifest.toolchain[toolName]?.version ?? "*"));
  const entry = manifest.toolchain[toolName];
  const have = probe[toolName] ?? "missing";
  // Evaluate against the repo's required range (which may be stricter than the manifest default).
  const effectiveToolchain =
    entry && range !== entry.version
      ? { ...manifest.toolchain, [toolName]: { ...entry, version: range } }
      : manifest.toolchain;
  const state = evaluateToolState(toolName, effectiveToolchain, probe);
  const autoProvisionable = Boolean(entry?.install);
  const requiresRoot =
    !autoProvisionable &&
    (state === "needs-root" || Boolean(rootCommandOf(entry, probe.__os ?? "")));
  return {
    tool: toolName,
    spec: `${toolName}@${range}`,
    range,
    have,
    state,
    autoProvisionable,
    requiresRoot,
  };
}

function synthesizeFleetToolchainRequirement(
  manifest: CiHostsManifest,
  probedHosts: ReadonlyArray<ProbedHostInfo>,
): RepoToolRequirement | null {
  const tools: string[] = [];
  for (const [name, spec] of Object.entries(manifest.toolchain)) {
    if (spec.optional) continue;
    const installedSomewhere = probedHosts.some(
      (h) => evaluateToolState(name, manifest.toolchain, h.probe) === "ok",
    );
    if (spec.base || installedSomewhere || spec.install !== null) {
      tools.push(`${name}@${spec.version}`);
    }
  }
  if (tools.length === 0) return null;
  return {
    repo: "fleet-toolchain",
    requiredTools: tools.toSorted(),
    requiredArch: [],
    ciLocalOnly: false,
  };
}

/**
 * Evaluates tool drift across all eligible same-arch CI hosts and highlights single-host
 * stranding (only 1 eligible host satisfies a repo while same-arch peers lack required tools).
 */
export function evaluateToolDrift(input: {
  readonly queueRoot: string;
  readonly manifest: CiHostsManifest;
  readonly probesByHost: Readonly<Record<string, Readonly<Record<string, string>> | null>>;
  readonly repos?: ReadonlyArray<RepoToolRequirement> | undefined;
  readonly includeManifestNonOptionalWhenNoRepos?: boolean | undefined;
  readonly ignoreOffState?: boolean | undefined;
  readonly at?: string | undefined;
}): ToolDriftReport {
  const at = input.at ?? new Date().toISOString();
  const probedHosts: ProbedHostInfo[] = [];
  const unreachableHosts: string[] = [];
  const offHosts: string[] = [];

  for (const host of input.manifest.hosts) {
    if (!input.ignoreOffState && isHostOff(input.queueRoot, host.name)) {
      offHosts.push(host.name);
      continue;
    }
    const probe = input.probesByHost[host.name];
    if (!probe) {
      unreachableHosts.push(host.name);
      continue;
    }
    probedHosts.push({
      entry: host,
      probe,
      arch: normalizeArch(probe.__arch ?? ""),
      os: (probe.__os ?? "").trim().toLowerCase(),
    });
  }

  let effectiveRepos: ReadonlyArray<RepoToolRequirement> = input.repos ?? [];
  if (effectiveRepos.length === 0 && input.includeManifestNonOptionalWhenNoRepos !== false) {
    const synth = synthesizeFleetToolchainRequirement(input.manifest, probedHosts);
    if (synth) effectiveRepos = [synth];
  }

  const requiredToolsUnion = new Set<string>();
  const repoStatuses: RepoStrandingStatus[] = [];
  const hostMissingMap = new Map<
    string,
    {
      readonly info: ProbedHostInfo;
      readonly missingByTool: Map<string, MissingToolDetail>;
      readonly affectedRepos: Set<string>;
    }
  >();

  const recordHostLack = (info: ProbedHostInfo, repoName: string, lackLine: string) => {
    const detail = buildMissingToolDetail(input.manifest, info.probe, lackLine);
    let rec = hostMissingMap.get(info.entry.name);
    if (!rec) {
      rec = { info, missingByTool: new Map(), affectedRepos: new Set() };
      hostMissingMap.set(info.entry.name, rec);
    }
    rec.affectedRepos.add(repoName);
    const existing = rec.missingByTool.get(detail.tool);
    if (!existing) {
      rec.missingByTool.set(detail.tool, detail);
    } else if (existing.range !== detail.range) {
      const mergedRange = mergeVersionRanges(existing.range, detail.range);
      rec.missingByTool.set(
        detail.tool,
        buildMissingToolDetail(input.manifest, info.probe, lackLine, mergedRange),
      );
    }
    // If a missing tool waits on a user-installable dependency, include that dependency too.
    const toolEntry = input.manifest.toolchain[detail.tool];
    for (const depName of toolEntry?.needs ?? []) {
      const depSpec = input.manifest.toolchain[depName];
      if (!depSpec?.install) continue;
      if (evaluateToolState(depName, input.manifest.toolchain, info.probe) !== "ok") {
        const depDetail = buildMissingToolDetail(
          input.manifest,
          info.probe,
          `${depName}@${depSpec.version} (has ${info.probe[depName] ?? "missing"})`,
        );
        if (!rec.missingByTool.has(depDetail.tool)) {
          rec.missingByTool.set(depDetail.tool, depDetail);
        }
      }
    }
  };

  for (const repo of effectiveRepos) {
    for (const spec of repo.requiredTools) requiredToolsUnion.add(spec);
    const reqArches = (repo.requiredArch ?? []).map(normalizeArch).filter(Boolean);
    const archFilter = new Set(reqArches);

    const eligible = probedHosts.filter((h) => {
      if (repo.ciLocalOnly && h.entry.ssh !== null) return false;
      if (archFilter.size > 0 && (!h.arch || !archFilter.has(h.arch))) return false;
      if (repoExcludedByToolOs(input.manifest, repo.requiredTools, h.os)) return false;
      return true;
    });

    const satisfying: ProbedHostInfo[] = [];
    const drifted: Array<{ readonly info: ProbedHostInfo; readonly lacks: ReadonlyArray<string> }> =
      [];

    for (const h of eligible) {
      const lacks = computeHostLacks(input.manifest, h.probe, "base", repo.requiredTools);
      if (lacks.length === 0) satisfying.push(h);
      else drifted.push({ info: h, lacks });
    }

    const sameArchSet =
      archFilter.size > 0 ? archFilter : new Set(satisfying.map((h) => h.arch).filter(Boolean));
    const sameArchDrifted = drifted.filter(
      (d) => sameArchSet.size === 0 || !d.info.arch || sameArchSet.has(d.info.arch),
    );

    for (const item of sameArchDrifted) {
      for (const lackLine of item.lacks) {
        recordHostLack(item.info, repo.repo, lackLine);
      }
    }

    const satisfyingNames = satisfying.map((h) => h.entry.name).toSorted();
    const driftedNames = sameArchDrifted.map((d) => d.info.entry.name).toSorted();
    const strandedOnSingleHost =
      !repo.ciLocalOnly && satisfyingNames.length === 1 && driftedNames.length > 0;
    const zeroSatisfyingHosts = satisfyingNames.length === 0 && driftedNames.length > 0;

    repoStatuses.push({
      repo: repo.repo,
      requiredTools: [...repo.requiredTools].toSorted(),
      requiredArch: reqArches.toSorted(),
      eligibleHosts: eligible.map((h) => h.entry.name).toSorted(),
      satisfyingHosts: satisfyingNames,
      driftedSameArchHosts: driftedNames,
      strandedOnSingleHost,
      zeroSatisfyingHosts,
      ...(strandedOnSingleHost && satisfyingNames[0] ? { strandedHost: satisfyingNames[0] } : {}),
    });
  }

  const hosts: HostToolDrift[] = [...hostMissingMap.values()]
    .map(({ info, missingByTool, affectedRepos }) => {
      const missing = [...missingByTool.values()].toSorted((a, b) => a.tool.localeCompare(b.tool));
      return {
        host: info.entry.name,
        arch: info.arch,
        os: info.os,
        missing,
        autoProvisionableTools: missing
          .filter((m) => m.autoProvisionable)
          .map((m) => m.tool)
          .toSorted(),
        rootRequiredTools: missing
          .filter((m) => m.requiresRoot)
          .map((m) => m.tool)
          .toSorted(),
        affectedRepos: [...affectedRepos].toSorted(),
      };
    })
    .toSorted((a, b) => a.host.localeCompare(b.host));

  const hasSingleHostStranding = repoStatuses.some((r) => r.strandedOnSingleHost);
  const hasDrift = hosts.length > 0 || repoStatuses.some((r) => r.zeroSatisfyingHosts);

  return {
    schema: 1,
    at,
    requiredToolsUnion: [...requiredToolsUnion].toSorted(),
    hasDrift,
    hasSingleHostStranding,
    repos: repoStatuses.toSorted((a, b) => a.repo.localeCompare(b.repo)),
    hosts,
    unreachableHosts: unreachableHosts.toSorted(),
    offHosts: offHosts.toSorted(),
  };
}

/** Loads manifest + repo requirements fresh, probes enabled CI hosts, and returns a structured drift report. */
export async function checkHostsToolDrift(input: {
  readonly queueRoot: string;
  readonly manifestPath?: string | undefined;
  readonly targetRepo?: string | undefined;
  readonly extraRepoDirs?:
    | ReadonlyArray<{ readonly repo?: string | undefined; readonly primary: string }>
    | undefined;
  readonly fresh?: boolean | undefined;
  readonly deps?: HostExecDeps | undefined;
}): Promise<{
  readonly ok: boolean;
  readonly report?: ToolDriftReport | undefined;
  readonly error?: string | undefined;
}> {
  const loaded = loadCiHostsManifest({ overridePath: input.manifestPath });
  if (!loaded.ok || !loaded.manifest) {
    return { ok: false, error: loaded.errors.join("; ") };
  }
  const manifest = loaded.manifest;
  const probesByHost: Record<string, Readonly<Record<string, string>> | null> = {};
  for (const host of manifest.hosts) {
    if (isHostOff(input.queueRoot, host.name)) {
      probesByHost[host.name] = null;
      continue;
    }
    probesByHost[host.name] = await probeCiHost({
      queueRoot: input.queueRoot,
      manifest,
      manifestPath: loaded.path ?? undefined,
      host,
      fresh: input.fresh,
      deps: input.deps,
    });
  }

  const repos = collectRepoToolRequirements({
    queueRoot: input.queueRoot,
    extraRepoDirs: input.extraRepoDirs,
    filterRepo: input.targetRepo,
  });
  const at = (input.deps?.nowIso ?? (() => new Date().toISOString()))();
  const report = evaluateToolDrift({
    queueRoot: input.queueRoot,
    manifest,
    probesByHost,
    repos,
    includeManifestNonOptionalWhenNoRepos: !input.targetRepo,
    at,
  });
  return { ok: true, report };
}

/** Formats a concise human-readable summary of a `ToolDriftReport` for CLI output. */
export function formatToolDriftReport(report: ToolDriftReport): string {
  const lines: string[] = [];
  if (!report.hasDrift) {
    lines.push(
      `CI toolchain aligned: 0 drifted hosts (${report.requiredToolsUnion.length} required tools checked)`,
    );
  } else {
    for (const repo of report.repos) {
      if (repo.zeroSatisfyingHosts) {
        lines.push(
          `BLOCKED repo=${repo.repo} satisfying=0 drifted=${repo.driftedSameArchHosts.join(",")} tools=${repo.requiredTools.join(",")}`,
        );
      } else if (repo.strandedOnSingleHost) {
        lines.push(
          `STRANDED repo=${repo.repo} host=${repo.strandedHost ?? "unknown"} drifted=${repo.driftedSameArchHosts.join(",")} tools=${repo.requiredTools.join(",")}`,
        );
      }
    }
    for (const h of report.hosts) {
      const specs = h.missing.map((m) => `${m.spec}[${m.have}]`).join(", ");
      const rootTag =
        h.rootRequiredTools.length > 0 ? ` needs-root=${h.rootRequiredTools.join(",")}` : "";
      lines.push(
        `DRIFT host=${h.host} (${h.arch || "unknown"}) missing=${specs}${rootTag} repos=${h.affectedRepos.join(",")}`,
      );
    }
  }
  if (report.unreachableHosts.length > 0) {
    lines.push(`UNREACHABLE hosts=${report.unreachableHosts.join(",")}`);
  }
  if (report.offHosts.length > 0) {
    lines.push(`OFF hosts=${report.offHosts.join(",")}`);
  }
  return `${lines.join("\n")}\n`;
}
