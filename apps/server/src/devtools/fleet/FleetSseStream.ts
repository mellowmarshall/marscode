// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - Backpressure-bounded SSE stream builder for native Fleet Console updates.

const SSE_STALL_TIMEOUT_MS = 30_000;

export type FleetSseListener = (eventName: string, payload: unknown) => void;

export interface FleetSseStreamDeps {
  readonly signal: AbortSignal;
  readonly apiPath: string;
  readonly activeListeners: Set<FleetSseListener>;
  readonly passiveListeners: Set<FleetSseListener>;
  readonly onActiveStart: () => void;
  readonly onIdleStop: () => void;
  readonly readInitialSnapshot: (
    requestedPanels?: ReadonlySet<string>,
  ) => Promise<Record<string, unknown>>;
}

export function createFleetEventStream(deps: FleetSseStreamDeps): ReadableStream<Uint8Array> {
  const qIdx = deps.apiPath.indexOf("?");
  const params = new URLSearchParams(qIdx >= 0 ? deps.apiPath.slice(qIdx + 1) : "");
  const passive = params.get("passive") === "1";
  const panelsParam = params.get("panels");
  const requestedPanels = panelsParam
    ? new Set(
        panelsParam
          .split(",")
          .map((p) => p.trim())
          .filter(Boolean),
      )
    : undefined;

  const encoder = new TextEncoder();
  const bucket = passive ? deps.passiveListeners : deps.activeListeners;
  let listener: FleetSseListener | null = null;
  let stallTimer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;

  const clearStallTimer = () => {
    if (stallTimer) {
      clearTimeout(stallTimer);
      stallTimer = null;
    }
  };

  const teardown = () => {
    if (closed) return;
    closed = true;
    clearStallTimer();
    if (listener) {
      bucket.delete(listener);
      listener = null;
    }
    deps.onIdleStop();
  };

  return new ReadableStream<Uint8Array>(
    {
      start: (controller) => {
        const enqueueEvent = (eventName: string, payload: unknown) => {
          if (closed) return;
          if ((controller.desiredSize ?? 0) <= 0) {
            if (!stallTimer) {
              stallTimer = setTimeout(() => {
                teardown();
                try {
                  controller.close();
                } catch {
                  // already closed
                }
              }, SSE_STALL_TIMEOUT_MS);
              stallTimer.unref();
            }
            return;
          }
          clearStallTimer();
          try {
            controller.enqueue(
              encoder.encode(`event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`),
            );
          } catch {
            teardown();
          }
        };

        const onAbort = () => {
          teardown();
          try {
            controller.close();
          } catch {
            // already closed
          }
        };

        if (deps.signal.aborted) {
          onAbort();
          return;
        }
        deps.signal.addEventListener("abort", onAbort, { once: true });

        listener = (eventName, payload) => {
          if (eventName !== "action" && requestedPanels && !requestedPanels.has(eventName)) {
            return;
          }
          enqueueEvent(eventName, payload);
        };
        bucket.add(listener);
        if (!passive) {
          deps.onActiveStart();
        }

        void deps
          .readInitialSnapshot(requestedPanels)
          .then((snap) => {
            if (!closed) enqueueEvent("snapshot", snap);
          })
          .catch(() => undefined);
      },
      pull: () => {
        clearStallTimer();
      },
      cancel: () => {
        teardown();
      },
    },
    { highWaterMark: 4 },
  );
}
