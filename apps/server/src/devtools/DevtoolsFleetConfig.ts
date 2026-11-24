// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - Fleet-wide DevTools host-config.json discovery, read, and SSH sync across workstations, stock T3 hosts, and bare VPSes.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  defaultHostConfigPath,
  normalizeHostConfig,
  prepareMergedHostConfig,
  readDevtoolsHostConfig,
  writeDevtoolsHostConfig,
  type DevtoolsHostConfig,
} from "./DevtoolsConfig.ts";

const SAFE_SSH_ALIAS_RE = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$/;
const DEFAULT_SSH_TIMEOUT_MS = 10_000;
const REMOTE_CONFIG_REL_PATH = ".local/lib/ship-queue/host-config.json";

const REMOTE_READ_SH =
  'p="$HOME/.local/lib/ship-queue/host-config.json"; if [ -f "$p" ]; then cat "$p"; else printf "{}"; fi';
const REMOTE_WRITE_SH =
  'set -e; umask 077; d="$HOME/.local/lib/ship-queue"; mkdir -p "$d"; tmp="$d/.host-config.json.tmp.$$"; trap \'rm -f "$tmp"\' EXIT; cat > "$tmp"; mv -f "$tmp" "$d/host-config.json"; trap - EXIT';

export interface FleetHostDescriptor {
  readonly name: string;
  readonly label: string;
  readonly ssh: string | null;
  readonly local: boolean;
  readonly role: string;
  readonly onHost?: string | undefined;
}

export interface FleetHostConfigState {
  readonly host: FleetHostDescriptor;
  readonly reachable: boolean;
  readonly exists: boolean;
  readonly inSyncWithLocal: boolean;
  readonly configPath: string;
  readonly config: DevtoolsHostConfig | null;
  readonly error?: string | undefined;
}

export interface FleetConfigSnapshot {
  readonly localHost: string;
  readonly localConfig: DevtoolsHostConfig;
  readonly hosts: ReadonlyArray<FleetHostConfigState>;
}

export interface FleetWriteResultEntry {
  readonly host: string;
  readonly ssh: string | null;
  readonly local: boolean;
  readonly ok: boolean;
  readonly config?: DevtoolsHostConfig | undefined;
  readonly error?: string | undefined;
}

export interface FleetWriteResponse {
  readonly ok: boolean;
  readonly targetHost: string;
  readonly results: ReadonlyArray<FleetWriteResultEntry>;
  readonly config?: DevtoolsHostConfig | undefined;
}

export interface SshRunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type SshRunner = (
  sshAlias: string,
  remoteScript: string,
  options?: {
    readonly stdin?: string | undefined;
    readonly timeoutMs?: number | undefined;
    readonly signal?: AbortSignal | undefined;
  },
) => Promise<SshRunResult>;

export interface FleetConfigOptions {
  readonly ciHostsPath?: string | undefined;
  readonly localConfigPath?: string | undefined;
  readonly sshRunner?: SshRunner | undefined;
  readonly timeoutMs?: number | undefined;
  readonly signal?: AbortSignal | undefined;
}

export function isValidSshAlias(alias: string): boolean {
  return SAFE_SSH_ALIAS_RE.test(alias);
}

function defaultCiHostsPath(): string {
  const libDir =
    process.env.SHIP_QUEUE_LIB_DIR?.trim() ||
    NodePath.join(NodeOS.homedir(), ".local", "lib", "ship-queue");
  return NodePath.join(libDir, "ci-hosts.json");
}

