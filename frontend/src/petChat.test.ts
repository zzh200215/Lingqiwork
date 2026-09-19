// Z1（PLAN4）：聊天请求带上**最近几轮对话**。
//
// 后端每一轮都是新的 `messages`（不落库是设计），不带历史它就记不得你上一句。
// 这一层钉两件事：`historyOf` 的过滤与上限、请求体里真的带了它。
import { afterEach, describe, expect, it, vi } from 'vitest'

import { historyOf, PET_HISTORY_MESSAGES, streamPetChat } from './petChat'

/** 一份最小的 SSE 响应：够 `streamPetChat` 那圈 `getReader()` 跑完。 */
function sseResponse(frames: string[]) {
  const enc = new TextEncoder()
  let i = 0
  return {
    ok: true,
    body: {
      getReader: () => ({
        read: async () =>
          i < frames.length
            ? { done: false, value: enc.encode(frames[i++]) }
            : { done: true, value: undefined },
      }),
    },
  }
}

afterEach(() => vi.unstubAllGlobals())

describe('historyOf', () => {
  it('丢掉还没说出话的那条——正在流的那条占位是空串，不该当成它说过的话', () => {
    expect(
      historyOf([
        { role: 'user', text: '第一问' },
        { role: 'pet', text: '' },
      ])
    ).toEqual([{ role: 'user', text: '第一问' }])
    expect(historyOf([{ role: 'user', text: '   ' }])).toEqual([])
  })

  it('只留最近几条，顺序不动', () => {
    const chat = Array.from({ length: 12 }, (_, i) => ({
      role: (i % 2 ? 'pet' : 'user') as 'user' | 'pet',
      text: `第 ${i} 句`,
    }))
    const got = historyOf(chat)
    expect(got.length).toBe(PET_HISTORY_MESSAGES)
    expect(got[0].text).toBe('第 6 句')
    expect(got[got.length - 1].text).toBe('第 11 句')
  })
})

describe('streamPetChat', () => {
  it('这一句与历史一起发出去（后端那边才接得上一句）', async () => {
    const bodies: { message?: string; history?: unknown }[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: unknown, init?: { body?: string }) => {
        bodies.push(JSON.parse(String(init?.body ?? '{}')))
        return Promise.resolve(sseResponse(['event: delta\ndata: {"text":"在。"}\n\n', 'event: done\ndata: {}\n\n']))
      })
    )
    const seen: string[] = []
    await streamPetChat(
      {
        message: '那第 2 条呢',
        history: [
          { role: 'user', text: '我今天干了啥' },
          { role: 'pet', text: '过了 3 张卡。' },
        ],
      },
      { onDelta: (t) => seen.push(t) }
    )
    expect(bodies[0].message).toBe('那第 2 条呢')
    expect(bodies[0].history).toEqual([
      { role: 'user', text: '我今天干了啥' },
      { role: 'pet', text: '过了 3 张卡。' },
    ])
    expect(seen.join('')).toBe('在。')
  })

  it('历史超上限时只发最近几条，且没有历史就发空数组', async () => {
    const bodies: { history?: unknown[] }[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: unknown, init?: { body?: string }) => {
        bodies.push(JSON.parse(String(init?.body ?? '{}')))
        return Promise.resolve(sseResponse(['event: done\ndata: {}\n\n']))
      })
    )
    const long = Array.from({ length: 20 }, (_, i) => ({ role: 'user' as const, text: `第 ${i} 句` }))
    await streamPetChat({ message: 'a', history: long }, { onDelta: () => {} })
    await streamPetChat({ message: 'b' }, { onDelta: () => {} })
    expect((bodies[0].history as unknown[]).length).toBe(PET_HISTORY_MESSAGES)
    expect(bodies[1].history).toEqual([])
  })
})
