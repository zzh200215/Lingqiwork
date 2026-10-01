# 主题 / 皮肤 / 自定义背景系统 —— 成熟开源实现调研报告

> 目标读者：正在为 **React 19 + Tailwind 3.4 + CSS 变量 + localStorage + FastAPI** 的本地优先 AI 工作台设计主题系统的工程师。
> 本文只写**可核对的实现事实**（文件路径、变量名、存储键、属性名），不写宣传语。凡未能核实的条目都显式标注「未核实」。

---

## 0. 调研方法与可信度说明

本机 `github.com` / `api.github.com` / `raw.githubusercontent.com` 被 hosts 加速器劫持到 `127.0.0.1`，**直连 GitHub 全部失败**。实际使用的三条通路：

| 通路 | 用途 | 示例 |
|---|---|---|
| jsDelivr gh CDN | 读**单个文件**（任意仓库、任意体积） | `https://cdn.jsdelivr.net/gh/<owner>/<repo>@<branch>/<path>` |
| jsDelivr data API | **列出仓库全部文件**（仓库 > 50 MB 会返回 403） | `https://data.jsdelivr.com/v1/packages/gh/<owner>/<repo>@<branch>?structure=flat` |
| `ghfast.top` 代理 | 读 `raw.githubusercontent.com` 的**原始文本**（`.go` / `.cljs` / `.js` 等 jsDelivr 会返回 `application/javascript` 而被拒的类型） | `https://ghfast.top/https://raw.githubusercontent.com/...` |

因此下面出现的每一个文件路径、变量名、localStorage 键，都是**实际抓取该文件后抄录的**。星标数只有 4 个项目成功核实，其余标注「未核实」。

---

## 1. shadcn/ui —— 令牌契约的「事实标准」

- 仓库：<https://github.com/shadcn-ui/ui> · 星标 **约 125k**（取自 ui.shadcn.com 站头链接文案）· 许可证 MIT
- 文档：<https://ui.shadcn.com/docs/theming>（Tailwind v4）、<https://v3.shadcn.com/docs/theming>（Tailwind v3 遗留文档）

### 1.1 变量名清单（已核实，来自 `apps/v4/app/globals.css`）

语义成对：**基色 + `-foreground`**，基色省略 `background` 后缀。

```
--background / --foreground      --card / --card-foreground
--popover / --popover-foreground --primary / --primary-foreground
--secondary / --secondary-foreground
--muted / --muted-foreground     --accent / --accent-foreground
--destructive / --destructive-foreground
--border  --input  --ring
--chart-1 … --chart-5
--sidebar / --sidebar-foreground / --sidebar-primary / --sidebar-primary-foreground
--sidebar-accent / --sidebar-accent-foreground / --sidebar-border / --sidebar-ring
--radius
```

站点自身还额外定义了 `--surface`、`--surface-foreground`、`--code`、`--code-foreground`、`--code-highlight`、`--code-number`、`--selection`、`--selection-foreground`。

### 1.2 明暗切换机制

`--radius` 在 `:root` 定义一次，暗色只在 `.dark` 覆盖同名变量。Tailwind v4 用 `@custom-variant dark (&:is(.dark *))` 把 `dark:` 绑到 `.dark` 祖先类上。半径派生：

```
--radius-sm: calc(var(--radius) * 0.6);
--radius-lg: var(--radius);
--radius-4xl: calc(var(--radius) * 2.6);
```

### 1.3 `hsl(var(--x))` 模式：**当前与历史两种形态**

这一点必须说清，因为它直接决定 Tailwind 3.4 的配置写法：

- **当前 shadcn（v3 文档与 v4 文档都是）**：变量里存**完整颜色值**，例如 `--background: oklch(1 0 0);`，然后在 `@theme inline` 里 1:1 映射 `--color-background: var(--background);`。
- **v3 时代被大量项目复制的 `hsl(var(--x))` 形态**：变量里只存 **HSL 通道三元组**（如 `--background: 0 0% 100%`），Tailwind 配置里再包一层 `hsl()`。
- **tweakcn 至今仍两种都支持，并给出了转换实现**（这是本次找到的最硬证据）：`utils/apply-theme.ts` 中写变量前先做 `colorFormatter(value, "hsl", "4")`，然后 `applyStyleToElement(root, key, hslValue)`；其 `store/preferences-store.ts` 明确列出：

```ts
const colorFormatsByVersion = {
  "3": ["hex", "rgb", "hsl"],
  "4": ["hex", "rgb", "hsl", "oklch"],
};
// tailwindVersion 默认 "4"、colorFormat 默认 "oklch"；
// 切到 "3" 且当前是 oklch 时，自动把 colorFormat 降级为 "hsl"
```

**对本项目的结论**：Tailwind 3.4 想保留 `bg-background/50` 这类透明度修饰符，就必须走**通道三元组**形态，在 `tailwind.config.ts` 里写：

```ts
colors: {
  background: "hsl(var(--background) / <alpha-value>)",
  border:     "hsl(var(--border) / <alpha-value>)",
}
```

若改用完整颜色值（`oklch(...)`）+ `var(--background)`，透明度修饰符会失效，需要用 `color-mix(in oklab, var(--x) 50%, transparent)` 代替。

### 1.4 自定义主题如何「安装」：registry 契约

`registry-item.json` schema（<https://ui.shadcn.com/schema/registry-item.json>）里有专门的 `registry:theme` 类型和 `cssVars` 字段，语义是**合并进项目现有变量**：

```json
"cssVars": {
  "theme": { "…": "仅 Tailwind v4 的 @theme 变量" },
  "light": { "--primary": "…" },
  "dark":  { "--primary": "…" }
}
```

也就是说：**内置主题 = `:root` / `.dark` 两块 CSS；第三方主题 = 一个带 `cssVars.light` / `cssVars.dark` 的 JSON，由 CLI 合并**。这是「默认主题」与「用户主题」分离的最干净范式。

---

## 2. next-themes —— FOUC、持久化、属性接缝的参考实现

- 仓库：<https://github.com/pacocoursey/next-themes> · 许可证 MIT（`license.md`）
- 关键源文件：`next-themes/src/index.tsx`、`next-themes/src/script.ts`、`next-themes/src/types.ts`

### 2.1 默认值与持久化

| 项 | 值（已核实） |
|---|---|
| localStorage 键 | `storageKey = 'theme'`（默认） |
| 默认主题 | `defaultTheme = enableSystem ? 'system' : 'light'` |
| 主题列表 | `themes = ['light', 'dark']` |
| DOM 属性 | `attribute = 'data-theme'`（也可 `'class'`，或 `['class','data-x']` 数组） |
| 主题名 → 属性值映射 | `value={{ pink: 'my-pink-theme' }}`，**只影响 DOM，不影响 localStorage** |

`setTheme` 每次写 `localStorage.setItem(storageKey, value)`；另外监听 `window.addEventListener('storage')` 做**跨标签页同步**，且 `if (!e.newValue) setTheme(defaultTheme)` 处理用户手动清空 localStorage 的情况。

### 2.2 防 FOUC：注入内联脚本

`ThemeScript` 组件把 `script` 函数**序列化成字符串**，用 `dangerouslySetInnerHTML` 注入到 `<head>`：

```tsx
const scriptArgs = JSON.stringify([attribute, storageKey, defaultTheme,
  forcedTheme, themes, value, enableSystem, enableColorScheme]).slice(1, -1)

<script suppressHydrationWarning
  nonce={typeof window === 'undefined' ? nonce : ''}
  dangerouslySetInnerHTML={{ __html: `(${script.toString()})(${scriptArgs})` }} />
```

脚本体（`script.ts`）核心逻辑：`localStorage.getItem(storageKey) || defaultTheme` → 若为 `system` 则用 `matchMedia('(prefers-color-scheme: dark)')` 解析 → `el.setAttribute(attr, theme)`（或 class 增删）→ 再设 `el.style.colorScheme = theme` 让原生控件（滚动条、表单）也跟着变。整个 `try/catch` 包住，隐私模式下 localStorage 抛错也不会白屏。

### 2.3 文档化的坑（README 原文）

- **必须**给 `<html>` 加 `suppressHydrationWarning`，否则 React 报水合警告（该属性只作用一层）。
- `useTheme()` 在挂载前返回 `undefined`，**直接渲染主题切换 UI 必然水合不匹配**。官方解法：`const [mounted, setMounted] = useState(false)`，挂载后才渲染；或 `dynamic(..., { ssr: false })`；并建议渲染骨架避免 CLS。
- 主题相关图片的官方写法：未解析前返回 1×1 透明 GIF 的 data URI；或用 CSS `[data-theme='dark'] [data-hide-on-theme='dark'] { display: none }` 同时渲染两份。
- `disableTransitionOnChange`：切主题前插入 `*,*::before,*::after{transition:none!important}`，强制一次 `getComputedStyle` 重排后 `setTimeout(..., 1)` 移除——避免切主题时各组件过渡时长不一致导致的「拖影」。
- `nonce` 用于 CSP；Cloudflare Rocket Loader 会延迟内联脚本从而**破坏防闪烁**，需 `scriptProps={{ 'data-cfasync': 'false' }}`。
- 开发模式仍可能闪一下，生产构建不会。
- **不能**把主题属性放到 `<body>` 或其它元素上（官方明确不支持）。

---

## 3. tweakcn —— 可视化主题编辑器 / v3+v4 双格式 / 服务端主题库

- 仓库：<https://github.com/jnsahaj/tweakcn> · 许可证文件 `LICENSE`（11,357 字节，Apache-2.0 全文长度；未逐字核对）· 星标未核实

### 3.1 主题的数据形状（`types/theme.ts`，zod schema）

```ts
themeStylePropsSchema = z.object({ background, foreground, card, "card-foreground",
  popover, "popover-foreground", primary, "primary-foreground", secondary,
  "secondary-foreground", muted, "muted-foreground", accent, "accent-foreground",
  destructive, "destructive-foreground", border, input, ring,
  "chart-1"…"chart-5", sidebar, "sidebar-foreground", "sidebar-primary",
  "sidebar-primary-foreground", "sidebar-accent", "sidebar-accent-foreground",
  "sidebar-border", "sidebar-ring",
  "font-sans", "font-serif", "font-mono", radius,
  "shadow-color","shadow-opacity","shadow-blur","shadow-spread",
  "shadow-offset-x","shadow-offset-y", "letter-spacing", spacing })
themeStylesSchema = z.object({ light: themeStylePropsSchema, dark: themeStylePropsSchema })
```

