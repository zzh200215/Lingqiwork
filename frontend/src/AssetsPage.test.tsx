// 资产页：产出速览 + 四个库的入口。真数据要跑过引擎才有，固定数据钉住结构。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

import AssetsPage from './AssetsPage'
import type { WorkOutput } from './api'

vi.mock('./api', () => ({
  api: {
    workOutputs: vi.fn(),
    // 「家底 / 最近动过 / 技能」那三块（2026-09-18 内容太少那一轮加的）
    dashboard: vi.fn(),
    listNotes: vi.fn(),
    listSkills: vi.fn(),
    promptEvalBoard: vi.fn(),
  },
}))
import { api } from './api'

const OUTPUTS: WorkOutput[] = [
  {
    kind: 'deliver',
    label: '交付',
    path: 'deliver/2026-09-12-周报.md',
    title: '第 37 周周报',
    date: '2026-09-12',
    mtime: 300,
  },
]

function renderPage() {
  return render(
    <MemoryRouter>
      <AssetsPage />
    </MemoryRouter>
  )
}

beforeEach(() => {
  vi.mocked(api.workOutputs).mockResolvedValue({ outputs: OUTPUTS })
  // 「家底」三块：默认给一份真数据，别让它们因为 mock 缺方法而炸
  vi.mocked(api.dashboard).mockResolvedValue({
    vault_files: 13,
    memories: 0,
    open_days_7d: 3,
  } as never)
  vi.mocked(api.listNotes).mockResolvedValue({
    dir: 'vault',
    files: [
      { path: 'notes/a.md', mtime: 1789000000 },
      { path: 'research/b.md', mtime: 1788000000 },
    ],
  })
  vi.mocked(api.listSkills).mockResolvedValue({
    dir: 'skills',
    skills: [
      { name: '材料缺口分析', description: '先找缺什么', files: [], chars: 420 },
    ],
  })
  vi.mocked(api.promptEvalBoard).mockResolvedValue({
    readable: true,
    error: '',
    registered: 40,
    measured: 0,
    decidable: 0,
    stale: 0,
    cases: 0,
    rules: { registered: '', measured: '', decidable: '', stale: '' },
    bias: '',
  })
})

afterEach(cleanup)

describe('AssetsPage', () => {
  it('产出速览：最近几件点得开，全量清单指回工作页', async () => {
    renderPage()
    expect(await screen.findByText('第 37 周周报')).toBeTruthy()
    expect(screen.getByText(/全部 1 件/).getAttribute('href')).toBe('/work?tab=report')
  })

  it('家底：摆的是「有多少」，不是「还差多少」', async () => {
    const { container } = renderPage()
    await screen.findByText('第 37 周周报')
    const house = container.querySelector('[data-assets-house]')
    expect(house).toBeTruthy()
    // 六个数都摆出来了（读得到的那些）
    expect(house?.textContent).toContain('13') // vault 笔记
    expect(house?.textContent).toContain('1') // 产出物 1 件 / 技能 1 份
    expect(house?.textContent).toContain('40') // 登记的提示词
    expect(house?.textContent).toContain('3 天') // 这周打开过
    // 红线（§4-1）：不催、不设目标
    expect(house?.textContent).not.toMatch(/还差|还欠|加油|目标|达标/)
  })

  it('最近动过与技能两块都摆出来了', async () => {
    const { container } = renderPage()
    await screen.findByText('第 37 周周报')
    expect(container.querySelector('[data-assets-recent]')?.textContent).toContain('notes/a.md')
    expect(container.querySelector('[data-assets-skills]')?.textContent).toContain('材料缺口分析')
  })

  it('不再重复侧栏那几个库的入口卡——这一页只剩它自己独有的东西', async () => {
    const { container } = renderPage()
    await screen.findByText('第 37 周周报')
    // 2026-09-18 导航改版：笔记 / 知识库 / 仪表盘 / 成长 成了侧栏「资产」「零柒」
    // 两组里的子项，页面里再摆一遍就是同一件事两个入口（且两处都要同步高亮）。
    // 「家底」那几块砖**可以**带落点（那是「这个数在哪看」，不是又一份入口卡），
    // 所以这里查的是那张卡本身没了：标题与它那几句说明都不在。
    expect(container.textContent).not.toContain('库与记录')
    expect(container.textContent).not.toContain('建过索引的文档')
    expect(container.textContent).not.toContain('你和这件事的关系')
  })

  it('没有产出时给指路的空态，不是空白', async () => {
    vi.mocked(api.workOutputs).mockResolvedValue({ outputs: [] })
    renderPage()
    expect(await screen.findByText('还没有产出。')).toBeTruthy()
  })
})
