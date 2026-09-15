// @testing-library + vitest, jsdom environment (vite.config.ts). 前端此前零测试，
// 教学页是产品独有价值所在的地方，所以第一批判的是它：卡点召回条、取材来源行、
// 以及 SSE 流里 sources 事件的解析——这三个都是「页面能不能说实话」的关口。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

import {
  MaterialLine,
  pointCardBody,
  ReceiptLine,
  RecallChip,
  shortSource,
} from './TutorPage'
import { streamTutorSay, type TutorRecallHit } from './stream'

describe('ReceiptLine', () => {
  afterEach(cleanup)
  // 学页三张成文卡跑完后的回执行：正文只活在 /notes 详情页，这一行负责指过去。
  it('存了才给链接，且指到 /notes 详情页', () => {
    render(
      <MemoryRouter>
        <ReceiptLine title="向量库选型" meta="来源 12 条" saved="research/2026-09-13-x.md" />
      </MemoryRouter>
    )
    const link = screen.getByText('向量库选型').closest('a')
    expect(link?.getAttribute('href')).toBe(
      '/notes?path=' + encodeURIComponent('research/2026-09-13-x.md')
    )
    expect(screen.getByText(/已存入/)).toBeTruthy()
  })

  it('没存时不给链接 —— 产物还不存在，别指一个空地址', () => {
    render(
      <MemoryRouter>
        <ReceiptLine title="向量库选型" meta="来源 12 条" saved="" />
      </MemoryRouter>
    )
    expect(screen.getByText('向量库选型').closest('a')).toBeNull()
    expect(screen.getByText('来源 12 条')).toBeTruthy()
  })
})

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

describe('MaterialLine', () => {  it('来源用短路径，且多个 chip 各自独立', () => {
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

describe('pointCardBody', () => {
  it('有来源文件 → 用文件，把这一点作为 focus', () => {
    expect(pointCardBody('await 到底交给谁', { source: 'notes/x.md' }, '')).toEqual({
      source_path: 'notes/x.md',
      focus: 'await 到底交给谁',
      count: 3,
    })
  })

  it('粘贴模式 → 用当初粘进去的那段，**不是点标题**', () => {
    // 点标题只有十几个字，后端 MIN_INPUT_CHARS=80 会直接 400。
    // 这个坑是浏览器实测抓到的：单测之前只覆盖了后端提示词，没覆盖这段。
    const material = '材'.repeat(200)
    const body = pointCardBody('await 到底交给谁', { source: '' }, material) as {
      text: string
      focus: string
    }
    expect(body.text).toBe(material)
    expect(body.text).not.toBe('await 到底交给谁')
    expect(body.focus).toBe('await 到底交给谁')
  })

  it('没有 dg 时按粘贴模式处理，不炸', () => {
    const body = pointCardBody('某个点', null, '材料'.repeat(60))
    expect(body).toMatchObject({ focus: '某个点', count: 3 })
    expect(body).toHaveProperty('text')
  })
})
