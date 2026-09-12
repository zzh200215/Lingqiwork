// 引用回填（§4-8）：正文里的 [n] 得能点回原材料，够不着的就不能假装能点。
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

import { linkCitations, Markdown, sourceHref, SourceList, type CiteSource } from './markdown'

afterEach(cleanup)

describe('sourceHref', () => {
  it('vault 相对路径 → 笔记页', () => {
    expect(sourceHref('notes/loop.md')).toBe('/notes?path=notes%2Floop.md')
    expect(sourceHref('clippings/foo.md')).toBe('/notes?path=clippings%2Ffoo.md')
  })

  it('网络来源 → 原样外链', () => {
    expect(sourceHref('https://example.com/a')).toBe('https://example.com/a')
    expect(sourceHref('http://example.com/a')).toBe('http://example.com/a')
  })

  it('vault 之外的块够不着 —— repos/ 与 dirs/ 前缀的源文件不住在 vault 里', () => {
    expect(sourceHref('repos/hello/src/a.py')).toBeNull()
    expect(sourceHref('dirs/桌面/笔记.md')).toBeNull()
  })

  it('没有落点、或看着像越界的路径，一律不给链接', () => {
    expect(sourceHref('')).toBeNull()
    expect(sourceHref('   ')).toBeNull()
    expect(sourceHref('/etc/passwd')).toBeNull()
    expect(sourceHref('notes/../../secret')).toBeNull()
  })
})

describe('linkCitations', () => {
  it('把 [n] 变成 sentinel 链接', () => {
    expect(linkCitations('看这里 [1] 就对了')).toBe('看这里 [\\[1\\]](#wb-cite-1) 就对了')
  })

  it('已有的 markdown 链接不动 —— [1](url) 是链接不是引用', () => {
    expect(linkCitations('见 [1](https://x.com)')).toBe('见 [1](https://x.com)')
  })

  it('代码围栏里的 [n] 不动 —— 那是代码不是引用', () => {
    const md = '正文 [1]\n```\narr[1] = 2\n```\n尾 [2]'
    expect(linkCitations(md)).toBe('正文 [\\[1\\]](#wb-cite-1)\n```\narr[1] = 2\n```\n尾 [\\[2\\]](#wb-cite-2)')
  })
})

const SOURCES: CiteSource[] = [
  { n: 1, kind: 'kb', title: '事件循环', ref: 'notes/loop.md' },
  { n: 2, kind: 'kb', title: '源码', ref: 'repos/hello/src/a.py' },
]

describe('Markdown 的引用角标', () => {
  it('够得着的 [n] 渲染成指向笔记页的链接', () => {
    render(<Markdown sources={SOURCES}>{'据此 [1] 可见'}</Markdown>)
    const link = screen.getByRole('link', { name: '[1]' })
    expect(link.getAttribute('href')).toBe('/notes?path=notes%2Floop.md')
    expect(link.getAttribute('target')).toBe('_blank') // 不销毁正在读的这份产出
  })

  it('够不着的 [n] 是不可点的角标，但有来源说明', () => {
    render(<Markdown sources={SOURCES}>{'据此 [2] 可见'}</Markdown>)
    expect(screen.queryByRole('link', { name: '[2]' })).toBeNull()
    expect(screen.getByText('[2]').getAttribute('title')).toContain('repos/hello/src/a.py')
  })

  it('没给 sources 时 [n] 保持纯文本 —— 今日页等的渲染不受影响', () => {
    render(<Markdown>{'据此 [1] 可见'}</Markdown>)
    expect(screen.queryByRole('link', { name: '[1]' })).toBeNull()
    expect(screen.getByText(/据此 \[1\] 可见/)).toBeTruthy()
  })

  it('正文里真正的链接开新页，不被当引用吃掉', () => {
    render(<Markdown sources={SOURCES}>{'见 [文档](https://example.com)'}</Markdown>)
    const link = screen.getByRole('link', { name: '文档' })
    expect(link.getAttribute('href')).toBe('https://example.com')
  })
})

describe('SourceList', () => {
  it('够得着的条目是链接、够不着的不是，且只有正文引到的加粗', () => {
    const { container } = render(<SourceList sources={SOURCES} used={[1]} />)
    expect(screen.getByRole('link', { name: /事件循环/ }).getAttribute('href')).toBe(
      '/notes?path=notes%2Floop.md'
    )
    expect(screen.queryByRole('link', { name: /源码/ })).toBeNull()
    const bold = container.querySelector('.font-medium')
    expect(bold?.textContent).toContain('事件循环')
  })

  it('没有来源就不渲染这个板块', () => {
    const { container } = render(<SourceList sources={[]} />)
    expect(container.textContent).toBe('')
  })
})
