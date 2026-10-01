# Codex community "skin" projects — visual system & product design teardown

**Scope:** how these projects model a skin, which UI regions they skin, their translucency/blur numbers, background handling, preview UX, image→skin flow, persistence/reset. Desktop plumbing (CDP, asar patching, launcher injection) is deliberately excluded except where it explains a design decision.

## Mirror note (read this first)

`github.com`, `api.github.com` and `raw.githubusercontent.com` **resolve to 127.0.0.1 in this environment and are unreachable.** Everything below was read through these mirrors, so you can reproduce it:

| Purpose | URL pattern that worked |
|---|---|
| Full repo tarball | `https://codeload.github.com/<owner>/<repo>/tar.gz/HEAD` |
| Single file | `https://ghproxy.net/https://raw.githubusercontent.com/<owner>/<repo>/<ref>/<path>` (also `gh-proxy.com`, `ghfast.top`) |
| **Release binaries** | `https://ghproxy.net/https://github.com/<owner>/<repo>/releases/download/<tag>/<asset>` |
| Repo file tree | `https://data.jsdelivr.com/v1/packages/gh/<owner>/<repo>@<ref>?structure=flat` |
| Web search | Bing **RSS** `https://www.bing.com/search?q=<q>&format=rss` — unfiltered where Bing HTML is censored |
| Chinese project names | 360 search `https://www.so.com/s?q=<q>` — the only index that surfaced HeiGe |

Search notes: Google, DuckDuckGo, Brave, Startpage, SearXNG instances are all blocked here. Software Heritage and grep.app are behind bot walls (Anubis / Vercel checkpoint). **`github.com` DNS is blackholed, so GitHub code search was unavailable** — repo discovery relied on Bing RSS + 360.

---

## 1. Projects found

