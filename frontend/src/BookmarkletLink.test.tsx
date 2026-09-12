// 钉住 React 那一层。`capture.test.ts` 只测字符串，正是它漏掉了「React 19 把
// javascript: 的 href 换成 throw」这个 bug——所以这里必须真的渲染一次。
import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import BookmarkletLink from './BookmarkletLink'

function hrefOf(origin = 'http://127.0.0.1:8000') {
  const { container } = render(<BookmarkletLink origin={origin} />)
  return container.querySelector('a')!.getAttribute('href') || ''
}

describe('BookmarkletLink', () => {
  it('href 是真正的小工具，没被 React 的安全策略换成 throw', () => {
    const href = hrefOf()
    expect(href.startsWith('javascript:')).toBe(true)
    expect(href).not.toContain('React has blocked')
  })

  it('指向这个 origin 下的 /kb 路由 —— 拖到书签栏后点一下才回得来', () => {
    expect(hrefOf('http://192.168.1.5:8012')).toContain('http://192.168.1.5:8012/kb?clip=')
  })

  it('是 draggable 的（拖到书签栏是唯一的安装方式）', () => {
    const { container } = render(<BookmarkletLink origin="http://x" />)
    expect(container.querySelector('a')!.getAttribute('draggable')).toBe('true')
  })

  it('在页面里点它不会真执行（不然会剪藏工作台自己）', () => {
    const { container } = render(<BookmarkletLink origin="http://x" />)
    const a = container.querySelector('a')!
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true })
    a.dispatchEvent(ev)
    expect(ev.defaultPrevented).toBe(true)
  })
})
