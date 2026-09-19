// 侧栏（2026-09-18 改版）：六个分组、可展开、当前那一组自动展开。
//
// 这一层以前没有测试——上一版是五个平铺的链接，测起来没什么可测的；改成分组之后
// 有三件事值得钉：**当前组自动展开**、**手动开合记得住**、**高亮跟着地址走**。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

import Layout from './Layout'

vi.mock('./api', () => ({ api: { visit: vi.fn() } }))
vi.mock('./PetWidget', () => ({ default: () => null }))
import { api } from './api'

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route element={<Layout />} path="*">
          <Route index element={<div>对话页</div>} />
          <Route path="work" element={<div>工作页</div>} />
          <Route path="settings" element={<div>设置页</div>} />
          <Route path="review" element={<div>今日页</div>} />
        </Route>
      </Routes>
    </MemoryRouter>
  )
}

/** 某一组下面的子项容器（收起来时它根本不在 DOM 里）。 */
function items(key: string) {
  return document.querySelector(`[data-nav-items="${key}"]`)
}

/** 侧栏那一列上出现的所有子项名字（顶栏面包屑不算——它不是导航）。 */
function navLabels(): string[] {
  return [...document.querySelectorAll('[data-nav-items] a')].map((a) =>
    (a.textContent || '').replace(/[^\u4e00-\u9fa5A-Za-z]/g, '')
  )
}

/** 顶栏面包屑的一段。 */
function crumb(which: 'module' | 'item') {
  return document.querySelector(`[data-crumb="${which}"]`)
}

beforeEach(() => {
  localStorage.clear()
  vi.mocked(api.visit).mockResolvedValue({ recorded: true, page: 'work', day: '2026-09-18' })
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve({ json: () => Promise.resolve([]) }))
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('侧栏 · 分组', () => {
  it('六个分组都在，顺序是你定的那个', () => {
    renderAt('/review')
    const keys = [...document.querySelectorAll('[data-nav-group]')].map((el) =>
      el.getAttribute('data-nav-group')
    )
    expect(keys).toEqual(['review', 'tutor', 'work', 'assets', 'companion', 'settings'])
  })

  it('当前所在的那一组自动展开，其余收着', () => {
    renderAt('/work')
    expect(items('work')).toBeTruthy()
    expect(items('tutor')).toBeNull()
    expect(items('companion')).toBeNull()
  })

  it('没有子功能的组不摆 chevron（今日就是一页）', () => {
    renderAt('/review')
    expect(document.querySelector('[data-nav-toggle="review"]')).toBeNull()
    expect(document.querySelector('[data-nav-toggle="work"]')).toBeTruthy()
  })

  it('点 chevron 能开合，而且**当前这一组也允许收起**', () => {
    renderAt('/work')
    expect(items('work')).toBeTruthy()
    fireEvent.click(document.querySelector('[data-nav-toggle="work"]') as HTMLElement)
    expect(items('work')).toBeNull()
    // 手动开过的记在 localStorage：切到别处再回来，它还是开着的
    fireEvent.click(document.querySelector('[data-nav-toggle="tutor"]') as HTMLElement)
    expect(items('tutor')).toBeTruthy()
    expect(JSON.parse(localStorage.getItem('nav-open') || '{}')).toMatchObject({ tutor: true })
  })

  it('上一次手动开过的组，下一次进站还是开着的', () => {
    localStorage.setItem('nav-open', JSON.stringify({ companion: true }))
    renderAt('/review')
    expect(items('companion')).toBeTruthy()
    expect(items('work')).toBeNull()
  })
})

describe('侧栏 · 高亮', () => {
  it('高亮跟着地址走：`?tab=` 决定亮哪一条', () => {
    renderAt('/work?tab=dispatch')
    const active = document.querySelector('[data-nav-item][data-nav-active="1"]')
    expect(active?.getAttribute('data-nav-item')).toBe('/work?tab=dispatch')
    expect(document.querySelector('[data-nav-group][data-nav-active="1"]')?.getAttribute('data-nav-group')).toBe('work')
  })

  it('没写参数时亮这一组的默认档（与页面默认同一个）', () => {
    renderAt('/work')
    expect(
      document.querySelector('[data-nav-item][data-nav-active="1"]')?.getAttribute('data-nav-item')
    ).toBe('/work?tab=output')
  })

  it('资产那一组里，/notes 这种独立页面也亮在它下面', () => {
    renderAt('/notes')
    expect(document.querySelector('[data-nav-group][data-nav-active="1"]')?.getAttribute('data-nav-group')).toBe('assets')
    expect(
      document.querySelector('[data-nav-item][data-nav-active="1"]')?.getAttribute('data-nav-item')
    ).toBe('/notes')
  })

  it('对话页不亮任何一组（它不在分组表里，入口是 logo 与「＋ 新对话」）', () => {
    renderAt('/')
    expect(document.querySelector('[data-nav-group][data-nav-active="1"]')).toBeNull()
  })

  it('五张脸的名字都在侧栏上（原先藏在陪伴页的标签条里）', () => {
    renderAt('/companion?tab=room')
    // **查侧栏那一列**：顶栏的面包屑也会写出当前那一档（「零柒 / 小屋」），
    // 用 `screen.getByText` 会同时命中两处——这里要验的是侧栏
    const nav = navLabels()
    for (const label of ['聊天', '教它', '成长', '小屋', '有声']) {
      expect(nav).toContain(label)
    }
  })

  it('设置那七项也在侧栏上（原先藏在设置页的左侧竖排里）', () => {
    renderAt('/settings?section=models')
    const nav = navLabels()
    for (const label of ['通用', '模型', '智能体', '自动化', '内容生成', '数据', 'MCP']) {
      expect(nav).toContain(label)
    }
    expect(
      document.querySelector('[data-nav-item][data-nav-active="1"]')?.getAttribute('data-nav-item')
    ).toBe('/settings?section=models')
  })
})

// ---------- 顶栏（2026-09-18 版面改版）----------
//
// 「你在哪」这一段从正文挪到了顶栏：原来每页各念一遍自己的名字，既重复又白占一行。

describe('顶栏 · 面包屑', () => {
  it('子页写成「模块 / 子页」', () => {
    renderAt('/work?tab=dispatch')
    expect(crumb('module')?.textContent).toBe('工作')
    expect(crumb('item')?.textContent).toBe('调度台')
  })

  it('没写参数时也说得出现在是哪一档（默认档），不写成「工作 / 工作」', () => {
    renderAt('/work')
    expect(crumb('module')?.textContent).toBe('工作')
    // 默认档是「产出」——面包屑照实写出来，比只写「工作」更有用
    expect(crumb('item')?.textContent).toBe('产出')
  })

  it('组名与子项同名时也只留一段（「学 / 学」）', () => {
    renderAt('/tutor?tab=learn')
    expect(crumb('module')?.textContent).toBe('学')
    expect(crumb('item')).toBeNull()
  })

  it('资产那一组里，/dashboard 这类独立页面也念得出名字', () => {
    renderAt('/dashboard')
    expect(crumb('module')?.textContent).toBe('资产')
    expect(crumb('item')?.textContent).toBe('仪表盘')
  })

  it('对话页不摆顶栏（它自带页头，再顶一条就重复了）', () => {
    renderAt('/')
    expect(document.querySelector('[data-crumb="module"]')).toBeNull()
  })
})
