// 产出一行式：链接 / 按钮 / 纯文本三种落点，以及右侧动作。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

import OutputCard from './OutputCard'

afterEach(cleanup)

function wrap(node: React.ReactNode) {
  return render(<MemoryRouter>{node}</MemoryRouter>)
}

describe('OutputCard', () => {
  it('有 href 就渲染成链接，带体裁标签与附带事实', () => {
    wrap(
      <OutputCard
        kind="research"
        label="研究"
        title="向量库选型"
        meta="来源 12 条"
        href="/notes?path=research/a.md"
      />
    )
    const link = screen.getByText('向量库选型').closest('a')
    expect(link?.getAttribute('href')).toBe('/notes?path=research/a.md')
    expect(screen.getByText('研究')).toBeTruthy()
    expect(screen.getByText('来源 12 条')).toBeTruthy()
  })

  it('没 href 有 onOpen 时是按钮', () => {
    const onOpen = vi.fn()
    wrap(<OutputCard label="方案" title="上向量库" onOpen={onOpen} />)
    fireEvent.click(screen.getByText('上向量库'))
    expect(onOpen).toHaveBeenCalled()
  })

  it('右侧动作渲染在行内', () => {
    wrap(<OutputCard label="交付" title="周报" href="/notes?path=x" actions={<button>改写成</button>} />)
    expect(screen.getByText('改写成')).toBeTruthy()
  })
})
