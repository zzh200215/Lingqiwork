# Skin Center — per-region theming: token models, translucency, gallery UX, image derivation

Research report for a real implementation decision. Every claim carries a URL. Anything I could not verify is marked **UNVERIFIED** and listed again in §F.

Target UI (the "7 regions"): global background, left sidebar, top bar/toolbar, main workspace, cards/panels, inputs/composer, modals/popovers. Existing skin model: 11-step neutral scale, 11-step accent scale, page background colour, chart palette, optional background image + dimming layer. Stack: React + Tailwind, CSS variables on `<html>` + a `dark` class.

> Note on method: this workspace's `github.com` / `raw.githubusercontent.com` is hosts-hijacked (see the pre-existing `theme-system-research.md` §0), so GitHub sources were read through the jsDelivr CDN (`cdn.jsdelivr.net/gh/<owner>/<repo>@<branch>/<path>`) and Microsoft/Google/W3C/Apple docs were fetched directly. Where a source is fetched from a CDN rather than `github.com`, both the canonical and the fetch URL are given.

---

## (a) Sources examined

| # | Source | URL | What it evidenced |
|---|---|---|---|
| 1 | VS Code Theme Color reference | https://code.visualstudio.com/api/references/theme-color | The documented colour-key list; alpha notation `#RRGGBBAA`; `contrastActiveBorder`/`contrastBorder`; "Some colors should not be opaque"; the `surface.*` / `modern*` region keys |
| 2 | VS Code colour-theme guide | https://code.visualstudio.com/api/extension-guides/color-theme | Theme JSON shape (`type`/`colors`/`tokenColors`), `tokenColors: "./Diner.tmTheme"`, the `-color-theme.json` suffix tip, "Arrow up and down to see a live preview" |
| 3 | VS Code themes doc | https://code.visualstudio.com/docs/configure/themes | "Use the Up and Down keys to navigate through the list and preview the colors of the theme"; `Browse Additional Color Themes...`; theme sharing via `https://vscode.dev/editor/theme/<extensionId>`; `workbench.colorCustomizations` usage |
| 4 | VS Code colour registry source | https://github.com/microsoft/vscode/blob/main/src/vs/workbench/common/theme.ts · fetched via `https://cdn.jsdelivr.net/gh/microsoft/vscode@main/src/vs/workbench/common/theme.ts` | Region-prefixed key names (`sideBar.*`, `titleBar.*`, `panel.*`, `statusBar.*`, `activityBar.*`, `surface.*`, `modernUI.*`, …) |
| 5 | VS Code platform colour registries | https://github.com/microsoft/vscode/tree/main/src/vs/platform/theme/common/colors · fetched `baseColors.ts`, `inputColors.ts`, `listColors.ts`, `editorColors.ts`, `menuColors.ts`, `miscColors.ts`, `chartsColors.ts` | `input.*`, `dropdown.*`, `list.*`, `menu.*`, `widget.*`, `charts.*`, `focusBorder`, `selection.background` |
| 6 | VS Code built-in theme file | https://github.com/microsoft/vscode/blob/main/extensions/theme-defaults/themes/dark_modern.json (via jsDelivr) | A shipped theme with **`colors` only and no `tokenColors`** → colours-only theme is valid |
| 7 | VS Code `theme-defaults` manifest | https://github.com/microsoft/vscode/blob/main/extensions/theme-defaults/package.json (via jsDelivr) | `contributes.themes[]` entry shape: `id`, `label`, `uiTheme` (`vs`/`vs-dark`/`hc-black`/`hc-light`), `path`; **10** built-in colour themes |
| 8 | Windows Terminal colour schemes | https://learn.microsoft.com/en-us/windows/terminal/customize-settings/color-schemes | Complete scheme JSON; "Every setting, aside from `name`, accepts a color"; `cursorColor`/`selectionBackground` optional; 7 built-in schemes |
| 9 | Obsidian community theme index | https://github.com/obsidianmd/obsidian-releases/blob/master/community-css-themes.json (via jsDelivr) | Real gallery index fields: `name`, `author`, `repo`, `screenshot`, `modes` |
| 10 | Style Settings plugin README | https://github.com/mgmeyers/obsidian-style-settings (via `ghfast.top` proxy of `raw.githubusercontent.com`) | The `/* @settings */` YAML-in-CSS mechanism; required `name`/`id`/`settings`; setting types `heading`, `info-text`, `class-toggle`, `variable-text`, `variable-color` |
| 11 | Obsidian theme (Minimal) stylesheet | https://github.com/kepano/obsidian-minimal/blob/master/obsidian.css (via jsDelivr) | The **real** Obsidian CSS-variable contract in use: `--background-primary/secondary/tertiary`, `--background-modifier-*`, `--interactive-*`, `--text-*`, `--modal-border` |
| 12 | Material Web system colour tokens | https://github.com/material-components/material-web/blob/main/tokens/_md-sys-color.scss (via jsDelivr) | The authoritative M3 role list (`$supported-tokens`, 50 names) and the `var(--md-sys-color-<token>, <fallback>)` emission pattern |
| 13 | Material Color Utilities — `DynamicScheme` | https://github.com/material-foundation/material-color-utilities/blob/main/dart/lib/dynamiccolor/dynamic_scheme.dart (via jsDelivr) | Scheme fields; `errorPalette` default `TonalPalette.of(25.0, 84.0)`; `contrastLevel` −1…1 |
| 14 | Material Color Utilities — scheme variants | `…/dart/lib/scheme/scheme_tonal_spot.dart`, `scheme_vibrant.dart`, `scheme_expressive.dart`, `scheme_content.dart`, `scheme_fidelity.dart`, `scheme_neutral.dart`, `scheme_monochrome.dart`, `scheme_rainbow.dart`, `scheme_fruit_salad.dart` (via jsDelivr) | The **chroma constants** per variant (the numbers requested) |
| 15 | Material Color Utilities — `MaterialDynamicColors` | `…/dart/lib/dynamiccolor/material_dynamic_colors.dart` (via jsDelivr) | The **tone values** for every surface role, light and dark; `scrim` tone 0 |
| 16 | Material Color Utilities — `ContrastCurve` | `…/dart/lib/dynamiccolor/src/contrast_curve.dart` (via jsDelivr) | Curves are 4 numbers for contrast levels −1, 0, 0.5, 1 and are lerped |
| 17 | Material Color Utilities — `Score` | `…/dart/lib/score/score.dart` (via jsDelivr) | `_targetChroma = 48.0`, `_cutoffChroma = 5.0`, `_cutoffExcitedProportion = 0.01`, `desired = 4` |
| 18 | Material Color Utilities — `QuantizerCelebi` | `…/dart/lib/quantize/quantizer_celebi.dart` (via jsDelivr) | Wallpaper→colour quantisation is Wu + WSMeans (Celebi) |
| 19 | Radix Colors — Understanding the scale | https://www.radix-ui.com/colors/docs/palette-composition/understanding-the-scale | The 12-step use-case table, verbatim; the APCA guarantee for steps 11/12 |
| 20 | shadcn/ui theming | https://ui.shadcn.com/docs/theming | Base colours list; token convention |
| 21 | shadcn/ui `globals.css` | https://github.com/shadcn-ui/ui/blob/main/apps/v4/app/globals.css (via jsDelivr) | The **`--sidebar-*` per-region group** (8 tokens) and the `--chart-1..5` group; `@theme inline` mapping |
| 22 | GitHub Primer colour foundations | https://primer.style/foundations/primitives/color | 235 distinct `--*` tokens incl. `--overlay-bgColor`, `--overlay-backdrop-bgColor`, `--overlay-borderColor`, `--bgColor-inset`, `--borderColor-translucent`, `--focus-outlineColor` |
| 23 | Tailwind CSS theme variables | https://tailwindcss.com/docs/theme | The `--*` theme namespaces (`--color-*`, `--radius-*`, `--shadow-*`, `--blur-*`, …) |
| 24 | Filter Effects Module Level 2 | https://drafts.csswg.org/filter-effects-2/ | Normative Backdrop Root definition + triggers; the opacity/filter/mask "applied twice" rationale; "creation of both a stacking context and a Containing Block for absolute and fixed position descendants" |
| 25 | MDN `backdrop-filter` | https://developer.mozilla.org/en-US/docs/Web/CSS/backdrop-filter | The backdrop-root list as a practical gotcha ("a common source of confusion"); rendered compat summary Chrome 76+ / Edge 79+ / Firefox 103+ / Safari listed as "None" |
| 26 | Fluent 2 — Acrylic | https://learn.microsoft.com/en-us/windows/apps/design/style/acrylic | Do/Don't list verbatim; "The acrylic recipe: background, blur, exclusion blend, color/tint overlay, noise"; contrast warning about accent text/hyperlinks |
| 27 | Fluent 2 — Mica | https://learn.microsoft.com/en-us/windows/apps/design/style/mica | "Mica is an **opaque**, dynamic material"; the content layer uses "`LayerFillColorDefaultBrush`, a **low-opacity solid color**"; the solid-fallback trigger list |
| 28 | WCAG 2.2 SC 1.4.3 Understanding | https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html | 4.5:1 / 3:1 thresholds; points to F83 |
| 29 | WCAG 2.2 Technique F83 | https://www.w3.org/WAI/WCAG22/Techniques/failures/F83 | The text-over-image rule and its Quickcheck test procedure |
| 30 | Windows 11 / prior workspace research | [theme-system-research.md](theme-system-research.md) §追加三, §追加二 | Already-verified in-workspace findings: measured shell opacities `bg-white/70` (sidebar) and `bg-white/85` (header); the 80%→45% dim recalculation; image-derivation precedents (color-thief, node-vibrant, MCU, matugen, Warp, macOS, Windows 11, Tabliss) |

