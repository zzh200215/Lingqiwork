import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import CommandPalette from './CommandPalette'

// 命令面板的 smoke：开合、过滤、空态。api 全 mock——面板自己的数据拉取不该连累断言。
vi.mock('./api', () => ({
  api: {
    listConversations: vi.fn(() => Promise.resolve([])),
    listNotes: vi.fn(() => Promise.resolve({ files: [] })),
    workOutputs: vi.fn(() => Promise.resolve({ outputs: [] })),
    globalSearch: vi.fn(() => Promise.resolve([])),
  },
}))

import { api } from './api'

function mount(open = true) {
  return render(
    <MemoryRouter initialEntries={['/work?tab=deliver']}>
      <CommandPalette open={open} onClose={() => {}} />
    </MemoryRouter>
  )
}

describe('CommandPalette', () => {
  afterEach(cleanup)

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
})
