// 跨标签页同步:外观是全站设置,工作台常开着不止一个窗口——在一边换肤,
// 另一边也该跟着变,而不是等一次刷新才对齐。
//
// 钉的是 `ThemeProvider` 里那个 storage 监听的三条行为:
// ① 另一页改了 `wb:theme`,本页 config 跟着变;
// ② 另一页改了 `wb:skins`,本页皮肤表跟着长出来;
// ③ 本页收到之后**不回写**——传入的值本来就在 localStorage 里了,再 saveTheme
//    一遍是空转,还会在对面标签页再点着一次 storage 事件,两页你来我往乒乓。
//    (jsdom 模拟不了「对面」,③用「存储字节不变 + putTheme 没被调」来钉;
//    与之配套的第四条证明这个守卫**不吞真编辑**——本页自己点的改动照常落盘。)
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'

vi.mock('./api', () => ({
  api: {
    getTheme: vi.fn(),
    putTheme: vi.fn(),
  },
}))

import { api } from './api'
import { ThemeProvider, useTheme } from './ThemeProvider'
import { DEFAULT_THEME, SKINS_KEY, STORE_KEY, listSkins, loadUserSkins } from './theme'

/** 探针:把 config.skin、皮肤表张数、skinsRev 摆到界面上,顺带留一个改皮肤的口子。 */
function Probe({ capture }: { capture?: (setSkin: (id: string) => void) => void }) {
  const { config, setSkin, skinsRev } = useTheme()
  if (capture) capture(setSkin)
  return (
    <p>
      <span data-testid="skin">{config.skin}</span>
      <span data-testid="count">{listSkins().length}</span>
      <span data-testid="rev">{skinsRev}</span>
    </p>
  )
}

function renderProbe(capture?: (setSkin: (id: string) => void) => void) {
  return render(
    <ThemeProvider>
      <Probe capture={capture} />
    </ThemeProvider>,
  )
}

function jsonTheme(skin: string): string {
  return JSON.stringify({ ...DEFAULT_THEME, skin })
}

describe('跨标签页同步', () => {
  beforeEach(() => {
    vi.mocked(api.putTheme).mockClear()
    localStorage.clear()
    loadUserSkins()
  })
  afterEach(() => {
    cleanup()
    localStorage.clear()
    loadUserSkins()
  })

  it('另一页换了皮肤,本页不刷新也跟着换——而且不把收到的值回写一遍', () => {
    localStorage.setItem(STORE_KEY, jsonTheme('default'))
    renderProbe()
    expect(screen.getByTestId('skin').textContent).toBe('default')

    // 「另一个标签页」的动作:写存储,然后浏览器向其他页派发 storage 事件
    localStorage.setItem(STORE_KEY, jsonTheme('forest'))
    const storedBytes = localStorage.getItem(STORE_KEY)
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: STORE_KEY }))
    })

    expect(screen.getByTestId('skin').textContent).toBe('forest')
    // 不回写:存储字节原样(回写一遍是空转,还会在对面再点着一次事件)
    expect(localStorage.getItem(STORE_KEY)).toBe(storedBytes)
    expect(api.putTheme).not.toHaveBeenCalled()
  })

  it('另一页装了皮肤,本页的皮肤表跟着长出来', () => {
    localStorage.setItem(STORE_KEY, jsonTheme('default'))
    renderProbe()
    const base = listSkins().length
    expect(screen.getByTestId('count').textContent).toBe(String(base))

    localStorage.setItem(
      SKINS_KEY,
      JSON.stringify({ version: 1, skins: [{ id: 'sync-x', label: '同步', accent: '#3a7bc2' }] }),
    )
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: SKINS_KEY }))
    })

    expect(screen.getByTestId('count').textContent).toBe(String(base + 1))
  })

  it('另一页 clear() 了整个存储(key 为 null):主题与皮肤都各自重读一遍', () => {
    localStorage.setItem(STORE_KEY, jsonTheme('default'))
    renderProbe()
    const base = listSkins().length

    localStorage.setItem(STORE_KEY, jsonTheme('forest'))
    localStorage.setItem(
      SKINS_KEY,
      JSON.stringify({ version: 1, skins: [{ id: 'sync-y', label: '同步二', accent: '#3a7bc2' }] }),
    )
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: null }))
    })

    expect(screen.getByTestId('skin').textContent).toBe('forest')
    expect(screen.getByTestId('count').textContent).toBe(String(base + 1))
  })

  it('守卫不吞真编辑:本页自己点的改动照常落盘', () => {
    localStorage.setItem(STORE_KEY, jsonTheme('default'))
    let captured: ((id: string) => void) | null = null
    renderProbe((fn) => (captured = fn))

    act(() => {
      captured!('forest')
    })

    // 同步那半(saveTheme)当场就该发生——说明持久化路径没有被守卫挡住
    expect(JSON.parse(localStorage.getItem(STORE_KEY)!).skin).toBe('forest')
  })
})
