// 资产页：产出速览 + 四个库的入口。真数据要跑过引擎才有，固定数据钉住结构。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

import AssetsPage from './AssetsPage'
import type { WorkOutput } from './api'

vi.mock('./api', () => ({
  api: {
    workOutputs: vi.fn(),
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
})

afterEach(cleanup)

describe('AssetsPage', () => {
  it('产出速览：最近几件点得开，全量清单指回工作页', async () => {
    renderPage()
    expect(await screen.findByText('第 37 周周报')).toBeTruthy()
    expect(screen.getByText(/全部 1 件/).getAttribute('href')).toBe('/work?tab=output')
  })

  it('四个库的入口都在：被撤出导航的页面从这里一定够得着', async () => {
    renderPage()
    for (const name of ['笔记', '知识库', '仪表盘', '成长']) {
      expect(screen.getByText(name).closest('a')?.getAttribute('href')).toBeTruthy()
    }
  })

  it('没有产出时给指路的空态，不是空白', async () => {
    vi.mocked(api.workOutputs).mockResolvedValue({ outputs: [] })
    renderPage()
    expect(await screen.findByText('还没有产出。')).toBeTruthy()
  })
})
