import * as Schema from "effect/Schema";
import {
  readLocalStorageValue,
  useLocalStorage,
  writeLocalStorageValue,
} from "../hooks/useLocalStorage";

export const OutputHighlightingModeSchema = Schema.Literals(["semantic", "ansi", "off"]);
export type OutputHighlightingMode = typeof OutputHighlightingModeSchema.Type;

export const DEFAULT_PROVIDER_TUI_PALETTES = true;
export const DEFAULT_OUTPUT_HIGHLIGHTING_MODE: OutputHighlightingMode = "semantic";

export const TUI_PROVIDER_PALETTES_STORAGE_KEY = "t3code:tui-provider-palettes:v1";
export const TUI_OUTPUT_HIGHLIGHTING_MODE_STORAGE_KEY = "t3code:tui-output-highlighting:v1";

export function readProviderTuiPalettes(): boolean {
  return readLocalStorageValue(
    TUI_PROVIDER_PALETTES_STORAGE_KEY,
    DEFAULT_PROVIDER_TUI_PALETTES,
    Schema.Boolean,
  );
}

export function writeProviderTuiPalettes(value: boolean): void {
  writeLocalStorageValue(
    TUI_PROVIDER_PALETTES_STORAGE_KEY,
    value,
    DEFAULT_PROVIDER_TUI_PALETTES,
    Schema.Boolean,
  );
}

export function readOutputHighlightingMode(): OutputHighlightingMode {
  return readLocalStorageValue(
    TUI_OUTPUT_HIGHLIGHTING_MODE_STORAGE_KEY,
    DEFAULT_OUTPUT_HIGHLIGHTING_MODE,
    OutputHighlightingModeSchema,
  );
}

export function writeOutputHighlightingMode(value: OutputHighlightingMode): void {
  writeLocalStorageValue(
    TUI_OUTPUT_HIGHLIGHTING_MODE_STORAGE_KEY,
    value,
    DEFAULT_OUTPUT_HIGHLIGHTING_MODE,
    OutputHighlightingModeSchema,
  );
}

export function useProviderTuiPalettes(): [
  boolean,
  (value: boolean | ((current: boolean) => boolean)) => void,
] {
  return useLocalStorage(
    TUI_PROVIDER_PALETTES_STORAGE_KEY,
    DEFAULT_PROVIDER_TUI_PALETTES,
    Schema.Boolean,
  );
}

export function useOutputHighlightingMode(): [
  OutputHighlightingMode,
  (
    value: OutputHighlightingMode | ((current: OutputHighlightingMode) => OutputHighlightingMode),
  ) => void,
] {
  return useLocalStorage(
    TUI_OUTPUT_HIGHLIGHTING_MODE_STORAGE_KEY,
    DEFAULT_OUTPUT_HIGHLIGHTING_MODE,
    OutputHighlightingModeSchema,
  );
}
