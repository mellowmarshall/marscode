import * as Effect from "effect/Effect";
import { beforeEach, expect, vi } from "vite-plus/test";
import { it } from "@effect/vitest";

const native = vi.hoisted(() => ({
  flashFrame: vi.fn(),
  isDestroyed: vi.fn(() => false),
  getFocusedWindow: vi.fn(() => null as object | null),
  listeners: new Map<string, () => void>(),
}));
vi.mock("electron", () => ({
  app: {
    on: (event: string, listener: () => void) => native.listeners.set(event, listener),
    removeListener: (event: string) => native.listeners.delete(event),
  },
  BrowserWindow: {
    getFocusedWindow: native.getFocusedWindow,
    getAllWindows: () => [native],
  },
}));

import * as ElectronApp from "../../electron/ElectronApp.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import { installWindowAttention } from "./windowAttention.ts";

beforeEach(() => {
  vi.clearAllMocks();
  native.getFocusedWindow.mockReturnValue(null);
  native.isDestroyed.mockReturnValue(false);
  native.listeners.clear();
});

it.effect("flashes an unfocused window until focus, an answer, or disposal stops it", () =>
  Effect.gen(function* () {
    const handlers = new Map<string, DesktopIpc.DesktopIpcHandleListener>();
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* installWindowAttention();
        const handler = handlers.get("desktop:set-window-attention")!;
        const event = { sender: { id: 1 } };
        yield* Effect.promise(() => expect(handler(event, "yes")).rejects.toBeDefined());
        expect(native.flashFrame).not.toHaveBeenCalled();

        yield* Effect.promise(() => Promise.resolve(handler(event, true)));
        expect(native.flashFrame).toHaveBeenLastCalledWith(true);
        native.listeners.get("browser-window-focus")!();
        expect(native.flashFrame).toHaveBeenLastCalledWith(false);

        // A focused window is already seen, so it does not flash.
        native.getFocusedWindow.mockReturnValue({});
        yield* Effect.promise(() => Promise.resolve(handler(event, true)));
        expect(native.flashFrame).toHaveBeenLastCalledWith(false);

        native.getFocusedWindow.mockReturnValue(null);
        yield* Effect.promise(() => Promise.resolve(handler(event, true)));
        expect(native.flashFrame).toHaveBeenLastCalledWith(true);
        yield* Effect.promise(() => Promise.resolve(handler(event, false)));
        expect(native.flashFrame).toHaveBeenLastCalledWith(false);
        yield* Effect.promise(() => Promise.resolve(handler(event, true)));
      }),
    ).pipe(
      Effect.provide([
        ElectronApp.layer,
        DesktopIpc.layerTest({
          handle: (channel, handler) => {
            handlers.set(channel, handler);
          },
          removeHandler: (channel) => {
            handlers.delete(channel);
          },
          on: vi.fn(),
          removeAllListeners: vi.fn(),
        }),
      ]),
    );
    expect(native.flashFrame).toHaveBeenLastCalledWith(false);
    expect(native.listeners.size).toBe(0);
    expect(handlers.size).toBe(0);
  }),
);
