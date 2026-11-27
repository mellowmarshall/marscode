// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off
// @effect-diagnostics globalConsole:off
/** Builds `<archiveRoot>/usage-archive-index-v1.sqlite` in place so remote clients skip raw SMB reads. */
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import type { UsageProviderKind } from "@t3tools/contracts";
import type { TranscriptUsageFormat } from "@t3tools/provider-core/server/usage";
import { grokUsageFormat } from "@t3tools/provider-grok/server/usage";

import { claudeUsageFormat } from "../src/provider/Drivers/claudeUsage.ts";
import { codexUsageFormat } from "../src/provider/Drivers/codexUsage.ts";
import {
  ARCHIVE_SIDECAR_FILE,
  SIDECAR_SCHEMA_SQL,
  SIDECAR_SCHEMA_VERSION,
} from "../src/usage/usageArchiveSidecar.ts";
import { dedupeWithinFile, type CachedFile } from "../src/usage/usageScanCache.ts";
import { encodeFilePayload } from "../src/usage/usageSqliteCodec.ts";
import { readTranscriptRecords } from "../src/usage/usageTranscriptReader.ts";

interface ArchiveSubdirSpec {
  readonly subdir: string;
  readonly provider: UsageProviderKind;
  readonly format: TranscriptUsageFormat<unknown>;
  readonly fileName?: string;
}

const SUBDIR_SPECS: readonly ArchiveSubdirSpec[] = [
  { subdir: "claude", provider: "claude", format: claudeUsageFormat },
  { subdir: "codex", provider: "codex", format: codexUsageFormat },
  { subdir: "codex_codex_archived-sessions", provider: "codex", format: codexUsageFormat },
  { subdir: "grok", provider: "grok", format: grokUsageFormat, fileName: "updates.jsonl" },
];

