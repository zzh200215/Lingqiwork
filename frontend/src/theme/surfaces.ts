/** **分区域的面**：一套皮肤能影响的每一层 UI，各自有一份「底」。
 *
 *  ## 为什么要有这个文件
 *
 *  换肤做到「换底色 + 换强调色」之后，剩下的差距全在这里：**面板层**。
 *  在这之前全仓的卡片、输入框、下拉、侧栏、顶栏的底色都是**写死的**
 *  （`bg-white` 169 处、`dark:bg-neutral-900` 之类的 325 处）。皮肤改不动它们，
 *  于是「换了一套皮肤」在观感上仍然只是「换了一张壁纸 + 换了按钮颜色」。
 *
 *  一个成熟的皮肤（Codex 那类社区皮肤就是这个形状）会让**背景、面板、
 *  壳、边框、强调色一起构成一个视觉体系**：图是氛围，面板是承托，字是结果。
 *  这一层就是那个「面板」。
 *
 *  ## 一个数，还是五个数
 *
 *  皮肤作者最想要的旋钮只有一个：**这套皮肤有多通透**。所以主要入口是 `glass`
 *  （0–100，100 = 完全不透明），其余几样都有默认值，不写就按它推：
 *
 *  | 区域 | 写的名字 | 默认怎么来 | 下限 | 为什么 |
 *  |---|---|---|---|---|
 *  | 卡片 / 面板 | `glass` | — | 55 | 主角 |
 *  | 侧栏 / 顶栏 | `sidebarGlass` / `topbarGlass` | `chromeGlass`（不写 = 85） | 0 | 壳要能看清导航，但它压在整条边上，容忍度与卡片不同 |
 *  | 输入框 / 内嵌小面 | `fieldGlass` | `glass` | 80 | **可读性的地板**：字打在一张全透的框里没法用 |
 *  | 浮层（模态/下拉） | `floatGlass` | `glass` | 95 | 浮层盖在内容上，透了就是两层字叠在一起 |
 *
 *  下限是**刻意不给作者改的**（见 `FIELD_FLOOR` / `FLOAT_FLOOR`）：这不是风格选择，
 *  是这类界面能不能用。参考实现里踩过这个坑——面板一透，底下滚动的内容就穿上来，
 *  两条正文叠在一起，谁也读不了。
 *
 *  ## 「跟着走」是一种**默认**，不是一个禁令
 *
 *  上面那张表里每一行的「默认怎么来」都是**跟随**：不写就跟着主旋钮。
 *  所以一份只写 `glass: 70` 的皮肤，五层会一起变成 70（输入框与浮层各自兜在下限上），
 *  而想分开的人**每一层都能单独写**——参考实现（Codex Dream Skin）里
 *  `sidebar` 与 `header` 就是两个独立的通透度，那不是多此一举：侧栏压着一整条竖边、
 *  顶栏只有一行，两者对「透多少」的容忍度本来就不一样。
 *
 *  用户的覆盖（`SurfOverrides`）走同一条链：**同一个键在皮肤里写过、用户也拨过，
 *  以用户为准**；用户没拨过的键跟着用户拨过的主旋钮走（`applyOverrides`）。
 *  这样「分区域」对写皮肤的人成立，对只拨滑块的人也成立。
 *
 *  ## 边框与阴影
 *
 *  `borderAlpha` 与 `shadow` 各有下限，理由同上，而且**契约管着它们**：
 *  `docs/ui-design-contract.md` §1 说分层靠边框、阴影只留给浮在上面的东西。
 *  所以这两项影响的范围是**分开**的——边框只作用于结构性面板，
 *  阴影只作用于浮层，卡片永远没有常驻阴影（那不是这里能开的旋钮）。 */
import { normalizeHex } from './color'

/** 夹到区间里；**给不出数就用 `fallback`，不是夹成 0**——坏值不等于零值，
 *  与 `theme.ts` 的 `clamp` 同一个取向。 */
function clampNum(v: unknown, lo: number, hi: number, fallback: number): number {
  const n = Number(v)
  if (!Number.isFinite(n)) return fallback
  return Math.min(hi, Math.max(lo, Math.round(n)))
}

export type PanelKey = 'card' | 'field' | 'float'

