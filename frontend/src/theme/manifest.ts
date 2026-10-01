/** 皮肤的**数据格式**，以及这套格式的严格校验。
 *
 *  ## 为什么皮肤要是「数据」而不是「代码」
 *
 *  换肤第一版把六个皮肤写死在 `skins.ts` 里，那意味着「加一个皮肤要改代码、重新构建」。
 *  参考的几套成熟皮肤系统都不是这么干的：DSH 的 dsh-deep-whale 每个皮肤一个
 *  `skin.json`，fcitx5 的主题每个目录一份 `theme.conf`，Codex-QQ-Skin 整个皮肤是
 *  一个可安装的包。它们共同的做法是——**宿主只认格式，不认具体哪一个皮肤**。
 *
 *  这里照做。于是一份皮肤变成可以写进 JSON、贴给别人、从别人那里导入的东西：
 *    · 加一个内置皮肤 = 往 `BUILTIN_MANIFESTS` 里加一条对象；
 *    · 加一个**自己的**皮肤 = 在设置页贴一段 JSON，一个字都不用改、不用重新构建；
 *    · 导出 = 把任意皮肤按同一个格式吐出来，改两个色号再导回去就是一份新皮肤。
 *
 *  ## 校验严格，而且「不合法 = 当它不存在」
 *
 *  每个字段都过一遍白名单（正则 / 取值域），有一项认不出就**整条丢掉**，而不是猜个
 *  默认值填上继续渲染。理由：一份被改坏的皮肤如果勉强画出来，表现是「某些颜色对了、
 *  某些没对」——那种坏法比「这张卡没出现」难查一个数量级。参考实现
 *  （dsh-deep-whale 的 `catalogEntry()`）也是这个取向：不合格的皮肤**不可见**，
 *  而不是抛异常，因为一条坏数据不该让整页打不开。
 *
 *  ## 校验里藏着一条安全线
 *
 *  `SKIN_ID_RE` 首字符必须是 `[a-z0-9]`，于是 `__proto__`、`constructor` 这类名字
 *  在解析阶段就被挡掉了——皮肤 id 会当索引用，这条正则就是原型污染的第一道闸。
 *  第二道闸在注册表里：索引是 `Map` 而不是对象字面量（见 `registry.ts`）。 */
import {
  BLACK,
  WHITE,
  accentPalette,
  hexToRgb,
  mix,
  normalizeHex,
  rgbToHex,
  type Channels,
} from './color'
import {
  DEFAULT_BG,
  DEFAULT_TINT,
  FOCUS_MAX,
  FOCUS_MIN,
  ZOOM_MAX,
  ZOOM_MIN,
  isBgFit,
  isSafeImageUrl,
  isScrimDir,
  type BgFit,
  type ScrimDir,
  type Tint,
} from './background'
import {
  BORDER_FLOOR,
  DEFAULT_SURFACES,
  MAX_PANEL_BLUR,
  fillSurfaces,
  resolveChrome,
  resolveSurface,
  type SkinSurfaces,
  type SkinSurfacesInput,
} from './surfaces'
import type { Skin, SkinVariant } from './skins'

/** 格式版本。**读到别的数字就整条拒绝**，不是尽量兼容：一份来自未来的皮肤，
 *  我们不知道它多带了什么字段、也不知道它期望的行为，猜着渲染比不渲染更糟。
 *  字段缺失则当作当前版本——手写一份皮肤时不该被迫先查版本号是多少。 */
export const SKIN_FORMAT = 1

type Scale = Record<string, Channels>
type Neutral = Record<string, Channels>

/** 皮肤**自带的一张底图**。这就是「图片式背景皮肤」那一类。
 *
 *  与用户自定义背景的关系（只有一条规则，别处不许再分叉）：
 *  **用户自己设了背景就以用户的为准；用户没设（`mode === 'skin'`）才用皮肤这张。**
 *  「恢复默认外观」于是自然回到皮肤这张——那句话的意思本来就是「回到这套皮肤的样子」。
 *
 *  为什么不让皮肤直接给一条 `linear-gradient(...)` 字符串：那样皮肤就同时掌握了
 *  「底色的色号」与「底色的画法」两件事，而画法已经有自己的一整套功能
 *  （纯色 / 渐变 / 图片 + 压暗 + 模糊）。给一张**图**是加法，
 *  给一段 CSS 是开第二个真相。 */
