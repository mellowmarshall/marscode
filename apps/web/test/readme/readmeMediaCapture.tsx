import type { ReactNode } from "react";
import { commands } from "vite-plus/test/browser";

declare module "vite-plus/test/browser" {
  interface BrowserCommands {
    /** Defined in vite.config.ts. Saves `<name>.png` of the element under T3CODE_README_MEDIA_DIR. */
    captureMedia: (
      name: string,
      selector: string,
      animations?: "disabled" | "allow",
    ) => Promise<void>;
  }
}

/** The element a capture crops to: one README image, on the app's dark theme. */
export function MediaFrame({
  name,
  width,
  minHeight,
  children,
}: {
  readonly name: string;
  readonly width: number;
  /** GIF frames must share one size, so animated captures pin their height. */
  readonly minHeight?: number;
  readonly children: ReactNode;
}) {
  return (
    <div
      data-media={name}
      data-fd="root"
      className="dark bg-background p-4 text-foreground"
      style={{ width: `${width}px`, minHeight }}
    >
      {children}
    </div>
  );
}

export async function captureMedia(
  name: string,
  frame = name,
  animations: "disabled" | "allow" = "disabled",
): Promise<void> {
  document.documentElement.classList.add("dark");
  // Let layout, fonts, and the first paint after a state change settle.
  await document.fonts.ready;
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  await commands.captureMedia(name, `[data-media="${frame}"]`, animations);
}

/**
 * Holds every CSS animation under `root` at `seconds` into its cycle, so a GIF frame shows one
 * exact phase of a real animation (captured with `animations: "allow"`).
 */
export function holdAnimationsAt(root: Element, seconds: number): void {
  for (const animation of root.getAnimations({ subtree: true })) {
    animation.pause();
    animation.currentTime = seconds * 1000;
  }
}
