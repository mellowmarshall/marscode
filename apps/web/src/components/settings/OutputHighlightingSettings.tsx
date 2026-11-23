import { DEFAULT_UNIFIED_SETTINGS, type OutputHighlightingMode } from "@t3tools/contracts/settings";
import { msg, useGT, useMessages } from "gt-react";

import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

const OUTPUT_HIGHLIGHTING_LABELS: Record<OutputHighlightingMode, string> = {
  semantic: msg("Semantic + ANSI"),
  ansi: msg("ANSI escapes only"),
  off: msg("Off"),
};

export function OutputHighlightingSettings() {
  const gt = useGT();
  const m = useMessages();
  const searchableSetting = useSearchableSetting();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();

  return (
    <>
      <SettingsRow
        {...searchableSetting("provider-tui-palettes")}
        description={gt(
          "Tint assistant markdown, inline code pills, and terminal output using each provider’s native TUI palette (Claude Code, Codex, Antigravity, Muse).",
        )}
        resetAction={
          settings.providerTuiPalettes !== DEFAULT_UNIFIED_SETTINGS.providerTuiPalettes ? (
            <SettingResetButton
              ariaLabel={gt("Reset provider TUI palettes to default")}
              onClick={() =>
                updateSettings({
                  providerTuiPalettes: DEFAULT_UNIFIED_SETTINGS.providerTuiPalettes,
                })
              }
            />
          ) : null
        }
        control={
          <Switch
            checked={settings.providerTuiPalettes}
            onCheckedChange={(checked) => updateSettings({ providerTuiPalettes: Boolean(checked) })}
            aria-label={gt("Provider TUI palettes")}
          />
        }
      />
      <SettingsRow
        {...searchableSetting("output-highlighting")}
        description={gt(
          "Highlight ANSI escapes, shell commands, flags, file paths, JSON, diffs, and log levels across command outputs and assistant inline code.",
        )}
        resetAction={
          settings.outputHighlightingMode !== DEFAULT_UNIFIED_SETTINGS.outputHighlightingMode ? (
            <SettingResetButton
              ariaLabel={gt("Reset output highlighting to default")}
              onClick={() =>
                updateSettings({
                  outputHighlightingMode: DEFAULT_UNIFIED_SETTINGS.outputHighlightingMode,
                })
              }
            />
          ) : null
        }
        control={
          <div className="w-full sm:w-auto sm:min-w-40">
            <Select
              value={settings.outputHighlightingMode}
              onValueChange={(value) => {
                if (value === "semantic" || value === "ansi" || value === "off") {
                  updateSettings({ outputHighlightingMode: value });
                }
              }}
            >
              <SelectTrigger
                size="sm"
                className="w-full min-w-0"
                aria-label={gt("Output highlighting")}
              >
                <SelectValue>
                  {m(OUTPUT_HIGHLIGHTING_LABELS[settings.outputHighlightingMode])}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem value="semantic">{gt("Semantic + ANSI (default)")}</SelectItem>
                <SelectItem value="ansi">{m(OUTPUT_HIGHLIGHTING_LABELS.ansi)}</SelectItem>
                <SelectItem value="off">{m(OUTPUT_HIGHLIGHTING_LABELS.off)}</SelectItem>
              </SelectPopup>
            </Select>
          </div>
        }
      />
    </>
  );
}
