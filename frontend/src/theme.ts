/** 外观 / 皮肤 / 自定义背景 —— 这个文件的唯一职责是「把一份主题设置变成 DOM 上的一串
 *  CSS 变量」，此外什么都不做：没有 React、不发请求、不碰任何业务组件。
 *
 *  ## 为什么是 CSS 变量而不是 Tailwind 配置里多写几套色板
 *
 *  Tailwind 的 `dark:` 是**编译期**的：`bg-white dark:bg-neutral-900` 在构建产物里就是
 *  两条固定规则，运行时改不了。而全仓有 240+ 个组件把类名写死在业务代码里，逐个改成
 *  `bg-surface` 那种语义类，等于把这次改动扩散到整个前端——收益却只是「换个底色」。
 *
 *  所以走的是另一条路（shadcn/ui themes、Obsidian、DaisyUI 都是这条）：
 *  **把 Tailwind 的调色板本身接到 CSS 变量上**。`tailwind.config.js` 里
 *  `violet-600: rgb(var(--wb-violet-600) / <alpha-value>)`，于是**现有的一万多个
 *  `bg-violet-*` / `border-neutral-*` / `text-neutral-*` 类名一个都不用改**，
 *  换肤就是换这几个变量的值。
 *
 *  `--wb-neutral-*` 也跟着换：这正是「深色 / 极简 / 森林」之间差别最大的地方
 *  （底色与文字一起走），也是「默认皮肤在亮暗两种模式下看起来和改动前一模一样」的
 *  保证——默认那两套值就是原来 neutral / violet 的数值本身。
 *
 *  ## 三层结构
 *
 *  1. **皮肤（SKINS）**：一份配置对象 = 一套色板 + 一条强调色。加皮肤 = 往
 *     `SKINS` 里加一条，别处一个字都不用动。
 *  2. **用户自定义**：强调色 / 背景（纯色 / 渐变 / 图片）叠在皮肤之上，存 localStorage。
 *  3. **DOM**：`applyTheme()` 把结果写成 `<html>` 上的内联 CSS 变量 + `dark` 类。
 *
 *  纯函数（`resolveTheme` / `themeCssVars`）与 DOM 操作（`applyTheme`）分开，
 *  前者可以直接测，不需要渲染任何东西。 */
import { accentPalette, channels, hexToRgb, normalizeHex, WHITE, type Channels } from './theme/color'
import {
  DEFAULT_BG,
  FOCUS_MAX,
  FOCUS_MIN,
  MAX_BG_POOL,
  ROTATE_CHOICES,
  VEIL_FACTORS,
  ZOOM_MAX,
  ZOOM_MIN,
  isBgFit,
  isBgMode,
  isSafeImageUrl,
  isScrimDir,
  isVideoUrl,
  rotatedImage,
  safeImageUrl,
  type BgFit,
  type BgMode,
  type ScrimDir,
  type ThemeBg,
  type Tint,
} from './theme/background'
import {
  SURF_KEYS,
  SURF_RANGE,
  applyOverrides,
  hasOverrides,
  panelAlpha,
  type SkinSurfaces,
  type SurfKey,
  type SurfOverrides,
} from './theme/surfaces'
import type { Skin, SkinVariant } from './theme/skins'
import {
  SKINS_CHANGED_EVENT,
  SKINS_KEY,
  hasSkin,
  installUserSkins,
  isBuiltinSkin,
  listSkins,
  loadUserSkins,
  removeUserSkin,
  renameUserSkin,
  skinById,
  userSkinManifests,
  type InstallReport,
} from './theme/registry'
import {
  MIN_SKIN_SCRIM,
  SKIN_FORMAT,
  channelsToHex,
  manifestToSkin,
  parseSkin,
  skinToManifest,
  type Parsed,
  type SkinBg,
  type SkinManifest,
  type VariantManifest,
} from './theme/manifest'

export {
  DEFAULT_BG,
  MAX_BG_POOL,
  MIN_SKIN_SCRIM,
  ROTATE_CHOICES,
  SKIN_FORMAT,
  PARTICLE_KINDS,
  SKINS_CHANGED_EVENT,
  SKINS_KEY,
  SURF_KEYS,
  SURF_RANGE,
  accentPalette,
  channelsToHex,
  hasOverrides,
  hasSkin,
  installUserSkins,
  isBgFit,
  isBgMode,
  isBuiltinSkin,
  isParticleKind,
  isSafeImageUrl,
  isScrimDir,
  isVideoUrl,
  listSkins,
  loadUserSkins,
  manifestToSkin,
  normalizeHex,
  parseSkin,
  removeUserSkin,
  renameUserSkin,
  rotatedImage,
  skinById,
  skinToManifest,
  userSkinManifests,
}
export type {
  BgFit,
  BgMode,
  Channels,
  InstallReport,
  Parsed,
  ParticleKind,
  ScrimDir,
  Skin,
  SkinBg,
  SkinManifest,
  SkinVariant,
  SurfKey,
  SurfOverrides,
  ThemeBg,
  VariantManifest,
}