注意它把 **shadcn 的颜色令牌 + 字体 + 圆角 + 阴影 + 字距 + 间距**统一成一个扁平 key 空间，`light`/`dark` 两份。`ThemePreset` 类型带 `source?: "SAVED" | "BUILT_IN"`，内置预设全量放在 `utils/theme-presets.ts`（约 103 KB）。

### 3.2 应用机制（`utils/apply-theme.ts`）

`applyThemeToElement(themeState, rootElement)`：`updateThemeClass` 增删 root 的 `.dark` → 把 `COMMON_STYLES`（圆角、字体、字距等非颜色键）**统一取 `light` 那一份**应用到 root → 颜色键按当前 mode 取值、经 `colorFormatter(value,"hsl","4")` 转成 HSL 三元组后 `root.style.setProperty('--' + key, value)` → 最后 `setShadowVariables` 展开阴影。

> 这条「**非颜色令牌只定义一次、颜色令牌分模式**」的划分非常值得抄：避免 `--radius` 在 light/dark 各写一遍导致不一致。

### 3.3 防 FOUC 的内联脚本（`components/theme-script.tsx`）

脚本里**硬编码了 `storageKey = "editor-storage"`**（zustand persist 的键），读取路径是 `JSON.parse(localStorage.getItem("editor-storage"))?.state?.themeState`；取不到就用 `matchMedia('(prefers-color-scheme: dark)')` 决定 mode；然后 `root.style.setProperty('--'+styleName, value)` 逐个写变量。它还把 `defaultLightThemeStyles` / `defaultDarkThemeStyles` 用 `JSON.stringify` 直接嵌进脚本文本作为兜底。脚本额外做了一件事：**在首屏就按主题字体注入 Google Fonts `<link>`**，避免字体后加载导致的排版跳动。

### 3.4 持久化分层

| 数据 | 位置 |
|---|---|
| 主题编辑状态（`themeState`） | localStorage `editor-storage`（zustand `persist`） |
| 编辑器偏好（tailwindVersion / colorFormat / packageManager / colorSelectorTab） | localStorage `preferences-storage`（zustand `persist`，`store/preferences-store.ts`） |
| 用户保存的主题 | **Postgres**，drizzle `theme` 表：`id / userId / name / styles json / createdAt / updatedAt`（`db/schema.ts`） |
| 社区主题 | `community_theme`（含 `publishedAt`、`likeCount` + 两个索引）、`community_theme_tag`、`theme_like` |

**这是「主题存后端」的教科书案例**：编辑态与偏好留在 localStorage（快、离线可用），命名主题与社区分享走后端（跨设备、可搜索、可点赞）。同时 `app/r/themes/[id]/route.ts` 与 `public/r/registry.json`（239 KB）说明它**把后端主题再以 shadcn registry 格式对外分发**——一套数据，两种出口。

### 3.5 可访问性

仓库里有 `utils/contrast-checker.ts`、`hooks/use-contrast-checker.ts`、`components/editor/contrast-checker.tsx`、`hooks/use-ai-theme-generation.ts`。**对比度检查是编辑器的一等公民**，不是事后补丁。

---

## 4. Tabler —— 多维度 `data-bs-*` 属性 + `tabler-*` 存储 + URL 三写

- 仓库：<https://github.com/tabler/tabler> · 文档：<https://docs.tabler.io/ui/getting-started/color-modes> · 许可证 MIT
- 脚本源码：`core/js/tabler-theme.ts` → 构建产物 `@tabler/core/dist/js/tabler-theme.min.js`

Tabler 把「主题」拆成 **10 个独立维度**，每个维度 = 一个 `<html>` 属性 + 一个 localStorage 键 + 一个 URL 查询参数：

| 设置 | 属性 | 默认 | 取值 |
|---|---|---|---|
| 明暗 | `data-bs-theme` | `auto` | `light` / `dark` / `auto` |
| 灰阶基底 | `data-bs-theme-base` | `neutral` | slate/gray/zinc/neutral/stone |
| 字体 | `data-bs-theme-font` | `sans-serif` | sans-serif/serif/monospace/comic |
| 主色 | `data-bs-theme-primary` | `blue` | blue/azure/indigo/purple/pink/red/orange/yellow/lime/green/teal/cyan/inverted |
| 圆角 | `data-bs-theme-radius` | `1` | 0 / 0.5 / 1 / 1.5 / 2 |
| 导航位置 | `data-bs-navbar-position` | `horizontal` | horizontal / vertical |
| 容器宽度 | `data-bs-layout` | `default` | default / fluid / boxed |
| 导航栏行为 | `data-bs-navbar` | `default` | default / sticky |
| 导航配色 | `data-bs-navbar-theme` | `default` | default / dark / primary |
| 侧边栏 | `data-bs-sidebar` | `default` | default / folded / folded-hover |

关键设计点，逐条都值得抄：

1. **「默认值不写进 DOM」**：`data-bs-theme-primary="blue"` 永远不会被写出，因为 blue 就是默认，浏览器回落到内置样式即可。属性只在**偏离默认**时出现。
2. **localStorage 键统一前缀**：每个键存为 `tabler-<key>`，例如 `tabler-theme`、`tabler-theme-primary`。前缀让清理与命名空间隔离变得平凡。
3. **三写一致**：设置面板的 change 处理器同时做三件事，代码就是文档给的四行：

```js
document.documentElement.setAttribute('data-bs-' + key, value)
window.localStorage.setItem('tabler-' + key, value)
url.searchParams.set(key, value)
window.history.pushState({}, '', url)
```

   URL 参数**优先级最高**，会覆盖并回写 localStorage，于是「分享一条链接 = 分享一套外观」。切换按钮甚至可以是纯 `<a href="?theme=dark">`，零 JS。
4. **`auto` 永远被解析掉**：脚本在加载时读一次 `prefers-color-scheme` 并把 `data-bs-theme` 设成解析后的 `light`/`dark`，**从不写字符串 `auto`**；同时持续监听系统变化，运行中切换系统主题会实时更新，无需刷新。
5. **FOUC 的明确处方**（原文照抄要点）：脚本必须**内联放在 `<body>` 开标签之后的第一件事**，不能加 `defer`/`async`，也不能放 `<head>`。否则「页面先以浅色绘制、片刻后翻成深色」= 可见的错误主题闪烁。主 bundle `tabler.min.js` 仍然照常 `defer` 放 `</body>` 前，两者分开。
6. **服务端渲染兜底**：文档明确列出第三种设置来源——「如果你已经从 cookie 或账号设置知道访客偏好，就自己把 `data-bs-*` 渲染在 `<html>` 上；脚本会把它当作起始值，只在存在存储值或 URL 参数时才替换」。**这是把「后端设置 JSON」和「localStorage」缝合起来的官方答案**（见 §15）。
7. **重置**：`removeAttribute('data-bs-theme')` + `localStorage.removeItem('tabler-theme')`，两件事都要做。
8. **无障碍警告**（原文）：`auto` 是默认且可访问的选项；若强制 light/dark，仍要提供可见的切换入口，因为用户会按时间/光线改偏好。切 `theme-primary`/`theme-base`/`theme-radius` **会改变整页对比度**，任何自定义组合都要重新检查 WCAG AA——「有些主色在其默认色阶下配白字过不了 AA」。

---

## 5. Mantine —— 主题对象 + 色系管理器 + `ColorSchemeScript`

- 仓库：<https://github.com/mantinedev/mantine> · 星标 **31.8k** · 许可证 MIT
- 关键文件（已核实）：
  - `packages/@mantine/core/src/core/MantineProvider/color-scheme-managers/local-storage-manager.ts`
  - `packages/@mantine/core/src/core/MantineProvider/ColorSchemeScript/ColorSchemeScript.tsx`

### 5.1 localStorage 键与属性

```ts
export function localStorageColorSchemeManager({
  key = 'mantine-color-scheme-value',   // ← 默认键名
}: LocalStorageColorSchemeManagerOptions = {}): MantineColorSchemeManager
```

管理器实现 5 个方法：`get(defaultValue)`（含 `typeof window === 'undefined'` 的 SSR 短路与 `isMantineColorScheme` 校验）、`set`、`subscribe`（监听 `storage` 事件且比对 `event.storageArea === window.localStorage && event.key === key`，实现跨标签同步）、`unsubscribe`、`clear`。写入失败只 `console.warn`，不抛。

DOM 属性是 `data-mantine-color-scheme`（不是 `data-theme`）。

### 5.2 `ColorSchemeScript`：防 FOUC 的官方内联脚本

```tsx
`try {
  var _colorScheme = window.localStorage.getItem("${localStorageKey}");
  var colorScheme = _colorScheme === "light" || _colorScheme === "dark" || _colorScheme === "auto"
    ? _colorScheme : "${defaultColorScheme}";
  var computedColorScheme = colorScheme !== "auto" ? colorScheme
    : window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  document.documentElement.setAttribute("data-mantine-color-scheme", computedColorScheme);
} catch (e) {}`
```

组件签名：`{ forceColorScheme?, defaultColorScheme = 'light', localStorageKey = 'mantine-color-scheme-value' }`，脚本标签带 `data-mantine-script` 便于测试定位。注意 **`auto` 是存储值之一，但从不写进 DOM**——与 Tabler 同一思路。

---

## 6. daisyUI + theme-change —— 主题即 CSS 块 + 极简持久化助手

- 仓库：<https://github.com/saadeghi/daisyui> · 文档：<https://daisyui.com/docs/themes/> · 许可证 MIT
- 关键路径（已核实，来自仓库文件清单）：
  - `packages/daisyui/src/themes/*.css` —— **每个内置主题一个文件**（light/dark/cupcake/cyberpunk/dracula/… 共 30+ 个，每个约 1 KB）
  - `packages/daisyui/functions/variables.css` —— 主题变量名清单（全是空值，作为 schema 用）
  - `packages/daisyui/functions/variables.js` / `themeOrder.js` / `generateThemes.js`
  - `packages/bundle/daisyui-theme.js`（46 KB）—— 供 CDN 直接用的主题 JS
  - `packages/docs/src/routes/(routes)/theme-generator/+page.svelte` —— 在线主题生成器

### 6.1 令牌契约（`src/themes/light.css` 全文核心）

```css
color-scheme: light;
--color-base-100: oklch(100% 0 0);
--color-base-200: oklch(98% 0 0);
--color-base-300: oklch(95% 0 0);
--color-base-content: oklch(21% 0.006 285.885);
--color-primary: oklch(45% 0.24 277.023);
--color-primary-content: oklch(93% 0.034 272.788);
/* secondary / accent / neutral / info / success / warning / error 同构 */
--radius-selector: 0.5rem;  --radius-field: 0.25rem;  --radius-box: 0.5rem;
--size-selector: 0.25rem;   --size-field: 0.25rem;
--border: 1px;  --depth: 1;  --noise: 0;
```

