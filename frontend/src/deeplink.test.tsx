// 深链落点：`?card=7` 要滚到那一条并亮一下；数据没到 / 没参数时什么都不做。
// jsdom 不实现 scrollIntoView，这里把它换成 spy——顺带断言「有没有滚」。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

import { useDeepLink } from './deeplink'

function Probe({ ready = true }: { ready?: boolean }) {
  useDeepLink('card', ready)
  return (
    <div>
      <div id="card-7">目标</div>
      <div id="card-8">别的</div>
    </div>
  )
}

function stubScroll() {
  const scroll = vi.fn()
  Element.prototype.scrollIntoView = scroll
  return scroll
}

const hot = (id: string) => document.getElementById(id)!.classList.contains('wb-hot')

afterEach(cleanup)

describe('useDeepLink', () => {
  it('把 ?card=7 那一条滚进视野并亮一下，别的不动', () => {
    const scroll = stubScroll()
    render(
      <MemoryRouter initialEntries={['/?card=7']}>
        <Probe />
      </MemoryRouter>
    )
    expect(hot('card-7')).toBe(true)
    expect(hot('card-8')).toBe(false)
    expect(scroll).toHaveBeenCalled()
  })

  it('数据还没到时不动——元素都还不存在', () => {
    const scroll = stubScroll()
    render(
      <MemoryRouter initialEntries={['/?card=7']}>
        <Probe ready={false} />
      </MemoryRouter>
    )
    expect(hot('card-7')).toBe(false)
    expect(scroll).not.toHaveBeenCalled()
  })

  it('没有参数时什么都不做', () => {
    const scroll = stubScroll()
    render(
      <MemoryRouter initialEntries={['/']}>
        <Probe />
      </MemoryRouter>
    )
    expect(hot('card-7')).toBe(false)
    expect(scroll).not.toHaveBeenCalled()
  })
})
