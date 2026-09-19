// 今日页的第二作答方式（M1 · PLAN §3 G1 场景 A）。
//
// 这一页此前没有测试文件，所以这里只搭**够用**的一套：队列一张卡 + 几个 mock。
// 两条最该钉住的不是渲染，是**降级**：
// 1. 判过 → 判词与缺口留在屏幕上（判完就翻页，不给反馈等于没判）；
// 2. 判分没跑成 → **一个字节都没写**，退回自评，而且重讲原文跟着自评那次请求走
//    （那一天你确实重讲了——北星指标读的就是那一列）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

import ReviewPage from './ReviewPage'
import type { CardItem } from './api'

vi.mock('./api', () => ({
  api: {
    cardQueue: vi.fn(),
    cardStats: vi.fn(),
    // PLAN2 T1：这张卡的对照事实——默认「没有落差」，那条线就不出现
    cardCrosscheck: vi.fn().mockResolvedValue({
      card_id: 1,
      concept: '',
      mastered: false,
      said_n: 0,
      again_7d: 0,
      contradiction: false,
    }),
    cardPrereq: vi.fn(),
    todaySummary: vi.fn(),
    reviewCard: vi.fn(),
    retellCard: vi.fn(),
    undoCardReview: vi.fn(),
    updateCard: vi.fn(),
    selfCheck: vi.fn(),
    // 「最近」那一栏（2026-09-18 内容太少那一轮加的）：三块各自独立取。
    // **默认给空数组**（不是裸 `vi.fn()`）——裸的那个返回 undefined，`.then` 当场炸。
    petFeed: vi.fn().mockResolvedValue({ events: [] }),
    listConversations: vi.fn().mockResolvedValue([]),
    dashboard: vi.fn().mockResolvedValue({
      open_days_7d: 0,
      narrative: { this_week_messages: 0, today_vault_files: 0 },
    }),
  },
}))
// 语音那一层不测：它要麦克风权限与 MediaRecorder（jsdom 都没有）
vi.mock('./voice', () => ({
  useVoiceInput: () => ({ toggle: vi.fn(), recording: false, transcribing: false }),
}))
vi.mock('./HabitStrip', () => ({ default: () => null }))
import { api } from './api'

function card(id: number, front: string): CardItem {
  return {
    id,
    kind: 'concept',
    front,
    back: '交给事件循环',
    hint: '',
    topic: 'asyncio',
    source: 'notes/loop.md',
    source_label: 'notes/loop.md',
    source_excerpt: '材料原文一句',
    origin: 'ai',
    suspended: false,
    due: '2026-09-16T10:00:00+00:00',
    interval_days: 0,
    ease: 2.5,
    reps: 0,
    lapses: 0,
    last_grade: null,
    last_review: null,
    created_at: '2026-09-15T10:00:00+00:00',
  }
}

const FIRST = card(1, 'await 到底把控制权交给了谁')
const SECOND = card(2, '第二张卡的题面')

function reviewResult(id: number, requeue = false) {
  return { ...card(id, ''), ok: true, due_seconds: 86400, requeue }
}

function renderPage() {
  return render(
    <MemoryRouter>
      <ReviewPage />
    </MemoryRouter>
  )
}

/** 进到问题相：概览 → 开始复习（两张卡）。 */
async function start() {
  const view = renderPage()
  fireEvent.click(await screen.findByText(/开始复习/))
  await screen.findByText(FIRST.front)
  return view
}

function openRetell() {
  fireEvent.click(screen.getByText('🎤 讲给它听'))
}

function typeRetell(text: string) {
  fireEvent.change(screen.getByPlaceholderText(/用你自己的话讲一遍/), { target: { value: text } })
}

beforeEach(() => {
  vi.mocked(api.cardQueue).mockResolvedValue({
    due: [FIRST, SECOND],
    fresh: [],
    due_total: 2,
    caps: { review_per_day: 20, new_per_day: 5 },
  } as never)
  vi.mocked(api.cardStats).mockResolvedValue({
    total: 2,
    new: 0,
    learning: 2,
    due_now: 2,
    streak: 1,
    today: { reviewed: 0, new_done: 0 },
    next_due: null,
  } as never)
  vi.mocked(api.todaySummary).mockResolvedValue({ rows: [] } as never)
  vi.mocked(api.selfCheck).mockResolvedValue(null as never)
  vi.mocked(api.reviewCard).mockImplementation(async (id: number) => reviewResult(id))
  // 默认：这张卡与它的概念没有落差，那条线不出现（要对质的那条用例自己改）
  vi.mocked(api.cardCrosscheck).mockResolvedValue({
    card_id: FIRST.id,
    concept: '',
    mastered: false,
    said_n: 0,
    again_7d: 0,
    contradiction: false,
  } as never)
})

