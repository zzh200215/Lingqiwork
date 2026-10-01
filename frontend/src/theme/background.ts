/** 自定义背景的数据形状与默认值。
 *
 *  单独一个文件是因为它被两边同时引用：`theme.ts`（解析 / 持久化）与
 *  `AppearanceSettings.tsx`（表单）。放在任何一边都会让另一边反向依赖。 */

export type BgMode = 'skin' | 'solid' | 'gradient' | 'image'

/** 背景图上那层**色调**。
 *
 *  与压暗层（`scrim`）分开，因为它们是两件事：
 *  · 压暗层是**可读性**机制，颜色由明暗模式定死（亮色压白、暗色压黑），
 *    强度按图算出来；
 *  · 色调是**风格**机制，颜色由皮肤给（一层深海蓝、一层暖褐），
 *    强度由皮肤作者定。
 *
 *  合成一层皮的时候两者叠着用：「一张图 + 一层皮肤色的薄纱」是这类皮肤最典型的做法，
 *  而只有压暗层的话，任何一张图都只能被压向白或黑——做不出「整体偏青」这种效果。 */
export interface Tint {
  /** `#rrggbb`。空串 = 不叠色调（默认）。 */
  color: string
  /** 0–100。0 = 不叠。 */
  alpha: number
}

export const DEFAULT_TINT: Tint = { color: '', alpha: 0 }

export function isTint(v: unknown): v is Tint {
  return typeof v === 'object' && v !== null && 'color' in v && 'alpha' in v
}

export interface ThemeBg {
  /** skin = 跟着皮肤走（不覆盖）；其余三种是用户明确指定的 */
  mode: BgMode
  /** mode === 'solid' */
  color: string
  /** mode === 'gradient'：起止色 + 角度（CSS `linear-gradient` 的角度） */
  from: string
  to: string
  angle: number
  /** mode === 'image'：`/api/images/xxx.png`、皮肤自带的 `/skins/xxx.svg`，或任意 http(s) 地址 */
  image: string
  /** 铺法：cover 铺满（默认）/ contain 完整显示 / repeat 平铺（纹理、格纸这类） */
  fit: BgFit
  /** 图片模糊半径 px，0 = 不模糊 */
  blur: number
  /** 图片上的压暗层百分比，0 = 不压。**默认给足**：自定义背景最常见的翻车
   *  就是「图很美，字看不见」，默认值应该是能用的那一档。 */
  scrim: number
  /** 压暗怎么分布：
   *  · `flat` 均匀一层（默认，最直白）
   *  · `edge` 往边缘加重——文字多在左边（侧栏）和上边（顶栏），中间反而该留给图。
   *    这是「图很美、字也要看得清」这两件事同时成立的办法：均匀压到够，
   *    图就没了；只压该压的地方，两边都保住。 */
  scrimDir: ScrimDir
  /** 图的焦点（`background-position` 的百分比）。**一张竖图铺在宽屏上，
   *  默认的居中裁切会把人的头切掉**——这类「图选对了、位置不对」的抱怨，
   *  修法是给两个数字，而不是给一个裁剪工具。50/50 = 居中。 */
  focusX: number
  focusY: number
  /** 缩放百分比，100 = 按 `fit` 原本的大小。**这是「取景」的另一个自由度**：
   *  想把某个局部放大当背景，不必先去把图裁一遍。 */
  zoom: number
  /** 图自身的不透明度 0–100（100 = 不透明）。与 `scrim` 不同：
   *  这个是把图**淡出**到页面底色上，压暗是往图上盖一层。 */
  opacity: number
  /** 图上的色调薄纱。见 `Tint`。 */
  tint: Tint
  /** **轮换池**：几张图按间隔轮着当壁纸（`rotateMin > 0` 且 `mode === 'image'`
   *  时生效）。只在 mode 为 image 时有意义——「跟着皮肤」与轮换是两回事。 */
  pool: string[]
  /** 轮换间隔（分钟），0 = 不轮换。档位见 `ROTATE_CHOICES`。 */
  rotateMin: number
}

export type BgFit = 'cover' | 'contain' | 'repeat'
export type ScrimDir = 'flat' | 'edge'

export function isBgFit(v: unknown): v is BgFit {
  return v === 'cover' || v === 'contain' || v === 'repeat'
}

export function isScrimDir(v: unknown): v is ScrimDir {
  return v === 'flat' || v === 'edge'
}

/** `edge` 压暗在各处保留的强度系数（相对滑块上那个数）。
 *
 *  **放在这里而不是 `theme.ts`**：它有两个读者——画渐变的 `scrimVeilFor()` 与
 *  「按图算压暗」的 `extract.ts`。两处各写一份的话，改了一个另一个不会跟着动，
 *  症状是「算出来的压暗是够的、画出来却不够」，而这种偏差肉眼极难判断
 *  （差 10% 的压暗看起来只是「这张图亮一点」）。 */
export const VEIL_FACTORS = {
  /** 侧栏最左：全屏文字最密的地方 */
  side: 0.75,
  /** 侧栏右缘（约屏宽 20%）：**文字带里最弱的一档**，算压暗时按它兜底 */
  sideMid: 0.62,
  /** 侧栏之外的过渡带 */
  sideLow: 0.42,
  /** 顶栏：只有一行字，所以比侧栏轻 */
  top: 0.5,
  /** 全页底子：中间也不能是零——页面标题、空状态、无卡片的列表行直接落在图上 */
  base: 0.25,
} as const