规律：**每个颜色都有配对的 `-content`（前景）**；`color-scheme` 是主题的一部分；`--depth`/`--noise` 是效果开关。`variables.css` 里这份清单被重列为空值的 `@theme { … }` 块，起「接口声明」作用。

### 6.2 默认主题 vs 自定义主题

- 启用：`@plugin "daisyui" { themes: light --default, dark --prefersdark; }`（Tailwind v4 写法）；`themes: all` 开全部；`themes: false` 全关。Tailwind 3.4 对应 `tailwind.config.js` 里的 `daisyui: { themes: [...] }`。
- 应用：`<html data-theme="cupcake">`，且**可嵌套**——`<div data-theme="light">` 内部强制浅色，`<span data-theme="retro">` 再套一层，无层数限制。
- 新增自定义：`@plugin "daisyui/theme" { name: "mytheme"; default: true; prefersdark: false; color-scheme: light; --color-primary: …; }`。
- **覆盖内置主题**：用**同名**声明，只写要改的变量，其余继承原主题——「部分覆盖 + 继承」比 fork 整份 CSS 好维护得多。
- 单主题专属样式：直接 `[data-theme="light"] { .my-btn { … } }`。
- 把 `dark:` 绑定到某个具名主题：`@custom-variant dark (&:where([data-theme=night], [data-theme=night] *));`。

### 6.3 持久化：`theme-change`（官方推荐）

- 仓库：<https://github.com/saadeghi/theme-change>（npm 包 `theme-change`）
- 一个 HTML 属性 `data-set-theme` 搞定：`<button data-set-theme="dark">`、`<select data-set-theme>`、`<input type="checkbox" value="dark" data-set-theme>`、轮换按钮 `<button data-set-theme="dark,light,pink">`。
- **持久化在 localStorage 里**，且「所有带相同 `data-set-theme` 的控件自动同步」。`data-key="admin-panel"` 可让不同区域用不同命名空间。
- 无障碍：`data-act-attribute="aria-pressed:true"` 在激活时加 ARIA 状态、失活时移除。
- React 用法：`useEffect(() => { themeChange(false) }, [])`，参数 `false` 表示控件是挂载后才出现的。
- 它同时支持 `[data-theme="dark"]` 和 `:root:has(input.theme-controller[value=mytheme]:checked)` 两种选择器——后者是**纯 CSS 的主题控制器**（一个隐藏 radio + `:has()`），零 JS 切主题。

---

## 7. Open Props + Radix Colors —— 令牌分层与色阶语义

### 7.1 Open Props

- 仓库：<https://github.com/argyleink/open-props> · 许可证 MIT（`LICENSE` 1,068 字节）· 星标未核实
- 关键路径（已核实）：`src/props.colors.css`、`src/props.colors-hsl.css`、`src/props.colors-oklch.css`、`src/props.sizes.css`、`src/props.fonts.css`、`src/props.shadows.css`、`src/props.shadows.light.css`、`src/props.shadows.dark.css`、`src/props.easing.css`、`src/props.animations.css`、`src/extra/theme.light.css`、`src/extra/theme.dark.css`、`src/extra/theme.light.switch.css`、`src/extra/theme.dark.switch.css`、`open-props.resolver.json`

**「按维度分文件 + 按模式分文件」的组织方式**：每个维度一个 `props.<dimension>.css`，需要区分明暗的维度再拆 `.light.css` / `.dark.css`；`.switch.css` 后缀表示「跟随选择器自动切换」版本。

`src/extra/theme.dark.switch.css` 的核心（这是明暗切换的完整契约）：

```css
:where([data-theme="dark"], .dark, .dark-theme) {
  color-scheme: dark;
  --text-1: var(--gray-0);   --text-2: var(--gray-4);
  --surface-1: var(--gray-9); --surface-2: var(--gray-8);
  --surface-3: var(--gray-7); --surface-4: var(--gray-6);
  --shadow-strength: 10%;
  --shadow-color: 220 40% 2%;
  /* 组件级覆盖 */
  & :where(button,.btn) { --_bg: var(--_bg-dark); }
}
```

要点：**同时接受 `[data-theme="dark"]`、`.dark`、`.dark-theme` 三种入口**（兼容性优先）；用 `:where()` 保持零特异性，方便用户覆盖；颜色用**语义层名**（`--text-1`/`--surface-1`）而不是色相名，语义层再指向具体色阶（`var(--gray-9)`）——这就是三层令牌（原始色阶 → 语义 → 组件）的最小实现。

### 7.2 Radix Colors 的 12 级色阶语义

- 仓库：<https://github.com/radix-ui/colors> · 文档：<https://www.radix-ui.com/colors/docs/palette-composition/understanding-the-scale>

| 步 | 用途 |
|---|---|
| 1 | 应用背景 |
| 2 | 微妙背景（条纹表格、代码块、卡片、侧边栏） |
| 3 | UI 元素背景（常态） |
| 4 | UI 元素背景（hover） |
| 5 | UI 元素背景（active / selected） |
| 6 | 微妙边框与分隔线（非交互组件） |
| 7 | 交互组件边框、焦点环 |
| 8 | 交互组件强边框、焦点环 |
| 9 | 实心背景（**全阶最高彩度**，也用于 Logo、覆盖层、彩色阴影） |
| 10 | 实心背景 hover |
| 11 | 低对比文字 |
| 12 | 高对比文字 |

这套编号本身就是**可访问性契约**：11/12 保证在 1/2 上有足够对比，9 保证配白/黑字可读。每种颜色都有 light/dark/alpha/P3 四个变体。**把「第几阶」写进令牌命名，比 `primary-light-2` 之类的命名更能防止误用。**

---

## 8. Obsidian —— PKM 主题的事实标准（闭源，但文档完备）

- 产品站：<https://obsidian.md>（闭源专有软件；主题生态完全开放）
- 文档：<https://docs.obsidian.md/Themes/App+themes/Build+a+theme>、<https://help.obsidian.md/snippets>、<https://docs.obsidian.md/Reference/CSS+variables/CSS+variables>

### 8.1 主题的物理结构

- 主题目录：`<vault>/.obsidian/themes/<ThemeName>/`
- 必需两个文件：`theme.css` + `manifest.json`；**目录名必须与 `manifest.json` 的 `name` 完全一致**。
- 改 `manifest.json` 后**必须重启 Obsidian**；改 `theme.css` 不用。
- 开发流程：Settings → Appearance → Themes 下拉选中主题。
- 官方模板仓库：<https://github.com/obsidianmd/obsidian-sample-theme>（GitHub template repo）。

### 8.2 CSS 变量的选择器约定（关键）

```css
.theme-dark  { --background-primary: #18004F; --background-secondary: #220070; }
.theme-light { --background-primary: #ECE4FF; --background-secondary: #D9C9FF; }
body         { --font-text-theme: Georgia, serif; --ribbon-background: magenta; }
:root        { --input-focus-border-color: Highlight; }
```

官方给出的选择器取舍规则，直接可抄：

- **两种模式都要用同一值时放 `body`**；
- **只有随明暗变化时才用 `.theme-dark` / `.theme-light`**；
- **`:root` 要慎用**，能放 `body` / `.theme-dark` / `.theme-light` 就别放 `:root`（`:root` 常用于插件变量，用户覆盖时容易打架）。

已核实的具体变量名举例：`--background-primary`、`--background-secondary`、`--ribbon-background`、`--font-text-theme`、`--h1-color`…`--h6-color`、`--input-focus-border-color`、`--input-hover-border-color`、`--input-disabled-border-color`、`--input-unfocused-border-color`、`--input-focus-outline`。文档称**暴露 400+ 个 CSS 变量**。

变量按域分层组织在参考文档里：Foundations（Borders/Colors/Cursor/Icons/Layers/Radiuses/Spacing/Typography）、Components（Button/Checkbox/Dialog/Modal/Popover/Slider/Tabs/Toggle…）、Editor（Block/Blockquote/Callout/Code/Embed/File/Heading/Link/List/Properties/Table/Tag）、Plugins（Canvas/File explorer/Graph/Search）、Window（Ribbon/Scrollbar/Status bar/Window frame/Workspace）、Publish。**「Foundations → Components → 具体域 → 插件」这套分层，就是给 400 个变量建立可发现性的方法。**

### 8.3 CSS 片段（Snippets）：比主题更轻的一层

- 位置：配置目录下 `snippets/`（即 `.obsidian/snippets/*.css`）。
- 操作路径：**Settings → Appearance → CSS snippets → 「Open snippets folder」→ 放入 `.css` → 「Reload snippets」→ 打开开关**。
- **保存文件即自动生效，无需重启**；偶尔需要「Reload Obsidian without saving」命令。
- 支持每篇笔记的类名：用 frontmatter 属性 `cssclasses: [red-border]`，CSS 里写 `.red-border img { … }`。这是「主题之外的局部皮肤」的优雅做法。
- 变量覆盖示例：`body { --h1-color: red; --h2-color: orange; … }`。

### 8.4 自定义背景图（社区惯例）

Obsidian 没有内置「上传背景图」UI，社区统一走 **CSS 片段**路线：在 snippet 里给 `.app-container` / `.workspace` 设 `background-image`，再叠加半透明遮罩层或降低图片不透明度，以保住前景文字对比度。核心变量是 `--background-primary` / `--background-secondary`——用 CSS 片段改这两个变量会影响全局（论坛里大量讨论正是因为「改它会波及很多地方」）。**教训：背景图不要通过改 `--background-*` 变量实现，而应作为独立图层叠在内容之下。**

### 8.5 分发方式

社区主题/插件通过应用内浏览器安装；官方仓库 <https://github.com/obsidianmd/obsidian-releases> 维护 `community-css-themes.json` 与 `community-plugins.json` 清单。主题作者按文档用 GitHub Actions 发布 release（<https://docs.obsidian.md/Themes/App+themes/Release+your+theme+with+GitHub+Actions>），再提交 PR 到该清单。

---

## 9. SiYuan —— 主题存后端 `conf.json` + 主题包 + 代码片段 + 安全模式

- 仓库：<https://github.com/siyuan-note/siyuan> · 许可证 **AGPL-3.0**（源文件头已核实）· 星标未核实
- 关键文件（已核实）：`kernel/model/conf.go`、`kernel/conf/*.go`、`app/appearance/themes/daylight/theme.json`

### 9.1 后端设置 JSON：`~/.siyuan/conf.json`

