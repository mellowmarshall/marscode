import { describe, expect, it } from "vite-plus/test";
import { commands, page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { render } from "../../../test/render";
import { PreviewPanelShell } from "./PreviewPanelShell";

const STORAGE_KEY = "test:right-panel-width";
const HANDLE = '[role="separator"][aria-label="Resize panel"]';

function Workspace() {
  return (
    <div style={{ display: "flex", width: 1200, height: 400 }}>
      <main style={{ flex: 1, minWidth: 0 }}>
        <button type="button">Chat</button>
      </main>
      <PreviewPanelShell mode="inline" open widthStorageKey={STORAGE_KEY}>
        <div role="region" aria-label="Panel content" />
      </PreviewPanelShell>
    </div>
  );
}

function panelWidth(screen: { container: HTMLElement }): number {
  return screen.container
    .querySelector<HTMLElement>("[data-preview-panel-mode]")!
    .getBoundingClientRect().width;
}

/** A wide viewport and an empty saved width, both restored when the test ends. */
async function wideViewportWithoutSavedWidth(): Promise<AsyncDisposable> {
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  const previous = localStorage.getItem(STORAGE_KEY);
  localStorage.removeItem(STORAGE_KEY);
  await page.viewport(1280, 800);
  return {
    async [Symbol.asyncDispose]() {
      await page.viewport(viewport.width, viewport.height);
      if (previous === null) localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, previous);
    },
  };
}

describe("PreviewPanelShell resize", () => {
  it("exposes an accessible separator with its bounds", async () => {
    await using _env = await wideViewportWithoutSavedWidth();
    await using screen = await render(<Workspace />, { router: false });
    const handle = screen.getByRole("separator", { name: "Resize panel" });
    await expect.element(handle).toHaveAttribute("aria-orientation", "vertical");
    await expect.element(handle).toHaveAttribute("aria-valuenow", "540");
    await expect.element(handle).toHaveAttribute("aria-valuemin", "360");
    // 70% of the 1280px viewport caps it before the 1200px row's chat reserve does.
    await expect.element(handle).toHaveAttribute("aria-valuemax", "840");
    await expect.element(handle).toHaveAttribute("tabindex", "0");
  });

  it("widens with a mouse drag, clamps to the maximum, and persists the result", async () => {
    await using _env = await wideViewportWithoutSavedWidth();
    await using screen = await render(<Workspace />, { router: false });
    const handle = screen.getByRole("separator", { name: "Resize panel" });

    await commands.dragHorizontally(HANDLE, -100);
    await expect.element(handle).toHaveAttribute("aria-valuenow", "640");
    expect(panelWidth(screen)).toBe(640);
    expect(localStorage.getItem(STORAGE_KEY)).toBe("640");

    await commands.dragHorizontally(HANDLE, -600);
    await expect.element(handle).toHaveAttribute("aria-valuenow", "840");
    expect(localStorage.getItem(STORAGE_KEY)).toBe("840");
  });

  it("resizes from the keyboard and persists each step", async () => {
    await using _env = await wideViewportWithoutSavedWidth();
    await using screen = await render(<Workspace />, { router: false });
    const handle = screen.getByRole("separator", { name: "Resize panel" });
    // Pressing the handle starts a drag, which keeps focus where it was; keyboard users tab to it.
    await userEvent.click(screen.getByRole("button", { name: "Chat" }));
    await userEvent.tab();
    await expect.element(handle).toHaveFocus();

    await userEvent.keyboard("{ArrowLeft}");
    await expect.element(handle).toHaveAttribute("aria-valuenow", "556");
    expect(panelWidth(screen)).toBe(556);
    expect(localStorage.getItem(STORAGE_KEY)).toBe("556");

    await userEvent.keyboard("{Shift>}{ArrowRight}{/Shift}");
    await expect.element(handle).toHaveAttribute("aria-valuenow", "492");

    await userEvent.keyboard("{Home}");
    await expect.element(handle).toHaveAttribute("aria-valuenow", "360");
    await userEvent.keyboard("{ArrowRight}");
    await expect.element(handle).toHaveAttribute("aria-valuenow", "360");

    await userEvent.keyboard("{End}");
    await expect.element(handle).toHaveAttribute("aria-valuenow", "840");
    expect(localStorage.getItem(STORAGE_KEY)).toBe("840");
  });

  it("restores the saved width on the next mount", async () => {
    await using _env = await wideViewportWithoutSavedWidth();
    {
      await using screen = await render(<Workspace />, { router: false });
      await commands.dragHorizontally(HANDLE, -80);
      await expect
        .element(screen.getByRole("separator", { name: "Resize panel" }))
        .toHaveAttribute("aria-valuenow", "620");
    }
    await using restored = await render(<Workspace />, { router: false });
    await expect
      .element(restored.getByRole("separator", { name: "Resize panel" }))
      .toHaveAttribute("aria-valuenow", "620");
    expect(panelWidth(restored)).toBe(620);
  });
});