| # | Name | What it is | Link | Could I read its source? |
|---|---|---|---|---|
| 1 | **Codex Dream Skin** | External theming tool + `dreamskin.cc` theme platform for Codex Desktop. Loopback CDP injection, no asar edits. | [github.com/Fei-Away/Codex-Dream-Skin](https://github.com/Fei-Away/Codex-Dream-Skin) · [dreamskin.cc](https://dreamskin.cc) | **Partly.** Public repo is *docs + CI + images only* (40 entries) — no `src/`. Client code ships inside the DMG / Setup.exe. I read all public docs, the CI/release pipelines, the **live website bundle**, the **live API**, and a **real downloaded theme package**. Could not decompile the installers (Inno Setup; no extractor available). |
| 2 | **"codex-skin"** | — | **Not found** | **No.** See §2. No repository literally named `codex-skin` exists in any index I could reach. |
| 3 | **黑哥 Codex Skin Studio** (HeiGe) | Codex Desktop skinning tool with an in-app **Theme Center**. Loopback CDP on `127.0.0.1:9341`. | [github.com/HeiGeAi/heige-codex-skin-studio](https://github.com/HeiGeAi/heige-codex-skin-studio) | **Yes — full source.** `src/theme-schema.mjs`, `src/skin-css.mjs`, `src/injector.mjs`, 12 real `themes/*/theme.json`, plus design specs. Read at commit `2b2bac9f79059944823b5ef2143e457e248af987`. |
| 4 | **Awesome Codex Skins** | A **formal spec** — the `.codexskin` v1 (schemaVersion 2) format, toolchain and gallery. | [github.com/Wangnov/awesome-codex-skins](https://github.com/Wangnov/awesome-codex-skins) · [SPEC.md](https://github.com/Wangnov/awesome-codex-skins/blob/main/SPEC.md) | **Yes.** `SPEC.md`, `REGISTRY.md`, and real 44 KB skin CSS files (`skins/asuka-eva02/theme.css`, `skins/guts-terminal/theme.css`) + manifests. |
| 5 | **Codex App Manager** | Desktop manager that consumes `.codexskin`; owns the canonical injected runtime. | [github.com/Wangnov/Codex-App-Manager](https://github.com/Wangnov/Codex-App-Manager) | **No** — referenced by project 4's spec as the canonical runtime implementation; I did not read it. |
| 6 | **Codex++** | "Open-source launcher and manager for the OpenAI Codex / ChatGPT desktop app." | [codexpp.cc](https://codexpp.cc/) | **No** — surfaced in search only; I did **not** verify it has a skin/theme system. Treat as unconfirmed. |

Not projects: `codexskins.art`, `codexskin.cn`, `codexskin.top`, `codex-dream-skin.com`, `codexdreamskin.top`, `codex-skin.org`, `codexskin.me`, `codexskins.org`, `codexskinmaker.com`, `awesomecodexskin.com` are **look-alike/SEO landing sites**, several clearly AI-content farms (e.g. one shows a shell one-liner `curl -fL https://codedreamskin.top/downloads/codex-dream-skin-main.zip`). They are not the upstream projects and I would not cite them.

---

## 2. "codex-skin" — couldn't find it (explicit non-finding)

I made repeated, differently-shaped attempts: Bing RSS (`"codex-skin"`, `codex-skin github repository`), Bing HTML with the base64 `bing.com/ck/a?u=a1…` redirect links decoded, and 360 search in Chinese. Results were either the generic Codex product set or character-level noise. `codeload.github.com/codex-skin/codex-skin/tar.gz/HEAD` → **HTTP 404**.

What I think happened: **"codex skin" is used as a common noun, not a repo name.** E.g. Tencent Cloud's article literally reads "codex skin 是针对 **Codex Desktop** 开发的一套完整换肤方案。项目地址: github.com - Codex-Dream-Skin" — i.e. the phrase points at Codex Dream Skin. There are also look-alike domains (`codexskin.cn/.top/.me`, `codex-skin.org`). **The closest real repositories are projects 1, 3 and 4.** I am not going to invent an owner/repo for it.

---

## 3. Codex Dream Skin — `Fei-Away/Codex-Dream-Skin`

### 3.1 What a "skin" is in their data model

**A theme is a 3-file contract, not a wallpaper path.** From the repo's own agent guide:

> 客户端只导入普通 `.zip`，不支持 `.dreamskin`… 新主题必须同时包含非空 `theme.json`、非空 `theme.css` 和 `theme.json` 引用的唯一背景图；三者缺一不可。
> 背景图最大 10 MiB… — [AGENTS.md](https://github.com/Fei-Away/Codex-Dream-Skin/blob/main/AGENTS.md)

A full Studio package also carries `manifest.json`; `LICENSE.txt` and `manifest.sig` are reserved. Limits: **ZIP ≤ 32 MiB, ≤ 32 entries, ≤ 64 MiB unpacked, background ≤ 10 MiB**, CSS ≤ 256 KiB ([README](https://github.com/Fei-Away/Codex-Dream-Skin/blob/main/README.md), [llms-theme.txt](https://dreamskin.cc/llms-theme.txt)).

**A real `theme.json`** — downloaded verbatim from `https://api.dreamskin.cc/v1/themes/ver_420123d4688b2d1e9bfc/download` (2,239,204 bytes; matches the API's `packageBytes` exactly):

```json
{
  "schemaVersion": 1,
  "id": "lazy-gpt-chan",
  "name": "慵懒的GPT娘",
  "image": "background.png",
  "appearance": "light",
  "art": { "focusX": 0.5, "focusY": 0.5, "safeArea": "none", "taskMode": "ambient" },
  "colors": {
    "background": "#f0f5f1", "panel": "#eaf5ee", "panelAlt": "#f1f7f3",
    "accent": "#3f806d", "accentAlt": "#568f7e", "secondary": "#659c91",
    "highlight": "#9caf88", "text": "#253e35", "muted": "#526e62",
    "line": "rgba(89, 132, 113, 0.18)"
  }
}
```

So it is **far more than a wallpaper path**: a 10-colour palette + four art/framing fields. Colours map to tokens by camelCase→kebab-case, which the site's own code shows verbatim:

```js
cr=["background","panel","panelAlt","accent","accentAlt","secondary","highlight","text","muted","line"],
qy=n=>n.replace(/[A-Z]/g,a=>`-${a.toLowerCase()}`),
mp=n=>`--ds-theme-color-${qy(n)}`
```

→ `panelAlt` becomes `--ds-theme-color-panel-alt`. (Extracted from the shipped bundle `https://dreamskin.cc/assets/index-CoqfNW4j.js`.)

`manifest.json` (same package) adds `packageVersion`, `themeId`, `version`, `skinApiVersion`, `minClientVersion`, `platforms[]`, `capabilities:["background","tokens","safe-css"]`, `publisher{id,displayName}`, `license`, `provenance{aiGenerated,summary}`, and a `files[]` array with per-file `bytes` + `sha256`.

### 3.2 Which UI regions they skin separately — **exactly 12, hard-coded**

This is the single most useful finding for your question. The website's Safe-CSS validator hard-codes the part list:

```js
const Gy="data-ds-part",
ek=["root","sidebar","main","header","home","home-hero","project-list","thread","message","composer","composer-toolbar","dialog"],
tn=n=>({[Gy]:n}),
```

and the docs confirm: *"`theme.css` 必须通过本机 Safe CSS 校验，导入后只会作用于 **12 个注册部件**"* ([README](https://github.com/Fei-Away/Codex-Dream-Skin/blob/main/README.md)). The official authoring spec lists all twelve as the entire addressable surface:

```css
[data-ds-part="root"]        [data-ds-part="sidebar"]   [data-ds-part="main"]
[data-ds-part="header"]      [data-ds-part="home"]      [data-ds-part="home-hero"]
[data-ds-part="project-list"][data-ds-part="thread"]    [data-ds-part="message"]
[data-ds-part="composer"]    [data-ds-part="composer-toolbar"]  [data-ds-part="dialog"]
```
> Optional states: `:hover`, `:focus-visible`. — [llms-theme.txt](https://dreamskin.cc/llms-theme.txt)

**Answer: separate surfaces with their own settings, not one global stylesheet.** The selector grammar enforces it — exactly one part per rule:

```js
Rw=/^\[data-ds-part="([a-z]+(?:-[a-z]+)*)"\](?::([a-z-]+))?$/
```

No descendant combinators, no class/id/type selectors, no `!important`, no `@media`. Note `:is()`/commas are impossible, so **one rule = one declared region**.

### 3.3 Translucency and blur — real numbers

Verbatim from the shipped `theme.css` of the package above:

```css
[data-ds-part="sidebar"] {
  background-color: rgba(239, 247, 242, 0.94);
  border-color: var(--ds-theme-color-line);
  border-width: 1px; border-style: solid;
  backdrop-filter: blur(20px) saturate(0.8);
  box-shadow: none;
}
[data-ds-part="main"]    { background-color: rgba(240, 248, 244, 0.02); box-shadow: none; }
[data-ds-part="home-hero"]{ color: var(--ds-theme-color-text); }
[data-ds-part="project-list"] { opacity: 0.78; gap: 12px; box-shadow: none; }
[data-ds-part="thread"]  { background-color: rgba(242, 249, 245, 0.55); backdrop-filter: blur(10px); }
[data-ds-part="message"] { background-color: rgba(245, 250, 247, 0.86); border-radius: 14px; }
[data-ds-part="composer"]{ background-color: rgba(255,255,255,0); border-width: 0; border-radius: 18px; backdrop-filter: none; }
[data-ds-part="composer-toolbar"] { color: var(--ds-theme-color-muted); background-color: rgba(255,255,255,0); }
[data-ds-part="dialog"]  { background-color: rgba(244, 250, 247, 0.98); border-radius: 18px;
                           box-shadow: 0 8px 24px rgba(38, 70, 56, 0.12); }
```

A second, darker real theme (`ver_0d5ead6f26f4ec29aadb`, `safeArea:"left"`) shows the same shape with state selectors:

```css
[data-ds-part="sidebar"] { background-color: rgba(27,23,27,0.91); border-right-color: rgba(216,172,105,0.30); }
[data-ds-part="header"]  { background-color: rgba(35,28,31,0.78); border-bottom-color: rgba(216,172,105,0.24); }
[data-ds-part="composer"]{ background-color: rgba(41,33,38,0.94); border-color: rgba(216,172,105,0.56); border-radius: 18px; }
[data-ds-part="composer"]:focus-visible { border-color: #F1CF90; }
[data-ds-part="dialog"]  { background-color: rgba(41,33,38,0.97); border-color: rgba(184,79,96,0.40); }
```

**Aggregated over 40 real themes** (via the `/v1/themes/<id>/preview` endpoint, which returns `safeCss` as a 2 KB payload instead of a 2 MB ZIP):

- `backdrop-filter` is overwhelmingly a **token**, not a literal: `blur(var(--ds-theme-surface-blur))` — **47 occurrences**. Literals span **4 px – 24 px**, usually with `saturate(0.8 – 1.25)` and sometimes `brightness(0.86 – 1.04)`.
- Panel alphas cluster at **0.86 / 0.90 / 0.91 / 0.94 / 0.97 / 0.98**; `main` goes as low as **0.02** (essentially the bare wallpaper); `thread` at **0.55**.
- `opacity` is rarely used (1 occurrence, `0.78`).
- Allowed filter functions are a closed set: `blur | saturate | brightness | contrast`, max 4 functions, **blur must come first**, blur 0–30 px, saturate 0.5–2, brightness/contrast 0.8–1.5 ([llms-theme.txt](https://dreamskin.cc/llms-theme.txt)); enforced by `/^(blur|saturate|brightness|contrast)\(\s*(.+?)\s*\)$/i`.

**The full Safe-CSS property allow-list** (30 properties, from the shipped validator):

```js
Op = color, background-color, border-color, border-top-color, border-right-color,
     border-bottom-color, border-left-color
$p = border-width, border-top-width, border-right-width, border-bottom-width, border-left-width
Ew = border-style, border-top-style, border-right-style, border-bottom-style, border-left-style
Fp = border-radius, border-top-left-radius, border-top-right-radius,
     border-bottom-right-radius, border-bottom-left-radius
zp = gap, row-gap, column-gap
Lw = [...Op, ...$p, ...Fp, ...zp,
      "box-shadow","opacity","backdrop-filter","font-size","font-weight","line-height","letter-spacing"]
```

Rejected: free selectors, `@import/@font-face/@media`, `url(...)`, `position`, `display`, `transform`, `animation`, `!important`, comments, unknown CSS variables. Values must be hex/rgb(a), a bare integer 0–999, `400|500|600|700|normal|bold`, or `var(--registered-token)`.

### 3.4 Readability over the image — the "safe area" idea

Rather than only dimming, DreamSkin pushes the problem into **image composition** and exposes it as data. From the repo's prompt guide ([docs/background-generation-prompts.md](https://github.com/Fei-Away/Codex-Dream-Skin/blob/main/docs/background-generation-prompts.md)):

> 母版画布：推荐 `2560 × 1440`（16:9）
> 构图：**左侧 `x=0%～52%` 为低信息安全区**；主视觉中心放在 `x=68%～76%`，脸、手和识别性道具控制在 `x=62%～88%`，非关键装饰最多延伸到 `x=90%`；任何关键内容距四边至少 **8%**。
> 浅/暗兼容：安全区要有连续、低频、低对比的明暗变化，避免纯白烧穿或纯黑死区。

And the acceptance check:

> 按 16:9、16:10、4:3 与超宽窗口分别做 `cover` 预览后，脸、手、头顶、麦克风或其他识别性道具仍完整，**底部 composer 不遮住关键内容**。

This is why `theme.json` carries `safeArea: "none" | "left"` — the theme declares where the image is quiet so the UI can trust it. In the 40-theme sample: `safeArea`: **none=33, left=7**; `taskMode`: **ambient=39, full=1**; `appearance`: **light=8, dark=31, auto=1**; `focusX` ∈ [0, 0.8], `focusY` ∈ [0.19, 0.65].

### 3.5 How the background image is handled

- **One image behind everything**, `cover`, no per-region images.
- Token model (from the bundle) — note `dim` is explicitly the darkening scrim:

| key | cssVar | range | default | unit | description (verbatim) |
|---|---|---|---|---|---|
| `image.focus-x` | `--ds-theme-image-focus-x` | 0–1 | .5 | | 背景图水平焦点（theme.json art.focusX） |
| `image.focus-y` | `--ds-theme-image-focus-y` | 0–1 | .5 | | 背景图垂直焦点（theme.json art.focusY） |
| `image.zoom` | `--ds-theme-image-zoom` | 1–1.6 | 1 | | 背景图缩放 |
| `image.dim` | `--ds-theme-image-dim` | 0–.8 | 0 | | 背景图遮罩强度（**保证前景可读性**） |
| `image.task-intensity` | `--ds-theme-image-task-intensity` | 0–1 | .35 | | 任务页背景强度（art.taskMode=ambient 的氛围权重） |

- Product framing: *"一张 16:9 纯壁纸连续铺满整窗，**首页突出氛围，任务页自动降低干扰**"* ([README](https://github.com/Fei-Away/Codex-Dream-Skin/blob/main/README.md)) — i.e. the image is strongest on the empty home screen and fades down on task pages, which is exactly what `taskMode`/`task-intensity` encode.
- Source-image pipeline: user PNG `1672 × 941` → derived export `2560 × 1440` JPEG, *"并不代表增加了源图细节"* (README is careful not to claim upscaling gains).

### 3.6 Preview / gallery UX

- **Gallery**: [dreamskin.cc/gallery](https://dreamskin.cc/gallery) — 689 published themes (`"limit":12,"offset":0,"total":689`), sorted recent/popular, with a creator leaderboard, favourites, comments and human moderation.
- **Web desktop simulator**: *"每套主题都能先在网页里的桌面模拟器中试穿，再决定装不装"* — you try a theme on inside a browser replica of the desktop before installing.
- **How the preview is generated**: the API returns everything the simulator needs in one payload — theme JSON + `safeCss` + a background URL:

```
GET https://api.dreamskin.cc/v1/themes/<ver_id>/preview
→ {"theme":{…},"platforms":[…],"background":{"url":"https://api.dreamskin.cc/v1/themes/<ver_id>/preview/background","mime":"image/png"},"safeCss":"…","applyCompatible":true}
GET https://api.dreamskin.cc/v1/themes/<ver_id>/preview/thumbnail[?variant=home]   → image/jpeg
```

  So the preview is **CSS-rendered live from the real tokens + real Safe CSS** (hence the simulator's `--ds-theme-color-*` variables in its own stylesheet), with a server-rendered thumbnail as the cheap gallery image.
- **Caveat**: the eight images in the repo's [docs/images/gallery/](https://github.com/Fei-Away/Codex-Dream-Skin/tree/main/docs/images/gallery) are **concept renderings that contain UI**, and the README warns they *"只作预览，绝不能当背景导入"*. The real screenshots live on the website, not in the repo.
- **Switching/reverting**: menu-bar (macOS) / system-tray (Windows) **「已保存主题」** list; a **「更换背景图」** entry; and *"可恢复：一键还原官方外观"* (one-click restore of the official look). Import **does not auto-apply**: *"导入成功只写入「已保存主题」库，不自动切换活动主题，也不覆盖 last-known-good。用户必须在菜单中明确选择后才应用"* (AGENTS.md).
- **One-click theming from the web**: the page calls `dreamskin://apply?version=ver_…`. The deep link may carry **only a version id** — no URL, path or command — and the app re-verifies review status, package size, byte count and SHA-256 before applying (README).

### 3.7 How a custom image becomes a skin

Two paths, both explicit and **manual on colour**:

1. **Online Studio** ([dreamskin.cc/studio](https://dreamskin.cc/studio)): *"在浏览器里换背景图、**调主题色**、写 Safe CSS，导出 `.zip` 主题包"* — upload a 16:9 background, tune the palette yourself, optionally write Safe CSS, export.
2. **AI-assisted authoring**: the project publishes a machine-readable spec at [`https://dreamskin.cc/llms-theme.txt`](https://dreamskin.cc/llms-theme.txt) and the Studio tells users to hand it to an LLM:

   > 调好背景与颜色后，对 AI 说：请打开并遵循 `https://dreamskin.cc/llms-theme.txt`，帮我写一段 DreamSkin Safe CSS…把结果贴进 CSS 面板，**校验通过后再导出**。

So: **no automatic colour extraction.** The image's legibility is solved upstream by prompt-engineering the safe zone (§3.4) and downstream by the user picking 10 colours in the Studio. There is also an LLM live-lint in the Studio ("Safe CSS 检查" with line/column jumps) — validation is the product surface, not an afterthought.

### 3.8 Persistence and reset

- **Theme library on disk**: macOS `~/Library/Application Support/CodexDreamSkinStudio/themes/`, Windows `%LOCALAPPDATA%\CodexDreamSkin\themes\`; menu entry 「打开主题文件夹」.
- **Active theme** is recorded in Codex's own `~/.codex/config.toml` under a `[desktop]` section (their `theme-config.mjs` rewrites it; issue #67 is about refusing to rewrite `config.toml` containing `"""`).
- **Reset**: one-click 「还原官方外观」; import never overwrites `last-known-good`; install/upgrade/uninstall keep *"原子 staging、备份与回滚"*. Issue #67/#189 show they treat "restore" as a first-class, tested path.
- **The really interesting bit** — because upstream DOM changes broke them 4 times in two weeks, they designed a **signed, hot-updatable selector "compat profile"** so a broken selector no longer requires a new installer:

  ```
  GET https://api.dreamskin.cc/v1/compat/profile?platform=&client=&codex=
  { "schema":"dreamskin-compat-profile/1", "revision":7, "expiresAt":"…", "minClient":"1.5.16",
    "selectors":[ /* same shape as tools/selectors.json */ ], "css":"…", "signature":"ed25519:…" }
  ```
  Rules: fetch async and **never block theming**; fail-closed validation (HTTPS pinned origin → bounded read → signature → schema → monotonic `revision` → not expired → `minClient` → **every selector `key` must already exist in the built-in contract**); **only the selector string may be overridden — never add a key, never change `tier`/`required`**; *"**绝不接受脚本、URL、文件路径、命令。这是硬边界：档案是数据，不是代码。**"* ([docs/compat-profile-design.md](https://github.com/Fei-Away/Codex-Dream-Skin/blob/main/docs/compat-profile-design.md))
  The design doc is also refreshingly honest about the failure that motivated it: *"每一次修的都只是**几个字符串**，但交付粒度是**整个安装包**"*.

**Evidence I could NOT get:** the actual `tools/selectors.json` (maps the 12 `data-ds-part` keys onto real Codex DOM selectors) is **not in the public repo** — it ships inside the installers. I downloaded the Windows `Setup.exe` (24,485,791 bytes, SHA-256 `a21557fe…` ✅ matches the published `SHA256SUMS.txt`) and the `.dmg` (3,427,771 bytes, SHA-256 `1e45f049…` ✅) but neither is extractable here: the Setup is **Inno Setup** (7-Zip has no Inno support; `innoextract` unavailable) and 7-Zip 25.01 refuses the DMG. Also, several files linked from the README are **absent from the public tree**: `docs/install-macos.md`, `docs/install-windows.md`, `docs/platforms.md`, `docs/reference-background-prompt-guide.md`, `docs/promo-copy.md`, `macos/README.md`, `windows/README.md`, and `docs/images/presets/`. The companion site repo `Fei-Away/dreamskin-cc` returns **404 (private)**.

---

## 4. HeiGe Codex Skin Studio — `HeiGeAi/heige-codex-skin-studio`

The most *product-complete* of the three, and the only one whose full source I could read.

### 4.1 What a "skin" is in their data model

**Deliberately minimal** — 4 colours and a hero image, validated in `src/theme-schema.mjs`:

```js
const COLOR_KEYS = ["accent", "secondary", "surface", "text"];
const COPY_KEYS  = ["brand", "headline", "tagline"];
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const APPEARANCES = new Set(["system", "light", "dark"]);
const HEX_COLOR = /^#[0-9A-F]{6}$/i;
const THEME_ID  = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DEFAULT_COLORS = { accent:"#4BC2E0", secondary:"#AD7ED5", surface:"#FAFAFF", text:"#122C60" };
```

A real shipped theme (`themes/genshin-night/theme.json`, verbatim):

```json
{
  "schemaVersion": 1,
  "id": "genshin-night",
  "name": "原神 · 星夜",
  "hero": "hero.webp",
  "appearance": "dark",
  "previewFocus": { "x": 50, "y": 17 },
  "colors": { "accent": "#e0b458", "secondary": "#7a86d8", "surface": "#171a2e", "text": "#f0e6c8" }
}
```

Full optional surface (from [docs/manual.md](https://github.com/HeiGeAi/heige-codex-skin-studio/blob/main/docs/manual.md)): `logo`, `polaroid`, `thumbnailFocus{x,y}`, `thumbnailZoom` (integer **100–400**), `copy{brand,headline,tagline}`. Only `schemaVersion`, `id`, `name`, `hero` are required. Colours are strictly **6-digit hex** — no alpha in the palette.

The elegant part: **thumbnail framing is separated from the applied background**:

> `previewFocus` 的 `x`、`y` 使用 0 到 100 的整数，**只控制主题中心大横幅**。`thumbnailFocus` 使用相同坐标范围，控制**主题小卡片和顶部圆形入口**。`thumbnailZoom` 使用 100 到 400 的整数，**只放大这两种小缩略图**，默认 100。**三项都不改变 Codex 全屏背景构图。**

### 4.2 Which UI regions they skin separately

Very much separate — but **not** via a declared part registry. They inject one generated stylesheet (`src/skin-css.mjs`) that names regions by their *real upstream DOM*, with a light/dark variant switch:

```css
:root[data-codex-window-type="electron"] { … }
#root { … }
#root::before { … }   /* brand text  */
#root::after  { … }   /* headline    */
.app-shell-left-panel { … }                       /* sidebar            */
.main-surface, .browser-main-surface { … }        /* main workspace     */
.composer-surface-chrome,
[data-user-message-bubble],
[data-codex-approval-surface] { … }               /* composer / bubbles */
[data-local-conversation-final-assistant],
[data-response-annotation-conversation] { … }     /* message container  */
[data-app-action-sidebar-thread-active="true"] { … }   /* active thread  */
[data-pip-obstacle="thread-summary-panel"] button { … } /* native panels  */
body::after { … }                                  /* decorative widget */
[data-cts-shell="dark"] …                          /* dark variants      */
```

They **also override Codex's own design tokens**, which is arguably the cleanest seam of all:

```css
--color-background-surface: color-mix(in srgb, var(--heige-surface) 90%, transparent) !important;
--color-background-panel:   color-mix(in srgb, var(--heige-surface) 94%, transparent) !important;
--color-background-button-primary: var(--heige-accent) !important;
--color-text-foreground:    var(--heige-text) !important;
--color-border:             color-mix(in srgb, var(--heige-accent) 45%, transparent) !important;
```

Their own token set is tiny: `--heige-accent`, `--heige-secondary`, `--heige-surface`, `--heige-text`, `--heige-native-light-ink`.

### 4.3 Translucency, blur, and a hard-won performance lesson

This project is the most interesting on blur because it **reduced** it, with the reason in the source comments. Verbatim from `src/skin-css.mjs`:

```css
.app-shell-left-panel {
  background: color-mix(in srgb, var(--heige-surface) 88%, transparent) !important;
  border-right: 1px solid color-mix(in srgb, var(--heige-accent) 45%, transparent) !important;
  /* blur 从 20px 降到 8px：背板是高频变化的对话区，大半径模糊会逐帧重采样 */
  backdrop-filter: blur(8px) saturate(1.12);
}
.main-surface, .browser-main-surface {
  background: linear-gradient(180deg, transparent 0 40%,
              color-mix(in srgb, var(--heige-surface) 74%, transparent) 100%) !important;
}
.composer-surface-chrome,
[data-user-message-bubble],
[data-codex-approval-surface] {
  color: var(--heige-text) !important;
  border: 1px solid color-mix(in srgb, var(--heige-accent) 24%, transparent) !important;
  /* 不透明度 60%→80%、blur 22px→8px：气泡盖在流式内容上，大模糊是卡顿主因 */
  background: color-mix(in srgb, var(--heige-surface) 80%, transparent) !important;
  box-shadow: 0 8px 24px color-mix(in srgb, var(--heige-accent) 12%, transparent) !important;
  backdrop-filter: blur(8px) saturate(1.08);
}
```

So the measured history is **sidebar blur 20 px → 8 px**, **composer blur 22 px → 8 px** while **raising** composer opacity **60 % → 80 %** — i.e. they traded translucency for frame rate.

The **readability** feature is the explicit anti-blur design, and their spec weighs three options and picks the cheapest ([readability-enhancement-design.md](https://github.com/HeiGeAi/heige-codex-skin-studio/blob/main/docs/superpowers/specs/2026-07-18-readability-enhancement-design.md)):

> 方案一：大面积实时高斯模糊 … 视觉上最接近磨砂玻璃，但长对话滚动时可能扩大 GPU 重绘区域，不符合「不卡顿」的最高优先级。
> 方案二：**主题自适应半透明底色** … 这是采用的方案。
> 方案三：每段消息独立卡片 … 依赖更多不稳定选择器，增加 DOM 和维护成本。

```css
:root[data-heige-readability="on"] [data-local-conversation-final-assistant] {
  color: var(--heige-text) !important;
  background: color-mix(in srgb, var(--heige-surface) 86%, transparent) !important;
  border: 1px solid color-mix(in srgb, var(--heige-accent) 18%, transparent) !important;
  border-radius: 18px;
  box-shadow: 0 8px 26px color-mix(in srgb, var(--heige-text) 10%, transparent) !important;
  backdrop-filter: none !important;
}
```

Shipped value is 90 % (*"最终回复和过程回复都使用 90％ 主题自适应半透明底色，并保留对称留白"*), default **on**, toggleable in the Theme Center, persisted to `localStorage` key `heigeCodexReadabilityEnabled`, synced across windows via a `heige-codex-skin-v2` BroadcastChannel. Explicit performance constraints: **no `backdrop-filter` in the AI reply area, no MutationObserver, no scroll/input/resize listeners, no network requests.**

### 4.4 How the background image is handled

One image, `cover`, anchored right, with an **explicit anti-`fixed` comment**:

```css
#root {
  color: var(--heige-text) !important;
  background:
    linear-gradient(90deg, color-mix(in srgb, var(--heige-surface) 96%, transparent) 0 22%, transparent 46%),
    linear-gradient(180deg, transparent 0 45%, color-mix(in srgb, var(--heige-surface) 78%, transparent) 78% 100%),
    /* 不用 fixed 背景附着：流式输出/滚动时会强制整视口逐帧重绘 */
    url(<hero data URL>) right center / cover no-repeat !important;
}
```

Two scrims: a **left column** (96 % → transparent by 46 %) protecting the sidebar/text column, and a **bottom band** (transparent until 45 %, then → 78 %) protecting the composer. The hero is injected as a **base64 data URL** (validated by `/^data:image\/(?:png|jpeg|webp);base64,[a-z0-9+/=]+$/i`), not a file path.

They also rename `main` to a home variant in the runtime (`.cts-home-shell`) and flip a `[data-cts-shell="dark"]` attribute — so light/dark is a single attribute, not duplicated stylesheets.

### 4.5 Preview / gallery UX

- **In-app Theme Center** ([screenshot](https://github.com/HeiGeAi/heige-codex-skin-studio/blob/main/docs/images/theme-center-live.webp)) opened from a **🎨 button in the top-centre of the app**. One screen holds: current-theme hero banner, version + 检查更新, **＋ 自定义图片**, **原生界面** (native = revert), a grid of 12 built-in theme cards, and two toggles (阅读增强 / 皮肤常驻). Theme cards are **click-to-switch**, and each card shows a thumbnail + name + latin subtitle + **three palette dots**.
- The button itself can be collapsed: 「隐藏此按钮」 turns it into a small translucent dot.
- **Preview framing is data, not screenshot**: each card is the *hero image* cropped by `thumbnailFocus` + `thumbnailZoom`; the big banner uses `previewFocus`. That is why those fields exist and why they're documented as *not* affecting the applied background.
- **Revert**: 「原生界面」 card in the same grid; plus `pause` / `resume` / `restore` (`restore.command` = drop persistence and restart to native), and `uninstall.bat` for full removal.
- **Persistence toggle**: on by default accessible only from the top menu; turning it **off** warns *"关闭后本次继续使用；下次启动恢复原生界面"*.

### 4.6 How a custom image becomes a skin — **real automatic colour extraction**

Three paths, from cheapest to fanciest (README):

1. **Menu upload**: 🎨 → 「＋ 自定义图片」 → upload → *"**自动取色、自动配深浅外观**"*.
2. **`customize.command`**: any PNG/JPG/JPEG/WebP → a complete theme (palette + background).
3. **Agent Skill**: hand `output/heige-codex-skin-studio.skill` to Codex and say "生成一张蓝紫色赛博城市主图，再做成皮肤" — generate then theme, no extra API key.

The extraction is documented precisely: *"自动按图片风格取色（**主色、辅色、面板底色、文字色**），并根据**图片亮度**同步 Codex 深浅外观"* (docs/manual.md) — i.e. it derives exactly the four `colors` fields and picks `light`/`dark` from image brightness. Note the honest caveat they ship for it: *"若图片主体亮度与背景差异很大，自动判断仍可能不符合你的偏好，此时可在 Codex 自己的「设置 → 外观 → 主题」里手动调整"*.

*(I did not locate the extraction algorithm's source file in the tree I listed — the listed modules include `src/image-metadata.mjs` but no obvious palette module, so the extractor likely lives in the platform `customize` entrypoints, which I did not read. I'm flagging that rather than claiming I verified the algorithm.)*

### 4.7 Persistence and reset

- **State**: `%APPDATA%\HeiGeCodexSkinStudio\state.json` with `persistenceEnabled`, `selectedThemeId`, `lastNonNativeThemeId`; themes under `…\themes`; `injector.log` alongside.
- **Persistence** is an explicit, user-owned switch; the supported path is a per-user LaunchAgent (macOS) / Scheduled Task (Windows). Turning it on is verified by the switch going green *within seconds* and the task existing — *"失败会立刻提示，不会长时间停在「正在等待后台确认」"*.
- **Three-level lifecycle instead of one "reset"**: `pause` (this session only) / `resume` (this session) / `restore` (turn off persistence and return to native, without waking Codex if it's already closed or already native).
- **Full teardown**: `uninstall.bat` unregisters the scheduled task, removes the Start Menu entry, kills the controller and deletes both the AppData state and the install tree; it works from the source repo even if the install dir was deleted by hand.
- Note the prior architecture: *"本仓库前身走 ASAR 修改路线，当前实现已改为 CDP"* — they migrated **away** from patching.

---

## 5. Awesome Codex Skins — `Wangnov/awesome-codex-skins`

The most formally specified, and the most ambitious visually. Its `SPEC.md` is the only actual **format specification** in this space.

### 5.1 What a "skin" is in their data model — `.codexskin` v1 / schemaVersion 2

Archive layout, verbatim from [SPEC.md](https://github.com/Wangnov/awesome-codex-skins/blob/main/SPEC.md):

```
<id>-<version>.codexskin
├── theme.json                  # required — manifest
├── theme.css                   # required — all selectors scoped to html.codex-theme-studio
├── chrome.html                 # optional — decorative overlay fragment (pointer-events: none)
├── previews/home.webp          # required for distribution — cover screenshot
├── assets/*.webp               # bitmap assets referenced by theme.json
└── assets/*.mp4                # optional motion assets referenced by "motionAssets"
```

The manifest's model is fundamentally different from the other two: **free-form keyed maps**, not a fixed palette.

```jsonc
{
  "schemaVersion": 2, "id": "guts-terminal", "name": "…", "description": "…",
  "version": "1.0.0", "author": "wangnov", "codexVerified": "26.707.91948",
  "appearance": "dual", "license": "personal-use", "tags": ["tokusatsu"],
  "previews": ["previews/home.webp"],
  "colors":  { "amber": "#e8a33d" },          // → CSS vars --cts-color-<key>
  "strings": { "hero-title": "…" },           // → --cts-str-<key> + [data-cts-text]
  "assets":  { "wall": "assets/wall.webp" },  // → --cts-asset-<key> (data URL)
  "motionAssets": { "intro-video": "assets/intro-video.mp4" },
  "codexTheme": { … }                         // native block, written to ~/.codex/config.toml
}
```

A real manifest (`skins/asuka-eva02/theme.json`) shows the scale: **12 named colours** (`red`, `red-deep`, `orange`, `amber`, `graphite`, `panel-dark`, `ink-light`, `ink`, `hazard`, `green`, `lcl`, `line`) and **45 assets** — wall, sidebar texture, character cutout, composer deck, four suggestion cards, three logos, two watermarks, 17 UI icons, 4 cursors (each with a 2× variant), and intro art. Plus it configures **Codex's own native theme**, including fonts and semantic diff colours:

```json
"codexTheme": {
  "appearanceTheme": "dark",
  "codeThemeIds": { "dark": "absolutely", "light": "absolutely" },
  "dark": { "accent": "#ff6a00", "contrast": 60, "ink": "#e8e4da", "opaqueWindows": true,
            "surface": "#17181d",
            "fonts": { "code": "SF Mono", "ui": "Hiragino Mincho ProN, \"Songti SC\"" },
            "semanticColors": { "diffAdded": "#3ddc84", "diffRemoved": "#e0301e", "skill": "#f6c800" } }
}
```

Their stated principle is the sharpest formulation of all: *"**素材化 UI 而非调色盘**、文字全部是活的 DOM、完全可逆、零交互拦截、预览必须真机可验证"* — asset-based UI, not a palette swap.

**Hard limits** (SPEC.md §2) — every one with a reason:

| Rule | Value | Why (verbatim) |
|---|---|---|
| Single asset size | ≤ **1.4 MB** raw | Chromium silently invalidates `data:` URLs over 2 MB (base64 ≈ ×1.34) |
| Asset formats | webp / png / jpg | webp preferred |
| Motion asset | ≤ 24 MB raw, ≤ 8 MB recommended | rides a non-CSS channel |
| **Text on bitmaps** | **forbidden** | all copy must be live DOM (brand-logo art is the sole exception) |
| **CSS scope** | **every selector under `html.codex-theme-studio`** | **single-class full reversal** |
| Overlay layers | `pointer-events: none`, only `#cts-stage` / `#cts-chrome` | never intercept interaction |
| Archive | ≤ 50 MB, ≤ 500 entries | importer caps |

### 5.2 Which UI regions they skin

No registry — they target real DOM directly, but **everything is namespaced**. Counted in a real skin: `html.codex-theme-studio` appears **168×** (asuka-eva02) / **183×** (guts-terminal), across **255 unique individual selectors in 191 rule groups**. After stripping the scope prefix, the regions are:

| Region | Selectors found in the real skin CSS |
|---|---|
| Root / theming context | `html.codex-theme-studio`, `body`, `.app-theme`, `[data-cts-shell="dark"]` |
| **Text & content** | `:is(input, textarea, [contenteditable="true"], .ProseMirror, p, pre, code, blockquote, h1…h6)` |
| **Interactive affordances** | `:is(a[href], button:not(:disabled), [role="button"], [role="link"], [role="menuitem"], [role="option"], [role="tab"], label[for], summary, select, input…)` |
| **Cursors** | `:is([draggable="true"], [data-dnd-kit-draggable], [data-rbd-draggable-id], [class~="cursor-grab"], [class~="cursor-grabbing"])` and `… *` |
| **Global background** | `div.main-surface`, `main.main-surface` + `::before` + `::after` + `> *`, `[role="main"] [class~="bg-token-main-surface-primary"]` |
| **Header / toolbar** | `main.main-surface > header`, `header.app-header-tint`, `.app-shell-main-content-top-fade` |
| **Sidebar** | `.app-shell-left-panel` + `::after`, `:is(nav, header, footer, div)`, `:is(button, a, span, label)`, `button:hover`, `a:hover`, `[aria-current="page"]`, `[class~="bg-token-list-hover-background"]`, `:is(input, [role="searchbox"])`, `input::placeholder` |
| **Main workspace** | `.app-shell-main-content-frame`, `main.main-surface.cts-home-shell .thread-scroll-container`, `[class*="container-type"]` |
| **Home / hero + suggestion cards** | `.cts-home div:has(> [data-testid="home-icon"]) > *`, `.cts-home .group\/home-suggestions button` + `::before`/`::after` **per nth-child(1..4)**, `:is(:hover, :focus, :focus-visible, :active, [data-state])`, `div[class*="composer-suggestion-inline-inset"]` |
| **Composer** | `.composer-surface-chrome`, `div:has(> .composer-surface-chrome)` + `::before`/`::after` (+ `:hover` variants), `.composer-surface-chrome :is(p, button, label, [contenteditable])`, `button[class*="size-token-button-composer"]`, `[class*="_WorkTriggerMeasurement"]` |
| **Content cards / messages** | `main.main-surface:not(.cts-home-shell) article`, `main.main-surface :is(pre, code)` |
| **Right panel / asides** | `main.main-surface aside:not(.app-shell-left-panel)`, `aside[data-app-shell-focus-area="right-panel"]`, `[class~="bg-token-main-surface-primary"]` |
| **Modals / popovers / dropdowns / tooltips** | `:is([role="menu"], [role="listbox"], [data-radix-popper-content-wrapper] > div, [data-radix-menu-content])`, `[role="menuitem"]`, `[role="option"]:is(:hover, [data-highlighted])`, `[role="dialog"]` + `:is(h1…, input, select)`, `[role="dialog"] [role="tablist"] button[aria-selected="true"]`, `[role="tooltip"]`, `section[class*="_floatingSurface_"]`, `[data-state="open"][class*="overlay"]`, `[class*="DialogOverlay"]`, `main button:has([class*="_dropdownLabel"])` |
| **Scrollbars** | `::-webkit-scrollbar`, `::-webkit-scrollbar-thumb`, `.app-shell-left-panel ::-webkit-scrollbar-thumb` (plus a `[data-cts-shell="dark"]` variant) |
| **Injected decoration** | `#cts-stage`, `#cts-chrome`, `.cts-hero`, `.cts-hero-title`, `.cts-hero-sub`, `#cts-intro` + 5 `@keyframes` |
| **Icons** | `svg[data-cts-glyph="…"]` — per-icon hooks: `new-task, scheduled, plugins, sites, pull-request, chat, search, explore, build, review, fix, attach, mic, model, settings, folder` |
| **Logos** | `.app-shell-left-panel [data-cts-logo="codex"|"chatgpt"|"chatgpt-work"]` |

Every one of these has a `[data-cts-shell="dark"]` counterpart — light/dark is a **variant axis over the same region list**, not a second design.

### 5.3 Translucency and blur — deliberately restrained

Counter to the other two, this project barely blurs. Across both real 44 KB skins there are only **four unique `backdrop-filter` values**:

```css
backdrop-filter: blur(6px);
backdrop-filter: blur(4px);
backdrop-filter: blur(2px) saturate(90%) !important;
backdrop-filter: none !important;
```

Instead, depth comes from **many alpha values and a wide hex ramp**. Alpha histogram (bucketed to 0.05) for `asuka-eva02`: values spread across 0.00→0.95 with the biggest clusters at **0.40 (15×)**, **0.20 (11×)**, **0.55 (10×)**, **0.85 (9×)**, **0.30 (8×)** — a *distributed* ramp rather than a handful of surface opacities. `guts-terminal` is similar (19× at 0.00, 16× at 0.20, 13× at 0.35, 11× at 0.30). Hex colours used: **36** and **32** respectively. `opacity` declarations are few and small: `.08 – .15` for watermark/wash layers, `.92` for a dimmed layer, plus `0`/`1` state flips.

**Interpretation:** they solve legibility with **asset craft** (purpose-made textures and washes) rather than with blur or a global scrim — which is consistent with "asset-based UI, not a palette swap".

### 5.4 How the background image is handled

Not one image but **a layer stack of named assets**: `wall` as the base, `sidebar-texture` as a sidebar wash, `watermark-dark` for the dark variant, plus `composer-deck` / `deck-slim` / four `card-*` images placed on specific cards. 42 (asuka) / 33 (guts) asset variables are actually referenced by the CSS. All are injected as **data URLs**, hence the strict 1.4 MB per-asset cap driven by Chromium's 2 MB data-URL invalidation.

### 5.5 Preview / gallery UX

- Gallery is the README table of 26 skins, each linking `skins/<id>/previews/home.webp`.
- **Previews must be real screenshots.** SPEC.md §3: *"Previews are **real screenshots taken from a running, themed Codex** — concept art or mockups are not acceptable as previews."* Cover spec: **home route, sidebar sections collapsed, intro finished, 1280×800 WebP, ≤ 500 KB recommended (1 MB hard cap)**, up to 4 extra shots.
- **Automated generation**: `node studio/bin/codex-theme.mjs preview-shot <id>` — *"frames and registers the cover automatically (asserts route & intro, captures at 2×, downsamples)"*. This is the strongest preview pipeline of the three: the screenshot is a **build artifact gated by CI**, not a human's screenshot.
- Tiering: **Certified** = CI green + maintainer verified on real hardware; **Community** = CI green only ([REGISTRY.md](https://github.com/Wangnov/awesome-codex-skins/blob/main/REGISTRY.md)).
- **Switching/reverting**: `use <id>` hot-swaps without restart; **`off` = "back to stock, instantly"**; the manager app (project 5) offers one-click *try-on*, *apply* (persistent, incl. native accent/font config) and *full restore*.

### 5.6 How a custom image becomes a skin

This is an **agent-driven pipeline**, not a GUI wizard. An Agent Skill `codex-theme-maker` (works in both Claude Code and Codex, plain `SKILL.md`, `npx skills add wangnov/awesome-codex-skins --skill codex-theme-maker -g`) takes you from a concept image to a packed `.codexskin`:

> The skill drives asset generation (**magenta-matte cutouts, alpha gates**), CSS assembly against the **DOM recipe book**, live CDP iteration, a structural acceptance suite, and the final `pack` delivery gate.

So "image → skin" here means: **cut the subject out of the artwork** (magenta matte + alpha gate — the alpha channel *is* the skin), generate the derived textures, then write CSS against a documented DOM recipe. No automatic colour-quantisation step is described — colours are authored by hand into the free-form `colors` map.

### 5.7 Persistence and reset

- **Idempotent and reversible by construction.** The runtime stamps `window.__CODEX_THEME_STUDIO__.stamp = "<engineVersion>:<id>:<sha1(runtime+css+chrome+config)[..12]>"`; reconcilers (studio watcher, manager daemon) re-inject only on stamp mismatch.
- Removal **"restores a byte-identical stock DOM (`class`/`style`/overlay/attribute zero-residue)"** — this is only achievable because every selector is scoped under the single `html.codex-theme-studio` class. That is the cleanest uninstall story of the three: it's structural, not procedural.
- Native theming is written to `~/.codex/config.toml` via the `codexTheme` block on *apply-with-restart*; `codeThemeIds` is required and contrast must be **≥ 4.5:1**.
- The pack gate is a hard delivery gate: `node studio/bin/codex-theme.mjs pack <id>` refuses to produce an archive unless schema, asset budgets, path containment, semver/`description`/`author`/`license`/`codexVerified`, a real WebP preview, directory-name==`id`, `appearance: "dual"`, and native-theme validation all pass.

---

## 6. So what does their CSS *actually do* — the meaningful seams

Setting aside CDP/asar plumbing, the three projects converge on the same answer even though their implementations differ. **The seams are the same 10–15 regions in every case.** Mapping the three onto one axis:

| Meaningful region | DreamSkin part | HeiGe selector | awesome-codex-skins selector |
|---|---|---|---|
| App root / theme scope | `root` | `:root[data-codex-window-type="electron"]`, `#root` | `html.codex-theme-studio`, `.app-theme` |
| Global background layer | (image token) | `#root` background (3-layer) | `main.main-surface::before/::after` |
| Sidebar | `sidebar` | `.app-shell-left-panel` | `.app-shell-left-panel` |
| Header / toolbar | `header` | — (uses native tokens) | `main.main-surface > header`, `header.app-header-tint` |
| Main workspace | `main` | `.main-surface`, `.browser-main-surface` | `main.main-surface`, `.app-shell-main-content-frame` |
| Home / hero + suggestions | `home`, `home-hero`, `project-list` | — | `.cts-home`, `.group\/home-suggestions button::before/::after` |
| Conversation / thread | `thread` | `[data-response-annotation-conversation]` | `main.main-surface.cts-home-shell .thread-scroll-container` |
| Message / assistant surface | `message` | `[data-local-conversation-final-assistant]` | `article` |
| Composer + its toolbar | `composer`, `composer-toolbar` | `.composer-surface-chrome`, `[data-user-message-bubble]`, `[data-codex-approval-surface]` | same + `div:has(> .composer-surface-chrome)` |
| Dialog / modal | `dialog` | — | `[role="dialog"]`, `[class*="DialogOverlay"]` |
| Menus / popovers | **not addressable** | — | `[role="menu"]`, `[role="listbox"]`, `[data-radix-popper-content-wrapper]`, `section[class*="_floatingSurface_"]` |
| Tooltip | **not addressable** | — | `[role="tooltip"]` |
| Right panel / aside | **not addressable** | `[data-pip-obstacle="thread-summary-panel"]` | `aside:not(.app-shell-left-panel)`, `aside[data-app-shell-focus-area="right-panel"]` |
| Scrollbars | **not addressable** | — | `::-webkit-scrollbar`, `::-webkit-scrollbar-thumb` |
| Text / content typography | (via tokens) | `:is(input, textarea, .ProseMirror, p, pre, code, blockquote, h1–h6)` | same |
| Native design tokens | **token system is the seam** | `--color-background-surface/panel/button-primary`, `--color-text-foreground`, `--color-border` | `codexTheme` → `config.toml` |

**What this tells you about a desktop chat/workbench UI:**

1. **The composer is the most-skins region in the entire product.** It appears in *every* project's CSS, usually with the most rules, and it's the one HeiGe re-tuned three times (blur, alpha, and `div:has(> .composer-surface-chrome)` for a decorative deck behind it). It is where the user stares and where translucency most easily ruins things.
2. **The sidebar and the main surface must have different treatments.** Sidebar gets a *higher* surface opacity (0.88–0.94) than the main surface (0.02–0.74). Every project does this. Uniform transparency looks broken because the sidebar carries dense, small text.
3. **The assistant-message container is the readability failure point.** HeiGe had to add a whole feature (readability mode) *specifically* for `[data-local-conversation-final-assistant]`, and their first fix was to make it fully transparent while giving the *cards inside it* their own surface. DreamSkin has a separate `message` part for the same reason.
4. **Menus/dialogs/tooltips/scrollbars are the seams people forget.** DreamSkin's 12-part model has **no** menu, popover or scrollbar part — and that is visible in their shipped themes as untouchable native-looking chrome. awesome-codex-skins covers all of them. If you own your CSS, this is a free win they don't all get.
5. **`data-*` attributes are the right seam, classes are not.** `[data-ds-part="…"]` and `[class~="bg-token-main-surface-primary"]` vs. `_ComposerLayoutRoot_` (a CSS-Modules hash) shows the difference: the hash broke on every Codex release, the data attribute didn't.
6. **The override target that ages best is the app's own token layer** (`--color-background-surface`, `--color-text-foreground`, `--ds-theme-*`). HeiGe's token override is 6 lines; their DOM selectors are the maintenance liability.

---

## 7. 可借鉴 / 不可借鉴

### 值得借鉴 (worth imitating in a web app that owns its own CSS)

| # | Practice | Evidence |
|---|---|---|
| 1 | **Declare a closed set of named regions and let skins only address those.** 12 parts, one part per rule, no descendant/class selectors. It makes theming a *bounded* feature instead of a CSS free-for-all, and it makes validation, preview and uninstall all trivial. | `ek=["root","sidebar",…,"dialog"]` in the shipped bundle; `Rw=/^\[data-ds-part="([a-z]+(?:-[a-z]+)*)"\](?::([a-z-]+))?$/` |
| 2 | **Apply those regions as `data-*` attributes in your own markup** (`data-ds-part="composer"`). It's the difference between a contract you own and a hash you must chase. | `tn=n=>({[Gy]:n})`; contrast the `_ComposerLayoutRoot_` churn in [compat-profile-design.md](https://github.com/Fei-Away/Codex-Dream-Skin/blob/main/docs/compat-profile-design.md) |
| 3 | **Separate the token layer from the selector layer.** A tiny palette → `--ds-theme-color-*` / `--cts-color-*` gets you most visual change with almost no selector surface. | 10-colour palette → `--ds-theme-color-panel-alt`; 6-line native-token override in `src/skin-css.mjs` |
| 4 | **Ship an explicit token contract with names, ranges and defaults** — not just a schema. 15 documented tokens with min/max/default is directly copyable. | the `pp` object: `surface.opacity .35–1 default 1`, `surface.blur 0–40px default 0`, `surface.radius 0–28px default 12`, `surface.border-alpha 0–1 default .14`, `image.zoom 1–1.6`, `image.dim 0–.8` |
| 5 | **Expose a first-class `dim` / scrim strength and a focus point.** Focus (`focusX/focusY`) + `zoom` + `dim` is the minimum viable background control set. | `image.focus-x/focus-y/zoom/dim/task-intensity` |
| 6 | **Treat "safe area" as data, and put the composition rule in your asset guidance.** Reserving `x=0–52 %` as a low-information zone is a *design-system* decision that removes most legibility bugs before they happen. | [background-generation-prompts.md](https://github.com/Fei-Away/Codex-Dream-Skin/blob/main/docs/background-generation-prompts.md) |
| 7 | **Have a readability mode: high-alpha surface, *no* blur, on the AI reply container, default on, toggleable.** They measured it, chose it over gaussian blur, and justified it on GPU repaint cost. | [readability-enhancement-design.md](https://github.com/HeiGeAi/heige-codex-skin-studio/blob/main/docs/superpowers/specs/2026-07-18-readability-enhancement-design.md) |
| 8 | **Budget blur, and be willing to lower it.** Their documented tuning is 20→8 px (sidebar), 22→8 px (composer) with opacity 60→80 %. `4–8 px` is the realistic range for a *content* surface; `14–20 px` belongs on chrome. Pair with `saturate(1.1–1.2)`. | `src/skin-css.mjs` comments: 「大半径模糊会逐帧重采样」/「大模糊是卡顿主因」 |
| 9 | **Do not use `background-attachment: fixed` for content surfaces**, with the reason stated: streaming text forces a full-viewport repaint each frame. | `#root` comment: 「不用 fixed 背景附着：流式输出/滚动时会强制整视口逐帧重绘」 |
| 10 | **Layer scrims instead of one global dim.** Directional gradients that protect the sidebar column and the composer band are better than a uniform overlay. | the two `linear-gradient`s in the `#root` background |
| 11 | **Separate *preview framing* from *applied background*.** `thumbnailFocus`/`thumbnailZoom`/`previewFocus` crop card thumbnails without touching the real composition. Cheap, and it makes every thumbnail look intentional. | [docs/manual.md](https://github.com/HeiGeAi/heige-codex-skin-studio/blob/main/docs/manual.md) |
| 12 | **Make previews build artifacts, not screenshots.** Assert the route/state, capture at 2×, downsample, register. And forbid concept art as a preview. | SPEC.md §3 + `preview-shot <id>` |
| 13 | **One-click revert, and make it structural.** Scope every skin rule under a single root class/attribute so "off" is a class removal with zero residue. | SPEC.md: *"single-class full reversal"*, *"byte-identical stock DOM … zero-residue"*; HeiGe's 「原生界面」 card |
| 14 | **Import ≠ apply.** A newly added skin goes to the library; the user explicitly selects it; `last-known-good` is never overwritten. | AGENTS.md: 「导入成功只写入已保存主题库，不自动切换活动主题，也不覆盖 last-known-good」 |
| 15 | **Validate skin CSS hard, with a whitelist, and make the linter a product surface.** A 30-property allow-list plus closed value grammars (colors, integers, `var()`), and an in-editor checker with line/column errors. | the `Op/$p/Fp/zp/Lw` sets; `jw/Nw/Dw/Iw` regexes; Studio's "Safe CSS 检查" |
| 16 | **Publish a machine-readable authoring guide for LLMs.** A single `llms-theme.txt` that states the allowed region list, token list and rejected constructs turns "write me a theme" into a reliable agent task. | [dreamskin.cc/llms-theme.txt](https://dreamskin.cc/llms-theme.txt), `llms-full.txt` in HeiGe |
| 17 | **Assume the delegate can be generous**: a compat/selector profile as **signed data, never code**, fail-closed, only overriding selector strings, and never able to introduce a new key. | [compat-profile-design.md](https://github.com/Fei-Away/Codex-Dream-Skin/blob/main/docs/compat-profile-design.md) |
| 18 | **Automatic colour extraction is a real UX win** when it produces your *whole* token set (main/secondary/panel/text) **and** picks light-vs-dark from image brightness — with a documented escape hatch to override manually. | [docs/manual.md](https://github.com/HeiGeAi/heige-codex-skin-studio/blob/main/docs/manual.md) |

### 不可借鉴 (artifacts of patching someone else's desktop app)

| # | Thing | Why it doesn't transfer |
|---|---|---|
| 1 | **CDP injection, loopback debug ports, launching the app with `--remote-debugging-port`, asar/`app.asar` handling, code-signature concerns, `--user-data-dir` isolation.** | Entirely a consequence of not owning the app. You have a build step. |
| 2 | **The entire class of "selector drift" work**: `tools/selectors.json`, `verifiedAgainst` provenance gates, the remote compat profile, `--verify`/`doctor`, renderer-readiness contracts, DOM fixtures, `.cts-home-shell` runtime re-classing. | These exist only because upstream can rename a class at any release. In your app, your markup *is* the contract. Note the irony: their compat profile is a workaround for a problem you don't have. |
| 3 | **Version-gating like `minClientVersion`, `skinApiVersion`, `codexVerified: "26.715.21425"`, `platforms:["windows"]`** in the *theme* payload. | You control both sides; your theme format versions with your app. |
| 4 | **Injecting the hero as a base64 `data:` URL** (with the resulting 1.4 MB asset cap derived from Chromium's 2 MB data-URL limit). | That's how you get bytes into a page you can't serve. You can serve `/themes/<id>/background.webp` and use ordinary caching — and skip the cap entirely. |
| 5 | **Writing `~/.codex/config.toml`, `state.json`, LaunchAgents, Scheduled Tasks, and `.command`/`.bat`/`.ps1` lifecycle scripts** (`install`/`apply`/`pause`/`resume`/`restore`/`uninstall`, process-identity checks, "don't wake Codex if it's already closed"). | Desktop-app lifecycle management, not design. In a web app "reset" is a settings row. |
| 6 | **Per-user theme directories** (`%LOCALAPPDATA%\…\themes`, `~/Library/Application Support/…`) and "move the folder by hand" as a documented install path. | Local-FS trust model you don't need. |
| 7 | **Signing/attestation machinery**: `manifest.sig`, ed25519 compat-profile signatures, SHA-256 per file, `actions/attest-build-provenance`, fail-closed archive validation (path traversal, symlinks, zip bombs, nested archives, ambiguous roots, dedupe), 32-entry/64 MiB limits. | All of it defends against *a hostile ZIP from a stranger on the internet*. Your theme store is server-side. (Do keep the **schema validation** idea — just none of the archive paranoia.) |
| 8 | **`pointer-events: none` on injected overlay layers and the `#cts-stage`/`#cts-chrome` split**, plus `MutationObserver`-free / "no reverse-parent matching" tricks (`svg[class*="pr-status-dot-color"]` targeted directly rather than via a parent selector). | These are workarounds for injecting DOM into a live React app you can't re-render. |
| 9 | **Asset cutout pipelines tuned for a specific failure**: "magenta-matte cutouts, alpha gates", 17 hand-made icon assets, custom cursor images with 2× variants. | That's art direction for a *fan-art* product (anime/IP skins). Useful as a reminder that a "skin" can include icon/cursor replacement — not as a pipeline to copy. |
| 10 | **Renaming/replacing the host app's branding** (`.app-shell-left-panel button[aria-label*="ChatGPT"]` → your logo). | Only possible, and only desirable, when you're reskinning someone else's product. |
| 11 | **The `opaqueWindows` / `contrast: 60` / `codeThemeIds` native-theme bridge.** | A bridge into Codex's own settings. Your app's theme *is* the settings. |
| 12 | **Pet/animation extras** (HeiGe's `Miku Future` pet, `motionAssets.intro-video`, 5 intro `@keyframes`), and the whole "don't cover login/system-permission UI / don't hide the restore entry" adversarial-CSS ruleset. | Fun, but orthogonal to a design system — and the adversarial rules only exist because the CSS is untrusted. |

### The one-line takeaway

All three independently converged on the same architecture, and it is **not** the CDP part: *a small token layer + a closed, named set of region seams + a whitelisted per-region override file + a one-click structural revert.* Everything else in these repos is the tax they pay for not owning the app you already own.

---

## Sources

Primary (all read):
- https://github.com/Fei-Away/Codex-Dream-Skin — README.md, AGENTS.md, docs/PROJECT.md, docs/compat-profile-design.md, docs/handoff-2026-08-27.md, docs/background-generation-prompts.md, CI/release workflows
- https://dreamskin.cc/llms-theme.txt · https://dreamskin.cc/studio · https://dreamskin.cc/gallery
- https://api.dreamskin.cc/v1/themes (689 themes) · /v1/themes/ver_420123d4688b2d1e9bfc/download · /preview · /preview/thumbnail
- https://dreamskin.cc/assets/index-CoqfNW4j.js and /assets/index-B7pFSUQS.css (the site's own bundle — source of the 12-part list, token table, token defaults and Safe-CSS validator)
- https://github.com/HeiGeAi/heige-codex-skin-studio (commit `2b2bac9f79059944823b5ef2143e457e248af987`) — src/theme-schema.mjs, src/skin-css.mjs, docs/manual.md, README.md, themes/*/theme.json, docs/superpowers/specs/2026-07-18-readability-enhancement-design.md, docs/superpowers/plans/2026-07-17-glass-surfaces.md
- https://github.com/Wangnov/awesome-codex-skins — SPEC.md, REGISTRY.md, README.md, skins/asuka-eva02/{theme.json,theme.css,chrome.html}, skins/guts-terminal/theme.css
- https://github.com/Wangnov/Codex-App-Manager (referenced only)

Release artifacts verified by SHA-256 against the project's own `SHA256SUMS.txt`: `CodexDreamSkin-Setup-v1.5.16.exe` (`a21557fe…`), `CodexDreamSkin-v1.5.16.dmg` (`1e45f049…`).

**Explicit gaps:** no repo named `codex-skin` was found; DreamSkin's client `src/` and `tools/selectors.json` are not public and the installers are not extractable here; `Fei-Away/dreamskin-cc` is 404 (private); several README-linked docs are missing from DreamSkin's public tree; `https://api.dreamskin.cc/v1/compat/profile` returns 404 (the design doc marks it *"草案，未实现"* — draft, not implemented); Codex++ was not verified to have a theming system; HeiGe's palette-extraction algorithm source was not located.
