// @testing-library + vitest, jsdom environment (vite.config.ts). 前端此前零测试，
// 教学页是产品独有价值所在的地方，所以第一批判的是它：卡点召回条、取材来源行、
// 以及 SSE 流里 sources 事件的解析——这三个都是「页面能不能说实话」的关口。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

import {
  ConceptMerge,
  MaterialLine,
  pointCardBody,
  ReceiptLine,
  RecallChip,
  RepeatChip,
  shortSource,
} from './TutorPage'
import TutorPage from './TutorPage'
import { streamTutorSay, type TutorRecallHit } from './stream'
import type { TutorConceptRow, TutorStuckRow } from './api'

// 整页那两条（「又卡住」）要真渲染一次 TutorPage —— 只测 RepeatChip 证明不了它挂上去了。
// 挂载时它会问这几个接口，别的一律不碰。
vi.mock('./api', () => ({
  api: {
    tutorSessions: vi.fn(),
    tutorStats: vi.fn(),
    tutorMap: vi.fn(),
    tutorMastery: vi.fn(),
    tutorStuck: vi.fn(),
    tutorRecurring: vi.fn(),
    tutorStarters: vi.fn(),
    tutorStart: vi.fn(),
    tutorEnd: vi.fn(),
    tutorJudge: vi.fn(),
    interviewBank: vi.fn(),
    interviewReport: vi.fn(),
    // R3：会话结束那一行的「挂到…」（AttachToThread 自己会调这三个）
    suggestThreads: vi.fn(),
    attachThreadItem: vi.fn(),
    createThread: vi.fn(),
  },
}))
import { api } from './api'

describe('ReceiptLine', () => {
  afterEach(cleanup)
  // 学页三张成文卡跑完后的回执行：正文只活在 /notes 详情页，这一行负责指过去。
  it('存了才给链接，且指到 /notes 详情页', () => {
    render(
      <MemoryRouter>
        <ReceiptLine title="向量库选型" meta="来源 12 条" saved="research/2026-09-13-x.md" />
      </MemoryRouter>
    )
    const link = screen.getByText('向量库选型').closest('a')
    expect(link?.getAttribute('href')).toBe(
      '/notes?path=' + encodeURIComponent('research/2026-09-13-x.md')
    )
    expect(screen.getByText(/已存入/)).toBeTruthy()
  })

  it('没存时不给链接 —— 产物还不存在，别指一个空地址', () => {
    render(
      <MemoryRouter>
        <ReceiptLine title="向量库选型" meta="来源 12 条" saved="" />
      </MemoryRouter>
    )
    expect(screen.getByText('向量库选型').closest('a')).toBeNull()
    expect(screen.getByText('来源 12 条')).toBeTruthy()
  })
})

describe('shortSource', () => {
  it('取路径尾部两段 —— chroma 的 title 只是文件名去后缀，认不出位置', () => {
    expect(shortSource('repos/hello-generic-agent/docs/part1/chapter3/index.md')).toBe(
      'chapter3/index.md'
    )
    expect(shortSource('clippings/fastapi.tiangolo.com-1d9476.md')).toBe(
      'clippings/fastapi.tiangolo.com-1d9476.md'
    )
    expect(shortSource('top.md')).toBe('top.md')
  })
})

describe('RecallChip', () => {
  it('把卡点原样亮出来 —— 验收要判断「触发得对」，藏着掖着就没了判断依据', () => {
    const hits: TutorRecallHit[] = [
      {
        concept: 'asyncio 事件循环',
        verdict: 'half',
        stuck: '以为 await 交给了操作系统',
        date: '08-21',
        score: 0.71,
      },
    ]
    render(<RecallChip hits={hits} />)
    expect(screen.getByText('接上了以前的记录')).toBeTruthy()
    expect(screen.getByText(/asyncio 事件循环/)).toBeTruthy()
    expect(screen.getByText(/半懂/)).toBeTruthy()
    expect(screen.getByText(/以为 await 交给了操作系统/)).toBeTruthy()
  })

  it('没有命中就不渲染这个板块', () => {
    const { container } = render(<RecallChip hits={[]} />)
    expect(container.textContent).toBe('')
  })
})

