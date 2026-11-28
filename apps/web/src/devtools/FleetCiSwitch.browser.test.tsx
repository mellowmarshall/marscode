import { useState } from "react";
import { describe, expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "~/index.css";
import "./fleetDeck.css";
import { render } from "../../test/render";
import { DeckHeaderStrip } from "./DeckHeaderStrip";
import { mergeFleetHosts } from "./devdeckTypes";

const WINDOW = { width: 1100, height: 780 };
const OFF_REASON = "runs a long simulation; keep CI off";
const OFF_AT = "2026-11-28T11:00:00.000Z";
const VERSION = "3f2a9c0d4b5e6f708192a3b4c5d6e7f8";

function fleetHosts(ciOff: Readonly<Record<string, boolean>>) {
  return mergeFleetHosts({
    localHost: { name: "queue-host-local", uptime_s: 3_134_249, load1: 1.15, cpus: 10 },
    localServers: [],
    localSessions: [],
    localAlerts: [],
    localWorktrees: null,
    nodes: {
      "build-host-01": {
        status: "online",
        host: { name: "build-host-01", uptime_s: 456_789, load1: 4.56, cpus: 8 },
      },
      "build-host-02": {
        status: "online",
        host: { name: "build-host-02", uptime_s: 98_765, load1: 0.5, cpus: 8 },
      },
    },
    hostsReport: {
      report: {
        hosts: [
          { name: "queue-host-local", ssh: null, ci_off: Boolean(ciOff["queue-host-local"]) },
          ciOff["build-host-01"]
            ? {
                name: "build-host-01",
                ssh: "build-host-01",
                ci_off: true,
                ci_off_at: OFF_AT,
                ci_off_version: VERSION,
                ci_off_by: "owner",
                ci_off_reason: OFF_REASON,
              }
            : { name: "build-host-01", ssh: "build-host-01", ci_off: false },
          { name: "build-host-02", ssh: "build-host-02", ci_off: false },
        ],
      },
    },
    shipPanel: null,
  });
}

type ToggleCall = readonly [host: string, enabled: boolean, confirmVersion: string | null];

/** The real strip with real selection state; CI toggles are recorded, not applied. */
function Harness({ calls }: { readonly calls: ToggleCall[] }) {
  const hosts = fleetHosts({ "build-host-01": true });
  const [selected, setSelected] = useState(hosts[0]!.id);
  return (
    <div data-fd="root" style={{ width: WINDOW.width - 256 }}>
      <DeckHeaderStrip
        hosts={hosts}
        selectedHost={hosts.find((h) => h.id === selected) ?? null}
        busyKeys={new Set()}
        onSelectHost={setSelected}
        onToggleCi={(host, enabled, version) => calls.push([host.id, enabled, version])}
        onCheckHosts={() => {}}
        onRunStorageReport={() => {}}
        onStartCleanupReview={() => {}}
      />
    </div>
  );
}

async function atDefaultWindow() {
  const previous = { width: window.innerWidth, height: window.innerHeight };
  await page.viewport(WINDOW.width, WINDOW.height);
  return {
    [Symbol.asyncDispose]: () => page.viewport(previous.width, previous.height),
  };
}

function chipFor(name: string): HTMLElement {
  const chip = Array.from(document.querySelectorAll<HTMLElement>('[data-fd="host-badge"]')).find(
    (el) => el.querySelector('[data-fd="host-name"]')?.textContent === name,
  );
  if (!chip) throw new Error(`no chip for ${name}`);
  return chip;
}

describe("Fleet CI switch", () => {
  it("clicking a host chip selects the host and never toggles CI", async () => {
    await using _viewport = await atDefaultWindow();
    const calls: ToggleCall[] = [];
    await using _screen = await render(<Harness calls={calls} />);

    const tab = page.getByRole("button", { name: /build-host-02/ });
    await expect.element(tab).toHaveAttribute("aria-pressed", "false");
    await tab.click();
    await expect.element(tab).toHaveAttribute("aria-pressed", "true");

    // Click the name and the load line too: every part of the select area selects, none toggles.
    await page.getByText("build-host-01", { exact: true }).click();
    await expect
      .element(page.getByRole("button", { name: /build-host-01/ }))
      .toHaveAttribute("aria-pressed", "true");
    await page.getByText("1.15", { exact: true }).click();
    await expect
      .element(page.getByRole("button", { name: /queue-host-local/ }))
      .toHaveAttribute("aria-pressed", "true");
    expect(calls).toEqual([]);

    // The switch is a separate, larger target beside the select area, never inside it.
    for (const name of ["queue-host-local", "build-host-01", "build-host-02"]) {
      const chip = chipFor(name);
      const select = chip.querySelector<HTMLElement>('[data-fd="host-select"]')!;
      const sw = chip.querySelector<HTMLElement>('[role="switch"]')!;
      expect(select.contains(sw)).toBe(false);
      const swBox = sw.getBoundingClientRect();
      const selBox = select.getBoundingClientRect();
      expect(swBox.width).toBeGreaterThanOrEqual(72);
      expect(swBox.height).toBeGreaterThanOrEqual(34);
      expect(swBox.left).toBeGreaterThanOrEqual(selBox.right - 0.5);
    }

    // Selecting with the switch's host never changes when the switch is used.
    await page.getByRole("switch", { name: "Disable CI on build-host-02" }).click();
    await expect
      .element(page.getByRole("button", { name: /queue-host-local/ }))
      .toHaveAttribute("aria-pressed", "true");
    expect(calls).toEqual([["build-host-02", false, null]]);
  });

  it("turning CI on for a host with a reason opens a confirmation, and cancel leaves it off", async () => {
    await using _viewport = await atDefaultWindow();
    const calls: ToggleCall[] = [];
    await using _screen = await render(<Harness calls={calls} />);

    const sw = page.getByRole("switch", { name: "Enable CI on build-host-01" });
    await expect.element(sw).toHaveAttribute("aria-checked", "false");
    await sw.click();

    const dialog = page.getByTestId("ci-on-confirm");
    await expect.element(dialog).toBeVisible();
    await expect.element(page.getByTestId("ci-on-confirm-reason")).toHaveTextContent(OFF_REASON);
    await expect.element(page.getByTestId("ci-on-confirm-by")).toHaveTextContent("owner");
    await expect
      .element(page.getByTestId("ci-on-confirm-at"))
      .toHaveTextContent(new Date(OFF_AT).toLocaleString());
    await expect.element(page.getByRole("button", { name: "Turn CI on" })).toBeVisible();
    expect(calls).toEqual([]);

    await page.getByRole("button", { name: "Cancel" }).click();
    await expect.element(dialog).not.toBeInTheDocument();
    await expect.element(sw).toHaveAttribute("aria-checked", "false");
    expect(calls).toEqual([]);

    // Only "Turn CI on" sends the turn-on, and it carries the confirmation.
    await sw.click();
    await page.getByRole("button", { name: "Turn CI on" }).click();
    await expect.element(page.getByTestId("ci-on-confirm")).not.toBeInTheDocument();
    expect(calls).toEqual([["build-host-01", true, VERSION]]);
  });

  it("turns CI on in one click for an off host with no reason", async () => {
    await using _viewport = await atDefaultWindow();
    const calls: ToggleCall[] = [];
    const hosts = fleetHosts({ "queue-host-local": true });
    await using _screen = await render(
      <div data-fd="root" style={{ width: WINDOW.width - 256 }}>
        <DeckHeaderStrip
          hosts={hosts}
          selectedHost={hosts[0] ?? null}
          busyKeys={new Set()}
          onSelectHost={() => {}}
          onToggleCi={(host, enabled, version) => calls.push([host.id, enabled, version])}
          onCheckHosts={() => {}}
          onRunStorageReport={() => {}}
          onStartCleanupReview={() => {}}
        />
      </div>,
    );
    await page.getByRole("switch", { name: "Enable CI on queue-host-local" }).click();
    expect(calls).toEqual([["queue-host-local", true, null]]);
    expect(document.querySelector('[data-testid="ci-on-confirm"]')).toBeNull();
  });
});
