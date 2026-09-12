// @testing-library + vitest, jsdom environment (vite.config.ts). 前端此前零测试，
// 教学页是产品独有价值所在的地方，所以第一批判的是它：卡点召回条、取材来源行、
// 以及 SSE 流里 sources 事件的解析——这三个都是「页面能不能说实话」的关口。
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

import {
  MaterialLine,
  RecallChip,
  shortSource,
} from './TutorPage'
import { streamTutorSay, type TutorRecallHit } from './stream'

describe('shortSource', () => {
  it('取路径尾部两段 —— chroma 的 title 只是文件名去后缀，认不出位置', () => {
    expect(shortSource('repos/hello-generic-agent/docs/part1/chapter3/index.md')).toBe(
      'chapter3/index.md'
    )
    expect(shortSource('clippings/fastapi.tiangolo.com-1d9476.md')).toBe(
      'clippings/fastapi.tiangolo.com-1d9476.md'
    )
    expect(shortSource('top.md')).toBe('top.md')
  })
})

describe('RecallChip', () => {
  it('把卡点原样亮出来 —— 验收要判断「触发得对」，藏着掖着就没了判断依据', () => {
    const hits: TutorRecallHit[] = [
      {
        concept: 'asyncio 事件循环',
        verdict: 'half',
        stuck: '以为 await 交给了操作系统',
        date: '08-21',
        score: 0.71,
      },
    ]
    render(<RecallChip hits={hits} />)
    expect(screen.getByText('接上了以前的记录')).toBeTruthy()
    expect(screen.getByText(/asyncio 事件循环/)).toBeTruthy()
    expect(screen.getByText(/半懂/)).toBeTruthy()
    expect(screen.getByText(/以为 await 交给了操作系统/)).toBeTruthy()
  })

  it('没有命中就不渲染这个板块', () => {
    const { container } = render(<RecallChip hits={[]} />)
    expect(container.textContent).toBe('')
  })
})

describe('MaterialLine', () => {
  it('来源用短路径，且多个 chip 各自独立', () => {
    const { container } = render(
      <MaterialLine
        sources={[
          { source: 'repos/ga/docs/part1/chapter3/index.md', title: 'index', score: 0.5 },
          { source: 'notes/loop.md', title: 'loop', score: 0.4 },
        ]}
      />
    )
    expect(screen.getByText(/取材/)).toBeTruthy()
    expect(container.textContent).toContain('chapter3/index.md')
    expect(container.textContent).toContain('notes/loop.md')
  })
})

function sseResponse(frames: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder()
      for (const f of frames) controller.enqueue(enc.encode(f))
      controller.close()
    },
  })
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}

describe('streamTutorSay', () => {
  it('解析 sources 事件 —— 后端新加的取材事件不能在页面上哑掉', async () => {
    const frames = [
      'event: sources\ndata: {"sources":[{"source":"notes/loop.md","title":"","score":0.7}]}\n\n',
      'event: delta\ndata: {"text":"讲"}\n\n',
      'event: done\ndata: {"model_id":"p/m","recalled":false}\n\n',
    ]
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse(frames)))
    const seen: unknown[] = []
    const done = await streamTutorSay(
      { session_id: 1, text: '问' },
      { onDelta: () => {}, onSources: (s) => seen.push(s) }
    )
    expect(done.ok).toBe(true)
    expect(seen).toEqual([[{ source: 'notes/loop.md', title: '', score: 0.7 }]])
  })

  it('流内 error 事件变成 ok:false —— SSE 一旦开了就没有状态码可设', async () => {
    const frames = ['event: error\ndata: {"message":"没有 provider"}\n\n']
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse(frames)))
    const done = await streamTutorSay(
      { session_id: 1, text: '问' },
      { onDelta: () => {} }
    )
    expect(done.ok).toBe(false)
    expect(done.error).toBe('没有 provider')
  })

  it('abort 信号转发给 fetch —— 中断传播的前端一半', async () => {
    const frames = [
      'event: delta\ndata: {"text":"讲"}\n\n',
      'event: done\ndata: {}\n\n',
    ]
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => { void init; return sseResponse(frames) })
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    await streamTutorSay(
      { session_id: 1, text: '问' },
      { onDelta: () => {} },
      controller.signal
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][1]?.signal).toBe(controller.signal)
  })
})
