import { describe, expect, it } from 'vitest'

import { NAV, navState, legacyTarget, parseRoute, resolveWorkTab } from './routes'

// ---------- 侧栏导航（2026-09-18 改版：平铺五区 → 可展开的分组）----------
//
// 这些断言盯的是「**侧栏高亮的地方，就是页面真正打开的地方**」——两边各算一份的那天，
// 会出现「侧栏亮着引擎、页面停在产出」这种没人报错的错。

describe('navState', () => {
  it('没写参数 → 这一组的第一个子项（与页面的默认值是同一个）', () => {
    expect(navState('/work', '')).toEqual({ group: 'work', href: '/work?tab=report' })
    expect(navState('/tutor', '')).toEqual({ group: 'tutor', href: '/tutor?tab=learn' })
    expect(navState('/companion', '')).toEqual({ group: 'companion', href: '/companion?tab=chat' })
    expect(navState('/settings', '')).toEqual({ group: 'settings', href: '/settings?section=general' })
  })

  it('写了参数 → 就是那一个子项', () => {
    expect(navState('/work', '?tab=dispatch').href).toBe('/work?tab=workflow')
    expect(navState('/tutor', '?tab=record').href).toBe('/tutor?tab=record')
    expect(navState('/settings', '?section=mcp').href).toBe('/settings?section=mcp')
  })

  it('工作流深链 `?task=7` 没写 tab → 落「工作流」（与工作页自己的默认一致）', () => {
    expect(navState('/work', '?task=7').href).toBe('/work?tab=workflow')
  })

  it('认不出的参数 → 退回第一个子项（页面也会退回默认，两边一致）', () => {
    expect(navState('/work', '?tab=nonsense').href).toBe('/work?tab=report')
    expect(navState('/settings', '?section=nope').href).toBe('/settings?section=general')
  })

  it('资产那一组的子项是**各自独立的页面**，按路径认', () => {
    expect(navState('/assets', '')).toEqual({ group: 'assets', href: '/assets' })
    expect(navState('/notes', '?path=notes/a.md')).toEqual({ group: 'assets', href: '/notes' })
    expect(navState('/kb', '').group).toBe('assets')
    expect(navState('/dashboard', '').href).toBe('/dashboard')
  })

  it('对话（/）现在有自己的分组（方向 7：入口显形）；真正没有分组的不亮任何一组', () => {
    expect(navState('/', '')).toEqual({ group: 'chat', href: '/' })
    expect(navState('/', '?conv=3')).toEqual({ group: 'chat', href: '/' })
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

  it('七个分组、按你定的顺序：对话 / 今日 / 学 / 工作 / 资产 / 零柒 / 设置', () => {
    expect(NAV.map((g) => g.key)).toEqual([
      'chat',
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
    // 工作页七档、零柒五档、学三档、设置七档、资产四项
    expect(NAV.find((g) => g.key === 'work')!.items).toHaveLength(4)
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

  it('/threads 整页搬进工作 · 事项，redirect 带上 query', () => {
    expect(legacyTarget('/threads', '', '')).toEqual({
      pathname: '/work',
      search: '?tab=thread',
      hash: '',
    })
    // 从「一件事」深链过来的 ?thread=3 不能丢
    expect(legacyTarget('/threads', '?thread=3', '')).toEqual({
      pathname: '/work',
      search: '?thread=3&tab=thread',
      hash: '',
    })
    // 新家的参数说了算：旧链接自带的 tab 不会盖掉 thread
    expect(legacyTarget('/threads', '?tab=output', '')).toEqual({
      pathname: '/work',
      search: '?tab=thread',
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

// ---------- P3：六个旧 tab key → 四个业务域 ----------
//
// 这一组守的是方案 §六 那条验收指标：**旧 `?tab=` 书签/深链存活率 100%**。
// 它和上面「整页搬家」（`/threads` 那种**路径**级重定向）不是一回事：
// `REDIRECTS` 只认路径，管不到查询参数——`?tab=` 这一层是新建的。

describe('P3 · 旧 tab key 的别名层', () => {
  it('四个新 key 原样认', () => {
    for (const k of ['report', 'prompt', 'workflow', 'thread'] as const) {
      expect(resolveWorkTab(k)).toBe(k)
    }
  })

  it('**两代旧 key 都认**：最早那六个技术构件名，以及 2026-09-24 那版五个业务域名', () => {
    // 最早那六个（用户看名字猜不出东西在哪，所以改了）
    expect(resolveWorkTab('output')).toBe('report')
    expect(resolveWorkTab('engine')).toBe('workflow')
    expect(resolveWorkTab('dispatch')).toBe('workflow') // 两个视角合成一域
    expect(resolveWorkTab('lab')).toBe('prompt')
    expect(resolveWorkTab('form')).toBe('prompt') // 同属评测族
    expect(resolveWorkTab('follow')).toBe('thread')
    // 2026-09-24 那五个（本轮把 deliver/automation/eval 改成了新名）
    expect(resolveWorkTab('deliver')).toBe('report')
    expect(resolveWorkTab('automation')).toBe('workflow')
    expect(resolveWorkTab('eval')).toBe('prompt')
    // 这三个上一版就是新名，没动过
    expect(resolveWorkTab('prompt')).toBe('prompt')
    expect(resolveWorkTab('thread')).toBe('thread')
  })

  it('不认识的就是不认识——不硬塞一个默认档', () => {
    expect(resolveWorkTab('nonsense')).toBeNull()
    expect(resolveWorkTab('')).toBeNull()
    expect(resolveWorkTab(null)).toBeNull()
  })

  it('`/work?tab=engine` 这种旧地址**在 URL 那一层就摆正**（地址栏自愈）', () => {
    expect(legacyTarget('/work', '?tab=engine', '')).toEqual({
      pathname: '/work',
      search: '?tab=workflow',
      hash: '',
    })
    // 别的参数一个都不能丢
    expect(legacyTarget('/work', '?tab=lab&prompt=FEYNMAN_PROMPT', '')).toEqual({
      pathname: '/work',
      search: '?tab=prompt&prompt=FEYNMAN_PROMPT',
      hash: '',
    })
  })

  it('已经是新 key 的 /work 地址**不动**——别每次进工作页都多一次跳转', () => {
    expect(legacyTarget('/work', '?tab=report', '')).toBeNull()
    expect(legacyTarget('/work', '?tab=prompt&prompt=X', '')).toBeNull()
    expect(legacyTarget('/work', '', '')).toBeNull()
    expect(legacyTarget('/work', '?task=7', '')).toBeNull() // 没有 tab，不关这一层的事
  })

  it('别名只认 `/work`——别的页面同名参数不该被它改', () => {
    expect(legacyTarget('/tutor', '?tab=engine', '')).toBeNull()
    expect(legacyTarget('/companion', '?tab=form', '')).toBeNull()
  })

  it('**侧栏与页面认同一个函数**：两代旧链接下侧栏都亮对', () => {
    // 各算一份的那天会出现「侧栏亮着 A、页面停在 B」，而且没人收到报错
    expect(navState('/work', '?tab=engine').href).toBe('/work?tab=workflow')
    expect(navState('/work', '?tab=automation').href).toBe('/work?tab=workflow')
    expect(navState('/work', '?tab=lab').href).toBe('/work?tab=prompt')
    expect(navState('/work', '?tab=eval').href).toBe('/work?tab=prompt')
    expect(navState('/work', '?tab=deliver').href).toBe('/work?tab=report')
    expect(navState('/work', '?tab=follow').href).toBe('/work?tab=thread')
    // 工作流深链没写 tab：落「工作流」（链在那儿）
    expect(navState('/work', '?task=7').href).toBe('/work?tab=workflow')
  })
})
