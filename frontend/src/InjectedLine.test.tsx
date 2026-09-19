// S1（PLAN3 §2 S1 第 6 条）：手动跑引擎的那条路上，这一行是唯一能看见「吃到了什么」的窗口。
import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'

import InjectedLine from './InjectedLine'

describe('InjectedLine', () => {
  it('命中就摆出技能名，并说清它是匹配出来的（不是人指的）', () => {
    const { container } = render(<InjectedLine names={['给领导写汇报要结论先行']} />)
    const el = container.querySelector('[data-injected]')
    expect(el?.textContent).toContain('本次注入：给领导写汇报要结论先行')
    expect(el?.textContent).toContain('按话题匹配出来的工序')
  })

  it('没命中就什么都不渲染——不写「注入：无」（只摆真发生过的事）', () => {
    const { container } = render(<InjectedLine names={[]} />)
    expect(container.querySelector('[data-injected]')).toBeNull()
    expect(container.textContent).toBe('')
  })

  it('多份工序用顿号连起来（S1 上限 2 份）', () => {
    const { container } = render(<InjectedLine names={['甲工序', '乙工序']} />)
    expect(container.querySelector('[data-injected]')?.textContent).toContain('本次注入：甲工序、乙工序')
  })
})
