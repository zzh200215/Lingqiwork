// 「事」页：五步摆开、候选派生、未归类一键挂。真数据要挂过东西才有，所以这里全用固定数据。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

import ThreadsPage from './ThreadsPage'
import type { ThreadDetail, ThreadRow, ThreadStep } from './api'

vi.mock('./api', () => ({
  api: {
    listThreads: vi.fn(),
    threadDetail: vi.fn(),
    createThread: vi.fn(),
    updateThread: vi.fn(),
    deleteThread: vi.fn(),
    attachThreadItem: vi.fn(),
    detachThreadItem: vi.fn(),
    unclassified: vi.fn(),
    ignoreInboxItem: vi.fn(),
    unignoreInboxItem: vi.fn(),
    suggestThreads: vi.fn(),
    deliverGenres: vi.fn(),
    deliverIntoThread: vi.fn(),
  },
}))
import { api } from './api'

/** 收件箱里的一条待归类。 */
const CAND = { kind: 'card' as const, ref: '9', title: 'RAG 评测怎么做', label: 'RAG 评测', step: 'learn' }

const STEPS: ThreadStep[] = [
  { key: 'in', label: '进来', kinds: ['material'] },
  { key: 'learn', label: '搞懂', kinds: ['session', 'card'] },
  { key: 'keep', label: '留下', kinds: ['note'] },
  { key: 'deliver', label: '交付', kinds: ['output', 'task'] },
  { key: 'judge', label: '判断', kinds: ['decision'] },
]

const THREAD: ThreadRow = {
  id: 1,
  name: 'RAG 评测',
  note: '',
  archived: false,
  // 状态机（方案 §8.4）：`open`/`done` 是**你设的**，`stalled`/`idle_days` 是后端算的
  status: 'open',
  stalled: false,
  idle_days: 0,
  deadline: null,
  created_at: null,
  updated_at: null,
  counts: { card: 2 },
  total: 2,
}

const DETAIL: ThreadDetail = {
  ...THREAD,
  items: [
    {
      kind: 'card',
      ref: '7',
      title: '怎么评',
      exists: true,
      step: 'learn',
      href: '/review',
      created_at: '2026-09-20T10:00:00+08:00',
    },
    {
      kind: 'note',
      ref: 'notes/gone.md',
      title: '（已不存在）',
      exists: false,
      step: 'keep',
      href: '',
      created_at: '2026-09-18T10:00:00+08:00',
    },
  ],
  by_step: {
    learn: [
      {
        kind: 'card',
        ref: '7',
        title: '怎么评',
        exists: true,
        step: 'learn',
        href: '/review',
        created_at: '2026-09-20T10:00:00+08:00',
      },
    ],
    keep: [
      {
        kind: 'note',
        ref: 'notes/gone.md',
        title: '（已不存在）',
        exists: false,
        step: 'keep',
        href: '',
        created_at: '2026-09-18T10:00:00+08:00',
      },
    ],
  },
  steps: STEPS,
  suggestions: [{ kind: 'card', ref: '9', title: 'RAG 评测怎么做', label: 'RAG 评测', step: 'learn' }],
  cost: {
    tokens_in: 900,
    tokens_out: 300,
    total: 1200,
    calls: 3,
    by_model: { 'p/m': { in: 900, out: 300, calls: 3 } },
  },
}

function renderPage(initial = '/') {
  return render(
    <MemoryRouter initialEntries={[initial]}>
      <ThreadsPage />
    </MemoryRouter>
  )
}

beforeEach(() => {
  vi.mocked(api.listThreads).mockResolvedValue({ threads: [], steps: STEPS })
  vi.mocked(api.unclassified).mockResolvedValue({ items: [], total: 0 })
  vi.mocked(api.threadDetail).mockResolvedValue(DETAIL)
  vi.mocked(api.deliverGenres).mockResolvedValue({
    genres: [{ id: 'briefing', label: '汇报要点', long: false, custom: false }],
    audiences: [{ id: 'leader', label: '领导' }],
    default_genre: 'briefing',
    default_audience: 'leader',
  })
})

