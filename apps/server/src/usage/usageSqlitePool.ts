// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { USAGE_SQLITE_INDEX_FILE, UsageSqliteIndex } from "./usageSqliteIndex.ts";

export interface SharedUsageSqliteHandle {
  readonly index: UsageSqliteIndex;
  readonly release: () => void;
}

const sharedIndexes = new Map<
  string,
  { readonly index: UsageSqliteIndex; readonly fileId: string; refs: number }
>();

function readSqliteFileId(dbPath: string): string {
  try {
    const stat = NodeFS.statSync(dbPath);
    return `${stat.dev}:${stat.ino}`;
  } catch {
    return "";
  }
}

/**
 * Acquires a process-wide shared SQLite index per stateDir so UsageService and AntigravityUsage
 * share one connection without lock contention. If the underlying DB file was unlinked/replaced,
 * detaches the old entry without closing it while existing holders still reference it.
 */
export function acquireUsageSqliteIndex(stateDir: string): SharedUsageSqliteHandle {
  const key = NodePath.resolve(stateDir);
  const dbPath = NodePath.join(key, USAGE_SQLITE_INDEX_FILE);
  let entry = sharedIndexes.get(key);
  if (entry !== undefined && readSqliteFileId(dbPath) !== entry.fileId) {
    sharedIndexes.delete(key);
    entry = undefined;
  }
  if (entry === undefined) {
    const index = new UsageSqliteIndex(stateDir);
    entry = { index, fileId: readSqliteFileId(dbPath), refs: 0 };
    sharedIndexes.set(key, entry);
  }
  const bound = entry;
  bound.refs += 1;
  let released = false;
  return {
    index: bound.index,
    release: () => {
      if (released) return;
      released = true;
      bound.refs -= 1;
      if (bound.refs <= 0) {
        if (sharedIndexes.get(key) === bound) sharedIndexes.delete(key);
        bound.index.close();
      }
    },
  };
}
