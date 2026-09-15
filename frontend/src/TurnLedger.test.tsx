// 最近回合（W5）：聊天那条路上每一轮发生了什么。
//
// 这一栏最该被钉住的不是渲染，是**语气**与**不重算**：
// 1. 它是诊断不是考核 —— 没有「好回合」筛选项、没有目标、没有排行榜；
// 2. 毛病标签直接来自后端的 `flags`（同一个判断不许有第二份实现）；
// 3. 筛出来的确实是那一类（筛选项传给后端，不是前端过滤）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import TurnLedger, { TurnRow } from './TurnLedger'
import type { TurnTrace } from './api'

vi.mock('./api', () => ({ api: { turns: vi.fn() } }))
import { api } from './api'

const FILTERS = [
  { key: 'lie', label: '声称存了没存', hint: '说了已存入但没落盘' },
  { key: 'no_save', label: '长正文没落盘', hint: '正文很长却没有回执' },
  { key: 'slow', label: '慢', hint: '超过 10 秒' },
]

function trace(patch: Partial<TurnTrace> = {}): TurnTrace {
  return {
    id: 1,
    at: '2026-09-15T10:00:00+00:00',
    conversation_id: 3,
    message_id: 9,
    model_id: 'sensenova/flash-lite',
    prompt_sha: 'abc123def456',
    route_level: '',
    route_kind: '',
    rounds: 3,
    tool_calls: [
      { name: 'kb_search', args_chars: 40, result_chars: 900, ms: 120, ok: true },
      { name: 'save_artifact', args_chars: 800, result_chars: 60, ms: 300, ok: true },
    ],
    tokens_in: 1200,
    tokens_out: 800,
    artifacts: [{ kind: 'deliver', path: 'deliver/a.md' }],
    answer_chars: 120,
    claim_checked: true,
    claim_truthful: true,
    retried: 0,
    seconds: 4.2,
    error: '',
    flags: [],
    ...patch,
  }
}

beforeEach(() => {
  vi.mocked(api.turns).mockResolvedValue({ traces: [trace()], filters: FILTERS, only: '' })
})

afterEach(cleanup)

describe('TurnLedger · 一行事实', () => {
  it('摊开这一轮的真实开销：轮数、工具、耗时、token、落盘', () => {
    const { container } = render(
      <ul>
        <TurnRow t={trace()} now={Date.now()} labels={{}} />
      </ul>
    )
    const row = container.querySelector('[data-turn="1"]') as HTMLElement
    expect(row.textContent).toContain('flash-lite') // 模型只留末段，长 id 不撑破一屏
    expect(row.textContent).toContain('3 轮')
    expect(row.textContent).toContain('2 次工具')
    expect(row.textContent).toContain('1200/800')
    expect(row.textContent).toContain('1 份产出')
  })

  it('没有产出时报正文长度 —— 「长正文却没落盘」就是靠这个数看出来的', () => {
    const { container } = render(
      <ul>
        <TurnRow t={trace({ artifacts: [], answer_chars: 900 })} now={Date.now()} labels={{}} />
      </ul>
    )
    expect((container.querySelector('[data-turn]') as HTMLElement).textContent).toContain('正文 900 字')
  })

  it('毛病标签用的是后端给的那一份文案（不另立说法）', () => {
    const { container } = render(
      <ul>
        <TurnRow
          t={trace({ flags: ['lie', 'slow'] })}
          now={Date.now()}
          labels={{ lie: '声称存了没存', slow: '慢' }}
        />
      </ul>
    )
    expect(container.querySelector('[data-turn-flag="lie"]')?.textContent).toBe('声称存了没存')
    expect(container.querySelector('[data-turn-flag="slow"]')?.textContent).toBe('慢')
  })

  // W3：这一轮被判成交付型还是闲聊，判在哪一级。**判定在后端**，界面只显示。
  it('把路由结论摊出来：交付型带体裁与判据级别', () => {
    const { container } = render(
      <ul>
        <TurnRow
          t={trace({
            route_level: 'rule',
            route_kind: 'deliver',
            quality: {
              route: { delivery: true, kind: 'deliver', level: 'rule', confidence: 0.9, reason: '祈使动词 + 体裁名词（deliver）' },
            },
          })}
          now={Date.now()}
          labels={{}}
        />
      </ul>
    )
    const tag = container.querySelector('[data-turn-route]')
    expect(tag?.textContent).toBe('交付型·deliver（rule）')
    expect(tag?.getAttribute('title')).toContain('祈使动词')
  })

  it('闲聊也如实写出来（不是不显示）', () => {
    const { container } = render(
      <ul>
        <TurnRow
          t={trace({ route_level: 'vector', quality: { route: { delivery: false, level: 'vector' } } })}
          now={Date.now()}
          labels={{}}
        />
      </ul>
    )
    expect(container.querySelector('[data-turn-route]')?.textContent).toBe('闲聊（vector）')
  })

  it('老行没有这一项就不显示 —— 不编一个「闲聊」出来', () => {
    const { container } = render(
      <ul>
        <TurnRow t={trace()} now={Date.now()} labels={{}} />
      </ul>
    )
    expect(container.querySelector('[data-turn-route]')).toBeNull()
  })
})

describe('TurnLedger · 这一栏', () => {
  it('列出回合，并说明它是诊断不是考核', async () => {
    const { container } = render(<TurnLedger />)
    await waitFor(() => expect(container.querySelector('[data-turn]')).toBeTruthy())
    expect(screen.getByText(/这是诊断，不是考核/)).toBeTruthy()
    expect(screen.getByText('最近回合')).toBeTruthy()
  })

  it('筛选项来自后端，点了就按那一类重新问一次', async () => {
    const { container } = render(<TurnLedger />)
    await waitFor(() => expect(container.querySelector('[data-turn]')).toBeTruthy())

    fireEvent.click(container.querySelector('[data-turn-filter="lie"]') as HTMLElement)
    await waitFor(() => expect(api.turns).toHaveBeenLastCalledWith(30, 'lie'))

    fireEvent.click(container.querySelector('[data-turn-filter=""]') as HTMLElement)
    await waitFor(() => expect(api.turns).toHaveBeenLastCalledWith(30, ''))
  })

  it('这一类一条都没有时说实话，不摆空表', async () => {
    vi.mocked(api.turns).mockResolvedValue({ traces: [], filters: FILTERS, only: 'lie' })
    render(<TurnLedger />)
    fireEvent.click(await screen.findByText('声称存了没存'))
    expect(await screen.findByText(/这一类目前一个都没有/)).toBeTruthy()
  })

  it('一条记录都没有时说清楚怎么才会有', async () => {
    vi.mocked(api.turns).mockResolvedValue({ traces: [], filters: FILTERS, only: '' })
    render(<TurnLedger />)
    expect(await screen.findByText(/聊一句就有了/)).toBeTruthy()
  })

  it('读不出来时说一句人话，不装没事', async () => {
    vi.mocked(api.turns).mockRejectedValue(new Error('后端不在'))
    render(<TurnLedger />)
    expect(await screen.findByText(/读回合账本出错：后端不在/)).toBeTruthy()
  })

  it('没有「好回合」这种筛选项 —— 这里只有事实和毛病', async () => {
    const { container } = render(<TurnLedger />)
    await waitFor(() => expect(container.querySelector('[data-turn]')).toBeTruthy())
    const keys = [...container.querySelectorAll('[data-turn-filter]')].map((el) =>
      el.getAttribute('data-turn-filter')
    )
    expect(keys).toEqual(['', 'lie', 'no_save', 'slow'])
  })
})
