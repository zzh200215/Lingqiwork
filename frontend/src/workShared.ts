/** 工作模块里**几个组件都要用的**小东西。
 *
 *  为什么单独一个文件：P4 把 `CapabilityCandidate` 拆出去之后，这两个符号
 *  **两边都要用**——`fmtWhen` 被 `CapabilityCandidate` / `RunRow` / `WorkflowRow`
 *  三处用，`failedResult` 被 `CapabilityCandidate` 和 `RunRow` 两处用。
 *  留在 `WorkPage.tsx` 里的话，新文件反过来 import 页面文件，那是**循环依赖**。
 */
import { useEffect, useRef, useState } from 'react'

import type { SkillCandidateResult, TaskRunItem } from './api'

/** 按 **Esc** 关掉一层浮层。挂上就用，卸载就摘。
 *
 *  ## 为什么这是个共用件
 *
 *  「浮层要能用键盘关掉」在本仓是**已经定了的约定**——`QuickView` / `SelectionView` /
 *  `CommandPalette` / `PetWidget` / `FeedbackButtons` … 一共 11 处都守着。而工作模块
 *  那两个弹窗（填值使用、分类管理）当时**只能点遮罩或点 ✕**：键盘用户走到那儿就出不来了。
 *  2026-09-25 在真界面上按了一下 Esc、弹窗纹丝不动，才发现。
 *
 *  ## 为什么用 ref 记回调
 *
 *  调用方多半写成内联箭头（`onClose={() => setOpen(false)}`），那个函数**每次渲染都是新的**。
 *  直接进依赖数组的话，监听器每渲染一次就摘了重挂一次——能跑，但没必要，而且一旦哪天真
 *  出了重复触发的问题，这里是第一个要怀疑的地方。所以监听器只挂一次，回调走 ref 取最新的。
 */
export function useEscapeClose(onClose: () => void): void {
  const latest = useRef(onClose)
  latest.current = onClose
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      // 输入法正在拼字时别抢 Esc——那一下是「取消这次输入」，不是「关掉这一层」。
      if (e.isComposing) return
      e.preventDefault()
      latest.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}

/** ISO（**带偏移**）→ "09-12 08:00" 本地时间（工作流只看得到最近这些，年份没用）。
 *
 *  ## 为什么是「解析」不是「切字符串」
 *
 *  原来是 `iso.slice(5, 16)`——把字符串里那几个数字原样摆出来。那只有在后端存的
 *  就是**本地墙上时间**时才对。而后端的约定是**存 UTC**（`models.utcnow`），
 *  序列化时补上 `+00:00`（`models.iso_utc`）。所以切字符串会整整差一个时区，
 *  本时区下就是八小时——同一屏上任务行说「上次 13:58」、它自己的运行记录说「05:58」，
 *  就是这么来的（2026-09-25 在真界面上发现并修掉）。
 *
 *  这里解析成 `Date` 再按本地格式化，于是后端说 UTC、界面说本地，两边各说各的语言。
 *  取不到偏移的老字符串（裸 `2026-09-17T05:58:54`）**照旧按切片兜底**：
 *  那种值本来就没有时区信息，猜一个比原样摆出来更糟。
 */
export function fmtWhen(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso.slice(5, 16).replace('T', ' ')
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 一段时长的人话（秒进）。`elapsed`（跑完的）与 `liveElapsed`（在跑的）共用同一条口径——
 *  同一屏上「3 分 12 秒」必须永远长一个样，不能一个组件一种写法。 */
export function fmtDur(s: number): string {
  if (s < 60) return `${s} 秒`
  return `${Math.floor(s / 60)} 分 ${s % 60} 秒`
}

/** 这一次运行跑了多久。**算不出来就返回空串**（还没结束、或时间戳缺一个、或这条压根
 *  读不到）——「0 秒」是编的，「不摆」是实话。 */
export function elapsed(run?: TaskRunItem): string {
  if (!run?.started_at || !run.finished_at) return ''
  const a = Date.parse(run.started_at)
  const b = Date.parse(run.finished_at)
  if (Number.isNaN(a) || Number.isNaN(b) || b < a) return ''
  return fmtDur(Math.round((b - a) / 1000))
}

/** 在跑的东西已经跑了多久：有起点、没终点，终点取 `now`（由 `useTickingNow` 供给）。
 *  没有起点（老运行行）返回空串——同 `elapsed` 的「不编」纪律。 */
export function liveElapsed(startedAt: string | null | undefined, now: number): string {
  if (!startedAt) return ''
  const a = Date.parse(startedAt)
  if (Number.isNaN(a) || now < a) return ''
  return fmtDur(Math.round((now - a) / 1000))
}

/** 滴答钟：**只有真有在跑的东西**时才每秒重渲染一次。
 *
 *  为什么不无脑 tick：一页清单大多时候什么都没在跑，为一个「也许要看秒」的假设让
 *  整页每秒重画一遍，是拿电与 CPU 陪跑。`active=false` 时它就是个不动的 `Date.now()`，
 *  不挂定时器；`true` 的那一拍**立刻**取一次当前时刻（不等第一个整秒，否则开头一秒
 *  显示的是挂载那一刻的旧数）。
 */
export function useTickingNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const t = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [active])
  return now
}