/** 面板层里**每一项可以被单独写、也可以被单独拨**的值。**这是一张闭集**：
 *  皮肤格式、用户覆盖的解析、界面上的滑块、运行时解析四处都从它派生——
 *  加一个区域只改这里一处（与下面 `PANEL_FLOOR` 同一条纪律）。
 *
 *  顺序大体就是界面上的顺序：五个区域在前（卡片 / 侧栏 / 顶栏 / 输入框 / 浮层），
 *  三样「不是某个区域、而是整层」的在后（模糊 / 边框 / 浮层阴影）。
 *  `chromeGlass` 也在这一组里，但**界面上没有它那一行**——它是壳的底档，
 *  侧栏与顶栏不写时跟着它；用户要分的是侧栏与顶栏，不需要先理解「壳的底档」。 */
export const SURF_KEYS = [
  'glass',
  'chromeGlass',
  'sidebarGlass',
  'topbarGlass',
  'fieldGlass',
  'floatGlass',
  'blur',
  'borderAlpha',
  'shadow',
] as const

export type SurfKey = (typeof SURF_KEYS)[number]

/** 用户对面板层的覆盖。**每一项都可以省**，省了就是「跟随皮肤」。
 *
 *  为什么是一张表而不是几个标量字段：这一层有八个值，而「用户拨过哪一项」
 *  本身就是信息——界面要据此决定「跟随皮肤」那个复位按钮显不显示。
 *  写成 `glass: number | null` 那样的话，加一个区域就要动
 *  `ThemeConfig`、解析、存储、界面四处，而漏掉解析那一处的症状是
 *  「拨了，刷新之后没了」。 */
export type SurfOverrides = Partial<Record<SurfKey, number>>

/** 三档面的默认不透明度来源。**这是一张表，不是三处 if**——
 *  面板的种类以后会增加（侧栏里的分组、右侧栏），加一种只该在这里加一行。
 *
 *  卡片那一档的下限是 **55 而不是 0**：全透的卡片不是「通透」，是「没有卡片」——
 *  内容直接压在图上，字与图互相干扰，而卡片本来唯一的职责就是把内容托起来。
 *  55% 是量着「底下的图还看得见、字仍然压得住」取的。 */
export const PANEL_FLOOR: Record<PanelKey, number> = {
  card: 55,
  field: 80,
  float: 95,
}

/** 输入框的下限。见文件顶部那段：这不是风格选择，是这类界面能不能用。 */
export const FIELD_FLOOR = PANEL_FLOOR.field
/** 浮层的下限。盖在内容上的东西透了，就是两层字叠在一起。 */
export const FLOAT_FLOOR = PANEL_FLOOR.float

/** 结构性边框的不透明度下限。**0 是不允许的**：契约说分层靠边框，
 *  没有边框的卡片在一张花图上会糊成一片。 */
export const BORDER_FLOOR = 55

/** 面板与壳的模糊**上限**。**24，不是 40**——三个独立的 Codex 换肤项目
 *  都在这件事上退过一步：HeiGe 把侧栏从 20px 降到 8px、气泡从 22px 降到 8px
 *  （源码里的原话是「大半径模糊会逐帧重采样」「大模糊是卡顿主因」），
 *  awesome-codex-skins 整套皮肤只用 2/4/6px，DreamSkin 那份允许集的上限是 30px。
 *  实测分布是「内容 4–8px、壳 14–20px」——再往上画面上几乎看不出差别，
 *  而每一帧都要重新采样。 */
export const MAX_PANEL_BLUR = 24

/** 默认的壳不透明度。产品今天就是「侧栏 70 / 顶栏 85」两档，
 *  统一成一档是这一轮的决定（见 `docs/ui-design-contract.md` §8.5）：
 *  两个数不一样是历史遗留，不是设计，而换肤要求「壳」是一个可命名的区域。 */
export const DEFAULT_CHROME_GLASS = 85

