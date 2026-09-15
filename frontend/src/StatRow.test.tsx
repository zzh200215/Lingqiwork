// 一行事实件：值可省、语气色可分、行尾元素可跟。
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

import StatRow from './StatRow'

afterEach(cleanup)

describe('StatRow', () => {
  it('渲染 label 与 value', () => {
    render(<StatRow items={[{ label: '接地', value: '4/5' }, { label: '2 轮' }]} />)
    expect(screen.getByText(/接地/).textContent).toContain('4/5')
    expect(screen.getByText('2 轮')).toBeTruthy()
  })

  it('行尾元素跟在最后', () => {
    render(<StatRow items={[{ label: '失败' }]} trailing={<span>原因在这里</span>} />)
    expect(screen.getByText('原因在这里')).toBeTruthy()
  })
})
