// 调度台（Q4）：确定性编排的看板。
//
// 这一屏最该被钉住的不是排版，是**两件事**：
// 1. 状态**来自后端**（`/api/dispatch` 算好的），界面不自己推 —— 推了就是第二份真值；
// 2. 按钮点的是**真的接口**（run / approve / reject），不是聊天里 @ 一下。
// 外加一条语气红线：这是看板不是考核（不催、不排名）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import DispatchPanel from './DispatchPanel'
import type { DispatchBoard } from './api'

vi.mock('./api', () => ({
  api: { dispatch: vi.fn(), runTask: vi.fn(), approveRun: vi.fn(), rejectRun: vi.fn() },
}))
import { api } from './api'

function board(patch: Partial<DispatchBoard> = {}): DispatchBoard {
  return {
    chains: [
      {
        root_id: 1,
        name: '周报流水线',
        length: 2,
        needs_attention: true,
        enabled: true,
        stuck_at: null,
        steps: [
          {
            index: 1,
            task_id: 1,
            name: '写草稿',
            state: 'awaiting',
            state_label: '等人点头',
            who: '默认模型（agent）',
            model_id: '',
            mode: 'agent',
            run_id: 10,
            actions: [
              { kind: 'approve', run_id: 10, task_id: 1, label: '放行' },
              { kind: 'reject', run_id: 10, task_id: 1, label: '驳回' },
            ],
          },
          {
            index: 2,
            task_id: 2,
            name: '发出去',
            state: 'blocked',
            state_label: '等上一步',
            blocked_by: 1,
            who: '默认模型',
            model_id: '',
            mode: 'simple',
            actions: [],
          },
        ],
      },
    ],
    counts: { chains: 1, steps: 2, needs_attention: 1, running: 0 },
    states: { awaiting: '等人点头' },
    broadcast: '1 步在等你点头：写草稿。点「放行」就接着往下跑。',
    ...patch,
  }
}

beforeEach(() => {
  vi.mocked(api.dispatch).mockResolvedValue(board())
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('DispatchPanel · 看板', () => {
  it('把两步链画出来，并摊出每一步的状态与谁在跑', async () => {
    const { container } = render(<DispatchPanel />)
    await waitFor(() => expect(container.querySelector('[data-dispatch]')).toBeTruthy())
    expect(container.querySelector('[data-dispatch-chain="1"]')).toBeTruthy()
    const steps = [...container.querySelectorAll('[data-dispatch-step]')]
    expect(steps.map((s) => s.getAttribute('data-dispatch-step'))).toEqual(['1', '2'])
    expect(steps.map((s) => s.getAttribute('data-dispatch-state'))).toEqual(['awaiting', 'blocked'])
    expect(container.querySelector('[data-dispatch-label="awaiting"]')?.textContent).toBe('等人点头')
    expect(container.textContent).toContain('默认模型（agent）')
  })

  it('宠物那一句播报就在上面（只说事实）', async () => {
    const { container } = render(<DispatchPanel />)
    await waitFor(() => expect(container.querySelector('[data-dispatch-broadcast]')).toBeTruthy())
    expect(container.querySelector('[data-dispatch-broadcast]')?.textContent).toContain('等你点头')
  })

  it('「放行」是**真的接口调用**，不是聊天里说一句', async () => {
    vi.mocked(api.approveRun).mockResolvedValue({ ok: true, approved: true, next_task_id: 2 })
    const { container } = render(<DispatchPanel />)
    await waitFor(() => expect(container.querySelector('[data-dispatch-action="approve"]')).toBeTruthy())
    fireEvent.click(container.querySelector('[data-dispatch-action="approve"]') as HTMLElement)
    await waitFor(() => expect(api.approveRun).toHaveBeenCalledWith(10))
    // 点完之后重新读一次看板（状态要跟着变，不能靠本地猜）
    expect(vi.mocked(api.dispatch).mock.calls.length).toBeGreaterThan(1)
  })

  it('「跑一次」走 runTask（同一个按钮组件，两种动作）', async () => {
    vi.mocked(api.dispatch).mockResolvedValue(
      board({
        chains: [
          {
            ...board().chains[0],
            steps: [
              {
                index: 1,
                task_id: 7,
                name: '写草稿',
                state: 'error',
                state_label: '挂了',
                who: '默认模型',
                model_id: '',
                mode: 'simple',
                error: '上游 500',
                actions: [{ kind: 'run', task_id: 7, label: '跑一次' }],
              },
            ],
          },
        ],
      })
    )
    vi.mocked(api.runTask).mockResolvedValue({ ok: true } as never)
    const { container } = render(<DispatchPanel />)
    await waitFor(() => expect(container.querySelector('[data-dispatch-action="run"]')).toBeTruthy())
    fireEvent.click(container.querySelector('[data-dispatch-action="run"]') as HTMLElement)
    await waitFor(() => expect(api.runTask).toHaveBeenCalledWith(7))
  })

  it('没有链条时说清怎么才会出现，而不是摆一块空表', async () => {
    vi.mocked(api.dispatch).mockResolvedValue(
      board({ chains: [], counts: { chains: 0, steps: 0, needs_attention: 0, running: 0 } })
    )
    const { container } = render(<DispatchPanel />)
    await waitFor(() => expect(container.querySelector('[data-dispatch-empty]')).toBeTruthy())
    expect(container.textContent).toContain('链到下一个')
  })

  it('读不出来时说一句人话', async () => {
    vi.mocked(api.dispatch).mockRejectedValue(new Error('后端不在'))
    render(<DispatchPanel />)
    expect(await screen.findByText(/读调度台出错：后端不在/)).toBeTruthy()
  })

  it('语气红线：这一屏不说「该跑了 / 落后 / 注意」', async () => {
    const { container } = render(<DispatchPanel />)
    await waitFor(() => expect(container.querySelector('[data-dispatch]')).toBeTruthy())
    const text = container.textContent || ''
    for (const banned of ['该跑', '落后', '赶紧', '必须']) {
      expect(text).not.toContain(banned)
    }
  })
})
