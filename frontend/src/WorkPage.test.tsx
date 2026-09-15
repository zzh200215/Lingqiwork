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
  WorkMeeting,
  WorkOutput,
} from './api'

vi.mock('./api', () => ({
  api: {
    workOutputs: vi.fn(),
    workMeetings: vi.fn(),
    audioUrl: (p: string) => `/api/work/audio?path=${encodeURIComponent(p)}`,
    installMeetingPreset: vi.fn(),
    installWorkPreset: vi.fn(),
    deliverGenres: vi.fn(),
    deliverSave: vi.fn(),
    listTasks: vi.fn(),
    listTaskRuns: vi.fn(),
    runTask: vi.fn(),
    approveRun: vi.fn(),
    rejectRun: vi.fn(),
    searchMaterial: vi.fn(),
  },
}))
vi.mock('./stream', () => ({ streamDeliver: vi.fn() }))
// 跟进标签整页就是 ThreadsPage（自己的测试文件钉它自己的行为），这里只验证标签切换
vi.mock('./ThreadsPage', () => ({
  default: ({ chromeless }: { chromeless?: boolean }) => (
    <div data-testid="threads-stub" data-chromeless={chromeless ? '1' : '0'}>
      事
    </div>
  ),
}))
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
    action: 'prompt',
    landing_dir: '',
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
  run_dir: '',
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

function renderPage(opts: { tab?: 'engine' | 'follow' } = {}) {
  return render(
    <MemoryRouter initialEntries={[opts.tab ? `/work?tab=${opts.tab}` : '/work']}>
      <WorkPage />
    </MemoryRouter>
  )
}

beforeEach(() => {
  vi.mocked(api.workOutputs).mockResolvedValue({ outputs: OUTPUTS })
  vi.mocked(api.workMeetings).mockResolvedValue({ meetings: [] })
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

  it('改写成：拿这件产出当钉住材料，开交付流换体裁重写（J4）', async () => {
    renderPage()
    await screen.findByText('asyncio 事件循环')

    // 悬停才出现的动作——直接点它
    fireEvent.click(screen.getAllByText('改写成')[0])

    // 交付流摊开，题目与钉住材料都带上了这件产出
    expect(await screen.findByText('周报')).toBeTruthy()
    const input = screen.getByPlaceholderText('写什么？（例：这周的 RAG 调研）') as HTMLInputElement
    expect(input.value).toContain('asyncio 事件循环')
    // 钉住的 chip 里就是这件产出（标题在产出行与 chip 各出现一次）
    expect(screen.getAllByText('asyncio 事件循环').length).toBeGreaterThanOrEqual(2)
  })
})

describe('WorkPage · 工作流', () => {
  it('定义、上次跑到哪、链下游、失败原因同屏', async () => {
    renderPage({ tab: 'engine' })
    expect(await screen.findByText('每日抓取')).toBeTruthy()
    expect(screen.getByText(/0 8 \* \* \*/)).toBeTruthy()
    expect(screen.getByText(/→ 总结成稿/)).toBeTruthy() // 任务链看得见
    expect(screen.getByText('ConnectionError: 域名解析失败')).toBeTruthy() // 不必再点一次
    expect(screen.getByText('总结成稿')).toBeTruthy()
  })

  it('展开一条看运行记录，接地分与判分理由都在', async () => {
    renderPage({ tab: 'engine' })
    fireEvent.click(await screen.findByText('每日抓取'))
    expect(await screen.findByText('接地 4/5')).toBeTruthy()
    expect(screen.getByText('接地 4/5').getAttribute('title')).toContain('材料里找到依据')
  })

  it('重跑调 runTask', async () => {
    vi.mocked(api.runTask).mockResolvedValue({ status: 'ok' } as TaskRunResult)
    renderPage({ tab: 'engine' })
    fireEvent.click((await screen.findAllByText('重跑'))[0])
    await waitFor(() => expect(api.runTask).toHaveBeenCalledWith(1))
  })

  it('没有工作流时指路设置页', async () => {
    vi.mocked(api.listTasks).mockResolvedValue([])
    renderPage({ tab: 'engine' })
    expect(await screen.findByText('还没有工作流。')).toBeTruthy()
  })

  it('人工卡点：停在待审的那一步，该做的是放行——不是重跑', async () => {
    vi.mocked(api.listTasks).mockResolvedValue([...TASKS, GATED])
    vi.mocked(api.approveRun).mockResolvedValue({ ok: true, approved: true, next_task_id: 2 })
    renderPage({ tab: 'engine' })

    expect(await screen.findByText('等你点头')).toBeTruthy()
    fireEvent.click(screen.getByText('通过'))
    await waitFor(() => expect(api.approveRun).toHaveBeenCalledWith(9))
  })

  it('人工卡点：驳回调 rejectRun', async () => {
    vi.mocked(api.listTasks).mockResolvedValue([...TASKS, GATED])
    vi.mocked(api.rejectRun).mockResolvedValue({ ok: true, approved: false, next_task_id: null })
    renderPage({ tab: 'engine' })

    fireEvent.click(await screen.findByText('驳回'))
    await waitFor(() => expect(api.rejectRun).toHaveBeenCalledWith(9))
  })
})

