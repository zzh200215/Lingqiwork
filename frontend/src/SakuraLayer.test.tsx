import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import SakuraLayer from './SakuraLayer'

afterEach(cleanup)

describe('SakuraLayer', () => {
  it('开：渲染一个不响应交互、对读屏隐藏的 canvas 层', () => {
    const { container } = render(<SakuraLayer on />)
    const c = container.querySelector('canvas')
    expect(c).toBeTruthy()
    expect(c?.getAttribute('aria-hidden')).toBe('true')
    expect(c?.className).toContain('pointer-events-none')
    // jsdom 没有 2d 上下文——组件必须安静退化，这正是这条渲染能活着的证据
  })

  it('关：整层不渲染', () => {
    const { container } = render(<SakuraLayer on={false} />)
    expect(container.querySelector('canvas')).toBeNull()
  })

  it('firefly：还是同一层 canvas，属性写明款式', () => {
    const { container } = render(<SakuraLayer on kind="firefly" />)
    const c = container.querySelector('canvas')
    expect(c).toBeTruthy()
    expect(c?.getAttribute('data-ambience')).toBe('firefly')
  })

  it('皮肤说「none」：开着也不画——款式是皮肤的，不是开关的', () => {
    const { container } = render(<SakuraLayer on kind="none" />)
    expect(container.querySelector('canvas')).toBeNull()
  })
})