**Fetched but not usable (recorded so the gap is explicit):**

| Source | URL | Outcome |
|---|---|---|
| Apple HIG — Materials | https://developer.apple.com/design/human-interface-guidelines/materials | HTTP 200 but fully client-rendered; body text is empty. The JSON mirror `…/tutorials/data/documentation/design/human-interface-guidelines/materials.json` returned 404. **Material thickness vocabulary UNVERIFIED** |
| Chrome extension themes manifest | https://developer.chrome.com/docs/extensions/develop/ui/themes and `…/reference/manifest/theme` | Connection failed / blocked from this host (`000`). **Chrome theme key names UNVERIFIED** |
| Carbon colour tokens | https://carbondesignsystem.com/elements/color/tokens/ | Page is client-rendered; `@carbon/themes` scss paths on jsDelivr 404. Only `@carbon/styles/scss/_theme.scss` resolved, which yielded `custom-property.declaration('icon-primary', …)`-style usages — **not** a clean token list. **Carbon `layer-01`/`field-01` names UNVERIFIED** |
| Fluent UI semantic tokens | `packages/tokens/src/global/colors.ts` (via jsDelivr) | File exists but contains only the raw `grey` hex ramp (2…98) and alpha colours. `colorNeutralBackground1`-style names **UNVERIFIED** |
| terminal.sexy | https://terminal.sexy/ | Client-rendered; returns only the page title. **UNVERIFIED** |
| Gogh | https://gogh-co.github.io/Gogh/ and the repo README via jsDelivr | jsDelivr returned a redirect for the guessed ref; page not read. **UNVERIFIED** |
| caniuse `css-backdrop-filter` | https://caniuse.com/css-backdrop-filter | HTTP 406 (blocks non-browser clients). Used MDN's rendered compat summary instead |
| Telegram theme API | https://core.telegram.org/api/themes | Connection blocked (`000`) from this host. **UNVERIFIED** |

---

## (b) Recommended token list for a 7-region workbench

### b.1 What the precedents actually agree on

Four different models exist. Reading them together gives the design:

1. **Flat, region-prefixed keys** (VS Code). Every surface is `<region>.<property>`, with `<region>.background`, `<region>.foreground`, `<region>.border` as the near-universal triplet, and state variants appended (`list.hoverBackground`, `list.activeSelectionBackground`, `list.inactiveSelectionBackground`, `menu.selectionBackground`, `input.placeholderForeground`). I extracted **425 distinct `registerColor('…')` keys** from the registry sources. Granularity is extreme: `input.*` alone is 17 keys; `list.*` is 28.
2. **One overridable region group** (shadcn/ui). Out of all regions, shadcn ships exactly **one** per-region token group — the sidebar:
   `--sidebar`, `--sidebar-foreground`, `--sidebar-primary`, `--sidebar-primary-foreground`, `--sidebar-accent`, `--sidebar-accent-foreground`, `--sidebar-border`, `--sidebar-ring`. Everything else is one global set (`--background`, `--card`, `--popover`, `--input`, `--border`, `--ring`, `--muted`, `--accent`) plus `--chart-1…5`. This is the strongest evidence that **one region needing its own tokens is the normal case, and seven is the extreme**.