/** localStorage 的键。**带版本号**：设置形状变了，旧值认不出来就退回默认，
 *  而不是把一份半新半旧的对象塞进 DOM（那种 bug 表现为「某些颜色对了、某些没对」）。
 *
 *  **v2 真的变过一次**：`dark: boolean` → `mode: 'light' | 'dark' | 'system'`。
 *  下面 `parseMode()` 里那一段就是版本号当初存在的理由。 */
export const STORE_KEY = 'wb:theme'

/** 「进过外观页」的一次性标记。顶栏调色盘上的小圆点只在没进过时亮——
 *  换肤入口有三个（侧栏设置第二项、顶栏、命令面板），但对第一次打开的人
 *  来说等于没有；这个功能的价值一半在「被发现」。进了外观页就落键，圆点永远消失。 */
export const APPEARANCE_VISITED_KEY = 'wb:appearance-visited'
export const STORE_VERSION = 2

/** 明暗的三种取法。`system` = 跟随操作系统（`prefers-color-scheme`）。
 *
 *  为什么值得单列一档：这是这类设置里**最常被选中的那一档**——用户白天在亮色
 *  环境、晚上系统自己转暗，工作台跟着走才不刺眼。
 *
 *  它同时说明了为什么这里存的不是 `dark: boolean`：布尔值里没有「跟随」的位置，
 *  硬塞第三态就只能靠「null 表示跟随」这类约定，而那约定会在每一处
 *  `if (cfg.dark)` 上分叉出「null 算亮还是算暗」。 */
export type ColorMode = 'light' | 'dark' | 'system'

export function isColorMode(v: unknown): v is ColorMode {
  return v === 'light' || v === 'dark' || v === 'system'
}

/** 系统当前是不是暗色。**读不到就当亮色**：`matchMedia` 在 jsdom、老浏览器、
 *  以及某些被裁过的 WebView 里可能不存在，而「读不到系统偏好」不该是能拦住首屏的事。 */
export function prefersDark(): boolean {
  try {
    return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches
  } catch {
    return false
  }
}

/** `mode` + 系统偏好 → 究竟用哪一套值。**全站唯一一处做这个判断的地方**：
 *  顶栏按钮、图表、设置面板的预览都问它，而不是各自写一遍 `mode === 'dark'`
 *  （那种写法在加 `system` 的那天会漏掉一半）。 */
export function resolveColorMode(mode: ColorMode, systemDark: boolean): boolean {
  return mode === 'system' ? systemDark : mode === 'dark'
}

/** 一份主题设置。`skin` 认不出来时按默认皮肤处理；`mode` 单独存——
 *  「用哪套皮肤」与「亮色还是暗色」是两件事（每个皮肤两套值都齐全）。 */
export interface ThemeConfig {
  version: number
  skin: string
  mode: ColorMode
  /** 强调色覆盖（#rrggbb）。空 = 用皮肤自带的强调色。 */
  accent: string
  bg: ThemeBg
  /** **面板层的用户覆盖**，一张表：拨过哪一项就记哪一项，没记的就是「跟随皮肤」。
   *
   *  与 `accent` 同一个模式：皮肤给一套值，用户拨一下就是一次覆盖，
   *  「跟随皮肤」把它清回去。**覆盖是唯一那条路**——不需要在「把用户拨的值存进
   *  皮肤数据里」和「存成覆盖」之间选一种；想把它固化成一套皮肤时用「存成新皮肤」。
   *
   *  为什么是一张表而不是几个标量（`glass` / `blur`）：这一层八个值，
   *  而「用户拨过哪一项」本身就是信息（界面据此决定每一项的复位按钮显不显示）。
   *  早先只有两根滑块时存的是两个标量，读到旧值时由 `parseSurfaces` 折叠进来。 */
  surfaces: SurfOverrides
}

/** 出厂外观。`mode: 'light'` 而**不是** `'system'`：换肤功能上线前这里是「亮色」，
 *  上线后没动过设置的人应该还是那一版。跟随系统是个好默认，但它是一次替用户做决定——
 *  该由用户自己点，而不是由我们在他升级的那天悄悄改掉他的屏幕。 */
export const DEFAULT_THEME: ThemeConfig = {
  version: STORE_VERSION,
  skin: 'default',
  mode: 'light',
  accent: '',
  bg: DEFAULT_BG,
  // 空表 = 一项都不覆盖，完全跟随皮肤。出厂时不去覆盖任何皮肤的面板层——
  // 那是一次替用户做的决定。
  surfaces: {},
}

function defaultTheme(): ThemeConfig {
  return {
    ...DEFAULT_THEME,
    bg: { ...DEFAULT_BG, tint: { ...DEFAULT_BG.tint } },
    surfaces: {},
  }
}

// ---------- 解析：皮肤 + 用户覆盖 → 最终 token ----------