export const DEFAULT_BG: ThemeBg = {
  mode: 'skin',
  color: '#f5f6f8',
  from: '#eef1f6',
  to: '#dfe5ee',
  angle: 160,
  image: '',
  fit: 'cover',
  blur: 0,
  scrim: 62,
  scrimDir: 'flat',
  focusX: 50,
  focusY: 50,
  zoom: 100,
  opacity: 100,
  tint: { ...DEFAULT_TINT },
  pool: [],
  rotateMin: 0,
}

/** 焦点 / 缩放 / 不透明度的取值域。**导出给解析层用**：三处（用户设置、皮肤数据、
 *  面板滑块）都要夹同一个区间，各写一份迟早对不上。 */
export const FOCUS_MIN = 0
export const FOCUS_MAX = 100
/** 缩放下限 100：**不允许缩到比「铺满」更小**。小于 100 会在边上露出底色，
 *  那不是「取景」而是「没铺满」——想要留白的话该用 `contain`。 */
export const ZOOM_MIN = 100
export const ZOOM_MAX = 250

export function isBgMode(v: unknown): v is BgMode {
  return v === 'skin' || v === 'solid' || v === 'gradient' || v === 'image'
}

/** 纯色 / 渐变的几档预设。**不用霓虹色**：底色是整站待得最久的一层，
 *  它该安静。这几档都是「能当纸用」的低饱和色。 */
export const SOLID_PRESETS = [
  '#ffffff',
  '#f6f7f9',
  '#eef0f3',
  '#e7e5e4',
  '#f3f1ec',
  '#eceef1',
  '#1b1c1e',
  '#20232a',
  '#151a1c',
  '#1d1b18',
]

export const GRADIENT_PRESETS: { label: string; from: string; to: string; angle: number }[] = [
  { label: '晨雾', from: '#f4f6fa', to: '#e2e8f2', angle: 160 },
  { label: '米纸', from: '#faf7f0', to: '#ece3d4', angle: 150 },
  { label: '松林', from: '#eef4ee', to: '#d9e6dc', angle: 160 },
  { label: '深海', from: '#eef3f8', to: '#d7e3ef', angle: 155 },
  { label: '暮色', from: '#20232b', to: '#12141a', angle: 165 },
  { label: '炭灰', from: '#1c1d1f', to: '#0e0f11', angle: 160 },
]

/** 背景图地址的合法性：只认站内图片接口、**皮肤自带的资源目录**，与 http(s)。
 *  `javascript:` / `data:` 之类一律不放行——这条值会进 `url(...)`。
 *
 *  `/skins/` 是给「图片式背景皮肤」用的：那些图跟着产品一起发，
 *  地址必须是写死的站内路径（不能是外部图床，否则离线或对方改了就没了）。 */
export function isSafeImageUrl(url: string): boolean {
  const u = (url || '').trim()
  if (!u) return false
  if (u.startsWith('/api/images/')) return true
  if (u.startsWith('/skins/')) return true
  return /^https?:\/\//i.test(u)
}

/** 用户输入的一串东西 → 可以放进 `url()` 的地址；不合法返回 ''。 */
export function safeImageUrl(url: string): string {
  const u = (url || '').trim()
  return isSafeImageUrl(u) ? u : ''
}

/** 视频壁纸的认法：按扩展名认 mp4 / webm（浏览器原生能播的两种）。
 *
 *  只用于「这一层画 `<video>` 还是画图」的分派，**合法性仍由 `isSafeImageUrl`
 *  把关**——那条只认站内与 http(s)，扩展名它不关心。动态壁纸与静态图在数据里
 *  是同一个字段（`bg.image`），分派是渲染层的事：加一种「会动的壁纸」
 *  没有给皮肤格式加第二个真相。 */
export function isVideoUrl(url: string): boolean {
  return /\.(mp4|webm)(?:[?#]|$)/i.test((url || '').trim())
}

// ---------- 轮换池 ----------

/** 轮换间隔的档位（分钟）。0 = 关。**档位收在这一个数组里**：界面与解析
 *  各写一份的话，「每天」哪天换就会变成一件说不清的事。 */
export const ROTATE_CHOICES = [10, 30, 60, 1440] as const

/** 池子上限。壁纸不是仓库——想囤图有 vault，这里只放「轮着看的这几张」。 */
export const MAX_BG_POOL = 12

/** 轮换池在「这一刻」该用哪张。
 *
 *  **时间桶，不是定时器**：按间隔把时间轴切块（`floor(now / 间隔)`），同一块内
 *  永远是同一张。于是换图不需要写盘、不需要 setInterval 撑着——刷新、重开、
 *  第二个标签页，大家看的是同一块钟，自然同一张图。这是本地优先工具该有的
 *  轮换：状态在时间里，不在任何一份存档里。
 *
 *  池子空 / 间隔为 0 → 返回 `image` 本身（轮换不生效）。 */
export function rotatedImage(
  bg: Pick<ThemeBg, 'pool' | 'rotateMin' | 'image'>,
  now: number,
): string {
  const pool = bg.pool.filter(Boolean)
  if (!pool.length || bg.rotateMin <= 0) return bg.image
  const bucket = Math.floor(now / (bg.rotateMin * 60_000))
  return pool[bucket % pool.length] ?? bg.image
}
