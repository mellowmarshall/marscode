// @effect-diagnostics nodeBuiltinImport:off - CI host payload sync (infra/ci-host + MarsCode packages) and tool provisioning.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { loadCiHostsManifest, type CiHostEntry } from "./ciHosts.ts";
import { computeHostLacks } from "./ciToolVersion.ts";
import { execOnHost, probeCiHost, type HostExecDeps } from "./hostProbe.ts";
import { nodeProcessRunner } from "./nodeProcess.ts";
import {
  buildWslRootLines,
  expandRootCommand,
  rootCommandOf,
  SELF_SUDO_TOKEN,
} from "./rootGrant.ts";
import { buildToolchainShellSetup, formatDataRootShell } from "./toolchainEnv.ts";

const REMOTE_PAYLOAD_DIR = "$HOME/.local/share/ship-queue-ci/marscode-ci-host";
const BUNDLED_PACKAGE_CANDIDATES: ReadonlyArray<string> = [
  "packages/runlog",
  "packages/guard-protocol",
  "packages/host-guards",
  "packages/playbook",
];

/** Resolves the list of MarsCode repository paths to archive for `hosts sync` (`infra/ci-host` + present bundled packages). */
export function resolveHostSyncPaths(marscodeRoot: string): ReadonlyArray<string> {
  const paths: string[] = ["infra/ci-host"];
  for (const rel of BUNDLED_PACKAGE_CANDIDATES) {
    if (NodeFS.existsSync(NodePath.join(marscodeRoot, rel))) {
      paths.push(rel);
    }
  }
  return paths;
}

/** Ships `marscode@sourceRef:infra/ci-host` + bundled MarsCode packages (`runlog`, `guard-protocol`, and `host-guards`/`playbook` if present) to a CI host. */
export async function syncCiHostPayload(input: {
  readonly host: CiHostEntry;
  readonly marscodeRoot: string;
  readonly sourceRef?: string | undefined;
  readonly deps?: HostExecDeps | undefined;
}): Promise<{
  readonly ok: boolean;
  readonly paths: ReadonlyArray<string>;
  readonly error?: string | undefined;
}> {
  const paths = resolveHostSyncPaths(input.marscodeRoot);
  const ref = (input.sourceRef ?? "HEAD").trim();
  if (!ref || ref.startsWith("-") || /[\s\0]/.test(ref)) {
    return { ok: false, paths, error: `invalid sourceRef: ${JSON.stringify(input.sourceRef)}` };
  }
  const runLocal = input.deps?.runLocal ?? nodeProcessRunner;
  const archive = await runLocal({
    command: "bash",
    args: [
      "-c",
      'set -euo pipefail; sha=$(git -C "$1" rev-parse --verify --end-of-options "$2^{commit}"); git -C "$1" archive --format=tar "$sha" -- "${@:3}" | base64',
      "--",
      input.marscodeRoot,
      ref,
      ...paths,
    ],
    cwd: input.marscodeRoot,
  });
  if (archive.exitCode !== 0) {
    return {
      ok: false,
      paths,
      error: archive.stderr.trim() || `git archive exited ${archive.exitCode}`,
    };
  }
  const unpackScript = `d=${REMOTE_PAYLOAD_DIR}; rm -rf "$d.next" && mkdir -p "$d.next" && python3 -c "import base64,sys; sys.stdout.buffer.write(base64.b64decode(sys.stdin.buffer.read()))" | tar -x -C "$d.next" && rm -rf "$d" && mv "$d.next" "$d"`;
  const unpack = await execOnHost(input.host, unpackScript, input.deps, {
    stdin: archive.stdout,
    timeoutMs: 120_000,
  });
  if (unpack.exitCode !== 0) {
    return {
      ok: false,
      paths,
      error: unpack.stderr.trim() || `remote unpack exited ${unpack.exitCode}`,
    };
  }
  return { ok: true, paths };
}

