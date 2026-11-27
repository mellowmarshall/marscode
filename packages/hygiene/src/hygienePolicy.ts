// @effect-diagnostics nodeBuiltinImport:off - Reads the repo's tracked hygiene.exceptions.json from disk.
/**
 * PLAYBOOK §16.7 scoped exceptions: a tracked `hygiene.exceptions.json` naming a class id and
 * file (or a vendored path to skip, or an upstream name to allow), each with a reason and `#N`.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { HYGIENE_CLASSES, type HygieneClass } from "./hygieneCatalog.ts";
import { EMPTY_POLICY, type HygienePolicy } from "./hygieneTypes.ts";

export const POLICY_FILE = "hygiene.exceptions.json";

const ISSUE_RE = /^#[1-9][0-9]*$/;
const CLASS_IDS: ReadonlySet<string> = new Set(HYGIENE_CLASSES);

// @effect-diagnostics-next-line extendsNativeError:off - a plain CLI library; no Effect failure channel.
export class PolicyError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(entry: Record<string, unknown>, key: string, where: string): string {
  const value = entry[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new PolicyError(`${POLICY_FILE}: ${where}.${key} must be a non-empty string`);
  }
  return value.trim();
}

function reasoned(entry: Record<string, unknown>, where: string) {
  const reason = text(entry, "reason", where);
  const issue = text(entry, "issue", where);
  if (reason.length < 12) {
    throw new PolicyError(`${POLICY_FILE}: ${where}.reason must state a concrete reason`);
  }
  if (!ISSUE_RE.test(issue)) throw new PolicyError(`${POLICY_FILE}: ${where}.issue must be #N`);
  return { reason, issue };
}

function list(raw: Record<string, unknown>, key: string): ReadonlyArray<Record<string, unknown>> {
  const value = raw[key] ?? [];
  if (!Array.isArray(value)) throw new PolicyError(`${POLICY_FILE}: ${key} must be an array`);
  return value.map((entry, i) => {
    if (!isRecord(entry)) throw new PolicyError(`${POLICY_FILE}: ${key}[${i}] must be an object`);
    return entry;
  });
}

function relativeFile(value: string, where: string): string {
  if (value.startsWith("/") || value.split("/").includes("..") || /[*?[\]]/.test(value)) {
    throw new PolicyError(`${POLICY_FILE}: ${where} must be one repo-relative path, no globs`);
  }
  return value;
}

export function parsePolicy(json: string): HygienePolicy {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new PolicyError(`${POLICY_FILE}: not valid JSON`);
  }
  if (!isRecord(raw)) throw new PolicyError(`${POLICY_FILE}: must be a JSON object`);
  const exclusions = list(raw, "exclusions").map((entry, i) => {
    const where = `exclusions[${i}]`;
    const path = relativeFile(text(entry, "path", where), `${where}.path`);
    if (!path.endsWith("/")) {
      throw new PolicyError(`${POLICY_FILE}: ${where}.path must be a directory ending in /`);
    }
    return { path, ...reasoned(entry, where) };
  });
  const upstreamNames = list(raw, "upstreamNames").map((entry, i) => {
    const where = `upstreamNames[${i}]`;
    const name = text(entry, "name", where);
    if (!/^[A-Za-z0-9._-]+$/.test(name)) {
      throw new PolicyError(`${POLICY_FILE}: ${where}.name must be one path segment`);
    }
    return { name, ...reasoned(entry, where) };
  });
  const exceptions = list(raw, "exceptions").map((entry, i) => {
    const where = `exceptions[${i}]`;
    const classId = text(entry, "classId", where);
    if (!CLASS_IDS.has(classId)) {
      throw new PolicyError(`${POLICY_FILE}: ${where}.classId is not a §16.2 class`);
    }
    const file = relativeFile(text(entry, "file", where), `${where}.file`);
    return { classId: classId as HygieneClass, file, ...reasoned(entry, where) };
  });
  return { exclusions, upstreamNames, exceptions };
}

/** Reads `hygiene.exceptions.json` from a checkout; an absent file is an empty policy. */
export function readPolicyFile(root: string): HygienePolicy {
  let json: string;
  try {
    json = NodeFS.readFileSync(NodePath.join(root, POLICY_FILE), "utf8");
  } catch {
    return EMPTY_POLICY;
  }
  return parsePolicy(json);
}

export function isExcludedPath(policy: HygienePolicy, file: string): boolean {
  return policy.exclusions.some((entry) => file.startsWith(entry.path));
}

export function isExcepted(policy: HygienePolicy, classId: HygieneClass, file: string): boolean {
  return policy.exceptions.some((entry) => entry.classId === classId && entry.file === file);
}

/** Receipt `exceptions[]`: subjects point into the policy file, never at matched text. */
export function policyReceiptEntries(
  policy: HygienePolicy,
): ReadonlyArray<{ subject: string; reason: string; issue: string }> {
  const at = (key: string, i: number) => `${POLICY_FILE}#/${key}/${i}`;
  return [
    ...policy.exclusions.map((e, i) => ({ subject: at("exclusions", i), ...pick(e) })),
    ...policy.upstreamNames.map((e, i) => ({ subject: at("upstreamNames", i), ...pick(e) })),
    ...policy.exceptions.map((e, i) => ({ subject: at("exceptions", i), ...pick(e) })),
  ];
}

function pick(entry: { reason: string; issue: string }) {
  return { reason: entry.reason, issue: entry.issue };
}