/** 一次解析出来的全部结果。UI 与 DOM 都只看这个对象。 */
export interface ResolvedTheme {
  skin: Skin
  dark: boolean
  /** 生效的强调色（皮肤自带或用户覆盖），用于预览色块与图表首色 */
  accent: string
  /** 是否用了用户填的强调色 */
  customAccent: boolean
  /** **生效的**背景。这不是 `config.bg`：用户没设背景时它是皮肤自带的那一张。 */
  bg: ThemeBg
  /** 这一份背景是皮肤给的（用户没自己设）——设置面板要说出这件事 */
  bgFromSkin: boolean
  /** 生效的背景图地址；不是图片模式、或地址不合法时为空 */
  image: string
  /** **面板底色**（卡片 / 输入框 / 浮层）。预览要拿真值现画，所以在这里给十六进制，
   *  而不是让组件去读 `--wb-surface` 那个通道串。 */
  surface: string
  /** **壳底色**（侧栏 / 顶栏） */
  chrome: string
  /** **结构性边框的颜色**（卡片与浮层那一圈）。由当前中性阶里的 200 / 800 取，
   *  所以它天然跟着皮肤走；`surfaces.borderAlpha` 调的是它的浓度。 */
  border: string
  /** 面板层的其余参数（通透度 / 模糊 / 边框 / 阴影）。同上：预览要用真值。 */
  surfaces: SkinSurfaces
  /** 背景图上的压暗层 rgba()（`flat` 的那一层；`edge` 时是它的底） */
  scrim: string
  /** `edge` 时的梯度；`flat` 时是 `none` */
  scrimVeil: string
  /** 要写进 DOM 的 CSS 变量（也是预览与图表复用的一份） */
  vars: Record<string, string>
}

/** 一个皮肤认不出来的名字 → 退回默认。**永远返回一个能用的皮肤**：主题是全局底噪，
 *  它挂了整站都不好看，不值得为了一个错别字把页面变成黑白。 */
export function resolveSkin(name: string): Skin {
  return skinById(name)
}

/** **背景这一件事唯一的分派点**：用户自己设了就以用户的为准，用户没设
 * （`mode === 'skin'`）才轮到皮肤自带的那一张。
 *
 * 只有这一条规则，别处不许再分叉——两处分派的下场是「设置面板说跟着皮肤、
 * 画面却是用户那张图」这类谁也说不清的状态。
 *
 * **轮换池也在这一个分派点里**：mode 为 image、池子非空且间隔开着时，
 * 「这一刻的图」由 `rotatedImage` 按时间桶决定（`now` 是**注入**的参数——
 * 默认当前时间，测试传定值；这函数仍然是纯的，纯度的证据在测试里）。 */
export function effectiveBg(cfg: ThemeConfig, variant: SkinVariant, now: number = Date.now()): ThemeBg {
  if (cfg.bg.mode !== 'skin') {
    if (cfg.bg.mode === 'image') {
      const rotated = rotatedImage(cfg.bg, now)
      // 轮换没生效（池子空 / 间隔关）时原样返回，**对象身份不动**——
      // 上游的 useMemo 靠引用稳定性少干活
      if (rotated !== cfg.bg.image) return { ...cfg.bg, image: rotated }
    }
    return cfg.bg
  }
  const s = variant.bg
  if (!s) return cfg.bg
  // **从 `DEFAULT_BG` 起，不是从 `cfg.bg` 起**：`mode === 'skin'` 时用户并没有对
  // 「图怎么铺、压多少」表过态，去继承他那份里遗留的模糊/压暗值只会得到
  // 「换了个带图的皮肤，压暗却还是上次调的那个数」这种说不清的结果。
  return {
    ...DEFAULT_BG,
    mode: 'image',
    image: s.image,
    fit: s.fit,
    blur: s.blur,
    scrim: s.scrim,
    // **平铺的纹理一律均匀压**：格纸、纸纹这类图案被不均匀地压暗，
    // 看起来不像「有明暗」而像渲染坏了。
    scrimDir: s.fit === 'repeat' ? 'flat' : s.scrimDir,
    // 取景那五项在皮肤数据里**可以省**（见 `SkinBg`）：省了就是默认值。
    // 用 `??` 而不是直接赋值——直接赋 `undefined` 会把上面 spread 进来的默认值抹掉。
    focusX: s.focusX ?? DEFAULT_BG.focusX,
    focusY: s.focusY ?? DEFAULT_BG.focusY,
    zoom: s.zoom ?? DEFAULT_BG.zoom,
    opacity: s.opacity ?? DEFAULT_BG.opacity,
    tint: s.tint ?? DEFAULT_BG.tint,
  }
}

/** 把一份设置解算成「亮还是暗 + 一串 CSS 变量」。
 *
 *  `systemDark` 由调用方传入而**不当成常量读**：这样这个函数仍然是纯的，
 *  测试可以直接断言「同一份 mode='system' 的设置，系统暗就是暗、系统亮就是亮」，
 *  不需要去 mock 一个媒体查询。默认值取当前系统偏好，所以忘了传也不会算错。 */