`AppConf` 结构体（Go）里 `Appearance *conf.Appearance \`json:"appearance"\`` 就是外观设置。同一文件还保存 `lang`、`fileTree`、`editor`、`export`、`uiLayout`、`keymap`、`sync`、`api`、`repo`、`snippet` 等。保存路径 `filepath.Join(util.ConfDir, "conf.json")`，`Conf.Save()` 用 `MarshalIndentJSON(snapshot, "", "  ")` 写盘，写前先加密 `AI.EncryptAPIKeys()` / `OIDC.EncryptClientSecret()` / `Secrets.Encrypt()`。

从源码可直接读出的外观相关字段：

| 字段 | 说明 |
|---|---|
| `Appearance.ThemeLight` | 浅色主题名，默认 `"daylight"` |
| `Appearance.ThemeDark` | 深色主题名，默认 `"midnight"` |
| `Appearance.ThemeJS` | 是否允许主题携带 JS（bool） |
| `Appearance.Icon` | 图标包，默认 `"litheness"`；`ant`/`material` 在 v3.7.0 被移除并自动迁移 |
| `Appearance.CodeBlockThemeLight` / `CodeBlockThemeDark` | 代码块高亮主题，默认 `"github"` / `"dracula"` |
| `Appearance.Lang` | 外观语言 |
| `Appearance.StatusBar` / `Notifications` / `EntryVisibility` | 状态栏 / 通知 / 条目可见性 |
| `Snippet.EnabledCSS` / `Snippet.EnabledJS` | CSS / JS 代码片段开关 |

**非常值得抄的一点——「安全模式」的破坏性兜底**：桌面端渲染进程崩溃恢复后，主进程以 `--safe-mode` 注入；启动时代码直接覆盖并持久化：

```go
Conf.Appearance.ThemeLight = "daylight"
Conf.Appearance.ThemeDark  = "midnight"
Conf.Appearance.Icon       = "litheness"
Conf.Appearance.ThemeJS    = false
Conf.Bazaar.PetalDisabled  = true
Conf.Snippet.EnabledCSS    = false
Conf.Snippet.EnabledJS     = false
Conf.Save()
```

即：**主题/片段能改的东西足够多，就必须有一条「全部关掉」的自救路径**。同时 `Conf.System.SafeMode = false` 被显式排除在持久化之外，避免跨启动残留。

另有 `GetMaskedConf()`：把 `UserData`、`MCPOAuth`、`CookieKey` 清空、`AccessAuthCode` 换成 `"*******"` 后再返回给前端——**主题设置接口不能顺手把密钥漏出去**。

### 9.2 主题包的形状

`app/appearance/themes/daylight/theme.json` 全文：

```json
{
  "name": "daylight",
  "author": "Vanessa",
  "url": "https://github.com/Vanessa219",
  "version": "1.1.2",
  "frontends": ["all"],
  "modes": ["light"]
}
```

配套 `theme.css`。**`modes` 声明该主题属于 light 还是 dark**（决定它出现在哪个选择器下），`frontends` 声明适用端（桌面/移动/all）。这比「靠 CSS 选择器猜」明确得多。主题通过集市（Bazaar）分发。

---

## 10. AFFiNE —— next-themes + 主题编辑器 + 全局状态

- 仓库：<https://github.com/toeverything/AFFiNE> · 许可证未核实 · 星标未核实
- 关键文件（均已核实）：
  - `packages/frontend/core/src/modules/theme/index.ts`、`.../entities/theme.ts`、`.../services/theme.ts`
  - `packages/frontend/core/src/modules/theme-editor/index.ts`、`.../services/theme-editor.ts`
  - `packages/frontend/core/src/desktop/dialogs/setting/general-setting/appearance/index.tsx`
  - `.../appearance/theme-editor-setting.tsx`

### 10.1 明暗：直接复用 next-themes

外观设置页里 `import { useTheme } from 'next-themes'`，三个选项就是 `system` / `light` / `dark`：

```tsx
const { setTheme, theme } = useTheme()
<RadioGroup items={radioItems} value={theme} width={250}
  onChange={value => { setTheme(value) }} />
```

`entities/theme.ts` 里把 next-themes 的字符串映射成 Blocksuite 的枚举：`theme === 'dark' ? ColorScheme.Dark : ColorScheme.Light`，再用 `createSignalFromObservable` 暴露成 signal 供编辑器消费。**这就是「主题名」与「编辑器内部色板枚举」之间的解耦点**。

### 10.2 自定义主题：独立的 `theme-editor` 模块 + `GlobalState`

```ts
private readonly _key = 'custom-theme';
customTheme$ = LiveData.from(this.globalState.watch<CustomTheme>(this._key).pipe(
  map(value => { if (!value) return { light: {}, dark: {} }; /* 清理空值 */ })))
setCustomTheme(theme) { this.globalState.set(this._key, theme) }
updateCustomTheme(mode: 'light' | 'dark', key, value?) { /* 空值即 delete */ }
reset() { this.globalState.set(this._key, { light: {}, dark: {} }) }
```

`CustomTheme` 的形状与 tweakcn 完全一致：`{ light: Record<string,string>, dark: Record<string,string> }`，**稀疏覆盖**（只存用户改过的键，空值即删除）。持久化交给 `GlobalState`（`modules/storage`），UI 侧只暴露 `modified$` 决定要不要显示「重置」按钮。

编辑入口：`theme-editor-setting.tsx` 里，桌面端调 `desktopApi.handler.ui.openThemeEditor()`，Web/移动端 `urlService.openPopupWindow(location.origin + '/theme-editor')`——**主题编辑器是一个独立路由页**，不是设置页里的内嵌表单。整个入口由 feature flag `enable_theme_editor` 控制。

### 10.3 应用外观设置与主题分离

`useAppSettingHelper()` 提供 `appSettings` / `updateSettings(key, value)`，管的是 `clientBorder`、`disableImageAntialiasing`、`enableNoisyBackground`、`enableBlurBackground`（仅 macOS）、`showLinkedDocInSidebar`。**主题名在 localStorage（next-themes），其它外观偏好在应用设置存储里**——两者生命周期不同（主题是设备本地偏好，设置可能需要同步），分开存是对的。

---

## 11. Logseq —— 三个属性 + 三个 body 类 + 自定义 CSS 重置

- 仓库：<https://github.com/logseq/logseq> · 星标 **45.1k** · 许可证 AGPL-3.0（未逐字核对）
- 关键文件（已核实）：`src/main/frontend/components/theme.cljs`

一个 `use-effect!` 里同时设置**四种**状态，注释直说是为 Tailwind 服务的：

```clojure
(.setAttribute doc "data-theme" theme)          ; html[data-theme=...]
(if (= theme "dark")
  (do (.add cls "dark")                          ; Tailwind dark mode
      (doto cls-body (.remove "white-theme" "light-theme") (.add "dark-theme")))
  (do (.remove cls "dark")
      (doto cls-body (.remove "dark-theme") (.add "white-theme" "light-theme"))))
(ui/apply-custom-theme-effect! theme)
(plugin-handler/hook-plugin-app :theme-mode-changed {:mode theme})
```

另外三个独立维度也走属性：

| 维度 | 属性 | 默认 |
|---|---|---|
| 强调色 | `data-color` | `"logseq"` |
| 编辑器字体 | `data-font` | `"default"` |
| 字体是否全局 | `data-font-global` | 布尔 |
| 界面语言 | `lang` | BCP-47 标签 |

**注意 `white-theme` 是历史包袱**，源码注释直接引用 PR #4652 说明它是向后兼容用的——所以它同时挂 `light-theme` 和 `white-theme`。`data-color` 的存在解释了社区里那个选择器 `html[data-theme=light][data-color=logseq]`（见 [logseq#10885](https://github.com/logseq/logseq/issues/10885)）：**明暗是两个正交维度，属性必须分开**。

系统主题：`system-theme?` 为真时调 `ui/setup-system-theme-effect!`（独立 effect，不在上面那个里）。自定义 CSS：换图谱时 `ui-handler/reset-custom-css!`，说明自定义 CSS 是**按图谱加载**的、需要显式重置。设置界面是 `shui/dialog-open!` 打开的一个 `:app-settings` 模态框（宽 `min(1024px, calc(100vw - 2rem))`），不是独立页面。

---

## 12. Joplin —— `settings.json` + 两个用户 CSS 文件

- 仓库：<https://github.com/laurent22/joplin> · 许可证 MIT（未逐字核对）· 星标未核实
- 文档：<https://joplinapp.org/help/apps/custom_css/>

两个文件，职责分明：

| 文件 | 位置 | 作用 |
|---|---|---|
| `userstyle.css` | profile 目录，如 `~/.config/joplin-desktop/userstyle.css` | **只影响渲染后的笔记内容**，且**同时用于屏幕显示和打印** |
| `userchrome.css` | 同目录 | **整个应用 UI** |

关键事实：

- **必须完全重启 Joplin**（不是最小化到托盘）才能生效。
- 文档明确警告：这两个文件是高级设置，**样式可能随版本失效，团队不承诺保持 HTML 结构稳定**——「你要用它就得准备持续维护」。
- 打印副作用被点名：`userstyle.css` 也用于打印，白字黑底打印出来通常不是想要的。
- 主题选择与其它配置一起存在 profile 目录的 **`settings.json`** 里（Joplin 的配置读写走 `Setting` 注册表 + `settings.json` 落盘）。即：**主题名在后端设置文件，用户 CSS 在 profile 目录的独立文件**。
- 自定义主题以 `.jpl` 包分发（社区主题仓库）。

---

## 13. daedalOS —— 动态壁纸 + 双背景层交叉淡入

- 仓库：<https://github.com/DustinBrett/daedalOS> · 星标 **13k** · 许可证 **MIT**（`package.json` 中 `"license": "MIT"` 已核实）
- 技术栈（`package.json` 已核实）：`react ^19.3.0`、`next ^15.5.5`、`styled-components ^6.5.3`、`idb ^8.0.3`（IndexedDB）
- 关键文件（已核实）：
  - `components/system/Desktop/index.tsx` → `useWallpaper(desktopRef)`
  - `components/system/Desktop/Wallpapers/useWallpaper.ts`
  - `components/system/Desktop/Wallpapers/constants.ts`、`handlers`、`types.ts`、`Galaxy/input.ts`
  - `contexts/session` → `useWallpaperImage()`、`useWallpaperFit()`、`setWallpaper()`

### 13.1 壁纸是「名字」，不是「URL」