afterEach(cleanup)

describe('ReviewPage · 讲给它听', () => {
  it('判过 → 判词与缺口留在屏幕上，并且翻到下一张', async () => {
    vi.mocked(api.retellCard).mockResolvedValue({
      ok: true,
      grade: 2,
      label: '困难',
      missed_points: ['await 的归属没说清'],
      hint: '',
      card: reviewResult(FIRST.id),
    })
    await start()
    openRetell()
    typeRetell('我先 await，然后它挂起……')
    fireEvent.click(screen.getByText('判一下'))

    expect(await screen.findByText(/它判：困难/)).toBeTruthy()
    // 缺口是**缺口**，不是一句「再努力」：原样摆出来
    expect(screen.getByText(/await 的归属没说清/)).toBeTruthy()
    // 判完就走（同一条账的后半段：出队、下一张）
    expect(await screen.findByText(SECOND.front)).toBeTruthy()
  })

  it('判分没跑成 → 一个字都没写，退回自评，而且重讲原文跟着自评走', async () => {
    vi.mocked(api.retellCard).mockResolvedValue({
      ok: false,
      grade: 0,
      label: '',
      reason: '判分没跑成（输出读不出来）',
      card: null,
    })
    await start()
    openRetell()
    typeRetell('我讲了一段')
    fireEvent.click(screen.getByText('判一下'))

    // 如实说，而且**不编分**：卡还停在这一张，等你自己定
    expect(await screen.findByText(/判分没跑成/)).toBeTruthy()
    expect(screen.getByText(FIRST.front)).toBeTruthy()

    // 自己定一档——原文一起带上（这就是「判分挂了也不丢那一天」的那条路）
    fireEvent.click(screen.getByText('显示答案'))
    fireEvent.click(screen.getByText('良好'))
    await waitFor(() => expect(api.reviewCard).toHaveBeenCalled())
    expect(vi.mocked(api.reviewCard).mock.calls[0].slice(0, 4)).toEqual([1, 3, expect.any(Number), '我讲了一段'])
  })

  it('还没讲就不让按（省一次调用）', async () => {
    await start()
    openRetell()
    const judge = screen.getByText('判一下') as HTMLButtonElement
    expect(judge.disabled).toBe(true)
    typeRetell('   ')
    expect((screen.getByText('判一下') as HTMLButtonElement).disabled).toBe(true)
    typeRetell('讲了')
    expect((screen.getByText('判一下') as HTMLButtonElement).disabled).toBe(false)
  })

  it('自评那条路照旧：不动重讲，1–4 还是 1–4', async () => {
    await start()
    // 第二作答方式是**多出来的一条**，不是替换
    expect(screen.getByText('显示答案')).toBeTruthy()
    expect(screen.queryByPlaceholderText(/用你自己的话讲一遍/)).toBeNull()
    fireEvent.click(screen.getByText('显示答案'))
    expect(screen.getByText('重来')).toBeTruthy()
    fireEvent.click(screen.getByText('简单'))
    await waitFor(() => expect(api.reviewCard).toHaveBeenCalled())
    // 没重讲 → 原文是空串（后端据此知道这一次是自评）
    expect(vi.mocked(api.reviewCard).mock.calls[0][3]).toBe('')
  })

  it('双轨矛盾时把落差说破——只说事实，不替你改判定', async () => {
    vi.mocked(api.cardCrosscheck).mockResolvedValue({
      card_id: FIRST.id,
      concept: 'asyncio 事件循环',
      mastered: true,
      said_n: 2,
      again_7d: 3,
      contradiction: true,
    } as never)
    const view = await start()
    const line = await screen.findByText(/你说通过 2 次/)
    expect(line.textContent).toContain('「asyncio 事件循环」')
    expect(line.textContent).toContain('重来 3 回')
    expect(line.getAttribute('data-crosscheck')).not.toBeNull()
    // 镜子不判决：「你其实没懂」这类话一个字都不出现；也没多出第二个按钮
    expect(view.container.textContent).not.toMatch(/你其实|没真懂|高估|扣分/)
  })

  it('没有落差时那条线不出现（不摆一句「暂无矛盾」）', async () => {
    const view = await start()
    expect(view.container.querySelector('[data-crosscheck]')).toBeNull()
  })
})
