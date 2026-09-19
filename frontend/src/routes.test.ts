import { describe, expect, it } from 'vitest'

import { NAV, navState, legacyTarget, parseRoute } from './routes'

// ---------- 侧栏导航（2026-09-18 改版：平铺五区 → 可展开的分组）----------
//
// 这些断言盯的是「**侧栏高亮的地方，就是页面真正打开的地方**」——两边各算一份的那天，
// 会出现「侧栏亮着引擎、页面停在产出」这种没人报错的错。

describe('navState', () => {
  it('没写参数 → 这一组的第一个子项（与页面的默认值是同一个）', () => {
    expect(navState('/work', '')).toEqual({ group: 'work', href: '/work?tab=output' })
    expect(navState('/tutor', '')).toEqual({ group: 'tutor', href: '/tutor?tab=learn' })
    expect(navState('/companion', '')).toEqual({ group: 'companion', href: '/companion?tab=chat' })
    expect(navState('/settings', '')).toEqual({ group: 'settings', href: '/settings?section=general' })
  })

  it('写了参数 → 就是那一个子项', () => {
    expect(navState('/work', '?tab=dispatch').href).toBe('/work?tab=dispatch')
    expect(navState('/tutor', '?tab=record').href).toBe('/tutor?tab=record')
    expect(navState('/settings', '?section=mcp').href).toBe('/settings?section=mcp')
  })

  it('工作流深链 `?task=7` 没写 tab → 落「引擎」（与工作页自己的默认一致）', () => {
    expect(navState('/work', '?task=7').href).toBe('/work?tab=engine')
  })

  it('认不出的参数 → 退回第一个子项（页面也会退回默认，两边一致）', () => {
    expect(navState('/work', '?tab=nonsense').href).toBe('/work?tab=output')
    expect(navState('/settings', '?section=nope').href).toBe('/settings?section=general')
  })

  it('资产那一组的子项是**各自独立的页面**，按路径认', () => {
    expect(navState('/assets', '')).toEqual({ group: 'assets', href: '/assets' })
    expect(navState('/notes', '?path=notes/a.md')).toEqual({ group: 'assets', href: '/notes' })
    expect(navState('/kb', '').group).toBe('assets')
    expect(navState('/dashboard', '').href).toBe('/dashboard')
  })

  it('没有分组的页面（对话）不亮任何一组', () => {
    expect(navState('/', '')).toEqual({ group: '', href: '' })
    expect(navState('/nope', '')).toEqual({ group: '', href: '' })
  })
})

describe('NAV 这份表本身', () => {
  it('每一组都有地址；有子项的组，组地址就是第一个子项（点组名不会落到空处）', () => {
    for (const g of NAV) {
      expect(g.href).toBeTruthy()
      expect(g.label).toBeTruthy()
      if (g.items.length) expect(g.href).toBe(g.items[0].href)
    }
  })

  it('六个分组、按你定的顺序：今日 / 学 / 工作 / 资产 / 零柒 / 设置', () => {
    expect(NAV.map((g) => g.key)).toEqual([
      'review',
      'tutor',
      'work',
      'assets',
      'companion',
      'settings',
    ])
  })

  it('页面里的每一档都在这张表上（子项地址不重复）', () => {
    const hrefs = NAV.flatMap((g) => g.items.map((i) => i.href))
    expect(new Set(hrefs).size).toBe(hrefs.length)
    // 工作页六档、零柒五档、学三档、设置七档、资产四项
    expect(NAV.find((g) => g.key === 'work')!.items).toHaveLength(6)
    expect(NAV.find((g) => g.key === 'companion')!.items).toHaveLength(5)
    expect(NAV.find((g) => g.key === 'settings')!.items).toHaveLength(7)
  })
})

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
