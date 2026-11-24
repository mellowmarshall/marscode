// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Incremental reader for Cerno stream-sifting telemetry findings (only enabled when Cerno config/index exists).
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

export interface CernoFindingRecord {
  readonly sourceId: string;
  readonly timestampUtc: string;
  readonly host: string;
  readonly mode: string;
  readonly harness: string;
  readonly complete: boolean;
  readonly osExit: number | null;
  readonly streamBytes: number;
  readonly rawOutcome: string;
  readonly finalOutcome: string;
  readonly alerts: number;
  readonly disagreement: boolean;
}

export interface CernoGroupRow {
  readonly key: string;
  readonly captures: number;
  readonly complete: number;
  readonly pass: number;
  readonly fail: number;
  readonly alerts: number;
  readonly disagreements: number;
  readonly streamBytes: number;
}

export interface CernoStatsResponse {
  readonly enabled: boolean;
  readonly host: string;
  readonly configPath: string;
  readonly captureDir: string | null;
  readonly localCapture: boolean;
  readonly shareOptIn: boolean;
  readonly totals: CernoGroupRow;
  readonly byHarness: ReadonlyArray<CernoGroupRow>;
  readonly byMode: ReadonlyArray<CernoGroupRow>;
  readonly recentFindings: ReadonlyArray<CernoFindingRecord>;
  readonly facets: {
    readonly hosts: ReadonlyArray<string>;
    readonly harnesses: ReadonlyArray<string>;
  };
}

interface CernoConfigFile {
  readonly local_capture?: boolean;
  readonly share_opt_in?: boolean;
  readonly capture_dir?: string;
}

interface CacheEntry {
  readonly indexPath: string;
  readonly ino: number;
  readonly mtimeMs: number;
  readonly size: number;
  readonly offset: number;
  readonly records: ReadonlyArray<CernoFindingRecord>;
}

let cachedIndex: CacheEntry | null = null;
const MAX_INDEX_LINES = 5_000;

function expandTildePath(raw: string, homeDir: string = NodeOS.homedir()): string {
  const trimmed = raw.trim();
  if (trimmed === "~") return homeDir;
  if (trimmed.startsWith("~/")) return NodePath.join(homeDir, trimmed.slice(2));
  return trimmed;
}

function defaultCernoConfigPath(homeDir: string = NodeOS.homedir()): string {
  return NodePath.join(homeDir, ".config", "cerno", "telemetry.json");
}

function readCernoConfig(configPath: string): CernoConfigFile | null {
  try {
    const text = NodeFS.readFileSync(configPath, "utf8");
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as CernoConfigFile;
  } catch {
    return null;
  }
}

function parseIndexLine(line: string, defaultHost: string): CernoFindingRecord | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const raw = JSON.parse(trimmed) as Record<string, unknown>;
    const sourceId = typeof raw.source_id === "string" ? raw.source_id : "";
    const timestampUtc = typeof raw.timestamp_utc === "string" ? raw.timestamp_utc : "";
    if (!sourceId || !timestampUtc) return null;
    const host = typeof raw.host === "string" && raw.host.trim() ? raw.host.trim() : defaultHost;
    return {
      sourceId,
      timestampUtc,
      host,
      mode: typeof raw.mode === "string" && raw.mode.trim() ? raw.mode.trim() : "unknown",
      harness:
        typeof raw.harness === "string" && raw.harness.trim() ? raw.harness.trim() : "unknown",
      complete: raw.complete === true,
      osExit: typeof raw.os_exit === "number" && Number.isFinite(raw.os_exit) ? raw.os_exit : null,
      streamBytes:
        typeof raw.stream_bytes === "number" && Number.isFinite(raw.stream_bytes)
          ? raw.stream_bytes
          : 0,
      rawOutcome:
        typeof raw.raw_outcome === "string" && raw.raw_outcome.trim()
          ? raw.raw_outcome.trim().toUpperCase()
          : "UNKNOWN",
      finalOutcome:
        typeof raw.final_outcome === "string" && raw.final_outcome.trim()
          ? raw.final_outcome.trim().toUpperCase()
          : "UNKNOWN",
      alerts: typeof raw.alerts === "number" && Number.isFinite(raw.alerts) ? raw.alerts : 0,
      disagreement: raw.disagreement === true,
    };
  } catch {
    return null;
  }
}