3. **Layered surfaces, not named regions** (Obsidian). `--background-primary` / `--background-secondary` / `--background-tertiary` are *depth layers*, with `--background-modifier-*` for borders/overlays/form fields and `--interactive-normal|hover|accent` for states. A region is expressed by pointing at a layer, not by having its own name.
4. **Named elevation containers** (Material 3). `surface`, `surface-dim`, `surface-bright`, `surface-container-lowest/low/(base)/high/highest`, `surface-variant`, `outline`, `outline-variant`, `scrim`. Surfaces are a *named ramp* (tone 100 → 4 in light mode), and elevation is "go down the ramp".
5. **Step indices with baked-in state** (Radix). A region needs only an index: step 1/2 = app background, 3/4/5 = component bg normal/hover/active, 6/7/8 = borders (subtle / interactive / strong+focus ring), 9/10 = solid accent + its hover, 11/12 = low/high-contrast text.

**The synthesis:** give each region a *small fixed block* (VS Code / shadcn shape), make the values **default to points on the existing 11-step neutral scale** (Radix / Material shape) rather than new raw colours, and keep **state** in the shared scale instead of duplicating it per region. That way a minimal skin writes nothing at all, and a maximal skin can address every region.

### b.2 The token list

Seven region blocks × 5 slots = 35 tokens, plus shared groups. Grouped, with justification and precedent.

#### Group 1 — Region surfaces (the core addition)

For `R` ∈ `{bg, sidebar, header, workspace, card, input, overlay}`:

| Token | Meaning | Why it exists | Precedent |
|---|---|---|---|
| `--r-<R>-surface` | base fill | every product's `<region>.background` | `sideBar.background`, `editorWidget.background`, `dropdown.background`, `--sidebar` |
| `--r-<R>-alpha` | 0–1 opacity of that fill | VS Code only has this implicitly via 8-digit hex; a separate number is what makes "translucent or not" a *decision* rather than an accident | VS Code `#RRGGBBAA`; `--overlay-backdrop-bgColor` |
| `--r-<R>-blur` | px `backdrop-filter` radius, `0` = none | the one property that has a hard correctness rule (see §c.1) | Fluent acrylic's blur layer; Mica's "low-opacity solid" content layer |
| `--r-<R>-border` | border colour | `<region>.border` is the second-most universal key | `panel.border`, `sideBar.border`, `menu.border`, `input.border`, `--sidebar-border`, `--borderColor-default` |
| `--r-<R>-shadow` | shadow colour/strength | `<region>.shadow` exists for exactly the floating regions | `widget.shadow`, `listFilterWidget.shadow`, `--background-modifier-box-shadow` |

Region-by-region notes:

- **`bg` (global background)** — usually the wallpaper itself plus the scrim; `--r-bg-blur: 0` and `--r-bg-alpha` is the *dim*, not a fill alpha.
- **`sidebar`** — the one region real products most often give a separate identity: shadcn ships 8 `--sidebar-*` tokens; Obsidian themes universally re-point `--background-secondary` for it; Radix names "Sidebar background" explicitly under step 1/2.
- **`header`** — VS Code gives `titleBar.*` five keys (active/inactive × foreground/background + border). Keep `-alpha`/`-blur` here; this is a legitimate glass surface (§c.2).
- **`workspace`** — the canvas *behind* the cards. In Material terms this is `surface-dim`, i.e. *darker than the cards* (light mode tone 87 vs cards at 98/96/94).
- **`card`** — must be opaque (§c.2). In Material terms `surface-container-low…highest`; in Carbon terms `layer-01/02/03`.
- **`input`** — VS Code's `input.*` (17 keys) and shadcn's `--input` both treat inputs as a first-class surface. Composer belongs here.
- **`overlay`** — modals + popovers + dropdowns. VS Code has `editorWidget.*`, `menu.*`, `dropdown.*`, `listFilterWidget.*`; Obsidian has `--modal-border`; Primer has an entire `--overlay-*` family.

#### Group 2 — Elevation / separation inside a region

Do **not** invent a new ramp. Bind to the existing 11-step neutral scale, and say which step each region sits on. This is the Material/Radix move and it is what keeps a 35-token model from becoming 35 arbitrary colours.

- `--r-card-surface: var(--neutral-2)` (light) / `var(--neutral-9)` (dark) — Material's spread between `surface` (98) and `surface-container-highest` (90) is **8 tone steps in light mode, 16 in dark (6→22)**; 11 steps of your scale maps onto that comfortably.
- Provide a `--r-<R>-border` default of one step off the surface, matching Radix's guarantee that step 6 is "subtle borders on components which are not interactive. For example sidebars, headers, cards, alerts, and separators" — literally the client's region list.

#### Group 3 — Text / foreground (shared, not per-region)

| Token | Precedent |
|---|---|
| `--fg-default` | `foreground`, `--fgColor-default`, `--text-normal`, Radix step 12 |
| `--fg-muted` | `descriptionForeground`, `--fgColor-muted`, `--text-muted`, Radix step 11 |
| `--fg-subtle` | `disabledForeground`, `--fgColor-disabled`, `--text-faint` |
| `--fg-on-accent` | `button.foreground`, `--fgColor-onEmphasis`, `--text-on-accent`, `onPrimary` |

Radix's published guarantee is the useful part: *"Steps 11 and 12 — which are designed for text — are guaranteed to Lc 60 and Lc 90 APCA contrast ratio on top of a step 2 background from the same scale."* If your neutral scale is Radix-shaped, text contrast is a property of the scale, not of each skin.

#### Group 4 — Accent + focus (shared)

`--accent`, `--accent-fg`, `--ring`/`--focus-border`, `--accent-hover`.
Precedent: VS Code `focusBorder` + `button.background/foreground`; Radix step 9/10 for solid + hover and step 8 for focus rings; shadcn `--primary`/`--ring`/`--sidebar-ring`; Primer `--focus-outlineColor`.

Keep `--accent` **per-region-overridable only if you must** — shadcn's `--sidebar-primary` shows the pattern, but note it also means every accent-consuming component needs a region-aware variant. For a first version: one accent, plus a sidebar override slot.

#### Group 5 — Effects / scrim (global)

| Token | Precedent |
|---|---|
| `--scrim` | M3 `scrim` role, **tone 0 in both light and dark**; Primer `--overlay-backdrop-bgColor`; Obsidian `--background-modifier-cover` |
| `--scrim-opacity` | the derived dim (§d) — the value the prior report measured at 45–62% |
| `--shadow-color` / `--shadow-strength` | `widget.shadow`, `listFilterWidget.shadow` are shadow *colours*, i.e. products keep shadow as a token, not a hardcoded rgba |
| `--border-strength` | lets a skin make all borders hairline or heavy in one place |
| `--noise` (optional) | Fluent's acrylic recipe includes a noise layer; omit unless you actually want the texture |

#### Group 6 — Chart palette (already present)

Keep `--chart-1…N`. Precedent: shadcn `--chart-1..5`; VS Code `charts.foreground`, `charts.lines`, `charts.red/green/blue/yellow/orange/purple` (8 keys — note VS Code fixes the *names* to hues, shadcn fixes them to *indices*; the index form is the better fit for a themable palette).

