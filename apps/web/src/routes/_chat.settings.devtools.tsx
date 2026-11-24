import { createFileRoute } from "@tanstack/react-router";
import { DevtoolsSettingsPanel } from "../devtools/DevtoolsSettingsPanel";

export const Route = createFileRoute("/_chat/settings/devtools")({
  component: DevtoolsSettingsPanel,
});