function readByteRangeSync(filePath: string, offset: number, length: number): string {
  if (length <= 0) return "";
  const fd = NodeFS.openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(length);
    let totalRead = 0;
    while (totalRead < length) {
      const n = NodeFS.readSync(fd, buf, totalRead, length - totalRead, offset + totalRead);
      if (n <= 0) break;
      totalRead += n;
    }
    return buf.subarray(0, totalRead).toString("utf8");
  } finally {
    NodeFS.closeSync(fd);
  }
}

function loadIndexRecordsCached(
  indexPath: string,
  defaultHost: string,
): ReadonlyArray<CernoFindingRecord> {
  let stat: NodeFS.Stats;
  try {
    stat = NodeFS.statSync(indexPath);
  } catch {
    return [];
  }
  if (
    cachedIndex &&
    cachedIndex.indexPath === indexPath &&
    cachedIndex.ino === stat.ino &&
    cachedIndex.mtimeMs === stat.mtimeMs &&
    cachedIndex.size === stat.size
  ) {
    return cachedIndex.records;
  }

  // Incremental tail read when the same inode only grew.
  if (
    cachedIndex &&
    cachedIndex.indexPath === indexPath &&
    cachedIndex.ino === stat.ino &&
    stat.size > cachedIndex.offset
  ) {
    try {
      const appended = readByteRangeSync(
        indexPath,
        cachedIndex.offset,
        stat.size - cachedIndex.offset,
      );
      const lastNewline = appended.lastIndexOf("\n");
      if (lastNewline >= 0) {
        const completeChunk = appended.slice(0, lastNewline + 1);
        const consumedBytes = Buffer.byteLength(completeChunk, "utf8");
        const added: CernoFindingRecord[] = [];
        for (const line of completeChunk.split("\n")) {
          const rec = parseIndexLine(line, defaultHost);
          if (rec) added.push(rec);
        }
        const merged = [...added, ...cachedIndex.records];
        merged.sort((a, b) =>
          a.timestampUtc < b.timestampUtc ? 1 : a.timestampUtc > b.timestampUtc ? -1 : 0,
        );
        const capped = merged.length > MAX_INDEX_LINES ? merged.slice(0, MAX_INDEX_LINES) : merged;
        cachedIndex = {
          indexPath,
          ino: stat.ino,
          mtimeMs: stat.mtimeMs,
          size: stat.size,
          offset: cachedIndex.offset + consumedBytes,
          records: capped,
        };
        return capped;
      }
    } catch {
      // Fall through to full read on read error.
    }
  }

  let rawBuf: Buffer;
  try {
    rawBuf = NodeFS.readFileSync(indexPath);
  } catch {
    return [];
  }
  const text = rawBuf.toString("utf8");
  const lastNewline = text.lastIndexOf("\n");
  const completeText = lastNewline >= 0 ? text.slice(0, lastNewline + 1) : text;
  const offset = lastNewline >= 0 ? Buffer.byteLength(completeText, "utf8") : rawBuf.byteLength;
  const lines = completeText.split("\n");
  const start = Math.max(0, lines.length - MAX_INDEX_LINES);
  const records: CernoFindingRecord[] = [];
  for (let i = start; i < lines.length; i += 1) {
    const rec = parseIndexLine(lines[i] ?? "", defaultHost);
    if (rec) records.push(rec);
  }
  records.sort((a, b) =>
    a.timestampUtc < b.timestampUtc ? 1 : a.timestampUtc > b.timestampUtc ? -1 : 0,
  );
  cachedIndex = {
    indexPath,
    ino: stat.ino,
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    offset,
    records,
  };
  return records;
}

interface MutableCernoBucket {
  readonly key: string;
  captures: number;
  complete: number;
  pass: number;
  fail: number;
  alerts: number;
  disagreements: number;
  streamBytes: number;
}

function newBucket(key: string): MutableCernoBucket {
  return {
    key,
    captures: 0,
    complete: 0,
    pass: 0,
    fail: 0,
    alerts: 0,
    disagreements: 0,
    streamBytes: 0,
  };
}

