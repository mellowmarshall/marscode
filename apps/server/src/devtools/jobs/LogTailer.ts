// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off - Adaptive fstat incremental log tailer with chunked async reads and event-loop yields.
import * as NodeFS from "node:fs";
import * as NodeStringDecoder from "node:string_decoder";

import {
  createLineExtractor,
  splitLogLines,
  stripAnsi,
  type ExtractedLineRecord,
  type ExtractedNumericValue,
} from "./extractors.ts";
import { openValidatedLogFile, type ValidatedLogHandle } from "./logFileGuard.ts";
import { extractGenericProgress } from "./progressExtractor.ts";
import type { JobLogSourceConfig } from "./types.ts";

const EMPTY_FIELDS: ReadonlyMap<string, ExtractedNumericValue> = new Map();
const EMPTY_STRINGS: ReadonlyMap<string, string> = new Map();

const ACTIVE_POLL_MS = 1_000;
const IDLE_POLL_MS = 5_000;
const READ_CHUNK_BYTES = 64 * 1024;
const MAX_TICK_BYTES = 256 * 1024;
const MAX_INITIAL_CATCHUP_BYTES = 4 * 1024 * 1024;
const MAX_DRAIN_TAIL_BYTES = 1024 * 1024;
const MAX_LOG_TAIL_LINES = 200;
const MAX_LOG_TAIL_BYTES = 64 * 1024;

export interface LogTailBatch {
  readonly extracted: ReadonlyArray<ExtractedLineRecord>;
  readonly rawLines: ReadonlyArray<string>;
  readonly matchedSuccess: boolean;
  readonly matchedFailure: boolean;
  readonly byteOffset: number;
  readonly dev: number;
  readonly ino: number;
  readonly totalLinesParsed: number;
}

export interface LogTailerOptions {
  readonly file: ValidatedLogHandle;
  readonly config: JobLogSourceConfig;
  readonly initialOffset?: number | undefined;
  readonly initialLines?: ReadonlyArray<string> | undefined;
  readonly initialLinesParsed?: number | undefined;
  readonly isWorkspaceAllowed: (realPath: string) => Promise<boolean>;
  readonly scopedRoots?: ReadonlyArray<string> | undefined;
  readonly onBatch: (batch: LogTailBatch) => void;
}

export class AdaptiveLogTailer {
  private handle: NodeFS.promises.FileHandle | null;
  private realPath: string;
  private dev: number;
  private ino: number;
  private byteOffset: number;
  private readonly config: JobLogSourceConfig;
  private readonly extract: (line: string) => ExtractedLineRecord | null;
  private readonly isWorkspaceAllowed: (realPath: string) => Promise<boolean>;
  private readonly scopedRoots?: ReadonlyArray<string> | undefined;
  private readonly onBatch: (batch: LogTailBatch) => void;
  private readonly decoder = new NodeStringDecoder.StringDecoder("utf8");
  private pendingLine = "";
  private discardPartialFirstLine = false;
  private readonly tailLines: string[] = [];
  private tailBytes = 0;
  private linesParsed: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private activePoll: Promise<void> | null = null;
  private closed = false;
  private lastGrowthAtMs = Date.now();

  constructor(options: LogTailerOptions) {
    this.handle = options.file.handle;
    this.realPath = options.file.realPath;
    this.dev = options.file.dev;
    this.ino = options.file.ino;
    this.config = options.config;
    this.extract = createLineExtractor(options.config.format, options.config.templates);
    this.isWorkspaceAllowed = options.isWorkspaceAllowed;
    this.scopedRoots = options.scopedRoots;
    this.onBatch = options.onBatch;
    this.linesParsed = options.initialLinesParsed ?? 0;

    if (options.initialLines) {
      for (const line of options.initialLines) {
        this.pushTailLine(line);
      }
    }

    if (options.file.startAtEof) {
      this.byteOffset = options.file.size;
    } else if (
      typeof options.initialOffset === "number" &&
      Number.isFinite(options.initialOffset) &&
      options.initialOffset >= 0 &&
      options.initialOffset <= options.file.size
    ) {
      this.byteOffset = options.initialOffset;
    } else {
      // Cap initial catch-up on existing files so multi-GB logs never stall the server.
      const catchupCap = options.file.initialTailBytes ?? MAX_INITIAL_CATCHUP_BYTES;
      this.byteOffset = Math.max(0, options.file.size - catchupCap);
      this.discardPartialFirstLine = this.byteOffset > 0;
    }
  }

  start(): void {
    if (this.closed) return;
    void this.pollOnce(false).finally(() => {
      if (!this.closed) this.scheduleNext(ACTIVE_POLL_MS);
    });
  }

  async flushNow(): Promise<void> {
    if (this.closed) return;
    if (this.activePoll) {
      await this.activePoll;
    }
    if (this.closed) return;
    await this.pollOnce(true);
  }

  getTailLines(): ReadonlyArray<string> {
    return [...this.tailLines];
  }

