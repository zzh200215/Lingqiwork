// sseFrames 的解析细节单测。streamTutorSay 的场景测试（TutorPage.test.tsx）走的是
// 完整函数；这里钉的是帧解析器本身——半帧缓冲、多行 data、keep-alive 跳过这些
// 分叉一旦坏了，全部流式功能（聊天/教学/播客/卡片）一起哑，却很难从页面看出来。
import { describe, expect, it, vi } from 'vitest'

import { sseFrames, streamCardsGenerate, streamCompose, streamDecide } from './stream'

function resOf(chunks: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder()
      for (const c of chunks) controller.enqueue(enc.encode(c))
      controller.close()
    },
  })
  return new Response(body, { status: 200 })
}

async function collect(chunks: string[]) {
  const out: [string, Record<string, unknown>][] = []
  for await (const [ev, data] of sseFrames(resOf(chunks))) out.push([ev, data])
  return out
}

describe('sseFrames', () => {
  it('基本帧：event + data', async () => {
    expect(await collect(['event: delta\ndata: {"text":"hi"}\n\n'])).toEqual([
      ['delta', { text: 'hi' }],
    ])
  })

  it('缺省 event 落到 message —— SSE 规范默认值', async () => {
    expect(await collect(['data: {"ok":1}\n\n'])).toEqual([['message', { ok: 1 }]])
  })

  it('多行 data 按换行拼回再 parse —— pretty-printed JSON 不能哑', async () => {
    const frames = ['event: x\ndata: {\ndata:   "a": 1,\ndata:   "b": 2\ndata: }\n\n']
    expect(await collect(frames)).toEqual([['x', { a: 1, b: 2 }]])
  })

  it('半帧跨 chunk：缓冲必须攒齐再切 —— 网络分包不保证按帧对齐', async () => {
    const out = await collect(['event: del', 'ta\ndata: {"t":', '1}\n\n'])
    expect(out).toEqual([['delta', { t: 1 }]])
  })

  it('多帧连续解析', async () => {
    const out = await collect([
      'event: a\ndata: {"n":1}\n\nevent: b\ndata: {"n":2}\n\n',
    ])
    expect(out).toEqual([
      ['a', { n: 1 }],
      ['b', { n: 2 }],
    ])
  })

  it('注释/keep-alive 帧（无 data 行）跳过，不产生垃圾事件', async () => {
    const out = await collect([': ping\n\nevent: delta\ndata: {"t":1}\n\n'])
    expect(out).toEqual([['delta', { t: 1 }]])
  })

  it('流结束时残留的不完整帧被丢弃，不抛错', async () => {
    const out = await collect(['event: delta\ndata: {"t":1}\n\n', 'data: {"cut'])
    expect(out).toEqual([['delta', { t: 1 }]])
  })

  // 刻意不测 CRLF：数据源是自家 FastAPI（固定 \n\n），本地优先无中间代理。
  // 真遇到改写换行的网关属于那一层的问题，不为它加解析复杂度。
})

