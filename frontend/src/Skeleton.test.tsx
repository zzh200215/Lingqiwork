import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import Skeleton, { SkeletonRows } from './Skeleton'

afterEach(cleanup)

describe('Skeleton', () => {
  it('渲染 wb-skeleton 条，对读屏隐藏，接受自定义尺寸类', () => {
    const { container } = render(<Skeleton className="h-4 w-32" />)
    const el = container.firstChild as HTMLElement
    expect(el.getAttribute('class')).toContain('wb-skeleton')
    expect(el.getAttribute('class')).toContain('h-4')
    expect(el.getAttribute('aria-hidden')).toBe('true')
  })

  it('SkeletonRows 默认三行，第一行短（形状贴近真实清单）', () => {
    const { container } = render(<SkeletonRows />)
    const bars = container.querySelectorAll('.wb-skeleton')
    expect(bars.length).toBe(3)
    expect(bars[0].getAttribute('class')).toContain('w-3/4')
  })

  it('SkeletonRows rows 可调', () => {
    const { container } = render(<SkeletonRows rows={5} />)
    expect(container.querySelectorAll('.wb-skeleton').length).toBe(5)
  })
})
