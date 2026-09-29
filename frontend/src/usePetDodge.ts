// 「让位」（P5）的测量（方向 6 第四刀，2026-09-29 自 PetWidget 拆出）。
//
// 宠物是 fixed 悬浮层，页面排版不知道它占着右下角。对话页的输入行正好在那儿——
// 窄屏（实测窗口 <1240px）上「发送」会被压住，Playwright 点击直接报
// `img[alt="零柒"]` 拦截。与其让每个页面自己留白躲它，不如让宠物**自己让开**：
// 量一量有没有撞上标了 `[data-pet-clear]` 的东西，撞了就整块上移。
// （谁要躲开就给它标 `data-pet-clear`：对话页输入行、学页作答行、笔记页「问笔记」输入行。）
import { useCallback, useEffect, useState, type RefObject } from 'react'
import type { Nudge } from './petNudges'
import { PET_CORNER } from './petDrag'

// 页面上「宠物必须让开」的东西都标这个属性。要谁躲开就给它标这个，
// 量与让都是挂件自己的事。
const PET_CLEAR_SELECTOR = '[data-pet-clear]'

export function usePetDodge(
  panelRef: RefObject<HTMLDivElement | null>,
  open: boolean,
  bubble: string | null,
  nudge: Nudge | null,
  pathname: string
) {
  const [dodge, setDodge] = useState(0)

  // 量与让都是幂等的：值没变 setDodge 就不再渲染，所以谁都可以放心调它。
  const measure = useCallback(() => {
    const el = panelRef.current
    if (!el) return
    // 用 offset* 而不是 getBoundingClientRect：位移不能反馈进下一次测量，
    // 否则每次 setDodge 都把结果再推一遍，收不住。
    const w = el.offsetWidth
    const h = el.offsetHeight
    const right = window.innerWidth - PET_CORNER
    const bottom = window.innerHeight - PET_CORNER
    const left = right - w
    const top = bottom - h
    let lift = 0
    document.querySelectorAll(PET_CLEAR_SELECTOR).forEach((target) => {
      const r = target.getBoundingClientRect()
      if (r.width === 0 && r.height === 0) return  // 还没排版出来
      if (right > r.left && left < r.right && bottom > r.top && top < r.bottom) {
        lift = Math.max(lift, bottom - r.top + 8)
      }
    })
    // 夹紧：再怎么让位，面板顶也不能被推出视口上沿——最多抬到离屏幕顶还有 8px。
    // 横屏矮视口上不夹紧的话，「让位」会把整块推出屏幕外面。
    lift = Math.min(lift, Math.max(0, bottom - h - 8))
    setDodge(lift)
  }, [panelRef])

  useEffect(() => {
    measure()
    window.addEventListener('resize', measure)
    // 面板展开 / 气泡冒出来都会改变占地，撞没撞上要重算。jsdom 没有
    // ResizeObserver，测试环境下跳过（那边本来也量不出布局）。
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    if (ro && panelRef.current) ro.observe(panelRef.current)
    // 首屏输入行是异步量出来的，补一次；路由换了也要重算
    const late = window.setTimeout(measure, 400)
    return () => {
      window.removeEventListener('resize', measure)
      ro?.disconnect()
      window.clearTimeout(late)
    }
  }, [measure, panelRef, open, bubble, nudge, pathname])

  // 页面自己会动：内容滚动（学页的作答行跟着滚进角落）、面板后开（笔记页的
  // 「问笔记」侧栏）、「谁在右下角」随时会变——resize 和 400ms 补量都赶不上。
  // 捕获阶段的 scroll + 一颗 body 观察器，合并到每轮宏任务量一次：一次批量的
  // DOM 变更只量一回，量是幂等的，不会滚成性能洞。
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    // 清了再排（尾沿去抖）：一批变更只留最后一颗定时器，但每一脚都保证有得发——
    // 不用「来了就跳过」的布尔，那种标志一旦遇上没被冲走的定时器就永远卡住。
    const kick = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        measure()
      }, 0)
    }
    const onScroll = () => kick()
    const mo = typeof MutationObserver === 'undefined' ? null : new MutationObserver(kick)
    window.addEventListener('scroll', onScroll, { passive: true, capture: true })
    if (mo) mo.observe(document.body, { childList: true, subtree: true })
    return () => {
      window.removeEventListener('scroll', onScroll, true)
      mo?.disconnect()
      if (timer) window.clearTimeout(timer)
    }
  }, [measure])

  return dodge
}