describe('MaterialLine', () => {  it('来源用短路径，且多个 chip 各自独立', () => {
    const { container } = render(
      <MaterialLine
        sources={[
          { source: 'repos/ga/docs/part1/chapter3/index.md', title: 'index', score: 0.5 },
          { source: 'notes/loop.md', title: 'loop', score: 0.4 },
        ]}
      />
    )
    expect(screen.getByText(/取材/)).toBeTruthy()
    expect(container.textContent).toContain('chapter3/index.md')
    expect(container.textContent).toContain('notes/loop.md')
  })
})

function sseResponse(frames: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder()
      for (const f of frames) controller.enqueue(enc.encode(f))
      controller.close()
    },
  })
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}

describe('streamTutorSay', () => {
  it('解析 sources 事件 —— 后端新加的取材事件不能在页面上哑掉', async () => {
    const frames = [
      'event: sources\ndata: {"sources":[{"source":"notes/loop.md","title":"","score":0.7}]}\n\n',
      'event: delta\ndata: {"text":"讲"}\n\n',
      'event: done\ndata: {"model_id":"p/m","recalled":false}\n\n',
    ]
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse(frames)))
    const seen: unknown[] = []
    const done = await streamTutorSay(
      { session_id: 1, text: '问' },
      { onDelta: () => {}, onSources: (s) => seen.push(s) }
    )
    expect(done.ok).toBe(true)
    expect(seen).toEqual([[{ source: 'notes/loop.md', title: '', score: 0.7 }]])
  })

  it('流内 error 事件变成 ok:false —— SSE 一旦开了就没有状态码可设', async () => {
    const frames = ['event: error\ndata: {"message":"没有 provider"}\n\n']
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse(frames)))
    const done = await streamTutorSay(
      { session_id: 1, text: '问' },
      { onDelta: () => {} }
    )
    expect(done.ok).toBe(false)
    expect(done.error).toBe('没有 provider')
  })

  it('abort 信号转发给 fetch —— 中断传播的前端一半', async () => {
    const frames = [
      'event: delta\ndata: {"text":"讲"}\n\n',
      'event: done\ndata: {}\n\n',
    ]
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => { void init; return sseResponse(frames) })
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    await streamTutorSay(
      { session_id: 1, text: '问' },
      { onDelta: () => {} },
      controller.signal
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][1]?.signal).toBe(controller.signal)
  })
})

describe('pointCardBody', () => {
  it('有来源文件 → 用文件，把这一点作为 focus', () => {
    expect(pointCardBody('await 到底交给谁', { source: 'notes/x.md' }, '')).toEqual({
      source_path: 'notes/x.md',
      focus: 'await 到底交给谁',
      count: 3,
    })
  })

  it('粘贴模式 → 用当初粘进去的那段，**不是点标题**', () => {
    // 点标题只有十几个字，后端 MIN_INPUT_CHARS=80 会直接 400。
    // 这个坑是浏览器实测抓到的：单测之前只覆盖了后端提示词，没覆盖这段。
    const material = '材'.repeat(200)
    const body = pointCardBody('await 到底交给谁', { source: '' }, material) as {
      text: string
      focus: string
    }
    expect(body.text).toBe(material)
    expect(body.text).not.toBe('await 到底交给谁')
    expect(body.focus).toBe('await 到底交给谁')
  })

  it('没有 dg 时按粘贴模式处理，不炸', () => {
    const body = pointCardBody('某个点', null, '材料'.repeat(60))
    expect(body).toMatchObject({ focus: '某个点', count: 3 })
    expect(body).toHaveProperty('text')
  })
})

