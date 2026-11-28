import * as Electron from "electron";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as ElectronApp from "../../electron/ElectronApp.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import { SET_WINDOW_ATTENTION_CHANNEL } from "../channels.ts";

/**
 * Flashes the unfocused windows while a thread waits on the user's approval: the taskbar
 * flashes on Windows, the Dock bounces on macOS, and Linux sets the urgency hint.
 */
function applyWindowAttention(active: boolean): void {
  try {
    const focused = Electron.BrowserWindow.getFocusedWindow();
    for (const window of Electron.BrowserWindow.getAllWindows()) {
      if (window.isDestroyed()) continue;
      window.flashFrame(active && focused === null);
    }
  } catch (error) {
    Effect.runSync(Effect.logWarning("Could not update window attention", error));
  }
}

export const installWindowAttention = Effect.fn("desktop.ipc.installWindowAttention")(function* () {
  const ipc = yield* DesktopIpc.DesktopIpc;
  const app = yield* ElectronApp.ElectronApp;
  const stop = () => applyWindowAttention(false);
  yield* ipc.handle(
    DesktopIpc.makeIpcMethod({
      channel: SET_WINDOW_ATTENTION_CHANNEL,
      payload: Schema.Boolean,
      result: Schema.Void,
      handler: (active) => Effect.sync(() => applyWindowAttention(active)),
    }),
  );
  // Seeing the window answers the flash; the request itself stays on its thread row.
  yield* app.on("browser-window-focus", stop);
  yield* Effect.addFinalizer(() => Effect.sync(stop));
});
