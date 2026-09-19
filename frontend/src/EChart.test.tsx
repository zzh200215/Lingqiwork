import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import EChart from './EChart'

// EChart 的 smoke：容器渲染得出来、option 吃得进、卸载不炸。
// jsdom 里走 SVG 渲染器（EChart.tsx 注册的就是 SVGRenderer），不需要 mock canvas。
describe('EChart', () => {
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
})