export interface SkinBg {
  /** 图地址。只收站内 `/skins/...`（跟着产品发的）与 http(s)。**不收 `data:`**：
   *  皮肤是数据、可能来自别人的一份 JSON，那种值会进 `url()` 且不可审阅。 */
  image: string
  /** 铺法。纹理类（格纸、纸纹）用 `repeat`，风景类用 `cover`。 */
  fit: BgFit
  /** 压暗百分比。**图越花越要压**，皮肤自己声明最合适的一档。 */
  scrim: number
  /** 压暗分布：`flat` 均匀 / `edge` 边缘加重（见 `background.ts` 的说明）。 */
  scrimDir: ScrimDir
  /** 模糊半径 px，0 = 不模糊。纹理类必须给 0——糊了就只剩一片脏色。 */
  blur: number
  /** 取景：焦点（百分比）与缩放（100 = 原样）。**一张竖图铺在宽屏上，
   *  默认的居中裁切会把要露的东西切掉**，而皮肤作者知道该露哪儿。
   *
   *  下面这五项**可以省**：省了就是「居中 / 原样 / 不透明 / 不叠色调」，
   *  也就是它们加进来之前的行为。一份写在 `skins.ts` 里的皮肤因此不必
   *  为了取景四项多出四行默认值——那是默认值，不是这套皮肤的特点。 */
  focusX?: number
  focusY?: number
  zoom?: number
  /** 图自身的不透明度 0–100。与 `scrim` 不同：这是把图**淡出**到页面底色上。 */
  opacity?: number
  /** 图上的色调薄纱。这是「整体偏青 / 偏暖」这类氛围的来处，
   *  只有压暗层的话任何一张图都只能被压向白或黑。 */
  tint?: Tint
}

/** 一个皮肤里**单个变体**（亮或暗）的数据。**每一项都是可选的**——
 *  见 `SkinManifest.accent` 上面那段「最少要写多少」。 */
export interface VariantManifest {
  /** 强调色（`#rrggbb`）。不写就跟着顶层那个 `accent` 走
   *  （暗色那一套会被自动提亮，见 `resolveAccent`）。 */
  accent?: string
  /** 可选：显式给整条色阶。**要么 11 档全给，要么一档都别给**（见 `parseScale`）。
   *  不给就由强调色推（`accentPalette`）——手写皮肤时通常不必给。 */
  accentScale?: Scale
  /** 可选：覆盖中性阶（底色与文字）。不给就用共享的那套。 */
  neutral?: Neutral
  /** 页面底色（卡片之下的那一层）。不给就由强调色推一个极淡的底。
   *  **有底图时它仍然要有**：图没加载出来的那一瞬、以及图本身透明的地方，
   *  看到的就是它。 */
  pageBg?: string
  /** 可选：图表后 5 色（第 0 色跟着强调色）。给了就必须 5 个。 */
  chart?: string[]
  /** 可选：这一套值配的那张底图。亮暗各一张（同一个皮肤两张图是常态）。 */
  bg?: SkinBg
  /** 可选：**这一套的面板层**。不写就是实心面板（产品今天的样子）。
   *  见 `theme/surfaces.ts`：一个 `glass` 旋钮驱动卡片、壳、输入框、浮层四档，
   *  其中输入框与浮层有改不动的下限。
   *  **每一项都可以省**（`SkinSurfacesInput`）：手写一份皮肤时想要的是
   *  「把面板调透一点」这一件事，不是先填七个字段。 */
  surfaces?: SkinSurfacesInput
}

/** 一份皮肤的完整数据。**这就是「一个皮肤」的全部**——没有别处藏着状态。
 *
 *  ## 最少要写多少
 *
 *  三个字段就能凑出一套能用的皮肤：
 *
 *  ```json
 *  { "id": "sakura", "label": "樱", "accent": "#d9558a" }
 *  ```
 *
 *  亮暗两套的强调色、页面底色、十一条色阶、中性阶全部由这一个色号推出来。
 *  想细调再往上叠——**每一项都是「写了就用写的，没写就推」**：
 *
 *  ```json
 *  {
 *    "id": "sakura", "label": "樱", "accent": "#d9558a",
 *    "dark": { "accent": "#f0a0bc", "pageBg": "#140d10" }
 *  }
 *  ```
 *
 *  这条「允许写一半」的规矩是从 Codex-QQ-Skin 的 `theme.json` 学来的：它的十个颜色
 *  角色同样可以只写两个，其余从主色 + 当前亮暗推（`explicitColorKeys` →
 *  `makeAdaptivePalette`）。好处很直接——**手写一份皮肤不再需要先配一整套色板**，
 *  而配错一整套色板正是「自己做皮肤」最容易劝退的一步。 */
export interface SkinManifest {
  format: number
  id: string
  label: string
  /** 一句话说明这个皮肤「是什么」，显示在选择卡上 */
  hint?: string
  /** 谁做的。内置皮肤没有；导入的皮肤会带着原始作者一起走 */
  author?: string
  /** 氛围粒子的款式（`sakura` / `firefly` / `none`）。**可以不写**：缺省
   *  `'sakura'`，也就是这个字段出现之前的行为。认不出的值退回缺省、
   *  不整条拒绝——它不是安全问题，只是参数（与 `fit` / `scrimDir` 同一条先例）。 */
  particles?: ParticleKind
  /** 整套皮肤的那个「品牌色」。**只写它也能成一套皮肤**（见上面那段）。 */
  accent?: string
  light?: VariantManifest
  dark?: VariantManifest
}

// ---------- 共享中性阶 ----------
//
// 中性阶是**底色与文字**，也就是「可读性」本身。它是格式自带的默认值，不是
// 每个皮肤各自的风格选择：皮肤之间拉开差别靠强调色与页面底色。
// 一份皮肤仍然可以覆盖它（`neutral`），但那件事没有正当理由，所以没人做。