// Q3.5 · 概念归一的人工出口。
//
// 机器只在有量出来的余量的地方并（相似度 0.80）；同领域的相邻概念它**分不开**
// （实测比某些该并的还近）。所以这个交互是**指认**，测的是：折叠时不摆候选、
// 候选只来自已有概念、点了把方向传对（source→into）、并的时候按不动。
describe('ConceptMerge', () => {
  afterEach(cleanup)

  const OTHERS = ['SQLite WAL 模式', 'SQLite 锁机制', 'CPython GIL']

  it('折叠时只有一句「并到…」——判断不该挂在每一行上', () => {
    const { container } = render(
      <ConceptMerge concept="SQLite 库级锁" others={OTHERS} busy={false} onMerge={() => {}} />
    )
    expect(container.querySelector('[data-merge-open="SQLite 库级锁"]')).toBeTruthy()
    expect(container.querySelector('[data-merge-into]')).toBeNull()
  })

  it('展开后列出别的概念，点了就把「这一条」并到挑中的那个', () => {
    const onMerge = vi.fn()
    const { container } = render(
      <ConceptMerge concept="SQLite 库级锁" others={OTHERS} busy={false} onMerge={onMerge} />
    )
    fireEvent.click(container.querySelector('[data-merge-open]') as HTMLElement)

    // 候选里**没有它自己**
    expect(container.querySelector('[data-merge-into="SQLite 库级锁"]')).toBeNull()
    expect(screen.getByText('SQLite WAL 模式')).toBeTruthy()

    fireEvent.click(container.querySelector('[data-merge-into="SQLite 锁机制"]') as HTMLElement)
    // 方向：这一条是 source，挑中的那个是 into（留下来的名字是后者）
    expect(onMerge).toHaveBeenCalledWith('SQLite 库级锁', 'SQLite 锁机制')
  })

  it('能筛：概念多了以后不该让人在几十个名字里找', () => {
    const { container } = render(
      <ConceptMerge concept="SQLite 库级锁" others={OTHERS} busy={false} onMerge={() => {}} />
    )
    fireEvent.click(container.querySelector('[data-merge-open]') as HTMLElement)
    fireEvent.change(container.querySelector('[data-merge-q]') as HTMLInputElement, {
      target: { value: 'GIL' },
    })
    expect(container.querySelector('[data-merge-into="CPython GIL"]')).toBeTruthy()
    expect(container.querySelector('[data-merge-into="SQLite WAL 模式"]')).toBeNull()
  })

  it('并的时候按不动（重复点击不该并两遍）', () => {
    const { container } = render(
      <ConceptMerge concept="A" others={['B']} busy onMerge={() => {}} />
    )
    fireEvent.click(container.querySelector('[data-merge-open]') as HTMLElement)
    expect((container.querySelector('[data-merge-into="B"]') as HTMLButtonElement).disabled).toBe(true)
  })

  it('只有一条概念时说「没得挑」，不摆一个空列表', () => {
    const { container } = render(
      <ConceptMerge concept="唯一的一条" others={['唯一的一条']} busy={false} onMerge={() => {}} />
    )
    fireEvent.click(container.querySelector('[data-merge-open]') as HTMLElement)
    expect(screen.getByText(/没得挑/)).toBeTruthy()
  })
})

// 「又卡住」：界面上这个标与零柒那句「「X」这是第 2 次了」**必须是同一批**——
// 判据在后端一处（`tutor.is_recurring_mistake`），前端只画标，不重算。
describe('RepeatChip', () => {
  afterEach(cleanup)

  const HIT: TutorConceptRow = {
    concept: 'asyncio 事件循环',
    verdict: 'half',
    stuck: '以为 await 交给了操作系统',
    stuck_resolved: false,
    last_at: '2026-09-15T10:00:00+00:00',
    last_session_id: 3,
    sessions: 2,
    recalled: 2,
  }

  it('画一个标，title 里是**真数出来的**接住过几次', () => {
    const { container } = render(<RepeatChip c={HIT} />)
    const chip = container.querySelector('[data-concept-repeat="asyncio 事件循环"]')
    expect(chip?.textContent).toBe('又卡住')
    expect(chip?.getAttribute('title')).toContain('接住过你卡在哪 2 次')
    expect(chip?.getAttribute('title')).toContain('又卡住了')
  })

  it('不在那一批里就不画（传 null）', () => {
    const { container } = render(<RepeatChip c={null} />)
    expect(container.textContent).toBe('')
  })
})

/** 打开「记录」那一档（概念地图与卡点清单都在那儿）。
 *
 *  2026-09-18 导航改版：那一档**不再由页面里的标签条切**（标签条搬到侧栏了），
 *  改由地址 `?tab=record` 决定——所以这里直接落在那个地址上，
 *  与侧栏点进来走的是同一条路。**放在模块层**：两个 describe 都要用它。 */
async function openRecord() {
  const view = render(
    <MemoryRouter initialEntries={['/tutor?tab=record']}>
      <TutorPage />
    </MemoryRouter>
  )
  await screen.findByText('学到哪了')
  return view
}

