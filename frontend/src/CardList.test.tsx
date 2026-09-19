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
    cardPrereq: vi.fn(),
    markPrereqSeen: vi.fn(),
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

function renderPage(entry = '/review') {
  return render(
    <MemoryRouter initialEntries={[entry]}>
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

  // PLAN2 T1 场景 B：从学习地图那一行小字跳过来，只看那个概念名下的卡。
  it('?topic= 进来就直接展开并只看这些话题词的卡，筛着的时候说得出来也撤得掉', async () => {
    vi.mocked(api.listCards).mockResolvedValue({
      total: 2,
      cards: [CARD, { ...CARD, id: 8, front: '晚上吃什么', topic: '做饭' }],
    })
    const { container } = renderPage('/review?topic=RAG&topic=event%20loop')
    expect(await screen.findByText('RAG 怎么评')).toBeTruthy()
    expect(screen.queryByText('晚上吃什么')).toBeNull() // 话题词不在筛里
    const note = container.querySelector('[data-topic-filter]')
    expect(note?.textContent).toContain('「RAG」')
    expect(note?.textContent).toContain('「event loop」')

    fireEvent.click(screen.getByText('清除'))
    expect(screen.getByText('晚上吃什么')).toBeTruthy()
  })

  // PLAN2 T3：搁置的卡才翻得动候选，而且**点一下才算一次**（拉取式）。
  it('搁置卡「可能缺前置」：点开才问后端，候选带状态标签并直接开一场教学', async () => {
    const dead = { ...CARD, id: 9, front: 'await 到底交给了谁', suspended: true }
    vi.mocked(api.listCards).mockResolvedValue({ total: 1, cards: [dead] })
    vi.mocked(api.cardPrereq).mockResolvedValue({
      card_id: 9,
      topic: 'RAG',
      concept: 'RAG',
      suspended: true,
      lapses: 8,
      candidates: [
        { concept: '召回率', status: '半懂' },
        { concept: '重排', status: '半懂 · 又卡住' },
      ],
    })
    vi.mocked(api.markPrereqSeen).mockResolvedValue({ ok: true })
    const view = renderPage()
    fireEvent.click(screen.getByText('全部卡片'))
    await screen.findByText('await 到底交给了谁')

    expect(api.cardPrereq).not.toHaveBeenCalled() // 拉取式：看的时候才有
    expect(api.markPrereqSeen).not.toHaveBeenCalled() // 「翻过」也只在真翻的那一下记
    fireEvent.click(view.container.querySelector('[data-prereq-open="9"]') as HTMLElement)
    const box = await screen.findByText(/可能缺前置/)
    expect(api.cardPrereq).toHaveBeenCalledWith(9)
    // PLAN2 §6：翻过要记一笔，而且**是单独一次 POST**，不是那条 GET 的副作用
    await waitFor(() => expect(api.markPrereqSeen).toHaveBeenCalledWith(9))
    expect(box.textContent).toContain('召回率')
    expect(box.textContent).toContain('半懂 · 又卡住')
    // 点候选开课时带上「从这张卡的候选来的」（回指采纳的分子），话题仍是那个概念
    const link = view.container.querySelector('a[href^="/tutor?new="]')
    expect(link?.getAttribute('href')).toBe('/tutor?new=%E5%8F%AC%E5%9B%9E%E7%8E%87&prereq=9')
  })

  it('找不到候选就说找不到，不硬凑一行', async () => {
    const dead = { ...CARD, id: 9, front: 'await 到底交给了谁', suspended: true }
    vi.mocked(api.listCards).mockResolvedValue({ total: 1, cards: [dead] })
    vi.mocked(api.cardPrereq).mockResolvedValue({
      card_id: 9,
      topic: 'RAG',
      concept: '',
      suspended: true,
      lapses: 8,
      candidates: [],
    })
    const view = renderPage()
    fireEvent.click(screen.getByText('全部卡片'))
    await screen.findByText('await 到底交给了谁')
    fireEvent.click(view.container.querySelector('[data-prereq-open="9"]') as HTMLElement)
    expect(await screen.findByText(/没找到可能的前置/)).toBeTruthy()
  })
})