/** 亮色中性阶。`500` **比 Tailwind 的 neutral-500 深一档**（#737373 → #6b6b6b）：
 *  它是全站次要文字的颜色，而几个皮肤的页面底色比纯白略深，`#737373` 压在上面是
 *  4.39–4.44:1，差一点到 AA 的 4.5；深一档之后是 4.99–5.05:1。那 0.1 人眼看不出来，
 *  但「换个皮肤就有一档文字不合格」是换肤自己引进来的账，该由皮肤表还掉——
 *  `theme.contrast.test.ts` 量着它。 */
export const DEFAULT_NEUTRAL_LIGHT: Neutral = {
  '50': '250 250 250',
  '100': '245 245 245',
  '200': '229 229 229',
  '300': '212 212 212',
  '400': '163 163 163',
  '500': '107 107 107',
  '600': '82 82 82',
  '700': '64 64 64',
  '800': '38 38 38',
  '900': '23 23 23',
  '950': '10 10 10',
}

export const DEFAULT_NEUTRAL_DARK: Neutral = {
  '50': '250 250 250',
  '100': '245 245 245',
  '200': '229 229 229',
  '300': '212 212 212',
  '400': '161 161 170',
  '500': '113 113 122',
  '600': '82 82 91',
  '700': '63 63 70',
  '800': '39 39 42',
  '900': '24 24 27',
  '950': '10 10 10',
}

/** 色阶的十一档。**认死这十一个键**：少一档就会出现「某个 Tailwind 类名落到
 *  `addBase` 的兜底值上」，表现是整页里某一处颜色不跟着皮肤走——比整条拒绝难查得多。 */
const STEPS = ['50', '100', '200', '300', '400', '500', '600', '700', '800', '900', '950'] as const

// ---------- 校验 ----------

/** 皮肤 id 的合法形状。它挡掉的是大写、空格、路径符号，以及 `__proto__`
 *  （首字符必须是 `[a-z0-9]`，下划线过不了）。 */
export const SKIN_ID_RE = /^[a-z0-9][a-z0-9._-]*$/

/** 另外明确拒掉的名字。**正则挡不住这一类，这是测出来的**：`constructor` 与
 *  `prototype` 都是合法的「小写字母开头」标识符，但它们在**任何对象字面量**上都能
 *  命中 `Object.prototype` 的成员——`({})['constructor']` 拿到的是 `Object` 这个
 *  构造函数。曾经 `skinById` 写成 `SKINS[id] ?? SKINS.default`，于是
 *  `skinById('constructor')` 会返回一个函数，紧接着 `skin.light` 就是 `undefined`，
 *  整页崩掉。
 *
 *  现在索引是 `Map`（不可能命中原型链），但那意味着「安全」依赖于「以后每个人都
 *  记得用 Map」。索引该用什么结构是实现细节，id 不该让任何结构出错——所以在这一层
 *  直接拒掉。 */
const RESERVED_IDS = new Set(['__proto__', 'constructor', 'prototype'])

const MAX_ID = 32
/** 名字与说明的上限。**导出给 `extract.ts`**：从文件名生成皮肤名时要按同一个
 *  上限截断，各写一个数的话会出现「生成的名字比手填的短/长一截」。 */
export const MAX_LABEL = 16
const MAX_HINT = 80
const MAX_AUTHOR = 40
/** 十六进制颜色。`normalizeHex` 连 `#abc` 那种三位的也认，这里只用来判「像不像颜色」。 */
const HEX_RE = /^#[0-9a-f]{3}([0-9a-f]{3})?$/i

// ---------- 氛围粒子（装饰是数据，不是代码） ----------

/** 皮肤自带的那层氛围粒子。**这是口味，不是能力**——画哪种、画不画，
 *  都是一份配置字段，皮肤包里没有任何一行代码。
 *
 *  缺省是 `'sakura'`：那是这个字段出现**之前**的行为（对话页一直有樱花，
 *  🌸 开关管它），字段化不许悄悄改掉它。`'firefly'` 是萤火虫（缓慢上浮、
 *  呼吸明灭），`'none'` 是这张卡不要任何粒子。 */
export type ParticleKind = 'sakura' | 'firefly' | 'none'
export const PARTICLE_KINDS: readonly ParticleKind[] = ['sakura', 'firefly', 'none']

export function isParticleKind(v: unknown): v is ParticleKind {
  return v === 'sakura' || v === 'firefly' || v === 'none'
}

/** 解析结果。**把「哪里不对」带出来**：导入失败时用户要看到的是
 *  「皮肤 id 只能是 a-z0-9._-」，而不是「导入失败」四个字。 */
export type Parsed<T> = { ok: true; value: T } | { ok: false; reason: string }