/** 壳**实际**有多透——亮暗两档都对半分。
 *
 *  它是 `CHROME_VEIL` 的真相：算背景压暗（`theme/extract.ts`）时要按
 *  「文字压在壳上之后实际看到什么」来解，而壳自己就是半透明的。
 *  **两处各写一份的下场是「算出来的压暗淡了」**——那种偏差肉眼只会读成
 *  「这张图有点亮」。所以这里从 `DEFAULT_CHROME_GLASS` 推，不手写。
 *
 *  注意它说的是**默认值**：皮肤可以自己改 `chromeGlass`，而生成皮肤时用的是默认值
 *  （生成的皮肤不写 `surfaces`），所以这个模型对「从图片现做一套皮肤」那条路是准的。 */
export const CHROME_VEIL = {
  light: { side: DEFAULT_CHROME_GLASS / 100, top: DEFAULT_CHROME_GLASS / 100 },
  dark: { side: DEFAULT_CHROME_GLASS / 100, top: DEFAULT_CHROME_GLASS / 100 },
} as const

export interface SkinSurfaces {
  /** 面板底色 `#rrggbb`。空 = 由页面底色推（`resolveSurface`）。 */
  surface: string
  /** 壳（侧栏 / 顶栏）底色。空 = 跟 `surface`。 */
  chrome: string
  /** 面板通透度 0–100。100 = 完全不透明。 */
  glass: number
  /** 壳通透度 0–100。不写 = `DEFAULT_CHROME_GLASS`。
   *  它是**侧栏与顶栏共用的那一档**（壳在默认情况下是一个区域）。 */
  chromeGlass: number
  /** 侧栏 / 顶栏**各自**的一档，不写就跟 `chromeGlass`。
   *
   *  为什么留着它们：壳「是一个区域」是**默认**，不是禁令。参考实现
   *  （Codex Dream Skin）把 `sidebar` 与 `header` 当成两个可以各自设的通透度，
   *  而那样的皮肤确实存在——侧栏压着一整条竖边、顶栏只有一行，
   *  两者对「透多少」的容忍度本来就不一样。
   *  默认一档是为了**大多数皮肤不用写**，两个出口是为了想分的人分得开。 */
  sidebarGlass: number
  topbarGlass: number
  /** 输入框（以及一切「内嵌的小面」）的通透度。不写 = 跟 `glass`。
   *  有 `FIELD_FLOOR` 兜着：字打在一张全透的框里没法用。 */
  fieldGlass: number
  /** 浮层（模态 / 下拉）的通透度。不写 = 跟 `glass`。
   *  有 `FLOAT_FLOOR` 兜着：浮层盖在内容上，透了就是两层字叠在一起。 */
  floatGlass: number
  /** 面板与壳的 `backdrop-filter` 模糊 px。0 = 不模糊。
   *  上限见 `MAX_PANEL_BLUR`（24）——**不是随便定的**，理由写在那儿。 */
  blur: number
  /** 结构性边框的不透明度 0–100，下限 `BORDER_FLOOR`。 */
  borderAlpha: number
  /** 浮层阴影强度 0–100。0 = 无影，100 = 产品今天的样子。
   *  **只作用于浮层**——卡片的常驻阴影是契约禁止的。 */
  shadow: number
}

/** 不写 `surfaces` 时的一套值。**与产品今天的样子一致**（除了壳的统一那一档）：
 *  面板实心、没有模糊、边框实心、浮层阴影照旧。 */
export const DEFAULT_SURFACES: SkinSurfaces = {
  surface: '',
  chrome: '',
  glass: 100,
  chromeGlass: DEFAULT_CHROME_GLASS,
  sidebarGlass: DEFAULT_CHROME_GLASS,
  topbarGlass: DEFAULT_CHROME_GLASS,
  fieldGlass: 100,
  floatGlass: 100,
  blur: 0,
  borderAlpha: 100,
  shadow: 100,
}

/** 一份**写法**：每一项都可以省，省了就取默认值。
 *
 *  手写一份皮肤时最想要的是「就把面板调透一点」这一件事，而不是先填七个字段。
 *  所以数据层收的是这个偏的形状，`fillSurfaces()` 负责补齐——
 *  与 `VariantManifest` 的「每一项都可选」是同一条纪律。 */
export type SkinSurfacesInput = Partial<SkinSurfaces>

