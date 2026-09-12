// 工作页三件事：工作流（定义 / 上次跑到哪 / 失败原因 / 运行记录带接地分 / 重跑）、
// 已经生成出来的产出（能筛、能点开）、以及在页内「写一份交付」。
// 真数据要跑一次引擎才产生（跑一次既慢又烧钱），所以这里用固定数据把这层钉住。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

import WorkPage from './WorkPage'
import type {
  DeliverCatalogue,
  ScheduledTask,
  TaskRunItem,
  TaskRunResult,
  WorkOutput,
} from './api'

vi.mock('./api', () => ({
  api: {
    workOutputs: vi.fn(),
    deliverGenres: vi.fn(),
    deliverSave: vi.fn(),
    listTasks: vi.fn(),
    listTaskRuns: vi.fn(),
    runTask: vi.fn(),
    approveRun: vi.fn(),
    rejectRun: vi.fn(),
  },
}))
vi.mock('./stream', () => ({ streamDeliver: vi.fn() }))
import { api } from './api'
import { streamDeliver } from './stream'

const OUTPUTS: WorkOutput[] = [
  {
    kind: 'research',
    label: '研究',
    path: 'research/2026-09-12-asyncio.md',
    title: 'asyncio 事件循环',
    date: '2026-09-12',
    mtime: 300,
  },
  {
    kind: 'recap',
    label: '复盘',
    path: 'recap/2026-09-11.md',
    title: '9 月 11 日',
    date: '2026-09-11',
    mtime: 200,
  },
]

const CATALOGUE: DeliverCatalogue = {
  genres: [
    { id: 'weekly', label: '周报' },
    { id: 'email', label: '邮件短稿' },
  ],
  audiences: [
    { id: 'self', label: '自己' },
    { id: 'leader', label: '领导' },
  ],
  default_genre: 'weekly',
  default_audience: 'self',
}

function task(id: number, name: string, patch: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id,
    name,
    prompt: `跑 ${name}`,
    cron: '0 8 * * *',
    model_id: '',
    use_rag: true,
    tools_enabled: true,
    save_to_vault: true,
    enabled: true,
    mode: 'simple',
    tool_whitelist: '',
    max_rounds: 12,
    retry: 1,
    notify_on_error: true,
    trigger_kind: 'cron',
    watch_path: '',
    chain_next_id: null,
    require_approval: false,
    conversation_id: null,
    last_run: null,
    last_status: '',
    last_result: '',
    next_run: null,
    ...patch,
  }
}

const TASKS: ScheduledTask[] = [
  task(1, '每日抓取', {
    chain_next_id: 2,
    last_run: '2026-09-12T08:00:00',
    last_status: 'error',
    last_result: 'ConnectionError: 域名解析失败',
  }),
  task(2, '总结成稿', {
    cron: '30 9 * * *',
    last_run: '2026-09-12T08:05:00',
    last_status: 'ok',
  }),
]

const RUN: TaskRunItem = {
  id: 9,
  task_id: 1,
  trigger: 'cron',
  upstream_task_id: null,
  started_at: '2026-09-12T08:00:00',
  finished_at: '2026-09-12T08:00:20',
  status: 'ok',
  mode: 'simple',
  model_id: 'p/m',
  rounds: 1,
  tool_calls: 0,
  error: '',
  answer: '答案',
  grounded: 4,
  judge_reason: '每条都能在材料里找到依据',
  log: [],
}

/** 配了人工卡点、且正停在待审上的那一条。 */
const GATED = task(3, '人工审', {
  cron: '15 10 * * *',
  require_approval: true,
  awaiting_run_id: 9,
  last_run: '2026-09-12T10:15:00',
  last_status: 'ok',
})

function renderPage() {
  return render(
    <MemoryRouter>
      <WorkPage />
    </MemoryRouter>
  )
}

beforeEach(() => {
  vi.mocked(api.workOutputs).mockResolvedValue({ outputs: OUTPUTS })
  vi.mocked(api.deliverGenres).mockResolvedValue(CATALOGUE)
  vi.mocked(api.listTasks).mockResolvedValue(TASKS)
  vi.mocked(api.listTaskRuns).mockResolvedValue([RUN])
})

afterEach(cleanup)

describe('WorkPage · 产出', () => {
  it('把引擎的产出列出来，并给出每种的数量', async () => {
    renderPage()
    expect(await screen.findByText('asyncio 事件循环')).toBeTruthy()
    expect(screen.getByText('9 月 11 日')).toBeTruthy()
    expect(screen.getByText(/全部 2/)).toBeTruthy()
    expect(screen.getByText(/研究 1/)).toBeTruthy()
  })

  it('按种类筛掉别的', async () => {
    renderPage()
    await screen.findByText('asyncio 事件循环')

    fireEvent.click(screen.getByText(/复盘 1/))
    expect(screen.queryByText('asyncio 事件循环')).toBeNull()
    expect(screen.getByText('9 月 11 日')).toBeTruthy()
  })

  it('一个产出都没有时给一句实话，而不是空白', async () => {
    vi.mocked(api.workOutputs).mockResolvedValue({ outputs: [] })
    renderPage()
    expect(await screen.findByText('还没有产出。')).toBeTruthy()
  })
})