function bad<T>(reason: string): Parsed<T> {
  return { ok: false, reason }
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** 必填的字符串字段。 */
function requiredText(raw: unknown, what: string, max: number): Parsed<string> {
  if (raw === undefined || raw === null) return bad(`${what}不能为空`)
  return optionalText(raw, what, max) ?? bad(`${what}不能为空`)
}

/** 选填的字符串字段：非空、去掉首尾空白、限长。
 *  返回 `null` = **没写**（这与「写错了」是两件事：写错了返回 `ok: false`，
 *  整条皮肤被拒；没写就是没写，交给推导）。 */
function optionalText(raw: unknown, what: string, max: number): Parsed<string> | null {
  if (raw === undefined || raw === null) return null
  if (typeof raw !== 'string') return bad(`${what}必须是字符串`)
  const v = raw.trim()
  if (!v) return null
  if (v.length > max) return bad(`${what}最多 ${max} 个字`)
  return { ok: true, value: v }
}

/** `R G B` 三个 0-255。**按空白拆开再读**，所以 `107  107 107` 这种多打了一个空格
 *  的也能收进来，出来时是规范形式——手写 JSON 时最容易多打的就是空格。 */
function parseChannels(raw: unknown, what: string): Parsed<Channels> {
  if (typeof raw !== 'string') return bad(`${what}必须是 \`R G B\` 这样的字符串`)
  const parts = raw.trim().split(/\s+/)
  if (parts.length !== 3) return bad(`${what}要三个数，形如 \`107 107 107\``)
  const nums = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN))
  if (nums.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) {
    return bad(`${what}的三个数都要在 0–255 之间`)
  }
  return { ok: true, value: nums.join(' ') }
}

function parseScale(raw: unknown, what: string): Parsed<Scale> {
  if (!isObj(raw)) return bad(`${what}必须是对象`)
  const out: Scale = {}
  for (const step of STEPS) {
    const got = parseChannels(raw[step], `${what}里的 ${step}`)
    if (!got.ok) return got
    out[step] = got.value
  }
  return { ok: true, value: out }
}

function parseNeutral(raw: unknown, what: string): Parsed<Neutral> {
  // 与色阶同一套判据：中性阶也是十一档，理由一样
  const got = parseScale(raw, what)
  return got.ok ? { ok: true, value: got.value } : got
}

/** 一个变体。**每一项都可选**——只检查「写了的那几项合不合法」，不要求写全。
 *
 *  「允许写一半」这件事要成立，判据就必须是「没写」与「写错」分开：没写 = 交给
 *  `manifestToSkin` 去推；写了一个认不出的值 = 整条拒绝。把「写错」也当成「没写」
 *  去推的话，用户把 `#d9558a` 敲成 `#d9558g` 之后会看到一套「看起来很合理、但不是
 *  自己要的颜色」的皮肤，而他不会知道是自己敲错了。 */
function parseVariant(raw: unknown, side: 'light' | 'dark'): Parsed<VariantManifest> {
  const what = side === 'light' ? '亮色' : '暗色'
  // 整个变体没写是允许的（顶层 accent 会兜住）；写了但不是对象才是错。
  if (raw === undefined || raw === null) return { ok: true, value: {} }
  if (!isObj(raw)) return bad(`${what}那一组要么不写，要么写成对象`)

  const out: VariantManifest = {}

  if (raw.accent !== undefined) {
    const accent = typeof raw.accent === 'string' ? normalizeHex(raw.accent) : null
    if (!accent) return bad(`${what}的 accent 要写成 \`#rrggbb\``)
    out.accent = accent
  }

  // pageBg 只收十六进制，**不收 `linear-gradient(...)` 这类表达式**：背景（渐变、
  // 图片、压暗层）已经有自己的一整套功能与存放位置，皮肤再带一套的话就会有两种
  // 真相。皮肤决定的是「底色的色号」，不是「底色的画法」。
  if (raw.pageBg !== undefined) {
    const pageBg = typeof raw.pageBg === 'string' ? normalizeHex(raw.pageBg) : null
    if (!pageBg) return bad(`${what}的 pageBg 要写成 \`#rrggbb\``)
    out.pageBg = pageBg
  }

  if (raw.accentScale !== undefined) {
    const got = parseScale(raw.accentScale, `${what}的 accentScale`)
    if (!got.ok) return got
    out.accentScale = got.value
  }
  if (raw.neutral !== undefined) {
    const got = parseNeutral(raw.neutral, `${what}的 neutral`)
    if (!got.ok) return got
    out.neutral = got.value
  }
  if (raw.chart !== undefined) {
    if (!Array.isArray(raw.chart)) return bad(`${what}的 chart 要写成数组`)
    // **正好 5 个**：第 0 色跟着强调色，所以这里要的是后 5 色。多给少给都会让
    // 「第几号图表色是谁」变成一件要说清的事，不如直接要求 5 个。
    if (raw.chart.length !== 5) return bad(`${what}的 chart 要正好 5 个颜色`)
    const chart: string[] = []
    for (const c of raw.chart) {
      const hex = typeof c === 'string' ? normalizeHex(c) : null
      if (!hex) return bad(`${what}的 chart 里有一个不是 \`#rrggbb\``)
      chart.push(hex)
    }
    out.chart = chart
  }
  if (raw.bg !== undefined) {
    const got = parseSkinBg(raw.bg, what)
    if (!got.ok) return got
    out.bg = got.value
  }
  if (raw.surfaces !== undefined) {
    const got = parseSurfaces(raw.surfaces, what)
    if (!got.ok) return got
    out.surfaces = got.value
  }
  return { ok: true, value: out }
}

