import { createFileRoute } from "@tanstack/react-router";
import { SecuritySettingsPanel } from "../devtools/SecuritySettingsPanel";

export const Route = createFileRoute("/_chat/settings/security")({
  component: SecuritySettingsPanel,
});
