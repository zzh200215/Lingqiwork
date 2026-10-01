import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import CommandPalette from './CommandPalette'
import { ThemeProvider } from './ThemeProvider'
import { loadTheme } from './theme'

// 命令面板的 smoke：开合、过滤、空态。api 全 mock——面板自己的数据拉取不该连累断言。
vi.mock('./api', () => ({
  api: {
    listConversations: vi.fn(() => Promise.resolve([])),
    listNotes: vi.fn(() => Promise.resolve({ files: [] })),
    workOutputs: vi.fn(() => Promise.resolve({ outputs: [] })),
    globalSearch: vi.fn(() => Promise.resolve([])),
    getTheme: vi.fn(() => Promise.resolve({ theme: null })),
    putTheme: vi.fn(() => Promise.resolve({ theme: null })),
  },
}))

import { api } from './api'

function mount(open = true) {
  return render(
    <ThemeProvider>
      <MemoryRouter initialEntries={['/work?tab=deliver']}>
        <CommandPalette open={open} onClose={() => {}} />
      </MemoryRouter>
    </ThemeProvider>
  )
}

describe('CommandPalette', () => {
  afterEach(() => {
    cleanup()
    localStorage.clear()
    document.documentElement.removeAttribute('style')
    document.documentElement.removeAttribute('data-wb-skin')
    document.documentElement.classList.remove('dark')
  })

  beforeEach(() => {
    vi.mocked(api.listConversations).mockClear()
    vi.mocked(api.listNotes).mockClear()
    vi.mocked(api.workOutputs).mockClear()
    vi.mocked(api.globalSearch).mockClear()
  })

  it('关闭时不渲染任何东西', () => {
    const { container } = mount(false)
    expect(container.querySelector('[data-cmd-dialog]')).toBeNull()
  })

  it('打开时拉取数据源并摆出页面直达', async () => {
    mount(true)
    await waitFor(() => expect(api.listConversations).toHaveBeenCalled())
    // NAV 里的「今日」组是一个页面直达项
    await waitFor(() => expect(screen.getByText('今日')).toBeTruthy())
  })

  it('输入无匹配的词给出空态，而不是白屏', async () => {
    mount(true)
    const input = await screen.findByPlaceholderText(/搜会话、笔记、产出物/)
    fireEvent.change(input, { target: { value: 'zzz不存在的词' } })
    await waitFor(() => expect(screen.getByText('没有匹配的结果')).toBeTruthy())
  })

  it('输入「仪表盘」能过滤出那一页的直达项', async () => {
    mount(true)
    const input = await screen.findByPlaceholderText(/搜会话、笔记、产出物/)
    fireEvent.change(input, { target: { value: '仪表盘' } })
    await waitFor(() => {
      const hit = document.querySelector('[data-cmd-item="/dashboard"]')
      expect(hit).toBeTruthy()
    })
  })

  // 换肤进面板（2026-10-01）：它是「一眼看结果」的动作，打两个字回车就换了，
  // 比「设置 → 外观 → 找那张卡」快一个数量级。**不是第二条真值**——它调的
  // 还是 ThemeProvider 那一份状态，所以这里断言的是 DOM 与 localStorage。
  it('打「森林」找得到林间皮肤，点一下当场换掉（不跳页）', async () => {
    mount(true)
    const input = await screen.findByPlaceholderText(/搜会话、笔记、产出物/)
    fireEvent.change(input, { target: { value: '青绿' } }) // 搜的是说明文字，不是皮肤名
    const item = await waitFor(() => {
      const el = document.querySelector('[data-cmd-item="/settings?section=appearance"]')
      expect(el).toBeTruthy()
      return el as HTMLElement
    })
    fireEvent.click(item)
    expect(loadTheme().skin).toBe('forest')
    expect(document.documentElement.dataset.wbSkin).toBe('forest')
  })

  it('打「暗色」能切到暗色模式', async () => {
    mount(true)
    const input = await screen.findByPlaceholderText(/搜会话、笔记、产出物/)
    fireEvent.change(input, { target: { value: '暗色模式' } })
    const item = await waitFor(() => {
      const el = document.querySelector('[data-cmd-item="/settings?section=appearance"]')
      expect(el).toBeTruthy()
      return el as HTMLElement
    })
    fireEvent.click(item)
    expect(loadTheme().mode).toBe('dark')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
  })
})