/** 皮肤自带的那张底图。
 *
 *  `image` **必须过 `isSafeImageUrl`**：它是唯一一条会被拼进 CSS `url()` 的
 *  外部字符串，而皮肤可能来自别人给的一份 JSON。只认站内 `/skins/` 与 http(s)，
 *  `javascript:` / `data:` / 相对路径一律不放行。
 *
 *  `scrim` 的下限是 **45**，不是 0：底图上的字能不能看清，不该由「皮肤作者记不记得
 *  压一层」决定。留一档兜底比事后补一条「某某皮肤看不清字」便宜得多。 */
function parseSkinBg(raw: unknown, what: string): Parsed<SkinBg> {
  if (!isObj(raw)) return bad(`${what}的 bg 要写成对象`)
  const image = typeof raw.image === 'string' ? raw.image.trim() : ''
  if (!image) return bad(`${what}的 bg 缺 image`)
  if (!isSafeImageUrl(image)) {
    return bad(`${what}的 bg.image 只能是站内 \`/skins/...\` 或 http(s) 地址`)
  }
  const fit: BgFit = isBgFit(raw.fit) ? raw.fit : 'cover'
  const tint = parseTint(raw.tint, what)
  if (tint && !tint.ok) return tint
  return {
    ok: true,
    value: {
      image,
      fit,
      scrim: clampNum(raw.scrim, MIN_SKIN_SCRIM, 95, 62),
      scrimDir: isScrimDir(raw.scrimDir) ? raw.scrimDir : 'edge',
      // **纹理类强制不模糊**：平铺的图案糊了之后不是「朦胧」而是一片脏色，
      // 那比清晰的纹理难看得多。这不是可调项，是这一类的物理事实。
      blur: fit === 'repeat' ? 0 : clampNum(raw.blur, 0, 40, 0),
      focusX: clampNum(raw.focusX, FOCUS_MIN, FOCUS_MAX, 50),
      focusY: clampNum(raw.focusY, FOCUS_MIN, FOCUS_MAX, 50),
      zoom: clampNum(raw.zoom, ZOOM_MIN, ZOOM_MAX, 100),
      opacity: clampNum(raw.opacity, 0, 100, 100),
      tint: tint && tint.ok ? tint.value : { ...DEFAULT_TINT },
    },
  }
}

/** 图上的色调薄纱。**没写就是没有**；写了但颜色认不出来 = 整条皮肤被拒
 *  （与其余字符串字段同一条纪律：写错与没写是两件事，见 `optionalText`）。 */
function parseTint(raw: unknown, what: string): Parsed<Tint> | null {
  if (raw === undefined || raw === null) return null
  if (!isObj(raw)) return bad(`${what}的 bg.tint 要写成对象`)
  const color = typeof raw.color === 'string' ? normalizeHex(raw.color) : null
  // **空串等于「没有色调」**，不是「写错了」。运行时对象里「没有色调」就是
  // `{ color: '', alpha: 0 }`（见 `DEFAULT_TINT`），而生成器与导出都可能把它
  // 原样写回来——把它当坏值的话，症状是**一份刚生成的皮肤装不上，
  // 报的还是「color 要写成 #rrggbb」，与看到的空字符串对不上号**。
  // 与 `surfaces.surface` 的空串是同一条纪律（那里踩过同一个坑）。
  if (!color) return raw.color === '' ? null : bad(`${what}的 bg.tint.color 要写成 \`#rrggbb\``)
  const alpha = clampNum(raw.alpha, 0, 100, 0)
  // alpha 0 = 等价于「没有色调」，存成默认值而不是一个「浓度为 0 的色」——
  // 后者在两个地方表示同一件事，而它们在导出时长得不一样。
  return { ok: true, value: alpha > 0 ? { color, alpha } : { ...DEFAULT_TINT } }
}

/** 面板层。**每一项都可选**，不写就是实心面板（产品今天的样子）。
 *
 *  `borderAlpha` 收在 `BORDER_FLOOR` 之上、`glass` 由 `panelAlpha()` 分区兜底：
 *  这两条下限不在这里做，因为它们要按区域算（卡片可以全透，输入框不行），
 *  而在这一层只做「形状与取值域」的校验。 */