describe('WorkPage · 处理一项工作', () => {
  it('起一个题目：装好工作流、用题目跑第一步（topic 走运行期覆盖，不改模板）', async () => {
    vi.mocked(api.installWorkPreset).mockResolvedValue({
      created: 3,
      tasks: [task(7, '工作·调研', { action: 'research', require_approval: true })],
    })
    vi.mocked(api.runTask).mockResolvedValue({ status: 'ok' } as TaskRunResult)
    renderPage({ tab: 'engine' })

    fireEvent.click(await screen.findByText('起一个题目'))
    fireEvent.change(screen.getByPlaceholderText('一句话题目（例：要不要上向量库选型）'), {
      target: { value: '要不要上向量库' },
    })
    fireEvent.click(screen.getByText('开始'))

    await waitFor(() => expect(api.installWorkPreset).toHaveBeenCalled())
    await waitFor(() => expect(api.runTask).toHaveBeenCalledWith(7, '要不要上向量库'))
  })

  it('空题目不起链，只给一句提醒', async () => {
    renderPage({ tab: 'engine' })
    fireEvent.click(await screen.findByText('起一个题目'))
    fireEvent.click(screen.getByText('开始'))
    expect(await screen.findByText('先写一个题目。')).toBeTruthy()
    expect(api.installWorkPreset).not.toHaveBeenCalled()
  })
})

describe('WorkPage · 会议', () => {
  const MEETING: WorkMeeting = {
    name: '2026-09-10-周会',
    path: 'meetings/2026-09-10-周会',
    date: '2026-09-10',
    title: '第 37 周周会',
    mtime: 100,
    audio: 'meetings/2026-09-10-周会/audio.m4a',
    files: [
      { path: 'meetings/2026-09-10-周会/会议·纪要-2026-09-10-1030.md', title: '会议纪要' },
      { path: 'meetings/2026-09-10-周会/会议·待办-2026-09-10-1030.md', title: '待办' },
    ],
  }

  it('一场一行：标题、日期、原声回听、产物都在', async () => {
    vi.mocked(api.workMeetings).mockResolvedValue({ meetings: [MEETING] })
    const { container } = renderPage({ tab: 'engine' })

    expect(await screen.findByText('第 37 周周会')).toBeTruthy()
    expect(screen.getByText('09-10')).toBeTruthy()
    const player = container.querySelector('audio')
    expect(player?.getAttribute('src')).toContain('/api/work/audio?path=')
    // 产物点得开（不是平铺成四行，而是一场下面的几个入口）
    expect(screen.getByText('会议纪要')).toBeTruthy()
    expect(screen.getByText('待办')).toBeTruthy()
  })

  it('没有会议时不占地方', async () => {
    renderPage({ tab: 'engine' })
    await screen.findByText('还没有工作流。')
    expect(screen.queryByText('会议')).toBeNull()
  })

  it('工作流空态能一键装一条会议流程', async () => {
    vi.mocked(api.listTasks).mockResolvedValue([])
    vi.mocked(api.installMeetingPreset).mockResolvedValue({ created: 4, tasks: [] })
    renderPage({ tab: 'engine' })

    fireEvent.click(await screen.findByText('装一条会议流程'))
    await waitFor(() => expect(api.installMeetingPreset).toHaveBeenCalled())
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
      expect.anything(),
      []
    )
  })

  it('钉一条材料进这次产出：搜到、钉住，生成时带上它（§4-14）', async () => {
    vi.mocked(api.searchMaterial).mockResolvedValue({
      query: '事件循环',
      hits: [
        {
          source: 'notes/loop.md',
          spec: 'notes/loop.md',
          title: '事件循环笔记',
          chunk: 0,
          score: 0.8,
          text: '正文',
          cards: 0,
        },
      ],
    })
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
        audience: 'self',
      },
    })
    renderPage()
    fireEvent.click(await screen.findByText('写一份交付'))
    fireEvent.click(screen.getByText('＋ 钉一条材料'))
    fireEvent.change(screen.getByPlaceholderText('在你自己的材料里搜一条…'), {
      target: { value: '事件循环' },
    })
    fireEvent.click(screen.getByText('搜'))
    fireEvent.click(await screen.findByText('事件循环笔记'))

    // 钉住的材料显示成 chip —— 生成时随请求一起走
    expect(screen.getByText('事件循环笔记')).toBeTruthy()
    fireEvent.change(screen.getByPlaceholderText('写什么？（例：这周的 RAG 调研）'), {
      target: { value: '这周的 RAG' },
    })
    fireEvent.click(screen.getByText('生成'))
    await waitFor(() =>
      expect(streamDeliver).toHaveBeenCalledWith(
        '这周的 RAG',
        'weekly',
        'self',
        expect.any(Function),
        expect.anything(),
        ['notes/loop.md']
      )
    )
  })
})

describe('WorkPage · 标签', () => {
  it('默认停在「产出」：清单看得见，「引擎」的内容不抢屏', async () => {
    renderPage()
    expect(await screen.findByText('asyncio 事件循环')).toBeTruthy()
    expect(screen.queryByText('每日抓取')).toBeNull()
  })

  it('「跟进」标签渲染「事」，产出清单退场', async () => {
    renderPage({ tab: 'follow' })
    expect(await screen.findByTestId('threads-stub')).toBeTruthy()
    expect(screen.queryByText('asyncio 事件循环')).toBeNull()
  })

  it('跟进标签里的「事」是无头渲染——页头只有「工作」一个', async () => {
    renderPage({ tab: 'follow' })
    expect(screen.getByTestId('threads-stub').getAttribute('data-chromeless')).toBe('1')
  })

  it('工作流深链 ?task=7 没写 tab，落在「引擎」才对得上', async () => {
    // jsdom 没有 scrollIntoView；深链定位到元素就会调它
    Element.prototype.scrollIntoView = () => {}
    render(
      <MemoryRouter initialEntries={['/work?task=1']}>
        <WorkPage />
      </MemoryRouter>
    )
    expect(await screen.findByText('每日抓取')).toBeTruthy()
    expect(screen.queryByText('asyncio 事件循环')).toBeNull()
  })
})
