import { describe, expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "~/index.css";
import "./fleetDeck.css";
import { render } from "../../test/render";
import { DeckHeaderStrip } from "./DeckHeaderStrip";
import { mergeFleetHosts } from "./devdeckTypes";

// The owner's default desktop window (`DEFAULT_MAIN_WINDOW_SIZE`); the Fleet console sits beside
// the 16rem thread sidebar.
const WINDOW = { width: 1100, height: 780 };
const CONSOLE_WIDTH = WINDOW.width - 256;

// Long names, multi-day uptimes and two-digit loads: the widest chip text a fleet shows.
const REMOTES = [
  { name: "build-host-linux-01", uptime_s: 1_234_567, load1: 12.34 },
  { name: "build-host-linux-02", uptime_s: 456_789, load1: 4.56 },
  { name: "gpu-workstation-03", uptime_s: 98_765, load1: 10.5 },
  { name: "laptop-dev-04", uptime_s: 801_234, load1: 0.07 },
];

const hosts = mergeFleetHosts({
  localHost: { name: "queue-host-local", uptime_s: 3_134_249, load1: 1.15, cpus: 10 },
  localServers: [],
  localSessions: [],
  localAlerts: [],
  localWorktrees: null,
  nodes: Object.fromEntries(
    REMOTES.map((h) => [h.name, { status: "online", host: { ...h, cpus: 8 } }]),
  ),
  hostsReport: {
    report: {
      hosts: [
        { name: "queue-host-local", ssh: null, ci_off: false },
        ...REMOTES.map((h) => ({ name: h.name, ssh: h.name, ci_off: false })),
      ],
    },
  },
  shipPanel: null,
});

describe("Fleet host chips at the default window size", () => {
  it("shows every host's name, uptime and load in full beside its CI switch", async () => {
    const previous = { width: window.innerWidth, height: window.innerHeight };
    await page.viewport(WINDOW.width, WINDOW.height);
    await using _viewport = {
      [Symbol.asyncDispose]: () => page.viewport(previous.width, previous.height),
    };
    await using _screen = await render(
      <div data-fd="root" style={{ width: CONSOLE_WIDTH }}>
        <DeckHeaderStrip
          hosts={hosts}
          selectedHost={hosts[0] ?? null}
          busyKeys={new Set()}
          onSelectHost={() => {}}
          onToggleCi={() => {}}
          onCheckHosts={() => {}}
          onRunStorageReport={() => {}}
          onStartCleanupReview={() => {}}
        />
      </div>,
    );

    await expect.element(page.getByText("12.34", { exact: true })).toBeVisible();
    const chips = Array.from(document.querySelectorAll<HTMLElement>('[data-fd="host-badge"]'));
    expect(chips).toHaveLength(5);
    expect(document.querySelectorAll('[role="switch"]')).toHaveLength(5);

    for (const chip of chips) {
      const chipBox = chip.getBoundingClientRect();
      const name = chip.querySelector<HTMLElement>('[data-fd="host-name"]')!;
      const meta = chip.querySelector<HTMLElement>('[data-fd="host-meta"]')!;
      for (const el of [name, meta]) {
        // Nothing is clipped or ellipsized: the text fits its box, and the box fits the chip.
        expect(el.scrollWidth).toBeLessThanOrEqual(el.clientWidth + 1);
        expect(getComputedStyle(el).textOverflow).not.toBe("ellipsis");
        const box = el.getBoundingClientRect();
        expect(box.right).toBeLessThanOrEqual(chipBox.right + 0.5);
      }
      for (const part of Array.from(meta.children)) {
        const partBox = part.getBoundingClientRect();
        expect(partBox.right).toBeLessThanOrEqual(chipBox.right + 0.5);
      }
      expect(meta.textContent).toMatch(/^up \d+[dhm][^·]*·load \d+\.\d{2}$/);
    }

    const metaText = chips.map((chip) => chip.querySelector('[data-fd="host-meta"]')!.textContent);
    expect(metaText).toContain("up 14d 6h·load 12.34");
    expect(chips.map((chip) => chip.querySelector('[data-fd="host-name"]')!.textContent)).toEqual(
      expect.arrayContaining(["build-host-linux-01", "gpu-workstation-03"]),
    );
  });
});
