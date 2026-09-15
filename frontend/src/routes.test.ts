import { describe, expect, it } from 'vitest'

import { legacyTarget, parseRoute } from './routes'

describe('parseRoute', () => {
  it('新路径直接认得', () => {
    expect(parseRoute('/')).toBe('chat')
    expect(parseRoute('/kb')).toBe('kb')
    expect(parseRoute('/tutor')).toBe('tutor')
    expect(parseRoute('/growth')).toBe('growth')
    expect(parseRoute('/review')).toBe('review')
  })

  it('尾斜杠无所谓', () => {
    expect(parseRoute('/kb/')).toBe('kb')
    expect(parseRoute('/kb///')).toBe('kb')
  })

  it('旧 .html 路径是别名，不是 404', () => {
    expect(parseRoute('/kb.html')).toBe('kb')
    expect(parseRoute('/tutor.html')).toBe('tutor')
    expect(parseRoute('/notes.html')).toBe('notes')
    expect(parseRoute('/review.html')).toBe('review')
    expect(parseRoute('/index.html')).toBe('chat')
  })

  it('不是路由就返回 null', () => {
    expect(parseRoute('/nope')).toBeNull()
    expect(parseRoute('/kb.json')).toBeNull()
    expect(parseRoute('')).toBe('chat') // 空路径当根
  })
})

describe('legacyTarget', () => {
  it('已经是新路径就不用跳', () => {
    expect(legacyTarget('/kb', '', '')).toBeNull()
    expect(legacyTarget('/', '?conv=3', '')).toBeNull()
  })

  it('旧路径映射到新路径', () => {
    expect(legacyTarget('/kb.html', '', '')).toEqual({ pathname: '/kb', search: '', hash: '' })
    expect(legacyTarget('/index.html', '', '')).toEqual({ pathname: '/', search: '', hash: '' })
  })

  // 整条改动里最该钉死的一条：存量书签小工具打开的是
  // `/kb.html?clip=<url>&title=<t>`，剪藏参数就在 search 里。
  // 只改路径、丢掉 query，等于把这条集成从「能用」变成「点了没反应」——
  // 而那些字符串存在用户浏览器里，我们改不了。
  it('跳转必须原样带上 search 和 hash', () => {
    expect(legacyTarget('/kb.html', '?clip=https%3A%2F%2Fx.com&title=T', '#aside=%2Fnotes')).toEqual({
      pathname: '/kb',
      search: '?clip=https%3A%2F%2Fx.com&title=T',
      hash: '#aside=%2Fnotes',
    })
  })

  it('认不出来的路径不跳，交给 * 那条路由', () => {
    expect(legacyTarget('/nope', '?x=1', '')).toBeNull()
  })
})

describe('P2 导航收缩', () => {
  it('/assets 是五区导航里的「资产」', () => {
    expect(parseRoute('/assets')).toBe('assets')
    expect(parseRoute('/assets.html')).toBe('assets')
  })

  it('/threads 整页搬进工作 · 跟进，redirect 带上 query', () => {
    expect(legacyTarget('/threads', '', '')).toEqual({
      pathname: '/work',
      search: '?tab=follow',
      hash: '',
    })
    // 从「一件事」深链过来的 ?thread=3 不能丢
    expect(legacyTarget('/threads', '?thread=3', '')).toEqual({
      pathname: '/work',
      search: '?thread=3&tab=follow',
      hash: '',
    })
    // 新家的参数说了算：旧链接自带的 tab 不会盖掉 follow
    expect(legacyTarget('/threads', '?tab=output', '')).toEqual({
      pathname: '/work',
      search: '?tab=follow',
      hash: '',
    })
  })

  it('没搬家的路径不 redirect——页面还在原址，书签照用', () => {
    expect(legacyTarget('/notes', '', '')).toBeNull()
    expect(legacyTarget('/kb', '?clip=x', '')).toBeNull()
    expect(legacyTarget('/dashboard', '', '')).toBeNull()
  })

  it('/growth 搬进陪伴页的成长标签', () => {
    expect(parseRoute('/companion')).toBe('companion')
    expect(legacyTarget('/growth', '', '')).toEqual({
      pathname: '/companion',
      search: '?tab=growth',
      hash: '',
    })
  })
})
