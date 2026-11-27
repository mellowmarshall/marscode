# Catalog & demonstrability

Master catalog for the interactive design picker plus the mandatory demonstrability rules so every preview remains legible on any captured theme.

## 1. Components

Groupings:

- **Actions**: `button`, `button-group`, `split-button`, `icon-button`.
- **Forms**: `input`, `search`, `input-group`, `textarea`, `select`, `checkbox`, `radio`, `toggle`, `range`, `file-upload`.
- **Data display**: `table`, `desc-list`, `list-feed`, `stat`, `timeline`.
- **Navigation**: `navbar`, `sidebar`, `tabs`, `breadcrumb`, `pagination`, `steps`, `command`.
- **Overlays**: `modal`, `drawer`, `dropdown`, `popover`, `tooltip`, `toast`.
- **Feedback & status**: `alert`, `banner`, `badge`, `chip`, `progress`, `spinner`, `skeleton`, `empty-state`.
- **Content & media**: `card`, `accordion`, `avatar`, `divider`, `kbd`.

Expose key interactive states (`default`, `hover`, `focus`, `disabled`, `loading`, `error`) rather than static happy-path stubs.

## 2. Patterns

Composite sections that can be demonstrated in the captured theme:

- Marketing: hero, feature grid, stats band, pricing tiers, FAQ accordion, CTA band, footer.
- App: dashboard stat row + table, sectioned settings form, master-detail split, auth card, command palette.
- States: skeleton loading, empty state, error state.

## 3. Experience layer

- **Atmosphere effects**: `aurora`, `vignette`, `glow`, `grain`, `glass`, `shadow` (sm-xl ramp), `duotone`, `blend`.
- **Motion presets**: `reveal-up`, `mask-line`, `fade`, `parallax`, `hover-scale`, `underline-wipe`, `magnetic`, `count-up`, `marquee`, `page-cover`. Each exported recipe must include a `prefers-reduced-motion` fallback.
- **Interactions**: `scroll-reveal`, `scroll-scrub`, `cursor`, `tilt`, `shader`, `loader`, `kinetic`, `ambient`.

## 4. Demonstrability rules (mandatory)

### 4.1 Self-contained demo harnesses

- Render each preview inside a harness box with its own backdrop rather than the raw thread background.
- For media-dependent effects (`blend`, `glass`, `parallax`, `duotone`, scrims), inject a generated gradient/duotone sample media band so the effect has content behind it.
- For contrast-sensitive effects (`grain`, `shadow`, `vignette`), show side-by-side light and dark chips so the effect reads on any theme.

### 4.2 Source-adaptive presentation

Detect and adapt automatically (flagging adjustments in `confidence`):

- **Dark theme**: boost shadow alpha (1.5x-2x) and floor grain opacity at >= 0.18 in previews.
- **Light theme**: use low-alpha neutral shadows and `multiply`/`soft-light` grain.
- **`surface ≈ background`**: add a hairline border so cards separate cleanly.
- **`primary ≈ accent`**: nudge the secondary hue in multi-stop aurora/duotone demos and switch duplicate primary/accent form axes to state axes.

### 4.3 Realistic content & clear feedback

- Use realistic labels, names, badges, and dates instead of placeholder text.
- Behavioral components (tooltip, popover, dropdown, accordion, toast) must open on interaction or replay cleanly.
- Briefly highlight affected preview tiles when tokens or toggles change, and keep one control surface per state.