  getCursor(): {
    readonly realPath: string;
    readonly dev: number;
    readonly ino: number;
    readonly byteOffset: number;
    readonly linesParsed: number;
  } {
    return {
      realPath: this.realPath,
      dev: this.dev,
      ino: this.ino,
      byteOffset: this.byteOffset,
      linesParsed: this.linesParsed,
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const h = this.handle;
    this.handle = null;
    if (h) {
      await h.close().catch(() => undefined);
    }
  }

  private pushTailLine(raw: string): void {
    const clean = stripAnsi(raw).trimEnd();
    if (!clean) return;
    const clipped = clean.length > 512 ? `${clean.slice(0, 512)}…` : clean;
    const bytes = Buffer.byteLength(clipped, "utf8");
    this.tailLines.push(clipped);
    this.tailBytes += bytes;
    while (this.tailLines.length > MAX_LOG_TAIL_LINES || this.tailBytes > MAX_LOG_TAIL_BYTES) {
      const dropped = this.tailLines.shift();
      if (dropped === undefined) break;
      this.tailBytes -= Buffer.byteLength(dropped, "utf8");
    }
  }

  private scheduleNext(delayMs: number): void {
    if (this.closed) return;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.pollOnce().finally(() => {
        if (!this.closed) {
          const idleMs = Date.now() - this.lastGrowthAtMs;
          this.scheduleNext(idleMs < 15_000 ? ACTIVE_POLL_MS : IDLE_POLL_MS);
        }
      });
    }, delayMs);
    this.timer.unref();
  }

  private async maybeReopenRotated(): Promise<boolean> {
    if (!this.config.path || this.config.autoFromPidFd) return false;
    try {
      const pathStat = await NodeFS.promises.stat(this.realPath);
      if (pathStat.dev === this.dev && pathStat.ino === this.ino) {
        return false;
      }
    } catch {
      return false;
    }
    const reopened = await openValidatedLogFile({
      explicitPath: this.config.path,
      isWorkspaceAllowed: this.isWorkspaceAllowed,
      scopedRoots: this.scopedRoots,
    });
    if (!reopened.ok) return false;
    const old = this.handle;
    this.handle = reopened.file.handle;
    this.realPath = reopened.file.realPath;
    this.dev = reopened.file.dev;
    this.ino = reopened.file.ino;
    this.byteOffset = 0;
    this.pendingLine = "";
    this.discardPartialFirstLine = false;
    if (old) await old.close().catch(() => undefined);
    return true;
  }

  private pollOnce(drainToEof = false): Promise<void> {
    if (this.closed || !this.handle) return Promise.resolve();
    if (this.activePoll) return this.activePoll;
    const run = this.executePoll(drainToEof).finally(() => {
      if (this.activePoll === run) this.activePoll = null;
    });
    this.activePoll = run;
    return run;
  }

  private async executePoll(drainToEof: boolean): Promise<void> {
    try {
      await this.maybeReopenRotated();
      if (this.closed || !this.handle) return;

      const stat = await this.handle.stat();
      if (stat.size < this.byteOffset) {
        this.byteOffset = 0;
        this.pendingLine = "";
        this.discardPartialFirstLine = false;
      }

      const backlog = stat.size - this.byteOffset;
      if (drainToEof && backlog > MAX_DRAIN_TAIL_BYTES) {
        this.byteOffset = stat.size - MAX_DRAIN_TAIL_BYTES;
        this.pendingLine = "";
        this.discardPartialFirstLine = true;
      } else if (!drainToEof && backlog > MAX_INITIAL_CATCHUP_BYTES) {
        // Prevent unbounded lag on logs writing faster than 256 KB/s.
        this.byteOffset = stat.size - MAX_DRAIN_TAIL_BYTES;
        this.pendingLine = "";
        this.discardPartialFirstLine = true;
      }

      const maxBytes = drainToEof ? Math.max(0, stat.size - this.byteOffset) : MAX_TICK_BYTES;
      const extracted: ExtractedLineRecord[] = [];
      const rawLines: string[] = [];
      let matchedSuccess = false;
      let matchedFailure = false;

      const processLine = (line: string) => {
        if (this.discardPartialFirstLine) {
          this.discardPartialFirstLine = false;
          return;
        }
        this.linesParsed += 1;
        this.pushTailLine(line);
        rawLines.push(line);
        const clean = stripAnsi(line);
        if (this.config.successMarker && clean.includes(this.config.successMarker)) {
          matchedSuccess = true;
        }
        if (this.config.failureMarker && clean.includes(this.config.failureMarker)) {
          matchedFailure = true;
        }
        const rec = this.extract(clean);
        const genericProgress = extractGenericProgress(clean);
        if (rec) {
          extracted.push(genericProgress ? { ...rec, genericProgress } : rec);
        } else if (genericProgress) {
          extracted.push({
            fields: EMPTY_FIELDS,
            strings: EMPTY_STRINGS,
            genericProgress,
          });
        }
      };

      if (stat.size > this.byteOffset) {
        this.lastGrowthAtMs = Date.now();
        const buf = Buffer.allocUnsafe(READ_CHUNK_BYTES);
        let readTotal = 0;

        while (!this.closed && this.handle && this.byteOffset < stat.size && readTotal < maxBytes) {
          const toRead = Math.min(
            READ_CHUNK_BYTES,
            stat.size - this.byteOffset,
            maxBytes - readTotal,
          );
          const { bytesRead } = await this.handle.read(buf, 0, toRead, this.byteOffset);
          if (bytesRead <= 0) break;
          this.byteOffset += bytesRead;
          readTotal += bytesRead;

          const text = this.decoder.write(buf.subarray(0, bytesRead));
          const { lines, remainder } = splitLogLines(this.pendingLine, text);
          this.pendingLine = remainder;
          for (const line of lines) processLine(line);

          if (this.byteOffset < stat.size && readTotal < maxBytes) {
            await new Promise<void>((resolve) => setImmediate(resolve));
          }
        }
      }

      if (drainToEof) {
        const trailing = this.pendingLine + this.decoder.end();
        this.pendingLine = "";
        if (trailing.trim()) processLine(trailing);
      }

      if (rawLines.length > 0 || matchedSuccess || matchedFailure) {
        this.onBatch({
          extracted,
          rawLines,
          matchedSuccess,
          matchedFailure,
          byteOffset: this.byteOffset,
          dev: this.dev,
          ino: this.ino,
          totalLinesParsed: this.linesParsed,
        });
      }
    } catch {
      // ignore transient stat/read errors; next poll retries
    }
  }
}