export function resolveTheme(cfg: ThemeConfig, systemDark: boolean = prefersDark()): ResolvedTheme {
  const skin = skinById(cfg.skin)
  const dark = resolveColorMode(cfg.mode, systemDark)
  const variant: SkinVariant = dark ? skin.dark : skin.light
  const hex = normalizeHex(cfg.accent)
  const accent = hex ?? variant.accent
  const accentScale = hex ? accentPalette(hex) : variant.accentScale
  const bg = effectiveBg(cfg, variant)
  const image = bg.mode === 'image' ? safeImageUrl(bg.image) : ''
  // `edge` 时那层「底子」要按系数减弱：不减弱的话它与梯度叠起来会把整页都压到 p，
  // 而边缘反而更重——那就等于「均匀压暗 + 一圈更黑」，不是这里想要的东西。
  const edge = bg.scrimDir === 'edge' && Boolean(image)
  const scrim = scrimFor(edge ? bg.scrim * EDGE_BASE_RATIO : bg.scrim, dark)
  const scrimVeil = edge ? scrimVeilFor(bg.scrim, dark) : 'none'

  const vars: Record<string, string> = {}
  for (const [step, v] of Object.entries(variant.neutral)) vars[`--wb-neutral-${step}`] = v
  for (const [step, v] of Object.entries(accentScale)) {
    vars[`--wb-violet-${step}`] = v
    // fuchsia 与强调色**同一份值**：`from-violet-500 to-fuchsia-500` 那种双色渐变
    // （logo、新对话按钮）于是自动变成单色渐变——不需要逐个改组件，也不会在森林皮肤
    // 上留一个紫色的 logo。名字保留是因为类名已经写在一万处。
    vars[`--wb-fuchsia-${step}`] = v
  }
  vars['--wb-page-bg'] = pageBackground(bg, variant)
  vars['--wb-scrim'] = scrim
  vars['--wb-scrim-veil'] = scrimVeil
  vars['--wb-bg-blur'] = `${bg.blur}px`
  // ---------- 分区域的面（`theme/surfaces.ts`）----------
  //
  // 这几个变量是「整套皮肤」与「换了一张壁纸」之间真正的差别：卡片、壳、输入框、
  // 浮层各自的底色与不透明度。下游在 `index.css` 里消费它们（`.wb-card` / `.wb-chrome`
  // / `bg-white` 的面板覆盖），业务组件一个都不用知道有「皮肤」这回事。
  //
  // 通道值给 `R G B`（不是 `rgb(...)`）：要给 `.wb-card` 之外的 `bg-white/NN`
  // 覆盖也留出 alpha 通道。
  //
  // **用户覆盖叠在皮肤之上**——与 `accent` 同一条规则，只是这里是一整层：
  // `applyOverrides` 认得出几项就叠几项，一项都没拨过时得到的就是皮肤那一套。
  // 界面上能拨的项、能拨到哪儿、拨了 `glass` 时谁跟着走，三件事都在
  // `theme/surfaces.ts` 里（`SURF_KEYS` / `SURF_RANGE` / `FOLLOW_GLASS`）——
  // 这里只消费，不重述一遍。
  const surf: SkinSurfaces = applyOverrides(variant.surfaces, cfg.surfaces)
  // 结构性边框的颜色**从当前这一套中性阶里取**：亮色下是 `neutral-200`、
  // 暗色下是 `neutral-800`——那正是今天 `border-neutral-200 dark:border-neutral-800`
  // 那对写法的两个值。取出来之后边框就有了一个可命名的名字，
  // 皮肤可以在它上面调浓度，而不必去改整套中性阶（那会连文字一起改掉）。
  const border = variant.neutral[dark ? '800' : '200'] ?? variant.neutral['200']
  vars['--wb-surface'] = channels(hexToRgb(variant.surface) ?? WHITE)
  vars['--wb-surface-alpha'] = pct(panelAlpha('card', surf.glass))
  vars['--wb-surface-blur'] = `${surf.blur}px`
  vars['--wb-chrome'] = channels(hexToRgb(variant.chrome) ?? WHITE)
  vars['--wb-chrome-alpha'] = pct(surf.chromeGlass)
  vars['--wb-sidebar-alpha'] = pct(surf.sidebarGlass)
  vars['--wb-topbar-alpha'] = pct(surf.topbarGlass)
  vars['--wb-chrome-blur'] = `${surf.blur}px`
  vars['--wb-border'] = border
  vars['--wb-border-alpha'] = pct(surf.borderAlpha)
  // 输入框与浮层：**各自那一档过各自的下限**，不是「面板那一档再夹一下」——
  // 一份把输入框单独拨到 40 的皮肤，该拿到 80（地板），而不是 55（卡片的地板）。
  vars['--wb-field-alpha'] = pct(panelAlpha('field', surf.fieldGlass))
  vars['--wb-float-alpha'] = pct(panelAlpha('float', surf.floatGlass))
  vars['--wb-float-shadow'] = pct(surf.shadow)
  // 背景的取景与色调：焦点 / 缩放 / 图自身的不透明度 / 一层色调薄纱
  vars['--wb-bg-focus'] = `${bg.focusX}% ${bg.focusY}%`
  // 缩放给**无单位倍数**，因为下游是 `transform: scale()`（`background-size`
  // 在 `cover` / `contain` 下是关键字，乘不了一个倍数）。
  vars['--wb-bg-zoom'] = String(bg.zoom / 100)
  vars['--wb-bg-opacity'] = pct(bg.opacity)
  vars['--wb-bg-tint'] = tintCss(bg.tint)
  // 实底主按钮的渐变两端（`index.css` 的 `.wb-btn-primary`）。**从色阶里推，不另存一份**：
  // 白字压在按钮上，所以两端都得是能压住白字的深色。亮色取 600→700，暗色取 600→700
  // 的暗色版本——两条都落在「深」的那半条色阶里。`theme.contrast.test.ts` 量着它。
  vars['--wb-btn-from'] = `rgb(${accentScale['600']})`
  vars['--wb-btn-to'] = `rgb(${accentScale['700']})`
  // 图表调色板：首色跟随强调色，其余是皮肤自带的（EChart.tsx 从这些变量里读，
  // 所以图表配色跟主题走这件事不需要图表组件知道有「皮肤」这回事）
  vars['--wb-chart-0'] = accent
  variant.chart.forEach((c, i) => {
    vars[`--wb-chart-${i + 1}`] = c
  })
  vars['--wb-chart-grid'] = dark ? 'rgba(255, 255, 255, 0.10)' : 'rgba(16, 24, 40, 0.08)'
  vars['--wb-chart-label'] = dark ? '#9ca3af' : '#6b7280'

  return {
    skin,
    dark,
    accent,
    customAccent: hex !== null,
    bg,
    bgFromSkin: cfg.bg.mode === 'skin' && Boolean(variant.bg),
    image,
    surface: variant.surface,
    chrome: variant.chrome,
    border: channelsToHex(border),
    surfaces: surf,
    scrim,
    scrimVeil,
    vars,
  }
}

