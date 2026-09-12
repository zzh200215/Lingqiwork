// 卡片清单：卡片此前没有任何清单界面，于是「事」上没法挂卡片。这里钉住那个落点。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

import CardList from './CardList'
import type { CardItem } from './api'

vi.mock('./api', () => ({
  api: {
    listCards: vi.fn(),
    suggestThreads: vi.fn(),
    attachThreadItem: vi.fn(),
    createThread: vi.fn(),
  },
}))
import { api } from './api'

const CARD: CardItem = {
  id: 7,
  kind: 'concept',
  front: 'RAG 怎么评',
  back: '看命中率',
  hint: '',
  topic: 'RAG',
  source: 'notes/loop.md',
  source_label: 'loop',
  source_excerpt: '',
  origin: 'ai',
  suspended: false,
  due: null,
  interval_days: 0,
  ease: 2.5,
  reps: 0,
  lapses: 0,
  last_grade: null,
  last_review: null,
  created_at: null,
}

function renderPage() {
  return render(
    <MemoryRouter>
      <CardList />
    </MemoryRouter>
  )
}

afterEach(cleanup)

describe('CardList', () => {
  it('默认收起，展开才去读卡片', async () => {
    vi.mocked(api.listCards).mockResolvedValue({ total: 1, cards: [CARD] })
    renderPage()

    expect(api.listCards).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('全部卡片'))
    expect(await screen.findByText('RAG 怎么评')).toBeTruthy()
    expect(screen.getByText('1 张')).toBeTruthy()
  })

  it('能筛，且每一行都挂得出去——这就是卡片此前缺的落点', async () => {
    vi.mocked(api.listCards).mockResolvedValue({
      total: 2,
      cards: [CARD, { ...CARD, id: 8, front: '晚上吃什么', topic: '做饭' }],
    })
    vi.mocked(api.suggestThreads).mockResolvedValue({ label: '做饭', threads: [] })
    renderPage()

    fireEvent.click(screen.getByText('全部卡片'))
    await screen.findByText('RAG 怎么评')

    fireEvent.change(screen.getByPlaceholderText('筛题面 / 答案 / 主题…'), {
      target: { value: '吃' },
    })
    expect(screen.queryByText('RAG 怎么评')).toBeNull()
    expect(screen.getByText('晚上吃什么')).toBeTruthy()

    fireEvent.click(screen.getByText('挂到…'))
    await waitFor(() => expect(api.suggestThreads).toHaveBeenCalledWith('card', '8'))
  })

  it('一张卡都没有时指路去出卡，而不是空白', async () => {
    vi.mocked(api.listCards).mockResolvedValue({ total: 0, cards: [] })
    renderPage()

    fireEvent.click(screen.getByText('全部卡片'))
    expect(await screen.findByText(/还没有卡片/)).toBeTruthy()
  })
})