`wallpaperImage` 是形如 `"GALAXY"`、`"MATRIX 3D"`、`"SLIDESHOW"`、`"STABLE_DIFFUSION"` 的字符串；后缀 `" ALT"` 作为**变体开关**（`isAlt = wallpaperImage.endsWith(" ALT")`）。派生：`const [wallpaperName] = wallpaperImage.split(" ")`。

### 13.2 双背景层 + CSS 变量交叉淡入（最值得抄的部分）

不直接改元素的 `background`，而是往 `document.documentElement` 上写**一组 CSS 变量**，由 CSS 负责过渡：

```ts
document.documentElement.style.setProperty("--background-transition-timing",
  isSlideshow ? "1.25s" : "0s")
document.documentElement.style.setProperty(
  `--${isAfterNextBackground ? "after" : "before"}-background`,
  `url(${CSS.escape(url)}) ${positionSize} ${repeat} fixed border-box border-box ${isTopWindow ? colors.background : colors.text}`)
document.documentElement.style.setProperty("--after-background-opacity",  isAfterNextBackground ? "1" : "0")
document.documentElement.style.setProperty("--before-background-opacity", isAfterNextBackground ? "0" : "1")
```

`isBeforeBg()` 决定这次写 `--before-*` 还是 `--after-*`，于是**永远有一层在显示、另一层在准备，切换时两层同时改 opacity 完成交叉淡入**，无闪烁、无重排。清理用 `resetWallpaper()` 里的 `removeProperty("--after-background")` / `removeProperty("--before-background")`。

注意背景声明的最后两个值 `border-box border-box ${color}`：**颜色作为 `background-color` 垫在图片之下**，图片未加载完时不会露出透明/白底。非顶层窗口（iframe）还会把 `--background-blend-mode` 设成 `difference`，保证任何壁纸上都可见。

### 13.3 可读性与性能

- **`prefers-reduced-motion` 是一等公民**：`const { matches: prefersReducedMotion } = window.matchMedia("(prefers-reduced-motion: reduce)")`，动效壁纸的 `speed` / `waveSpeed` / `animationSpeed` 直接设为 `REDUCED_MOTION_PERCENT`。
- 静态图走 `OffscreenCanvas` + Web Worker（`useWorker`、`createOffscreenCanvas`、`hasOffscreenCanvasSupport()`），把渲染搬离主线程；GALAXY 壁纸按 `Math.min(window.devicePixelRatio || 1, 1.5)` 渲染并自带质量调节器。
- 图片从虚拟文件系统读成 buffer，`bufferToUrl(fileData)` 生成 **blob URL**，并在替换前 `cleanUpBufferUrl(currentWallpaperUrl)` 主动回收——**不把图片塞进 localStorage**。
- 视频壁纸用真实 `<video>` 元素，`muted`、`loop`、`playsInline`、`disablePictureInPicture`、`disableRemotePlayback`，且 `setAttribute("aria-hidden", "true")`。
- 幻灯片列表存在 `PICTURES_FOLDER/SLIDESHOW_FILE`（一个 JSON 文件），并 `preloadImage(..., PRELOAD_ID, true, "auto")` 预加载下一张。
- 逃生阀：`window.DEBUG_DISABLE_WALLPAPER` 与 `?disableWallpaper=true` 查询参数可完全关闭壁纸。

---

## 14. win11React —— 壁纸数组 + 双层容器 + `backdrop-filter` 遮罩

- 仓库：<https://github.com/blueedgetechno/win11React> · 许可证未核实（根有 `LICENSE`，7,048 字节）· 星标未核实
- 关键文件（已核实）：`src/reducers/wallpaper.js`、`src/containers/background/index.jsx`、`src/containers/background/back.scss`、`src/reducers/settings.js`、`src/containers/applications/apps/settings.jsx`、`src/containers/applications/apps/assets/settingsData.json`

### 14.1 壁纸表 + localStorage 索引

`src/reducers/wallpaper.js` 顶部（已核实原文）：

```js
var wps = localStorage.getItem("wps") || 0;
var locked = localStorage.getItem("locked");
const walls = ["default/img0.jpg", "dark/img0.jpg",
  "ThemeA/img0.jpg", /* … ThemeA1-3 */ "ThemeB/img0.jpg", /* … */
  "ThemeC/img0.jpg", /* … */ "ThemeD/img0.jpg", /* … */ ];
const themes = ["default", "dark", "ThemeA", "ThemeB", "ThemeD", "ThemeC"];
```

- **存储的是数组下标，不是路径**：`localStorage.setItem("wps", twps)`，`localStorage.setItem("locked", false)`。切换是 `(state.wps + 1) % walls.length`。
- `WALLSET` action 同时接受下标和路径：`const isIndex = !Number.isNaN(parseInt(action.payload))`，若给路径则 `walls.findIndex(item => item === action.payload)` 反查下标再存。
- 静态资源按**主题名分目录**：`public/img/wallpaper/{default,dark,ThemeA,ThemeB,ThemeC,ThemeD}/img0..img3.jpg` 加 `lock.jpg`（锁屏专用）。`themes` 数组与目录名一一对应。

### 14.2 背景是独立容器，不是 body 背景

`src/containers/background/index.jsx`：

```jsx
const wall = useSelector(state => state.wallpaper)
<div className="background" style={{ backgroundImage: `url(img/wallpaper/${wall.src})` }} />
```

`back.scss` 里 `.background { min-width:100vw; min-height:100vh; background-color: var(--wintheme);
background-repeat:no-repeat; background-size:cover; background-position:center; transition: all .2s ease; }`

**`background-color: var(--wintheme)` 作为垫底色**（与 daedalOS 同一手法），`transition: all .2s ease` 让壁纸切换有过渡。

### 14.3 可读性：锁屏用 `backdrop-filter` 遮罩

```scss
.lockscreen[data-blur="true"]::after {
  content: ""; position: absolute; inset: 0; z-index: -1;
  -webkit-backdrop-filter: blur(25px); backdrop-filter: blur(25px);
  background: rgba(0, 0, 0, 0.1);
}
```

**模糊 + 半透明黑叠加**同时用：模糊抹掉高频细节，`rgba(0,0,0,.1)` 压暗。状态通过 `data-blur` 属性驱动（配合 `transition: all 200ms ease-in-out` 平滑过渡）。文字侧再用 Tailwind 类显式指定前景色：`text-gray-100` / `text-gray-200` / `text-gray-400`——**不依赖自动对比度**。

---

## 15. 专题：把主题存进「后端设置 JSON」的项目，以及为什么

| 项目 | 主题落点 | 为什么 |
|---|---|---|
| **SiYuan** | `~/.siyuan/conf.json` 的 `appearance` 对象（`ThemeLight`/`ThemeDark`/`Icon`/`ThemeJS`/`CodeBlockTheme*`）+ `Snippet.EnabledCSS/JS` | 桌面端需要**换工作空间后主题跟着走**、需要 CLI/API 读写（`GetMaskedConf`）、需要安全模式一次性覆盖所有外观开关。存 localStorage 做不到这三件事。 |
| **Joplin** | profile 目录 `settings.json` + `userstyle.css` / `userchrome.css` 独立文件 | 用户 CSS 是**大段文本**，塞 localStorage 会撑爆配额；放文件还能让用户用编辑器改、用 Git 管理。 |
| **tweakcn** | Postgres `theme` 表（`styles json`）+ `community_theme` / `theme_like` | 主题要跨设备、要被搜索/点赞/分享，还必须能以 shadcn registry 格式对外分发。localStorage 只承担**编辑态**。 |
| **AFFiNE** | `custom-theme` 键存进 `GlobalState`（应用设置存储），主题名本身仍走 next-themes 的 localStorage | 拆分依据是**生命周期**：明暗模式是设备本地偏好；用户自定义色板属于「账号级设置」，要跟着账号走。 |
| **Tabler** | 无后端，但**文档明确支持第三种来源**：由服务端从 cookie 或账号设置渲染 `data-bs-*` 属性到 `<html>`，脚本把它当起始值 | 这是「后端 + localStorage」并存时最省事的缝合法：**服务端只负责首屏正确，客户端脚本负责后续持久化**，两边不需要同步协议。 |

**对本项目（FastAPI + 本地优先）的建议组合**：`localStorage` 存 `theme`（明/暗/系统）与 `bgImageId` 等设备级偏好 → 首屏内联脚本立刻应用，零闪烁；FastAPI 侧存一份 `settings.json`（`{"appearance": {"theme": "...", "accent": "...", "customTheme": {"light": {...}, "dark": {...}}, "background": {...}}}`）作为**权威副本与跨设备同步源**；启动时先读 localStorage 渲染，再异步拉后端覆盖并回写 localStorage。这正是 AFFiNE + Tabler 两种做法的交集。

---

## 16. 专题：自定义背景图的 4 种存法与可读性手法

### 存法对比（均为实测）

| 存法 | 项目 | 细节 | 适用性 |
|---|---|---|---|
| **静态资源 + 索引** | win11React | `localStorage["wps"] = 0..N` 只是数组下标；图片在 `public/img/wallpaper/<Theme>/imgN.jpg` | ✅ 内置壁纸集首选。零 IO、可缓存、可 CDN |
| **虚拟文件系统 + blob URL** | daedalOS | `readFile(path)` → `bufferToUrl(buf)` → `blob:` URL 写进 CSS 变量；切换时 `cleanUpBufferUrl()` 回收 | ✅ 用户上传图首选。**不要 base64 进 localStorage**（4/3 膨胀 + 5 MB 配额） |
| **JSON 清单文件** | daedalOS 幻灯片 | `PICTURES_FOLDER/SLIDESHOW_FILE` 里存路径数组，`getAllImages()` 递归扫描 `PICTURES_FOLDER` 生成 | ✅ 图片集合/相册场景 |
| **主题包内嵌** | Obsidian | 主题作者在 `theme.css` 里 `background-image: url(...)`（文档另有「Embed fonts and images in your theme」专页） | ✅ 主题自带装饰图；用户换图仍走 snippet |
| **后端设置里的标识符** | SiYuan / tweakcn 模式 | 后端只存**图片 id 或 URL**，二进制走对象存储/静态目录 | ✅ FastAPI 场景最稳 |

**base64 进 localStorage：本次调研的所有成熟项目都没有这么做。**

### 保证前景文字可读性的 4 种手法（按项目实测）