afterEach(cleanup)

describe('ThreadsPage', () => {
  it('左栏每行给状态、多久没动、挂着几份（方案 §8.4）', async () => {
    vi.mocked(api.listThreads).mockResolvedValue({
      threads: [
        THREAD,
        { ...THREAD, id: 2, name: '放很久的事', stalled: true, idle_days: 21 },
        { ...THREAD, id: 3, name: '做完的事', status: 'done' },
      ],
      steps: STEPS,
    })
    renderPage()

    expect(await screen.findByText('RAG 评测')).toBeTruthy()
    // 三种状态各一个说法，颜色点由 STATUS 一处给
    expect(screen.getByText('进行中')).toBeTruthy()
    expect(screen.getByText('停滞')).toBeTruthy()
    expect(screen.getByText('完成')).toBeTruthy()
    expect(screen.getByText(/21 天没动/)).toBeTruthy()
    // 三行都挂着 2 份（同一份夹具），所以只查第一行
    const rows = [...document.querySelectorAll('section ul > li')]
    expect(rows[0].textContent).toContain('挂着 2 份')
  })

  it('按状态过滤：点「停滞」只剩停滞的那些', async () => {
    vi.mocked(api.listThreads).mockResolvedValue({
      threads: [THREAD, { ...THREAD, id: 2, name: '放很久的事', stalled: true, idle_days: 21 }],
      steps: STEPS,
    })
    renderPage()
    await screen.findByText('放很久的事')

    fireEvent.click(screen.getByText(/^停滞 1$/))
    expect(screen.queryByText('RAG 评测')).toBeNull()
    expect(screen.getByText('放很久的事')).toBeTruthy()
  })

  it('没有任何一件事时给一句实话，并指路收件箱', async () => {
    renderPage()
    expect(await screen.findByText('还没有一件事')).toBeTruthy()
  })

  it('「＋ 新的一件事」推来的信号把新建面板摊开，建完就打开它', async () => {
    vi.mocked(api.createThread).mockResolvedValue(THREAD)
    render(
      <MemoryRouter initialEntries={['/']}>
        <ThreadsPage newSignal={1} />
      </MemoryRouter>
    )

    fireEvent.change(await screen.findByPlaceholderText(/新的一件事/), {
      target: { value: 'RAG 评测' },
    })
    fireEvent.click(screen.getByText('建'))
    await waitFor(() => expect(api.createThread).toHaveBeenCalledWith('RAG 评测'))
  })

  it('详情是**时间线**（方案 §8.4）：同一条线上按时间倒序，引用丢了的不给落点', async () => {
    vi.mocked(api.listThreads).mockResolvedValue({ threads: [THREAD], steps: STEPS })
    renderPage('/?thread=1')

    const line = await screen.findByText('怎么评')
    expect(line).toBeTruthy()
    // 引用还在的那条点得开，指向已经不存在的那条是一段灰字
    expect(screen.getByRole('button', { name: '怎么评' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '（已不存在）' })).toBeNull()
    expect(screen.getByText('（已不存在）')).toBeTruthy()

    // 时间倒序：09-20 那条排在 09-18 那条前面
    const tl = document.querySelector('[data-thread-timeline]') as HTMLElement
    const titles = [...tl.querySelectorAll('li')].map((li) => li.textContent ?? '')
    expect(titles[0]).toContain('怎么评')
    expect(titles[1]).toContain('（已不存在）')
  })

  it('「起一个工作链」把**事名**交给上层预填题目（方案 §8.4 就地起链）', async () => {
    // **只预填、不起链**：起链要花模型钱，最后那一下得由人按——所以这里验的是
    // 「名字带出去了」，不是「链起来了」。
    vi.mocked(api.listThreads).mockResolvedValue({ threads: [THREAD], steps: STEPS })
    const onStartWork = vi.fn()
    render(
      <MemoryRouter initialEntries={['/?thread=1']}>
        <ThreadsPage onStartWork={onStartWork} />
      </MemoryRouter>
    )

    fireEvent.click(await screen.findByText('起一个工作链'))
    expect(onStartWork).toHaveBeenCalledWith('RAG 评测')
  })

  it('未归类：「挂到…」给的是派生候选，点一下就挂上', async () => {
    vi.mocked(api.unclassified).mockResolvedValue({
      items: [{ kind: 'card', ref: '9', title: 'RAG 评测怎么做', label: 'RAG 评测', step: 'learn' }],
      total: 1,
    })
    vi.mocked(api.suggestThreads).mockResolvedValue({ label: 'RAG 评测', threads: [THREAD] })
    vi.mocked(api.attachThreadItem).mockResolvedValue({ ok: true, attached: true })
    renderPage()

    fireEvent.click(await screen.findByText('挂到…'))
    fireEvent.click(await screen.findByText('RAG 评测')) // 候选里那件事，不用打字
    await waitFor(() => expect(api.attachThreadItem).toHaveBeenCalledWith(1, 'card', '9'))
  })

  it('收件箱的「挂到…」是**公共那个组件**：挂上之后就地说一句回执（§五-2）', async () => {
    // 这一页原来自己养了一套 picker，做的事一模一样，却少了公共组件已经有的两样东西：
    // 失败时说一声、以及这条「已挂到 X」的回执。这条用例钉的就是**它确实是公共那个**——
    // 自建那套没有这句话。
    vi.mocked(api.unclassified).mockResolvedValue({ items: [CAND], total: 1 })
    vi.mocked(api.suggestThreads).mockResolvedValue({ label: 'RAG 评测', threads: [THREAD] })
    vi.mocked(api.attachThreadItem).mockResolvedValue({ ok: true, attached: true })
    renderPage()

    fireEvent.click(await screen.findByText('挂到…'))
    fireEvent.click(await screen.findByText('RAG 评测'))
    expect(await screen.findByText('已挂到 RAG 评测')).toBeTruthy()
  })

  it('收件箱的「忽略」：划掉这一条候选，**不是删掉东西**', async () => {
    vi.mocked(api.unclassified)
      .mockResolvedValueOnce({ items: [CAND], total: 1 })
      .mockResolvedValue({ items: [], total: 0 })
    vi.mocked(api.ignoreInboxItem).mockResolvedValue({ ok: true, ignored: true })
    renderPage()

    fireEvent.click(await screen.findByText('忽略'))
    await waitFor(() => expect(api.ignoreInboxItem).toHaveBeenCalledWith('card', '9'))
    // 收件箱的目标 = **清空**（§8.4）：划掉最后一条之后整块不渲染，不占首屏
    await waitFor(() => expect(document.querySelector('[data-inbox]')).toBeNull())
    // 走的是「忽略」那条接口，**不是**删卡片、也不是解除挂接
    expect(api.updateThread).not.toHaveBeenCalled()
  })

  it('忽略失败要说出来——「没划掉」不能装成「划掉了」', async () => {
    vi.mocked(api.unclassified).mockResolvedValue({ items: [CAND], total: 1 })
    vi.mocked(api.ignoreInboxItem).mockRejectedValue(new Error('500: {"detail":"库挂了"}'))
    renderPage()

    fireEvent.click(await screen.findByText('忽略'))
    expect(await screen.findByText(/库挂了/)).toBeTruthy()
    // 没成功就不该把它从界面上抹掉（那会让人以为已经划掉了）
    expect(document.querySelector('[data-inbox]')).not.toBeNull()
  })

  it('未归类：没有匹配的事时，可以用它自己的名字新建并挂上', async () => {
    vi.mocked(api.unclassified).mockResolvedValue({
      items: [{ kind: 'card', ref: '9', title: 'RAG 评测怎么做', label: 'RAG 评测', step: 'learn' }],
      total: 1,
    })
    vi.mocked(api.suggestThreads).mockResolvedValue({ label: 'RAG 评测', threads: [] })
    vi.mocked(api.createThread).mockResolvedValue(THREAD)
    vi.mocked(api.attachThreadItem).mockResolvedValue({ ok: true, attached: true })
    renderPage()

    fireEvent.click(await screen.findByText('挂到…'))
    fireEvent.click(await screen.findByText(/新建「RAG 评测」/))
    await waitFor(() => expect(api.createThread).toHaveBeenCalledWith('RAG 评测'))
    await waitFor(() => expect(api.attachThreadItem).toHaveBeenCalledWith(1, 'card', '9'))
  })

  it('这件事头上的账看得见：花的钱、次数、用过的模型（§4-16）', async () => {
    vi.mocked(api.listThreads).mockResolvedValue({ threads: [THREAD], steps: STEPS })
    renderPage('/?thread=1')

    expect(await screen.findByText('1.2k tokens · 3 次调用 · p/m')).toBeTruthy()
  })

  it('就这件事写一份交付：调 deliverIntoThread（账记在这件事头上）', async () => {
    vi.mocked(api.listThreads).mockResolvedValue({ threads: [THREAD], steps: STEPS })
    vi.mocked(api.deliverIntoThread).mockResolvedValue({
      filename: 'deliver/2026-09-12-汇报要点.md',
      title: '汇报要点',
      chunks: 1,
    })
    renderPage('/?thread=1')

    fireEvent.click(await screen.findByText('写一份'))
    // 第 4 个参数是 AbortSignal（「停止」用）——每次都不同，所以判形状
    await waitFor(() =>
      expect(api.deliverIntoThread).toHaveBeenCalledWith(1, 'briefing', 'leader', expect.any(AbortSignal))
    )
  })
})