// streamCompose 的契约：进度事件转发给 onStage、report 解析成 ok:true、
// error 落成 ok:false 而不是抛异常（同 streamResearch 的约定——进度已经渲染在
// 页面上，抛出会把它一起丢掉）。这些一旦坏了，页面只会「点了没反应」。
describe('streamCompose', () => {
  it('转发 gathering/sources/writing，report 落成 ok:true', async () => {
    const frames =
      'event: gathering\ndata: {}\n\n' +
      'event: sources\ndata: {"sources":[{"n":1,"kind":"kb","title":"A","ref":"notes/a.md"}],"kb":1}\n\n' +
      'event: writing\ndata: {}\n\n' +
      'event: report\ndata: {"title":"T","sections":[{"heading":"H","body":"B [1]"}],"used":[1],"sources":[],"model_id":"m"}\n\n'
    const fetchMock = vi.fn(async () => resOf([frames]))
    vi.stubGlobal('fetch', fetchMock)
    try {
      const stages: string[] = []
      const done = await streamCompose('话题', (ev) => stages.push(ev))
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/compose',
        expect.objectContaining({ method: 'POST', body: JSON.stringify({ topic: '话题' }) })
      )
      expect(stages).toEqual(['gathering', 'sources', 'writing'])
      expect(done.ok).toBe(true)
      expect(done.report?.title).toBe('T')
      expect(done.report?.used).toEqual([1])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('error 事件落成 ok:false，不抛', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => resOf(['event: error\ndata: {"message":"模型挂了"}\n\n'])))
    try {
      const done = await streamCompose('t', () => {})
      expect(done.ok).toBe(false)
      expect(done.error).toBe('模型挂了')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

// streamDecide 多一条 `frame`：它是这一条**给人看的**中间产物（读错题是第一位失败模式），
// 所以必须转发到 onStage 而不是被当成内部步骤吞掉——吞掉页面就只剩一个「理清中…」。
describe('streamDecide', () => {
  it('frame 转发给 onStage（不吞），report 带上题面', async () => {
    const frames =
      'event: framing\ndata: {}\n\n' +
      'event: frame\ndata: {"decision":"选哪个向量库","options":["Chroma","Qdrant"],"criteria":["部署成本"]}\n\n' +
      'event: gathering\ndata: {}\n\n' +
      'event: sources\ndata: {"sources":[{"n":1,"kind":"kb","title":"A","ref":"notes/a.md"}],"kb":1,"web":0}\n\n' +
      'event: writing\ndata: {}\n\n' +
      'event: draft\ndata: {"title":"T","sections":[{"heading":"H","body":"B"}]}\n\n' +
      'event: report\ndata: {"title":"T","sections":[{"heading":"H","body":"B [1]"}],"used":[1],"sources":[],"model_id":"m","frame":{"decision":"选哪个向量库","options":["Chroma"],"criteria":[]}}\n\n'
    const fetchMock = vi.fn(async () => resOf([frames]))
    vi.stubGlobal('fetch', fetchMock)
    try {
      const stages: [string, Record<string, unknown>][] = []
      const done = await streamDecide('本地向量库怎么选', (ev, data) => stages.push([ev, data]))
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/decide',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ topic: '本地向量库怎么选' }),
        })
      )
      expect(stages.map(([ev]) => ev)).toEqual([
        'framing', 'frame', 'gathering', 'sources', 'writing', 'draft',
      ])
      // draft 转发给页面 —— 正文边生成边渲染靠的就是这一帧
      const draft = stages.find(([ev]) => ev === 'draft')?.[1]
      expect((draft?.sections as { heading: string }[])[0].heading).toBe('H')
      // frame 事件的内容真的到了页面手上——题面读对了没有，只有人看得出来
      const frame = stages.find(([ev]) => ev === 'frame')?.[1]
      expect(frame?.decision).toBe('选哪个向量库')
      expect(frame?.options).toEqual(['Chroma', 'Qdrant'])
      expect(done.ok).toBe(true)
      expect(done.report?.frame?.decision).toBe('选哪个向量库')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('error 事件落成 ok:false，不抛', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => resOf(['event: error\ndata: {"message":"没取到材料"}\n\n'])))
    try {
      const done = await streamDecide('t', () => {})
      expect(done.ok).toBe(false)
      expect(done.error).toBe('没取到材料')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('streamCardsGenerate', () => {
  function stub(payload: string) {
    const fetchMock = vi.fn(
      async (_url: RequestInfo | URL, _init?: RequestInit) => resOf([payload])
    )
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  it('把 focus 原样发到后端 —— 「按点出卡」的「只围绕这一点」靠它落地', async () => {
    const fetchMock = stub('event: done\ndata: {"ok":true,"cards":[],"source":"notes/x.md"}\n\n')
    try {
      const done = await streamCardsGenerate(
        { source_path: 'notes/x.md', focus: 'await 把控制权交给了谁', count: 3 },
        () => {}
      )
      expect(done.ok).toBe(true)
      expect(JSON.parse(fetchMock.mock.calls[0][1]?.body as string)).toMatchObject({
        source_path: 'notes/x.md',
        focus: 'await 把控制权交给了谁',
        count: 3,
      })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('不带 focus 时 body 里就没有这个键 —— 普通出卡维持原样', async () => {
    const fetchMock = stub('event: done\ndata: {"ok":true,"cards":[]}\n\n')
    try {
      await streamCardsGenerate({ text: '一段材料', count: 5 }, () => {})
      expect(JSON.parse(fetchMock.mock.calls[0][1]?.body as string)).not.toHaveProperty('focus')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