1. **垫底色**：`background-color: var(--wintheme)`（win11React）、`… border-box border-box ${colors.background}`（daedalOS）——图片未加载完也不露白。
2. **模糊 + 半透明叠加**：`backdrop-filter: blur(25px)` + `background: rgba(0,0,0,.1)`（win11React 锁屏）。可再加 `saturate()` 提升质感。
3. **双背景层 opacity 交叉淡入**：`--before-background` / `--after-background` + `--before-background-opacity` / `--after-background-opacity`（daedalOS）——切换无闪烁。
4. **显式前景色 + 混合模式**：文字用固定色阶（`text-gray-100`/`200`/`400`）而不是继承；iframe 内用 `--background-blend-mode: difference` 保证极端背景下仍可见（daedalOS）。

补充：**「模糊程度」应当可调且可关闭**，并尊重 `prefers-reduced-motion`（daedalOS 对动效壁纸做了，静态壁纸的模糊开关是自然延伸）。

---

## 可借鉴清单

> 每条给出：**来源** → **做法** → **对 Tailwind 3.4 + CSS 变量 + localStorage + FastAPI 的适配度**。

1. **语义成对令牌 + `-foreground` 后缀约定**
   *来源：shadcn/ui（`apps/v4/app/globals.css`）* → 每个面（surface）配一个前景令牌，基色省略 `background` 后缀：`--card` / `--card-foreground`、`--primary` / `--primary-foreground`。
   **适配度：极高，直接采用。** 这套命名与 Tailwind 3.4 的 `bg-*` / `text-*` 配对天然吻合，且能强制设计者回答「这个面上的字是什么颜色」。

2. **HSL 通道三元组 + `hsl(var(--x) / <alpha-value>)` 映射**
   *来源：tweakcn（`utils/apply-theme.ts` 的 `colorFormatter(value,"hsl","4")`、`store/preferences-store.ts` 的 `colorFormatsByVersion`）+ shadcn v3 遗留文档* → 变量存 `H S% L%` 三元组，Tailwind 配置里包 `hsl()`。
   **适配度：极高，且是 Tailwind 3.4 的必选项。** 保留 `bg-background/50` 透明度修饰符的唯一途径；若改用 `oklch(...)` 完整值则需 `color-mix()` 替代。

3. **「非颜色令牌只定义一次，颜色令牌分模式」**
   *来源：tweakcn（`applyCommonStyles` 永远取 `styles.light` 那一份，`applyThemeColors` 才按 mode 取）* → 圆角、字体、字距、间距放公共层，只有颜色进 light/dark 两份。
   **适配度：高。** 避免 `--radius` 在两处漂移，也让「换配色」与「换圆角」变成两个独立操作。

4. **首屏内联脚本 + 一个 localStorage 键 + 属性接缝**
   *来源：next-themes（`ThemeScript` 序列化 `script` 函数 + `dangerouslySetInnerHTML`，键 `theme`，属性 `data-theme`）、Mantine（`ColorSchemeScript`，键 `mantine-color-scheme-value`，属性 `data-mantine-color-scheme`）* → 脚本在 `<head>` 里同步执行，读 localStorage → 解析 `system` → 设置 `<html>` 属性 + `style.colorScheme`。
   **适配度：极高。** 但 **Vite/CRA 没有 SSR**，可以直接在 `index.html` 里写死这段脚本，比 next-themes 的运行时注入更简单；`suppressHydrationWarning` 只在 SSR 下需要。

5. **`auto` 永不写入 DOM**
   *来源：Tabler（`auto` 加载时解析成 `light`/`dark` 并持续监听系统变化）、Mantine（`computedColorScheme`）* → 存储值可以是 `auto`，但属性值永远是已解析的具体值；并持续监听 `matchMedia` 变化实时更新。
   **适配度：高。** 让 CSS 只需处理 `[data-theme="dark"]` 一种情况，不必到处写 `@media (prefers-color-scheme: dark)`。

6. **「偏离默认才写属性」+ 统一存储前缀**
   *来源：Tabler* → `data-bs-theme-primary="blue"` 永不写出；所有键存为 `tabler-<key>`。
   **适配度：高。** 前缀让 localStorage 命名空间干净（建议 `wb-theme` / `wb-bg`），「不写默认值」让 DOM 更干净、也便于判断「用户是否显式设置过」。

7. **多维度属性而非单一 theme 名**
   *来源：Tabler（10 个 `data-bs-*` 维度）、Logseq（`data-theme` + `data-color` + `data-font` + `data-font-global` 四个正交属性）* → 明暗、强调色、字体、圆角各自独立。
   **适配度：高。** 对 AI 工作台尤其合适：`data-theme`（明暗）+ `data-accent`（品牌色）+ `data-bg-mode`（背景处理方式）三者正交，用户可自由组合，也避免主题数量组合爆炸。

8. **用户主题 = 稀疏覆盖对象 `{ light: {}, dark: {} }`**
   *来源：AFFiNE（`theme-editor` 模块，`_key = 'custom-theme'`，`updateCustomTheme(mode,key,value)` 空值即 delete）、tweakcn（同一形状）* → 只存用户改过的键，`reset()` 就是写回 `{light:{},dark:{}}`，`modified$` 决定是否显示重置按钮。
   **适配度：极高。** 这是「内置主题 + 用户微调」的最小存储形态；对 FastAPI 而言就是 settings JSON 里一个嵌套对象，序列化无痛。

9. **主题编辑入口是独立路由，不是设置页里的内嵌表单**
   *来源：AFFiNE（`/theme-editor` 路由或桌面 `ui.openThemeEditor()`，由 feature flag `enable_theme_editor` 控制）* → 设置页只放一个「自定义主题 / 打开编辑器 / 重置」的三态行。
   **适配度：高。** 编辑器需要大面积实时预览，塞进设置页会很难用；独立路由还能单独懒加载。

10. **registry / 主题包格式：JSON 声明 + `cssVars.light` / `cssVars.dark`**
    *来源：shadcn/ui（`registry-item.json` 的 `registry:theme` + `cssVars{theme,light,dark}`，语义是「合并进项目现有变量」）、SiYuan（`theme.json` 的 `name/author/version/frontends/modes` + `theme.css`）* → 主题包 = 元数据 JSON + 一份 CSS/变量表，`modes` 显式声明属于 light 还是 dark。
    **适配度：极高，建议直接采用 SiYuan 的 manifest 形状。** 前端只需 `fetch` 一个 JSON，把 `light`/`dark` 两块写进 `<style>` 或 `CSSStyleSheet`，无需构建期介入；FastAPI 只存这些 JSON 文件即可。

11. **对比度检查内建进主题编辑器**
    *来源：tweakcn（`utils/contrast-checker.ts` + `hooks/use-contrast-checker.ts` + `components/editor/contrast-checker.tsx`）、Tabler 文档（切主色/基底色会改变整页对比度，必须重查 WCAG AA）* → 用户改色时实时算对比度并给出警告。
    **适配度：高。** 计算是纯函数（相对亮度 + 对比度公式），前端本地算即可，不需要后端。

12. **背景图三层结构：垫底色 + 图片层 + 遮罩层，并给足逃生阀**
    *来源：daedalOS（`--before/--after-background` + `--*-opacity` + `--background-blend-mode` + `background-color` 垫底；`?disableWallpaper=true` 与 `window.DEBUG_DISABLE_WALLPAPER` 逃生阀）、win11React（`background-color: var(--wintheme)` + `backdrop-filter: blur(25px)` + `rgba(0,0,0,.1)`）* → 用 CSS 变量驱动两层 opacity 交叉淡入；模糊/压暗强度可调可关。
    **适配度：极高。** 用 CSS 变量而不是直接改元素样式，天然与「主题令牌」同一套机制；Tailwind 3.4 里可用 `bg-[image:var(--bg-image)]` 或自定义 `backgroundImage` 主题键接入。

13. **图片绝不进 localStorage：走 blob URL / 后端 id**
    *来源：daedalOS（IndexedDB 虚拟 FS + `bufferToUrl` → `blob:` URL，切换时 `cleanUpBufferUrl()` 回收）、win11React（静态资源 + 下标）、SiYuan/tweakcn（后端只存标识符）* → localStorage 只存 `bgImageId` 或下标；二进制走后端或 IndexedDB。
    **适配度：极高。** FastAPI 侧建 `POST /api/appearance/background` 存文件、返回 id，前端 `<img src="/api/appearance/background/{id}">`；这样也天然支持「多设备同步同一张背景图」。

14. **URL 查询参数作为第三设置源，分享即复现外观**
    *来源：Tabler（`?theme=dark&theme-primary=azure`，参数优先级最高且回写 localStorage；切换按钮可以是纯 `<a href="?theme=dark">`）* → 属性 / localStorage / URL 三者一致，`pushState` 同步。
    **适配度：中高。** 对本地工作台价值在于「分享一条链接 = 分享一套外观」，也方便做截图回归测试（`?theme=dark&bg=none`）。注意别把敏感信息写进 URL。

15. **`prefers-reduced-motion` 与「全部关掉」的安全模式**
    *来源：daedalOS（动效壁纸的 `speed` 直接设 `REDUCED_MOTION_PERCENT`）、SiYuan（`--safe-mode` 启动时覆盖 `ThemeLight/ThemeDark/Icon/ThemeJS/Snippet.EnabledCSS/JS/Bazaar` 并持久化，且 `SafeMode` 本身不持久化）* → 动效一律受 `prefers-reduced-motion` 约束；当主题能执行 JS / 加载自定义 CSS 时，必须有一条把所有扩展一次性关掉的自救路径。
    **适配度：高。** 若你的工作台允许用户贴自定义 CSS（很可能会），请同时提供 `?safe=1` 或启动参数级别的禁用开关，并且这个开关本身不要被持久化。

16. **服务端渲染起始属性 + 客户端脚本接管**
    *来源：Tabler 文档（「若已从 cookie 或账号设置知道偏好，自己渲染 `data-bs-*` 到 `<html>`；脚本把它当起始值，只在有存储值或 URL 参数时替换」）* → 后端只保证首屏正确，客户端负责后续持久化，两边不需要同步协议。
    **适配度：极高，正是 FastAPI + localStorage 的最佳缝合方式。** 用 Jinja2/模板把用户设置注入 `<html data-theme="…">`，内联脚本先读 localStorage（有则覆盖），再异步 `PATCH /api/settings/appearance` 回写。

17. **主题清单接口脱敏**
    *来源：SiYuan（`GetMaskedConf()` 清空 `UserData`/`MCPOAuth`/`CookieKey`，`AccessAuthCode` 替换为 `"*******"`）* → 返回外观设置时显式剔除同文件里的密钥字段。
    **适配度：高。** 若把 appearance 和其它设置放在同一个 `settings.json`，务必用 Pydantic response model 显式声明返回字段，别直接 `return settings.dict()`。

---

## 附：本次核实到的「存储键 / 属性名」速查

