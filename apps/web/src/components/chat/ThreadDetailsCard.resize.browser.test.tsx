import "~/index.css";

import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { useRef, useState } from "react";
import { describe, expect, it } from "vite-plus/test";
import { commands, page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { useRightPanelStore } from "../../rightPanelStore";
import { PopoverCreateHandle } from "../ui/popover";
import { ChatCanvas } from "./ChatCanvas";
import { createChatCanvasStore } from "./canvasStore";
import { ThreadDetailsCard } from "./ThreadDetailsCard";
import { THREAD_DETAILS_CARD_WIDTH_STORAGE_KEY } from "./threadDetailsCardLayout";

const HANDLE = '[role="separator"][aria-label="Resize thread details"]';

const threadRef: ScopedThreadRef = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-resize"),
};

function Workspace({ canvasWidth = 1280 }: { readonly canvasWidth?: number }) {
  const [store] = useState(createChatCanvasStore);
  const [handle] = useState(PopoverCreateHandle);
  const anchor = useRef<HTMLDivElement | null>(null);
  return (
    <div style={{ display: "flex", width: canvasWidth, height: 600 }}>
      <div ref={anchor} />
      <ChatCanvas store={store} threadRef={threadRef} preview={null} composerOverlayElement={null}>
        <button type="button">Chat</button>
        <ThreadDetailsCard
          threadRef={threadRef}
          anchor={anchor}
          handle={handle}
          contentKey="resize"
        >
          {() => <div style={{ height: 200 }}>Details content</div>}
        </ThreadDetailsCard>
      </ChatCanvas>
    </div>
  );
}

function panelWidth(screen: { container: HTMLElement }): number {
  return Math.round(
    screen.container
      .querySelector<HTMLElement>('[data-thread-details-panel="inline"]')!
      .getBoundingClientRect().width,
  );
}

function canvasElement(screen: { container: HTMLElement }): HTMLElement {
  return screen.container.querySelector<HTMLElement>("[data-chat-canvas]")!;
}

/** A wide viewport and clean saved width + right-panel state, restored when the test ends. */
async function wideViewportWithoutSavedWidth(): Promise<AsyncDisposable> {
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  const previous = localStorage.getItem(THREAD_DETAILS_CARD_WIDTH_STORAGE_KEY);
  localStorage.removeItem(THREAD_DETAILS_CARD_WIDTH_STORAGE_KEY);
  useRightPanelStore.setState({ threadPanelVisibilityByThreadKey: {} });
  await page.viewport(1280, 800);
  return {
    async [Symbol.asyncDispose]() {
      await page.viewport(viewport.width, viewport.height);
      useRightPanelStore.setState({ threadPanelVisibilityByThreadKey: {} });
      if (previous === null) localStorage.removeItem(THREAD_DETAILS_CARD_WIDTH_STORAGE_KEY);
      else localStorage.setItem(THREAD_DETAILS_CARD_WIDTH_STORAGE_KEY, previous);
    },
  };
}