### b.3 What real products treat as mandatory

The honest answer: **almost nothing is mandatory except identity.**

| Product | Required | Optional / defaulted |
|---|---|---|
| Windows Terminal scheme | `name` | everything else; `cursorColor` and `selectionBackground` explicitly optional. *"Every setting, aside from `name`, accepts a color as a string in hex format"* |
| VS Code theme extension | at contribution-point level `id`, `label`, `uiTheme`, `path` | the colour file itself may be colours-only — the shipped `dark_modern.json` has **127 colour keys and no `tokenColors` at all** |
| VS Code theme file | `type` + `colors` in the examples | `tokenColors` may be a path to a `.tmTheme` |
| Obsidian `@settings` block | `name`, `id`, `settings` | individual settings each carry their own `default` |
| shadcn registry theme | `cssVars` object | merged into the project's existing variables rather than replacing them |
| Radix Colors | n/a — all 12 steps × all accents shipped | nothing is optional because nothing is authored by the user |

**Therefore:** require `{ id, label, base: light|dark, mode }` on a skin, and make **every** colour token optional with a documented derivation order. This exactly matches the already-adopted rule in this workspace's prior research (*"清单允许写一半，其余按明确的优先级推导"*, [theme-system-research.md](theme-system-research.md) §追加).

### b.4 Naming

Two viable schemes, both with precedent:

- **VS Code style, `region.property`**: `sidebar.surface`, `sidebar.alpha`, `header.blur`, `modal.shadow`. Scales to 400 keys; greppable; matches an existing mental model for anyone who has written a VS Code theme.
- **CSS-variable style, `--r-<region>-<slot>`**: what shadcn (`--sidebar-border`), Primer (`--overlay-bgColor`) and Obsidian (`--background-modifier-border`) all do.

Do not mix them. Pick the CSS-variable spacing and document the manifest field as the same string minus `--`.

---

## (c) Translucency and glass: numbers, rules, failure modes

### c.1 The hard technical constraint (this one is a real bug generator)

The Filter Effects Level 2 spec is unambiguous, and it collides directly with a "background image + dimming layer" implementation:

> "The effect of the backdrop-filter will not be visible unless some portion of element B is semi-transparent. Also note that any opacity applied to element B will be applied to the filtered backdrop image as well."

> "A computed value of other than none results in the creation of both a **stacking context** and a **Containing Block** for absolute and fixed position descendants, unless the element it applies to is a document root element."

And the Backdrop Root triggers, verbatim from the spec:

> - The root element of the document (HTML).
> - An element with a `filter` property other than "none".
> - An element with an `opacity` value less than 1.
> - An element with `mask`, `mask-image`, `mask-border`, or `clip-path` properties with values other than "none".
> - An element with a `backdrop-filter` value other than "none".
> - An element with a `mix-blend-mode` value other than "normal".
> - An element with a `will-change` value specifying any property that would create a Backdrop Root on non-initial value.

The consequence, spelled out in the rationale:

> "Because the opacity applies to the element and all children, rendered together, the opacity value would be 'applied twice' if the Backdrop Root Image were to read back content above the semi-transparent element. Effectively, the backdrop-filtered portion of the backdrop would be rendered with (Opacity)²."

MDN states the practical symptom:

> "This means that if a parent element has `opacity: 0.9`, it becomes a backdrop root and any child's `backdrop-filter` will only blur the content between that parent and the child — not the content behind the parent. This is a common source of confusion when `backdrop-filter` appears to have no visible effect despite being correctly applied."

**Concrete consequences for this app:**

1. If the **dimming layer** is an ancestor with `opacity: 0.55`, every descendant `backdrop-filter` is neutered — it will blur only within the dim layer, not the wallpaper. Implement the dim as a **painted, opaque-coloured overlay** (`background-color: rgb(0 0 0 / 55%)`) that is a *sibling* of the wallpaper, not an `opacity` on a wrapper.
2. Never put `will-change` on any ancestor of a blurred panel. The spec is explicit that `will-change` **creates the backdrop root immediately**, "to avoid changing it (and therefore changing the rendered appearance) during animation".
3. Never nest blurred panels. Spec: *"Each nesting level will double the number of these required re-paint cycles, leading to significant performance problems."*
4. A blurred element becomes a containing block for `position: fixed` descendants — so a blurred *sidebar* will break any fixed-position modal or tooltip nested inside it. Render modals in a portal outside the blurred subtree.
5. Prefix it. MDN's rendered compatibility summary lists **Chrome 76+, Edge 79+, Firefox 103+**, with **Safari listed as "None"** in that table (the prefixed `-webkit-backdrop-filter` is the Safari path). **Caveat: this is the summary as rendered at fetch time and I could not read caniuse (HTTP 406) to cross-check; re-verify Safari's current unprefixed status before shipping.** Ship `-webkit-backdrop-filter` regardless.

### c.2 Which surfaces may be translucent — the decision rule

Fluent 2's published Do/Don't list is the closest thing to an official rule set, and it maps onto this UI almost verbatim:

> "**Do** use acrylic on transient surfaces.
> **Do** extend acrylic to at least one edge of your app to provide a seamless experience…
> **Don't** put desktop acrylic on large background surfaces of your app.
> **Don't** place multiple acrylic panes next to each other because this results in an undesirable visible seam.
> **Don't** place accent-colored text over acrylic surfaces."

Plus, from the same page: *"If you are using in-app acrylic on navigation surfaces, consider extending content beneath the acrylic pane to improve the flow in your app… However, to avoid creating a striping effect, try not to place multiple pieces of acrylic edge-to-edge"*, and *"For vertical panes or surfaces that help section off content of your app, we recommend you use an opaque background instead of acrylic."*

Mica makes the same split at the window level: Mica is *"an **opaque**, dynamic material"* used only for *"the backdrop of your application — behind all other content"*, and the content layer above it must use *"`LayerFillColorDefaultBrush`, a **low-opacity solid color**"* — i.e. **the layer you read on is not blurred, it is a translucent solid.**

**Recommended rule for the 7 regions:**

| Region | May be translucent? | May blur? | Rule |
|---|---|---|---|
| global background | n/a (it *is* the image) | no | wallpaper + paintable scrim only |
| sidebar | **yes** | **yes, low radius** | navigation surface; Fluent explicitly endorses acrylic on navigation surfaces; keep it to one pane, extended to the window edge |
| header/toolbar | **yes** | **yes, low radius** | same reasoning; VS Code gives `titleBar.*` its own group, and it is thin and text-light |
| main workspace | **no** | **no** | "large background surface" — Fluent's explicit Don't |
| cards/panels | **no** — solid, may be *slightly* translucent over the workspace, never over the raw image | **no** | Mica's content layer is a low-opacity **solid**; Radix/Material both make cards an opaque step |
| inputs/composer | **no** | **no** | sustained text entry + caret legibility; no product in the survey blurs an input |
| modals/popovers | **yes** | **yes** | the canonical "transient surface"; VS Code's `editorWidget`/`menu`/`dropdown` are their own opaque groups, but the glass treatment is legitimate here because attention is on the overlay |