/** 补齐一份面板层。**唯一一处做这件事的地方**：数据层、运行时、预览三处
 *  各写一遍 `?? DEFAULT_...` 的话，漏一处就是「某个地方的面板不跟皮肤走」。
 *
 *  四项有**跟随**语义，而不是各自一个常数：
 *  · 侧栏 / 顶栏不写就跟 `chromeGlass`——否则一份写了 `chromeGlass: 60`
 *    的皮肤会发现壳没跟着动；
 *  · 输入框 / 浮层不写就跟 `glass`——它们是「面板那一档」在两个更严的下限上的样子，
 *    而不是独立的一个数。 */
export function fillSurfaces(v?: SkinSurfacesInput): SkinSurfaces {
  const merged = { ...DEFAULT_SURFACES, ...(v ?? {}) }
  if (v?.sidebarGlass === undefined) merged.sidebarGlass = merged.chromeGlass
  if (v?.topbarGlass === undefined) merged.topbarGlass = merged.chromeGlass
  if (v?.fieldGlass === undefined) merged.fieldGlass = merged.glass
  if (v?.floatGlass === undefined) merged.floatGlass = merged.glass
  return merged
}

/** 一个区域最终的不透明度。**下限在这里兜，作者改不动**。 */
export function panelAlpha(key: PanelKey, glass: number): number {
  return Math.max(PANEL_FLOOR[key], clampNum(glass, 0, 100, 100))
}

/** 面板底色。没写就由页面底色推：**往白那头退一点**，让面板**浮**在页面之上。
 *
 *  两个方向都往白：亮色下页面本来是白的（推 4% 还是白），暗色下页面很深
 *  （推 6% 才把面板从页面里分出来）。**面板永远比页面亮一档**是这套界面分层的
 *  基本事实——参考 `default` 皮肤今天的值：页面 `#0a0a0a`、卡片 `neutral-900`
 *  （`#18181b`），推 6% 得到 `#191919`，差 1–2 个色阶。
 *
 *  为什么不直接等于页面底色：两者一样的话，在有背景图时面板与页面就分不开了——
 *  面板的全部意义就是「承托内容的那一层」。 */
export function resolveSurface(surfaces: SkinSurfaces, pageBg: string, dark: boolean): string {
  if (surfaces.surface) return normalizeHex(surfaces.surface) ?? pageBg
  return push(pageBg, dark ? 0.06 : 0.04)
}

/** 壳底色。没写就跟面板——壳与面板同色是常态，分开写是想要「侧栏比卡片深一档」。 */
export function resolveChrome(surfaces: SkinSurfaces, surface: string): string {
  return surfaces.chrome ? (normalizeHex(surfaces.chrome) ?? surface) : surface
}

/** 把 `#rrggbb` 往白（`t` > 0）或黑（`t` < 0）那头推 `|t|`。 */
function push(hex: string, t: number): string {
  const n = parseInt((normalizeHex(hex) ?? '#ffffff').slice(1), 16)
  const mix = (v: number): number => (t >= 0 ? v + (255 - v) * t : v * (1 + t))
  return (
    '#' +
    [(n >> 16) & 255, (n >> 8) & 255, n & 255]
      .map((v) => Math.round(mix(v)).toString(16).padStart(2, '0'))
      .join('')
  )
}

// ---------- 用户能拨到哪儿（写在这儿：上面两张表是它的输入）----------

/** 每一项能拨到哪儿。**上限不是审美**：模糊那一条的理由写在 `MAX_PANEL_BLUR`
 *  （三个独立实现都在 24px 上下退过一步），边框那一条的理由写在 `BORDER_FLOOR`。
 *  这张表同时是**用户覆盖的夹子**：滑块拨不出这个区间，手改的 localStorage 也进不来。 */
export const SURF_RANGE: Record<SurfKey, readonly [number, number]> = {
  glass: [0, 100],
  chromeGlass: [0, 100],
  sidebarGlass: [0, 100],
  topbarGlass: [0, 100],
  fieldGlass: [0, 100],
  floatGlass: [0, 100],
  blur: [0, MAX_PANEL_BLUR],
  borderAlpha: [BORDER_FLOOR, 100],
  shadow: [0, 100],
}