describe('WorkPage · 工作流', () => {
  it('定义、上次跑到哪、链下游、失败原因同屏', async () => {
    renderPage()
    expect(await screen.findByText('每日抓取')).toBeTruthy()
    expect(screen.getByText(/0 8 \* \* \*/)).toBeTruthy()
    expect(screen.getByText(/→ 总结成稿/)).toBeTruthy() // 任务链看得见
    expect(screen.getByText('ConnectionError: 域名解析失败')).toBeTruthy() // 不必再点一次
    expect(screen.getByText('总结成稿')).toBeTruthy()
  })

  it('展开一条看运行记录，接地分与判分理由都在', async () => {
    renderPage()
    fireEvent.click(await screen.findByText('每日抓取'))
    expect(await screen.findByText('接地 4/5')).toBeTruthy()
    expect(screen.getByText('接地 4/5').getAttribute('title')).toContain('材料里找到依据')
  })

  it('重跑调 runTask', async () => {
    vi.mocked(api.runTask).mockResolvedValue({ status: 'ok' } as TaskRunResult)
    renderPage()
    fireEvent.click((await screen.findAllByText('重跑'))[0])
    await waitFor(() => expect(api.runTask).toHaveBeenCalledWith(1))
  })

  it('没有工作流时指路设置页', async () => {
    vi.mocked(api.listTasks).mockResolvedValue([])
    renderPage()
    expect(await screen.findByText('还没有工作流。')).toBeTruthy()
  })

  it('人工卡点：停在待审的那一步，该做的是放行——不是重跑', async () => {
    vi.mocked(api.listTasks).mockResolvedValue([...TASKS, GATED])
    vi.mocked(api.approveRun).mockResolvedValue({ ok: true, approved: true, next_task_id: 2 })
    renderPage()

    expect(await screen.findByText('等你点头')).toBeTruthy()
    fireEvent.click(screen.getByText('通过'))
    await waitFor(() => expect(api.approveRun).toHaveBeenCalledWith(9))
  })

  it('人工卡点：驳回调 rejectRun', async () => {
    vi.mocked(api.listTasks).mockResolvedValue([...TASKS, GATED])
    vi.mocked(api.rejectRun).mockResolvedValue({ ok: true, approved: false, next_task_id: null })
    renderPage()

    fireEvent.click(await screen.findByText('驳回'))
    await waitFor(() => expect(api.rejectRun).toHaveBeenCalledWith(9))
  })
})

describe('WorkPage · 交付', () => {
  it('「写一份交付」摊开体裁与读者，默认选中后端给的那一组', async () => {
    renderPage()
    fireEvent.click(await screen.findByText('写一份交付'))
    expect(screen.getByText('周报')).toBeTruthy()
    expect(screen.getByText('邮件短稿')).toBeTruthy()
    expect(screen.getByText('领导')).toBeTruthy()
  })

  it('生成：按选中的体裁×读者出稿，草稿渲染出来后可存进 vault', async () => {
    vi.mocked(streamDeliver).mockResolvedValue({
      ok: true,
      report: {
        title: '第 37 周周报',
        sections: [{ heading: '本周进展', body: '做了 A [1]' }],
        used: [1],
        sources: [{ n: 1, kind: 'kb', title: 'A', ref: 'notes/a.md' }],
        model_id: 'm',
        prompt_sha: 'abc123',
        genre: 'weekly',
        audience: 'leader',
      },
    })
    renderPage()
    fireEvent.click(await screen.findByText('写一份交付'))
    fireEvent.click(screen.getByText('领导'))
    fireEvent.change(screen.getByPlaceholderText('写什么？（例：这周的 RAG 调研）'), {
      target: { value: '这周的 RAG' },
    })
    fireEvent.click(screen.getByText('生成'))

    expect(await screen.findByText('第 37 周周报')).toBeTruthy()
    expect(screen.getByText('存进 vault')).toBeTruthy()
    // 正文里的引用点得回原材料（§4-8）
    expect(screen.getByRole('link', { name: '[1]' }).getAttribute('href')).toBe(
      '/notes?path=notes%2Fa.md'
    )
    expect(streamDeliver).toHaveBeenCalledWith(
      '这周的 RAG',
      'weekly',
      'leader',
      expect.any(Function),
      expect.anything()
    )
  })
})