describe('TutorPage · 又卡住的那几个', () => {
  const HIT: TutorConceptRow = {
    concept: 'asyncio 事件循环',
    verdict: 'half',
    stuck: '以为 await 交给了操作系统',
    stuck_resolved: false,
    last_at: '2026-09-15T10:00:00+00:00',
    last_session_id: 3,
    sessions: 2,
    recalled: 2,
  }
  const OTHER: TutorConceptRow = {
    concept: 'SQLite WAL 模式',
    verdict: 'half',
    stuck: '以为读会被写挡住',
    stuck_resolved: false,
    last_at: '2026-09-14T10:00:00+00:00',
    last_session_id: 4,
    sessions: 1,
    recalled: 0,
  }
  const stuckRow = (id: number, c: TutorConceptRow): TutorStuckRow => ({
    id,
    concept: c.concept,
    stuck: c.stuck,
    verdict: 'half',
    created_at: c.last_at,
    resolved_at: '',
  })

  beforeEach(() => {
    vi.mocked(api.tutorSessions).mockResolvedValue({ sessions: [] })
    vi.mocked(api.tutorStats).mockResolvedValue({
      days: 14,
      sessions: 3,
      got: 1,
      got_with_recall: 1,
      concepts: 2,
    })
    vi.mocked(api.tutorMap).mockResolvedValue({
      mastered: [],
      learning: [],
      stuck: [HIT, OTHER],
      untouched: [],
    })
    vi.mocked(api.tutorMastery).mockResolvedValue({
      events: [],
      mastered: 0,
      learning: 0,
      sessions: 0,
    })
    vi.mocked(api.tutorStuck).mockResolvedValue({
      stuck: [stuckRow(3, HIT), stuckRow(4, OTHER)],
    })
    vi.mocked(api.tutorRecurring).mockResolvedValue({ recurring: [HIT] })
    vi.mocked(api.tutorStarters).mockResolvedValue({ starters: [] })
  })

  afterEach(cleanup)

  it('只有「又卡住」的那条概念带标，别的概念不带', async () => {
    const { container } = await openRecord()
    // 地图那一行 + 待解卡点那一行，同一批概念两处都标（扫哪一列都不会看漏）
    const chips = [...container.querySelectorAll('[data-concept-repeat]')]
    expect(chips.map((el) => el.getAttribute('data-concept-repeat'))).toEqual([
      'asyncio 事件循环',
      'asyncio 事件循环',
    ])
    // 另一条照旧摆着（地图 + 卡点两处），只是没有那个标
    expect(screen.getAllByText('SQLite WAL 模式').length).toBeGreaterThan(0)
  })

  it('一个都没有时不摆空标，也不造一栏空的', async () => {
    vi.mocked(api.tutorRecurring).mockResolvedValue({ recurring: [] })
    const { container } = await openRecord()
    expect(container.querySelector('[data-concept-repeat]')).toBeNull()
    expect(screen.queryByText('又卡住')).toBeNull()
  })
})

// PLAN2 T1 场景 B：地图上每个概念多一行卡片轨的现状（零话术风险的那一面）。
describe('TutorPage · 地图上的卡片摘要', () => {
  const WITH_CARDS: TutorConceptRow = {
    concept: 'asyncio 事件循环',
    verdict: 'got',
    stuck: '',
    stuck_resolved: false,
    last_at: '2026-09-15T10:00:00+00:00',
    last_session_id: 3,
    sessions: 2,
    recalled: 0,
    cards_summary: { n: 3, mature: 1, again_7d: 2, topics: ['asyncio 事件循环', 'event loop 调度'] },
  }
  const NO_CARDS: TutorConceptRow = {
    concept: 'SQLite WAL 模式',
    verdict: 'got',
    stuck: '',
    stuck_resolved: false,
    last_at: '2026-09-14T10:00:00+00:00',
    last_session_id: 4,
    sessions: 2,
    recalled: 0,
  }

  beforeEach(() => {
    vi.mocked(api.tutorSessions).mockResolvedValue({ sessions: [] })
    vi.mocked(api.tutorStats).mockResolvedValue({
      days: 14,
      sessions: 3,
      got: 2,
      got_with_recall: 0,
      concepts: 2,
    })
    vi.mocked(api.tutorMap).mockResolvedValue({
      mastered: [WITH_CARDS, NO_CARDS],
      learning: [],
      stuck: [],
      untouched: [],
    })
    vi.mocked(api.tutorMastery).mockResolvedValue({
      events: [],
      mastered: 0,
      learning: 0,
      sessions: 0,
    })
    vi.mocked(api.tutorStuck).mockResolvedValue({ stuck: [] })
    vi.mocked(api.tutorRecurring).mockResolvedValue({ recurring: [] })
    vi.mocked(api.tutorStarters).mockResolvedValue({ starters: [] })
  })

  afterEach(cleanup)

  it('有卡的概念带三个数，没有卡的概念那一行不存在（只摆非零）', async () => {
    const view = await openRecord()

    const el = view.container.querySelector('[data-concept-cards="asyncio 事件循环"]')
    expect(el?.textContent).toBe('3 张卡 · 1 成熟 · 近 7 天重来 2 次')
    expect(view.container.querySelector('[data-concept-cards="SQLite WAL 模式"]')).toBeNull()
  })

  it('点那一行跳复习页，筛的是**话题词本身**（可重复的参数，别名那种情况才不漏卡）', async () => {
    const view = await openRecord()

    const href = view.container
      .querySelector('[data-concept-cards="asyncio 事件循环"]')
      ?.getAttribute('href')
    const qs = new URLSearchParams((href ?? '').split('?')[1] ?? '')
    expect(qs.getAll('topic')).toEqual(['asyncio 事件循环', 'event loop 调度'])
  })
})

