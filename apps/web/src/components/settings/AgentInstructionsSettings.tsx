import { useGT } from "gt-react";
import { useRef } from "react";

import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { Textarea } from "../ui/textarea";
import { SettingsRow, SettingResetButton } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import { useSearchableSetting } from "./settingsSearch";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

/** An empty setting means the server's built-in text, so saving that text unchanged stores "". */
function agentInstructionsToSave(value: string, defaultText: string): string {
  const trimmed = value.trim();
  return trimmed === defaultText.trim() ? "" : trimmed;
}

export function AgentInstructionsSettings() {
  const gt = useGT();
  const searchableSetting = useSearchableSetting();
  const settings = useScopedSettings();
  const { scope, target, targets } = useSettingsScope();
  const edited = useRef(false);
  const updateSettings = useUpdateScopedSettings();
  const mixed = useScopedSettingsMixed(["agentInstructions"]);
  const isProjectScope = scope.kind === "project" || scope.kind === "checkout";
  const environmentId = target?.environmentId ?? null;
  const defaults = useEnvironmentQuery(
    environmentId === null || isProjectScope
      ? null
      : serverEnvironment.defaultAgentInstructions({ environmentId, input: {} }),
  );
  if (isProjectScope) return null;

  const defaultText = defaults.data?.text ?? null;
  const current = settings.agentInstructions;
  const scopeKey = targets.map((entry) => entry.environmentId).join(",");
  // The built-in text is needed to show it and to tell an edit from it, unless the user replaced it.
  const blocked = defaultText === null && current === "" && !mixed;

  return (
    <SettingsRow
      serverScoped
      settingKeys={["agentInstructions"]}
      {...searchableSetting("agent-instructions")}
      description={gt(
        "The instructions T3 adds to every agent's system prompt. Edits replace the built-in text and apply when an agent session next starts.",
      )}
      resetAction={
        mixed || current !== "" ? (
          <SettingResetButton
            ariaLabel={gt("Reset agent instructions to default")}
            onClick={() => updateSettings({ agentInstructions: "" })}
          />
        ) : null
      }
    >
      <div className="mt-3 max-w-3xl pb-3.5">
        <Textarea
          key={`${scopeKey}:${mixed}:${current}:${defaultText !== null}`}
          aria-label={gt("Agent instructions")}
          disabled={blocked}
          rows={16}
          spellCheck={false}
          onChange={() => {
            edited.current = true;
          }}
          defaultValue={mixed ? "" : current !== "" ? current : (defaultText ?? "")}
          placeholder={
            mixed
              ? gt("Mixed. Enter instructions to apply to all selected targets.")
              : defaults.isPending
                ? gt("Loading the built-in instructions…")
                : undefined
          }
          onBlur={(event) => {
            if (!edited.current) return;
            edited.current = false;
            const next =
              defaultText === null
                ? event.target.value.trim()
                : agentInstructionsToSave(event.target.value, defaultText);
            if (mixed || next !== current) updateSettings({ agentInstructions: next });
          }}
        />
        {blocked && defaults.error !== null ? (
          <p className="mt-2 text-destructive text-xs">
            {gt("This server did not send its built-in instructions. Update it to edit them here.")}
          </p>
        ) : null}
      </div>
    </SettingsRow>
  );
}
