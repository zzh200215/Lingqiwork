// 「这一轮读哪几份」（材料清单的第二个来源，2026-09-22）。
//
// 这一层钉的是**界面自己的那几条口径**：钉的是后端给的那个 `spec`（不是标题）、同一份只钉
// 一次、顺序就是钉的顺序、搜不到不炸。至于「钉了到底进没进编排器的清单」——那是后端的事，
// 由 `tests/test_thread_context.py::test_the_collab_route_takes_pinned_materials_as_a_second_source`
// 走真路由钉住；这里不重算一遍（同一件事的第二份实现迟早会漂）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import CollabPins, { type PinnedMaterial } from './CollabPins'
import type { MaterialHit } from './api'
import { api } from './api'

vi.mock('./api', () => ({
  api: { searchMaterial: vi.fn() },
}))

const hit = (spec: string, title: string): MaterialHit => ({
  source: `vault:${spec}`,
  spec,
  title,
  chunk: 0,
  score: 0.5,
  text: '正文',
  cards: 0,
})

function setup(pins: PinnedMaterial[] = []) {
  const onChange = vi.fn()
  render(<CollabPins pins={pins} onChange={onChange} />)
  return onChange
}

async function search(text: string, hits: MaterialHit[]) {
  vi.mocked(api.searchMaterial).mockResolvedValue({ query: text, hits })
  fireEvent.click(screen.getByText('＋ 钉一条材料'))
  fireEvent.change(screen.getByPlaceholderText('在你自己的材料里搜一条…'), {
    target: { value: text },
  })
  fireEvent.click(screen.getByText('搜'))
  await screen.findByText(hits[0]?.title ?? '（空）').catch(() => {})
}

beforeEach(() => vi.clearAllMocks())
afterEach(cleanup)

describe('协作面板 · 钉材料', () => {
  it('搜出来点一下就钉上：进去的是后端给的 spec，不是标题', async () => {
    const onChange = setup()
    await search('rag', [hit('notes/rag.md', 'RAG 这一轮')])
    fireEvent.click(screen.getByText('RAG 这一轮'))
    expect(onChange).toHaveBeenCalledWith([{ spec: 'notes/rag.md', title: 'RAG 这一轮' }])
  })

  it('同一份钉两次只留一条（按 spec 去重）', async () => {
    const onChange = setup([{ spec: 'notes/rag.md', title: 'RAG 这一轮' }])
    await search('rag', [hit('notes/rag.md', 'RAG 这一轮（另一个分块）')])
    fireEvent.click(screen.getByText('RAG 这一轮（另一个分块）'))
    expect(onChange).not.toHaveBeenCalled()
  })

  it('钉住的按钉的顺序排，✕ 取消其中一条', () => {
    const pins = [
      { spec: 'clippings/材料.md', title: '材料' },
      { spec: 'notes/索引.md', title: '索引' },
    ]
    const onChange = setup(pins)
    const chips = screen.getAllByTitle(/\.md$/)
    expect(chips.map((c) => c.getAttribute('data-collab-pin'))).toEqual([
      'clippings/材料.md',
      'notes/索引.md',
    ])
    fireEvent.click(screen.getAllByTitle('取消钉住')[0])
    expect(onChange).toHaveBeenCalledWith([{ spec: 'notes/索引.md', title: '索引' }])
  })

  it('搜索失败不炸，也不假装搜到了', async () => {
    vi.mocked(api.searchMaterial).mockRejectedValue(new Error('boom'))
    setup()
    fireEvent.click(screen.getByText('＋ 钉一条材料'))
    fireEvent.change(screen.getByPlaceholderText('在你自己的材料里搜一条…'), {
      target: { value: 'rag' },
    })
    fireEvent.click(screen.getByText('搜'))
    // 面板还在、没有假装搜到一条，而且"搜"这个按钮恢复可用（busy 落了）
    await waitFor(() => expect(screen.getByText('搜')).toBeTruthy())
    expect(document.querySelectorAll('[data-collab-pin-hit]').length).toBe(0)
    expect((screen.getByText('搜') as HTMLButtonElement).disabled).toBe(false)
  })

  it('空查询不搜（省一次冷启动六秒的检索）', () => {
    setup()
    fireEvent.click(screen.getByText('＋ 钉一条材料'))
    fireEvent.click(screen.getByText('搜'))
    expect(api.searchMaterial).not.toHaveBeenCalled()
  })

  it('把「读步手里只有 vault 里的文件」这句写在脸上（钉了 vault 外的东西会被后端跳过）', () => {
    setup()
    expect(screen.getByText(/读步手里只有 vault 里的文件/)).toBeTruthy()
  })
})
