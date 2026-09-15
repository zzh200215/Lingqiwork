// 形态（Q3）：一个领域的三个数、什么时候算数、什么时候一句话都不肯说。
//
// 这一页最该被钉住的不是渲染，是**不肯说**：样本不够时不许给一个比例，也不许把
// 「检索得住」写成「学会了」。所以下面有一条专门盯「样本不足」，一条专门盯那句非宣称。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

import FormPane from './FormPane'
import type { EvalItem, FormDomain, FormReport } from './api'

vi.mock('./api', () => ({
  api: {
    form: vi.fn(),
    listEvalItems: vi.fn(),
    updateEvalItem: vi.fn(),
    runEval: vi.fn(),
  },
}))
import { api } from './api'

const GROWN: FormDomain = {
  domain: '教学',
  retrieval: {
    enough: true,
    cases: 3,
    labelled: 3,
    hits: 3,
    hit_rate: 1.0,
    ci_low: 0.44,
    ci_high: 1.0,
    faithfulness: 4.5,
    judged: 3,
    run_id: 7,
    at: '2026-09-15T10:00:00+00:00',
    note: '',
  },
  concepts: {
    enough: true,
    mastered: 2,
    seen: 3,
    names: ['asyncio 事件循环', 'SQLite WAL 模式'],
    at: '2026-09-15T10:00:00+00:00',
  },
  skills: [
    {
      name: 'FEYNMAN_PROMPT',
      purpose: '费曼反转教学',
      passed: 3,
      cases: 8,
      rate: 0.375,
      ci_low: 0.14,
      ci_high: 0.69,
      at: '2026-09-15T10:00:00+00:00',
      stale: false,
      enough: true,
    },
  ],
  grown: true,
}

const THIN: FormDomain = {
  domain: '法律',
  retrieval: {
    enough: false,
    cases: 2,
    labelled: 4,
    hits: 1,
    hit_rate: 0.5,
    ci_low: 0.09,
    ci_high: 0.91,
    faithfulness: null,
    judged: 0,
    run_id: 7,
    at: '2026-09-15T10:00:00+00:00',
    note: '最近一次评测里只有 2 条这个领域的题，命中率说不出口',
  },
  concepts: { enough: false, mastered: 0, seen: 1, names: [], at: '' },
  skills: [],
  grown: false,
}

const REPORT: FormReport = { domains: [GROWN, THIN], min_cases: 3, min_concepts: 1 }

const ITEMS: EvalItem[] = [
  { id: 1, question: 'WAL 模式什么时候有用？', expected_source: 'notes/sqlite.md', note: '', domain: '教学' },
  { id: 2, question: '合同解除的条件？', expected_source: 'notes/law.md', note: '', domain: '' },
]

beforeEach(() => {
  vi.mocked(api.form).mockResolvedValue(REPORT)
  vi.mocked(api.listEvalItems).mockResolvedValue(ITEMS)
})

afterEach(cleanup)

function renderPane() {
  return render(
    <MemoryRouter>
      <FormPane />
    </MemoryRouter>
  )
}

describe('FormPane · 三个数', () => {
  it('一个领域摆出三样：检索（带区间）、搞懂的概念、技能卡', async () => {
    const { container } = renderPane()
    const card = await waitFor(() => {
      const el = container.querySelector('[data-form-domain="教学"]')
      if (!el) throw new Error('还没有这个领域')
      return el as HTMLElement
    })
    expect(card.textContent).toContain('3/3 命中')
    expect(card.textContent).toContain('44–100%') // 区间照直写，不美化
    expect(card.textContent).toContain('忠实度 4.5/5')
    expect(card.textContent).toContain('2 个')
    expect(card.textContent).toContain('3/8 通过')
    expect(card.getAttribute('data-form-grown')).toBe('1')
  })

  it('长成的那个必须写明「它没有学会它」——检索得住不是学会了', async () => {
    const { container } = renderPane()
    await screen.findByText('教学')
    const card = container.querySelector('[data-form-domain="教学"]') as HTMLElement
    expect(card.textContent).toContain('它没有学会教学')
    expect(card.textContent).toContain('没有一样测过它对你这类问题的判断')
  })

  it('样本不够的那一样说「样本不足」，不给一个会被误读的比例', async () => {
    const { container } = renderPane()
    await screen.findByText('法律')
    const card = container.querySelector('[data-form-domain="法律"]') as HTMLElement
    expect(card.getAttribute('data-form-grown')).toBe('0')
    expect(card.textContent).toContain('样本不足')
    expect(card.textContent).toContain('命中率说不出口') // 为什么不给数，说清楚
    // 50% 这个数**不出现**——两条样本算出来的命中率是噪音
    expect(card.textContent).not.toContain('50%')
  })

  it('三样里差的哪一样一眼看得出来（不是一屏问号）', async () => {
    const { container } = renderPane()
    await screen.findByText('法律')
    const card = container.querySelector('[data-form-domain="法律"]') as HTMLElement
    expect(card.textContent).toContain('碰过 1 个，还没说通') // 碰过但没学会，说准这一句
    expect(card.textContent).toContain('这个领域还没有跑过对照的技能卡')
    expect(card.textContent).toContain('现在标了 4 条，多出来的还没跑过') // 题比那次评测多
  })

  it('没有领域时说清楚路径：领域是你在证据上写的一个短词', async () => {
    vi.mocked(api.form).mockResolvedValue({ domains: [], min_cases: 3, min_concepts: 1 })
    renderPane()
    expect(await screen.findByText('还没有任何一个领域。')).toBeTruthy()
    expect(screen.getByText(/领域是你在证据上自己写的一个短词/)).toBeTruthy()
  })
})

describe('FormPane · 给样例题标领域', () => {
  it('列出样例题，没归类的在头上说清有几条', async () => {
    const { container } = renderPane()
    await screen.findByText('样例题的领域')
    expect(screen.getByText('1 条还没归类')).toBeTruthy()
    const row = container.querySelector('[data-form-item="2"]') as HTMLElement
    expect(row.textContent).toContain('合同解除的条件？')
    const input = container.querySelector('[data-form-domain-input="2"]') as HTMLInputElement
    expect(input.value).toBe('')
  })

  it('改一个领域，回车就存下去并重新算', async () => {
    vi.mocked(api.updateEvalItem).mockResolvedValue({ ...ITEMS[1], domain: '法律' })
    const { container } = renderPane()
    const input = (await waitFor(() => {
      const el = container.querySelector('[data-form-domain-input="2"]')
      if (!el) throw new Error('还没有那条')
      return el as HTMLInputElement
    }))
    fireEvent.change(input, { target: { value: '法律' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(api.updateEvalItem).toHaveBeenCalledWith(2, { domain: '法律' }))
    await waitFor(() => expect(api.form).toHaveBeenCalledTimes(2)) // 存完重算一遍
  })

  it('跑一次评测要把成本说在按钮上（每条题最多两次调用）', async () => {
    vi.mocked(api.runEval).mockResolvedValue({ id: 9, hit1: 1, total: 2 } as never)
    renderPane()
    const btn = (await screen.findByText(/跑一次评测/)) as HTMLButtonElement
    expect(btn.textContent).toContain('2 条')
    expect(btn.textContent).toContain('最多 4 次调用')
    fireEvent.click(btn)
    await waitFor(() => expect(api.runEval).toHaveBeenCalledWith(null, true))
    expect(await screen.findByText(/#9/)).toBeTruthy()
  })
})