function parseSurfaces(raw: unknown, what: string): Parsed<SkinSurfaces> {
  if (raw === undefined || raw === null) return { ok: true, value: { ...DEFAULT_SURFACES } }
  if (!isObj(raw)) return bad(`${what}的 surfaces 要么不写，要么写成对象`)
  const out: SkinSurfaces = { ...DEFAULT_SURFACES }
  for (const key of ['surface', 'chrome'] as const) {
    const raw0 = raw[key]
    // **空串等于没写**：这两项的默认值是 `''`（意思是「由页面底色推」），
    // 而 `fillSurfaces()` 会把默认值补进运行时对象——于是「导出再导入」这条路上
    // 送回来的就是这个空串。把它当成「写错了」的话，症状是
    // **一份自己导出的皮肤导不回来**，而且报的是「surface 要写成 #rrggbb」，
    // 与看到的空字符串对不上号。空串在这个格式里一律是「没写」（同 `optionalText`）。
    if (raw0 === undefined || raw0 === '') continue
    const c = typeof raw0 === 'string' ? normalizeHex(raw0) : null
    if (!c) return bad(`${what}的 surfaces.${key} 要写成 \`#rrggbb\``)
    out[key] = c
  }
  out.glass = clampNum(raw.glass, 0, 100, DEFAULT_SURFACES.glass)
  out.chromeGlass = clampNum(raw.chromeGlass, 0, 100, DEFAULT_SURFACES.chromeGlass)
  // 侧栏 / 顶栏：**不写就跟着 `chromeGlass`**（见 `fillSurfaces`）。
  // 这里给的是「写了的那个值」，跟随交给 `fillSurfaces`——两处都做的话，
  // 改一处忘一处就会得到「皮肤说跟，解析说不跟」。
  out.sidebarGlass = raw.sidebarGlass === undefined ? out.chromeGlass : clampNum(raw.sidebarGlass, 0, 100, out.chromeGlass)
  out.topbarGlass = raw.topbarGlass === undefined ? out.chromeGlass : clampNum(raw.topbarGlass, 0, 100, out.chromeGlass)
  // 输入框 / 浮层：**不写就跟着 `glass`**，理由同上（跟随只在这里与 `fillSurfaces`
  // 各表达一次，两处说的是同一件事：不写 = 跟着面板那一档）。
  // 注意这里存的是**面板那一档**，而下限（80 / 95）在 `panelAlpha()` 里才兜——
  // 一份写了 `glass: 0` 的皮肤导出的 `fieldGlass` 是 0，而它渲染出来是 80。
  // 这不是不一致：存的是作者写的意图，渲染的是下限兜过之后的结果。
  out.fieldGlass = raw.fieldGlass === undefined ? out.glass : clampNum(raw.fieldGlass, 0, 100, out.glass)
  out.floatGlass = raw.floatGlass === undefined ? out.glass : clampNum(raw.floatGlass, 0, 100, out.glass)
  out.blur = clampNum(raw.blur, 0, MAX_PANEL_BLUR, DEFAULT_SURFACES.blur)
  out.borderAlpha = clampNum(raw.borderAlpha, BORDER_FLOOR, 100, DEFAULT_SURFACES.borderAlpha)
  out.shadow = clampNum(raw.shadow, 0, 100, DEFAULT_SURFACES.shadow)
  return { ok: true, value: out }
}

/** 皮肤底图的压暗下限。见 `parseSkinBg` 的说明。 */
export const MIN_SKIN_SCRIM = 45

/** 数字字段：给不出数就用 `fallback`（与 `clamp` 同一个取向——「坏值」不等于 0）。 */
function clampNum(v: unknown, lo: number, hi: number, fallback: number): number {
  const n = Number(v)
  if (!Number.isFinite(n)) return fallback
  return Math.min(hi, Math.max(lo, Math.round(n)))
}

/** 把「任何东西」收成一份合法的皮肤。**这是唯一的入口**——内置皮肤与导入的皮肤
 *  都走它，所以「内置的能用、导入的不能用」这种分叉没有存在的余地。
 *
 *  返回 null 之外的失败原因，见 `Parsed`。 */
export function parseSkin(raw: unknown): Parsed<SkinManifest> {
  if (!isObj(raw)) return bad('皮肤得是一个 JSON 对象')

  if (raw.format !== undefined) {
    if (typeof raw.format !== 'number' || raw.format !== SKIN_FORMAT) {
      return bad(`格式版本对不上（这份是 ${String(raw.format)}，当前是 ${SKIN_FORMAT}）`)
    }
  }

  if (typeof raw.id !== 'string') return bad('缺少 id')
  const id = raw.id.trim()
  if (!id) return bad('id 不能为空')
  if (id.length > MAX_ID) return bad(`id 最多 ${MAX_ID} 个字符`)
  if (!SKIN_ID_RE.test(id)) return bad('id 只能用小写字母开头，后跟小写字母、数字、`.`、`_`、`-`')
  if (RESERVED_IDS.has(id)) return bad(`id 不能叫 \`${id}\`（与对象自带的成员重名）`)

  const label = requiredText(raw.label, '名字', MAX_LABEL)
  if (!label.ok) return label
  const hint = optionalText(raw.hint, '说明', MAX_HINT)
  if (hint && !hint.ok) return hint
  const author = optionalText(raw.author, '作者', MAX_AUTHOR)
  if (author && !author.ok) return author
  // 氛围粒子：认不出的值当「没写」，由 `manifestToSkin` 补缺省——与 fit/scrimDir
  // 同一条先例（参数写错不该让人丢掉整张卡），也不该冒充一个存在的款式。
  const particles = isParticleKind(raw.particles) ? raw.particles : undefined

  // 顶层那个「品牌色」。它与两个变体里的 accent 是一个东西的两种写法：
  // 写这里 = 亮暗共用；写变体里 = 那一边单独用。两边都没写也合法（会推一个兜底色）。
  let accent: string | undefined
  if (raw.accent !== undefined) {
    const got = typeof raw.accent === 'string' ? normalizeHex(raw.accent) : null
    if (!got) return bad('accent 要写成 `#rrggbb`')
    accent = got
  }

  const light = parseVariant(raw.light, 'light')
  if (!light.ok) return light
  const dark = parseVariant(raw.dark, 'dark')
  if (!dark.ok) return dark

  return {
    ok: true,
    value: {
      format: SKIN_FORMAT,
      id,
      label: label.value,
      hint: hint?.value,
      author: author?.value,
      particles,
      accent,
      light: light.value,
      dark: dark.value,
    },
  }
}

