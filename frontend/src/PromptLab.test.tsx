// 实验室（Q1 的提示词对照台）：登记表列表 + 一条的全貌 + 一次对照的报告。
//
// 三条最该被钉住的不是渲染，是**态度**：
// 1. 这一页**不能改提示词**（内容只读——它是源码的事实，不是这里的配置）；
// 2. 区间宽就说宽，不给一个好看的比例；
// 3. 候选变体只出现在报告里，绝不回写登记表。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import PromptLab from './PromptLab'
import type { PromptCheckReport, PromptRegistryEntry, PromptRegistryEntryDetail } from './api'

vi.mock('./api', () => ({
  api: {
    promptRegistry: vi.fn(),
    promptEntry: vi.fn(),
    checkPrompt: vi.fn(),
  },
}))
import { api } from './api'

function entry(patch: Partial<PromptRegistryEntry> = {}): PromptRegistryEntry {
  return {
    name: 'FEYNMAN_PROMPT',
    module: 'app.core.tutor',
    purpose: '费曼反转教学：用户讲，模型当那个没搞懂的学生 + 考官',
    kind: 'prompt',
    sha: 'abc123def456',
    bytes: 812,
    drifted: false,
    cases: 8,
    fixture: 'feynman.json',
    baseline: {
      at: '2026-09-15T10:00:00',
      passed: 6,
      cases: 8,
      rate: 0.75,
      ci_low: 0.41,
      ci_high: 0.93,
      model_id: 'sensenova/flash-lite',
      stale: false,
    },
    ...patch,
  }
}

const DETAIL: PromptRegistryEntryDetail = {
  name: 'FEYNMAN_PROMPT',
  module: 'app.core.tutor',
  purpose: '费曼反转教学：用户讲，模型当那个没搞懂的学生 + 考官',
  kind: 'prompt',
  sha: 'abc123def456',
  content: '你在「费曼模式」里扮演一个聪明但没搞懂的 学生 + 考官。',
  fixture: 'feynman.json',
  note: '第一条对照',
  cases: [
    {
      id: 'term-dropping',
      intent: '甩术语不解释：规则 2 要求他用大白话重说一遍',
      user: 'asyncio 事件循环就是 event loop。',
      checks: ['asks_a_question', 'asks_for_plain_language'],
    },
    {
      id: 'solid-first-try',
      intent: '一次就讲圆了：规则 7 应当请他给完全外行的人再讲一遍',
      user: '事件循环就是一个不停转的圈。',
      checks: ['asks_for_layperson'],
    },
  ],
  checks: [
    { name: 'asks_a_question', why: '规则 1「像一个真诚困惑的学生那样提问」' },
    { name: 'asks_for_plain_language', why: '规则 2「要求他用大白话重说一遍」' },
    { name: 'asks_for_layperson', why: '规则 7「给完全外行的人再讲一遍」' },
  ],
  runs: [
    {
      id: 3,
      at: '2026-09-15T10:00:00',
      key: 'FEYNMAN_PROMPT',
      prompt_sha: 'abc123def456',
      variant_sha: '',
      variant_label: '',
      model_id: 'sensenova/flash-lite',
      cases: 8,
      passed: 6,
      rate: 0.75,
      ci_low: 0.41,
      ci_high: 0.93,
      seconds: 42,
      detail_json: '{}',
    },
  ],
}

const REPORT: PromptCheckReport = {
  key: 'FEYNMAN_PROMPT',
  module: 'app.core.tutor',
  purpose: DETAIL.purpose,
  kind: 'prompt',
  prompt_sha: 'abc123def456',
  variant_sha: '',
  variant_label: '',
  model_id: 'sensenova/flash-lite',
  total: 2,
  passed: 1,
  rate: 0.5,
  ci: [0.09, 0.91],
  tell: false,
  assertions: { total: 4, failed: 2 },
  seconds: 9.5,
  calls: 2,
  baseline: { at: '2026-09-15T10:00:00', passed: 6, total: 8, variant_label: '' },
  flips: [{ id: 'solid-first-try', was: true, now: false }],
  context: '空上下文（无召回 / 无材料 / 无画像）——上下文会显著改变行为',
  run_id: 4,
  cases: [
    {
      id: 'term-dropping',
      intent: '',
      user: 'asyncio 事件循环就是 event loop。',
      checks: ['asks_a_question', 'asks_for_plain_language'],
      passed: true,
      failed: [],
      reply: '那 control 交回 loop 的时候，谁记着这个函数？',
      chars: 22,
      seconds: 3,
      error: '',
    },
    {
      id: 'solid-first-try',
      intent: '',
      user: '事件循环就是一个不停转的圈。',
      checks: ['asks_for_layperson'],
      passed: false,
      failed: [{ name: 'asks_for_layperson', why: '规则 7「给完全外行的人再讲一遍」' }],
      reply: '所以它一直转？',
      chars: 7,
      seconds: 3,
      error: '',
    },
  ],
}

beforeEach(() => {
  vi.mocked(api.promptRegistry).mockResolvedValue({ prompts: [entry()], inline: [] })
  vi.mocked(api.promptEntry).mockResolvedValue(DETAIL)
  vi.mocked(api.checkPrompt).mockResolvedValue(REPORT)
})

afterEach(cleanup)

