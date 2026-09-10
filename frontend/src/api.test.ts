// request 封装的单测。全前端的后端调用都走这一个函数，它的错误行为
// （非 2xx 把状态码和响应体一起抛出来）决定了所有页面的报错提示长什么样。
import { afterEach, describe, expect, it, vi } from 'vitest'

import { request } from './api'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('request', () => {
  it('2xx 返回解析后的 JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ ok: true, items: [1, 2] }), { status: 200 })
      )
    )
    await expect(request('/api/x')).resolves.toEqual({ ok: true, items: [1, 2] })
  })

  it('非 2xx 抛「状态码: 响应体」—— 页面报错能看出后端说了什么', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('下游任务不存在', { status: 400 }))
    )
    await expect(request('/api/x')).rejects.toThrow('400: 下游任务不存在')
  })

  it('POST 时带 JSON 头与序列化 body', async () => {
    const fetchMock = vi.fn(
      async (_url: RequestInfo | URL, _init?: RequestInit) =>
        new Response('{}', { status: 200 })
    )
    vi.stubGlobal('fetch', fetchMock)
    await request('/api/x', { method: 'POST', body: JSON.stringify({ a: 1 }) })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/x')
    expect(init?.method).toBe('POST')
    expect((init?.headers as Record<string, string>)['Content-Type']).toBe(
      'application/json'
    )
  })
})
