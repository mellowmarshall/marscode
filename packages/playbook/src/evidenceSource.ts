// @effect-diagnostics nodeBuiltinImport:off - Locates and reads repo-emitted playbook-evidence/v1 JSON receipts safely inside PLAYBOOK_EVIDENCE_DIR or the worktree.
/**
 * Trusted receipt source discovery for `playbook-evidence/v1`: enforces the
 * `PLAYBOOK_EVIDENCE_DIR` trust boundary, blocks symlink escapes, rejects tracked
 * worktree receipts, and unpacks combined `evidence.json` bundles.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { isTrackedFile } from "./git.ts";
import { isRecord, parseStrictJson } from "./strictJson.ts";

const MAX_EVIDENCE_BYTES = 2 * 1024 * 1024;

export interface EvidenceSourceInput {
  readonly root: string;
  readonly section: string;
  readonly settings: Readonly<Record<string, unknown>>;
  readonly evidenceDir: string;
  readonly env?: NodeJS.ProcessEnv | undefined;
}

export type ReceiptReadResult =
  | { readonly kind: "ok"; readonly source: string; readonly raw: unknown }
  | { readonly kind: "parse_error"; readonly source: string; readonly detail: string }
  | { readonly kind: "trust_error"; readonly source: string; readonly detail: string }
  | { readonly kind: "missing"; readonly expected: string };

function safeReadInside(baseDir: string, relPath: string): { path: string; text: string } | null {
  if (!relPath || relPath.startsWith("/") || relPath.includes("\0")) return null;
  let baseReal: string;
  try {
    baseReal = NodeFS.realpathSync(baseDir);
  } catch {
    return null;
  }
  const candidate = NodePath.resolve(baseReal, relPath);
  let real: string;
  try {
    real = NodeFS.realpathSync(candidate);
  } catch {
    return null;
  }
  if (real !== baseReal && !real.startsWith(baseReal + NodePath.sep)) return null;
  try {
    const st = NodeFS.lstatSync(real);
    if (!st.isFile() || st.size > MAX_EVIDENCE_BYTES) return null;
    return { path: real, text: NodeFS.readFileSync(real, "utf8") };
  } catch {
    return null;
  }
}

function isInsideDir(candidate: string, dir: string): boolean {
  return candidate === dir || candidate.startsWith(dir + NodePath.sep);
}

/** Locate receipt: when PLAYBOOK_EVIDENCE_DIR is set, read ONLY from it (never worktree). */
export function readReceiptCandidate(input: EvidenceSourceInput): ReceiptReadResult {
  const env = input.env ?? process.env;
  const envDir = env.PLAYBOOK_EVIDENCE_DIR?.trim() ?? "";
  const explicit = typeof input.settings.evidence === "string" ? input.settings.evidence : null;
  const attempts: Array<{
    base: string;
    rel: string;
    label: string;
    combined?: boolean;
    worktree?: boolean;
  }> = [];

  if (envDir) {
    let rootReal: string;
    let envReal: string;
    try {
      rootReal = NodeFS.realpathSync(input.root);
      envReal = NodeFS.realpathSync(envDir);
    } catch {
      return {
        kind: "trust_error",
        source: envDir,
        detail: `PLAYBOOK_EVIDENCE_DIR '${envDir}' does not exist or is unreadable (§1.6)`,
      };
    }
    if (isInsideDir(envReal, rootReal)) {
      return {
        kind: "trust_error",
        source: envDir,
        detail: "PLAYBOOK_EVIDENCE_DIR must point outside the repo worktree (§1.6)",
      };
    }
    if (explicit) {
      attempts.push({
        base: envReal,
        rel: NodePath.basename(explicit),
        label: `${envDir}/${NodePath.basename(explicit)}`,
      });
    }
    attempts.push({
      base: envReal,
      rel: `${input.section}.json`,
      label: `${envDir}/${input.section}.json`,
    });
    attempts.push({
      base: envReal,
      rel: "evidence.json",
      label: `${envDir}/evidence.json`,
      combined: true,
    });
  } else {
    if (env.SHIP_QUEUE_JOB?.trim() || env.CI?.trim()) {
      return {
        kind: "trust_error",
        source: input.evidenceDir,
        detail:
          "PLAYBOOK_EVIDENCE_DIR is required under CI / ship-queue; worktree receipts are untrusted (§1.6)",
      };
    }
    if (explicit) {
      attempts.push({ base: input.root, rel: explicit, label: explicit, worktree: true });
    }
    attempts.push({
      base: input.root,
      rel: NodePath.posix.join(input.evidenceDir, `${input.section}.json`),
      label: NodePath.posix.join(input.evidenceDir, `${input.section}.json`),
      worktree: true,
    });
    attempts.push({
      base: input.root,
      rel: NodePath.posix.join(input.evidenceDir, "evidence.json"),
      label: NodePath.posix.join(input.evidenceDir, "evidence.json"),
      combined: true,
      worktree: true,
    });
  }

  for (const attempt of attempts) {
    const found = safeReadInside(attempt.base, attempt.rel);
    if (!found) continue;
    if (attempt.worktree && isTrackedFile(input.root, attempt.rel)) {
      return {
        kind: "parse_error",
        source: attempt.label,
        detail:
          "receipt must not be committed to git; emit runtime receipts untracked or via PLAYBOOK_EVIDENCE_DIR (§1.6)",
      };
    }
    let parsed: unknown;
    try {
      parsed = parseStrictJson(found.text);
    } catch (cause) {
      return {
        kind: "parse_error",
        source: attempt.label,
        detail: `invalid JSON (${cause instanceof Error ? cause.message : String(cause)})`,
      };
    }
    if (attempt.combined && isRecord(parsed) && isRecord(parsed.sections)) {
      const sub = parsed.sections[input.section];
      if (sub === undefined) continue;
      if (isRecord(sub)) {
        return {
          kind: "ok",
          source: `${attempt.label}#${input.section}`,
          raw: {
            schema: sub.schema ?? parsed.schema,
            section: sub.section ?? input.section,
            tree: sub.tree ?? parsed.tree,
            jobId: sub.jobId ?? parsed.jobId,
            generatedAt: sub.generatedAt ?? parsed.generatedAt,
            ...sub,
          },
        };
      }
      return { kind: "ok", source: `${attempt.label}#${input.section}`, raw: sub };
    }
    return { kind: "ok", source: attempt.label, raw: parsed };
  }
  const expected = envDir
    ? `${envDir}/${input.section}.json`
    : (explicit ?? NodePath.posix.join(input.evidenceDir, `${input.section}.json`));
  return { kind: "missing", expected };
}