// M1 · PLAN §3 G1 场景 B：「我来讲」讲完了，让它读一遍全文给一档。
// 它走的是**同一条 end()**（服务端就已经落了 verdict），所以前端拿到结果只负责显示——
// 判不了则如实说一句、退回你自己标，**不编分**。
describe('TutorPage · 我来讲 · 让它判', () => {
  const ended = {
    id: 1,
    verdict: 'half',
    concept: '事件循环',
    domain: 'asyncio',
    aliases: '',
    stuck: '',
    transfer: '',
    material_nearby: [],
    merged: null,
  }

  beforeEach(() => {
    // jsdom 没有 scrollIntoView，而会话视图每来一句就往底部滚一次——不补这一下，
    // effect 里抛的错会把整棵树拆掉（症状是「找不到那个按钮」）。
    Element.prototype.scrollIntoView = vi.fn()
    vi.mocked(api.tutorSessions).mockResolvedValue({ sessions: [] })
    vi.mocked(api.tutorStats).mockResolvedValue({
      days: 14,
      sessions: 1,
      got: 0,
      got_with_recall: 0,
      concepts: 1,
    })
    vi.mocked(api.tutorMap).mockResolvedValue({
      mastered: [],
      learning: [],
      stuck: [],
      untouched: [],
    })
    vi.mocked(api.tutorMastery).mockResolvedValue({
      events: [],
      mastered: 0,
      learning: 0,
      sessions: 0,
    })
    vi.mocked(api.tutorStuck).mockResolvedValue({ stuck: [] })
    vi.mocked(api.tutorRecurring).mockResolvedValue({ recurring: [] })
    vi.mocked(api.tutorStarters).mockResolvedValue({ starters: [] })
    vi.mocked(api.tutorStart).mockResolvedValue({
      id: 1,
      topic: '事件循环',
      repo: '',
      mode: 'feynman',
      model_id: 'p/m',
      model_ok: true,
    })
    // 第一轮回复走 SSE（`streamTutorSay` 是 fetch 流）
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseResponse(['event: delta\ndata: {"text":"那 await 的时候谁在跑？"}\n\n', 'event: done\ndata: {}\n\n'])
      )
    )
  })

  afterEach(() => {
    cleanup() // 不收拾的话上一例的树还挂着，`queryByText` 会捞到它的「记下了」
    vi.unstubAllGlobals()
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView
  })

  /** 开一场「我来讲」，等它的第一句话落地。 */
  async function beginSession() {
    render(
      <MemoryRouter>
        <TutorPage />
      </MemoryRouter>
    )
    fireEvent.click(await screen.findByText('🗣 我来讲（费曼）'))
    fireEvent.change(document.querySelector('[data-tutor-topic]') as HTMLInputElement, {
      target: { value: '事件循环' },
    })
    fireEvent.click(document.querySelector('[data-tutor-begin]') as HTMLElement)
    await screen.findByText('那 await 的时候谁在跑？')
  }

  it('判出来了 → verdict 与缺口都摆出来（走的是服务端那条 end）', async () => {
    vi.mocked(api.tutorJudge).mockResolvedValue({
      judged: true,
      verdict: 'half',
      missed_points: ['没说清 await 把控制权交给了谁'],
      model_id: 'p/m',
      ended,
    })
    await beginSession()
    fireEvent.click(document.querySelector('[data-judge]') as HTMLElement)

    const msg = await waitFor(() => {
      const el = document.querySelector('[data-judge-msg]')
      if (!el) throw new Error('还没有那句判词')
      return el
    })
    expect(msg.textContent).toContain('它判：半懂')
    expect(msg.textContent).toContain('没说清 await 把控制权交给了谁')
    // 与手动标一档同样的收尾：概念记下了，右栏跟着刷新
    expect(screen.getByText(/记下了：事件循环/)).toBeTruthy()
    // 前端**不**再调一次 end（那会白花第二次提取的钱）
    expect(api.tutorEnd).not.toHaveBeenCalled()
  })

  it('判不出来 → 如实说，一个字都没动，你自己标', async () => {
    vi.mocked(api.tutorJudge).mockResolvedValue({
      judged: false,
      reason: '判分没跑成（输出读不出来）',
      ended: null,
    })
    await beginSession()
    fireEvent.click(document.querySelector('[data-judge]') as HTMLElement)

    const msg = await waitFor(() => {
      const el = document.querySelector('[data-judge-msg]')
      if (!el) throw new Error('还没有那句话')
      return el
    })
    expect(msg.textContent).toContain('判分没跑成')
    expect(screen.queryByText(/记下了/)).toBeNull() // 没结论，就没「记下了」
  })

  // R3 · PLAN5 §3：把这一场会话挂到某件事上。
  it('评完才出现「挂到…」，而且挂的是**这一场**（kind=session + 本场 sid）', async () => {
    vi.mocked(api.tutorEnd).mockResolvedValue({ ...ended, verdict: 'got' })
    vi.mocked(api.suggestThreads).mockResolvedValue({ threads: [], label: '事件循环' })
    await beginSession()

    // 没评之前不摆：这一场还没「成」，挂上去的是半场
    expect(screen.queryByText('挂到…')).toBeNull()

    fireEvent.click(document.querySelector('[data-verdict="got"]') as HTMLElement)
    const btn = await screen.findByText('挂到…')

    fireEvent.click(btn)
    await waitFor(() => expect(api.suggestThreads).toHaveBeenCalled())
    // 改动前这里是 kind="tutor"（R3 把它改名为 session）；传错的值不会报错，
    // 只会在某天变成「挂接指向一个不存在的东西」——所以这里把两个参数都钉住。
    expect(vi.mocked(api.suggestThreads).mock.calls[0][0]).toBe('session')
    expect(vi.mocked(api.suggestThreads).mock.calls[0][1]).toBe('1') // 本场会话的 id
  })
})

