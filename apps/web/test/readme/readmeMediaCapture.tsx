import type { ReactNode } from "react";
import { commands } from "vite-plus/test/browser";

declare module "vite-plus/test/browser" {
  interface BrowserCommands {
    /** Defined in vite.config.ts. Saves `<name>.png` of the element under T3CODE_README_MEDIA_DIR. */
    captureMedia: (name: string, selector: string) => Promise<void>;
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

export async function captureMedia(name: string, frame = name): Promise<void> {
  document.documentElement.classList.add("dark");
  // Let layout, fonts, and the first paint after a state change settle.
  await document.fonts.ready;
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  await commands.captureMedia(name, `[data-media="${frame}"]`);
}
