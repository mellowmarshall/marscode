// @effect-diagnostics nodeBuiltinImport:off - Hot-reloadable policy, ci-hosts.json, repo declaration, and pins loaders (single-fd bounded read, stat + content digest, zero process-wide singletons).
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  resolveCiHostsPath,
  validateCiHostsManifest,
  type CiHostsManifest,
  type ResolveCiHostsPathOptions,
} from "./ciHosts.ts";
import { parseShipDeclaration, type ShipDeclaration } from "./declaration.ts";
import { validatePinsSpec, type PinsSpec } from "./pins.ts";

export const MAX_POLICY_FILE_BYTES = 2 * 1024 * 1024;

const OPEN_BASE_FLAGS = NodeFS.constants.O_RDONLY | (NodeFS.constants.O_NONBLOCK ?? 0);
const OPEN_NOFOLLOW_FLAGS = OPEN_BASE_FLAGS | (NodeFS.constants.O_NOFOLLOW ?? 0);

export interface FileFingerprint {
  readonly exists: boolean;
  readonly path: string;
  readonly mtimeMs: number;
  readonly size: number;
  readonly ino: number;
  readonly sha256: string;
}

export interface BoundedFileRead {
  readonly fingerprint: FileFingerprint;
  readonly text: string | null;
  readonly error?: string | undefined;
}

export interface RepoDeclarationLoad {
  readonly declaration: ShipDeclaration;
  readonly confPath: string | null;
  readonly playbookPath: string | null;
  readonly digest: string;
}

export interface CiHostsReloadResult {
  readonly ok: boolean;
  readonly manifest?: CiHostsManifest | undefined;
  readonly path: string | null;
  readonly digest: string;
  readonly generation: number;
  readonly changed: boolean;
  readonly errors: ReadonlyArray<string>;
  readonly warnings: ReadonlyArray<string>;
}

export interface DeclarationReloadResult extends RepoDeclarationLoad {
  readonly generation: number;
  readonly changed: boolean;
}

export interface PinsReloadResult {
  readonly ok: boolean;
  readonly spec?: PinsSpec | undefined;
  readonly path: string;
  readonly digest: string;
  readonly generation: number;
  readonly changed: boolean;
  readonly error?: string | undefined;
}

export interface HotPolicySnapshot {
  readonly ciHosts?: CiHostsReloadResult | undefined;
  readonly declaration?: RepoDeclarationLoad | undefined;
  readonly pins?: PinsReloadResult | undefined;
}

const ABSENT_SHA = "absent";

function sha256Text(text: string): string {
  return NodeCrypto.createHash("sha256").update(text).digest("hex");
}

function absentFingerprint(filePath: string, tag = ABSENT_SHA): FileFingerprint {
  return {
    exists: false,
    path: filePath,
    mtimeMs: 0,
    size: 0,
    ino: 0,
    sha256: tag,
  };
}

function fingerprintsEqual(a: FileFingerprint | null, b: FileFingerprint): boolean {
  if (!a) return false;
  return (
    a.exists === b.exists &&
    a.path === b.path &&
    a.mtimeMs === b.mtimeMs &&
    a.size === b.size &&
    a.ino === b.ino &&
    a.sha256 === b.sha256
  );
}

/**
 * Opens `filePath` once, checks `fstatSync` (regular file + size bound), reads up to `maxBytes`
 * from that single file descriptor, and hashes the exact buffer read (zero double-read TOCTOU).
 * When `containWithinDir` is set, refuses any symlink escaping that directory.
 */