describe('ThreadsPage · 活性（2026-09-26）', () => {
  it('可见时每 15 秒自己跟一拍：工作流往时间线落成品，页面不该停在打开那一刻', async () => {
    const { act } = await import('@testing-library/react')
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    try {
      renderPage('/work?tab=thread')
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
      const afterMount = vi.mocked(api.listThreads).mock.calls.length
      expect(afterMount).toBeGreaterThan(0)

      await act(async () => {
        await vi.advanceTimersByTimeAsync(15000)
      })
      expect(vi.mocked(api.listThreads).mock.calls.length).toBeGreaterThan(afterMount)
      expect(vi.mocked(api.unclassified).mock.calls.length).toBeGreaterThan(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('ThreadsPage · 收件箱批处理（2026-09-26）', () => {
  it('忽略全部：两段式确认，第二下才逐条真执行', async () => {
    vi.mocked(api.unclassified).mockResolvedValue({
      items: [
        { kind: 'note', ref: 'notes/a.md', title: '甲' },
        { kind: 'card', ref: 'cards/b.md', title: '乙' },
      ],
      total: 2,
    })
    renderPage('/work?tab=thread')
    fireEvent.click(await screen.findByText('忽略全部'))
    // 第一下只立起确认——什么都没发生，这是批量不可逆操作的缓冲
    expect(screen.getByText('确认忽略 2 条？')).toBeTruthy()
    expect(api.ignoreInboxItem).not.toHaveBeenCalled()

    fireEvent.click(screen.getByText('确认忽略 2 条？'))
    await waitFor(() => expect(api.ignoreInboxItem).toHaveBeenCalledTimes(2))
    expect(api.ignoreInboxItem).toHaveBeenNthCalledWith(1, 'note', 'notes/a.md')
    expect(api.ignoreInboxItem).toHaveBeenNthCalledWith(2, 'card', 'cards/b.md')
  })
})
