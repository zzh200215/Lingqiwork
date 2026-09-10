// sseFrames 的解析细节单测。streamTutorSay 的场景测试（TutorPage.test.tsx）走的是
// 完整函数；这里钉的是帧解析器本身——半帧缓冲、多行 data、keep-alive 跳过这些
// 分叉一旦坏了，全部流式功能（聊天/教学/播客/卡片）一起哑，却很难从页面看出来。
import { describe, expect, it } from 'vitest'

import { sseFrames } from './stream'

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
