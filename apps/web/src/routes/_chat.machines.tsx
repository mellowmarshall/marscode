import { createFileRoute } from "@tanstack/react-router";

import { readMachinesTab } from "../components/machines/machines.logic";
import { MachinesPage, type MachinesSearch } from "../components/machines/MachinesPage";

export const Route = createFileRoute("/_chat/machines")({
  validateSearch: (raw: Record<string, unknown>): MachinesSearch => {
    const tab = readMachinesTab(raw.tab);
    return {
      ...(typeof raw.env === "string" && raw.env ? { env: raw.env.slice(0, 200) } : {}),
      ...(tab !== "overview" ? { tab } : {}),
    };
  },
  component: MachinesPage,
});
