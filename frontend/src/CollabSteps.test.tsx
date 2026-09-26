/** 协作逐步账（`CollabSteps`）——A2 那句「逐步账流出来了但没做界面呈现」的那一半。
 *
 *  这里钉的不是"画得好不好看"，是**三件会误导人的事**：
 *  1. 每一步的数**照抄后端**（轮数 / 工具 / 秒数一个都不自己算）；
 *  2. **轮数烧光要显眼**：那一步交回来的是占位符，它在正文里长得像正常回答（A2 撞过）；
 *  3. 没有工具、没有步骤、有错，三种情况各说各的话。
 */
import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'

import CollabSteps from './CollabSteps'
import type { CollabStep } from './stream'

function step(patch: Partial<CollabStep> = {}): CollabStep {
  return {
    step: 1,
    title: '读材料 · 检索内核',
    phase: 'read',
    agent: '写手',
    rounds: 2,
    tools: ['vault_read_file'],
    seconds: 3.4,
    ...patch,
  }
}

describe('协作逐步账', () => {
  it('每一步一行：序号、标题、谁跑的、几轮、几次工具、几秒', () => {
    const { container } = render(
      <CollabSteps
        steps={[
          step(),
          step({ step: 2, title: '结论 · 写手', phase: 'digest', agent: '评审', rounds: 1, tools: [], seconds: 5 }),
        ]}
      />,
    )
    expect(container.querySelectorAll('[data-collab-step]').length).toBe(2)
    const text = container.textContent ?? ''
    expect(text).toContain('读材料 · 检索内核')
    expect(text).toContain('写手')
    expect(text).toContain('2 轮')
    expect(text).toContain('3.4s')
    expect(text).toContain('vault_read_file')
    // 没有工具的那一步说清楚，别留空让人以为是"没记"
    expect(text).toContain('没用工具')
    // 汇总是并行那一波的收尾：总数只报「几步并行」，不自己算总耗时
    expect(text).toContain('2 步')
  })

  it('**烧光的那一步要显眼**：它交回来的是占位符，不是答案', () => {
    const { container } = render(
      <CollabSteps
        steps={[step({ step: 1, rounds_exhausted: true }), step({ step: 2, title: '汇总', phase: 'merge' })]}
      />,
    )
    const burned = container.querySelector('[data-collab-steps-burned]')?.textContent ?? ''
    expect(burned).toContain('1 步把轮数烧光')
    expect(container.textContent).toContain('烧光')
  })

  it('出错的那一步把原因摆出来，并在表头计数', () => {
    const { container } = render(
      <CollabSteps steps={[step({ step: 3, error: 'RuntimeError: 这一路挂了' })]} />,
    )
    expect(container.querySelector('[data-collab-steps-failed]')?.textContent).toContain('1 步报错')
    expect(container.querySelector('[data-collab-step-error="3"]')?.textContent).toContain('这一路挂了')
  })

  it('没步骤就整块不渲染（协作之外的消息不该多个空壳）', () => {
    const { container } = render(<CollabSteps steps={[]} />)
    expect(container.querySelector('[data-collab-steps]')).toBeNull()
    expect(container.textContent).toBe('')
  })

  it('并行那几步会数出来（并行是编排器定的，账上要看得出来）', () => {
    const { container } = render(
      <CollabSteps
        steps={[
          step({ step: 1, parallel: true }),
          step({ step: 2, title: '读材料 · 嵌入窗口', parallel: true }),
          step({ step: 3, title: '汇总', phase: 'merge', parallel: false }),
        ]}
      />,
    )
    expect(container.textContent).toContain('2 步并行')
  })
})
