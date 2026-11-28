// @effect-diagnostics nodeBuiltinImport:off globalDate:off - CI host probing, off/on state, schema-1 health reports, provisioning, and infra/ci-host sync.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { shellSingleQuote } from "@t3tools/ssh/command";

import {
  expandDataRoot,
  isSafeHostName,
  loadCiHostsManifest,
  normalizeArch,
  type CiHostEntry,
  type CiHostsManifest,
} from "./ciHosts.ts";
import { dataRootUnderHome, dataRootUnderHomeNote } from "./dataRootPolicy.ts";
import { evaluateToolState, type ToolCheckState } from "./ciToolVersion.ts";
import { nodeProcessRunner } from "./nodeProcess.ts";
import { buildRootGrantRequest, planToolProvides } from "./rootGrant.ts";
import { sshRemoteCommandRunner, type RemoteCommandRunner } from "./sshExec.ts";
import { buildToolchainEnv, buildToolchainShellSetup } from "./toolchainEnv.ts";
import type { ProcessResult, ProcessRunner } from "./types.ts";

const MEASURED_PROBES = new Set(["hardware-gpu", "webkit-video"]);
const DEFAULT_PROBE_TTL_MS = 300_000;

export interface HostOffState {
  readonly at: string;
  readonly by: string;
  readonly reason: string;
}

export interface HostCheckToolRow {
  readonly name: string;
  readonly range: string;
  readonly version: string | null;
  readonly state: ToolCheckState;
  readonly install: "user" | "root";
  readonly note?: string | undefined;
}

export interface HostCheckDriftRow {
  readonly text: string;
  readonly state: "needs-root" | "unknown" | "update" | "drift" | "missing";
}

export interface HostCheckEntry {
  readonly name: string;
  readonly ssh: string | null;
  readonly reached: boolean;
  readonly probed_at: string | null;
  readonly platform: string | null;
  readonly arch: string | null;
  readonly tools: ReadonlyArray<HostCheckToolRow>;
  readonly drift: ReadonlyArray<HostCheckDriftRow>;
  readonly notes: ReadonlyArray<string>;
  /** The host's data root is under a home directory (see dataRootPolicy.ts). */
  readonly data_root_under_home: boolean;
  readonly grants: {
    readonly host: string;
    readonly grant: ReadonlyArray<string>;
    readonly local: ReadonlyArray<string>;
  } | null;
  readonly no_grant: ReadonlyArray<{ readonly tool: string; readonly why: string }>;
  readonly grant_error: string;
  readonly ci_off: boolean;
  readonly ci_off_at: string | null;
  readonly ci_off_by: string | null;
  readonly ci_off_reason: string | null;
}

export interface HostsCheckReport {
  readonly schema: 1;
  readonly at: string;
  readonly manifest?: string | undefined;
  readonly hosts: ReadonlyArray<HostCheckEntry>;
  readonly settings: ReadonlyArray<Record<string, unknown>>;
}

export interface HostExecDeps {
  readonly runLocal?: ProcessRunner | undefined;
  readonly runRemote?: RemoteCommandRunner | undefined;
  readonly homeDir?: string | undefined;
  readonly nowMs?: (() => number) | undefined;
  readonly nowIso?: (() => string) | undefined;
}

export function hostOffFilePath(queueRoot: string, hostName: string): string {
  return NodePath.join(queueRoot, "hosts", `${hostName}.off`);
}