function accumulate(bucket: MutableCernoBucket, rec: CernoFindingRecord): void {
  bucket.captures += 1;
  if (rec.complete) bucket.complete += 1;
  if (rec.finalOutcome === "PASS") bucket.pass += 1;
  else if (rec.finalOutcome === "FAIL") bucket.fail += 1;
  bucket.alerts += rec.alerts;
  if (rec.disagreement) bucket.disagreements += 1;
  bucket.streamBytes += rec.streamBytes;
}

export function loadCernoStats(options?: {
  readonly configPath?: string;
  readonly host?: string;
  readonly days?: number;
  readonly harness?: string;
  readonly localHostName?: string;
}): CernoStatsResponse {
  const localHost = (options?.localHostName ?? NodeOS.hostname()).split(".")[0] || "localhost";
  const configPath = options?.configPath ?? defaultCernoConfigPath();
  const cfg = readCernoConfig(configPath);
  const captureDir =
    typeof cfg?.capture_dir === "string" && cfg.capture_dir.trim()
      ? expandTildePath(cfg.capture_dir)
      : null;
  const enabled = Boolean(cfg && cfg.local_capture !== false && captureDir);
  const emptyTotals = newBucket("all");

  if (!enabled || !captureDir) {
    return {
      enabled: false,
      host: localHost,
      configPath,
      captureDir,
      localCapture: Boolean(cfg?.local_capture),
      shareOptIn: Boolean(cfg?.share_opt_in),
      totals: emptyTotals,
      byHarness: [],
      byMode: [],
      recentFindings: [],
      facets: { hosts: [localHost], harnesses: [] },
    };
  }

  const indexPath = NodePath.join(captureDir, "index.jsonl");
  const all = loadIndexRecordsCached(indexPath, localHost);
  const cutoffMs =
    typeof options?.days === "number" && options.days > 0
      ? Date.now() - options.days * 86_400_000
      : null;

  const hosts = new Set<string>([localHost]);
  const harnesses = new Set<string>();
  const totals = newBucket("all");
  const harnessMap = new Map<string, MutableCernoBucket>();
  const modeMap = new Map<string, MutableCernoBucket>();
  const recentFindings: CernoFindingRecord[] = [];

  for (const rec of all) {
    hosts.add(rec.host);
    harnesses.add(rec.harness);
    if (
      options?.host &&
      options.host !== "all" &&
      rec.host.toLowerCase() !== options.host.toLowerCase()
    ) {
      continue;
    }
    if (
      options?.harness &&
      options.harness !== "all" &&
      rec.harness.toLowerCase() !== options.harness.toLowerCase()
    ) {
      continue;
    }
    if (cutoffMs !== null) {
      const ts = Date.parse(rec.timestampUtc);
      if (!Number.isFinite(ts) || ts < cutoffMs) continue;
    }
    accumulate(totals, rec);
    let hb = harnessMap.get(rec.harness);
    if (!hb) {
      hb = newBucket(rec.harness);
      harnessMap.set(rec.harness, hb);
    }
    accumulate(hb, rec);

    let mb = modeMap.get(rec.mode);
    if (!mb) {
      mb = newBucket(rec.mode);
      modeMap.set(rec.mode, mb);
    }
    accumulate(mb, rec);

    if (
      recentFindings.length < 30 &&
      (rec.alerts > 0 || rec.disagreement || rec.finalOutcome === "FAIL")
    ) {
      recentFindings.push(rec);
    }
  }

  const sortBuckets = (map: Map<string, MutableCernoBucket>) =>
    Array.from(map.values()).toSorted((a, b) => {
      if (b.alerts + b.disagreements !== a.alerts + a.disagreements) {
        return b.alerts + b.disagreements - (a.alerts + a.disagreements);
      }
      return b.captures - a.captures;
    });

  return {
    enabled: true,
    host: localHost,
    configPath,
    captureDir,
    localCapture: cfg?.local_capture !== false,
    shareOptIn: cfg?.share_opt_in === true,
    totals,
    byHarness: sortBuckets(harnessMap),
    byMode: sortBuckets(modeMap),
    recentFindings,
    facets: {
      hosts: Array.from(hosts).toSorted(),
      harnesses: Array.from(harnesses).toSorted(),
    },
  };
}