describe("ThreadDetailsCard resize", () => {
  it("exposes an accessible separator with its bounds", async () => {
    await using _env = await wideViewportWithoutSavedWidth();
    await using screen = await render(<Workspace />, { router: false });
    const handle = screen.getByRole("separator", { name: "Resize thread details" });
    await expect.element(handle).toHaveAttribute("aria-orientation", "vertical");
    await expect.element(handle).toHaveAttribute("aria-valuenow", "280");
    await expect.element(handle).toHaveAttribute("aria-valuemin", "240");
    await expect.element(handle).toHaveAttribute("aria-valuemax", "480");
    await expect.element(handle).toHaveAttribute("tabindex", "0");
    expect(panelWidth(screen)).toBe(280);
  });

  it("widens with a mouse drag, clamps to the maximum, updates canvas variables, and persists", async () => {
    await using _env = await wideViewportWithoutSavedWidth();
    await using screen = await render(<Workspace />, { router: false });
    const handle = screen.getByRole("separator", { name: "Resize thread details" });

    await commands.dragHorizontally(HANDLE, -100);
    await expect.element(handle).toHaveAttribute("aria-valuenow", "380");
    expect(panelWidth(screen)).toBe(380);
    expect(localStorage.getItem(THREAD_DETAILS_CARD_WIDTH_STORAGE_KEY)).toBe("380");
    expect(canvasElement(screen).style.getPropertyValue("--thread-details-panel-width")).toBe(
      "380px",
    );
    expect(
      Number.parseFloat(canvasElement(screen).style.getPropertyValue("--chat-lane-inset-end")),
    ).toBeGreaterThan(0);

    await commands.dragHorizontally(HANDLE, -300);
    await expect.element(handle).toHaveAttribute("aria-valuenow", "480");
    expect(panelWidth(screen)).toBe(480);
    expect(localStorage.getItem(THREAD_DETAILS_CARD_WIDTH_STORAGE_KEY)).toBe("480");
  });

  it("resizes from the keyboard and persists each step", async () => {
    await using _env = await wideViewportWithoutSavedWidth();
    await using screen = await render(<Workspace />, { router: false });
    const handle = screen.getByRole("separator", { name: "Resize thread details" });

    await userEvent.click(screen.getByRole("button", { name: "Chat" }));
    await userEvent.tab();
    await expect.element(handle).toHaveFocus();

    await userEvent.keyboard("{ArrowLeft}");
    await expect.element(handle).toHaveAttribute("aria-valuenow", "296");
    expect(panelWidth(screen)).toBe(296);
    expect(localStorage.getItem(THREAD_DETAILS_CARD_WIDTH_STORAGE_KEY)).toBe("296");

    await userEvent.keyboard("{Shift>}{ArrowLeft}{/Shift}");
    await expect.element(handle).toHaveAttribute("aria-valuenow", "360");
    expect(panelWidth(screen)).toBe(360);

    await userEvent.keyboard("{Home}");
    await expect.element(handle).toHaveAttribute("aria-valuenow", "240");
    await userEvent.keyboard("{ArrowRight}");
    await expect.element(handle).toHaveAttribute("aria-valuenow", "240");

    await userEvent.keyboard("{End}");
    await expect.element(handle).toHaveAttribute("aria-valuenow", "480");
    expect(localStorage.getItem(THREAD_DETAILS_CARD_WIDTH_STORAGE_KEY)).toBe("480");
  });

  it("restores the saved width on remount and clamps temporarily when the canvas narrows", async () => {
    await using _env = await wideViewportWithoutSavedWidth();
    {
      await using screen = await render(<Workspace canvasWidth={1280} />, { router: false });
      await commands.dragHorizontally(HANDLE, -140);
      await expect
        .element(screen.getByRole("separator", { name: "Resize thread details" }))
        .toHaveAttribute("aria-valuenow", "420");
    }

    await using restored = await render(<Workspace canvasWidth={1280} />, { router: false });
    const handle = restored.getByRole("separator", { name: "Resize thread details" });
    await expect.element(handle).toHaveAttribute("aria-valuenow", "420");
    expect(panelWidth(restored)).toBe(420);

    // Narrowing the canvas clamps the inline width to 368px (1100 - 732) without losing 420px.
    await restored.rerender(<Workspace canvasWidth={1100} />);
    await expect.element(handle).toHaveAttribute("aria-valuemax", "368");
    await expect.element(handle).toHaveAttribute("aria-valuenow", "368");
    expect(panelWidth(restored)).toBe(368);

    // Widening back restores the saved 420px width.
    await restored.rerender(<Workspace canvasWidth={1280} />);
    await expect.element(handle).toHaveAttribute("aria-valuenow", "420");
    expect(panelWidth(restored)).toBe(420);
  });
});
