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
    suggestThreads: vi.fn(),
  },
}))
import { api } from './api'

const STEPS: ThreadStep[] = [
  { key: 'in', label: '进来', kinds: ['material'] },
  { key: 'learn', label: '搞懂', kinds: ['tutor', 'card'] },
  { key: 'keep', label: '留下', kinds: ['note'] },
  { key: 'deliver', label: '交付', kinds: ['output', 'task'] },
  { key: 'judge', label: '判断', kinds: ['decision'] },
]

const THREAD: ThreadRow = {
  id: 1,
  name: 'RAG 评测',
  note: '',
  archived: false,
  created_at: null,
  updated_at: null,
  counts: { card: 2 },
  total: 2,
}

const DETAIL: ThreadDetail = {
  ...THREAD,
  items: [
    { kind: 'card', ref: '7', title: '怎么评', exists: true, step: 'learn', href: '/review' },
    { kind: 'note', ref: 'notes/gone.md', title: '（已不存在）', exists: false, step: 'keep', href: '' },
  ],
  by_step: {
    learn: [{ kind: 'card', ref: '7', title: '怎么评', exists: true, step: 'learn', href: '/review' }],
    keep: [
      { kind: 'note', ref: 'notes/gone.md', title: '（已不存在）', exists: false, step: 'keep', href: '' },
    ],
  },
  steps: STEPS,
  suggestions: [{ kind: 'card', ref: '9', title: 'RAG 评测怎么做', label: 'RAG 评测', step: 'learn' }],
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
})

afterEach(cleanup)

describe('ThreadsPage', () => {
  it('列出这件事，并给出五步各有几条（空的步不占位）', async () => {
    vi.mocked(api.listThreads).mockResolvedValue({ threads: [THREAD], steps: STEPS })
    renderPage()

    expect(await screen.findByText('RAG 评测')).toBeTruthy()
    expect(screen.getByText('搞懂 2')).toBeTruthy()
    expect(screen.queryByText('留下 0')).toBeNull()
  })

  it('没有任何一件事时给一句实话，并指路「未归类」', async () => {
    renderPage()
    expect(await screen.findByText(/还没有一件事/)).toBeTruthy()
  })

  it('建一件事，建完就打开它', async () => {
    vi.mocked(api.createThread).mockResolvedValue(THREAD)
    renderPage()

    fireEvent.change(await screen.findByPlaceholderText(/新的一件事/), {
      target: { value: 'RAG 评测' },
    })
    fireEvent.click(screen.getByText('建'))
    await waitFor(() => expect(api.createThread).toHaveBeenCalledWith('RAG 评测'))
  })

  it('打开一件事：按五步摆开；引用丢了的那条不给落点', async () => {
    vi.mocked(api.listThreads).mockResolvedValue({ threads: [THREAD], steps: STEPS })
    renderPage('/?thread=1')

    expect(await screen.findByText('搞懂')).toBeTruthy()
    expect(screen.getByRole('button', { name: '怎么评' })).toBeTruthy() // 活的，点得开
    // 指向已经不存在的东西 → 一段灰字，不是可点的
    expect(screen.queryByRole('button', { name: '（已不存在）' })).toBeNull()
    expect(screen.getByText('（已不存在）')).toBeTruthy()
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
})