async function walkLocalArchive(
  root: string,
  fileName?: string,
): Promise<Array<{ readonly fullPath: string; readonly size: number; readonly mtimeMs: number }>> {
  const out: Array<{ fullPath: string; size: number; mtimeMs: number }> = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: NodeFS.Dirent[];
    try {
      entries = await NodeFSP.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    const compressedBases = new Set<string>();
    if (fileName === undefined) {
      for (const entry of entries) {
        if (!entry.isDirectory() && entry.name.endsWith(".jsonl.zst")) {
          compressedBases.add(entry.name.slice(0, -4));
        }
      }
    }
    const subdirs: string[] = [];
    for (const entry of entries) {
      const fullPath = NodePath.join(dir, entry.name);
      if (entry.isDirectory()) {
        subdirs.push(fullPath);
      } else if (
        fileName !== undefined
          ? entry.name === fileName
          : entry.name.endsWith(".jsonl.zst") ||
            (entry.name.endsWith(".jsonl") && !compressedBases.has(entry.name))
      ) {
        try {
          const stat = await NodeFSP.stat(fullPath);
          if (stat.isFile()) out.push({ fullPath, size: stat.size, mtimeMs: stat.mtimeMs });
        } catch {
          // Skip disappearing or unreadable files.
        }
      }
    }
    for (let i = subdirs.length - 1; i >= 0; i -= 1) stack.push(subdirs[i]!);
  }
  return out;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let archiveRoot = "";
  let concurrency = 8;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--concurrency" && args[i + 1] !== undefined) {
      concurrency = Math.max(1, Math.min(32, Number.parseInt(args[i + 1]!, 10) || 8));
      i += 1;
    } else if (!arg.startsWith("-")) {
      archiveRoot = NodePath.resolve(arg);
    }
  }
  if (!archiveRoot) {
    console.error("Usage: build-usage-archive-index <archiveRoot> [--concurrency 8]");
    process.exit(1);
  }

  const startedAt = Date.now();
  const destPath = NodePath.join(archiveRoot, ARCHIVE_SIDECAR_FILE);
  const workDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-archive-index-build-"));
  const workDbPath = NodePath.join(workDir, ARCHIVE_SIDECAR_FILE);

  let totalFiles = 0;
  let skippedUnchanged = 0;
  let parsedCount = 0;
  let failedCount = 0;
  let totalBytesRead = 0;

  try {
    if (NodeFS.existsSync(destPath)) {
      await NodeFSP.copyFile(destPath, workDbPath);
    }
    const db = new NodeSqlite.DatabaseSync(workDbPath);
    try {
      const existingVersion = (
        db.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined
      )?.user_version;
      if (existingVersion !== undefined && existingVersion > SIDECAR_SCHEMA_VERSION) {
        throw new Error(
          `Refusing to overwrite newer sidecar schema version ${existingVersion} (supported: ${SIDECAR_SCHEMA_VERSION}).`,
        );
      }
      db.exec("PRAGMA journal_mode = WAL;");
      db.exec("PRAGMA synchronous = NORMAL;");
      db.exec(SIDECAR_SCHEMA_SQL);
      db.exec(`PRAGMA user_version = ${SIDECAR_SCHEMA_VERSION};`);

      const existingRows = db
        .prepare("SELECT path, size, mtime_ms, order_idx FROM usage_files")
        .all() as Array<{ path: string; size: number; mtime_ms: number; order_idx: number }>;
      const existing = new Map<string, { size: number; mtimeMs: number }>();
      let nextOrderIdx = 1;
      for (const row of existingRows) {
        existing.set(row.path, { size: row.size, mtimeMs: row.mtime_ms });
        if (row.order_idx >= nextOrderIdx) nextOrderIdx = row.order_idx + 1;
      }

      const upsertStmt = db.prepare(
        `INSERT INTO usage_files (path, provider, size, mtime_ms, order_idx, payload)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET
           provider = excluded.provider,
           size = excluded.size,
           mtime_ms = excluded.mtime_ms,
           payload = excluded.payload`,
      );
      const deleteStmt = db.prepare("DELETE FROM usage_files WHERE path = ?");

      const seenRelPaths = new Set<string>();
      const coveredSubdirs: string[] = [];
      const coveredProviders = new Set<UsageProviderKind>();
      const failedBySubdir: Record<string, number> = {};
      const failedByProvider: Partial<Record<UsageProviderKind, number>> = {};

      for (const spec of SUBDIR_SPECS) {
        const subRoot = NodePath.join(archiveRoot, spec.subdir);
        if (!NodeFS.existsSync(subRoot)) continue;
        coveredSubdirs.push(spec.subdir);
        coveredProviders.add(spec.provider);
        const files = await walkLocalArchive(subRoot, spec.fileName);
        totalFiles += files.length;
        const toParse: Array<{
          relPath: string;
          fullPath: string;
          size: number;
          mtimeMs: number;
          orderIdx: number;
        }> = [];
        for (const file of files) {
          const relPath = NodePath.relative(archiveRoot, file.fullPath).replaceAll("\\", "/");
          seenRelPaths.add(relPath);
          const prev = existing.get(relPath);
          if (prev !== undefined && prev.size === file.size && prev.mtimeMs === file.mtimeMs) {
            skippedUnchanged += 1;
            continue;
          }
          toParse.push({ relPath, ...file, orderIdx: nextOrderIdx });
          nextOrderIdx += 1;
        }
        console.error(
          `[${spec.subdir}] total=${files.length} unchanged=${files.length - toParse.length} toParse=${toParse.length}`,
        );

        let batch: Array<{
          relPath: string;
          provider: UsageProviderKind;
          size: number;
          mtimeMs: number;
          orderIdx: number;
          payload: Uint8Array;
        }> = [];
        const flushBatch = () => {
          if (batch.length === 0) return;
          batch.sort((a, b) => a.orderIdx - b.orderIdx);
          db.exec("BEGIN IMMEDIATE");
          try {
            for (const row of batch) {
              upsertStmt.run(
                row.relPath,
                row.provider,
                row.size,
                row.mtimeMs,
                row.orderIdx,
                row.payload,
              );
            }
            db.exec("COMMIT");
          } catch (error) {
            db.exec("ROLLBACK");
            throw error;
          }
          batch = [];
        };

        let cursor = 0;
        const worker = async (): Promise<void> => {
          while (cursor < toParse.length) {
            const item = toParse[cursor]!;
            cursor += 1;
            const parsed = await readTranscriptRecords(item.fullPath, spec.format);
            totalBytesRead += item.size;
            if (parsed === null) {
              failedCount += 1;
              failedBySubdir[spec.subdir] = (failedBySubdir[spec.subdir] ?? 0) + 1;
              failedByProvider[spec.provider] = (failedByProvider[spec.provider] ?? 0) + 1;
              // Do not preserve a stale row when a modified file fails to parse.
              seenRelPaths.delete(item.relPath);
              continue;
            }
            const entry: CachedFile = {
              size: item.size,
              mtimeMs: item.mtimeMs,
              provider: spec.provider,
              records: dedupeWithinFile(parsed.records),
              tailRecords: parsed.tailRecords,
              malformedRecords: parsed.malformedRecords,
              position: parsed.position,
            };
            batch.push({
              relPath: item.relPath,
              provider: spec.provider,
              size: item.size,
              mtimeMs: item.mtimeMs,
              orderIdx: item.orderIdx,
              payload: encodeFilePayload(entry),
            });
            parsedCount += 1;
            if (batch.length >= 250) flushBatch();
            if (parsedCount % 2000 === 0) {
              console.error(
                `  progress: parsed=${parsedCount} failed=${failedCount} bytes=${(totalBytesRead / 1e9).toFixed(2)}GB elapsed=${((Date.now() - startedAt) / 1000).toFixed(1)}s`,
              );
            }
          }
        };
        await Promise.all(Array.from({ length: Math.min(concurrency, toParse.length) }, worker));
        flushBatch();
      }

      // Remove rows whose files were replaced (e.g. .jsonl superseded by .jsonl.zst) or failed re-parse.
      const removedPaths = [...existing.keys()].filter((p) => !seenRelPaths.has(p));
      if (removedPaths.length > 0) {
        db.exec("BEGIN IMMEDIATE");
        try {
          for (const p of removedPaths) deleteStmt.run(p);
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      }

      const upsertMeta = db.prepare(
        "INSERT INTO usage_meta (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json",
      );
      upsertMeta.run("builtAtMs", JSON.stringify(Date.now()));
      upsertMeta.run("coveredSubdirs", JSON.stringify(coveredSubdirs));
      upsertMeta.run("coveredProviders", JSON.stringify([...coveredProviders]));
      upsertMeta.run("failedBySubdir", JSON.stringify(failedBySubdir));
      upsertMeta.run("failedByProvider", JSON.stringify(failedByProvider));
      // Collapse WAL into a single self-contained SQLite file safe for read-only CIFS/SMB sharing.
      db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
      db.exec("PRAGMA journal_mode = DELETE;");
      db.exec("VACUUM;");
    } finally {
      db.close();
    }

    const tmpDest = `${destPath}.tmp-${process.pid}`;
    await NodeFSP.copyFile(workDbPath, tmpDest);
    await NodeFSP.rename(tmpDest, destPath);
    const finalSizeMB = (await NodeFSP.stat(destPath)).size / 1e6;
    const elapsedSec = (Date.now() - startedAt) / 1000;
    console.log(
      JSON.stringify({
        archiveRoot,
        sidecarPath: destPath,
        sidecarSizeMB: Number(finalSizeMB.toFixed(2)),
        totalFiles,
        skippedUnchanged,
        parsedCount,
        failedCount,
        bytesReadGB: Number((totalBytesRead / 1e9).toFixed(2)),
        elapsedSec: Number(elapsedSec.toFixed(2)),
      }),
    );
    if (failedCount > 0) process.exitCode = 1;
  } finally {
    await NodeFSP.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

await main();