export function readFileWithFingerprint(
  filePath: string,
  options?: {
    readonly maxBytes?: number | undefined;
    readonly containWithinDir?: string | undefined;
  },
): BoundedFileRead {
  const maxBytes = Math.max(1, options?.maxBytes ?? MAX_POLICY_FILE_BYTES);
  let openTarget = filePath;
  let openFlags = OPEN_BASE_FLAGS;

  if (options?.containWithinDir) {
    let canonicalDir: string;
    let canonicalTarget: string;
    try {
      canonicalDir = NodeFS.realpathSync(options.containWithinDir);
    } catch {
      return { fingerprint: absentFingerprint(filePath), text: null };
    }
    try {
      canonicalTarget = NodeFS.realpathSync(filePath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") {
        return { fingerprint: absentFingerprint(filePath), text: null };
      }
      return {
        fingerprint: absentFingerprint(filePath, "error:unreadable"),
        text: null,
        error: `cannot resolve ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    const rel = NodePath.relative(canonicalDir, canonicalTarget);
    if (!rel || rel.startsWith("..") || NodePath.isAbsolute(rel)) {
      return {
        fingerprint: absentFingerprint(filePath, "error:symlink-escape"),
        text: null,
        error: `${NodePath.basename(filePath)} resolves outside repository directory`,
      };
    }
    openTarget = canonicalTarget;
    openFlags = OPEN_NOFOLLOW_FLAGS;
  }

  let fd: number;
  try {
    fd = NodeFS.openSync(openTarget, openFlags);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return { fingerprint: absentFingerprint(filePath), text: null };
    }
    const detail =
      code === "ELOOP" || code === "EMLINK"
        ? `${NodePath.basename(filePath)} is not a regular file`
        : `not readable (${err instanceof Error ? err.message : String(err)})`;
    return {
      fingerprint: absentFingerprint(filePath, `error:${code ?? "open"}`),
      text: null,
      error: detail,
    };
  }

  try {
    const st = NodeFS.fstatSync(fd);
    if (!st.isFile()) {
      return {
        fingerprint: absentFingerprint(filePath, "error:not-file"),
        text: null,
        error: `${NodePath.basename(filePath)} is not a regular file`,
      };
    }
    if (st.size > maxBytes) {
      return {
        fingerprint: absentFingerprint(filePath, `error:too-large:${st.size}`),
        text: null,
        error: `${NodePath.basename(filePath)} exceeds maximum size of ${maxBytes} bytes`,
      };
    }
    const buf = Buffer.alloc(Math.min(maxBytes + 1, Math.max(st.size + 1, 4096)));
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const n = NodeFS.readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      total += n;
      if (total > maxBytes) {
        return {
          fingerprint: absentFingerprint(filePath, `error:too-large:${total}`),
          text: null,
          error: `${NodePath.basename(filePath)} exceeds maximum size of ${maxBytes} bytes`,
        };
      }
      chunks.push(Buffer.from(buf.subarray(0, n)));
    }
    const text = Buffer.concat(chunks, total).toString("utf8");
    return {
      fingerprint: {
        exists: true,
        path: filePath,
        mtimeMs: st.mtimeMs,
        size: total,
        ino: st.ino,
        sha256: sha256Text(text),
      },
      text,
    };
  } catch (err) {
    return {
      fingerprint: absentFingerprint(filePath, "error:read"),
      text: null,
      error: `not readable (${err instanceof Error ? err.message : String(err)})`,
    };
  } finally {
    NodeFS.closeSync(fd);
  }
}

function buildRepoDeclaration(
  confPath: string,
  playbookPath: string,
  conf: BoundedFileRead,
  playbook: BoundedFileRead,
): RepoDeclarationLoad {
  const parsed = parseShipDeclaration(conf.text ?? "", playbook.text ?? "", ".tree-guard.conf");
  const extraWarnings: string[] = [];
  if (conf.error) extraWarnings.push(`WARNING: .tree-guard.conf ignored: ${conf.error}`);
  if (playbook.error) extraWarnings.push(`WARNING: playbook.json ignored: ${playbook.error}`);
  const declaration: ShipDeclaration =
    extraWarnings.length > 0
      ? { ...parsed, warnings: [...parsed.warnings, ...extraWarnings] }
      : parsed;
  const digest = sha256Text(`${conf.fingerprint.sha256}\0${playbook.fingerprint.sha256}`);
  return {
    declaration,
    confPath: conf.fingerprint.exists ? confPath : null,
    playbookPath: playbook.fingerprint.exists ? playbookPath : null,
    digest,
  };
}

/** Reads `.tree-guard.conf` and optional `playbook.json` fresh from `repoDir` with symlink containment and size bounds. */
export function loadRepoDeclarationFromDir(
  repoDir: string,
  options?: { readonly maxBytes?: number | undefined },
): RepoDeclarationLoad {
  const confCandidate = NodePath.join(repoDir, ".tree-guard.conf");
  const playbookCandidate = NodePath.join(repoDir, "playbook.json");
  const readOpts = { containWithinDir: repoDir, maxBytes: options?.maxBytes };
  const conf = readFileWithFingerprint(confCandidate, readOpts);
  const playbook = readFileWithFingerprint(playbookCandidate, readOpts);
  return buildRepoDeclaration(confCandidate, playbookCandidate, conf, playbook);
}

/**
 * Instance-scoped hot reloader for `ci-hosts.json`.
 * Reads once per cycle on a bounded fd and parses directly from that single buffer (zero double-read TOCTOU).
 */
export function createCiHostsReloader(
  options: ResolveCiHostsPathOptions & { readonly maxBytes?: number | undefined } = {},
) {
  let prevFingerprint: FileFingerprint | null = null;
  let prevResult: Omit<CiHostsReloadResult, "changed"> | null = null;
  let generation = 0;

  return {
    reload(): CiHostsReloadResult {
      const resolvedPath = options.overridePath?.trim() || resolveCiHostsPath(options);
      const read: BoundedFileRead = resolvedPath
        ? readFileWithFingerprint(resolvedPath, { maxBytes: options.maxBytes })
        : { fingerprint: absentFingerprint(""), text: null };
      if (prevResult && fingerprintsEqual(prevFingerprint, read.fingerprint)) {
        return { ...prevResult, changed: false };
      }
      generation += 1;
      prevFingerprint = read.fingerprint;

      if (!resolvedPath || (!read.fingerprint.exists && !read.error)) {
        prevResult = {
          ok: false,
          path: null,
          digest: read.fingerprint.sha256,
          generation,
          errors: ["ci-hosts.json not found"],
          warnings: [],
        };
        return { ...prevResult, changed: true };
      }
      if (read.error || read.text === null) {
        prevResult = {
          ok: false,
          path: resolvedPath,
          digest: read.fingerprint.sha256,
          generation,
          errors: [read.error ?? "ci-hosts.json not readable"],
          warnings: [],
        };
        return { ...prevResult, changed: true };
      }

      let raw: unknown;
      try {
        raw = JSON.parse(read.text) as unknown;
      } catch (err) {
        prevResult = {
          ok: false,
          path: resolvedPath,
          digest: read.fingerprint.sha256,
          generation,
          errors: [`not readable JSON (${err instanceof Error ? err.message : String(err)})`],
          warnings: [],
        };
        return { ...prevResult, changed: true };
      }

      const validated = validateCiHostsManifest(raw, resolvedPath);
      prevResult = {
        ok: validated.ok,
        ...(validated.manifest ? { manifest: validated.manifest } : {}),
        path: resolvedPath,
        digest: read.fingerprint.sha256,
        generation,
        errors: validated.errors,
        warnings: validated.warnings,
      };
      return { ...prevResult, changed: true };
    },
  };
}

/**
 * Instance-scoped hot reloader for a repository's `.tree-guard.conf` + `playbook.json`.
 */
export function createDeclarationReloader(
  repoDir: string,
  options?: { readonly maxBytes?: number | undefined },
) {
  let prevConf: FileFingerprint | null = null;
  let prevPlaybook: FileFingerprint | null = null;
  let prevResult: Omit<DeclarationReloadResult, "changed"> | null = null;
  let generation = 0;

  return {
    reload(): DeclarationReloadResult {
      const confPath = NodePath.join(repoDir, ".tree-guard.conf");
      const playbookPath = NodePath.join(repoDir, "playbook.json");
      const readOpts = { containWithinDir: repoDir, maxBytes: options?.maxBytes };
      const conf = readFileWithFingerprint(confPath, readOpts);
      const playbook = readFileWithFingerprint(playbookPath, readOpts);
      if (
        prevResult &&
        fingerprintsEqual(prevConf, conf.fingerprint) &&
        fingerprintsEqual(prevPlaybook, playbook.fingerprint)
      ) {
        return { ...prevResult, changed: false };
      }
      generation += 1;
      prevConf = conf.fingerprint;
      prevPlaybook = playbook.fingerprint;
      const loaded = buildRepoDeclaration(confPath, playbookPath, conf, playbook);
      prevResult = { ...loaded, generation };
      return { ...prevResult, changed: true };
    },
  };
}

/**
 * Instance-scoped hot reloader for `sq_pins.json`.
 * Parses directly from the single bounded fd buffer (zero double-read TOCTOU).
 */
export function createPinsReloader(
  specPath: string,
  options?: { readonly maxBytes?: number | undefined },
) {
  let prevFingerprint: FileFingerprint | null = null;
  let prevResult: Omit<PinsReloadResult, "changed"> | null = null;
  let generation = 0;

  return {
    reload(): PinsReloadResult {
      const read = readFileWithFingerprint(specPath, { maxBytes: options?.maxBytes });
      if (prevResult && fingerprintsEqual(prevFingerprint, read.fingerprint)) {
        return { ...prevResult, changed: false };
      }
      generation += 1;
      prevFingerprint = read.fingerprint;
      if (read.error || read.text === null) {
        prevResult = {
          ok: false,
          path: specPath,
          digest: read.fingerprint.sha256,
          generation,
          error: read.error ?? `pins spec not found: ${specPath}`,
        };
        return { ...prevResult, changed: true };
      }
      try {
        const spec = validatePinsSpec(JSON.parse(read.text) as unknown, specPath);
        prevResult = {
          ok: true,
          spec,
          path: specPath,
          digest: read.fingerprint.sha256,
          generation,
        };
      } catch (err) {
        prevResult = {
          ok: false,
          path: specPath,
          digest: read.fingerprint.sha256,
          generation,
          error: err instanceof Error ? err.message : String(err),
        };
      }
      return { ...prevResult, changed: true };
    },
  };
}

/** Captures a fresh, immutable policy snapshot at job dispatch time with zero stale caches. */
export function loadHotPolicySnapshot(input: {
  readonly ciHosts?: ResolveCiHostsPathOptions | undefined;
  readonly repoDir?: string | undefined;
  readonly pinsPath?: string | undefined;
}): HotPolicySnapshot {
  return {
    ...(input.ciHosts !== undefined
      ? { ciHosts: createCiHostsReloader(input.ciHosts).reload() }
      : {}),
    ...(input.repoDir ? { declaration: loadRepoDeclarationFromDir(input.repoDir) } : {}),
    ...(input.pinsPath ? { pins: createPinsReloader(input.pinsPath).reload() } : {}),
  };
}