// M3 · PLAN §3 G3：面试陪练。会话还是那套会话（tutor 的流换声部），
// 收尾不是自评而是**一份复盘报告**；卡壳一键回到「开一场教学」那条现有路径。
describe('TutorPage · 面试陪练', () => {
  const SECTIONS = {
    summary: '整体能讲，一到并发就开始含糊。',
    solid: ['GIL 之下 IO 能跑，讲清楚了'],
    stuck: ['await 的归属说不清'],
    teach_next: ['async 调度'],
  }

  beforeEach(() => {
    vi.mocked(api.tutorSessions).mockResolvedValue({ sessions: [] })
    vi.mocked(api.tutorStats).mockResolvedValue({
      days: 14,
      sessions: 0,
      got: 0,
      got_with_recall: 0,
      concepts: 0,
    })
    vi.mocked(api.tutorMap).mockResolvedValue({ mastered: [], learning: [], stuck: [], untouched: [] })
    vi.mocked(api.tutorMastery).mockResolvedValue({ events: [], mastered: 0, learning: 0, sessions: 0 })
    vi.mocked(api.tutorStuck).mockResolvedValue({ stuck: [] })
    vi.mocked(api.tutorRecurring).mockResolvedValue({ recurring: [] })
    vi.mocked(api.tutorStarters).mockResolvedValue({ starters: [] })
    vi.mocked(api.interviewBank).mockResolvedValue({
      file: '面试准备.md',
      questions: ['事件循环里 await 交给了谁', 'GIL 之下 IO 怎么跑'],
      concepts: [{ concept: '事件循环', recurring: true, stuck: '说不清归属' }],
      cards: ['GIL 是什么'],
      count: 4,
    })
    vi.mocked(api.tutorStart).mockResolvedValue({
      id: 7,
      topic: 'Python 后端',
      repo: '',
      mode: 'interview',
      model_id: 'p/m',
      model_ok: true,
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseResponse([
          'event: delta\ndata: {"text":"那 await 的时候，控制权交给谁了？"}\n\n',
          'event: done\ndata: {}\n\n',
        ])
      )
    )
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView
  })

  async function beginInterview() {
    Element.prototype.scrollIntoView = vi.fn()
    render(
      <MemoryRouter>
        <TutorPage />
      </MemoryRouter>
    )
    fireEvent.click(await screen.findByText('🎤 面试陪练'))
    // 题库那一行是选中时才拉的一次只读请求
    expect(await screen.findByText(/面试准备\.md 2 条/)).toBeTruthy()
    fireEvent.change(document.querySelector('[data-tutor-topic]') as HTMLInputElement, {
      target: { value: 'Python 后端' },
    })
    fireEvent.click(document.querySelector('[data-tutor-begin]') as HTMLElement)
    await screen.findByText('那 await 的时候，控制权交给谁了？')
  }

  it('开一场面试：模式是 interview，没有自评那一行，题库来自他自己的东西', async () => {
    await beginInterview()
    expect(vi.mocked(api.tutorStart).mock.calls[0][2]).toBe('interview')
    // 面试不是教学：不摆「这次 搞懂了/半懂/没用」，也不摆「让它判」
    expect(document.querySelector('[data-verdict]')).toBeNull()
    expect(document.querySelector('[data-judge]')).toBeNull()
    expect(document.querySelector('[data-interview-report]')).toBeTruthy()
    expect(screen.getByText(/问过 1 题/)).toBeTruthy()
  })

  it('出复盘报告：四个格子摆出来，卡壳一键回到「开一场教学」', async () => {
    vi.mocked(api.interviewReport).mockResolvedValue({
      ok: true,
      path: 'reports/2026-09-16-面试陪练-Python 后端.md',
      asked: 5,
      chars: 420,
      sections: SECTIONS,
    })
    await beginInterview()
    fireEvent.click(document.querySelector('[data-interview-report]') as HTMLElement)

    expect(await screen.findByText(SECTIONS.summary)).toBeTruthy()
    expect(screen.getByText(/GIL 之下 IO 能跑/)).toBeTruthy()
    expect(screen.getByText(/await 的归属说不清/)).toBeTruthy()
    // 报告落 vault/reports/，而且如实写着题库没被动过（它不算「成品」，界面也不吹成交付）
    const link = screen.getByText(/reports\/2026-09-16/).closest('a')
    expect(link?.getAttribute('href')).toContain('/notes?path=')
    expect(screen.getByText(/题库文件没有被改过/)).toBeTruthy()

    // 「去搞懂 →」走的是**现有路径**：开一场教学（socratic），不是另造一份记录
    fireEvent.click(document.querySelector('[data-teach="await 的归属说不清"]') as HTMLElement)
    await waitFor(() => expect(api.tutorStart).toHaveBeenCalledTimes(2))
    expect(vi.mocked(api.tutorStart).mock.calls[1][0]).toBe('await 的归属说不清')
    expect(vi.mocked(api.tutorStart).mock.calls[1][2]).toBe('socratic')
  })

  it('报告出不来就如实说，不编一份出来', async () => {
    vi.mocked(api.interviewReport).mockResolvedValue({
      ok: false,
      reason: '报告没生成出来（failed）',
    })
    await beginInterview()
    fireEvent.click(document.querySelector('[data-interview-report]') as HTMLElement)

    expect(await screen.findByText(/报告没生成出来/)).toBeTruthy()
    expect(document.querySelector('[data-interview-report-body]')).toBeNull()
  })

  it('选中的模式要真的传到后端（回归：这一条之前是断的）', async () => {
    // 曾经的形状：`beginWith(topic)` 不带 mode → 选「我来讲（费曼）」开出来的是苏格拉底会话，
    // 页面按费曼摆 UI、模型按老师讲课。面试陪练也一样：模式传不过去，整条功能是哑的。
    Element.prototype.scrollIntoView = vi.fn()
    render(
      <MemoryRouter>
        <TutorPage />
      </MemoryRouter>
    )
    fireEvent.click(await screen.findByText('🗣 我来讲（费曼）'))
    fireEvent.change(document.querySelector('[data-tutor-topic]') as HTMLInputElement, {
      target: { value: '事件循环' },
    })
    fireEvent.click(document.querySelector('[data-tutor-begin]') as HTMLElement)
    await waitFor(() => expect(api.tutorStart).toHaveBeenCalled())
    expect(vi.mocked(api.tutorStart).mock.calls[0][2]).toBe('feynman')
  })
})