/** 拨「面板通透度」时**跟着一起走**的那几项。
 *
 *  它们是同一条链上的下游：主旋钮一动，没被单独拨过的下游跟着动。
 *  `chromeGlass` 在其中是因为它就是「壳那一档」的底——侧栏与顶栏各自的一档
 *  不写时跟着它（见 `fillSurfaces`）。 */
const FOLLOW_GLASS: readonly SurfKey[] = [
  'chromeGlass',
  'sidebarGlass',
  'topbarGlass',
  'fieldGlass',
  'floatGlass',
]

/** 把用户的覆盖叠到皮肤那一套之上。**全仓唯一一处做这件事的地方**：
 *  运行时（写 CSS 变量）与预览（画微缩工作台）都走它，两处各写一遍的话，
 *  预览与真实界面会在某个区域上不一致，而那种不一致正是「预览」最不该出的错。
 *
 *  两条规则：
 *  1. 覆盖里**认得出**的项才算数，且夹进 `SURF_RANGE`——手改 localStorage 进来的
 *     一个 `blur: 400` 不该让每一帧都去重采样 400px。
 *  2. 拨过 `glass` 时，**没被单独拨过的**下游跟着走。这条不是便利：用户拖
 *     「面板通透度」时的意图是「整个界面透一点」，只改卡片那会让这根滑块看起来
 *     只做了一半（而它以前确实管着壳——见 `docs/ui-design-contract.md` §8.7）。 */
export function applyOverrides(base: SkinSurfaces, ov?: SurfOverrides): SkinSurfaces {
  const out: SkinSurfaces = { ...base }
  const src = ov ?? {}
  for (const k of SURF_KEYS) {
    const v = src[k]
    if (typeof v !== 'number' || !Number.isFinite(v)) continue
    const [lo, hi] = SURF_RANGE[k]
    out[k] = Math.min(hi, Math.max(lo, Math.round(v)))
  }
  if (typeof src.glass === 'number' && Number.isFinite(src.glass)) {
    for (const k of FOLLOW_GLASS) {
      if (typeof src[k] === 'number' && Number.isFinite(src[k])) continue
      out[k] = out.glass
    }
  }
  return out
}

/** 覆盖表里有没有**真正生效**的项。界面靠它决定「跟随皮肤」那个出口显不显示。
 *
 *  「生效」与 `applyOverrides` 认的是同一件事：**能读成有限数的才算**。
 *  一个 `NaN`（手改坏、或某个上游算崩了）在合成时会被忽略，所以它也不该让
 *  「已覆盖」那个状态亮起来——否则界面会出现一个按下去什么都不变的「跟随皮肤」。 */
export function hasOverrides(ov?: SurfOverrides): boolean {
  return SURF_KEYS.some((k) => {
    const v = (ov ?? {})[k]
    return typeof v === 'number' && Number.isFinite(v)
  })
}

/** 一项**能拨到的最实那一头**——也就是它的地板。
 *
 *  界面上滑块的下限取这个数，而不是 `SURF_RANGE` 里的 0：一个能拨到 0
 *  而渲染出来是 55（卡片）的滑块是在骗人，「我明明拨到底了，怎么还这么实」。
 *  地板仍然是**地板**（`panelAlpha()` 那边照旧兜着），这里只是让控件说真话。 */
export function surfFloor(k: SurfKey): number {
  if (k === 'glass') return PANEL_FLOOR.card
  if (k === 'fieldGlass') return FIELD_FLOOR
  if (k === 'floatGlass') return FLOAT_FLOOR
  return SURF_RANGE[k][0]
}

/** 一项**实际**是多少（过地板、过值域）。界面显示这个数，而不是皮肤或覆盖里
 *  写的那个：写了 40 的输入框渲染出来是 80，界面上显示 40 就成了
 *  「滑块说 40、界面是 80」——这类偏差会让人不再相信这一整块面板。 */
export function surfValue(s: SkinSurfaces, k: SurfKey): number {
  const v = s[k]
  if (k === 'glass') return panelAlpha('card', v)
  if (k === 'fieldGlass') return panelAlpha('field', v)
  if (k === 'floatGlass') return panelAlpha('float', v)
  const [lo, hi] = SURF_RANGE[k]
  return Math.min(hi, Math.max(lo, Math.round(v)))
}
