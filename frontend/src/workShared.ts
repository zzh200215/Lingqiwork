/** 工作模块里**几个组件都要用的**小东西。
 *
 *  为什么单独一个文件：P4 把 `CapabilityCandidate` 拆出去之后，这两个符号
 *  **两边都要用**——`fmtWhen` 被 `CapabilityCandidate` / `RunRow` / `WorkflowRow`
 *  三处用，`failedResult` 被 `CapabilityCandidate` 和 `RunRow` 两处用。
 *  留在 `WorkPage.tsx` 里的话，新文件反过来 import 页面文件，那是**循环依赖**。
 */
import { useEffect, useRef } from 'react'

import type { SkillCandidateResult } from './api'

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
