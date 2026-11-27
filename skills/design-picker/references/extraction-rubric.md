# Extraction rubric

Work through every section to produce a complete token set matching `token-schema.json`. For anything inferred rather than read directly from computed styles or pixels, record it in `confidence`.

## 0. Setup

- If given **multiple screenshots** (full screen + close-up), cross-reference them: close-ups give accurate radius, border, and shadow; full screens give layout and palette.
- Note whether the capture is **light** or **dark** mode and set `mode`.
- For **mobile** screenshots (@2x/@3x), report type sizes in logical px (divide raster px by density) and note the density in `confidence`.

## 1. Color roles (not raw swatches)

Map sampled colors onto semantic roles (sample multiple points to avoid anti-aliasing noise):

- `primary`: dominant brand / primary CTA color.
- `accent`: distinct secondary color (if monochromatic, set equal to `primary` and note it).
- `neutral`: gray used for secondary buttons and chrome.
- `success` / `warning` / `danger`: read from badges or alerts if present; otherwise infer harmonious values and flag in `confidence`.
- `surface` vs `background`: cards/panels are typically one step off the page background; capture both even when subtle.
- `border`, `text`, `muted`: hairlines plus primary and secondary text tones.

## 2. Radius

Read corner radius on buttons and cards. If they differ, report button radius as base and note card radius in `confidence`. Express as a CSS length.

## 3. Typography

- `fontFamily.sans`: from `document.fonts` on live URLs, or best-guess stack from screenshots (always flag screenshot font guesses in `confidence`).
- `fontFamily.display`: distinct heading/display stack if present.
- `fontFamily.mono`: if code or tabular numerals appear.
- `typeScale`: distinct text styles from largest to smallest (`name`, `size`, `weight`, `lineHeight`, `tracking`).

## 4. Spacing & density

- Estimate the base unit (commonly `4px` or `8px`) from gaps and padding.
- Set `density` to `compact`, `comfortable`, or `spacious`.

## 5. Elevation

- Capture shadows on cards, dropdowns, and modals as CSS `box-shadow`. Note when dark UIs rely on hairline borders instead of drop shadows.

## 6. Sanity pass

- Verify contrast between `text` and `background` / `surface`.
- Verify every inferred token is recorded in `confidence`.
