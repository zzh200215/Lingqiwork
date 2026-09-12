/** 跨模块同屏：左边主区、右边侧栏，中间一条可拖的缝。
 *
 *  侧栏目标存在 **hash**（`#aside=<编码后的 href>`），主区照旧用 query。
 *
 *  侧栏那一侧**是一个 iframe**，不是一个嵌进来的路由。这一点是这套东西的关键：
 *  - 页面排版认的是**视口**宽度。侧栏只有三五百像素，可整个窗口的视口还是一千四，
 *    把页面直接渲染进来，它会照旧按宽屏排——自己那个两三百像素的侧列就把窗格占满，
 *    真正的正文被挤成一条缝（拉分隔条也不重排，因为窗格宽度不是视口）。
 *    iframe 给了它**自己的一份视口**，页面现有的响应式排版原样生效。
 *  - 顺带解决两件事：键盘事件不会跨文档冒泡（不用再给全局快捷键加作用域），
 *    两个文档各有各的 router（不用在 Router 里嵌 Router）。
 *
 *  宽度上限不是「侧栏最多占多少」，而是「**主区至少剩多少**」——见 `split.ts`
 *  的 `asideWidth`。容器连两栏都放不下时直接不渲染侧栏（主区用满），
 *  因为把一个页面挤成 224px 比不显示侧栏糟得多。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'

import { titleFor } from './routes'
import {
  asideWidth,
  AsideContext,
  decodeAside,
  DEFAULT_ASIDE_RATIO,
  encodeAside,
  ratioForDrag,
  type AsideApi,
} from './split'

const RATIO_KEY = 'asideRatio'
/** 宠物位置要避开侧栏（它 fixed 在右下角，不躲就正好压在侧栏上）。
 *  通过这个自定义属性告诉它侧栏现在多宽——见 `PetWidget`。 */
const ASIDE_W_VAR = '--aside-w'

/** 存的是**比例**不是像素：窗口缩放、浏览器缩放，侧栏都跟着变，
 *  不像固定像素那样窗口一小就把主区挤没。 */
function storedRatio(): number {
  const raw = Number(localStorage.getItem(RATIO_KEY))
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_ASIDE_RATIO
}

