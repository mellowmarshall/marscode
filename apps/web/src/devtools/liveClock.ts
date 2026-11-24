/** Shared 1s live clock store so multiple live job views share a single interval. */
import { useSyncExternalStore } from "react";

let sharedClockNowMs = Date.now();
let sharedClockTimer: ReturnType<typeof setInterval> | null = null;
const sharedClockListeners = new Set<() => void>();

function subscribeSharedClock(listener: () => void): () => void {
  sharedClockListeners.add(listener);
  if (sharedClockTimer === null) {
    sharedClockNowMs = Date.now();
    sharedClockTimer = setInterval(() => {
      sharedClockNowMs = Date.now();
      for (const cb of sharedClockListeners) cb();
    }, 1_000);
  }
  return () => {
    sharedClockListeners.delete(listener);
    if (sharedClockListeners.size === 0 && sharedClockTimer !== null) {
      clearInterval(sharedClockTimer);
      sharedClockTimer = null;
    }
  };
}

const NOOP_CLOCK_SUBSCRIBE = () => () => {};
const getSharedClockSnapshot = () => sharedClockNowMs;

export function useLiveClockMs(enabled: boolean): number {
  return useSyncExternalStore(
    enabled ? subscribeSharedClock : NOOP_CLOCK_SUBSCRIBE,
    getSharedClockSnapshot,
    getSharedClockSnapshot,
  );
}
