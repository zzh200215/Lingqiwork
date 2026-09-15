// 空态统一件：钉住「主句 + 次句 + 可选操作」三件都渲染得出来。
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

import EmptyHint from './EmptyHint'

afterEach(cleanup)

describe('EmptyHint', () => {
  it('渲染主句与次句', () => {
    render(<EmptyHint title="还没有产出。" hint="去工作页写一份交付。" />)
    expect(screen.getByText('还没有产出。')).toBeTruthy()
    expect(screen.getByText('去工作页写一份交付。')).toBeTruthy()
  })

  it('没给次句就不留空行', () => {
    const { container } = render(<EmptyHint title="空" />)
    // 只有主句一个 <p>
    expect(container.querySelectorAll('p').length).toBe(1)
  })

  it('给了操作就渲染在框里', () => {
    render(<EmptyHint title="还没有工作流。" action={<button>装一条</button>} />)
    expect(screen.getByText('装一条')).toBeTruthy()
  })
})
