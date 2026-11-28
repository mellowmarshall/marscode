// @effect-diagnostics nodeBuiltinImport:off - CI host payload sync (infra/ci-host + MarsCode packages) and tool provisioning.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { loadCiHostsManifest, type CiHostEntry } from "./ciHosts.ts";
import { computeHostLacks, isToolOutOfScope } from "./ciToolVersion.ts";
import { execOnHost, probeCiHost, type HostExecDeps } from "./hostProbe.ts";
import { nodeProcessRunner } from "./nodeProcess.ts";
import {
  buildPayloadBundles,
  missingPayloadBundles,
  PAYLOAD_BUNDLE_PATHS,
  payloadBundleCacheDir,
} from "./payloadBundles.ts";
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

/** The one line an installer prints when it kept another install's CLI (ci-marscode-cli.sh). */
const SKIPPED_INSTALL = /^[\w.-]+: warning: skipped .*$/m;

/**
 * Ships `marscode@sourceRef:infra/ci-host` + bundled MarsCode packages to a CI host, plus each
 * package's `dist/bin.mjs` built from that same commit (`buildPayloadBundles`, cached per commit).
 */
export async function syncCiHostPayload(input: {
  readonly host: CiHostEntry;
  readonly marscodeRoot: string;
  readonly sourceRef?: string | undefined;
  /** `payloadBundleCacheDir(...)`: where per-commit bundle builds are kept. */
  readonly bundleCacheDir: string;
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
  const rev = await runLocal({
    command: "git",
    args: [
      "-C",
      input.marscodeRoot,
      "rev-parse",
      "--verify",
      "--end-of-options",
      `${ref}^{commit}`,
    ],
    cwd: input.marscodeRoot,
  });
  if (rev.exitCode !== 0) {
    return { ok: false, paths, error: rev.stderr.trim() || `unknown ref ${ref}` };
  }
  const sha = rev.stdout.trim();
  const built = await buildPayloadBundles({
    marscodeRoot: input.marscodeRoot,
    sha,
    cacheDir: input.bundleCacheDir,
    run: runLocal,
  });
  if (!built.ok) return { ok: false, paths, error: built.error };
  // Every bundle is archived by its exact path, and a missing one stops the sync before the
  // host's working payload is replaced.
  const missing = missingPayloadBundles(built.dir);
  if (missing.length > 0) {
    return { ok: false, paths, error: `payload bundles missing: ${missing.join(", ")}` };
  }
  // The base64 payload goes to a file, not stdout: the process runner caps captured output.
  const payloadFile = NodePath.join(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "sq-payload-")),
    "payload.b64",
  );
  let payload: string;
  try {
    const archive = await runLocal({
      command: "bash",
      args: [
        "-c",
        [
          "set -euo pipefail",
          "t=$(mktemp); trap 'rm -f \"$t\"' EXIT",
          "r=$1; sha=$2; b=$3; out=$4; bundles=$5; shift 5",
          'git -C "$r" archive --format=tar -o "$t" "$sha" -- "$@"',
          // The bundle paths are fixed package names (PAYLOAD_BUNDLE_PATHS), split on spaces.
          'tar -rf "$t" -C "$b" $bundles',
          'base64 < "$t" > "$out"',
        ].join("; "),
        "--",
        input.marscodeRoot,
        sha,
        built.dir,
        payloadFile,
        PAYLOAD_BUNDLE_PATHS.join(" "),
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
    payload = NodeFS.readFileSync(payloadFile, "utf8");
  } finally {
    NodeFS.rmSync(NodePath.dirname(payloadFile), { recursive: true, force: true });
  }
  const unpackScript = `d=${REMOTE_PAYLOAD_DIR}; rm -rf "$d.next" && mkdir -p "$d.next" && python3 -c "import base64,sys; sys.stdout.buffer.write(base64.b64decode(sys.stdin.buffer.read()))" | tar -x -C "$d.next" && rm -rf "$d" && mv "$d.next" "$d"`;
  const unpack = await execOnHost(input.host, unpackScript, input.deps, {
    stdin: payload,
    timeoutMs: 120_000,
  });
  if (unpack.exitCode !== 0) {
    return {
      ok: false,
      paths,
      error: unpack.stderr.trim() || `remote unpack exited ${unpack.exitCode}`,
    };
  }
  return {
    ok: true,
    paths: [...paths, ...PAYLOAD_BUNDLE_PATHS],
  };
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
  /** Tools whose installer kept another install's CLI that the new one has no flag parity with. */
  readonly skippedTools?: ReadonlyArray<string> | undefined;
}> {
  const loaded = loadCiHostsManifest({ overridePath: input.manifestPath });
  if (!loaded.ok || !loaded.manifest) {
    return { ok: false, message: loaded.errors.join("; ") };
  }
  const host = loaded.manifest.hosts.find((h) => h.name === input.hostName);
  if (!host) return { ok: false, message: `no CI host ${input.hostName} in manifest` };

  if (input.marscodeRoot) {
    const bundleCacheDir = payloadBundleCacheDir(loaded.manifest.hosts);
    if (!bundleCacheDir) {
      const msg = `PROVISION host=${host.name} sync result=failed: the manifest has no local (ssh: null) host to build payload bundles on`;
      input.onProgress?.(msg);
      return { ok: false, message: msg };
    }
    const synced = await syncCiHostPayload({
      host,
      marscodeRoot: input.marscodeRoot,
      sourceRef: input.sourceRef,
      bundleCacheDir,
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
  const skippedTools: string[] = [];
  let failed = "";

  for (const [toolName, spec] of Object.entries(loaded.manifest.toolchain)) {
    if (onlyNames && !onlyNames.has(toolName)) continue;
    // A tool for another OS is never installed, refresh or not (its installer refuses this OS).
    if (isToolOutOfScope(spec, probe.__os)) continue;
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
    // An installer that kept another install's CLI (no flag parity) says so in one line: skipped, not failed.
    const skippedWhy = res.exitCode === 0 ? SKIPPED_INSTALL.exec(res.stdout)?.[0] : undefined;
    const line =
      res.exitCode !== 0
        ? `PROVISION host=${host.name} tool=${toolName} result=failed: ${res.stderr.trim() || `exit ${res.exitCode}`}`
        : skippedWhy
          ? `PROVISION host=${host.name} tool=${toolName} result=skipped: ${skippedWhy}`
          : `PROVISION host=${host.name} tool=${toolName} result=installed`;
    input.onProgress?.(line);
    if (res.exitCode !== 0) {
      if (!failed) failed = line;
    } else if (skippedWhy) {
      skippedTools.push(toolName);
    } else {
      installedTools.push(toolName);
    }
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

  // The host guards install last, after node is in place, on every full provision.
  const guards = loaded.manifest.guards;
  if (guards && !onlyNames) {
    const res = await execOnHost(host, `${envPrefix}\n${guards.install}`, input.deps, {
      timeoutMs: 15 * 60_000,
    });
    const guardsSkipped = res.exitCode === 0 ? SKIPPED_INSTALL.exec(res.stdout)?.[0] : undefined;
    const line =
      res.exitCode !== 0
        ? `PROVISION host=${host.name} guards result=failed: ${res.stderr.trim() || `exit ${res.exitCode}`}`
        : guardsSkipped
          ? `PROVISION host=${host.name} guards result=skipped: ${guardsSkipped}`
          : `PROVISION host=${host.name} guards result=installed`;
    input.onProgress?.(line);
    if (res.exitCode !== 0 && !failed) failed = line;
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
    ? { ok: false, message: failed, installedTools, skippedRootTools, skippedTools }
    : {
        ok: true,
        message: `Provisioned ${host.name}`,
        installedTools,
        skippedRootTools,
        skippedTools,
      };
}
