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
    // 引擎档那块「最近几次运行」走的批量接口（P2：8 次请求合成 1 次）。
    // 默认给空对象：没跑过的任务不在里面，界面就不摆那一块。
    recentTaskRuns: vi.fn().mockResolvedValue({}),
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
    // 2026-09-25（P2）：工作流清单每行也读它（`by_task`），所以下面几条用例会自己给一份。
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
// 「提示词」整页是 PromptLibrary（自己的测试文件钉它的行为），同上
vi.mock('./PromptLibrary', () => ({
  default: () => <div data-testid="prompt-stub">提示词</div>,
}))
import { api } from './api'
import { WORK_TAB_ALIAS, type WorkTab } from './routes'

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
    { id: 'weekly', label: '周报', long: true, custom: false },
    { id: 'email', label: '邮件短稿', long: false, custom: false },
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

/** `?tab=` 取**新域名或旧 key 都行**：这一页的调用点大多还用旧 key（`engine`/`lab`…），
 *  它们**正好在端到端地验证别名层**——「旧链接能打开新页面」这件事，
 *  光靠 `routes.test.ts` 钉那几个纯函数是不够的。
 *
 *  类型**从 `routes` 取**，不手写 union：2026-09-25 那次改名漏了这个手写列表，
 *  于是新增的 `workflow` 在测试里编译不过——而它本该跟着 `WorkTab` 自动生效。 */