/** 这一趟是谁叫起来的。**一份定义两处用**（工作流清单行 + 后台作业的「最近几次运行」）——
 *  原来只有清单行有人话映射，另一处直接摆英文码 `cron` / `manual`，同一屏两种语言。 */
export const TRIGGER_LABEL: Record<string, string> = {
  cron: '定时',
  manual: '手动',
  chain: '上游触发',
  watch: '监听',
}

/** 这次运行怎么样。`running` / 待审优先——它们还没结束，谈不上成败。
 *  同 `TRIGGER_LABEL`：从清单行上收上来，让「最近几次运行」也用人话，不再印 `running`。 */
export function runTone(r: TaskRunItem): { tone: 'bad' | 'warn' | 'good' | 'info'; text: string } {
  if (r.status === 'running') return { tone: 'warn', text: '运行中' }
  if (r.status === 'awaiting_approval') return { tone: 'warn', text: '等你点头' }
  if (r.status === 'ok') return { tone: 'good', text: '✓' }
  if (r.status === 'rejected') return { tone: 'info', text: '已驳回' }
  return { tone: 'bad', text: '✗' }
}

/** cron → 一句人话（学 GitHub Actions 把「触发原因」说成人话）。
 *
 *  只认**常见形状**，认不出就原样摆 cron——认不出还硬翻译才是编。
 *  原式永远悬停在 title 上（`WorkflowRow` 那边挂），想核对随时有。
 */
export function cronLabel(cron: string): string {
  const m = cron.trim().split(/\s+/)
  if (m.length !== 5) return cron
  const [min, hour, dom, mon, dow] = m
  const p2 = (n: number) => String(n).padStart(2, '0')
  // 步进：`*/N` 且 N 是纯数字才算，别的（`*/N-M` 这类）不猜
  const stepOf = (x: string) => (x.startsWith('*/') && /^\d+$/.test(x.slice(2)) ? Number(x.slice(2)) : null)
  const hhmm = `${p2(Number(hour))}:${p2(Number(min))}`
  if (dom === '*' && mon === '*') {
    const sMin = stepOf(min)
    if (sMin && hour === '*') return `每 ${sMin} 分钟`
    if (hour === '*') {
      if (min !== '*' && !min.includes(',') && !min.includes('-') && /^\d+$/.test(min) && dow === '*')
        return `每小时第 ${Number(min)} 分`
    }
    if (stepOf(hour) && /^\d+$/.test(min) && dow === '*')
      return `每 ${Number(hour.slice(2))} 小时（00:${p2(Number(min))} 起）`
    if (/^\d+$/.test(min) && /^\d+$/.test(hour)) {
      if (dow === '1-5') return `工作日 ${hhmm}`
      if (dow === '0,6' || dow === '6,0') return `周末 ${hhmm}`
      if (dow === '*') return `每天 ${hhmm}`
    }
  }
  return cron
}

/** 「读成能力」失败时的结果。**两处手写字面量合成一处。**
 *
 *  原来 `CapabilityCandidate`（按材料读）和 `RunRow`（按运行读）各写了一遍同样的
 *  11 个键——两处一模一样，改字段时漏一处就会让某一条路静默走偏。
 *
 *  顺带修掉一个语义 bug：错误态下 `ok=false, usable=false`，而界面按 `usable` 分派文案，
 *  于是**一次网络失败会被说成「没出能力」**——把「请求没成」讲成了「这份材料不行」。
 *  `reason` 里带得出原文，但得让调用方知道这是失败而不是判定，所以多给一个 `failed` 标记。
 */
export function failedResult(reason: string): SkillCandidateResult {
  return {
    ok: false,
    usable: false,
    name: '',
    description: '',
    instructions: '',
    reason,
    existing: [],
    source: '',
    model_id: '',
    written: false,
    already: '',
    // 这一条是给界面看的：**这是「没问成」，不是「问过了，不行」**
    failed: true,
  }
}
