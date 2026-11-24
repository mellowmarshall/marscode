import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  DEFAULT_OUTPUT_HIGHLIGHTING_MODE,
  DEFAULT_PROVIDER_TUI_PALETTES,
  readOutputHighlightingMode,
  readProviderTuiPalettes,
  TUI_OUTPUT_HIGHLIGHTING_MODE_STORAGE_KEY,
  TUI_PROVIDER_PALETTES_STORAGE_KEY,
  writeOutputHighlightingMode,
  writeProviderTuiPalettes,
} from "./tuiOutputPreferences";

function createMemoryStorage() {
  const backing = new Map<string, string>();
  return {
    getItem: (key: string) => backing.get(key) ?? null,
    setItem: (key: string, value: string) => {
      backing.set(key, value);
    },
    removeItem: (key: string) => {
      backing.delete(key);
    },
    clear: () => {
      backing.clear();
    },
  };
}

describe("tuiOutputPreferences", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns defaults when localStorage is unavailable or empty", () => {
    vi.stubGlobal("window", undefined);
    expect(readProviderTuiPalettes()).toBe(DEFAULT_PROVIDER_TUI_PALETTES);
    expect(readOutputHighlightingMode()).toBe(DEFAULT_OUTPUT_HIGHLIGHTING_MODE);
  });

  it("reads and writes preferences cleanly using localStorage", () => {
    const storage = createMemoryStorage();
    const dispatched: Array<string> = [];
    vi.stubGlobal("window", {
      localStorage: storage,
      dispatchEvent: (event: { type: string }) => {
        dispatched.push(event.type);
        return true;
      },
    });
    vi.stubGlobal(
      "CustomEvent",
      class {
        readonly type: string;
        constructor(type: string) {
          this.type = type;
        }
      },
    );

    expect(readProviderTuiPalettes()).toBe(true);
    expect(readOutputHighlightingMode()).toBe("semantic");

    writeProviderTuiPalettes(false);
    writeOutputHighlightingMode("ansi");
    expect(storage.getItem(TUI_PROVIDER_PALETTES_STORAGE_KEY)).toBe("false");
    expect(storage.getItem(TUI_OUTPUT_HIGHLIGHTING_MODE_STORAGE_KEY)).toBe('"ansi"');
    expect(readProviderTuiPalettes()).toBe(false);
    expect(readOutputHighlightingMode()).toBe("ansi");

    storage.setItem(TUI_OUTPUT_HIGHLIGHTING_MODE_STORAGE_KEY, '"invalid"');
    expect(readOutputHighlightingMode()).toBe("semantic");
    expect(dispatched.length).toBeGreaterThanOrEqual(2);
  });
});