function renderPage(opts: { tab?: WorkTab | keyof typeof WORK_TAB_ALIAS } = {}) {
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

describe('WorkPage · 域级取数（P2）', () => {
  it('工作流拉不到要说出来——收进 `workData` 之前它是 `.catch(() => {})`', async () => {
    // 原来是静默吞：拉不到就摆一个空列表，看起来像「你一条工作流都没建」。
    // 收进域 hook 之后纪律统一了——这一条钉住它别再退回去。
    vi.mocked(api.listTasks).mockRejectedValue(new Error('500: {"detail":"库锁着"}'))
    renderPage({ tab: 'engine' })

    const bar = await screen.findByText(/工作流拉不出来/)
    expect(bar.textContent).toContain('库锁着')
  })

  it('会议拉不到也说出来', async () => {
    vi.mocked(api.workMeetings).mockRejectedValue(new Error('500: boom'))
    renderPage({ tab: 'engine' })
    expect(await screen.findByText(/会议拉不出来/)).toBeTruthy()
  })
})

describe('WorkPage · 最近几次运行（P2）', () => {
  it('走**一次**批量请求，不是每条任务各来一次', async () => {
    // 这一条防的是**退化**：批量接口的价值全在「一次」上，
    // 改回逐条 `listTaskRuns` 的话功能一模一样、测试全绿，只有请求数悄悄变回 8。
    renderPage({ tab: 'engine' })
    await waitFor(() => expect(api.recentTaskRuns).toHaveBeenCalled())
    expect(api.listTaskRuns).not.toHaveBeenCalled()
  })

  it('只问前 8 条任务——那块地方就摆得下 8 条', async () => {
    renderPage({ tab: 'engine' })
    await waitFor(() => expect(api.recentTaskRuns).toHaveBeenCalled())
    const ids = vi.mocked(api.recentTaskRuns).mock.calls[0][0]
    expect(ids.length).toBeLessThanOrEqual(8)
  })
})

describe('WorkPage · 失败不再静默（P0）', () => {
  it('重跑失败要说出来——原来是空 catch，点了什么都没发生', async () => {
    vi.mocked(api.runTask).mockRejectedValue(new Error('503: {"detail":"后端没起来"}'))
    renderPage({ tab: 'engine' })
    // 「重跑」在每条工作流上各有一颗，取第一颗就行——这里验的是失败会不会被吞
    fireEvent.click((await screen.findAllByText('重跑'))[0])

    const bar = await screen.findByText(/重跑没起来/)
    expect(bar.textContent).toContain('后端没起来')
  })

  it('错误条**不按 tab 门控**：在非「产出」档触发的失败也浮现出来', async () => {
    // 原来渲染那一行被 `tab === 'output' &&` 门控着，于是引擎档里 setErr 写进去
    // 却永远不显示；切回产出档还会突然弹一条陈旧错误。
    vi.mocked(api.runTask).mockRejectedValue(new Error('boom'))
    renderPage({ tab: 'engine' })
    fireEvent.click((await screen.findAllByText('重跑'))[0])
    expect(await screen.findByText(/重跑没起来/)).toBeTruthy()
  })

  it('运行记录拉不到就说「拉不到」，不摆成「还没有运行记录」', async () => {
    // 这两句长得像，意思正相反：「拉不到」是**不知道**，「还没有」是**知道没有**。
    // 原来 `catch` 里只 `setRuns([])` 不吭声，于是后端挂了的时候，界面比谁都肯定地说
    // 「还没有运行记录」——用户据此以为这工作流从没跑过。展开那一栏走的是
    // `WorkflowRow` 里那颗任务名按钮（既有用例也是点它）。
    vi.mocked(api.listTaskRuns).mockRejectedValue(new Error('500: {"detail":"读不到运行目录"}'))
    renderPage({ tab: 'engine' })

    fireEvent.click((await screen.findAllByText('每日抓取'))[0])

    const bar = await screen.findByText(/运行记录拉不出来/)
    expect(bar.textContent).toContain('读不到运行目录')
    // 要害：它**没有**被讲成「没有运行记录」——「拉不到」是不知道，「还没有」是知道没有
    expect(screen.queryByText('还没有运行记录。')).toBeNull()
  })
})

describe('WorkPage · 可达性（P0）', () => {
  it('「改写成」和「挂到…」**常显**——原来是 hidden + group-hover:block，键盘和触屏都够不着', async () => {
    renderPage()
    await screen.findByText('asyncio 事件循环')

    const rewrite = screen.getAllByText('改写成')[0]
    // `display:none` 的元素不在 Tab 序列里，所以「有没有被 hidden 掉」正是要害
    expect(rewrite.className).not.toContain('hidden')
    expect(rewrite.className).toContain('opacity-60')
  })
})

describe('WorkPage · 产出', () => {
  it('把引擎的产出列出来，并给出每种的数量', async () => {
    renderPage()
    expect(await screen.findByText('asyncio 事件循环')).toBeTruthy()
    expect(screen.getByText('9 月 11 日')).toBeTruthy()
    expect(screen.getByText(/全部 2/)).toBeTruthy()
    expect(screen.getByText(/研究 1/)).toBeTruthy()
  })

  it('按分组筛掉别的——筛选是**分组**（研究/成文/工作流），不是每一种 kind 一个胶囊', async () => {
    renderPage()
    await screen.findByText('asyncio 事件循环')

    // 「成文」这一组管着交付/产出/方案/复盘/对质；这份夹具里落进去的是复盘那份
    fireEvent.click(screen.getByText(/成文 1/))
    expect(screen.queryByText('asyncio 事件循环')).toBeNull()
    expect(screen.getByText('9 月 11 日')).toBeTruthy()
  })

  it('一份报告都没有时给一句实话并给去处，而不是空白', async () => {
    vi.mocked(api.workOutputs).mockResolvedValue({ outputs: [] })
    renderPage()
    expect(await screen.findByText('还没有报告')).toBeTruthy()
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

  it('运行记录带这一趟的**耗时**（§8.3）；算不出来时那一格不摆，不编「0 秒」', async () => {
    // 夹具里 08:00:00 → 08:00:20
    renderPage({ tab: 'engine' })
    fireEvent.click((await screen.findAllByText('每日抓取'))[0])
    expect(await screen.findByText('20 秒')).toBeTruthy()

    // 还没结束的那一趟（`finished_at` 为空）不摆耗时——摆「0 秒」读起来像瞬间跑完
    vi.mocked(api.listTaskRuns).mockResolvedValue([{ ...RUN, finished_at: null }])
    cleanup()
    renderPage({ tab: 'engine' })
    fireEvent.click((await screen.findAllByText('每日抓取'))[0])
    await screen.findByText('接地 4/5')
    expect(screen.queryByText(/秒$/)).toBeNull()
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

  it('步骤条（§8.3）：运行记录上点「步骤 N」就地摊开每一步，再点收起', async () => {
    vi.mocked(api.listTaskRuns).mockResolvedValue([
      {
        ...RUN,
        log: [
          { step: '取材', ok: true, ms: 120, note: '3 条材料' },
          { step: '成文', ok: true, ms: 2400 },
          { step: '落盘', ok: true, ms: 5, ref: 'research/2026-09-25-x.md' },
        ],
      },
    ])
    renderPage({ tab: 'engine' })
    fireEvent.click((await screen.findAllByText('每日抓取'))[0])
    await screen.findByText('接地 4/5')

    // 默认收着（`skill_inject` 不算一步，所以这里正好 3 步）
    expect(screen.queryByText('取材')).toBeNull()
    fireEvent.click(screen.getByText('步骤 3'))

    expect(await screen.findByText('取材')).toBeTruthy()
    expect(screen.getByText('120 毫秒')).toBeTruthy()
    expect(screen.getByText('2.4 秒')).toBeTruthy()
    expect(screen.getByText('3 条材料')).toBeTruthy()

    fireEvent.click(screen.getByText('收起步骤'))
    expect(screen.queryByText('取材')).toBeNull()
  })

  it('一次没留下步骤：按钮上写「步骤 0」，摊开也是一句实话', async () => {
    vi.mocked(api.listTaskRuns).mockResolvedValue([RUN]) // log: []
    renderPage({ tab: 'engine' })
    fireEvent.click((await screen.findAllByText('每日抓取'))[0])
    await screen.findByText('接地 4/5')

    fireEvent.click(screen.getByText('步骤 0'))
    expect(await screen.findByText(/这次没留下步骤/)).toBeTruthy()
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
    // **只传 id**：不改参数的重跑与从前逐字一致
    await waitFor(() => expect(api.runTask).toHaveBeenCalledWith(1))
  })

  it('「改参数」重跑：把这次的题目带上去，**不改任务模板**（§8.3 第 5 条）', async () => {
    // 想换个说法再跑一次，原来只能去设置里改任务本身——那会动到以后每一次运行。
    vi.mocked(api.runTask).mockResolvedValue({ status: 'ok' } as TaskRunResult)
    renderPage({ tab: 'workflow' })
    await screen.findByText('每日抓取')

    fireEvent.click(screen.getAllByText('改参数')[0])
    const input = (await screen.findByPlaceholderText('这次跑什么？（只覆盖这一次）')) as HTMLInputElement
    // 预填任务自己的题目，改一改就行
    expect(input.value).toBe('跑 每日抓取')
    fireEvent.change(input, { target: { value: '只抓 HN 头版' } })
    fireEvent.click(screen.getByText('按这个跑'))

    await waitFor(() => expect(api.runTask).toHaveBeenCalledWith(1, '只抓 HN 头版'))
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

    // 置顶横幅与清单行都会有这一颗，所以判据用徽章本身；点哪一颗都调同一个 handler
    expect((await screen.findAllByText('等你放行')).length).toBeGreaterThan(0)
    fireEvent.click(screen.getAllByText('通过')[0])
    await waitFor(() => expect(api.approveRun).toHaveBeenCalledWith(9))
  })

  it('人工卡点：驳回调 rejectRun', async () => {
    vi.mocked(api.listTasks).mockResolvedValue([...TASKS, GATED])
    vi.mocked(api.rejectRun).mockResolvedValue({ ok: true, approved: false, next_task_id: null })
    renderPage({ tab: 'engine' })

    fireEvent.click((await screen.findAllByText('驳回'))[0])
    await waitFor(() => expect(api.rejectRun).toHaveBeenCalledWith(9))
  })
})

describe('WorkPage · 工作流页（P2 · §8.3）', () => {
  it('等你放行**置顶成一条横幅**，就地通过 / 驳回', async () => {
    // 「停在卡点上」是此刻唯一非做不可的事，摆在清单顶上就地放行，
    // 省掉「先去清单里找到那一行」。没有待放行时整块不出现（下面那条钉它）。
    vi.mocked(api.listTasks).mockResolvedValue([...TASKS, GATED])
    vi.mocked(api.approveRun).mockResolvedValue({ ok: true, approved: true, next_task_id: 2 })
    const { container } = renderPage({ tab: 'workflow' })

    await screen.findByText('等你放行')
    const banner = container.querySelector('[data-waiting-banner]') as HTMLElement
    expect(banner).toBeTruthy()
    expect(banner.textContent).toContain('1 步等你放行')
    expect(banner.textContent).toContain('人工审')

    // 就地放行走的是同一个 handler
    fireEvent.click(banner.querySelectorAll('button')[0])
    await waitFor(() => expect(api.approveRun).toHaveBeenCalledWith(9))
  })

  it('没有待放行时，那条横幅**一个字都不占**', async () => {
    renderPage({ tab: 'workflow' })
    await screen.findByText('每日抓取')
    expect(document.querySelector('[data-waiting-banner]')).toBeNull()
  })

  it('待放行的行**排到清单最前**', async () => {
    // 夹具里 TASKS 是「每日抓取 / 总结成稿」，GATED「人工审」在最后——
    // 待放行的话它必须冒到第一位，而不是让人翻到清单底部去找。
    vi.mocked(api.listTasks).mockResolvedValue([...TASKS, GATED])
    const { container } = renderPage({ tab: 'workflow' })

    // 名字**出现两次**：置顶横幅一次、清单行一次（这正是本轮的设计）。
    // 名字后面还跟着「卡点」两个字，所以用正则而不是精确匹配。
    await screen.findAllByText(/人工审/)
    const rows = [...container.querySelectorAll('li[id^="task-"]')]
    expect(rows[0].getAttribute('id')).toBe('task-3') // GATED 的 id
  })

  it('行内写「上次跑于何时、跑了多久」——耗时只活在运行记录上（§8.3 每行）', async () => {
    // 方案原话是「上次运行**+耗时**」。任务的 `last_run` 只有开始时刻，
    // 耗时得从那次运行上拿（批量只读接口，`useTaskCenter` 拉的）。
    vi.mocked(api.recentTaskRuns).mockResolvedValue({ '1': RUN })
    renderPage({ tab: 'workflow' })

    // 「每日抓取」现在会出现两处（清单行 + 折叠区里的「最近几次运行」），所以用 findAll
    await screen.findAllByText('每日抓取')
    // RUN 是 08:00:00 → 08:00:20
    expect(screen.getByText(/上次 09-12 08:00（20 秒）/)).toBeTruthy()
  })

  it('读不到那次运行就**不摆耗时**——不编一个「0 秒」出来', async () => {
    vi.mocked(api.recentTaskRuns).mockRejectedValue(new Error('500: 读不到'))
    renderPage({ tab: 'workflow' })

    await screen.findAllByText('每日抓取')
    expect(screen.getByText(/上次 09-12 08:00/)).toBeTruthy()
    expect(screen.queryByText(/（\d+ 秒）/)).toBeNull()
  })

  it('三块统计砖在**页头**，不在折叠区里（§8.3：EnginePulse 统计砖并入页头 stats）', async () => {    // 埋在折叠区里等于「每次都要先展开才看得见这台机器的状态」——而它们本来就是
    // 那一档最该先看到的东西。取数仍在 EnginePulse 里（唯一同时读那三个接口的地方），
    // 算好了报给页面；这条钉的是**画在哪**。
    vi.mocked(api.dashboard).mockResolvedValue({
      task_stats: { runs_30d: 11, ok: 10, error: 1, rate: 0.91, by_task: {} },
    } as never)
    const { container } = renderPage({ tab: 'workflow' })

    const tile = await screen.findByText('30 天成功率')
    const header = container.querySelector('header') as HTMLElement
    expect(header, '页头没了？').toBeTruthy()
    expect(header.contains(tile)).toBe(true)
    // 三个接口各自异步回来，值晚于砖本身——等它到位（挂载那一瞬不报空值，
    // 所以这里一定等得到真数，不会停在 — 上）
    await waitFor(() => expect(header.textContent).toContain('91%'))
    expect(header.textContent).toContain('11 次运行')

    // 折叠区里一块砖都不该剩（那两块只剩「最近几次运行」与「后台作业」）
    for (const d of container.querySelectorAll('details')) {
      expect(d.querySelector('[data-stat-tile]'), '折叠区里还有统计砖').toBeNull()
    }
  })

  it('每行摆自己的 30 天成绩；**没跑过的那条不摆**（0% 会把「没跑过」说成「全挂了」）', async () => {    vi.mocked(api.dashboard).mockResolvedValue({
      task_stats: {
        runs_30d: 10,
        ok: 9,
        error: 1,
        rate: 0.9,
        by_task: {
          // 只给「每日抓取」（id 1）——「总结成稿」（id 2）30 天内没跑过
          '1': { runs: 8, ok: 6, rate: 0.75 },
        },
      },
    } as never)
    renderPage({ tab: 'workflow' })

    await screen.findByText('每日抓取')
    expect(await screen.findByText(/30 天 75%/)).toBeTruthy()
    // 没成绩的那条不写「30 天」
    const rows = [...document.querySelectorAll('li[id^="task-"]')]
    const second = rows.find((r) => r.getAttribute('id') === 'task-2') as HTMLElement
    expect(second.textContent).not.toContain('30 天')
  })

  it('次要的两块**默认收起**：首屏只留「等你放行 + 起题目 + 清单」', async () => {
    // 方案 §8.3：运行视图与后台作业折到底部。用原生 <details>，所以「收着」就是真的
    // 没展开（不是视觉上藏起来）——键盘也能开。
    const { container } = renderPage({ tab: 'workflow' })
    await screen.findByText('每日抓取')

    const folds = [...container.querySelectorAll('details')]
    expect(folds.length).toBe(2)
    expect(folds.every((d) => !(d as HTMLDetailsElement).open)).toBe(true)
    // 查 `<summary>` 本身：纯文本查会撞上 EnginePulse 里那块也叫「后台作业」的统计砖
    const titles = folds.map((d) => d.querySelector('summary')?.textContent ?? '')
    expect(titles[0]).toContain('运行视图')
    expect(titles[1]).toContain('后台作业')
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

    fireEvent.click(await screen.findByText('起一个题目', { selector: '[data-open-work]' }))
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

    fireEvent.click(await screen.findByText('起一个题目', { selector: '[data-open-work]' }))
    fireEvent.change(screen.getByPlaceholderText('一句话题目（例：要不要上向量库选型）'), {
      target: { value: '要不要上向量库' },
    })
    fireEvent.click(screen.getByText('开始'))

    const back = await screen.findByRole('link', { name: '要不要上向量库' })
    expect(back.getAttribute('href')).toBe('/work?tab=thread&thread=3')
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

    fireEvent.click(await screen.findByText('起一个题目', { selector: '[data-open-work]' }))
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

    fireEvent.click(await screen.findByText('起一个题目', { selector: '[data-open-work]' }))
    fireEvent.change(screen.getByPlaceholderText('一句话题目（例：要不要上向量库选型）'), {
      target: { value: '要不要上向量库' },
    })
    fireEvent.click(screen.getByText('开始'))

    await waitFor(() => expect(api.runTask).toHaveBeenCalled())
    expect(screen.queryByText(/产物会挂到/)).toBeNull()
  })

  it('空题目不起链，只给一句提醒', async () => {
    renderPage({ tab: 'engine' })
    fireEvent.click(await screen.findByText('起一个题目', { selector: '[data-open-work]' }))
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

describe('WorkPage · 标签', () => {
  it('默认停在「报告」：清单看得见，「自动化」的内容不抢屏', async () => {
    renderPage()
    expect(await screen.findByText('asyncio 事件循环')).toBeTruthy()
    expect(screen.queryByText('每日抓取')).toBeNull()
  })

  it('「跟进」标签渲染「事」，产出清单退场', async () => {
    renderPage({ tab: 'follow' })
    expect(await screen.findByTestId('threads-stub')).toBeTruthy()
    expect(screen.queryByText('asyncio 事件循环')).toBeNull()
  })

  it('页头那句说明也按档换——不然它一个字都没说到眼前这屏', async () => {
    renderPage({ tab: 'prompt' })
    expect(await screen.findByText(/攒 → 试 → 量/)).toBeTruthy()
    // 「报告」那一档的主题句不该出现在提示词这档
    expect(screen.queryByText(/写一个交得出去的东西/)).toBeNull()
  })

  it('页头的主操作按档换：提示词这档不写着「写一份报告」', async () => {
    // 原来它在每一档都写着「写一份交付」，在提示词那档点下去会跳去产出——
    // **按钮说的和按钮做的对不上**，比少一个按钮更糟。
    renderPage({ tab: 'prompt' })
    expect(await screen.findByText('＋ 新建提示词')).toBeTruthy()
    expect(screen.queryByText('写一份报告')).toBeNull()
  })

  it('「评测」不再单独一档：旧 key `lab` 落到提示词页（方案 §一 5→4）', async () => {
    // 2026-09-25 定稿方案把「评测」并进了「提示词」——攒提示词、拿它对照、量它好不好
    // 本来就是一件事的三步。旧地址 `?tab=lab` 由别名层接住，落在同一页。
    renderPage({ tab: 'lab' })
    expect(await screen.findByTestId('prompt-stub')).toBeTruthy()
    expect(await screen.findByTestId('lab-stub')).toBeTruthy()
    expect(screen.queryByText('asyncio 事件循环')).toBeNull()
  })

  it('提示词页 = 库 + 对照台 + 技能草稿 + 数据形态（五区同页，方案 §8.2）', async () => {
    renderPage({ tab: 'prompt' })
    expect(await screen.findByTestId('prompt-stub')).toBeTruthy()
    // 原先挂在「评测」档下的三块，现在跟着提示词页走
    expect(await screen.findByTestId('lab-stub')).toBeTruthy()
    expect(screen.queryByText('asyncio 事件循环')).toBeNull()
  })

  it('五区有 sticky 锚点导航，且**每个锚点都真有落点**（§8.2）', async () => {
    // 「锚点指向一个不存在的 id」是最容易犯又最难发现的错：点了没反应，
    // 而页面上什么都不报。所以这条不只查导航在不在，还查每个 href 有对应元素。
    //
    // **「库」与「对打」的落点这一页查不到**：那两块的内容在 `PromptLibrary` 里
    // （对打要用它手上那份提示词清单），这一页把那个组件换成了 stub。它们的落点由
    // `PromptLibrary.test.tsx` 查——两边各查自己拥有的那部分，合起来是完整的五个。
    const { container } = renderPage({ tab: 'prompt' })
    await screen.findByTestId('prompt-stub')

    const nav = container.querySelector('[data-prompt-sections]') as HTMLElement
    expect(nav).toBeTruthy()
    const links = [...nav.querySelectorAll('a')]
    expect(links.map((a) => a.textContent)).toEqual(['库', '对打', '评测', '技能', '数据形态'])

    const mine = ['prompt-lib', 'prompt-eval', 'prompt-skill', 'prompt-form']
    for (const a of links) {
      const id = (a.getAttribute('href') ?? '').replace('#', '')
      if (!mine.includes(id)) continue
      expect(container.querySelector(`#${id}`), `锚点 #${id} 没有落点`).toBeTruthy()
    }
  })

  it('三区各带方案里那句标题与副标题（§8.2 区3/4/5）', async () => {
    // 那三块是**现成组件原样并入**的：它们自己有内容，但没有「这一区叫什么、干嘛的」。
    // 副标题照抄方案——它是「看标签名猜中页面内容」那条验收的一部分。
    //
    // **判据钉在区里的 h2 上，不钉 `getByText`**：导航胶囊里也有「评测」两个字，
    // 按文本查会同时命中两个（而那条导航本身由上面那条用例管）。
    const { container } = renderPage({ tab: 'prompt' })
    await screen.findByTestId('prompt-stub')

    for (const [id, title, sub] of [
      ['prompt-eval', '评测', '系统提示词的对照台——改了有没有变好，拿金标题量'],
      ['prompt-skill', '技能草稿', '把材料读成 SKILL.md 草稿，跑过对照才算数'],
      ['prompt-form', '数据形态', '金标题集的领域分布'],
    ]) {
      const sec = container.querySelector(`#${id}`) as HTMLElement
      expect(sec, `#${id} 没有落点`).toBeTruthy()
      expect(sec.querySelector('h2')?.textContent, `#${id} 的标题`).toBe(title)
      expect(sec.textContent, `#${id} 的副标题`).toContain(sub)
    }
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

    // 第 4 个参数是 AbortSignal（「不等了」用）——每次都不同，所以判形状
    await waitFor(() =>
      expect(api.makeCandidate).toHaveBeenCalledWith('notes/paper.md', '', false, expect.any(AbortSignal))
    )
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
    await waitFor(() =>
      expect(api.makeCandidate).toHaveBeenLastCalledWith('notes/paper.md', '', true, expect.any(AbortSignal))
    )
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