| 项目 | localStorage 键 | DOM 属性 | 主题名取值 |
|---|---|---|---|
| next-themes | `theme`（可配 `storageKey`） | `data-theme`（可配 `attribute`，支持 `class` / 数组） | `light` / `dark` / `system` / 任意 |
| Mantine | `mantine-color-scheme-value`（可配 `key`） | `data-mantine-color-scheme` | `light` / `dark` / `auto` |
| Tabler | `tabler-theme`、`tabler-theme-primary`、`tabler-theme-base`、`tabler-theme-font`、`tabler-theme-radius`、`tabler-navbar-position`、`tabler-layout`、`tabler-navbar`、`tabler-navbar-theme`、`tabler-sidebar` | `data-bs-theme`、`data-bs-theme-base`、`data-bs-theme-font`、`data-bs-theme-primary`、`data-bs-theme-radius`、`data-bs-navbar-position`、`data-bs-layout`、`data-bs-navbar`、`data-bs-navbar-theme`、`data-bs-sidebar` | `light`/`dark`/`auto` + 各维度枚举 |
| tweakcn | `editor-storage`（主题编辑态）、`preferences-storage`（编辑器偏好） | root 上的 `.dark` 类 + 行内 CSS 变量 | `light` / `dark` |
| daisyUI 文档推荐（theme-change） | 由 `theme-change` 管理；`data-key` 可分命名空间 | `data-theme`（`<html>` 或任意嵌套元素） | `light`/`dark`/`cupcake`/… 任意 |
| shadcn 官方 Vite 示例 | `vite-ui-theme` | `class` 上的 `light` / `dark` | `light`/`dark`/`system` |
| AFFiNE | next-themes 的键 + `GlobalState` 里的 `custom-theme` | next-themes 的 `data-theme`/`class` | `system`/`light`/`dark` |
| Logseq | 由应用设置管理 | `data-theme`、`data-color`、`data-font`、`data-font-global`、`lang`；`<html>.dark`；`<body>.dark-theme`/`.light-theme`/`.white-theme` | `light` / `dark` |
| win11React | `wps`（壁纸下标）、`locked` | — | 壁纸主题目录名数组 |
| SiYuan | —（后端 `conf.json`） | — | `Appearance.ThemeLight` / `.ThemeDark` |
| Joplin | —（profile `settings.json`） | — | 主题 id + `userstyle.css` / `userchrome.css` |

---

# 追加：第二批参考（2026-10-02）

第一批看的是「通用主题系统怎么组织」。第二批换了个角度——**看别人怎么把皮肤做成
一件可以拿走的东西**：能装、能卸、能导入导出、能由第三方做。四个项目：