export function readHostOffState(queueRoot: string, hostName: string): HostOffState | null {
  const filePath = hostOffFilePath(queueRoot, hostName);
  if (!NodeFS.existsSync(filePath)) return null;
  const text = NodeFS.readFileSync(filePath, "utf8");
  const fields: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const eq = line.indexOf("=");
    if (eq > 0) fields[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return {
    at: fields.at ?? "",
    by: fields.by ?? "",
    reason: fields.reason ?? "",
  };
}

export function isHostOff(queueRoot: string, hostName: string): boolean {
  return NodeFS.existsSync(hostOffFilePath(queueRoot, hostName));
}

export function setCiHostAvailability(input: {
  readonly queueRoot: string;
  readonly hostName: string;
  readonly enabled: boolean;
  readonly reason?: string | undefined;
  readonly actor?: string | undefined;
  readonly manifestPath?: string | undefined;
  readonly nowIso?: (() => string) | undefined;
}): { readonly ok: boolean; readonly message: string; readonly changed: boolean } {
  const name = input.hostName.trim();
  if (!isSafeHostName(name)) {
    return { ok: false, message: `Invalid host name: ${name}`, changed: false };
  }
  const loaded = loadCiHostsManifest({ overridePath: input.manifestPath });
  const declared =
    loaded.ok && loaded.manifest ? loaded.manifest.hosts.some((h) => h.name === name) : false;
  const filePath = hostOffFilePath(input.queueRoot, name);

  if (input.enabled) {
    if (!declared && !NodeFS.existsSync(filePath)) {
      return { ok: false, message: `no CI host ${name} in manifest`, changed: false };
    }
    if (!NodeFS.existsSync(filePath)) {
      return { ok: true, message: `ci host ${name} is already on for CI`, changed: false };
    }
    NodeFS.rmSync(filePath, { force: true });
    return { ok: true, message: `CI enabled on ${name}`, changed: true };
  }

  if (loaded.ok && !declared) {
    return { ok: false, message: `no CI host ${name} in manifest`, changed: false };
  }
  if (NodeFS.existsSync(filePath)) {
    return { ok: true, message: `ci host ${name} is already off for CI`, changed: false };
  }
  const dir = NodePath.dirname(filePath);
  NodeFS.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const cleanReason = (input.reason ?? "").replace(/[\n\r\t]/g, " ").trim();
  const actor = input.actor ?? safeUsername();
  const at = (input.nowIso ?? (() => new Date().toISOString()))();
  const tmp = `${filePath}.tmp.${process.pid}`;
  NodeFS.writeFileSync(tmp, `at=${at}\nby=${actor}\nreason=${cleanReason}\n`, { mode: 0o600 });
  NodeFS.renameSync(tmp, filePath);
  return { ok: true, message: `CI disabled on ${name}`, changed: true };
}

function safeUsername(): string {
  try {
    return NodeOS.userInfo().username || "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Builds the host probe bash script using the ONE unified `buildToolchainShellSetup`.
 * Guarantees probes and CI steps observe the exact same `PATH` (including `$HOME/.vite-plus/bin`).
 */
export function buildHostProbeScript(manifest: CiHostsManifest): string {
  const lines: string[] = [
    buildToolchainShellSetup(),
    'printf "__os\\t%s\\n" "$(uname -s | tr "[:upper:]" "[:lower:]")"',
    'printf "__arch\\t%s\\n" "$(uname -m)"',
    'printf "__home\\t%s\\n" "$HOME"',
    'pd=$(mktemp -d) || { echo "ci probe: no temporary directory" >&2; exit 1; }',
    "trap 'rm -rf \"$pd\"' EXIT",
  ];

  const measured: string[] = [];
  let idx = 0;
  for (const [name, tool] of Object.entries(manifest.toolchain)) {
    idx += 1;
    const seq = String(idx).padStart(4, "0");
    const cmd = `( if o=$(timeout 30 bash -c ${shellSingleQuote(tool.probe)} 2>&1 </dev/null); then v=$(printf '%s' "$o" | grep -oE '[0-9]+(\\.[0-9]+)*' | head -1); printf '%s\\t%s\\n' ${shellSingleQuote(name)} "\${v:-?}"; else printf '%s\\tmissing\\n' ${shellSingleQuote(name)}; fi ) > "$pd/${seq}"`;
    if (MEASURED_PROBES.has(name)) {
      measured.push(cmd);
    } else {
      lines.push(`${cmd} &`);
    }
  }
  lines.push("wait", ...measured, 'cat "$pd"/* 2>/dev/null');
  return lines.join("\n");
}

export function parseProbeOutput(stdout: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of stdout.split(/\r?\n/)) {
    const tab = line.indexOf("\t");
    if (tab <= 0) continue;
    const key = line.slice(0, tab);
    const val = line.slice(tab + 1);
    if (key && val) out[key] = val;
  }
  return out;
}

export function readProbeFile(filePath: string): Record<string, string> | null {
  if (!NodeFS.existsSync(filePath)) return null;
  try {
    const parsed = parseProbeOutput(NodeFS.readFileSync(filePath, "utf8"));
    return Object.keys(parsed).length > 0 ? parsed : null;
  } catch {
    return null;
  }
}

export function writeProbeFile(filePath: string, probe: Readonly<Record<string, string>>): void {
  NodeFS.mkdirSync(NodePath.dirname(filePath), { recursive: true, mode: 0o700 });
  const content =
    Object.entries(probe)
      .map(([k, v]) => `${k}\t${v}`)
      .join("\n") + "\n";
  const tmp = `${filePath}.tmp.${process.pid}`;
  NodeFS.writeFileSync(tmp, content, { mode: 0o600 });
  NodeFS.renameSync(tmp, filePath);
}

export async function execOnHost(
  host: CiHostEntry,
  bashScript: string,
  deps: HostExecDeps = {},
  options: { readonly stdin?: string | undefined; readonly timeoutMs?: number | undefined } = {},
): Promise<ProcessResult> {
  if (host.ssh) {
    const runRemote = deps.runRemote ?? sshRemoteCommandRunner;
    return runRemote(host.ssh, bashScript, options);
  }
  const runLocal = deps.runLocal ?? nodeProcessRunner;
  const env = buildToolchainEnv(process.env, {
    homeDir: deps.homeDir,
    dataRoot: expandDataRoot(host.data_root, deps.homeDir),
  });
  return runLocal({
    command: "bash",
    args: ["-c", bashScript],
    cwd: deps.homeDir ?? NodeOS.homedir(),
    env,
    stdin: options.stdin,
  });
}

export async function probeCiHost(input: {
  readonly queueRoot: string;
  readonly manifest: CiHostsManifest;
  readonly manifestPath?: string | undefined;
  readonly host: CiHostEntry;
  readonly fresh?: boolean | undefined;
  readonly probeTtlMs?: number | undefined;
  readonly deps?: HostExecDeps | undefined;
}): Promise<Record<string, string> | null> {
  const probePath = NodePath.join(input.queueRoot, "hosts", `${input.host.name}.probe`);
  const nowMs = (input.deps?.nowMs ?? (() => Date.now()))();
  const ttlMs = input.probeTtlMs ?? DEFAULT_PROBE_TTL_MS;

  if (!input.fresh && NodeFS.existsSync(probePath)) {
    const st = NodeFS.statSync(probePath);
    const manifestMtime =
      input.manifestPath && NodeFS.existsSync(input.manifestPath)
        ? NodeFS.statSync(input.manifestPath).mtimeMs
        : 0;
    if (st.mtimeMs >= manifestMtime && nowMs - st.mtimeMs < ttlMs) {
      const cached = readProbeFile(probePath);
      if (cached) return cached;
    }
  }

  const script = buildHostProbeScript(input.manifest);
  const res = await execOnHost(input.host, script, input.deps, { timeoutMs: 120_000 });
  if (res.exitCode !== 0) return null;
  const parsed = parseProbeOutput(res.stdout);
  if (Object.keys(parsed).length === 0) return null;
  writeProbeFile(probePath, parsed);
  return parsed;
}

/** Runs a native schema-1 `hosts check` across one or all manifest hosts with zero CLI shell-out. */
export async function checkCiHosts(input: {
  readonly queueRoot: string;
  readonly manifestPath?: string | undefined;
  readonly targetHost?: string | undefined;
  readonly deps?: HostExecDeps | undefined;
}): Promise<{
  readonly ok: boolean;
  readonly drift: boolean;
  readonly report?: HostsCheckReport | undefined;
  readonly error?: string | undefined;
}> {
  const loaded = loadCiHostsManifest({ overridePath: input.manifestPath });
  if (!loaded.ok || !loaded.manifest) {
    return { ok: false, drift: true, error: loaded.errors.join("; ") };
  }
  const manifest = loaded.manifest;
  const hostsToCheck = input.targetHost
    ? manifest.hosts.filter((h) => h.name === input.targetHost)
    : manifest.hosts;
  if (input.targetHost && hostsToCheck.length === 0) {
    return { ok: false, drift: true, error: `no CI host ${input.targetHost} in manifest` };
  }

  const at = (input.deps?.nowIso ?? (() => new Date().toISOString()))();
  const entries: HostCheckEntry[] = [];
  let hasDrift = false;

  for (const host of hostsToCheck) {
    const off = readHostOffState(input.queueRoot, host.name);
    // Moving a data root out of /home needs root, so the Fleet card shows it as a needs-root row.
    const homeRoot = dataRootUnderHome(host.data_root);
    const drift: HostCheckDriftRow[] = homeRoot
      ? [{ text: dataRootUnderHomeNote(host.data_root), state: "needs-root" }]
      : [];
    if (homeRoot) hasDrift = true;
    const probe = await probeCiHost({
      queueRoot: input.queueRoot,
      manifest,
      manifestPath: loaded.path ?? undefined,
      host,
      fresh: true,
      deps: input.deps,
    });
    if (!probe) {
      hasDrift = true;
      entries.push({
        name: host.name,
        ssh: host.ssh,
        reached: false,
        probed_at: null,
        platform: null,
        arch: null,
        tools: [],
        drift,
        notes: [],
        data_root_under_home: homeRoot,
        grants: null,
        no_grant: [],
        grant_error: "",
        ci_off: Boolean(off),
        ci_off_at: off?.at || null,
        ci_off_by: off?.by || null,
        ci_off_reason: off?.reason || null,
      });
      continue;
    }

    const platform = probe.__os ?? null;
    const tools: HostCheckToolRow[] = [];
    const needsRootLacks: string[] = [];
    for (const [toolName, toolSpec] of Object.entries(manifest.toolchain)) {
      const state = evaluateToolState(toolName, manifest.toolchain, probe);
      if (state === "missing" || state === "needs-root" || state === "unknown") hasDrift = true;
      const version = probe[toolName] ?? null;
      if (state === "needs-root") {
        needsRootLacks.push(`${toolName}@${toolSpec.version} (has ${version ?? "missing"})`);
      }
      tools.push({
        name: toolName,
        range: toolSpec.version,
        version,
        state,
        install: toolSpec.install ? "user" : "root",
        ...(state !== "ok" && state !== "not-for-host" && toolSpec.note
          ? { note: toolSpec.note }
          : {}),
      });
    }

    let grants: HostCheckEntry["grants"] = null;
    const noGrant: Array<{ readonly tool: string; readonly why: string }> = [];
    let grantError = "";
    if (needsRootLacks.length > 0) {
      const planned = planToolProvides(manifest.toolchain, platform ?? "", needsRootLacks);
      const rootTools: string[] = [];
      for (const item of planned) {
        if (item.kind === "root" || item.kind === "both") rootTools.push(item.tool);
        else if (item.kind === "none")
          noGrant.push({ tool: item.tool, why: item.reason ?? "no grant" });
      }
      if (rootTools.length > 0) {
        try {
          const req = buildRootGrantRequest(manifest.toolchain, [
            {
              host: host.name,
              ssh: host.ssh ?? "",
              home: probe.__home ?? "/root",
              os: platform ?? "",
              tools: rootTools,
              ...(host.wsl ? { wsl: host.wsl } : {}),
            },
          ]);
          const first = req.hosts[0];
          if (first) {
            grants = { host: first.host, grant: first.grant, local: first.local };
          }
        } catch (err) {
          grantError = err instanceof Error ? err.message : String(err);
        }
      }
    }

    entries.push({
      name: host.name,
      ssh: host.ssh,
      reached: true,
      probed_at: at,
      platform,
      arch: probe.__arch ? normalizeArch(probe.__arch) : null,
      tools,
      drift,
      notes: [],
      data_root_under_home: homeRoot,
      grants,
      no_grant: noGrant,
      grant_error: grantError,
      ci_off: Boolean(off),
      ci_off_at: off?.at || null,
      ci_off_by: off?.by || null,
      ci_off_reason: off?.reason || null,
    });
  }

  return {
    ok: true,
    drift: hasDrift,
    report: {
      schema: 1,
      at,
      ...(loaded.path ? { manifest: loaded.path } : {}),
      hosts: entries,
      settings: [],
    },
  };
}