describe('PromptLab', () => {
  it('列出登记表，并给三种事实之一：有用例 / 没有基线 / 没有用例', async () => {
    vi.mocked(api.promptRegistry).mockResolvedValue({
      prompts: [
        entry(),
        entry({ name: 'CHAT_SYSTEM', module: 'app.core.pet', cases: 0, baseline: null }),
        entry({ name: 'FEYNMAN_PROMPT_X', cases: 8, baseline: null, sha: 'zzz' }),
      ],
      inline: [],
    })
    render(<PromptLab />)
    expect(await screen.findByText('6/8 · 75%')).toBeTruthy()
    expect(screen.getByText('没有基线')).toBeTruthy()
    expect(screen.getByText('没有用例')).toBeTruthy()
    expect(screen.getByText('登记表 3 条')).toBeTruthy()
  })

  it('选一条：看到用例、断言（鼠标停上去是哪句话）、内容只读折叠', async () => {
    const { container } = render(<PromptLab />)
    fireEvent.click(await screen.findByText('FEYNMAN_PROMPT'))
    await waitFor(() => expect(api.promptEntry).toHaveBeenCalledWith('FEYNMAN_PROMPT'))
    expect(await screen.findByText('golden set 2 条')).toBeTruthy()
    expect(screen.getByText('「asyncio 事件循环就是 event loop。」')).toBeTruthy()

    // 内容默认收着，点开才有——而且它是 <pre>（读，不是改）
    expect(container.querySelector('pre')).toBeNull()
    fireEvent.click(screen.getByText('看内容（只读）'))
    expect(container.querySelector('pre')?.textContent).toContain('费曼模式')
    expect(container.querySelector('textarea[readonly]')).toBeNull()
  })

  it('跑一次对照：k/n、Wilson、逐条结果与失败的那条断言为什么挂', async () => {
    const { container } = render(<PromptLab />)
    fireEvent.click(await screen.findByText('FEYNMAN_PROMPT'))
    fireEvent.click(await screen.findByText('跑一次对照（已登记内容）'))

    await waitFor(() => expect(api.checkPrompt).toHaveBeenCalledWith('FEYNMAN_PROMPT', {}))
    const report = await waitFor(() => {
      const el = container.querySelector('[data-lab-report]')
      if (!el) throw new Error('还没有报告')
      return el
    })
    expect(report.textContent).toContain('1/2')
    expect(report.textContent).toContain('Wilson 9%–91%')
    expect(report.textContent).toContain('2 次调用')
    // 区间太宽就说太宽，不给一个好看的比例
    expect(report.textContent).toContain('区间太宽')
    // 失败的那条 + 它挂在哪句断言上（why 是后端给的，界面不抄）
    expect(report.textContent).toContain('asks_for_layperson')
    expect(report.textContent).toContain('规则 7')
    // 翻面也写出来
    expect(report.textContent).toContain('solid-first-try')
    // 重放边界写在报告里
    expect(report.textContent).toContain('空上下文')
  })

  it('逐条结果里摊着模型的原话——失败时人能自己看一眼', async () => {
    render(<PromptLab />)
    fireEvent.click(await screen.findByText('FEYNMAN_PROMPT'))
    fireEvent.click(await screen.findByText('跑一次对照（已登记内容）'))
    await screen.findByText(/1\/2/)
    expect(screen.getByText('所以它一直转？')).toBeTruthy()
  })

  it('候选变体：报告标出「候选」，并明说它不会进登记表', async () => {
    const { container } = render(<PromptLab />)
    fireEvent.click(await screen.findByText('FEYNMAN_PROMPT'))
    fireEvent.click(await screen.findByText(/拿一段候选变体比一比/))
    fireEvent.change(container.querySelector('textarea') as HTMLTextAreaElement, {
      target: { value: '你是考官。反问。' },
    })
    fireEvent.change(screen.getByPlaceholderText(/给它起个名字/), {
      target: { value: '试·极简版' },
    })
    vi.mocked(api.checkPrompt).mockResolvedValue({
      ...REPORT,
      variant_sha: 'v123',
      variant_label: '试·极简版',
    })
    fireEvent.click(await screen.findByText('跑候选变体'))

    await waitFor(() =>
      expect(api.checkPrompt).toHaveBeenCalledWith('FEYNMAN_PROMPT', {
        variant: '你是考官。反问。',
        variant_label: '试·极简版',
      })
    )
    const report = await waitFor(() => {
      const el = container.querySelector('[data-lab-report]')
      if (!el) throw new Error('还没有报告')
      return el
    })
    expect(report.textContent).toContain('候选 试·极简版')
  })

  it('没有用例的那条：跑不了，按钮是禁用的（不假装能跑）', async () => {
    vi.mocked(api.promptEntry).mockResolvedValue({ ...DETAIL, cases: [] })
    render(<PromptLab />)
    fireEvent.click(await screen.findByText('FEYNMAN_PROMPT'))
    const btn = (await screen.findByText('跑一次对照（已登记内容）')) as HTMLButtonElement
    expect(btn.disabled).toBe(true)
  })

  it('登记表读不到时给一句话，不是空白页', async () => {
    vi.mocked(api.promptRegistry).mockRejectedValue(new Error('后端不在'))
    render(<PromptLab />)
    expect(await screen.findByText(/读登记表出错了：后端不在/)).toBeTruthy()
  })
})
