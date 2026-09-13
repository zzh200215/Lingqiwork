// request 封装的单测。全前端的后端调用都走这一个函数，它的错误行为
// （非 2xx 把状态码和响应体一起抛出来）决定了所有页面的报错提示长什么样。
import { afterEach, describe, expect, it, vi } from 'vitest'

import { api, request } from './api'

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

describe('tutorStart', () => {
  function stub() {
    const fetchMock = vi.fn(
      async (_url: RequestInfo | URL, _init?: RequestInit) =>
        new Response('{}', { status: 200 })
    )
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  it('带上 origin_point_id —— 学习地图「未触及」的点开场靠它回填已教', async () => {
    const fetchMock = stub()
    await api.tutorStart('拆出的点', '', 'socratic', 7)
    expect(JSON.parse(fetchMock.mock.calls[0][1]?.body as string)).toMatchObject({
      topic: '拆出的点',
      mode: 'socratic',
      origin_point_id: 7,
    })
  })

  it('普通开场（不带点）时 origin_point_id 为 null —— 不至于把 undefined 发成字符串', async () => {
    const fetchMock = stub()
    await api.tutorStart('随便问问')
    expect(JSON.parse(fetchMock.mock.calls[0][1]?.body as string)).toMatchObject({
      topic: '随便问问',
      origin_point_id: null,
    })
  })
})