/** Provisions missing user-level tools (and optionally WSL/passwordless-sudo root tools) on one CI host. */
export async function provisionCiHost(input: {
  readonly queueRoot: string;
  readonly hostName: string;
  readonly manifestPath?: string | undefined;
  readonly marscodeRoot?: string | undefined;
  readonly sourceRef?: string | undefined;
  /** Restrict provisioning to this subset of tool names (used by automated drift convergence). */
  readonly onlyTools?: ReadonlyArray<string> | undefined;
  /** When false, never executes root/sudo/WSL-root commands; owner root-grant approval remains required. */
  readonly allowRoot?: boolean | undefined;
  readonly onProgress?: ((line: string) => void) | undefined;
  readonly deps?: HostExecDeps | undefined;
}): Promise<{
  readonly ok: boolean;
  readonly message: string;
  readonly installedTools?: ReadonlyArray<string> | undefined;
  readonly skippedRootTools?: ReadonlyArray<string> | undefined;
}> {
  const loaded = loadCiHostsManifest({ overridePath: input.manifestPath });
  if (!loaded.ok || !loaded.manifest) {
    return { ok: false, message: loaded.errors.join("; ") };
  }
  const host = loaded.manifest.hosts.find((h) => h.name === input.hostName);
  if (!host) return { ok: false, message: `no CI host ${input.hostName} in manifest` };

  if (input.marscodeRoot) {
    const synced = await syncCiHostPayload({
      host,
      marscodeRoot: input.marscodeRoot,
      sourceRef: input.sourceRef,
      deps: input.deps,
    });
    if (!synced.ok) {
      const msg = `PROVISION host=${host.name} sync result=failed: ${synced.error}`;
      input.onProgress?.(msg);
      return { ok: false, message: msg };
    }
    input.onProgress?.(`PROVISION host=${host.name} sync result=ok (${synced.paths.join(", ")})`);
  }

  const probe = await probeCiHost({
    queueRoot: input.queueRoot,
    manifest: loaded.manifest,
    manifestPath: loaded.path ?? undefined,
    host,
    fresh: true,
    deps: input.deps,
  });
  if (!probe) {
    return { ok: false, message: `PROVISION host=${host.name} result=failed: host unreachable` };
  }

  const onlySpecs = input.onlyTools ? [...input.onlyTools] : null;
  const onlyNames = onlySpecs
    ? new Set(onlySpecs.map((spec) => spec.split("@", 1)[0] ?? spec).filter(Boolean))
    : null;
  const lacks = onlySpecs
    ? computeHostLacks(loaded.manifest, probe, "base", onlySpecs)
    : computeHostLacks(loaded.manifest, probe, "all");
  const lackingNames = new Set(lacks.map((l) => l.split("@", 1)[0] ?? ""));
  const setup = buildToolchainShellSetup({ dataRootShell: formatDataRootShell(host.data_root) });
  const envPrefix = `${setup}; export CI_HOST_PAYLOAD=${REMOTE_PAYLOAD_DIR} CI_DEVTOOLS=${REMOTE_PAYLOAD_DIR}`;
  const installedTools: string[] = [];
  const skippedRootTools: string[] = [];
  let failed = "";

  for (const [toolName, spec] of Object.entries(loaded.manifest.toolchain)) {
    if (onlyNames && !onlyNames.has(toolName)) continue;
    if (!lackingNames.has(toolName) && (onlyNames || !spec.refresh)) continue;
    if (!spec.install) {
      if (lackingNames.has(toolName) && input.allowRoot === false) {
        skippedRootTools.push(toolName);
        input.onProgress?.(
          `PROVISION host=${host.name} tool=${toolName} result=skipped_needs_root`,
        );
      }
      continue;
    }
    const res = await execOnHost(host, `${envPrefix}\n${spec.install}`, input.deps, {
      timeoutMs: 15 * 60_000,
    });
    const line =
      res.exitCode === 0
        ? `PROVISION host=${host.name} tool=${toolName} result=installed`
        : `PROVISION host=${host.name} tool=${toolName} result=failed: ${res.stderr.trim() || `exit ${res.exitCode}`}`;
    input.onProgress?.(line);
    if (res.exitCode === 0) installedTools.push(toolName);
    else if (!failed) failed = line;
  }

  const allowRoot = input.allowRoot !== false;
  const selfRootToken = allowRoot ? (host.wsl ?? (host.sudo ? SELF_SUDO_TOKEN : "")) : "";
  if (selfRootToken && probe.__os && probe.__home) {
    const rootCmds: string[] = [];
    try {
      for (const toolName of lackingNames) {
        if (onlyNames && !onlyNames.has(toolName)) continue;
        const rcmd = rootCommandOf(loaded.manifest.toolchain[toolName], probe.__os);
        if (rcmd) rootCmds.push(expandRootCommand(rcmd, probe.__home));
      }
      if (rootCmds.length > 0) {
        for (const cmd of buildWslRootLines(selfRootToken, rootCmds)) {
          const res = await execOnHost(host, cmd, input.deps, { timeoutMs: 15 * 60_000 });
          const line =
            res.exitCode === 0
              ? `PROVISION host=${host.name} root result=ran`
              : `PROVISION host=${host.name} root result=failed: ${res.stderr.trim() || `exit ${res.exitCode}`}`;
          input.onProgress?.(line);
          if (res.exitCode !== 0 && !failed) failed = line;
        }
      }
    } catch (err) {
      const line = `PROVISION host=${host.name} root result=failed: ${err instanceof Error ? err.message : String(err)}`;
      input.onProgress?.(line);
      if (!failed) failed = line;
    }
  }

  if (installedTools.length > 0) {
    await probeCiHost({
      queueRoot: input.queueRoot,
      manifest: loaded.manifest,
      manifestPath: loaded.path ?? undefined,
      host,
      fresh: true,
      deps: input.deps,
    });
  }

  return failed
    ? { ok: false, message: failed, installedTools, skippedRootTools }
    : { ok: true, message: `Provisioned ${host.name}`, installedTools, skippedRootTools };
}
