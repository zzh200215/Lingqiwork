import { render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import EChart from './EChart'
import { applyTheme, resolveTheme, DEFAULT_THEME } from './theme'

// EChart 的 smoke：容器渲染得出来、option 吃得进、卸载不炸。
// jsdom 里走 SVG 渲染器（EChart.tsx 注册的就是 SVGRenderer），不需要 mock canvas。
describe('EChart', () => {
  afterEach(() => {
    document.documentElement.removeAttribute('style')
    document.documentElement.removeAttribute('data-wb-skin')
    document.documentElement.classList.remove('dark')
  })

  it('渲染容器并接受一份柱状图 option', () => {
    const { container, unmount } = render(
      <EChart
        height={120}
        ariaLabel="测试图"
        option={{
          xAxis: { type: 'category', data: ['一', '二'] },
          yAxis: { type: 'value' },
          series: [{ type: 'bar', data: [1, 3] }],
        }}
      />
    )
    expect(container.querySelector('[data-echart]')).toBeTruthy()
    expect(container.querySelector('[aria-label="测试图"]')).toBeTruthy()
    unmount()
  })

  it('卸载不抛错（dispose 路径）', () => {
    const { unmount } = render(
      <EChart
        height={100}
        option={{
          xAxis: { type: 'category', data: ['一', '二'] },
          yAxis: { type: 'value' },
          series: [{ type: 'line', data: [1, 2] }],
        }}
      />
    )
    expect(() => unmount()).not.toThrow()
  })

  // 换肤（2026-10-01）改的是 `<html>` 上的内联 CSS 变量，`class` 一个字节都没变——
  // 只盯 class 的观察器会让图表保持旧配色，直到有人切一次亮暗才跟上。
  // 这里切一次皮肤（不碰亮暗），断言 SVG 真的重画了。
  it('换皮肤（只改变量、不换亮暗）也会重画图表', async () => {
    const { container } = render(
      <EChart
        height={100}
        option={{
          xAxis: { type: 'category', data: ['一'] },
          yAxis: { type: 'value' },
          series: [{ type: 'bar', data: [1] }],
        }}
      />
    )
    const before = container.querySelector('[data-echart]')!.innerHTML

    applyTheme(resolveTheme({ ...DEFAULT_THEME, skin: 'ocean', mode: 'dark' }))
    await waitFor(() => {
      expect(container.querySelector('[data-echart]')!.innerHTML).not.toBe(before)
    })
  })
})
