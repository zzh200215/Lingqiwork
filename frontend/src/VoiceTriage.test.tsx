// 那一问（R2 · PLAN5 §3）：这份语音备忘是材料，还是工作留痕？
//
// 三条纪律各有一条测试盯着：**拉取式不摆计数**（§4-1）、**读不到 ≠ 都归类完了**（§4-8）、
// **回答了就从单子上下去**（单子空了整块不渲染）。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import VoiceTriage from './VoiceTriage'
import type { VoicePending } from './api'

vi.mock('./api', () => ({
  api: {
    tutorDigest: vi.fn(),
    suggestThreads: vi.fn(),
    attachThreadItem: vi.fn(),
    createThread: vi.fn(),
  },
}))
import { api } from './api'

function pending(patch: Partial<VoicePending> = {}): VoicePending {
  return {
    readable: true,
    error: '',
    open: [
      {
        path: 'voice/2026-09-18-1430.md',
        name: '2026-09-18-1430.md',
        title: '语音备忘 2026-09-18 14:30',
        chars: 120,
        mtime: 1789700000,
      },
    ],
    counts: { total: 1, material: 0, thread: 0, open: 1 },
    rules: {
      pull: '拉取式：只在你打开它的时候回答，不催、不计数、不进零柒的提醒来源',
      material: '「当材料」= 交给既有的拆点',
      thread: '「工作留痕」= 挂到某件「事」上',
      state: '判据是两条既有路上的痕',
    },
    ...patch,
  }
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('VoiceTriage（那一问）', () => {
  it('有一份没归类时摆出来，两个按钮都在', () => {
    const { container } = render(<VoiceTriage v={pending()} onChanged={() => {}} />)
    expect(container.querySelector('[data-voice-triage]')).toBeTruthy()
    expect(container.querySelector('[data-voice-note="voice/2026-09-18-1430.md"]')).toBeTruthy()
    expect(screen.getByText('语音备忘 2026-09-18 14:30')).toBeTruthy()
    expect(container.querySelector('[data-voice-material]')?.textContent).toBe('当材料')
    expect(screen.getByText('工作留痕')).toBeTruthy()
  })

  it('**不摆计数**：没有「还有 N 份」这种待办口吻（§4-1 镜子不是掌柜）', () => {
    const { container } = render(<VoiceTriage v={pending()} onChanged={() => {}} />)
    const text = container.textContent ?? ''
    expect(text).not.toMatch(/还有\s*\d|还差|还欠|待办|加油|目标|逾期/)
    // 载荷里那个 counts 是事实，但**界面上不显示它**
    expect(text).not.toContain('共 1')
  })

  it('都归类完了就整块不渲染——一点痕迹都不留', () => {
    const done = pending({ open: [], counts: { total: 3, material: 2, thread: 1, open: 0 } })
    const { container } = render(<VoiceTriage v={done} onChanged={() => {}} />)
    expect(container.querySelector('[data-voice-triage]')).toBeNull()
    expect(container.textContent).toBe('')
  })

  it('还没读到也整块不渲染（别闪一个空壳）', () => {
    const { container } = render(<VoiceTriage v={null} onChanged={() => {}} />)
    expect(container.querySelector('[data-voice-triage]')).toBeNull()
    expect(container.textContent).toBe('')
  })

  it('读不到就说读不到——**不许说成「都归类完了」**（§4-8）', () => {
    const broken = pending({ readable: false, error: 'OperationalError: db down', open: [] })
    const { container } = render(<VoiceTriage v={broken} onChanged={() => {}} />)
    const line = container.querySelector('[data-voice-triage-error]')?.textContent ?? ''
    expect(line).toContain('db down')
    expect(line).toContain('读不到不等于')
    expect(container.querySelector('[data-voice-triage]')).toBeNull()
  })

  it('「当材料」走既有的拆点，**不自动建卡**，拆完叫一声让页面重取', async () => {
    vi.mocked(api.tutorDigest).mockResolvedValue({
      source: 'voice/2026-09-18-1430.md',
      source_label: 'voice/2026-09-18-1430.md',
      points: [
        { id: 1, title: '报价为什么要提前发', why: '' },
        { id: 2, title: '评审会前要准备什么', why: '' },
      ],
      error: '',
    })
    const onChanged = vi.fn()
    const { container } = render(<VoiceTriage v={pending()} onChanged={onChanged} />)

    fireEvent.click(container.querySelector('[data-voice-material]') as HTMLElement)

    await waitFor(() =>
      expect(api.tutorDigest).toHaveBeenCalledWith({ source_path: 'voice/2026-09-18-1430.md' }),
    )
    // 出卡是**学页里手动那一步**：这里一次都不该调建卡的接口
    expect(api.createThread).not.toHaveBeenCalled()
    expect(await screen.findByText(/拆出 2 个点/)).toBeTruthy()
    expect(onChanged).toHaveBeenCalled()
  })

  it('拆不出来时照实说那句错，不假装成功', async () => {
    vi.mocked(api.tutorDigest).mockResolvedValue({
      source: '',
      source_label: '',
      points: [],
      error: '这篇内容太短，出不了卡',
    })
    const { container } = render(<VoiceTriage v={pending()} onChanged={() => {}} />)

    fireEvent.click(container.querySelector('[data-voice-material]') as HTMLElement)

    expect(await screen.findByText('这篇内容太短，出不了卡')).toBeTruthy()
    expect(container.querySelector('[data-voice-triage-msg]')).toBeNull()
  })

  it('「工作留痕」挂上之后也叫一声（挂完还留在单子上就成了假的）', async () => {
    vi.mocked(api.suggestThreads).mockResolvedValue({
      label: '报价',
      threads: [
        {
          id: 7,
          name: 'Q4 报价',
          note: '',
          archived: false,
          created_at: null,
          updated_at: null,
          counts: {},
          total: 0,
        },
      ],
    })
    vi.mocked(api.attachThreadItem).mockResolvedValue({ ok: true, attached: true })
    const onChanged = vi.fn()
    render(<VoiceTriage v={pending()} onChanged={onChanged} />)

    fireEvent.click(screen.getByText('工作留痕'))
    fireEvent.click(await screen.findByText('Q4 报价'))

    await waitFor(() =>
      expect(api.attachThreadItem).toHaveBeenCalledWith(7, 'note', 'voice/2026-09-18-1430.md'),
    )
    expect(onChanged).toHaveBeenCalled()
  })
})