// PLAN2 §6 第三条（回指采纳）：从搁置卡的前置候选点进来的深链要带 `prereq=<card_id>`，
// 它一路走到 `tutor.start(prereq_card_id=…)`——后端只在会话行上记一个事实。
describe('TutorPage · 从「可能缺前置」的候选点进来', () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn()
    vi.mocked(api.tutorSessions).mockResolvedValue({ sessions: [] })
    vi.mocked(api.tutorStats).mockResolvedValue({
      days: 14,
      sessions: 0,
      got: 0,
      got_with_recall: 0,
      concepts: 0,
    })
    vi.mocked(api.tutorMap).mockResolvedValue({ mastered: [], learning: [], stuck: [], untouched: [] })
    vi.mocked(api.tutorMastery).mockResolvedValue({ events: [], mastered: 0, learning: 0, sessions: 0 })
    vi.mocked(api.tutorStuck).mockResolvedValue({ stuck: [] })
    vi.mocked(api.tutorRecurring).mockResolvedValue({ recurring: [] })
    vi.mocked(api.tutorStarters).mockResolvedValue({ starters: [] })
    vi.mocked(api.tutorStart).mockResolvedValue({
      id: 9,
      topic: '召回率',
      repo: '',
      mode: 'socratic',
      model_id: 'p/m',
      model_ok: true,
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => sseResponse(['event: delta\ndata: {"text":"召回率是什么？"}\n\n', 'event: done\ndata: {}\n\n']))
    )
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('深链把 card id 传到开场那一步（老师模式、话题就是那个概念）', async () => {
    render(
      <MemoryRouter initialEntries={['/tutor?new=召回率&prereq=9']}>
        <TutorPage />
      </MemoryRouter>
    )
    await waitFor(() => expect(api.tutorStart).toHaveBeenCalled())
    const call = vi.mocked(api.tutorStart).mock.calls[0]
    expect(call[0]).toBe('召回率')
    expect(call[2]).toBe('socratic')
    expect(call[4]).toBe(9) // 第五个参数就是那张搁置卡
  })

  it('没有这个参数时一个字节都不多传（别的深链照旧）', async () => {
    render(
      <MemoryRouter initialEntries={['/tutor?new=召回率']}>
        <TutorPage />
      </MemoryRouter>
    )
    await waitFor(() => expect(api.tutorStart).toHaveBeenCalled())
    expect(vi.mocked(api.tutorStart).mock.calls[0][4]).toBeUndefined()
  })
})

describe('TutorPage · 面试陪练（原处）', () => {
  it('选中的模式要真的传到后端（回归：这一条之前是断的）', async () => {
    // 曾经的形状：`beginWith(topic)` 不带 mode → 选「我来讲（费曼）」开出来的是苏格拉底会话，
    // 页面按费曼摆 UI、模型按老师讲课。面试陪练也一样：模式传不过去，整条功能是哑的。
    Element.prototype.scrollIntoView = vi.fn()
    render(
      <MemoryRouter>
        <TutorPage />
      </MemoryRouter>
    )
    fireEvent.click(await screen.findByText('🗣 我来讲（费曼）'))
    fireEvent.change(document.querySelector('[data-tutor-topic]') as HTMLInputElement, {
      target: { value: '事件循环' },
    })
    fireEvent.click(document.querySelector('[data-tutor-begin]') as HTMLElement)
    await waitFor(() => expect(api.tutorStart).toHaveBeenCalled())
    expect(vi.mocked(api.tutorStart).mock.calls[0][2]).toBe('feynman')
  })
})