function defaultSshRunner(
  sshAlias: string,
  remoteScript: string,
  options: {
    readonly stdin?: string | undefined;
    readonly timeoutMs?: number | undefined;
    readonly signal?: AbortSignal | undefined;
  } = {},
): Promise<SshRunResult> {
  if (!isValidSshAlias(sshAlias)) {
    return Promise.resolve({
      exitCode: 2,
      stdout: "",
      stderr: `Invalid SSH host alias: ${sshAlias}`,
    });
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_SSH_TIMEOUT_MS;
  return new Promise((resolve) => {
    const child = NodeChildProcess.spawn(
      "ssh",
      [
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=5",
        "-o",
        "ServerAliveInterval=5",
        "-o",
        "ServerAliveCountMax=1",
        "-T",
        "--",
        sshAlias,
        remoteScript,
      ],
      {
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (result: SshRunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };

    const onAbort = () => {
      child.kill("SIGTERM");
      finish({ exitCode: 124, stdout, stderr: stderr || "SSH operation aborted" });
    };

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish({
        exitCode: 124,
        stdout,
        stderr: stderr || `SSH timed out after ${timeoutMs}ms`,
      });
    }, timeoutMs);

    if (options.signal) {
      if (options.signal.aborted) {
        onAbort();
        return;
      }
      options.signal.addEventListener("abort", onAbort, { once: true });
    }

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (stdout.length < 256 * 1024) stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < 32 * 1024) stderr += chunk;
    });
    child.on("error", (err) => {
      finish({ exitCode: 1, stdout, stderr: err.message });
    });
    child.on("close", (code) => {
      finish({ exitCode: code ?? 1, stdout, stderr });
    });

    if (options.stdin !== undefined) {
      child.stdin.write(options.stdin, "utf8");
    }
    child.stdin.end();
  });
}

export function discoverFleetHosts(
  ciHostsPath: string = defaultCiHostsPath(),
): ReadonlyArray<FleetHostDescriptor> {
  const hosts: FleetHostDescriptor[] = [];
  const seenNames = new Set<string>();
  const localHostname = NodeOS.hostname();
  let sawLocal = false;

  const pushHost = (desc: FleetHostDescriptor) => {
    const key = desc.name.toLowerCase();
    if (seenNames.has(key)) return;
    seenNames.add(key);
    hosts.push(desc);
  };

  try {
    if (NodeFS.existsSync(ciHostsPath)) {
      const parsed = JSON.parse(NodeFS.readFileSync(ciHostsPath, "utf8")) as {
        readonly hosts?: ReadonlyArray<Record<string, unknown>>;
      };
      const rawHosts = Array.isArray(parsed.hosts) ? parsed.hosts : [];
      const parentHosts: string[] = [];

      for (const entry of rawHosts) {
        if (!entry || typeof entry !== "object") continue;
        const name = typeof entry.name === "string" ? entry.name.trim() : "";
        if (!name) continue;
        const sshRaw = entry.ssh;
        const ssh = typeof sshRaw === "string" && sshRaw.trim() ? sshRaw.trim() : null;
        const local = ssh === null;
        if (local) sawLocal = true;
        if (!local && ssh && !isValidSshAlias(ssh)) continue;
        const role = typeof entry.role === "string" && entry.role.trim() ? entry.role.trim() : "ci";
        const onHost =
          typeof entry.on === "string" && entry.on.trim() ? entry.on.trim() : undefined;
        pushHost({
          name,
          label: local ? `${name} (this host)` : name,
          ssh,
          local,
          role,
          onHost,
        });
        if (onHost && isValidSshAlias(onHost)) {
          parentHosts.push(onHost);
        }
      }

      // Include parent workstation hosts (e.g. macOS host "host-x" running OrbStack guest).
      for (const parentName of parentHosts) {
        pushHost({
          name: parentName,
          label: parentName,
          ssh: parentName,
          local: false,
          role: "workstation",
        });
      }
    }
  } catch {
    // Fallback to local host alone if ci-hosts.json is missing or malformed.
  }

  if (!sawLocal) {
    hosts.unshift({
      name: localHostname,
      label: `${localHostname} (this host)`,
      ssh: null,
      local: true,
      role: "local",
    });
  }
  return hosts;
}

