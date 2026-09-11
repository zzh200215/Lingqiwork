// 输入层第 1 步的离线测试：深链解析 + 小工具构造。两个纯函数，不打网络不渲染。
//
// 小工具字符串一旦构造错（比如 origin 拼歪、少了个引号），表现是「点了没反应」，
// 在浏览器里极难查——所以在这里钉死。
import { describe, expect, it } from 'vitest'

import { asSingleUrl, buildBookmarklet, parseClipParams } from './capture'

describe('parseClipParams', () => {
  it('解析 clip 与 title', () => {
    expect(parseClipParams('?clip=https%3A%2F%2Fx.com%2Fa&title=%E6%A0%87%E9%A2%98')).toEqual({
      url: 'https://x.com/a',
      title: '标题',
    })
  })

  it('title 缺省是空串，不是 undefined —— 调用方少一个分支', () => {
    expect(parseClipParams('?clip=https://x.com/a')).toEqual({ url: 'https://x.com/a', title: '' })
  })

  it('没有 clip 参数就是 null（普通打开页面不该触发剪藏）', () => {
    expect(parseClipParams('')).toBeNull()
    expect(parseClipParams('?path=notes/a.md')).toBeNull()
  })

  it('非 http(s) 的 clip 一律拒绝 —— 不给后端送别的 scheme', () => {
    expect(parseClipParams('?clip=javascript:alert(1)')).toBeNull()
    expect(parseClipParams('?clip=file:///C:/x.md')).toBeNull()
    expect(parseClipParams('?clip=')).toBeNull()
  })
})

describe('asSingleUrl', () => {
  it('整段就是一个网址时才认', () => {
    expect(asSingleUrl('https://example.com/a')).toBe('https://example.com/a')
    expect(asSingleUrl('  http://x.com  ')).toBe('http://x.com')
  })

  it('带空格/换行的多行选中不算 —— 正文里含链接的段落不该被当成网址抓走', () => {
    expect(asSingleUrl('看这个 https://example.com')).toBeNull()
    expect(asSingleUrl('https://a.com\nhttps://b.com')).toBeNull()
  })

  it('非 http(s) 与空文本不算', () => {
    expect(asSingleUrl('')).toBeNull()
    expect(asSingleUrl('   ')).toBeNull()
    expect(asSingleUrl('example.com')).toBeNull() // 没有 scheme 就不是能被抓取的地址
    expect(asSingleUrl('file:///C:/x.md')).toBeNull()
  })
})

describe('buildBookmarklet', () => {
  const bm = buildBookmarklet('http://127.0.0.1:8000')

  it('是可点击的 javascript: 协议地址', () => {
    expect(bm.startsWith('javascript:')).toBe(true)
  })

  it('把当前页的 URL 和标题编码后交给深链', () => {
    expect(bm).toContain('encodeURIComponent(location.href)')
    expect(bm).toContain('encodeURIComponent(document.title)')
    expect(bm).toContain('?clip=\'+u+\'&title=\'+t')
  })

  it('目标是同源的 kb.html —— 顶层导航绕开 CORS，不能指向别的源', () => {
    expect(bm).toContain("window.open('http://127.0.0.1:8000/kb.html?clip='")
  })

  it('origin 末尾的斜杠不会拼出双斜杠', () => {
    expect(buildBookmarklet('http://127.0.0.1:8000/')).toBe(bm)
    expect(buildBookmarklet('http://127.0.0.1:8000///')).toBe(bm)
  })

  it('带上固定的小窗尺寸（剪藏结果就地显示，3 秒后自关）', () => {
    expect(bm).toContain("'width=520,height=240'")
  })
})