// ---------- 数据 ⇄ 运行时 ----------

/** 兜底的强调色：两边都没写 accent 时用它。**紫色**，与默认皮肤同源。 */
const FALLBACK_ACCENT = '#7c3aed'

/** 这一边该用哪个强调色。**优先级只有两级，写在一处**：
 *
 *  1. 变体自己写了 `accent` → 用它（用户明确表态，不再猜）。
 *  2. 没写 → 用顶层的 `accent`；暗色那一边**自动提亮**。
 *
 *  第 2 条的提亮不是装饰：同一个色号在暗底上会显得发闷，内置那六套也都是
 *  「暗色比亮色浅一档」（`#7c3aed` / `#a78bfa` 就是一对）。往白里混 28% 是量着
 *  这个差走的——再少就与亮色那套看不出区别，再多就发灰、失去色相。 */
function resolveAccent(m: SkinManifest, side: 'light' | 'dark'): string {
  const own = m[side]?.accent
  if (own) return own
  const brand = m.accent ?? FALLBACK_ACCENT
  const base = hexToRgb(brand) ?? hexToRgb(FALLBACK_ACCENT)!
  return side === 'light' ? brand : rgbToHex(mix(base, WHITE, 0.28))
}

/** 这一边的页面底色。没写就由强调色推：往白 / 黑那头推到**几乎认不出来**。
 *
 *  推得这么远（93% / 90%）是刻意的：页面底色是整站待得最久的一层，它该安静。
 *  推到 70% 就已经是一块有颜色的布，卡片浮在上面会显脏；而「皮肤有自己的底色」
 *  这件事靠 7% 的偏向已经足够被眼睛读到——把六个内置皮肤的底色摆在一起看，
 *  差别也正是这个量级。 */
function resolvePageBg(v: VariantManifest | undefined, accent: string, side: 'light' | 'dark'): string {
  if (v?.pageBg) return v.pageBg
  const rgb = hexToRgb(accent) ?? hexToRgb(FALLBACK_ACCENT)!
  return rgbToHex(mix(rgb, side === 'light' ? WHITE : BLACK, side === 'light' ? 0.93 : 0.9))
}

/** 数据 → 运行时。**这里是「没写的那些」唯一的推导处**：中性阶、由强调色推出的
 *  色阶、页面底色、以及暗色那一套的提亮。
 *
 *  「一份皮肤只写一个强调色」是这套格式最要紧的一条：手写一份皮肤时最烦的就是
 *  配十一档颜色，而它们本来就能从一个色号推出来（`accentPalette`，或者干脆
 *  抄一份 Tailwind 的色阶贴上——内置那六个就是抄的，因为它们的手感比推导的好）。
 *  推导只是默认路径，不是唯一路径。 */
export function manifestToSkin(m: SkinManifest): Skin {
  const lightAccent = resolveAccent(m, 'light')
  const darkAccent = resolveAccent(m, 'dark')
  return {
    id: m.id,
    label: m.label,
    hint: m.hint ?? '',
    author: m.author,
    // 氛围粒子的缺省是**历史行为**：樱花一直都在，字段化不许悄悄把它关掉
    particles: m.particles ?? 'sakura',
    light: toVariant(m.light, lightAccent, 'light'),
    dark: toVariant(m.dark, darkAccent, 'dark'),
  }
}

function toVariant(v: VariantManifest | undefined, accent: string, side: 'light' | 'dark'): SkinVariant {
  const dark = side === 'dark'
  const pageBg = resolvePageBg(v, accent, side)
  const surfaces = fillSurfaces(v?.surfaces)
  const surface = resolveSurface(surfaces, pageBg, dark)
  return {
    neutral: v?.neutral ?? (dark ? DEFAULT_NEUTRAL_DARK : DEFAULT_NEUTRAL_LIGHT),
    accentScale: v?.accentScale ?? accentPalette(accent),
    accent,
    pageBg,
    // 面板与壳的底色**由页面底色推**（不写的话），所以它们永远和这一套配色同源——
    // 皮肤作者只给一个 `pageBg`，三层的相对关系就已经成立了。
    surface,
    chrome: resolveChrome(surfaces, surface),
    surfaces,
    // 图表调色板的兜底：一档蓝绿黄红紫，中性到哪个皮肤上都不难看。
    // 第 0 色（`--wb-chart-0`）由 `resolveTheme` 填成强调色，这里不管。
    //
    // 为什么不从强调色推这五色：图表要的是**能被分辨**的几档色相，从一个色号推出来的
    // 是一条单色阶，画成多序列柱状图就分不出谁是谁了。宁可让图表配色与皮肤不同源，
    // 也不要一张读不出来的图。
    chart: (v?.chart as [string, string, string, string, string] | undefined) ?? [
      '#60a5fa',
      '#34d399',
      '#fbbf24',
      '#fb7185',
      '#a78bfa',
    ],
    bg: v?.bg,
  }
}

