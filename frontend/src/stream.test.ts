// sseFrames 的解析细节单测。streamTutorSay 的场景测试（TutorPage.test.tsx）走的是
// 完整函数；这里钉的是帧解析器本身——半帧缓冲、多行 data、keep-alive 跳过这些
// 分叉一旦坏了，全部流式功能（聊天/教学/播客/卡片）一起哑，却很难从页面看出来。
import { describe, expect, it, vi } from 'vitest'

import {
  sseFrames,
  streamCardsGenerate,
  streamChat,
  streamCollab,
  streamCompose,
  streamDecide,
  streamDeliver,
} from './stream'

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

// streamDeliver 的契约：除了话题与体裁×读者，两个「加进这一次」的输入也必须真的进请求体——
// 钉材料（§4-14）与**定稿的提纲**（§8.1）。少了任何一个，界面上做的事在服务端就不存在。
describe('streamDeliver', () => {
  it('把钉住的材料与定稿的提纲一起发出去', async () => {
    const frames =
      'event: gathering\ndata: {}\n\n' +
      'event: report\ndata: {"title":"T","sections":[],"used":[],"sources":[],"outline":["本周进展","风险"]}\n\n'
    const fetchMock = vi.fn(async () => resOf([frames]))
    vi.stubGlobal('fetch', fetchMock)
    try {
      const done = await streamDeliver(
        '这周的 RAG',
        'weekly',
        'leader',
        () => {},
        undefined,
        ['notes/a.md'],
        ['本周进展', '风险']
      )
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/deliver',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            topic: '这周的 RAG',
            genre: 'weekly',
            audience: 'leader',
            pinned: ['notes/a.md'],
            outline: ['本周进展', '风险'],
            extra: '',
          }),
        })
      )
      expect(done.ok).toBe(true)
      expect(done.report?.outline).toEqual(['本周进展', '风险'])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('不走提纲时发一个空表——不是不发这个字段', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      resOf(['event: report\ndata: {"title":"T","sections":[],"used":[],"sources":[]}\n\n'])
    )
    vi.stubGlobal('fetch', fetchMock)
    try {
      await streamDeliver('话题', 'email', 'self', () => {})
      const body = JSON.parse(fetchMock.mock.calls[0][1]?.body as string)
      expect(body.outline).toEqual([])
      expect(body.pinned).toEqual([])
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

// 产出回执：`save_artifact` 跑完后端补发一条 `tool_result`，前端靠它渲染
// 「已存入产出」的链接。这条事件哑了，界面就只剩模型嘴里那句「已存好」——点不开。
describe('streamChat 的 tool_result', () => {
  it('把 name/meta 派给 onToolResult，正文不进回调', async () => {
    const frames =
      'event: delta\ndata: {"text":"存好了。"}\n\n' +
      'event: tool_result\ndata: {"name":"save_artifact","meta":{"artifact":{"kind":"deliver","label":"交付","title":"周报","path":"deliver/x.md","href":"/notes?path=deliver%2Fx.md","chunks":2}}}\n\n' +
      'event: done\ndata: {}\n\n'
    vi.stubGlobal('fetch', vi.fn(async () => resOf([frames])))
    try {
      const seen: [string, Record<string, unknown>, string | undefined][] = []
      const deltas: string[] = []
      await streamChat(
        1,
        '写一份周报',
        false,
        {
          onDelta: (t) => deltas.push(t),
          onError: () => {},
          onDone: () => {},
          onToolResult: (name, meta, uid) => seen.push([name, meta, uid]),
        },
        new AbortController().signal
      )
      expect(deltas).toEqual(['存好了。'])
      expect(seen).toHaveLength(1)
      expect(seen[0][0]).toBe('save_artifact')
      expect((seen[0][1].artifact as { href: string }).href).toBe('/notes?path=deliver%2Fx.md')
      expect(seen[0][2]).toBeUndefined() // 单路聊天没有 uid
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('对比模式的 tool_result 带上 uid —— A/B 两路的回执不能串味', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => resOf([
      'event: tool_result\ndata: {"name":"save_artifact","meta":{"artifact":{"href":"/a"}},"uid":"b"}\n\n',
      'event: done\ndata: {}\n\n',
    ])))
    try {
      const uids: (string | undefined)[] = []
      await streamChat(1, 'x', false, {
        onDelta: () => {},
        onError: () => {},
        onDone: () => {},
        onToolResult: (_n, _m, uid) => uids.push(uid),
      }, new AbortController().signal)
      expect(uids).toEqual(['b'])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('没接 onToolResult 时不炸 —— 老调用点不用改', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => resOf([
      'event: tool_result\ndata: {"name":"save_artifact","meta":{}}\n\n',
      'event: done\ndata: {}\n\n',
    ])))
    try {
      await streamChat(1, 'x', false, { onDelta: () => {}, onError: () => {}, onDone: () => {} }, new AbortController().signal)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

// W2a：两条底线的校验结论 + 这一轮刚落库的消息 id。两帧都哑了的话，界面既看不到
// 「该存没存」的实话，也点不了那条「📄 存进产出」的人工出口（它按 message id 存）。
describe('streamChat 的 quality / saved', () => {
  it('quality 帧带着判据结论与 uid', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => resOf([
      'event: quality\ndata: {"codes":["long_body_without_a_receipt"],"retried":true,"asked_to_save":true}\n\n' +
        'event: done\ndata: {}\n\n',
    ])))
    try {
      const seen: { codes?: string[]; retried?: boolean; asked?: boolean; uid?: string }[] = []
      await streamChat(1, 'x', false, {
        onDelta: () => {},
        onError: () => {},
        onDone: () => {},
        onQuality: (note, uid) =>
          seen.push({ codes: note.codes, retried: note.retried, asked: note.asked_to_save, uid }),
      }, new AbortController().signal)
      expect(seen).toEqual([{ codes: ['long_body_without_a_receipt'], retried: true, asked: true, uid: undefined }])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  // P3：引用验证。服务端剥掉了编造的 [来源 N] 之后，带一份干净正文来让界面替换气泡——
  // 这一帧哑了的话，库里是剥干净的、屏幕上还留着那个假编号（两边不一致比不剥更糟）。
  it('citations 帧把剥完的正文与被拿掉的编号交给界面', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => resOf([
      'event: citations\ndata: {"text":"结论在这里。","fake":[7],"injected":5,"cited":[1]}\n\n' +
        'event: done\ndata: {}\n\n',
    ])))
    try {
      const seen: { text?: string; fake?: number[]; injected?: number; uid?: string }[] = []
      await streamChat(1, 'x', false, {
        onDelta: () => {},
        onError: () => {},
        onDone: () => {},
        onCitations: (fix, uid) =>
          seen.push({ text: fix.text, fake: fix.fake, injected: fix.injected, uid }),
      }, new AbortController().signal)
      expect(seen).toEqual([{ text: '结论在这里。', fake: [7], injected: 5, uid: undefined }])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('saved 帧把 message_id 交给界面（对比模式带 uid）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => resOf([
      'event: done\ndata: {}\n\n' +
        'event: saved\ndata: {"uid":"b","message_id":42}\n\n',
    ])))
    try {
      const seen: [number, string | undefined][] = []
      await streamChat(1, 'x', false, {
        onDelta: () => {},
        onError: () => {},
        onDone: () => {},
        onSaved: (id, uid) => seen.push([id, uid]),
      }, new AbortController().signal)
      expect(seen).toEqual([[42, 'b']])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('两种帧都没接时不炸', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => resOf([
      'event: quality\ndata: {"codes":[]}\n\nevent: saved\ndata: {"message_id":1}\n\nevent: done\ndata: {}\n\n',
    ])))
    try {
      await streamChat(1, 'x', false, { onDelta: () => {}, onError: () => {}, onDone: () => {} }, new AbortController().signal)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('协作的逐步账（step 事件）', () => {
  it('每一步的事实原样交给 onStep（界面照抄，不自己算）', async () => {
    const fact = {
      step: 2,
      title: '读材料 · 检索内核',
      phase: 'read',
      agent: '写手',
      rounds: 2,
      tools: ['vault_read_file'],
      seconds: 3.4,
      rounds_exhausted: false,
      parallel: true,
    }
    vi.stubGlobal('fetch', vi.fn(async () => resOf([
      `event: step\ndata: ${JSON.stringify({ fact })}\n\n`,
      'event: done\ndata: {}\n\n',
    ])))
    const seen: unknown[] = []
    try {
      await streamCollab(1, '目标', [1, 2], 'fanout', false, [], {
        onDelta: () => {},
        onError: () => {},
        onDone: () => {},
        onStep: (f) => seen.push(f),
      }, new AbortController().signal)
    } finally {
      vi.unstubAllGlobals()
    }
    expect(seen).toEqual([fact])
  })

  it('没有 onStep 时也不炸（老调用方不用改）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => resOf([
      'event: step\ndata: {"fact":{"step":1,"title":"x","phase":"work","agent":"a","rounds":1,"tools":[],"seconds":1}}\n\n',
      'event: done\ndata: {}\n\n',
    ])))
    try {
      await streamCollab(1, '目标', [1, 2], 'pipeline', false, [], {
        onDelta: () => {},
        onError: () => {},
        onDone: () => {},
      }, new AbortController().signal)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('钉的材料原样进请求体（材料清单的第二个来源，2026-09-22）', async () => {
    const f = vi.fn(async (_url: string, _init?: RequestInit) => resOf(['event: done\ndata: {}\n\n']))
    vi.stubGlobal('fetch', f)
    try {
      await streamCollab(1, '目标', [1, 2], 'fanout', true, ['notes/a.md', 'clippings/b.md'], {
        onDelta: () => {},
        onError: () => {},
        onDone: () => {},
      }, new AbortController().signal)
    } finally {
      vi.unstubAllGlobals()
    }
    const body = JSON.parse(String(f.mock.calls[0]?.[1]?.body))
    expect(body.pinned).toEqual(['notes/a.md', 'clippings/b.md'])
    expect(body.pattern).toBe('fanout')
  })
})