/** 压暗层：亮色模式压白、暗色模式压黑。
 *
 *  这是「自定义背景图之后正文还读得清」的唯一机制——不靠把卡片做成半透明
 *  （那会变成一层玻璃拟态，且内容一长就花），而是让图自己退到后面去。 */
export function scrimFor(pct: number, dark: boolean): string {
  const a = clamp(pct, 0, 95, 0) / 100
  return dark ? `rgba(0, 0, 0, ${a})` : `rgba(255, 255, 255, ${a})`
}

/** 边缘加重的压暗（`scrimDir === 'edge'`）。
 *
 *  ## 它解决的是什么
 *
 *  均匀压暗有个绕不过去的取舍：图花 → 压到够重才看得清字 → 图也没了。
 *  但「文字在哪里」和「图该在哪里亮着」本来就不重合：文字集中在**左边**
 *  （侧栏）和**上边**（顶栏），中间是卡片——卡片本来就不透明，那里的图不需要压。
 *  所以把压暗按位置分配，两件事就同时成立了。
 *
 *  ## 三个数怎么定的
 *
 *  滑块上那个百分比是**文字那一带**的压暗强度，不是全页的：
 *
 *  | 位置 | 强度 | 为什么 |
 *  |---|---|---|
 *  | 左边（侧栏） | `p × 0.75` | 侧栏是最多大字小字的地方 |
 *  | 上边（顶栏） | `p × 0.5` | 顶栏只有一行 |
 *  | 全页底子 | `p × 0.25` | 中间也不能是零：页面标题、空状态、无卡片的列表行都直接落在图上 |
 *
 *  左上角三者叠起来略高于 `p`，那是唯一可以多压一点的地方（顶栏与侧栏的交叉处）。
 *
 *  这个做法来自 orca-link 那套皮肤：它给场景图盖的也是一层**方向性、不对称**的渐变，
 *  深的一头压在导航文字那一侧（`rgba(6,10,16,.58)` → `.12`），而不是整屏均匀变暗。
 *  均匀压暗是浪费了那张图——多出来的暗度全花在了没人看的地方。 */
export function scrimVeilFor(pct: number, dark: boolean): string {
  const p = clamp(pct, 0, 95, 0) / 100
  const rgb = dark ? '0, 0, 0' : '255, 255, 255'
  const at = (a: number) => `rgba(${rgb}, ${(p * a).toFixed(3)})`
  // 两个方向各一条：横向管侧栏那一侧，纵向管顶栏那一侧。
  // 分开而不是一条斜的——侧栏是整条竖边，斜着压会右上角漏出来。
  //
  // 横向为什么在 20–30% 之间还留着大半强度（0.62 / 0.42）：**侧栏大约占屏宽 18%**，
  // 而它是全屏文字最密的地方。梯度要是从 0% 就开始快速衰减，侧栏右半边就已经
  // 没什么压暗了——「把暗度放在有字的地方」这件事只做了一半。
  // 30% 之后才真正放掉，中间那片留给图。
  return [
    `linear-gradient(to right, ${at(VEIL_FACTORS.side)} 0%, ${at(VEIL_FACTORS.sideMid)} 20%, ` +
      `${at(VEIL_FACTORS.sideLow)} 30%, ${at(0)} 62%)`,
    `linear-gradient(to bottom, ${at(VEIL_FACTORS.top)} 0%, ${at(0)} 34%)`,
  ].join(', ')
}