One more Fluent warning that applies to the composer and any accent-coloured UI:

> "We don't recommend placing accent-colored text on your acrylic surfaces because these combinations are likely to not pass minimum contrast ratio requirements at the default 14px font size. Try to avoid placing hyperlinks over acrylic elements."

### c.3 Concrete numbers

**What I could verify as published numbers:**

- **Material 3 separation between surfaces** (from `material_dynamic_colors.dart`, light mode): `surface` = tone **98**, `surface-container-low` = **96**, `surface-container` = **94**, `surface-container-high` = **92**, `surface-container-highest` = **90**, `surface-variant` = **90**, `surface-dim` = **87**, `surface-container-lowest` = **100**. Dark mode: `surface` = **6**, containers **10 / 12 / 17 / 22**, `surface-bright` = **24**, `surface-variant` = **30**. So **the total spread across all surface roles is 10 tone (light) and 18 tone (dark)** — that is the published "how much should a card differ from the page" number, and it is *small*.
- **Outline**: `outline` = tone **50** light / **60** dark; `outline-variant` = **80** light / **30** dark.
- **Scrim**: `scrim` = **tone 0** in both modes (`tone: (s) => 0`).
- **Text on surfaces**: Radix guarantees steps 11/12 hit **Lc 60 / Lc 90 APCA** on a step-2 background.
- **Contrast thresholds**: WCAG AA **4.5:1** normal text, **3:1** large text; AAA 7:1.
- **Shell opacities actually in this codebase** (from the prior report's measurement, [theme-system-research.md](theme-system-research.md) §追加三): sidebar `bg-white/70`, header `bg-white/85`.
- **Derived dim actually chosen**: ~**45%** once the shell's own translucency is accounted for, versus **80%** if you ignore it. The report's key finding: *"够不到目标时压到 95% 是白压"* — pushing 62%→95% moved the tightest region only from 3.95 to 4.43 while erasing the image.

**What is NOT published (do not attribute numbers to these):**

- Fluent's current acrylic page does **not** state tint opacity, luminosity opacity, blur radius or noise percentage. The recipe is named ("background, blur, exclusion blend, color/tint overlay, noise") but the values are not in the page text. **Any specific "80% tint / 30px blur" figure you have seen is a historical Windows 10-era value and I could not verify it against current documentation.**
- Mica's page says the content layer is "a low-opacity solid color" with **no number**.
- Apple's HIG material thickness values could not be read (§F).

**Recommended starting points (engineering judgement, clearly labelled as such — not quoted from any spec):**

- blur radius: **8–16px** for sidebar/header, **16–24px** for modals. Below ~8px the effect reads as a rendering artefact; above ~24px on a large surface the cost rises and the "frosted" look becomes the design.
- surface alpha for blurred chrome: **0.55–0.75**. The measured `bg-white/70` sits inside this band.
- opaque card fill over a wallpaper: **≥ 0.92** alpha, or fully opaque (see §d's derivation for why 0.92 is the practical floor).
- Never more than **two** blurred surfaces visible at once (Fluent's seam rule + the spec's nesting penalty).

### c.4 Text over images — what the standard actually requires

WCAG F83 is a *failure* technique, and its test procedure is the operational rule:

> "**Quickcheck:** First do a quick check to see if the contrast between the text and the area of the image that is **darkest (for dark text) or lightest (for light text)** meets or exceeds that required by the Success Criterion… If the Quickcheck is false, then check to see if the background behind each letter has sufficient contrast with the letter."

And the description states the requirement directly:

> "For pictures, this means that there would need to be sufficient contrast between the text and **those parts of the image that are most like the text and behind the text**."

**Important negative finding:** WCAG does **not** publish a scrim/overlay formula, a minimum overlay opacity, or any guidance on `backdrop-filter`. F83 tells you *what* must hold (contrast at the worst point) and *how to test it*, but not *how opaque your overlay must be*. Any "WCAG says 60% scrim" claim is not from WCAG. This is confirmed by reading the full SC 1.4.3 Understanding page and F83: the only numeric content is 4.5:1 / 3:1 / 7:1.

The dimming layer's job is therefore: **guarantee the worst-case pixel reaches the target ratio**, which is exactly what the prior report implemented (*"「解，不要查表」"* — solve for the tone rather than look it up).

### c.5 Failure modes, with sources

| Failure | Mechanism | Source |
|---|---|---|
| Blur silently does nothing | an ancestor with `opacity < 1` / `filter` / `mask` / `clip-path` / `mix-blend-mode` / `will-change` becomes a backdrop root; the backdrop is cut there | Filter Effects 2 §3; MDN ("a common source of confusion") |
| Blur region rendered at (opacity)² | the ancestor's opacity is applied to the already-filtered backdrop | Filter Effects 2 §3.1 |
| Exponential cost | nested backdrop-filters each double re-paint cycles | Filter Effects 2 §3.2 |
| `position: fixed` descendants jump | `backdrop-filter` creates a containing block | Filter Effects 2 §2.1 |
| Seam / striping | two translucent panes edge-to-edge | Fluent acrylic Do/Don't |
| Legibility collapse | accent text or links over a translucent pane | Fluent acrylic |
| Appearance changes mid-animation | `will-change` creates the backdrop root *immediately*, changing which content is sampled | Filter Effects 2 §3.2 |

**On `backdrop-filter` inside a scrolling container:** I could **not** find an authoritative statement of the behaviour (neither the spec nor MDN addresses scroll specifically), and I did not find a reliable demonstration I could fetch. **UNVERIFIED.** The mechanically safe reading from the spec — the Backdrop Root Image is "the final image that would be produced" by painting content between the backdrop root and the element, clipped to the element's border box, flattened to 2D screen space — implies the blurred element samples whatever is painted behind it *at that moment*, so it should re-sample as an ancestor scrolls. **But this is my reading of the spec, not a quoted guarantee, and it is the single most likely place for a browser-specific surprise.** Test it on the actual target browsers before relying on it, and prefer making blurred chrome `position: sticky`/fixed outside the scroll container rather than inside it.

**On measured blur performance cost:** I found no published frame-time measurements. **UNVERIFIED.** The spec's own rationale is qualitative but strong: relaxing the backdrop-root constraint "would lead to a potential doubling of the CPU/GPU memory and bandwidth", and nesting "would become an exponential performance breakdown".

---

## (d) Deriving a whole skin from one image

### d.1 Material You's real numbers (the canonical case)

From `dart/lib/scheme/scheme_tonal_spot.dart` — the default Material You theme on Android 12/13:

```dart
primaryPalette:         TonalPalette.of(sourceColorHct.hue,                    36.0),
secondaryPalette:       TonalPalette.of(sourceColorHct.hue,                    16.0),
tertiaryPalette:        TonalPalette.of(sanitizeDegreesDouble(hue + 60.0),     24.0),
neutralPalette:         TonalPalette.of(sourceColorHct.hue,                     6.0),
neutralVariantPalette:  TonalPalette.of(sourceColorHct.hue,                     8.0),
```

and from `dynamic_scheme.dart`, the error palette default: `errorPalette ?? TonalPalette.of(25.0, 84.0)`.

**This is the number you asked for: the neutral palette is chroma 6, the neutral-variant palette is chroma 8.** (Note: the frequently repeated "neutral = 4" is **not** what current `main` says; I could not verify whether 4.0 was an earlier value, so treat 6/8 as current and the 4 as **UNVERIFIED**.)

Full variant table (all read from the `scheme_*.dart` sources):

| Variant | primary | secondary | tertiary | neutral | neutralVariant |
|---|---|---|---|---|---|
| **tonalSpot** (default) | hue @ 36 | hue @ 16 | hue+60 @ 24 | **hue @ 6** | **hue @ 8** |
| vibrant | hue @ **200** | rotated | rotated | hue @ 10 | hue @ 12 |
| expressive | hue+240 @ … | rotated | rotated | hue+15 @ 8 | hue+15 @ … |
| content | from source | from source | from source | from source | from source |
| fidelity | from source | from source | complement | from source | from source |
| neutral | hue @ 12 | hue @ 8 | hue @ 16 | hue @ **2** | hue @ **2** |
| monochrome | hue @ 0 | 0 | 0 | 0 | 0 |
| rainbow | hue @ 48 | hue @ 16 | hue+60 @ … | hue @ 0 | hue @ 0 |
| fruitSalad | hue−50 @ … | hue−50 @ … | hue @ 36 | hue @ 10 | hue @ 16 |

**Take-away for a wallpaper-derived skin:** the neutral tint is *very low chroma* (2–12) and the accent is *high chroma* (36–200). Your existing 11-step neutral scale is the right container; the derivation should aim for chroma ≈ 6–8 at the source hue for surfaces, and reserve higher chroma for the accent.

**Contrast levels** — the published mechanism for adapting to an unusual image. `DynamicScheme.contrastLevel` is documented in-source as *"Value from -1 to 1. -1 represents minimum contrast, 0 represents standard (i.e. the design as spec'd), and 1 represents maximum contrast."* Surfaces move too, e.g. `surfaceContainerHighest` light = `ContrastCurve(90, 90, 84, 80)` — i.e. at maximum contrast the top card step drops from tone 90 to 80, widening the separation from `surface` (98) from 8 to 18 tones. `ContrastCurve.get()` **lerps** between the four values for levels −1, 0, 0.5, 1 — it does not snap.

**Quantisation** — `QuantizerCelebi` = Wu + WSMeans, and `Score` picks from the quantised set with `_targetChroma = 48.0`, `_cutoffChroma = 5.0`, `_cutoffExcitedProportion = 0.01`, `desired = 4`. So Google's own scorer **discards anything below chroma 5** as unusable and targets 48.

### d.2 Other products deriving surfaces from a wallpaper

- **Windows 11 / Mica**: *"Mica is an opaque, dynamic material that incorporates theme and desktop wallpaper to paint the background of long-lived windows."* It **does** derive surface colour from the wallpaper — but only the base layer, and it explicitly degrades to a solid (`SolidBackgroundFillColorBase`) when transparency is off, Battery Saver is on, the hardware is low-end, the window is inactive, or Windows < 22000. This is a good precedent for a **fallback ladder**.
- **macOS**: the accent colour is chosen from a fixed set and is **never derived**; wallpaper tinting is a *separate, opt-in switch*. The prior report's takeaway — *"「推导出来的」与「用户选的」是两件事"* — is the right framing.
- **Warp (terminal)**: upload an image via a `+` in the theme picker → candidates generated → **the resulting hex values are frozen into the YAML file**. Contrast this with music players (MusicBee, Plexamp) which recompute per track and therefore never have a stable named theme.
- **Obsidian "Dynamic Theme Background"**: only blur/brightness/saturation sliders, and its own README admits it is *"optimized for dark themes, light themes may need adjusting"* — a negative example that argues for running your contrast check in both modes.
- **Android Palette API**: swatch profiles Vibrant / Vibrant Dark / Vibrant Light / Muted / Muted Dark / Muted Light / Dominant — **UNVERIFIED** (I did not fetch the developer.android.com page; it was in scope but not reached).
- **color-thief 2.x/3.x, node-vibrant, matugen, pywal/wallust**: already catalogued with borrowings in [theme-system-research.md](theme-system-research.md) §追加三.

### d.3 Deriving a *safe* overlay amount from image statistics

**Negative finding, stated plainly: I could not find any spec, product documentation, or published algorithm that derives a scrim/dim opacity from measured image statistics.** Material 3 specifies a scrim role (tone 0) but not an opacity rule. WCAG specifies the target ratio but not the overlay. Fluent and Mica describe layers qualitatively without numbers. Treat everything below as **derived here, not cited**.

The derivable part is exact and worth automating:

1. **Target.** Pick the contrast ratio required (4.5:1 for body text, 3:1 for large text).
2. **Worst case.** Per F83's Quickcheck, do not average. Take the **lightest** region behind light text (or darkest behind dark text) — practically: sample the image under the text's bounding boxes and take the extreme percentile.
3. **Composite in sRGB, then measure.** CSS composites in the encoded space, so the composite channel is `c' = (1−a)·c_img + a·c_scrim` per sRGB channel; **then** linearise. Relative luminance is `L = 0.2126·R + 0.7152·G + 0.0722·B` with `c_lin = c/12.92` for `c ≤ 0.03928` else `((c+0.055)/1.055)^2.4`; contrast is `(L_light + 0.05)/(L_dark + 0.05)`.
4. **Solve for `a` by bisection** on the real composite — there is no closed form because of the piecewise linearisation and the `+0.05` offsets. This is what makes "solve, don't look up" (the MCU `foregroundTone` approach the prior report borrowed) the correct implementation.
5. **Rule of thumb** for intuition: over the power-law branch with channels scaling roughly equally, a black scrim multiplies luminance by ≈ `(1−a)^2.4`, so `a ≈ 1 − k^(1/2.4)`. **Halving the background luminance needs ≈ 25% black; quartering it needs ≈ 44%.** This is *my* derivation; it is an approximation that ignores the `+ 0.05` terms and any hue shift, and it should be used only to sanity-check the bisection result.
6. **Stop early.** When the target cannot be met even at a high alpha, do not keep pushing — the prior report measured that going 62% → 95% bought only 3.95 → 4.43 while destroying the image. Cap the dim, keep the image, and surface the actual measured ratio to the user.

The *spatial* part matters more than the aggregate: the prior report's solution — a directional gradient weighted toward the regions that actually contain text (sidebar edge + top bar), rather than a uniform dim — is the right approach, and it is also why the derivation must be **per-region**, not one global number. That directly matches the per-region token model in §b.

**Blur radius from image detail/frequency (variance of Laplacian, edge density): I found nothing published.** **UNVERIFIED — no prior art found.** Choosing blur from image statistics would be novel work, not a port of an existing method.

---

## (e) Gallery / editor UX recommendations, with precedents

### e.1 How the preview is produced

| Approach | Precedent | Verdict for a Skin Center |
|---|---|---|
| **Live re-render from the theme's own values, while the item is highlighted** | VS Code: *"Use the Up and Down keys to navigate through the list and preview the colors of the theme"* and *"Arrow up and down to see a live preview of your theme"* | **Do this.** It is the strongest precedent and requires no assets. |
| **Static screenshot shipped with the theme** | Obsidian's index has a per-theme `screenshot` field (`"screenshot": "screenshot.png"`, `"assets/light-1.png"`, …) | Only if you accept third-party submissions. The prior report deliberately rejected it (*"加一个皮肤就要多两张图，而且缩略图必然与真实配色分叉"*), and for built-in data-only skins that is correct. |
| **A real iframe / "try it" URL** | VS Code for the Web: `https://vscode.dev/editor/theme/<extensionId>` | Overkill for an in-app gallery; the live-render path already gives the truth. |
| **Overlay "try it" mode** | — | Not needed if preview is live. |

**The design that follows:** a gallery tile renders a **miniature of the real UI** using the skin's variables (a scoped `<div>` with the skin's custom properties), not a picture. Because the skin is data, the miniature cannot drift from the applied result. That is also what makes "preview on hover/keyboard focus" free.

### e.2 Browsing, applying, reverting

- **Grid + one filter dimension.** Obsidian's community index models exactly one filterable attribute: `modes: ["dark", "light"]`. That is the precedent for *"does this skin support the mode I'm in?"* — and it is the only filter Obsidian's own browser needs. Add search by name; add nothing else until it hurts.
- **Apply = select.** VS Code applies by picking from the list; there is no separate Apply button, and the doc does not describe a "revert" — you re-select the previous theme. **Do not invent a revert stack.** A visible "currently applied" marker plus a "Reset to default" entry is the whole interaction.
- **Live apply while editing.** VS Code: *"Changes to the theme file are applied live in the Extension Development Host window"* and for token customisation *"Changes are applied live to your VS Code instance and no refreshing or reloading is necessary."* → **edits apply live; there is no confirm step.**
- **The editing model to copy is VS Code's, and it is the best single idea here:**
  1. Tweak live (`workbench.colorCustomizations` ⇒ your per-region editor).
  2. When it looks right, run **`Developer: Generate Color Theme from Current Settings`** to *materialise* the live state into a portable theme file.
  → For a Skin Center: **live-edit, then "Save as new skin"**. Editing is always a working copy; nothing is destructive; the gallery and the editor share one data shape.
- **Import/export is a first-class path.** Obsidian themes are distributed as `repo` + `screenshot` in an index; VS Code themes are `contributes.themes[]` entries with `path`; the prior report's platform precedent (deep-whale) adds "validate the *merged* result, and after import you must still be able to export". Keep the export format identical to the built-in format.

### e.3 How many presets, and how to name them

**No published guidance on preset count was found.** I looked at Material 3, Radix, shadcn, Windows Terminal and Apple HIG; none states a number. What I *can* report is the observed band:

| Product | Built-in count | Naming style |
|---|---|---|
| Windows Terminal | **7** schemes: Campbell, Campbell Powershell, Vintage, One Half Dark, One Half Light, Tango Dark, Tango Light | place/person (`Campbell`, `Tango`), origin (`Vintage`), or `<scheme> <variant>` |
| VS Code (`theme-defaults`) | **10** colour themes: Light 2026, Dark 2026, Dark+, Dark Modern, Light+, Light Modern, Visual Studio Dark, Visual Studio Light, Default High Contrast, Default High Contrast Light | `<Mood/Origin> <Modern|+>`; explicit High Contrast variants |
| shadcn/ui base colours | **7**: Neutral, Stone, Zinc, Mauve, Olive, Mist, Taupe | **material nouns** |
| Radix Themes | 6 accents × 6 grays | material nouns / hue names |
| VS Code `charts.*` | 8 keys, **named by hue** (`charts.red`, `charts.green`, …) | hue names |

**Recommendation:** ship **7–10** built-ins. Names should be *material or place nouns* (Stone, Zinc, Mist, Campbell, Tango) rather than adjectives about mood ("Sleek", "Modern", "Pro") — every product surveyed that names well uses nouns, and mood adjectives are exactly what makes a theme read as generic. Name light/dark as **two entries in one family** rather than doubling the count: Obsidian's `modes: ["dark","light"]` shows the field that expresses this, and the prior report's rule — *"明暗是宿主拥有的正交轴，不是皮肤的一个变体"* — is the right model.

---

## (f) Things I would NOT do

1. **Do not implement the dimming layer as `opacity` on an ancestor of anything blurred.** Spec-verified: `opacity < 1` creates a backdrop root and the child's `backdrop-filter` is cut off; the blurred region also renders at (opacity)². Paint the dim as a solid `rgb(0 0 0 / a)` layer instead.
2. **Do not put `will-change` on any ancestor of a blurred panel.** The spec says `will-change` creates the backdrop root *immediately*, which changes what gets sampled — a rendering change, not just a perf hint.
3. **Do not nest blurred surfaces.** Spec: each nesting level doubles re-paint cycles. Practically: never blur a modal that lives inside a blurred sidebar.
4. **Do not render modals inside a blurred container.** `backdrop-filter` creates a containing block for `position: fixed`, so the modal will be positioned against the sidebar, not the viewport. Portal it out.
5. **Do not blur the main workspace, the cards, or the inputs.** Fluent's explicit Don't ("large background surfaces"); Mica's content layer is a *low-opacity solid*, not a blur; no surveyed product blurs a text input.
6. **Do not put accent-coloured text, or hyperlinks, on a translucent surface.** Fluent states these are "likely to not pass minimum contrast ratio requirements at the default 14px font size".
7. **Do not place two translucent panes edge-to-edge.** Fluent: "undesirable visible seam" / "striping effect".
8. **Do not ship `backdrop-filter` without `-webkit-backdrop-filter` and without a solid fallback.** MDN's rendered table lists Safari as unsupported for the unprefixed property (re-verify). Also copy Mica's fallback ladder: drop to solid when transparency is disabled system-side, on battery saver, on low-end hardware, or when the window is inactive.
9. **Do not measure text contrast against the image's average colour.** WCAG F83 requires the *darkest-for-dark-text / lightest-for-light-text* area — "those parts of the image that are most like the text".
10. **Do not cite WCAG as the source of an overlay-opacity number.** WCAG publishes 4.5:1 / 3:1 / 7:1 and a test procedure; it publishes no scrim value. Deriving the alpha is your job.
11. **Do not make 35 colour tokens mandatory.** Windows Terminal requires only `name`; VS Code ships a theme with no `tokenColors`; shadcn merges `cssVars` into what exists. Require identity (`id`, `label`, `base`, `mode`) and derive the rest in a documented order.
12. **Do not add a per-region *state* matrix** (hover/active/selected × 7 regions). Radix and VS Code both prove state belongs to the *scale* (Radix steps 3/4/5, 6/7/8) or to component tokens, not to a region × state grid. 7 regions × 5 states would be 35 states nobody will ever author.
13. **Do not let the skin own the light/dark axis.** Already decided in this workspace; confirmed by every precedent (Obsidian's `modes` array, VS Code's `uiTheme`, deep-whale's `{light, dark}` preview).
14. **Do not derive the whole palette from the image without an override.** macOS never derives its accent, and the prior report's `config.accent` rule (user-entered accent wins over skin-derived) is the correct precedence. **Derived ≠ chosen.**
15. **Do not skip a contrast self-test on derived skins, in both modes.** DTB's README admitting "optimized for dark themes, light themes may need adjusting" is the failure this prevents.
16. **Do not use `backdrop-filter` inside a scrolling container without testing it.** The behaviour is genuinely not documented (§c.5) and I could not verify it. Prefer `position: sticky` chrome outside the scroll container.
17. **Do not ship adjectival theme names** ("Sleek", "Aurora Pro", "Neo Dark"). Every well-named gallery surveyed uses material nouns or places.
18. **Do not build the gallery preview as screenshots for built-in skins.** They diverge from the real colours by construction; the live-render path is free because the skin is data. Reserve screenshots for third-party submissions, where Obsidian's index shows the required field shape.
19. **Do not add a confirm step after a theme edit.** VS Code applies live, twice-documented. A confirm dialog on a reversible visual change is pure friction.
20. **Do not push the dim past the point of no return.** Measured precedent: 62% → 95% bought 3.95 → 4.43 and cost the image entirely. Cap it and report the measured ratio instead.

---

## (g) Explicit list of things I could not verify

1. **Fluent acrylic's numeric values** (tint opacity, luminosity opacity, blur radius, noise %). The current page states the recipe by name only. Do not attribute specific numbers to it.
2. **Mica's content-layer opacity number.** Only "a low-opacity solid color" is published.
3. **Apple HIG material thickness vocabulary** (`ultraThin`/`thin`/`regular`/`thick`/`ultraThick`) and any per-material blur/opacity values — the page is client-rendered and the JSON mirror 404s.
4. **Chrome's theme manifest key names** (`theme.colors` / `theme.images` / `theme.tints`) — the docs host is unreachable from this machine.
5. **Carbon's token names** (`layer-01/02/03`, `field-01`, `border-subtle`, `text-primary`, `overlay`) — page client-rendered, npm scss paths 404. Only the `custom-property.declaration('…')` usage pattern was readable.
6. **Fluent UI's semantic token names** (`colorNeutralBackground1`…) — the source file contains only the raw grey ramp.
7. **Telegram's theme format** — `core.telegram.org` is blocked from this host.
8. **Discord / BetterDiscord's token model** — not retrieved.
9. **terminal.sexy's preview/export behaviour**, **Gogh's scheme presentation**, **Firefox/AMO theme gallery markup** — all client-rendered or unreachable.
10. **`backdrop-filter` behaviour inside a scrolling container** — not addressed by the spec or MDN; my reading of the spec is stated as a reading, not a citation.
11. **Measured performance cost of large-area blur** — no published frame-time numbers found.
12. **Whether Material's neutral chroma was historically 4.0** rather than the current 6.0.
13. **Any published guidance on the number of presets to ship.**
14. **Any published algorithm for deriving scrim opacity from image statistics** — §d.3 is derived here, explicitly not cited.
15. **Any published method for choosing blur radius from image statistics** — no prior art found.
16. **Android Palette API's swatch profiles** — in scope, not reached.
17. **Safari's current unprefixed `backdrop-filter` support** — MDN's rendered table says "None"; caniuse returned HTTP 406 so I could not cross-check. Re-verify.
18. **VS Code deprecated colour keys** — I found no `deprecationMessage` occurrences in `workbench/common/theme.ts`, so I make no claim about which keys are deprecated.

---

## (h) One-page implementation summary

- **Token model:** 7 region blocks × `{surface, alpha, blur, border, shadow}` = 35 tokens, all optional, each defaulting to a step of the existing 11-step neutral scale. Plus shared `--fg-{default,muted,subtle,on-accent}`, `--accent`/`--ring`, `--scrim`/`--scrim-opacity`/`--shadow-color`/`--border-strength`, and `--chart-*`. Manifest requires only `{id, label, base, mode}`.
- **Translucency contract:** sidebar, header, modals/popovers may blur (8–24px, alpha 0.55–0.75); workspace, cards and inputs must not. Dim is a painted layer, never `opacity`. Never nest. Never two adjacent panes. Portal modals out of blurred subtrees. Ship the `-webkit-` prefix and Mica's solid-fallback ladder.
- **Derivation:** neutral chroma ≈ 6–8 at the source hue (Material's real numbers); accent chroma 36+. Sample the *worst* region per F83, then bisect the scrim alpha against the real composite and the real contrast formula. Cap the dim; report the achieved ratio.
- **Gallery:** live-rendered miniature from the skin's own variables, grid + a `modes` filter + name search, apply-by-select with a "currently applied" marker, live-apply editing with "Save as new skin" as the materialisation step, export format identical to the built-in format.
- **Presets:** 7–10, named with material or place nouns, light/dark expressed as one family with two modes.