function configsEqual(a: DevtoolsHostConfig, b: DevtoolsHostConfig): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function parseRemoteJsonObject(stdout: string): {
  readonly exists: boolean;
  readonly raw: Record<string, unknown>;
} {
  const trimmed = stdout.trim();
  if (!trimmed || trimmed === "{}") {
    return { exists: false, raw: {} };
  }
  const parsed = JSON.parse(trimmed);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { exists: true, raw: {} };
  }
  return { exists: true, raw: parsed as Record<string, unknown> };
}

export async function readFleetHostConfig(
  host: FleetHostDescriptor,
  localConfig: DevtoolsHostConfig,
  options: FleetConfigOptions = {},
): Promise<FleetHostConfigState> {
  const localConfigPath = options.localConfigPath ?? defaultHostConfigPath();
  if (host.local || !host.ssh) {
    const exists = NodeFS.existsSync(localConfigPath);
    const config = readDevtoolsHostConfig(localConfigPath);
    return {
      host,
      reachable: true,
      exists,
      inSyncWithLocal: configsEqual(config, localConfig),
      configPath: localConfigPath,
      config,
    };
  }

  const runner = options.sshRunner ?? defaultSshRunner;
  const res = await runner(host.ssh, REMOTE_READ_SH, {
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  });
  if (res.exitCode !== 0) {
    return {
      host,
      reachable: false,
      exists: false,
      inSyncWithLocal: false,
      configPath: `~/${REMOTE_CONFIG_REL_PATH}`,
      config: null,
      error: res.stderr.trim() || `SSH exited with code ${res.exitCode}`,
    };
  }
  try {
    const parsed = parseRemoteJsonObject(res.stdout);
    const config = normalizeHostConfig(parsed.raw);
    return {
      host,
      reachable: true,
      exists: parsed.exists,
      inSyncWithLocal: configsEqual(config, localConfig),
      configPath: `~/${REMOTE_CONFIG_REL_PATH}`,
      config,
    };
  } catch (err) {
    return {
      host,
      reachable: true,
      exists: true,
      inSyncWithLocal: false,
      configPath: `~/${REMOTE_CONFIG_REL_PATH}`,
      config: null,
      error: `Invalid remote host-config.json: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export async function readFleetConfigSnapshot(
  options: FleetConfigOptions = {},
): Promise<FleetConfigSnapshot> {
  const localConfigPath = options.localConfigPath ?? defaultHostConfigPath();
  const localConfig = readDevtoolsHostConfig(localConfigPath);
  const discovered = discoverFleetHosts(options.ciHostsPath);
  const localDesc = discovered.find((h) => h.local);
  const states = await Promise.all(
    discovered.map((host) => readFleetHostConfig(host, localConfig, options)),
  );
  return {
    localHost: localDesc?.name ?? NodeOS.hostname(),
    localConfig,
    hosts: states,
  };
}

export function findFleetHost(
  target: string,
  options: Pick<FleetConfigOptions, "ciHostsPath"> = {},
): FleetHostDescriptor | null {
  const needle = target.trim().toLowerCase();
  if (!needle) return null;
  const hosts = discoverFleetHosts(options.ciHostsPath);
  if (needle === "local" || needle === "this") {
    return hosts.find((h) => h.local) ?? null;
  }
  return (
    hosts.find(
      (h) => h.name.toLowerCase() === needle || (h.ssh && h.ssh.toLowerCase() === needle),
    ) ?? null
  );
}

async function writeSingleRemoteHost(
  host: FleetHostDescriptor,
  patch: Record<string, unknown>,
  options: FleetConfigOptions,
): Promise<FleetWriteResultEntry> {
  if (!host.ssh) {
    return {
      host: host.name,
      ssh: null,
      local: false,
      ok: false,
      error: "Host has no SSH alias",
    };
  }
  const runner = options.sshRunner ?? defaultSshRunner;
  const readRes = await runner(host.ssh, REMOTE_READ_SH, {
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  });
  if (readRes.exitCode !== 0) {
    return {
      host: host.name,
      ssh: host.ssh,
      local: false,
      ok: false,
      error: readRes.stderr.trim() || `SSH read failed (exit ${readRes.exitCode})`,
    };
  }
  let existing: Record<string, unknown> = {};
  try {
    existing = parseRemoteJsonObject(readRes.stdout).raw;
  } catch (err) {
    return {
      host: host.name,
      ssh: host.ssh,
      local: false,
      ok: false,
      error: `Invalid existing remote host-config.json: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const prepared = prepareMergedHostConfig(existing, patch);
  if (!prepared.ok) {
    return {
      host: host.name,
      ssh: host.ssh,
      local: false,
      ok: false,
      error: prepared.error,
    };
  }
  const writeRes = await runner(host.ssh, REMOTE_WRITE_SH, {
    stdin: `${JSON.stringify(prepared.toPersist, null, 2)}\n`,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  });
  if (writeRes.exitCode !== 0) {
    return {
      host: host.name,
      ssh: host.ssh,
      local: false,
      ok: false,
      error: writeRes.stderr.trim() || `SSH write failed (exit ${writeRes.exitCode})`,
    };
  }
  return {
    host: host.name,
    ssh: host.ssh,
    local: false,
    ok: true,
    config: prepared.config,
  };
}

export async function writeFleetHostConfig(
  targetHost: string,
  patch: Record<string, unknown>,
  options: FleetConfigOptions = {},
): Promise<FleetWriteResponse> {
  // Validate submitted patch once up front before touching any host.
  const precheck = prepareMergedHostConfig({}, patch);
  if (!precheck.ok) {
    return {
      ok: false,
      targetHost,
      results: [
        {
          host: targetHost,
          ssh: null,
          local: targetHost === "local",
          ok: false,
          error: precheck.error,
        },
      ],
    };
  }

  const localConfigPath = options.localConfigPath ?? defaultHostConfigPath();
  const normalizedTarget = targetHost.trim();
  const hosts = discoverFleetHosts(options.ciHostsPath);

  if (normalizedTarget.toLowerCase() === "all") {
    const results = await Promise.all(
      hosts.map(async (host): Promise<FleetWriteResultEntry> => {
        if (host.local) {
          const written = writeDevtoolsHostConfig(patch, localConfigPath);
          return written.ok
            ? { host: host.name, ssh: null, local: true, ok: true, config: written.config }
            : { host: host.name, ssh: null, local: true, ok: false, error: written.error };
        }
        return writeSingleRemoteHost(host, patch, options);
      }),
    );
    const localResult = results.find((r) => r.local && r.ok);
    return {
      ok: results.every((r) => r.ok),
      targetHost: "all",
      results,
      ...(localResult?.config ? { config: localResult.config } : {}),
    };
  }

  const target = findFleetHost(normalizedTarget, options);
  if (!target) {
    return {
      ok: false,
      targetHost: normalizedTarget,
      results: [
        {
          host: normalizedTarget,
          ssh: null,
          local: false,
          ok: false,
          error: `Unknown fleet host: ${normalizedTarget}`,
        },
      ],
    };
  }

  if (target.local) {
    const written = writeDevtoolsHostConfig(patch, localConfigPath);
    return written.ok
      ? {
          ok: true,
          targetHost: target.name,
          config: written.config,
          results: [
            { host: target.name, ssh: null, local: true, ok: true, config: written.config },
          ],
        }
      : {
          ok: false,
          targetHost: target.name,
          results: [{ host: target.name, ssh: null, local: true, ok: false, error: written.error }],
        };
  }

  const remoteResult = await writeSingleRemoteHost(target, patch, options);
  return {
    ok: remoteResult.ok,
    targetHost: target.name,
    results: [remoteResult],
    ...(remoteResult.config ? { config: remoteResult.config } : {}),
  };
}