export default function SplitPane({ children }: { children: React.ReactNode }) {
  const location = useLocation()
  const navigate = useNavigate()

  // 只有初次挂载从地址栏读，之后 state 是真值。
  const [href, setHref] = useState(() => decodeAside(location.hash))
  const wantHash = href ? encodeAside(href) : ''
  // 地址栏里这个 hash 是不是我们自己写的。分不开这件事就会两头挨打：
  // 分不出「用户刚贴进来的」就会被自己的旧投影抵掉（✕ 关了又开），
  // 分不出「主区换页顺手抹掉的」又会让侧栏消失。
  const ours = useRef('')

  useEffect(() => {
    if (location.hash === wantHash) {
      ours.current = wantHash
      return
    }
    const fromUrl = decodeAside(location.hash)
    if (fromUrl !== null && fromUrl !== href && location.hash !== ours.current) {
      // 地址里有别人刚放进去的 aside → 采纳。**只开不关**：地址里没有 aside 这件事
      // 有两种来源（用户清的 / 主区换页抹的）分不开，而后者必须保住侧栏。
      setHref(fromUrl)
      return
    }
    // 剩下就是把 state 投影到地址上（含 ✕ 之后的清空）
    ours.current = wantHash
    navigate(
      { pathname: location.pathname, search: location.search, hash: wantHash },
      { replace: true }
    )
  }, [href, wantHash, location.hash, location.pathname, location.search, navigate])

  // 同路径的 fragment 导航（把带 #aside= 的地址粘到已经打开的这一页上）不一定惊动路由，
  // 所以另听一个 hashchange 兜底。语义与上面一致：只开，不关。
  // `pushState`/`replaceState` 不触发 hashchange，我们自己写 URL 不会吵到自己，
  // 所以这个事件一定来自地址栏/锚点，不必再过一遍 `ours` 的判断。
  useEffect(() => {
    function onHash() {
      const fromUrl = decodeAside(window.location.hash)
      if (fromUrl !== null) setHref((cur) => (fromUrl === cur ? cur : fromUrl))
    }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  const api = useMemo<AsideApi>(
    () => ({
      href,
      open: (h) => setHref(h),
      toggle: (h) => setHref((cur) => (cur === h ? null : h)),
      close: () => setHref(null),
    }),
    [href]
  )

  const containerRef = useRef<HTMLDivElement>(null)
  const [ratio, setRatio] = useState(storedRatio)
  const ratioRef = useRef(ratio)
  ratioRef.current = ratio
  // 0 = 还没量出来。量出来之前不挤：`asideWidth` 遇到 0 会返回 0（单栏），
  // 免得首帧按 window.innerWidth 猜一个，猜大了就先闪一下两栏。
  const [containerW, setContainerW] = useState(0)
  const asideW = asideWidth(ratio, containerW)
  const dragging = useRef(false)

  useEffect(() => {
    if (!href) return
    const el = containerRef.current
    if (!el) return
    const measure = () => {
      const w = el.getBoundingClientRect().width
      if (w) setContainerW(w)
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return // jsdom 里没有
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [href])

  useEffect(() => {
    document.documentElement.style.setProperty(ASIDE_W_VAR, `${asideW}px`)
  }, [asideW])

  function startDrag(e: React.PointerEvent<HTMLDivElement>) {
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    dragging.current = true
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'col-resize'
  }

  function onDrag(e: React.PointerEvent<HTMLDivElement>) {
    if (!dragging.current) return
    const box = containerRef.current?.getBoundingClientRect()
    if (!box?.width) return
    setRatio(ratioForDrag(e.clientX, box.right, box.width))
  }

  function endDrag() {
    if (!dragging.current) return
    dragging.current = false
    document.body.style.userSelect = ''
    document.body.style.cursor = ''
    localStorage.setItem(RATIO_KEY, String(ratioRef.current))
  }

  return (
    <AsideContext.Provider value={api}>
      {/* 没有侧栏时外层是 `contents`（盒子不参与布局，页面仍是布局的直接孩子），
          有侧栏时才变成真容器。这样做的关键在**元素身份不变**：侧栏开合的那一瞬，
          主区那棵子树不会重挂——聊天里跑到一半的流不该因为点开面板就断掉。 */}
      <div ref={containerRef} className={href ? 'flex min-w-0 flex-1' : 'contents'}>
        <div className={href ? 'flex min-w-0 flex-1 flex-col' : 'contents'}>{children}</div>

        {/* `asideW === 0` = 这一屏放不下两栏（见 split.ts 的 asideWidth）。
            这时只渲染主区，让它用满；`href` 不动，窗口再拉宽侧栏自己回来。 */}
        {href && asideW > 0 ? (
          <>
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="调整侧栏宽度"
              title="拖动调整宽度"
              onPointerDown={startDrag}
              onPointerMove={onDrag}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
              className="w-1 shrink-0 cursor-col-resize bg-neutral-200 transition-colors hover:bg-violet-400 dark:bg-neutral-800 dark:hover:bg-violet-500"
            />
            <aside
              style={{ width: asideW }}
              className="flex min-w-0 shrink-0 flex-col border-l border-neutral-200/80 bg-white dark:border-neutral-800/80 dark:bg-neutral-950"
            >
              <div className="flex shrink-0 items-center gap-2 border-b border-neutral-200/80 px-3 py-1.5 dark:border-neutral-800/80">
                <span className="truncate text-[11px] font-medium uppercase tracking-wider text-neutral-400">
                  {titleFor(href)}
                </span>
                <div className="flex-1" />
                <button
                  onClick={() => setHref(null)}
                  title="关掉侧栏"
                  className="rounded-md px-1.5 text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-neutral-700 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
                >
                  ✕
                </button>
              </div>
              {/* 嵌的是同一份应用的另一份实例：它自带 router、自带视口，
                  地址栏里就是 `href` 本身（合法站内路径，decodeAside 已经验过）。 */}
              <iframe
                src={href}
                title={titleFor(href)}
                allow="clipboard-write"
                className="min-h-0 w-full flex-1 border-0 bg-white dark:bg-neutral-950"
              />
            </aside>
          </>
        ) : null}
      </div>
    </AsideContext.Provider>
  )
}
