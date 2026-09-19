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
  SkillCandidateResult,
  SkillCandidateRow,
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
    installVoicePreset: vi.fn(),
    deliverGenres: vi.fn(),
    deliverSave: vi.fn(),
    listTasks: vi.fn(),
    listTaskRuns: vi.fn(),
    runTask: vi.fn(),
    approveRun: vi.fn(),
    rejectRun: vi.fn(),
    searchMaterial: vi.fn(),
    listCandidates: vi.fn(),
    makeCandidate: vi.fn(),
    runSkillEval: vi.fn(),
    skillCases: vi.fn(),
    saveSkillCases: vi.fn(),
    skillTrials: vi.fn(),
    draftFromRun: vi.fn(),
    qualityFeedback: vi.fn(),
    // 引擎那一档的「这台机器现在什么状态」（2026-09-18 内容太少那一轮加的）。
    // 默认给空清单：裸 `vi.fn()` 返回 undefined，`.then` 会当场炸。
    healthJobs: vi.fn().mockResolvedValue({ jobs: [], keep_runs: 20 }),
    // 2026-09-19 引擎档顶部那排计数卡会读 30 天成功率（`/api/dashboard` 的
    // `task_stats`）——给 null，卡片摆「—」，不影响原有断言。
    dashboard: vi.fn().mockResolvedValue({ task_stats: null }),
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
// 实验室整页是 PromptLab（自己的测试文件钉它的行为），这里只验证标签挂上了
vi.mock('./PromptLab', () => ({
  default: () => <div data-testid="lab-stub">实验室</div>,
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
  thread_id: null,
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

function renderPage(opts: { tab?: 'engine' | 'follow' | 'lab' } = {}) {
  return render(
    <MemoryRouter initialEntries={[opts.tab ? `/work?tab=${opts.tab}` : '/work']}>
      <WorkPage />
    </MemoryRouter>
  )
}

/** 一份能力候选结果的默认形状（S2 的「读成技能」用它，各用例只覆盖关心的那几个字段）。 */
function candidate(over: Partial<SkillCandidateResult> = {}): SkillCandidateResult {
  return {
    ok: true,
    usable: false,
    name: '',
    description: '',
    instructions: '',
    reason: '',
    existing: [],
    source: 'run#9',
    model_id: 'p/m',
    written: false,
    already: '',
    run_id: 9,
    runs: [9],
    ...over,
  }
}

beforeEach(() => {
  vi.mocked(api.workOutputs).mockResolvedValue({ outputs: OUTPUTS })
  vi.mocked(api.workMeetings).mockResolvedValue({ meetings: [] })
  vi.mocked(api.deliverGenres).mockResolvedValue(CATALOGUE)
  vi.mocked(api.listTasks).mockResolvedValue(TASKS)
  vi.mocked(api.listTaskRuns).mockResolvedValue([RUN])
  // 「读成能力」那一栏一挂载就拉一次清单 —— 给个默认值，免得别的用例撞上 undefined
  vi.mocked(api.listCandidates).mockResolvedValue({
    skills: [],
    measured: false,
    checks: [],
    fixture_dir: '/tmp/evals',
    trial_window: 20,
  })
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
    expect((await screen.findAllByText('每日抓取')).length).toBeGreaterThan(0)
    expect(screen.getByText(/0 8 \* \* \*/)).toBeTruthy()
    expect(screen.getByText(/→ 总结成稿/)).toBeTruthy() // 任务链看得见
    expect(screen.getByText('ConnectionError: 域名解析失败')).toBeTruthy() // 不必再点一次
    // 链下游那个名字现在两处都有（工作流清单 + 引擎档的「最近几次运行」），取第一个即可
    expect(screen.getAllByText('总结成稿').length).toBeGreaterThan(0)
  })

  it('展开一条看运行记录，接地分与判分理由都在', async () => {
    renderPage({ tab: 'engine' })
    fireEvent.click((await screen.findAllByText('每日抓取'))[0])
    expect(await screen.findByText('接地 4/5')).toBeTruthy()
    expect(screen.getByText('接地 4/5').getAttribute('title')).toContain('材料里找到依据')
  })

  it('运行记录里看得见「本次注入」——吃了哪份工序是匹配出来的，不是人指的（S1）', async () => {
    vi.mocked(api.listTaskRuns).mockResolvedValue([
      {
        ...RUN,
        log: [
          {
            tool: 'skill_inject',
            args: { skills: ['给领导写汇报要结论先行'] },
            ok: true,
            result: '本次注入：给领导写汇报要结论先行',
          },
        ],
      },
    ])
    renderPage({ tab: 'engine' })
    fireEvent.click((await screen.findAllByText('每日抓取'))[0])
    expect(await screen.findByText('注入 给领导写汇报要结论先行')).toBeTruthy()
  })

  it('没注入的那一次不留痕：日志里没有这一项，界面上也不摆「注入：无」（S1）', async () => {
    vi.mocked(api.listTaskRuns).mockResolvedValue([RUN]) // log: []
    renderPage({ tab: 'engine' })
    fireEvent.click((await screen.findAllByText('每日抓取'))[0])
    await screen.findByText('接地 4/5')
    expect(screen.queryByText(/^注入 /)).toBeNull()
  })

  it('运行记录上「读成技能」：落了草稿就把「按哪几次运行判断的」一起说清（S2）', async () => {
    vi.mocked(api.draftFromRun).mockResolvedValue(
      candidate({
        usable: true,
        name: '给领导写汇报要结论先行',
        description: '要把工作结果汇报给领导时用',
        instructions: '# 结论先行\n\n1. 第一句就是结论。\n',
        written: true,
        path: 'skills/给领导写汇报要结论先行/SKILL.md',
        chars: 120,
        runs: [7, 8, 9],
        topic: '给领导汇报这次项目的结论',
      })
    )
    renderPage({ tab: 'engine' })
    fireEvent.click((await screen.findAllByText('每日抓取'))[0])
    fireEvent.click(await screen.findByText('读成技能 →'))

    const line = await screen.findByText(/落了草稿/)
    expect(line.textContent).toContain('给领导写汇报要结论先行')
    expect(line.textContent).toContain('按 3 次运行判断')
    expect(line.textContent).toContain('skills/给领导写汇报要结论先行/SKILL.md')
    expect(line.textContent).toContain('没基线不算能力')
    expect(api.draftFromRun).toHaveBeenCalledWith(9, false)
  })

  it('判不出工序就直说，不硬凑（S2）', async () => {
    vi.mocked(api.draftFromRun).mockResolvedValue(
      candidate({ usable: false, reason: '这次只是一份一次性的结果，没有可复用的工序' })
    )
    renderPage({ tab: 'engine' })
    fireEvent.click((await screen.findAllByText('每日抓取'))[0])
    fireEvent.click(await screen.findByText('读成技能 →'))

    expect(
      await screen.findByText('没出能力：这次只是一份一次性的结果，没有可复用的工序')
    ).toBeTruthy()
  })

  it('同名不覆盖：把决定交给人，覆盖要显式点（S2）', async () => {
    vi.mocked(api.draftFromRun)
      .mockResolvedValueOnce(candidate({ usable: true, written: false, already: '周报的写法', reason: '技能「周报的写法」已存在（可勾选覆盖）' }))
      .mockResolvedValueOnce(candidate({ usable: true, written: true, path: 'skills/周报的写法/SKILL.md' }))
    renderPage({ tab: 'engine' })
    fireEvent.click((await screen.findAllByText('每日抓取'))[0])
    fireEvent.click(await screen.findByText('读成技能 →'))

    fireEvent.click(await screen.findByText('覆盖已有的「周报的写法」'))
    await waitFor(() => expect(api.draftFromRun).toHaveBeenLastCalledWith(9, true))
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
    // 第三个参数是这件事的名字（M2：题目即「事」名，产物挂到它上面）
    await waitFor(() => expect(api.runTask).toHaveBeenCalledWith(7, '要不要上向量库', '要不要上向量库'))
  })

  it('产物挂到哪件事上当场说清，并给一个去处（M2）', async () => {
    vi.mocked(api.installWorkPreset).mockResolvedValue({
      created: 3,
      tasks: [task(7, '工作·调研', { action: 'research', require_approval: true })],
    })
    vi.mocked(api.runTask).mockResolvedValue({
      status: 'ok',
      thread_id: 3,
      thread: { id: 3, name: '要不要上向量库', created: true },
    } as TaskRunResult)
    renderPage({ tab: 'engine' })

    fireEvent.click(await screen.findByText('起一个题目'))
    fireEvent.change(screen.getByPlaceholderText('一句话题目（例：要不要上向量库选型）'), {
      target: { value: '要不要上向量库' },
    })
    fireEvent.click(screen.getByText('开始'))

    const back = await screen.findByRole('link', { name: '要不要上向量库' })
    expect(back.getAttribute('href')).toBe('/work?tab=follow&thread=3')
  })

  it('重用了同名的那件事时，也照实说（不是「新建」）', async () => {
    vi.mocked(api.installWorkPreset).mockResolvedValue({
      created: 0,
      tasks: [task(7, '工作·调研', { action: 'research', require_approval: true })],
    })
    vi.mocked(api.runTask).mockResolvedValue({
      status: 'ok',
      thread_id: 3,
      thread: { id: 3, name: '要不要上向量库', created: false },
    } as TaskRunResult)
    renderPage({ tab: 'engine' })

    fireEvent.click(await screen.findByText('起一个题目'))
    fireEvent.change(screen.getByPlaceholderText('一句话题目（例：要不要上向量库选型）'), {
      target: { value: '要不要上向量库' },
    })
    fireEvent.click(screen.getByText('开始'))

    expect(await screen.findByRole('link', { name: '要不要上向量库' })).toBeTruthy()
  })

  it('没挂上（后端没回这件事）就一个字都不多说', async () => {
    vi.mocked(api.installWorkPreset).mockResolvedValue({
      created: 3,
      tasks: [task(7, '工作·调研', { action: 'research', require_approval: true })],
    })
    vi.mocked(api.runTask).mockResolvedValue({ status: 'ok', thread_id: null } as TaskRunResult)
    renderPage({ tab: 'engine' })

    fireEvent.click(await screen.findByText('起一个题目'))
    fireEvent.change(screen.getByPlaceholderText('一句话题目（例：要不要上向量库选型）'), {
      target: { value: '要不要上向量库' },
    })
    fireEvent.click(screen.getByText('开始'))

    await waitFor(() => expect(api.runTask).toHaveBeenCalled())
    expect(screen.queryByText(/产物会挂到/)).toBeNull()
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

  // R2 · PLAN5 §3：语音进料是**另一条** preset（会议留原声往下走三步，这条只留文本）。
  // 这条测试盯的就是「两个按钮各接各的端点」——接错了图省事共用一个 handler，
  // 会出现「点语音备忘装出四步链」这种谁也想不明白的场面。
  it('工作流空态另有一个语音备忘入口，装的是它自己那条 preset', async () => {
    vi.mocked(api.listTasks).mockResolvedValue([])
    vi.mocked(api.installVoicePreset).mockResolvedValue({ created: 1, tasks: [] })
    renderPage({ tab: 'engine' })

    const btn = await screen.findByText('装一条语音备忘')
    fireEvent.click(btn)
    await waitFor(() => expect(api.installVoicePreset).toHaveBeenCalled())
    // 没顺手把会议那条也装了
    expect(api.installMeetingPreset).not.toHaveBeenCalled()
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

  it('预览里看得见「本次注入」，点 👍 时把注入清单一起带上（S1）', async () => {
    // 手动跑引擎**没有运行记录**，所以「吃到了什么」只能靠这一帧事件与这次反馈带上去
    vi.mocked(streamDeliver).mockImplementation(async (_t, _g, _a, onStage) => {
      onStage('skills', { skills: ['给领导写汇报要结论先行'], picked: [] })
      onStage('writing', {})
      return {
        ok: true,
        report: {
          title: '第 37 周周报',
          sections: [{ heading: '结论', body: '先说结论 [1]' }],
          used: [1],
          sources: [{ n: 1, kind: 'kb', title: 'A', ref: 'notes/a.md' }],
          model_id: 'm',
          prompt_sha: 'abc123',
          genre: 'weekly',
          audience: 'leader',
        },
      }
    })
    vi.mocked(api.qualityFeedback).mockResolvedValue({ id: 1, kind: 'deliver', verdict: 'good' })
    renderPage()
    fireEvent.click(await screen.findByText('写一份交付'))
    fireEvent.change(screen.getByPlaceholderText('写什么？（例：这周的 RAG 调研）'), {
      target: { value: '这周的 RAG' },
    })
    fireEvent.click(screen.getByText('生成'))

    const line = await screen.findByText(/本次注入：给领导写汇报要结论先行/)
    expect(line.textContent).toContain('按话题匹配出来的工序')

    fireEvent.click(screen.getByTitle('好'))
    await waitFor(() =>
      expect(api.qualityFeedback).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'deliver', injected: '["给领导写汇报要结论先行"]' })
      )
    )
  })

  it('没命中就不摆那一行，反馈也不带 injected（不知道 ≠ 没注入）（S1）', async () => {
    vi.mocked(streamDeliver).mockImplementation(async (_t, _g, _a, onStage) => {
      onStage('writing', {}) // 没有 skills 这一帧
      return {
        ok: true,
        report: {
          title: '第 37 周周报',
          sections: [{ heading: '结论', body: '先说结论' }],
          used: [],
          sources: [],
          model_id: 'm',
          prompt_sha: 'abc123',
          genre: 'weekly',
          audience: 'leader',
        },
      }
    })
    vi.mocked(api.qualityFeedback).mockResolvedValue({ id: 2, kind: 'deliver', verdict: 'good' })
    renderPage()
    fireEvent.click(await screen.findByText('写一份交付'))
    fireEvent.change(screen.getByPlaceholderText('写什么？（例：这周的 RAG 调研）'), {
      target: { value: '这周的 RAG' },
    })
    fireEvent.click(screen.getByText('生成'))
    await screen.findByText('第 37 周周报')

    expect(screen.queryByText(/本次注入/)).toBeNull()
    fireEvent.click(screen.getByTitle('好'))
    await waitFor(() => expect(api.qualityFeedback).toHaveBeenCalled())
    // 这一页说得出「确实没有」——所以带 `[]`，而不是不带（不带 = 不知道）
    expect(vi.mocked(api.qualityFeedback).mock.calls[0][0]).toMatchObject({ injected: '[]' })
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

  it('「实验室」标签渲染提示词对照台，产出清单退场（Q1 落在工作模块里）', async () => {
    renderPage({ tab: 'lab' })
    expect(await screen.findByTestId('lab-stub')).toBeTruthy()
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
    expect((await screen.findAllByText('每日抓取')).length).toBeGreaterThan(0)
    expect(screen.queryByText('asyncio 事件循环')).toBeNull()
  })
})

describe('WorkPage · 读成能力（环一）', () => {
  const draft = {
    ok: true,
    usable: true,
    name: '论文评测复现',
    description: '复现一篇论文的评测口径时用它',
    instructions: '1. 找出主表',
    reason: '材料里有一套可复现的评测工序',
    existing: [],
    source: 'notes/paper.md',
    model_id: 'p/m',
    written: true,
    already: '',
    path: 'skills/论文评测复现/SKILL.md',
    chars: 120,
    registered: false,
  }

  it('一份材料出一份草稿：说清落在哪，并说明它还不是「技能卡」', async () => {
    vi.mocked(api.listCandidates).mockResolvedValue({
    skills: [],
    measured: false,
    checks: [],
    fixture_dir: '/tmp/evals',
    trial_window: 20,
  })
    vi.mocked(api.makeCandidate).mockResolvedValue(draft)
    renderPage({ tab: 'lab' })

    fireEvent.change(await screen.findByPlaceholderText(/材料在哪/), {
      target: { value: 'notes/paper.md' },
    })
    fireEvent.click(screen.getByText('读一读'))

    await waitFor(() => expect(api.makeCandidate).toHaveBeenCalledWith('notes/paper.md', '', false))
    expect(await screen.findByText('论文评测复现')).toBeTruthy()
    // 「落盘 ≠ 登记」这条必须写在界面上，而不是只在代码注释里
    expect(screen.getByText(/这是\*\*草稿\*\*/)).toBeTruthy()
  })

  it('出不了能力就直说理由，不硬凑', async () => {
    vi.mocked(api.listCandidates).mockResolvedValue({
    skills: [],
    measured: false,
    checks: [],
    fixture_dir: '/tmp/evals',
    trial_window: 20,
  })
    vi.mocked(api.makeCandidate).mockResolvedValue({
      ...draft,
      usable: false,
      written: false,
      reason: '这份材料只是一组结论，没有可执行的工序',
    })
    renderPage({ tab: 'lab' })

    fireEvent.change(await screen.findByPlaceholderText(/或者直接粘一段材料/), {
      target: { value: '一堆结论' },
    })
    fireEvent.click(screen.getByText('读一读'))

    expect(await screen.findByText(/没有可执行的工序/)).toBeTruthy()
    expect(screen.queryByText(/落在/)).toBeNull()
  })

  it('同名不覆盖：停下并给一个显式的「覆盖」按钮', async () => {
    vi.mocked(api.listCandidates).mockResolvedValue({
    skills: [],
    measured: false,
    checks: [],
    fixture_dir: '/tmp/evals',
    trial_window: 20,
  })
    vi.mocked(api.makeCandidate).mockResolvedValue({
      ...draft,
      written: false,
      already: '论文评测复现',
      reason: "技能 '论文评测复现' 已存在（可勾选覆盖）",
    })
    renderPage({ tab: 'lab' })

    fireEvent.change(await screen.findByPlaceholderText(/材料在哪/), {
      target: { value: 'notes/paper.md' },
    })
    fireEvent.click(screen.getByText('读一读'))

    const force = await screen.findByText(/覆盖已有的/)
    fireEvent.click(force)
    await waitFor(() => expect(api.makeCandidate).toHaveBeenLastCalledWith('notes/paper.md', '', true))
  })

  it('没量过的技能如实说「还没量过」，不编分数', async () => {
    vi.mocked(api.listCandidates).mockResolvedValue({
      skills: [
        {
          name: '论文评测复现',
          description: '复现口径',
          files: 1,
          chars: 120,
          registered: false,
          cases: 0,
          stale: false,
          baseline: null,
          trials: { n: 0, last_at: null, last_ts: null },
        },
      ],
      measured: false,
      checks: [],
      fixture_dir: '/tmp/evals',
      trial_window: 20,
    })
    renderPage({ tab: 'lab' })

    expect(await screen.findByText(/都还没有基线/)).toBeTruthy()
    expect(screen.getByText('论文评测复现')).toBeTruthy()
    expect(screen.getByText(/还没量过/)).toBeTruthy()
  })

  it('写用例：尺子由人给，「它会收到什么」空着就不许存', async () => {
    vi.mocked(api.listCandidates).mockResolvedValue({
      skills: [
        {
          name: '论文评测复现',
          description: '复现口径',
          files: 1,
          chars: 120,
          registered: false,
          cases: 0,
          stale: false,
          baseline: null,
          trials: { n: 0, last_at: null, last_ts: null },
        },
      ],
      measured: false,
      checks: [],
      fixture_dir: '/tmp/evals',
      trial_window: 20,
    })
    vi.mocked(api.skillCases).mockResolvedValue({
      skill: '论文评测复现',
      cases: [],
      model_id: '',
      checks: [{ name: 'not_a_wall_of_text', why: '别糊成一堵墙' }],
      default_checks: ['not_a_wall_of_text'],
      file: '论文评测复现.json',
    })
    vi.mocked(api.saveSkillCases).mockResolvedValue({
      skill: '论文评测复现',
      cases: 1,
      file: '论文评测复现.json',
    })
    renderPage({ tab: 'lab' })

    fireEvent.click(await screen.findByText('写用例'))
    await waitFor(() => expect(api.skillCases).toHaveBeenCalledWith('论文评测复现'))
    // 空草稿时「存进金标集」是禁用的 —— 一条空用例等于没有尺子
    expect((screen.getByText('存进金标集') as HTMLButtonElement).disabled).toBe(true)

    fireEvent.change(screen.getByPlaceholderText(/它会收到什么/), {
      target: { value: '照着这篇论文复现它的评测口径' },
    })
    fireEvent.change(screen.getByPlaceholderText(/它当时应该怎样/), {
      target: { value: '按工序走，别自己另起一套' },
    })
    fireEvent.click(screen.getByText('存进金标集'))

    await waitFor(() =>
      expect(api.saveSkillCases).toHaveBeenCalledWith('论文评测复现', [
        {
          id: '',
          intent: '按工序走，别自己另起一套',
          ask: '照着这篇论文复现它的评测口径',
          checks: ['not_a_wall_of_text'],
        },
      ])
    )
    expect(await screen.findByText(/存好了：1 条/)).toBeTruthy()
  })

  it('断言可勾可取消，勾选状态跟着这条用例走', async () => {
    vi.mocked(api.listCandidates).mockResolvedValue({
      skills: [
        {
          name: '论文评测复现',
          description: '复现口径',
          files: 1,
          chars: 120,
          registered: false,
          cases: 0,
          stale: false,
          baseline: null,
          trials: { n: 0, last_at: null, last_ts: null },
        },
      ],
      measured: false,
      checks: [],
      fixture_dir: '/tmp/evals',
      trial_window: 20,
    })
    vi.mocked(api.skillCases).mockResolvedValue({
      skill: '论文评测复现',
      cases: [{ id: 'c1', intent: '按工序走', ask: '复现这篇论文', checks: ['not_a_wall_of_text'] }],
      model_id: '',
      checks: [{ name: 'not_a_wall_of_text', why: '别糊成一堵墙' }],
      default_checks: ['not_a_wall_of_text'],
      file: '论文评测复现.json',
    })
    vi.mocked(api.saveSkillCases).mockResolvedValue({
      skill: '论文评测复现',
      cases: 1,
      file: '论文评测复现.json',
    })
    renderPage({ tab: 'lab' })

    fireEvent.click(await screen.findByText('写用例'))
    const chip = await screen.findByText(/not_a_wall_of_text/)
    expect(chip.textContent?.startsWith('✓')).toBe(true)

    fireEvent.click(chip) // 取消勾选 → 这条用例不再限制字数
    fireEvent.click(screen.getByText('存进金标集'))
    await waitFor(() =>
      expect(api.saveSkillCases).toHaveBeenCalledWith('论文评测复现', [
        { id: 'c1', intent: '按工序走', ask: '复现这篇论文', checks: [] },
      ])
    )
  })
})

describe('WorkPage · 量一遍（技能包的成绩）', () => {
  function rowsWith(
    cases: number,
    registered: boolean,
    baseline: SkillCandidateRow['baseline'],
    trials: SkillCandidateRow['trials'] = { n: 0, last_at: null, last_ts: null }
  ) {
    return {
      skills: [
        {
          name: '论文评测复现',
          description: '复现口径',
          files: 1,
          chars: 120,
          registered,
          cases,
          stale: false,
          baseline,
          trials,
        },
      ],
      measured: registered,
      checks: [],
      fixture_dir: '/tmp/evals',
      trial_window: 20,
    }
  }

  it('量过的技能摊出成绩：过了几条 / 多过少过 / 跟着工序做几分', async () => {
    vi.mocked(api.listCandidates).mockResolvedValue(
      rowsWith(4, true, {
        at: '2026-09-16T10:00:00+08:00',
        model_id: 'p/m',
        cases: 4,
        with_passed: 3,
        rate: 0.75,
        ci_low: 0.4,
        ci_high: 0.93,
        helped: 2,
        hurt: 0,
        follows_method: 4,
        seconds: 20,
      })
    )
    renderPage({ tab: 'lab' })

    expect(await screen.findByText(/过了 3\/4/)).toBeTruthy()
    expect(screen.getByText(/有它多过 2 条 \/ 少过 0 条/)).toBeTruthy()
    expect(screen.getByText(/跟着工序做 4\/5/)).toBeTruthy()
  })

  it('「量一遍」把报告摊出来，并说清这次花了几次调用', async () => {
    vi.mocked(api.listCandidates).mockResolvedValue(rowsWith(4, false, null))
    vi.mocked(api.runSkillEval).mockResolvedValue({
      skill: '论文评测复现',
      sha: 'abc123',
      model_id: 'p/m',
      cases: [],
      total: 4,
      with_passed: 4,
      rate: 1,
      ci: [0.51, 1],
      tell: false,
      deltas: { helped: 3, hurt: 0, same: 1 },
      follows_method: 4.5,
      seconds: 33,
      calls: 12,
      cases_needed: 0,
    })
    renderPage({ tab: 'lab' })

    fireEvent.click(await screen.findByText('量一遍'))

    await waitFor(() => expect(api.runSkillEval).toHaveBeenCalledWith('论文评测复现'))
    expect(await screen.findByText(/跑了 12 次调用/)).toBeTruthy()
    // n 小就不许下结论 —— 这句话必须在界面上，而不是只在代码注释里
    expect(screen.getByText(/这个 n 下不了结论/)).toBeTruthy()
  })

  // ---------- S3 草稿试用期 ----------

  const TRIAL = {
    run_id: 12,
    task_id: 1,
    task_name: '每周产出',
    topic: '给领导汇报这次项目的结论',
    status: 'ok',
    started_at: '2026-09-15T06:00:00',
    at_ts: 1757916000,
    grounded: 4,
    skills: ['论文评测复现'],
    answer: '## 结论\n先说结论，再给两条支撑。',
  }

  it('草稿卡上那一行事实：**带窗口**，不写成「共 N 次」（S3）', async () => {
    vi.mocked(api.listCandidates).mockResolvedValue(
      rowsWith(0, false, null, { n: 3, last_at: TRIAL.started_at, last_ts: TRIAL.at_ts })
    )
    renderPage({ tab: 'lab' })

    const line = await screen.findByText(/被用过/)
    expect(line.textContent).toContain('最近 20 次运行内被用过')
    expect(line.textContent).toContain('3')
    expect(line.textContent).toContain('最近一次')
    expect(line.textContent).not.toContain('共 3 次')
  })

  it('没被用过的草稿，那一行根本不出现（只摆非零）（S3）', async () => {
    vi.mocked(api.listCandidates).mockResolvedValue(rowsWith(0, false, null))
    renderPage({ tab: 'lab' })

    await screen.findByText('量一遍')
    expect(screen.queryByText(/被用过/)).toBeNull()
    expect(screen.queryByText('看试用记录')).toBeNull()
  })

  it('展开试用记录：题目、产出、接地分都在，还能「把这次当用例」（S3）', async () => {
    vi.mocked(api.listCandidates).mockResolvedValue(
      rowsWith(0, false, null, { n: 1, last_at: TRIAL.started_at, last_ts: TRIAL.at_ts })
    )
    vi.mocked(api.skillTrials).mockResolvedValue({
      skill: '论文评测复现',
      window: 20,
      n: 1,
      last_at: TRIAL.started_at,
      last_ts: TRIAL.at_ts,
      trials: [TRIAL],
    })
    renderPage({ tab: 'lab' })
    fireEvent.click(await screen.findByText('看试用记录'))

    expect(await screen.findByText('给领导汇报这次项目的结论')).toBeTruthy()
    expect(screen.getByText(/运行 #12/)).toBeTruthy()
    expect(screen.getByText(/接地 4\/5/)).toBeTruthy()
    expect(screen.getByText(/先说结论，再给两条支撑/)).toBeTruthy()
    expect(api.skillTrials).toHaveBeenCalledWith('论文评测复现')
  })

  it('「把这次当用例」：预填 ask（那次的题目），**intent 留空给人写**（S3 的红线）', async () => {
    vi.mocked(api.listCandidates).mockResolvedValue(
      rowsWith(0, false, null, { n: 1, last_at: TRIAL.started_at, last_ts: TRIAL.at_ts })
    )
    vi.mocked(api.skillTrials).mockResolvedValue({
      skill: '论文评测复现',
      window: 20,
      n: 1,
      last_at: TRIAL.started_at,
      last_ts: TRIAL.at_ts,
      trials: [TRIAL],
    })
    vi.mocked(api.skillCases).mockResolvedValue({
      skill: '论文评测复现',
      cases: [],
      model_id: 'p/m',
      checks: [{ name: 'not_a_wall_of_text', why: '别写成一堵墙' }],
      default_checks: ['not_a_wall_of_text'],
      file: 'evals/skills/论文评测复现.json',
    })
    vi.mocked(api.saveSkillCases).mockResolvedValue({
      skill: '论文评测复现',
      cases: 1,
      file: 'evals/skills/论文评测复现.json',
    })
    renderPage({ tab: 'lab' })
    fireEvent.click(await screen.findByText('看试用记录'))
    fireEvent.click(await screen.findByText('把这次当用例'))

    // 题目填进了「它会收到什么」，而「它当时应该怎样」是空的（模型不出题）
    const ask = (await screen.findByPlaceholderText(/它会收到什么/)) as HTMLTextAreaElement
    const intent = screen.getByPlaceholderText('它当时应该怎样（一句话）') as HTMLInputElement
    expect(ask.value).toBe('给领导汇报这次项目的结论')
    expect(intent.value).toBe('')

    fireEvent.click(screen.getByText('存进金标集'))
    await waitFor(() =>
      expect(api.saveSkillCases).toHaveBeenCalledWith('论文评测复现', [
        { id: '', intent: '', ask: '给领导汇报这次项目的结论', checks: ['not_a_wall_of_text'] },
      ])
    )
  })
})