| 项目 | 是什么 | 为什么看它 |
|---|---|---|
| [`Small-tailqwq/dsh-deep-whale`](https://github.com/Small-tailqwq/dsh-deep-whale) | DSH 的皮肤平台：一个 `skin-manager` 插件 + 两个皮肤 + 一套安装/升级技能 | 唯一一个**完整**的皮肤平台（清单格式、版本兼容、导入导出、互斥、资源投递、契约审计），信息密度最高 |
| [`thep0y/fcitx5-themes-candlelight`](https://github.com/thep0y/fcitx5-themes-candlelight) | fcitx5 输入法主题包（7 个主题目录） | 「一个主题 = 一个目录 + 一份 `theme.conf` + 几张图」，最朴素的皮肤即数据 |
| [`zhulin025/Codex-QQ-Skin`](https://github.com/zhulin025/Codex-QQ-Skin) | 把 Codex 桌面端换皮成 QQ 2007 的注入器 + 皮肤库 | **清单允许只写一部分颜色**（10 个角色写 2 个，其余推），以及皮肤包的导入校验 |
| [`xiake595/touhou-hakurei`](https://github.com/xiake595/touhou-hakurei) | DSH Web GUI 的第三方皮肤（东方·博丽神社） | 作用域、销毁还原、只消费宿主 token 的做法 |

## 真正被采纳的四条

1. **皮肤是数据，不是代码**（deep-whale `skin.json` + fcitx5 `theme.conf`）。
   采纳为 `src/theme/manifest.ts`：一份皮肤是一个对象，内置与导入走**同一条**解析路径。
   直接兑现了那条约束——「加一个内置皮肤 = 加一条对象；加一个自己的皮肤 = 贴一份 JSON」。
2. **清单允许写一半，其余按明确的优先级推导**（Codex-QQ-Skin 的
   `explicitColorKeys → makeAdaptivePalette`）。这是四条里价值最高的一条：
   `{ id, label, accent }` 三个字段就能成一套皮肤，亮暗两套、11 档色阶、页面底色
   全部推出来。**「配错一整套色板」正是自己做皮肤最容易劝退的一步**，去掉它之后
   「新增主题只需要增加配置」才从口号变成事实。
3. **导入是合并，且校验的是合并之后的结果**（deep-whale `transfer.ts`：
   `assertPreferencesImportable(merge(snapshot, incoming))`）。采纳为
   `planImport` 的两条自检：装完之后必须**仍然导得出去**（否则用户从此做不出备份，
   而他不会知道）、同 id 只能有一份。另外「文件里认得的坏条目只跳过它自己并说明原因」
   也来自这里。
4. **明暗是宿主拥有的正交轴，不是皮肤的一个变体**（deep-whale 两个皮肤都是
   「一个皮肤跨两种模式」，`skin.json#preview` 是 `{light, dark}` 两张图）。
   这条**确认**了第一版的设计（皮肤 × 亮暗正交），也顺带说明 `bodyAttr` 那类
   「作用域键」值得写进清单——本仓库对应的是 `html[data-wb-*]` 那三个属性，
   已经写进设计契约当主题作者可依赖的钩子。

另外一条**局部**采纳的：`html[data-wb-mode]`（生效的亮暗写成一个属性）来自
Codex-QQ-Skin 的 `data-theme` 与 touhou-hakurei 的 `data-ds-dark-theme`——
「主题作者该依赖语义属性，而不是 Tailwind 那个 `.dark` 类名」。

## 明确没采纳的（以及为什么）

| 看到的东西 | 为什么不要 |
|---|---|
| deep-whale 的 `visibility-schedule`（按时间段隐藏装饰，SFW 模式） | 它是**装饰可见性**的时间表，不是「日落自动转暗」。本仓库的背景/图片本来就是用户显式开关的，再加一层时间表没有对应的问题要解 |
| 同一项目的互斥开关、YAML 补丁层、签名热修包、指纹溯源、版本准入 | 那些解的是「**第三方插件**装进一个自己不改的宿主」的问题（谁赢、装没装、是哪个构建、宿主升级了怎么办）。本仓库的皮肤是产品自带的一份数据，没有插件加载这一层，照搬会引入一整套没有对手的机制 |
| Codex-QQ-Skin 的 CDP 注入 + `~/.codex/config.toml` 覆写 | 它是从外部改一个**不属于自己**的应用，只能靠调试端口注入。本仓库是在自己的应用里换自己的变量，那条路既不需要也不该走 |
| candlelight 的九宫格图片边距（`[InputPanel/Background/Margin]`）、`ScaleWithDPI`、同一主题的 SVG/PNG 两份资源 | 那是位图 UI 工具包的渲染模型。Web 上对应的是 `border-image` 与矢量资源，本仓库的皮肤不含位图资产，没有这个问题 |
| ~~皮肤自带一套背景/壁纸~~ | **这条后来改了**（2026-10-02，见下面「追加二」）：当时的理由是「背景已经有自己的一整套功能，皮肤再带一套就有两种真相」。那个顾虑是对的，但它指向的答案是**一条明确的分派规则**（用户设了就用用户的，没设才用皮肤的），而不是「皮肤不许有底图」。规则立起来之后两种真相就不存在了 |
| 皮肤缩略图/预览图（`preview.light` / `.dark`） | 第一版就刻意不做：加一个皮肤就要多两张图，而且缩略图必然与真实配色分叉。预览是**用皮肤自己的色值现画的**——带底图的皮肤则把**那张真图**直接铺进预览，于是更没有分叉的余地 |
| 内容寻址的资源投递（文件名 = 内容的 sha256、不可变缓存、允许清单） | 那是给「皮肤自带大量位图、走 HTTP 从插件目录投递」设计的。本仓库的皮肤是纯色值，背景图走已有的 `/api/images/` |
| `contain: strict` 之外的那一整套性能护栏（低功耗模式探测、`will-change` 一次性租约、resize 期间关过渡） | 那些是给「整屏透明角色立绘 + 滤镜 + 动画」准备的。本仓库的背景层只有一张图加一层压暗，`contain: strict` 一条就够 |

## 顺带被确认的两件事

- **通道三元组而不是完整色值**（Codex-QQ-Skin 同时导出 `--ds-accent` 与
  `--ds-accent-rgb`，本仓库是 `rgb(var(--wb-x) / <alpha-value>)`）：两边独立走到
  同一个做法，说明这是 Tailwind 生态里唯一能同时满足「跟变量走」与「带斜杠透明度」的写法。
- **皮肤样式只消费宿主的 token，不自带一套配色**（touhou-hakurei 用 `--dsw-alias-*`，
  只给自己那点装饰加 `--hakurei-*`）：本仓库对应的是设计契约里
  「语义色刻意不跟皮肤走」那一条（rose=错误、amber=等人……）——同样的边界，反过来说。

## 过程中被这些参考改掉的一个判断

原以为「导入一份文件」是个只需校验输入的动作。deep-whale 那条
「校验**合并之后**的结果」把它推开了一层：真正会伤人的不是「文件不合法」，
而是「导入成功了，但用户从此做不出备份」。照着这条写测试时又发现了一个**真 bug**：
`parseTheme` 会把认不出的皮肤名收拾成默认皮肤（对本机存储来说是对的），
于是「设置 + 皮肤一起导出、一起导入」这种最常用的用法会把皮肤选择悄悄丢掉，
而用户看到的是「导入成功了，但皮肤还是原来那个」。
修法是**先读文件里的皮肤、再定设置里的皮肤**——顺序本身就是这条参考的产物。

---

# 追加二：图片式背景皮肤（2026-10-02，同日晚些）

用户提了「加上那种图片式的背景皮肤」。这推翻了我上面「皮肤不带背景」那个判断，
但推翻的方式值得记下来：**当初的理由（会有两种真相）是对的，结论是错的**——
两种真相不是靠「不许有」避免的，是靠**一条明确的分派规则**避免的：

> 用户自己设了背景就以用户的为准；用户没设（`mode === 'skin'`）才用皮肤那张。

规则只有一处（`theme.ts` 的 `effectiveBg`），所以「设置面板说跟着皮肤、画面却是用户那张图」
这类谁也说不清的状态没有存在的余地。`mode: 'skin'` 这个从第一版就有的取值，
正好就是这个规则的落点——**它当初的意思就是「我不覆盖，你看着办」**。

## 这一轮真正借到的，是「压暗怎么分布」

图片式背景的难点从来不是把图铺上去，而是铺上去之后**字还读不读得清**。
上一轮我读了 orca-link 那段却没采纳——它给场景图盖的是一层**方向性、不对称**的渐变：
深的一头压在导航文字那一侧（`rgba(6,10,16,.58)` → `.12`），而不是整屏均匀变暗。

这一轮它成了必需品。理由很直接：均匀压暗有个绕不过去的取舍——
图花 → 压到够重才看得清字 → 图也没了。而**「文字在哪里」与「图该在哪里亮着」本来就不重合**：
文字集中在左边（侧栏）和上边（顶栏），中间是卡片，而卡片本来就不透明，那里的图不需要压。
把压暗按位置分配，两件事就同时成立了。

自己那版与它的差别有两处，都是被实测逼出来的：
1. 它是一条 90° 的横向渐变；本仓库用了**横向 + 纵向两条**——侧栏是整条竖边，
   光压左边的话顶栏那一行还是露着。
2. 横向梯度必须在**前 30% 保留大半强度**：侧栏占屏宽约 18%，梯度要是从 0% 就开始快速衰减，
   侧栏右半边就已经没什么压暗了，「把暗度放在有字的地方」只做了一半。
   第一版就是这么写的，量出来侧栏只拿到约 30% 的强度，改成 0.75 / 0.62 / 0.42 / 0 之后是约 44%。

## 一个不改结论但值得记的实测

铺图之后**只有亮色会略微降对比度**（压暗层是白的，压不亮本来就接近白的山雾天空），
暗色一律升高（黑压暗层把底压得更黑）。实测最紧的一处是远山亮色的中心 4.56:1
（它替换掉的那个纯色底是 4.73:1）——仍在 AA 之上。

## 顺带修掉的一个真 bug

做这一轮时才发现：`accentPalette` 的 `600` 是固定「压 14%」，而它是**实底按钮那一档**
（白字压在上面）。基色够深时没问题，用户挑一个淡黄（`#fde047`）当强调色时，
压 14% 得到 `#d9c03d`，白字压上去只有 **1.6:1**——按钮上的字直接糊掉。
也就是说「自己填强调色」那条路一直是坏的，只是没人挑过淡色。

新写的三套皮肤正好走的是「只给一个色号、色阶由它推」这条路，于是它先撞上了这个 bug。
修法是压到白字够为止（上限 0.72，再压色相就没了），并且 700–950 从那之后的 600 接着往下压
（两条各自从基色压的话，淡色底会出现「700 比 600 还浅」）。
深色基色**一个字节都没变**——那一路本来就是好的，不该被顺手改口味。

# 追加三：上传一张图，现做一套皮肤（2026-10-02，同日晚些）

问题：**「上传图片」原来只做成了一件背景**——图盖上去，强调色还是上一个皮肤的那个。
人挑图的时候心里想的是「整个工作台变成这个样子」，而只换背景只兑现了其中一半。

这一轮的结论写在 `docs/ui-design-contract.md` §8.4。这里记的是**调研过程**。

## 两路调研（各一个子代理，各自带链接）

### 一、从图里取色：成熟实现怎么做的

| 项目 | 做法 | 借了什么 |
|---|---|---|
| **color-thief** 2.x | MMCQ（中位切分），全分辨率 `getImageData` + `quality=10` 跳像素采样 | **两段式切分**（先按数量切到 3/4，再按「数量 × 跨度」切到底）与那个常数 `fractByPopulations`；`a >= 125` 的半透明取舍线 |
| **color-thief** 3.x | 同上，但量化在 **OKLCH** 里做；滤波器逐级放宽（先不管白色、再不管 alpha、最后退回全图平均） | **逐级放宽那条阶梯**；以及它 README 里那句实测——**Web Worker 是净亏**（结构化克隆像素数组比省下的量化还贵）。所以这里不做 worker |
| **node-vibrant** | MMCQ + 6 个命名色板（Vibrant / Muted / DarkVibrant…），按 `(1-|s-目标|)×3 + (1-|l-目标|)×6.5 + (占比)×0.5` 打分 | **占比权重压得很低**这个取向（那里是总分 10 份里的 0.5 份）。它的 `_generateEmptySwatches` **有 bug**（在 LightVibrant 分支里写 DarkVibrant，还把饱和度目标当明度用），没抄 |
| **material-color-utilities** | Celebi（Wu + WSMeans）切 128 色再打分；`Score` 目标 chroma 48、权重 0.7/0.3/0.1、色相窗口 ±14/+16、色相多样性 90°→15° | **`DislikeAnalyzer`**：色相 90–111、够彩、够暗 = 最讨嫌的一类颜色（Palmer & Schloss 2010），强制提亮。四个比较，比事后收到一句「这个皮肤好丑」便宜 |
| **matugen** | MCU 的 Rust 移植，`resize(112, 112)` 再量化 | **采样尺寸**这个量级（Material 的开发指南说 128）。这里用 128 |
| **pywal / wallust** | ImageMagick / k-means；`lighten_color` 是逐通道 `c + (255-c)×a` | **基本没借**——它在 sRGB 里混，越混越灰、色相还会漂。压暗那一段的取分位思路倒是同源 |
| **Material 3 的对比度** | `Contrast.ratioOfYs = (亮+5)/(暗+5)`；`foregroundTone()` 按比值**解**出一个 tone，而不是查表 | **「解，不要查表」**。这里三个位置的压暗就是解出来的 |

**明确没做的一件事**：把整套色阶搬到 OKLCH 里生成。
调研的结论确实是 OKLCH 更好（固定色相与明度、只让色域压 chroma），
但 `accentPalette` 已经用 sRGB 混法跑了九套皮肤、被 `theme.contrast.test.ts` 钉着，
而且**对比度那一档已经用 WCAG 公式解过了**（600 会一路压到白字够为止）。
换过去会改变全部九套内置皮肤的颜色，收益是「色相更稳一点」——不值得在这一轮做。
记在这里，不是忘了。

### 二、产品侧：成熟产品怎么处理「上传的图成为一套主题」

| 产品 | 做法 | 借了什么 |
|---|---|---|
| **Warp**（终端） | 主题选择器里一个 **`+`** → 传图 → 从最显眼的几种颜色生成候选主题 → 定下来写进 YAML | **入口的位置**（在皮肤表那一格）+ 把解出来的十六进制**冻进文件**（Warp 的 YAML 里存的就是具体色号） |
| **Material You** | 壁纸 → 量化 → 一个源色 → 亮暗**两套**角色从同一个源色生成；用户可以「Basic colors」覆盖 | **一个源色出亮暗两套**（这里是两个变体各自的压暗）；以及那个覆盖出口 |
| **macOS** | 强调色是固定几档、**从不推导**；另有一个独立的「用壁纸颜色给窗口染色」开关 | **「推导出来的」与「用户选的」是两件事**。所以这里生成的皮肤照样可以被上面的强调色输入框改掉 |
| **Obsidian DTB** | 只给模糊/亮度/饱和度滑块，什么都不推导；README 自己承认「为暗色主题优化，亮色可能要自己调」 | **它的诚实**（那句话正是要避免的），以及反面教材：**两套系统抢同一个背景**（原文：「如果你的主题定义了自己的背景，选其中一个，避免冲突」） |
| **Windows 11** | 主题 = 背景 + 颜色 + 声音 + 光标，**存成一个具名条目**，可删可导出 | **具名条目**这件事本身就是答案：音乐播放器全都做不到（见下） |
| **Tabliss / Bonjourr** | 用户图存成一个数组；Tabliss 超过 2 MiB 会提示 | **图 404 时的处理**：Tabliss 是「保留那个条目、退到默认背景」，绝不悄悄删掉 |
| 音乐播放器（MusicBee / Plexamp） | 从专辑封面**实时**取色，跟着歌走 | **反面教材**：没有一个能把你从封面取到的配色**存成一个具名主题**——因为它们每次都重算，于是主题永远没有稳定的身份。这里恰好相反：解出来的色号**冻进皮肤对象**，同一张图跑两次结果一样（中位切分没有随机性，测试钉着这一条） |

## 被参考实现改掉的一个判断

「上传的图该不该自动带出强调色」我原来的答案是「不该」——理由是
「强调色已经有主了（皮肤），再从图里推一个就是两种真相」。
这跟上一轮「皮肤要不要自带背景」是同一种顾虑，而**结论同样是错的**：
两种真相不是靠「不许有」避免的，是靠**一条明确的优先级**。
上一轮那条是 `effectiveBg`（用户的背景设置优先）；
这一轮那条是 `config.accent`（用户在面板上填的强调色优先于皮肤带的）。
两条都是「一处判断」，而不是「禁止某一方存在」。

## 三个只有量了才知道的数

1. **壳自己的半透明底必须算进去。** 侧栏 `bg-white/70`、顶栏 `bg-white/85`
   （`Layout.tsx`），字压在它们上面时底下那层图已经被洗过一遍。
   不算这一层，一张中间调的图会被解出 **80%** 的压暗；算上是 **45%** 上下。
   差别正好是「图还在」与「图没了」。
2. **够不到目标时压到 95% 是白压。** 一张上亮下暗的风景照，62% → 95%
   只把侧栏那一处从 3.95 抬到 4.43（差 0.5），代价是整张图消失。
   所以够不到时停在 62%，把这 0.5 让出去，换回那张图。
   **这一条是被截图抓住的**——数字上 4.43 比 3.95 好看，屏幕上一片白。
3. **「差一点」与「确实发灰」不值得分两档。** 本来按 4.0 / 4.5 做了两级提示，
   实测下来够不到目标的那些落在 2.1–3.9，两级提示里上面那一档几乎不会触发。
   一个几乎不触发的分支不如没有——改成一条，并把**具体比值**摆出来。

## 一处有意不收的口子

**导出不带图。** 皮肤 JSON 里只有地址，图片留在 `data/images/`。
参考实现里 Warp 的主题仓库明确拒收二进制底图（「只收 yaml，控制仓库体积」），
理由一样：导出是设置档案，不是照片备份。代价是导出的图片皮肤换台机器就只剩配色，
`ThemeBackdrop` 探到图加载不出来就整层不画，退回页面底色——仍然是一套能用的皮肤。
