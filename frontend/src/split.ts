/** 跨模块同屏的协议：侧栏目标编码进 **hash**，外加宽度钳制。
 *
 *  为什么是 hash 而不是 query——两个理由，缺一不可：
 *  1. 各页面清自己参数用的是 `setSearchParams({}, …)` / 整段 replace，
 *     侧栏放在 query 里会被顺手抹掉；
 *  2. 侧栏目标可能带两个参数（`/?new=&repo=`、`/kb?clip=&title=`），
 *     键值对 query 表达不了「一整个 href」。
 *
 *  hash 不参与路由匹配，也不进 `useSearchParams`，所以主区的参数逻辑原样有效。
 */
import { createContext, useContext } from 'react'

export const ASIDE_KEY = 'aside'

/** 侧栏最窄宽度——比这还窄就没有并排的意义了。 */
export const MIN_ASIDE = 260
/** **主区必须留住的宽度。** 它才是主角：侧栏是来搭手的，不是来抢地方的。
 *  没有这条下限，1000px 的窗口里侧栏能把它挤成 224px（笔记页直接没法用）。 */
export const MAIN_MIN = 460
/** 侧栏最多占容器这个比例，用户拖到头也就这么宽。 */
export const MAX_ASIDE_RATIO = 0.45
/** 默认占容器约三成——"侧"栏就该是侧栏。 */
export const DEFAULT_ASIDE_RATIO = 0.3

/** href → `#aside=<编码后的 href>`。 */
export function encodeAside(href: string): string {
  return `#${ASIDE_KEY}=${encodeURIComponent(href)}`
}

/** `location.hash` → 侧栏目标；没有、解得不对、或不是站内路径 → null。
 *
 *  校验不是形式主义：这个字符串会被塞进嵌套路由去渲染。`javascript:` 之类的东西
 *  不该有机会进来（MemoryRouter 不会执行它，但没必要留一个「只有靠下游才安全」
 *  的输入）。
 */
export function decodeAside(hash: string): string | null {
  if (!hash || !hash.startsWith('#') || hash.length < 2) return null
  const raw = new URLSearchParams(hash.slice(1)).get(ASIDE_KEY)
  if (raw === null) return null
  const href = raw.trim()
  if (!isInAppPath(href)) return null
  return href
}

/** 站内路径：单个 `/` 开头（不是 `//`），且不含控制字符。
 *  绝对 URL（`https://…`）、`javascript:`、`//evil.com` 这类协议相对地址都会被挡下。 */
export function isInAppPath(href: string): boolean {
  if (!href.startsWith('/') || href.startsWith('//')) return false
  for (let i = 0; i < href.length; i++) {
    const code = href.charCodeAt(i)
    if (code < 0x20 || code === 0x7f) return false
  }
  return true
}

/** 侧栏该占多宽（px）。**返回 0 = 这一屏不开分栏**，主区自己用满。
 *
 *  宽度存的是**比例**不是像素：窗口放大缩小、浏览器缩放，侧栏都跟着走，
 *  不像固定像素那样窗口一小就把主区挤没。上下限都换算成这一屏的实际情况：
 *  - 上限 = min(容器 max 比例, 容器 − 主区下限)——主区先拿到它要的，剩下的才是侧栏的；
 *  - 连最窄的侧栏都塞不下时返回 0：两个都要、两个都残，不如只留主角。
 */
export function asideWidth(ratio: number, container: number): number {
  const room = Number.isFinite(container) && container > 0 ? container : 0
  if (room === 0) return 0 // 还没量出来（jsdom、首帧）——先不挤
  const ceiling = Math.min(room * MAX_ASIDE_RATIO, room - MAIN_MIN)
  if (ceiling < MIN_ASIDE) return 0
  const want = (Number.isFinite(ratio) ? ratio : DEFAULT_ASIDE_RATIO) * room
  return Math.round(Math.min(Math.max(want, MIN_ASIDE), ceiling))
}

/** 拖到某个位置 → 换算成比例存起来。上下限不在这里收，交给 `asideWidth`——
 *  拖动当下和之后每一帧用的是同一套判据。 */
export function ratioForDrag(pointerX: number, right: number, container: number): number {
  if (!Number.isFinite(container) || container <= 0) return DEFAULT_ASIDE_RATIO
  const px = Math.max(0, right - pointerX)
  return Math.min(Math.max(px / container, 0.05), MAX_ASIDE_RATIO)
}

/** 侧栏的开/关。**无论有没有分栏都要能用**——页面上的「在侧栏打开」按钮
 *  靠它把一个 href 送上侧栏，所以 Provider 总是挂着，不是有 aside 才挂。 */
export interface AsideApi {
  /** 当前侧栏目标；null = 没开。 */
  href: string | null
  open: (href: string) => void
  /** 已经是这个目标就关掉——入口按钮因此天然是个开关。 */
  toggle: (href: string) => void
  close: () => void
}

const NO_ASIDE: AsideApi = { href: null, open: () => {}, toggle: () => {}, close: () => {} }

export const AsideContext = createContext<AsideApi>(NO_ASIDE)

/** 拿不到 Provider 时不炸，给一个什么都不做的。
 *  外壳永远挂着 Provider（`Layout` → `<Outlet/>` 外面就是 `SplitPane`），所以这条
 *  路径只在「单独渲染某个页面」时走到——测试里就是这样。 */
export function useAside(): AsideApi {
  return useContext(AsideContext)
}