/** 全页底子那一层在 `edge` 模式下的强度系数（见 `scrimVeilFor`）。 */
export const EDGE_BASE_RATIO = 0.25

/** 页面底色（`--wb-page-bg`）——**纯色与渐变也走这条路**，不只是图片。
 *
 *  它们与图片的差别只在于「画的是颜色还是图」：颜色直接进 `--wb-page-bg`，
 *  图片由 `ThemeBackdrop` 那张固定画布画、这一层只留一个兜底色（图没加载出来时
 *  不至于是白的）。四种模式各一条分支，没有第四种写法——这是「背景」这一件事
 *  唯一的分派点。 */
export function pageBackground(bg: ThemeBg, variant: SkinVariant): string {
  if (bg.mode === 'solid') return bg.color
  if (bg.mode === 'gradient') {
    return `linear-gradient(${bg.angle}deg, ${bg.from}, ${bg.to})`
  }
  if (bg.mode === 'image') return variant.pageBg
  return variant.pageBg
}

/** 夹到区间里；**给不出数就用 `fallback`**（不是夹成 0）。
 *
 *  这两件事必须分开：`angle: 'x'` 的意思是「这个值坏了」，不是「角度是 0」——
 *  混为一谈的话，坏一个字段会把背景渐变悄悄转成水平方向。 */
function clamp(n: unknown, lo: number, hi: number, fallback: number): number {
  const v = Number(n)
  if (!Number.isFinite(v)) return fallback
  return Math.min(hi, Math.max(lo, Math.round(v)))
}

/** 0–100 的百分比 → CSS 里的 0–1 小数。**统一走这一个函数**：
 *  `.55` 与 `55%` 两种写法混用的话，改一处忘一处就是「某些地方不跟着变」。 */
function pct(v: number): string {
  return String(Math.max(0, Math.min(100, Math.round(v))) / 100)
}

/** 色调薄纱 → 一条 `rgba()`；没有色调时给 `transparent`。
 *
 *  **给 `transparent` 而不是 `none`**：它要进 `background-image` 的多层叠里，
 *  `none` 会把整条 `background-image` 作废——症状是「加了个色调，压暗层没了」。 */
