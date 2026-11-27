# Motion & effects rubric

The experience layer. A screenshot cannot show motion, scroll physics, audio, or runtime libraries; for a live URL, drive T3 Code's preview browser. Capture all of it in the first pass and write it into `theme.json` under `effects`, `motion`, and `architecture`.

## A. Browser inspection recipe using T3 `preview_*` tools

Use T3 Code's native `preview_*` tools (`preview_status`, `preview_open`, `preview_snapshot`, `preview_act`, `preview_evaluate`, `t3_preview_close`):

1. **Open the page**
   - Call `preview_status` to check existing tabs.
   - Call `preview_open` with `{ "url": "<target-url>" }` (keep the returned `tabId`).
   - If the site uses an intro loader or delayed hydration, call `preview_wait_for` on a visible headline or landmark.
2. **Capture visuals across sections**
   - Hero frame: call `preview_snapshot` with `{ "tabId": "<tabId>", "includeImage": true }`.
   - Scroll sections: call `preview_act` with `{ "tabId": "<tabId>", "action": "scroll", "deltaY": 1000 }`, then call `preview_snapshot` with `{ "tabId": "<tabId>", "includeImage": true }`. Repeat for key sections.
3. **Inspect runtime code, palette, fonts, and effects**
   Call `preview_evaluate` with `{ "tabId": "<tabId>", "expression": "..." }`:

```js
(() => {
  const out = {};
  out.scripts = [...document.querySelectorAll("script[src]")].map((s) => s.src).slice(0, 40);
  const globals = {};
  for (const key of [
    "gsap",
    "ScrollTrigger",
    "Lenis",
    "THREE",
    "Howl",
    "Howler",
    "barba",
    "Highway",
    "taxi",
    "Splitting",
    "SplitType",
    "LocomotiveScroll",
    "PIXI",
    "OGL",
  ]) {
    globals[key] = typeof window[key] !== "undefined";
  }
  out.globals = globals;
  out.canvases = document.querySelectorAll("canvas").length;
  out.audios = [...document.querySelectorAll("audio")].map((a) => ({
    src: a.currentSrc || a.src,
    loop: a.loop,
  }));
  out.cursorEls = [...document.querySelectorAll('[class*="cursor"],[id*="cursor"]')]
    .map((e) => String(e.className || e.id))
    .slice(0, 8);
  const bodyStyle = getComputedStyle(document.body);
  out.bg = {
    body: bodyStyle.backgroundColor,
    color: bodyStyle.color,
    font: bodyStyle.fontFamily,
    overflow: bodyStyle.overflow,
  };
  out.scrollH = document.documentElement.scrollHeight;
  out.innerH = window.innerHeight;
  const attrs = new Set();
  for (const el of document.querySelectorAll("*")) {
    for (const a of el.attributes) {
      if (a.name.startsWith("data-")) attrs.add(a.name);
    }
  }
  out.dataAttrs = [...attrs].slice(0, 40);
  out.fonts = [...document.fonts]
    .map((f) => `${f.family} ${f.weight}`)
    .filter((v, i, a) => a.indexOf(v) === i)
    .slice(0, 12);
  const counts = {};
  for (const el of [...document.querySelectorAll("*")].slice(0, 1500)) {
    const cs = getComputedStyle(el);
    for (const color of [cs.color, cs.backgroundColor, cs.borderTopColor]) {
      if (color && color !== "rgba(0, 0, 0, 0)") counts[color] = (counts[color] || 0) + 1;
    }
  }
  out.topColors = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12);
  return out;
})();
```

4. **Clean up**
   - Call `t3_preview_close` with `{ "tabId": "<tabId>" }` once inspection is done (unless the user asked to keep the tab open).

**Reading the output:**

- `data-v-*` plus a Vite entry bundle indicates a Vue SPA (React/Svelte have analogous markers); SPA routing implies client-side route transitions without full reloads.
- `Howl` / `Howler` true indicates persistent audio across navigation.
- `body{overflow:hidden}` plus `scrollH ≈ innerH` indicates virtual/WebGL scroll driven by wheel events.
- `<canvas>` count plus `data-webgl-*` indicates WebGL background or interactive shaders.
- Cursor class names indicate a lerped custom cursor with hover states.
- `topColors` and `fonts` give ground-truth computed values rather than visual guesses.

## B. Effects checklist (`theme.json.effects`)

- **gradients**: name + CSS value (ambient backdrop/vignette, hero glow, hover sheen, mesh/aurora).
- **grain / noise**: opacity + blend mode (often `overlay` at 0.03-0.06), static or drifting.
- **glow**: colored box-shadow / radial bloom on focal elements.
- **glass**: backdrop-blur + translucent surface (nav bars, overlays).
- **blend modes**: `mix-blend-mode: difference/exclusion` (cursors, headings over media).
- **WebGL ambience**: particle/fluid dissolves, hover displacement, shader backgrounds (record under `architecture`).

## C. Motion checklist (`theme.json.motion`)

- **easings**: name -> `cubic-bezier(...)`. Defaults: out-expo `(0.16,1,0.3,1)`, in-out-quart `(0.76,0,0.24,1)`, out-soft `(0.33,1,0.68,1)`.
- **durations**: instant ~120ms, fast ~240ms, base ~480ms, slow ~800ms, cinematic ~1200ms.
- **scroll model**: `native`, `smooth` (inertia/Lenis), or `virtual` (WebGL), with lerp factor if smoothed.
- **presets**: codeable units with `id`, `name`, `trigger`, and CSS/JS notes (`reveal-up`, `mask-line`, `scrub-text`, `parallax`, `pin`, `page-cover`, `shared-element`, `hover-scale`, `magnetic`, `underline-wipe`, `cursor-follow`, `marquee`, `count-up`).
- **page-transition model**: cover wipe, cross-fade, shared-element, or FLIP (note scroll reset).
- **reduced-motion**: always specify `prefers-reduced-motion` fallback (instant opacity, no transforms, native scroll, no WebGL/custom cursor).

## D. Architecture (`theme.json.architecture`)

Short build notes a developer needs: `stack`, `scroll`, `webgl`, `audio`, `cursor`, `transitions`, and `libraries`.