/** 运行时 → 数据。**导出这条路**：把它吐成 JSON，改两个色号再导回来就是一份新皮肤。
 *
 *  中性阶与色阶**只在「不是推导出来的那一份」时才写出去**：写了就等于把推导结果
 *  冻进文件里，于是「导出再导入」会悄悄换掉那些手调过的值（默认皮肤那两条色阶是
 *  逐档对着 Tailwind 抄的，推导推不出来），而一份只写了一个色号的皮肤导出来会变成
 *  满满一屏数字、没法读也没法改。判据是**与推导结果比**，不是与「是不是内置」比——
 *  这样内置皮肤导出来同样是能读的。 */
export function skinToManifest(s: Skin): SkinManifest {
  return {
    format: SKIN_FORMAT,
    id: s.id,
    label: s.label,
    hint: s.hint || undefined,
    author: s.author,
    // 樱花是缺省——「缺省的那一份不写出去」与中性阶/色阶是同一条纪律，
    // 一份不想要粒子的皮肤导出来才带得走那句话。
    particles: s.particles === 'sakura' ? undefined : s.particles,
    accent: s.light.accent,
    light: fromVariant(s.light, 'light'),
    dark: fromVariant(s.dark, 'dark'),
  }
}

function fromVariant(v: SkinVariant, side: 'light' | 'dark'): VariantManifest {
  const out: VariantManifest = {}
  // 亮色那一边的 accent 已经写在顶层了，不必重复
  if (side === 'dark') out.accent = v.accent
  out.pageBg = v.pageBg
  if (!sameScale(v.accentScale, accentPalette(v.accent))) out.accentScale = v.accentScale
  const neutral = side === 'light' ? DEFAULT_NEUTRAL_LIGHT : DEFAULT_NEUTRAL_DARK
  if (!sameScale(v.neutral, neutral)) out.neutral = v.neutral
  out.chart = v.chart
  if (v.bg) out.bg = compactBg(v.bg)
  // 面板层同理：与默认那一份一样就不写出去，免得一份实心皮肤的导出里
  // 多出五行「这个皮肤是实心的」——那是默认值，不是这套皮肤的特点。
  if (!sameSurfaces(v.surfaces, DEFAULT_SURFACES)) out.surfaces = v.surfaces
  return out
}

/** 底图写回去时**只写它自己的特点**。
 *
 *  取景那五项（焦点 / 缩放 / 不透明度 / 色调）等于默认值就不写——不这么做的话，
 *  一份「居中、原样」的皮肤导出来会平白多出四行默认值，而且
 *  **「导出再导入是不是同一份」那个逐字段比较会因为这些多出来的字段而不相等**。
 *  与 `sameScale` / `sameSurfaces` 同一条理：判断的基准是**推导结果**，不是「有没有写」。 */
function compactBg(b: SkinBg): SkinBg {
  const out: SkinBg = {
    image: b.image,
    fit: b.fit,
    scrim: b.scrim,
    scrimDir: b.scrimDir,
    blur: b.blur,
  }
  if (b.focusX !== undefined && b.focusX !== DEFAULT_BG.focusX) out.focusX = b.focusX
  if (b.focusY !== undefined && b.focusY !== DEFAULT_BG.focusY) out.focusY = b.focusY
  if (b.zoom !== undefined && b.zoom !== DEFAULT_BG.zoom) out.zoom = b.zoom
  if (b.opacity !== undefined && b.opacity !== DEFAULT_BG.opacity) out.opacity = b.opacity
  if (b.tint && b.tint.color && b.tint.alpha > 0) out.tint = b.tint
  return out
}

/** 两份面板层逐项相等？用于判断「这一份是不是推导出来的」，从而决定导出时写不写它。 */
function sameSurfaces(a: SkinSurfaces, b: SkinSurfaces): boolean {
  return (Object.keys(a) as (keyof SkinSurfaces)[]).every((k) => a[k] === b[k])
}

/** 两条色阶逐档相等？用于判断「这一份是不是推导出来的」，从而决定导出时写不写它。 */
function sameScale(a: Scale, b: Scale): boolean {
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k])
}

/** 通道三元组 → `#rrggbb`。给「把皮肤里某个色号显示出来」这类地方用
 *  （`AppearanceSettings` 的强调色色块、预览卡的底色）。 */
export function channelsToHex(c: Channels): string {
  const rgb = c.split(/\s+/).map(Number)
  return rgb.length === 3 && rgb.every(Number.isFinite) ? rgbToHex([rgb[0], rgb[1], rgb[2]]) : '#000000'
}

/** 一个颜色字符串能不能当 `pageBg` 用。`SkinCard` 用它判断「这个色号显示得出来吗」。 */
export function isHexColor(v: string): boolean {
  return HEX_RE.test(v) && hexToRgb(v) !== null
}