function tintCss(t: Tint): string {
  const rgb = t.color ? hexToRgb(t.color) : null
  if (!rgb || t.alpha <= 0) return 'transparent'
  return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${(t.alpha / 100).toFixed(3)})`
}

// ---------- 读写 localStorage ----------

/** 老键：顶栏那个亮暗按钮在换肤功能之前往 localStorage 里写的 `theme`。
 *  留着它只为**迁移**——不迁移的话，升上来的那次打开会回到亮色（用户会认为
 *  「我的深色没了」），而这本来只是一次改名。迁移后旧键留着不动：
 *  它没有任何读者了，删它反而多一次写操作。 */
const LEGACY_DARK_KEY = 'theme'

/** 读一份设置。**任何异常都退回默认**——localStorage 可能被禁用（隐私模式）、
 *  可能存着别的版本、可能被人手改坏。主题不该是能白屏的那一环。 */
export function loadTheme(): ThemeConfig {
  try {
    const raw = localStorage.getItem(STORE_KEY)
    if (raw) return parseTheme(JSON.parse(raw))
    const legacy = localStorage.getItem(LEGACY_DARK_KEY)
    if (legacy) return { ...defaultTheme(), mode: legacy === 'dark' ? 'dark' : 'light' }
    return defaultTheme()
  } catch {
    return defaultTheme()
  }
}

/** 把「任何东西」收成一份合法的 ThemeConfig。**逐字段兜底**，不做整体信任：
 *  少一个字段就那一项用默认，其余照旧（整份丢掉会把用户配好的图片一起清掉）。
 *
 *  `version` 写的是**当前**版本，不是读到的那个——它记录的是「这份数据结构是什么」，
 *  而经过这里的对象一定是当前形状。读到的旧版本号只用来决定怎么翻译（见 `parseMode`），
 *  翻译完就没用了。 */
export function parseTheme(raw: unknown): ThemeConfig {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const bg = (o.bg && typeof o.bg === 'object' ? o.bg : {}) as Record<string, unknown>
  return {
    version: STORE_VERSION,
    skin: typeof o.skin === 'string' && hasSkin(o.skin) ? o.skin : DEFAULT_THEME.skin,
    mode: parseMode(o),
    accent: typeof o.accent === 'string' ? (normalizeHex(o.accent) ?? '') : '',
    bg: {
      mode: isBgMode(bg.mode) ? bg.mode : DEFAULT_BG.mode,
      color: str(bg.color, DEFAULT_BG.color),
      from: str(bg.from, DEFAULT_BG.from),
      to: str(bg.to, DEFAULT_BG.to),
      angle: clamp(bg.angle, 0, 360, DEFAULT_BG.angle),
      image: typeof bg.image === 'string' ? bg.image : '',
      fit: isBgFit(bg.fit) ? bg.fit : DEFAULT_BG.fit,
      blur: clamp(bg.blur, 0, 40, 0),
      // 兜底是 **62 而不是 0**：缺这一项多半是「旧版本存下来的设置」，那时还没有压暗层。
      // 按 0 兜的话，升级之后自定义背景图会突然变得看不清字——缺省值应该是能用的那一档。
      scrim: clamp(bg.scrim, 0, 95, DEFAULT_BG.scrim),
      // 兜底是 `flat`：v1 的存储里没有这一项，而它当年的行为就是均匀压。
      // 一份旧设置升级上来，看到的不该是一次静默的外观改变。
      scrimDir: isScrimDir(bg.scrimDir) ? bg.scrimDir : DEFAULT_BG.scrimDir,
      // 取景三项同理：旧记录里没有它们，兜底取「居中 / 原样 / 不透明」——
      // 那正好是它们加进来之前的行为，升级上来的人看到的还是同一张图。
      focusX: clamp(bg.focusX, FOCUS_MIN, FOCUS_MAX, DEFAULT_BG.focusX),
      focusY: clamp(bg.focusY, FOCUS_MIN, FOCUS_MAX, DEFAULT_BG.focusY),
      zoom: clamp(bg.zoom, ZOOM_MIN, ZOOM_MAX, DEFAULT_BG.zoom),
      opacity: clamp(bg.opacity, 0, 100, DEFAULT_BG.opacity),
      tint: parseTint(bg.tint),
      // 轮换池：**只收合法地址**（与 image 同一道闸）、去重、封顶——它是
      // 「壁纸收藏夹」，不是垃圾场；手改坏的那几条丢掉，好的照收
      pool: parsePool(bg.pool),
      rotateMin: clamp(bg.rotateMin, 0, 1440, DEFAULT_BG.rotateMin),
    },
    // 面板层的覆盖：一张表，认不出来的项**丢掉那一项**而不是丢掉整份
    //（与上面「逐字段兜底」同一条纪律）。旧版本的两个标量也在这里折叠进来。
    surfaces: parseSurfaces(o),
  }
}

/** 轮换池的读法。非法地址丢掉、重复的只留一个、超过上限截断。 */
function parsePool(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const item of raw) {
    const u = safeImageUrl(typeof item === 'string' ? item : '')
    if (u && !out.includes(u)) out.push(u)
    if (out.length >= MAX_BG_POOL) break
  }
  return out
}

/** 面板层覆盖的读法。**两张来源都要认**：
 *
 *  · `o.surfaces` —— 现在这张表；
 *  · `o.glass` / `o.blur` —— 只有两根滑块那会儿存的两个标量。
 *
 *  为什么不是「版本号对不上就退回默认」：那会把用户配好的皮肤、强调色、背景图
 *  一起清掉，而这次变的只是**面板层那几个数存在哪儿**。旧值能翻译就翻译——
 *  `glass: 62` 与 `surfaces: { glass: 62 }` 说的是同一件事，没有理由丢掉它。
 *
 *  范围在这里夹一次（`SURF_RANGE`）：手改过的 localStorage 进来的 `blur: 400`
 *  不该让每一帧都去重采样 400px。`applyOverrides` 那边还会再夹一次——
 *  那里夹的是**皮肤 + 覆盖**合成后的结果，两处夹的不是同一个东西。 */
function parseSurfaces(o: Record<string, unknown>): SurfOverrides {
  const raw = (o.surfaces && typeof o.surfaces === 'object' ? o.surfaces : {}) as Record<string, unknown>
  const out: SurfOverrides = {}
  for (const k of SURF_KEYS) {
    const v = raw[k]
    if (typeof v !== 'number' || !Number.isFinite(v)) continue
    const [lo, hi] = SURF_RANGE[k]
    out[k] = Math.min(hi, Math.max(lo, Math.round(v)))
  }
  // v2 → 现在：只有 `glass` / `blur` 两个标量。`null` 是「跟随皮肤」，
  // 也就是「这一项没被拨过」——正是这张表里「没有这个键」的意思。
  const legacy: [SurfKey, unknown][] = [
    ['glass', o.glass],
    ['blur', o.blur],
  ]
  for (const [k, v] of legacy) {
    if (out[k] !== undefined) continue
    if (typeof v !== 'number' || !Number.isFinite(v)) continue
    const [lo, hi] = SURF_RANGE[k]
    out[k] = Math.min(hi, Math.max(lo, Math.round(v)))
  }
  return out
}

/** 色调薄纱的读法。**认不出来就当没有**——它是一件纯装饰，为它把整份设置丢掉
 *  （于是用户的背景图也没了）不值得。这里的宽与皮肤格式那边的严是有意的：
 *  那份是**要装进来长期用**的数据，这份是**本机自己存的偏好**。 */
function parseTint(raw: unknown): Tint {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_BG.tint }
  const o = raw as Record<string, unknown>
  const color = typeof o.color === 'string' ? normalizeHex(o.color) : null
  const alpha = clamp(o.alpha, 0, 100, 0)
  if (!color || alpha <= 0) return { ...DEFAULT_BG.tint }
  return { color, alpha }
}

/** 明暗这一项的读法，**全仓只有这一份**，因为它是唯一一个跨过版本的字段：
 *  v1 存的是 `dark: boolean`，v2 存的是 `mode`。两种都要认。
 *
 *  v1 的 `dark: false` 为什么不能当成「缺省」处理：那样「用户明确选过亮色」与
 *  「从没设置过」会合并成同一件事，将来默认值一改，前者的选择就被吃掉了。
 *  读到一个能认的布尔值就是一次明确的表态，照它翻译。 */
function parseMode(o: Record<string, unknown>): ColorMode {
  if (isColorMode(o.mode)) return o.mode
  if (typeof o.dark === 'boolean') return o.dark ? 'dark' : 'light'
  return DEFAULT_THEME.mode
}

function str(v: unknown, fallback: string): string {
  return typeof v === 'string' && v ? v : fallback
}

export function saveTheme(cfg: ThemeConfig): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({ ...cfg, version: STORE_VERSION }))
  } catch {
    /* 存不下（隐私模式 / 配额满）就只在这一次会话里生效——不值得为此挡住换肤 */
  }
}

/** 恢复默认：把默认值**写回去**，而不是删掉记录。
 *
 *  为什么不是删：`ThemeProvider` 的持久化 effect 会在任何一次变更后落盘，删掉之后
 *  它立刻又把默认值写回来——「删」与「写默认」在这一层是同一件事，但前者多一步
 *  无用功，且让「恢复默认之后存储里是什么」变成一句说不清的话。
 *
 *  删记录这条路仍然存在于 `loadTheme` 那一侧（从没设置过 = 没有记录），
 *  两者不冲突：一个是「用户点了恢复默认」，一个是「这台机器从没设置过」。 */
export function saveDefaultTheme(): ThemeConfig {
  const cfg = defaultTheme()
  saveTheme(cfg)
  return cfg
}

// ---------- 落到 DOM ----------

/** 把主题写到 `<html>` 上：`dark` 类（Tailwind 的暗色变体读它）+ 一层内联 CSS 变量
 *  （tailwind.config.js 里的调色板读它）。
 *
 *  **内联样式优先级高于任何选择器**，所以这里不需要 `!important`，也不需要 `.dark`
 *  再声明一遍同样的变量——编译期的暗色变体与运行时的皮肤在这一步合流。
 *
 *  返回生效的那份变量，调用方（预览色块 / 图表）直接复用，不另算一遍。 */
export function applyTheme(r: ResolvedTheme): Record<string, string> {
  if (typeof document === 'undefined') return r.vars
  const root = document.documentElement
  root.classList.toggle('dark', r.dark)
  // 背景层画不画图由这个属性控制（`[data-wb-bg='image']`）——在类名列表里拼一个
  // 条件类名容易和别的类打架，属性选择器更直白，也让「当前是什么背景」可被断言。
  root.dataset.wbBg = r.bg.mode
  root.dataset.wbSkin = r.skin.id
  // 生效的亮暗也写成一个属性，而不是只靠 `dark` 那个类名。
  //
  // `dark` 类是给 Tailwind 的暗色变体用的（编译期产物读它），而 `data-*` 是给
  // **主题作者**用的：皮肤样式里写 `[data-wb-mode='dark']` 比写 `.dark` 稳——
  // 前者是我们自己的契约，后者是 Tailwind 的实现细节，哪天换一套暗色方案就没了。
  // 三个属性（皮肤 / 背景 / 明暗）凑齐，「现在是什么外观」这件事就完全可断言。
  root.dataset.wbMode = r.dark ? 'dark' : 'light'
  // `color-scheme` 让原生控件（滚动条、select 下拉、时间选择器）跟着亮暗走
  root.style.colorScheme = r.dark ? 'dark' : 'light'
  for (const [k, v] of Object.entries(r.vars)) root.style.setProperty(k, v)
  return r.vars
}

/** 启动引导：在 React 挂载**之前**同步跑一次，避免「先白后黑」闪一下。
 *  `main.tsx` 第一行调它——必须发生在首屏绘制之前，所以不能放进 effect。 */
export function bootTheme(): ThemeConfig {
  const cfg = loadTheme()
  applyTheme(resolveTheme(cfg))
  return cfg
}
