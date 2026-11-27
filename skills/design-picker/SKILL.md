---
name: design-picker
description: Capture the full design language of a reference (screenshot or live URL) and render it inline as an interactive HTML design picker covering color, gradients/effects, typography, components, and motion/transitions/animation. Uses T3 Code's `preview_*` tools to inspect live URLs (visuals and runtime code) and `html_preview` / `html_render` to present the interactive explorer inline in the thread. Use when the user provides a UI screenshot or reference URL and wants to capture, explore, or export a reusable design spec.
---

# Design Picker

Capture the **full design language** of a reference and present it inline as an interactive HTML explorer covering color, **gradients & effects**, typography, components (grouped by category), and **motion / transitions / animation**, then let the user pick tokens, effects, motion presets, and component variants and export a markdown design spec (with codeable easing/keyframes).

A reference is rarely just colors. Modern interfaces are experiences: gradients, grain, WebGL, smooth or virtual scroll, route transitions, persistent audio, custom cursors, hover-reactive backgrounds, and reveal animations. Capture all of it in the first pass.

## Inputs

- **Screenshot(s)** (app, mobile, or web; full screen plus close-up helps).
- **A live URL** (preferred when available). A screenshot is one frozen frame; the experience layer (scroll, transitions, audio, cursor, WebGL, hover reactivity) is invisible in a still. For a URL, drive T3 Code's preview browser to read both visuals and code (step 1B).
- A verbal description also works.

## Workflow

### 1. Capture comprehensively in the first pass

Work through **[references/extraction-rubric.md](references/extraction-rubric.md)** (color, typography, layout) **and** **[references/motion-and-effects.md](references/motion-and-effects.md)** (gradients, effects, motion, architecture). Produce a `theme.json` matching **[references/token-schema.json](references/token-schema.json)**, filling `effects`, `motion`, and `architecture` in addition to `colors`.

Map colors onto semantic **roles** (not raw swatches). Record everything inferred (versus read directly) in `confidence`, especially fonts and motion.

Also fill `detected` using the catalog ids enumerated in **[references/token-schema.json](references/token-schema.json)** (`detected.components`, `.motion`, `.interactions`, `.effects`) so the interactive picker starts the source's observed feature set toggled ON while leaving the rest available to toggle.

#### 1A. From a screenshot

Read the screenshot directly. Derive gradients, glow, and grain from the imagery. Flag inferred motion and font guesses in `confidence`.

#### 1B. From a live URL using T3 `preview_*` tools (required)

Drive T3 Code's shared browser with `preview_*` tools instead of external browser CLIs:

1. Call `preview_status` to check available tabs and whether a tab can be automated.
2. Call `preview_open` with `url: "<reference-url>"` (and `reuseExistingTab: false` when running in parallel).
3. Capture visuals across the page:
   - Call `preview_snapshot` with `includeImage: true` on the hero.
   - Scroll through sections with `preview_act` (`action: "scroll"`, `deltaY: 900`) and take `preview_snapshot` (`includeImage: true`) on key sections.
4. Read the live implementation with `preview_evaluate` using the inspection script in **[references/motion-and-effects.md](references/motion-and-effects.md)** (libraries, scroll model, audio, canvases/WebGL, custom cursor, computed palette, loaded fonts, and framework `data-*` attributes).
5. Close the tab you opened with `t3_preview_close` when inspection is complete (unless the user asked to keep it open).

Identify and record: rendering stack, smooth/virtual scroll, WebGL/canvas, audio libraries, custom cursor, page-transition model, and the real computed palette and fonts. Summarize the findings (palette, typography, key effects, motion model, confidence) for the user before building.

### 2. Build the self-contained interactive picker HTML

Generate a self-contained HTML file (inline `<style>` and `<script>`, no external server required) that implements the captured theme and follows both:

- **[references/catalog.md](references/catalog.md)** (§4 demonstrability rules are mandatory so previews remain legible on dark themes, light themes, `primary ≈ accent`, and `surface ≈ background`).
- T3 inline rendering rules for `html_preview` / `html_render`:
  - Leave `html`, `body`, and the outer wrapper with no fixed page background, no outer card border, and no side padding so the chrome sits cleanly on the thread background.
  - Use fluid widths (works at 728px desktop and ~360px mobile) and let content determine height (never use `vh` units or `height: 100%` on `html`/`body`).
  - Use T3 theme CSS variables (`--background`, `--foreground`, `--muted`, `--card`, `--border`, `--primary`, `--accent`, `--radius`, `--font-sans`, `--font-mono`) for the picker's control chrome, while isolating captured-theme previews inside self-contained demo harness boxes (`padding: 16px`, `border-radius: var(--radius)`).
  - Include live token editors (colors, radius, font), toggle switches for detected/optional components, effects, and motion presets (with Replay controls), and copy/export buttons for CSS variables, Tailwind config, DTCG JSON, and a markdown design spec.

### 3. Preview and render inline in T3 Code

1. Call `html_preview` with the generated HTML file path (or inline HTML) to verify rendering, inspect the returned PNG, check console output for zero errors, and read `contentHeight`.
2. Fix any visual or console issues and re-check with `html_preview` until clean.
3. Call `html_render` with the verified HTML, a clear `title`, and `height` set to `contentHeight` (clamped to 80..2000) so the interactive design picker appears directly inline in the thread. Do not instruct the user to open a local file manually or start a dev server.

## Notes

- For a live URL, always run the T3 `preview_*` pass; a static screenshot misses scroll, hover, transition, audio, and WebGL behavior.
- Never open a local HTTP server just to display the picker; `html_preview` and `html_render` display self-contained HTML directly inside T3 Code.
