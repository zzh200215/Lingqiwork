import { useEffect, useRef, useState } from 'react'
import * as echarts from 'echarts/core'
import { BarChart, LineChart, PieChart } from 'echarts/charts'
import { GridComponent, LegendComponent, TooltipComponent } from 'echarts/components'
import { SVGRenderer } from 'echarts/renderers'
import type { EChartsCoreOption } from 'echarts/core'

// 项目里唯一的图表出口。**按需注册**（echarts/core 而不是整包 import），
// 渲染器用 SVG：仪表盘这种小数据量场景下文字更锐、没有 canvas 分数像素的糊，
// 而且在 jsdom 里也能初始化（测试不用额外 mock canvas）。
echarts.use([BarChart, LineChart, PieChart, GridComponent, LegendComponent, TooltipComponent, SVGRenderer])

const FALLBACK_PALETTE = ['#7c5cff', '#e879f9', '#38bdf8', '#34d399', '#fbbf24', '#fb7185']
const FALLBACK_LABEL = '#6b7280'
const FALLBACK_GRID = 'rgba(16, 24, 40, 0.08)'

/** 从 CSS 变量里读图表主题（`index.css` 的 `--wb-chart-*`，亮/暗各一套）。
 *  图表配色跟主题走这件事的真相放在 CSS 里，JS 只负责读。 */
function readTheme() {
  if (typeof window === 'undefined' || typeof getComputedStyle !== 'function') {
    return { palette: FALLBACK_PALETTE, label: FALLBACK_LABEL, grid: FALLBACK_GRID }
  }
  const s = getComputedStyle(document.documentElement)
  const v = (name: string, fallback: string) => s.getPropertyValue(name).trim() || fallback
  return {
    palette: FALLBACK_PALETTE.map((_, i) => v(`--wb-chart-${i}`, FALLBACK_PALETTE[i])),
    label: v('--wb-chart-label', FALLBACK_LABEL),
    grid: v('--wb-chart-grid', FALLBACK_GRID),
  }
}

/** 把主题色补进调用方的 option：只补调用方**没写**的字段（坐标轴文字、网格线、
 *  图例文字），写了的绝不覆盖——option 的形状控制权始终在页面手里。 */
function applyTheme(option: EChartsCoreOption): EChartsCoreOption {
  const { palette, label, grid } = readTheme()
  const o = { ...option } as Record<string, unknown>
  if (!o.color) o.color = palette
  o.textStyle = { color: label, ...(o.textStyle as object | undefined) }
  if (o.legend) o.legend = { textStyle: { color: label }, ...(o.legend as object) }

  const patchAxis = (a: unknown) => {
    if (!a || typeof a !== 'object') return a
    const axis = a as Record<string, any>
    return {
      ...axis,
      axisLabel: { color: label, ...(axis.axisLabel ?? {}) },
      axisLine: { ...axis.axisLine, lineStyle: { color: grid, ...(axis.axisLine?.lineStyle ?? {}) } },
      splitLine:
        axis.splitLine === false
          ? false
          : { ...axis.splitLine, lineStyle: { color: grid, ...(axis.splitLine?.lineStyle ?? {}) } },
    }
  }
  for (const key of ['xAxis', 'yAxis']) {
    if (o[key] === undefined) continue
    o[key] = Array.isArray(o[key]) ? (o[key] as unknown[]).map(patchAxis) : patchAxis(o[key])
  }
  return o as EChartsCoreOption
}

export interface EChartProps {
  option: EChartsCoreOption
  /** 像素高度。容器不给高度的话 echarts 会量出 0——必须给 */
  height?: number
  ariaLabel?: string
  className?: string
}

/** ECharts 的薄包装：容器 + 自适应 + 暗色跟随。option 变了整份重设（notMerge），
 *  因为 bento 瓦片之间的数据切换总是换整组系列，增量 merge 反而留脏状态。 */
export default function EChart({ option, height = 180, ariaLabel, className }: EChartProps) {
  const boxRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<echarts.ECharts | null>(null)
  const [dark, setDark] = useState(() =>
    typeof document === 'undefined' ? false : document.documentElement.classList.contains('dark')
  )

  // 暗色切换改的是 <html> 的 class，观察它——图表不用等整页重渲染
  useEffect(() => {
    const root = document.documentElement
    const mo = new MutationObserver(() => setDark(root.classList.contains('dark')))
    mo.observe(root, { attributes: true, attributeFilter: ['class'] })
    return () => mo.disconnect()
  }, [])

  useEffect(() => {
    const box = boxRef.current
    if (!box) return
    const chart = echarts.init(box)
    chartRef.current = chart
    // jsdom（测试环境）没有 ResizeObserver；真浏览器都有
    const ro =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(() => chart.resize())
        : null
    if (ro) ro.observe(box)
    return () => {
      ro?.disconnect()
      chart.dispose()
      chartRef.current = null
    }
  }, [])

  useEffect(() => {
    chartRef.current?.setOption(applyTheme(option), { notMerge: true })
  }, [option, dark])

  return (
    <div
      ref={boxRef}
      data-echart=""
      role="img"
      aria-label={ariaLabel}
      style={{ height }}
      className={className}
    />
  )
}
