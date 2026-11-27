// @effect-diagnostics nodeBuiltinImport:off - Bounded safe file reads for guard audit logs and exceptions.json.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { redactArgvCommand } from "@t3tools/guard-protocol/redaction";

const MAX_AUDIT_READ_BYTES = 256 * 1024;
const MAX_EXCEPTIONS_READ_BYTES = 512 * 1024;

export function readRegularFileRange(
  filePath: string,
  maxBytes: number,
  mode: "head" | "tail",
): { readonly text: string; readonly truncated: boolean } | null {
  let fd: number | null = null;
  try {
    const flags = NodeFS.constants.O_RDONLY | (NodeFS.constants.O_NOFOLLOW ?? 0);
    fd = NodeFS.openSync(filePath, flags);
    const stat = NodeFS.fstatSync(fd);
    if (!stat.isFile()) return null;
    if (mode === "head" && stat.size > maxBytes) {
      return null;
    }
    const truncated = stat.size > maxBytes;
    const size = Math.min(stat.size, maxBytes);
    if (size === 0) return { text: "", truncated: false };
    const start = mode === "tail" ? Math.max(0, stat.size - size) : 0;
    const buf = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const n = NodeFS.readSync(fd, buf, offset, size - offset, start + offset);
      if (n <= 0) break;
      offset += n;
    }
    return { text: buf.subarray(0, offset).toString("utf8"), truncated };
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        NodeFS.closeSync(fd);
      } catch {
        // ignore close failure
      }
    }
  }
}

export function readLegacyAuditTail(
  logPath: string,
  limit = 50,
): ReadonlyArray<Record<string, unknown>> {
  const cappedLimit = Math.max(1, Math.min(200, Math.floor(limit)));
  const result = readRegularFileRange(logPath, MAX_AUDIT_READ_BYTES, "tail");
  if (!result || !result.text) return [];
  let raw = result.text;
  if (result.truncated) {
    const firstNl = raw.indexOf("\n");
    raw = firstNl === -1 ? "" : raw.slice(firstNl + 1);
  }
  const lines = raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const tail = lines.slice(-cappedLimit);
  return tail.map((line) => {
    try {
      const parsed = JSON.parse(line) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const rec = parsed as Record<string, unknown>;
        if (Array.isArray(rec.command) && rec.command.every((v) => typeof v === "string")) {
          return { ...rec, command: redactArgvCommand(rec.command) };
        }
        return rec;
      }
    } catch {
      // Never echo unparsed plain-text audit lines over HTTP.
    }
    return { unparsed: true };
  });
}

export function readExceptionsFile(exceptionsPathsOverride?: ReadonlyArray<string>): {
  readonly path: string | null;
  readonly entries: unknown;
} {
  const home = NodeOS.homedir();
  const candidates = exceptionsPathsOverride ?? [
    NodePath.join(home, ".local", "lib", "exceptions.json"),
    NodePath.join(home, ".local", "lib", "host-guards", "exceptions.json"),
  ];
  for (const candidate of candidates) {
    const res = readRegularFileRange(candidate, MAX_EXCEPTIONS_READ_BYTES, "head");
    if (!res || !res.text) continue;
    try {
      return { path: candidate, entries: JSON.parse(res.text) as unknown };
    } catch {
      return { path: candidate, entries: null };
    }
  }
  return { path: null, entries: null };
}
