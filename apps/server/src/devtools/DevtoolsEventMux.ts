/**
 * Multiplexes DevTools SSE topics (`guards`, `jobs`, `devdeck`, `ship-queue`) onto a single
 * `GET /api/devtools/events?topics=...` stream with prefixed SSE event names (`<topic>:<event>`),
 * independent sub-stream resilience, and unified AbortSignal teardown.
 */
import * as CliRunners from "./CliRunners.ts";
import * as DevdeckProxy from "./DevdeckProxy.ts";
import type { NativeFleetService } from "./fleet/NativeFleetService.ts";
import { shouldUseLegacyDevdeckProxy } from "./fleet/NativeFleetWiring.ts";
import type { GuardGrantBroker } from "./GuardGrantBroker.ts";
import type * as JobRegistry from "./jobs/JobRegistry.ts";

export type DevtoolsMuxTopic = "guards" | "jobs" | "devdeck" | "ship-queue";

const VALID_TOPICS: ReadonlySet<string> = new Set<DevtoolsMuxTopic>([
  "guards",
  "jobs",
  "devdeck",
  "ship-queue",
]);

const MAX_FRAME_BUFFER_CHARS = 2 * 1024 * 1024;
const FRAME_DELIM_RE = /\r?\n\r?\n/;
const encoder = new TextEncoder();

export function parseMuxTopics(raw: string | null): ReadonlySet<DevtoolsMuxTopic> | null {
  if (!raw) return null;
  const parsed = new Set<DevtoolsMuxTopic>();
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    if (!VALID_TOPICS.has(trimmed)) return null;
    parsed.add(trimmed as DevtoolsMuxTopic);
  }
  return parsed.size > 0 ? parsed : null;
}

function rewriteSseFrame(topic: DevtoolsMuxTopic, rawFrame: string): string | null {
  let eventName = "message";
  const dataLines: string[] = [];
  for (const line of rawFrame.split(/\r?\n/)) {
    if (!line || line.startsWith(":")) continue;
    if (line.startsWith("event:")) {
      const candidate = line.slice(6).trim();
      if (candidate) eventName = candidate;
    } else if (line.startsWith("data:")) {
      // SSE spec strips at most one leading U+0020 space after `data:`.
      dataLines.push(line.startsWith("data: ") ? line.slice(6) : line.slice(5));
    }
  }
  if (dataLines.length === 0) return null;
  const payload = dataLines.map((line) => `data: ${line}`).join("\n");
  return `event: ${topic}:${eventName}\n${payload}\n\n`;
}

export interface CreateMuxStreamOptions {
  readonly topics: ReadonlySet<DevtoolsMuxTopic>;
  readonly broker: GuardGrantBroker;
  readonly jobRegistry: JobRegistry.JobRegistryService;
  readonly includeCmdline: boolean;
  readonly devdeckApiPath: string;
  readonly devdeckTarget?: DevdeckProxy.DevdeckTarget | undefined;
  readonly nativeFleet?: NativeFleetService | undefined;
}

export function createMultiplexedEventStream(
  outerSignal: AbortSignal,
  options: CreateMuxStreamOptions,
): ReadableStream<Uint8Array> {
  const innerCtrl = new AbortController();
  const readers: Array<ReadableStreamDefaultReader<Uint8Array>> = [];
  let unsubGuards: (() => void) | null = null;
  let onOuterAbortRef: (() => void) | null = null;
  let closed = false;

  const cleanup = () => {
    if (closed) return;
    closed = true;
    if (onOuterAbortRef) {
      outerSignal.removeEventListener("abort", onOuterAbortRef);
      onOuterAbortRef = null;
    }
    if (unsubGuards) {
      const fn = unsubGuards;
      unsubGuards = null;
      fn();
    }
    innerCtrl.abort();
    while (readers.length > 0) {
      const reader = readers.pop()!;
      void reader.cancel().catch(() => undefined);
    }
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const enqueueText = (text: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          cleanup();
        }
      };

      const onOuterAbort = () => {
        cleanup();
        try {
          controller.close();
        } catch {
          // already closed
        }
      };
      if (outerSignal.aborted) {
        onOuterAbort();
        return;
      }
      onOuterAbortRef = onOuterAbort;
      outerSignal.addEventListener("abort", onOuterAbort, { once: true });

      const pipeTopic = (topic: DevtoolsMuxTopic, source: ReadableStream<Uint8Array>) => {
        const reader = source.getReader();
        readers.push(reader);
        const decoder = new TextDecoder();
        let buffer = "";
        let discardingOversizedFrame = false;
        let sawUnavailable = false;

        void (async () => {
          try {
            while (!innerCtrl.signal.aborted) {
              const { value, done } = await reader.read();
              if (done) break;
              if (!value || value.byteLength === 0) continue;
              const chunk = decoder.decode(value, { stream: true });
              if (discardingOversizedFrame) {
                const delimMatch = FRAME_DELIM_RE.exec(chunk);
                if (!delimMatch) continue;
                discardingOversizedFrame = false;
                buffer = chunk.slice(delimMatch.index + delimMatch[0].length);
              } else {
                buffer += chunk;
                if (buffer.length > MAX_FRAME_BUFFER_CHARS) {
                  buffer = "";
                  discardingOversizedFrame = true;
                  continue;
                }
              }
              const parts = buffer.split(FRAME_DELIM_RE);
              buffer = parts.pop() ?? "";
              for (const rawFrame of parts) {
                const rewritten = rewriteSseFrame(topic, rawFrame);
                if (!rewritten) continue;
                if (rewritten.startsWith(`event: ${topic}:unavailable\n`)) {
                  sawUnavailable = true;
                }
                enqueueText(rewritten);
              }
            }
          } catch {
            // Isolate sub-stream failures so sibling topics stay live on this connection.
          } finally {
            if (!innerCtrl.signal.aborted && !sawUnavailable) {
              enqueueText(`event: ${topic}:unavailable\ndata: {"error":"stream disconnected"}\n\n`);
            }
          }
        })();
      };

      try {
        if (options.topics.has("guards")) {
          enqueueText(
            `event: guards:event\ndata: ${JSON.stringify({
              type: "snapshot",
              pending: options.broker.listPending(),
            })}\n\n`,
          );
          if (!innerCtrl.signal.aborted) {
            unsubGuards = options.broker.subscribe((event) => {
              enqueueText(`event: guards:event\ndata: ${JSON.stringify(event)}\n\n`);
            });
          }
        }

        if (!innerCtrl.signal.aborted && options.topics.has("jobs")) {
          pipeTopic(
            "jobs",
            options.jobRegistry.createEventsStream(innerCtrl.signal, {
              includeCmdline: options.includeCmdline,
            }),
          );
        }

        if (!innerCtrl.signal.aborted && options.topics.has("devdeck")) {
          const useProxy = shouldUseLegacyDevdeckProxy(options.devdeckTarget);
          pipeTopic(
            "devdeck",
            !useProxy && options.nativeFleet
              ? options.nativeFleet.createEventStream(innerCtrl.signal, options.devdeckApiPath)
              : DevdeckProxy.createDevdeckEventStream(
                  innerCtrl.signal,
                  options.devdeckApiPath,
                  options.devdeckTarget,
                ),
          );
        }

        if (!innerCtrl.signal.aborted && options.topics.has("ship-queue")) {
          pipeTopic("ship-queue", CliRunners.createShipQueueEventStream(innerCtrl.signal));
        }
      } catch {
        cleanup();
        try {
          controller.close();
        } catch {
          // already closed
        }
      }
    },
    cancel() {
      cleanup();
    },
  });
}
