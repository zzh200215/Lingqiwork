// 小屋（P4）：屋里摆着什么、今天喂了它什么、架上那几份产出。
//
// 两条最该被钉住的不是渲染，是**语气**：
// 1. 每件东西标的是「到手那天」，不是「最近更新」；
// 2. 屋里空着 / 今天没吃东西时，说的是实话，**没有「还差 N 件」「它饿了」这种欠账口吻**。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

import RoomPane from './RoomPane'
import type {
  FormDomain,
  PetConceptCard,
  PetMeal,
  PetRoom,
  PetSkillCard,
  PetState,
  PetThing,
  PodcastEntry,
  WeeklyReport,
  WorkOutput,
} from './api'

vi.mock('./api', () => ({
  api: {
    petRoom: vi.fn(),
    petState: vi.fn(),
    weeklyReport: vi.fn(),
    weeklyPodcast: vi.fn(),
  },
}))
import { api } from './api'

function thing(patch: Partial<PetThing>): PetThing {
  return {
    id: 'work:1',
    kind: 'badge',
    module: 'work',
    module_label: '工作',
    icon: '📄',
    label: '第一份成品',
    detail: '第 1 份成品',
    at: '2026-09-10T09:00:00',
    at_ts: Date.now() / 1000 - 4 * 86400,
    count: 1,
    ...patch,
  }
}

const STACK = thing({
  id: 'work:5',
  kind: 'prop',
  icon: '📦',
  label: '一摞成果',
  detail: '第 5 份成品',
  at: '2026-09-14T09:00:00',
  at_ts: Date.now() / 1000 - 3600,
})

const MEAL: PetMeal = {
  key: 'runs_ok',
  module: 'work',
  module_label: '工作',
  icon: '⚙️',
  label: '工作流 2 条',
  count: 2,
}

const SHELF: WorkOutput[] = [
  { kind: 'deliver', label: '交付', title: '给领导的汇报', date: '2026-09-12', path: 'deliver/a.md', mtime: 1 },
]

/** 一张技能卡（Q2）：跑过对照的提示词。 */
const SKILL: PetSkillCard = {
  name: 'FEYNMAN_PROMPT',
  module: 'app.core.tutor',
  purpose: '费曼反转教学：用户讲，模型当那个没搞懂的学生 + 考官',
  kind: 'prompt',
  sha: 'e9fd94ec9044',
  domain: '教学',
  passed: 2,
  cases: 8,
  rate: 0.25,
  ci_low: 0.07,
  ci_high: 0.59,
  at: '2026-09-15T10:00:00',
  model_id: 'sensenova/flash-lite',
  stale: false,
}

/** 一张概念卡（P2 · F13）：学习地图在小屋里的镜子。档位就是地图那一档。 */
function concept(patch: Partial<PetConceptCard>): PetConceptCard {
  return {
    id: 'concept:asyncio 事件循环',
    name: 'asyncio 事件循环',
    state: 'mastered',
    sessions: 3,
    stuck: '',
    at: '2026-09-14T09:00:00',
    at_ts: Date.now() / 1000 - 2 * 86400,
    ...patch,
  }
}

const CONCEPT = concept({})

/** 一根枝（Q3）：三样都站住的领域。 */
const BRANCH: FormDomain = {
  domain: '教学',
  retrieval: {
    enough: true,
    cases: 3,
    labelled: 3,
    hits: 3,
    hit_rate: 1.0,
    ci_low: 0.44,
    ci_high: 1.0,
    faithfulness: 4.5,
    judged: 3,
    run_id: 7,
    at: '2026-09-15T10:00:00+00:00',
    note: '',
  },
  concepts: { enough: true, mastered: 2, seen: 3, names: ['asyncio 事件循环'], at: '2026-09-15T10:00:00+00:00' },
  skills: [
    {
      name: 'FEYNMAN_PROMPT',
      purpose: '费曼反转教学',
      passed: 3,
      cases: 8,
      rate: 0.375,
      ci_low: 0.14,
      ci_high: 0.69,
      at: '2026-09-15T10:00:00+00:00',
      stale: false,
      enough: true,
    },
  ],
  grown: true,
}

const ROOM: PetRoom = {
  things: [STACK, thing({})],
  carried: STACK,
  shelf: SHELF,
  today: { meals: [MEAL], date: '2026-09-14' },
  skills: [SKILL],
  form: [BRANCH],
  concepts: { cards: [CONCEPT], total: 1 },
  flavor: '这阵子喂它最多的是「检索」（3 个概念）。',
  empty: false,
}

const EMPTY: PetRoom = {
  things: [],
  carried: null,
  shelf: [],
  today: { meals: [], date: '2026-09-14' },
  skills: [],
  form: [],
  concepts: { cards: [], total: 0 },
  flavor: '',
  empty: true,
}

/** 这一周（M4 · G4）：全部读出来的事实 + **它说的那一句**（`weekly.text()` 出来的）。 */
const WEEK: WeeklyReport = {
  week: { start: '2026-09-14', end: '2026-09-16' },
  facts: { sources: 2, points: 5, got: 3, half: 1, outputs: 2, recurring: ['闭包'] },
  text: '这周你消化了 2 份材料（拆出 5 个点）、说通了 3 个概念、交出 2 份成品。有 1 个概念停在半懂，「闭包」还是没走通。',
  empty: false,
}

const POD: PodcastEntry = {
  id: 'pod-x',
  title: '周报 09-14–09-16',
  sources: [],
  turns: 2,
  duration_sec: 12.3,
  file: 'pod-x.wav',
  script: [],
  created_at: '2026-09-16T21:00:00',
  ok: true,
}

function renderPane() {
  return render(
    <MemoryRouter>
      <RoomPane />
    </MemoryRouter>
  )
}

/** 一个「此刻」：默认待机、没话说。 */
function petState(patch: Partial<PetState> = {}): PetState {
  return { mode: 'idle', action: 'idle', energy: 80, line: '', path: '', ...patch }
}

beforeEach(() => {
  vi.mocked(api.petRoom).mockResolvedValue(ROOM)
  vi.mocked(api.petState).mockResolvedValue(petState())
  vi.mocked(api.weeklyReport).mockResolvedValue(WEEK)
})

afterEach(cleanup)

describe('RoomPane', () => {
  it('摆件与徽章分开摆：一件东西只出现在一处', async () => {
    const { container } = renderPane()
    // 「一摞成果」出现两次是**对的**：屋里摆着一件，它身上也挂着那一件（最近到手）
    expect((await screen.findAllByText('一摞成果')).length).toBe(2)
    expect(screen.getByText('屋里摆着')).toBeTruthy()
    expect(screen.getByText('徽章')).toBeTruthy()
    const ids = [...container.querySelectorAll('[data-room-thing]')].map((el) =>
      el.getAttribute('data-room-thing')
    )
    expect(ids.sort()).toEqual(['work:1', 'work:5'])
  })

  it('每件东西标的是**到手那天**，不是「最近更新」', async () => {
    renderPane()
    // 一摞成果是今天到手的：说「1 小时前」；第一份成品是四天前：说「4 天前」
    expect(await screen.findByText(/第 5 份成品 · 1 小时前/)).toBeTruthy()
    expect(screen.getByText(/第 1 份成品 · 4 天前/)).toBeTruthy()
  })

  it('它最近叼回来的那件挂在宠物身上', async () => {
    const { container } = renderPane()
    await screen.findAllByText('一摞成果')
    expect(container.querySelector('[data-room-carried]')?.getAttribute('data-room-carried')).toBe(
      'work:5'
    )
  })

  it('刚交出去的那份成品也能挂在身上——不必正好撞上门槛', async () => {
    const fresh: PetThing = {
      id: 'file:deliver/a.md',
      kind: 'output',
      module: 'work',
      module_label: '工作',
      icon: '📄',
      label: '给领导的汇报',
      detail: '交付 · 2026-09-12',
      at: '2026-09-12T10:00:00',
      at_ts: Date.now() / 1000 - 60,
      count: 1,
    }
    vi.mocked(api.petRoom).mockResolvedValue({ ...ROOM, carried: fresh })
    const { container } = renderPane()
    await screen.findAllByText('一摞成果')
    expect(container.querySelector('[data-room-carried]')?.getAttribute('data-room-carried')).toBe(
      'file:deliver/a.md'
    )
    expect(screen.getAllByText('给领导的汇报').length).toBe(2) // 身上一件 + 架上一份
  })

  it('今天喂了它什么：一条线一件，带模块名', async () => {
    const { container } = renderPane()
    await screen.findByText('工作流 2 条')
    const meal = container.querySelector('[data-room-meal="runs_ok"]')
    expect(meal?.textContent).toContain('工作')
    expect(meal?.textContent).toContain('⚙️')
    expect(screen.getByText('2 件')).toBeTruthy()
  })

  it('架上那几份点得开，去的是那篇原文', async () => {
    const { container } = renderPane()
    await screen.findByText('给领导的汇报')
    const link = container.querySelector('a[href^="/notes?path="]') as HTMLAnchorElement
    expect(link.getAttribute('href')).toBe('/notes?path=deliver%2Fa.md')
  })

  it('一件东西都没有时说实话，不摆「还差几件」的进度', async () => {
    vi.mocked(api.petRoom).mockResolvedValue(EMPTY)
    renderPane()
    expect(await screen.findByText('小屋还是空的。')).toBeTruthy()
    expect(screen.getByText(/它两手空空/)).toBeTruthy()
    // 空屋子里没有欠账口吻
    expect(screen.queryByText(/还差/)).toBeNull()
    expect(screen.queryByText(/解锁/)).toBeNull()
  })

  it('今天还没吃东西时，说的是「它不饿」——宠物不靠你喂才活着', async () => {
    vi.mocked(api.petRoom).mockResolvedValue({ ...ROOM, today: { meals: [], date: '2026-09-14' } })
    renderPane()
    expect(await screen.findByText(/它不饿/)).toBeTruthy()
    expect(screen.queryByText(/还差/)).toBeNull()
  })

  it('Z4：小屋顶上那一行喂养风味与成长页同源；数不出来就不摆', async () => {
    const { container } = renderPane()
    expect(await screen.findByText(/这阵子喂它最多的是「检索」/)).toBeTruthy()
    expect(container.querySelector('[data-room-flavor]')).toBeTruthy()

    cleanup()
    vi.mocked(api.petRoom).mockResolvedValue({ ...ROOM, flavor: '' })
    const second = renderPane()
    await screen.findByText('屋里摆着')
    expect(second.container.querySelector('[data-room-flavor]')).toBeNull()
  })

  it('读出错给一句话，不是空白页', async () => {
    vi.mocked(api.petRoom).mockRejectedValue(new Error('后端不在'))
    renderPane()
    expect(await screen.findByText(/读小屋出错了：后端不在/)).toBeTruthy()
  })
})

// 屋子里的零柒：**它是一只宠物，两处画它就该是同一个姿势**（与悬浮那个读同一个接口）。
describe('RoomPane · 屋里的零柒', () => {
  it('摆的是此刻的姿势，不是写死的待机', async () => {
    vi.mocked(api.petState).mockResolvedValue(
      petState({ mode: 'busy', action: 'running-right', line: '复盘正在跑，我去盯着。' })
    )
    const { container } = renderPane()
    const pet = await waitFor(() => {
      const el = container.querySelector('[data-room-pet]') as HTMLImageElement | null
      if (!el) throw new Error('还没有宠物')
      return el
    })
    expect(pet.getAttribute('src')).toBe('/pet/running-right.webp')
    expect(pet.getAttribute('data-room-action')).toBe('running-right')
    expect(screen.getByText('复盘正在跑，我去盯着。')).toBeTruthy()
  })

  it('刚交出一份成品 → 它在屋里跳一下', async () => {
    vi.mocked(api.petState).mockResolvedValue(
      petState({ mode: 'celebrating', action: 'jumping', line: '交出去一份。收着。' })
    )
    const { container } = renderPane()
    await screen.findByText('交出去一份。收着。')
    expect(
      container.querySelector('[data-room-pet]')?.getAttribute('data-room-action')
    ).toBe('jumping')
  })

  it('没话说时一个字都不摆（安静是默认）', async () => {
    const { container } = renderPane()
    await screen.findAllByText('一摞成果')
    expect(container.querySelector('[data-room-line]')).toBeNull()
  })

  it('它叼着的那份在架上也标得出来——两处指的是同一件东西', async () => {
    const fresh: PetThing = {
      id: 'file:deliver/a.md',
      ref: 'deliver/a.md',
      kind: 'output',
      module: 'work',
      module_label: '工作',
      icon: '📄',
      label: '给领导的汇报',
      detail: '交付 · 2026-09-12',
      at: '2026-09-12T10:00:00',
      at_ts: Date.now() / 1000 - 60,
      count: 1,
    }
    vi.mocked(api.petRoom).mockResolvedValue({ ...ROOM, carried: fresh })
    const { container } = renderPane()
    await screen.findAllByText('给领导的汇报')
    expect(
      container.querySelector('[data-room-shelf-carried]')?.getAttribute('data-room-shelf-carried')
    ).toBe('deliver/a.md')
    expect(screen.getByText('它刚叼回来的')).toBeTruthy()
  })

  it('24 小时内到手的说「多久以前」，更早的回到日期——屋里不摆流水账', async () => {
    const now = Date.now() / 1000
    vi.mocked(api.petRoom).mockResolvedValue({
      ...ROOM,
      carried: null,
      shelf: [
        { kind: 'deliver', label: '交付', title: '刚写的', date: '2026-09-14', path: 'deliver/new.md', mtime: now - 120 },
        { kind: 'research', label: '研究', title: '上周的', date: '2026-09-07', path: 'research/old.md', mtime: now - 7 * 86400 },
      ],
    })
    renderPane()
    expect(await screen.findByText('刚写的')).toBeTruthy()
    expect(screen.getByText('2 分钟前')).toBeTruthy()
    expect(screen.getByText('2026-09-07')).toBeTruthy() // 旧的照旧写日期
    expect(screen.queryByText('7 天前')).toBeNull()
  })

  it('待在这一页的时候会自己重取：后台交出一份成品，屋里当场多一件', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    try {
      const { container } = renderPane()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(container.querySelectorAll('[data-room-thing]').length).toBe(2)
      expect(api.petRoom).toHaveBeenCalledTimes(1)

      // 下一拍之前：架子上多了一份
      const shelf = [
        ...SHELF,
        { kind: 'recap', label: '复盘', title: '刚落的复盘', date: '2026-09-14', path: 'recap/b.md', mtime: 2 },
      ] as WorkOutput[]
      vi.mocked(api.petRoom).mockResolvedValue({ ...ROOM, shelf })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(15000)
      })
      expect(api.petRoom).toHaveBeenCalledTimes(2)
      expect(screen.getByText('刚落的复盘')).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })
})

// Q2 · 技能卡：技能只有一个到手方式——一条提示词跑过一次对照。
// P2 · F13：学习地图在小屋里的镜子。它与屋里别的东西不是一类——照的是**此刻在哪一档**，
// 所以同一个概念的卡会变色；而「未触及」那一档**一个字都不进屋**（那是「还没做的事」）。
describe('RoomPane · 它记住的概念', () => {
  const LEARNED = concept({
    id: 'concept:SQLite WAL',
    name: 'SQLite WAL',
    state: 'learning',
    sessions: 1,
    at_ts: Date.now() / 1000 - 3600,
  })
  const STUCK = concept({
    id: 'concept:CORS 预检',
    name: 'CORS 预检',
    state: 'stuck',
    sessions: 2,
    stuck: '以为 OPTIONS 是应用层发的',
  })

  it('按地图分好的档摆卡：词与色跟学页那张地图是同一套', async () => {
    vi.mocked(api.petRoom).mockResolvedValue({
      ...ROOM,
      concepts: { cards: [CONCEPT, LEARNED, STUCK], total: 3 },
    })
    const { container } = renderPane()
    const cards = await waitFor(() => {
      const els = [...container.querySelectorAll('[data-room-concept]')]
      if (els.length < 3) throw new Error('概念卡还没摆出来')
      return els as HTMLElement[]
    })
    expect(cards.map((el) => el.getAttribute('data-room-concept'))).toEqual([
      'asyncio 事件循环',
      'SQLite WAL',
      'CORS 预检',
    ])
    expect(cards.map((el) => el.getAttribute('data-room-concept-state'))).toEqual([
      'mastered',
      'learning',
      'stuck',
    ])
    // 档位那两个字来自 `conceptState.ts`（与地图的档位标签同一份），不是后端发来的
    expect(cards[0].textContent).toContain('已掌握')
    expect(cards[1].textContent).toContain('在学')
    expect(cards[2].textContent).toContain('卡住')
    expect(cards[0].textContent).toContain('讲过 3 次')
    // 点开走既有的那条深链：专门为这个概念开一场教学
    expect((cards[0] as HTMLAnchorElement).getAttribute('href')).toBe(
      `/tutor?new=${encodeURIComponent('asyncio 事件循环')}`
    )
  })

  it('只有卡住那一档带「卡在哪儿」', async () => {
    vi.mocked(api.petRoom).mockResolvedValue({
      ...ROOM,
      concepts: { cards: [CONCEPT, STUCK], total: 2 },
    })
    const { container } = renderPane()
    await waitFor(() =>
      expect(container.querySelectorAll('[data-room-concept]').length).toBe(2)
    )
    const got = [...container.querySelectorAll('[data-room-concept]')].map((el) => el.textContent)
    expect(got[1]).toContain('卡在「以为 OPTIONS 是应用层发的」')
    expect(got[0]).not.toContain('卡在')
  })

  it('未触及那一档进不来，屋里也不摆一句「还没碰的」', async () => {
    // 后端这份契约里根本没有 untouched 这个键；就算硬塞进来也不该被摆出来
    vi.mocked(api.petRoom).mockResolvedValue({
      ...ROOM,
      concepts: {
        cards: [CONCEPT],
        total: 1,
        // @ts-expect-error 故意多塞一档：界面不许自己长出地图上没有的档
        untouched: [{ id: 1, point: 'B+ 树怎么分裂' }],
      },
    })
    const { container } = renderPane()
    await waitFor(() => expect(container.querySelector('[data-room-concept]')).toBeTruthy())
    expect(container.querySelectorAll('[data-room-concept]').length).toBe(1)
    expect(screen.queryByText('B+ 树怎么分裂')).toBeNull()
    expect(screen.queryByText(/未触及/)).toBeNull()
    expect(screen.queryByText(/还差|还欠|没碰/)).toBeNull()
  })

  it('认不出来的档照实写出来，不猜一个颜色糊上', async () => {
    vi.mocked(api.petRoom).mockResolvedValue({
      ...ROOM,
      concepts: { cards: [concept({ state: '复习中' })], total: 1 },
    })
    const { container } = renderPane()
    const card = await waitFor(() => {
      const el = container.querySelector('[data-room-concept]')
      if (!el) throw new Error('还没有卡')
      return el as HTMLElement
    })
    expect(card.textContent).toContain('复习中')
    // 没有那三档的颜色（认不出来就是不给色，也不假装它是「在学」）
    expect(card.className).not.toContain('emerald')
    expect(card.className).not.toContain('amber')
    expect(card.className).not.toContain('sky')
  })

  it('屋里摆不下时说「共 N 个」并给出去处——掉出屋子的不是没了', async () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      concept({ id: `concept:概念${i}`, name: `概念${i}`, state: 'learning' })
    )
    vi.mocked(api.petRoom).mockResolvedValue({ ...ROOM, concepts: { cards: many, total: 15 } })
    const { container } = renderPane()
    await waitFor(() =>
      expect(container.querySelectorAll('[data-room-concept]').length).toBe(12)
    )
    expect(screen.getByText('共 15 个')).toBeTruthy()
    const hrefs = [...container.querySelectorAll('a')].map((a) => a.getAttribute('href'))
    expect(hrefs).toContain('/tutor')
  })

  it('摆得下时不写「共 N 个」', async () => {
    const { container } = renderPane()
    await waitFor(() => expect(container.querySelector('[data-room-concept]')).toBeTruthy())
    expect(screen.queryByText(/^共 \d+ 个$/)).toBeNull()
  })

  it('一张卡都没有时说清楚路径，不摆空位也不催', async () => {
    vi.mocked(api.petRoom).mockResolvedValue(EMPTY)
    renderPane()
    expect(await screen.findByText('它记住的概念')).toBeTruthy()
    expect(screen.getByText(/还没有一张概念卡/)).toBeTruthy()
    expect(screen.queryByText(/还差|还欠|没碰/)).toBeNull()
  })
})

describe('RoomPane · 它学会的技能', () => {
  it('摆出有基线的那张卡：名字、过了几条、区间，点开进实验室', async () => {
    const { container } = renderPane()
    const card = await waitFor(() => {
      const el = container.querySelector('[data-room-skill="FEYNMAN_PROMPT"]')
      if (!el) throw new Error('还没有技能卡')
      return el as HTMLAnchorElement
    })
    expect(card.textContent).toContain('FEYNMAN_PROMPT')
    expect(card.textContent).toContain('2/8')
    expect(card.textContent).toContain('25%')
    expect(card.textContent).toContain('7–59%') // 区间照直写，不做四舍五入的美化
    // 点开就是那一条的对照台
    expect(card.getAttribute('href')).toBe('/work?tab=lab&prompt=FEYNMAN_PROMPT')
  })

  it('一张卡都没有时说清楚路径，不摆空位也不催', async () => {
    vi.mocked(api.petRoom).mockResolvedValue(EMPTY)
    renderPane()
    expect(await screen.findByText('它学会的技能')).toBeTruthy()
    expect(screen.getByText(/技能只有一个到手方式/)).toBeTruthy()
    expect(screen.queryByText(/还差/)).toBeNull()
  })

  it('基线过期就直说——卡上的分数不是这一版的了', async () => {
    vi.mocked(api.petRoom).mockResolvedValue({
      ...ROOM,
      skills: [{ ...SKILL, stale: true }],
    })
    const { container } = renderPane()
    await waitFor(() => expect(container.querySelector('[data-room-skill]')).toBeTruthy())
    expect(screen.getByText('基线过期')).toBeTruthy()
  })
})

// Q3 · 形态：一根枝要三样可验证的东西在**同一个领域**里都站得住。
describe('RoomPane · 它长出的枝', () => {
  it('摆出那个领域和三个数，并**写明它没学会它**', async () => {
    const { container } = renderPane()
    const branch = await waitFor(() => {
      const el = container.querySelector('[data-room-form="教学"]')
      if (!el) throw new Error('还没有长出枝')
      return el as HTMLElement
    })
    expect(branch.textContent).toContain('教学')
    expect(branch.textContent).toContain('检索 3/3') // 命中 + 样本量
    expect(branch.textContent).toContain('44–100%') // 区间照直写
    expect(branch.textContent).toContain('忠实度 4.5/5')
    expect(branch.textContent).toContain('搞懂 2 个概念')
    expect(branch.textContent).toContain('技能卡 3/8')
    // 最要紧的一句：「检索得住」不是「学会了」
    expect(branch.textContent).toContain('它没有学会教学')
    expect(branch.textContent).toContain('没有一样测过它对你这类问题的判断')
  })

  it('没有枝的时候说清楚路径：领域是你在证据上写的一个短词', async () => {
    vi.mocked(api.petRoom).mockResolvedValue(EMPTY)
    renderPane()
    expect(await screen.findByText('它长出的枝')).toBeTruthy()
    expect(screen.getByText(/还没有长出枝/)).toBeTruthy()
    expect(screen.getByText(/领域是你在证据上自己写的一个短词/)).toBeTruthy()
    expect(screen.queryByText(/还差/)).toBeNull()
  })

  it('只摆长出来的那几根——没长成的领域不进屋', async () => {
    vi.mocked(api.petRoom).mockResolvedValue({ ...ROOM, form: [] })
    const { container } = renderPane()
    await screen.findByText('它长出的枝')
    expect(container.querySelector('[data-room-form]')).toBeNull()
    expect(screen.getByText(/还没有长出枝/)).toBeTruthy()
  })
})

// M4 · 这一周：**读出来的事实**说成一句话。不是清单、不是账单，转播客念的就是那一句。
describe('RoomPane · 这一周', () => {
  it('说的是那句话，并把数摆出来让你核', async () => {
    const { container } = renderPane()
    expect(await screen.findByText(WEEK.text)).toBeTruthy()
    // 区间一起摆出来：周三点开时它只是半周，别让半周的数看起来像整周的数
    expect(screen.getByText('09-14 – 09-16')).toBeTruthy()
    const facts = [...container.querySelectorAll('[data-room-weekly-fact]')].map((el) =>
      el.getAttribute('data-room-weekly-fact')
    )
    expect(facts).toEqual(['sources', 'got', 'half', 'outputs'])
    expect(container.querySelector('[data-room-weekly-recurring="闭包"]')).toBeTruthy()
  })

  it('零的那几格不摆出来——一排 0 就是一张自找的欠账清单', async () => {
    vi.mocked(api.weeklyReport).mockResolvedValue({
      ...WEEK,
      facts: { sources: 0, points: 0, got: 1, half: 0, outputs: 0, recurring: [] },
      text: '这周你说通了 1 个概念。',
    })
    const { container } = renderPane()
    await screen.findByText('这周你说通了 1 个概念。')
    const facts = [...container.querySelectorAll('[data-room-weekly-fact]')].map((el) =>
      el.getAttribute('data-room-weekly-fact')
    )
    expect(facts).toEqual(['got'])
  })

  it('没数据的那一周只说「还没什么可说的」，也不给转播客的按钮', async () => {
    vi.mocked(api.weeklyReport).mockResolvedValue({
      ...WEEK,
      facts: { sources: 0, points: 0, got: 0, half: 0, outputs: 0, recurring: [] },
      text: '',
      empty: true,
    })
    const { container } = renderPane()
    expect(await screen.findByText(/还没什么可说的/)).toBeTruthy()
    expect(screen.queryByText('转成播客')).toBeNull()
    expect(container.querySelector('[data-room-weekly-text]')).toBeNull()
    expect(screen.queryByText(/还欠|还差|没做/)).toBeNull()
  })

  it('一键转播客：声音给出来，地址就是那一期', async () => {
    vi.mocked(api.weeklyPodcast).mockResolvedValue(POD)
    const { container } = renderPane()
    fireEvent.click(await screen.findByText('转成播客'))
    await waitFor(() => {
      const el = container.querySelector('[data-room-weekly-audio]')
      if (!el) throw new Error('还没有音频')
      expect(el.getAttribute('data-room-weekly-audio')).toBe('pod-x.wav')
      expect(el.getAttribute('src')).toBe('/api/podcast/audio/pod-x.wav')
    })
  })

  it('录不出来就照实说，不假装成功', async () => {
    vi.mocked(api.weeklyPodcast).mockRejectedValue(
      new Error('400: {"detail":"语音合成失败，没有生成任何音频"}')
    )
    const { container } = renderPane()
    fireEvent.click(await screen.findByText('转成播客'))
    expect(await screen.findByText('语音合成失败，没有生成任何音频')).toBeTruthy()
    expect(container.querySelector('[data-room-weekly-audio]')).toBeNull()
  })

  it('周报读不出来不拖垮整间屋子', async () => {
    vi.mocked(api.weeklyReport).mockRejectedValue(new Error('500: boom'))
    const { container } = renderPane()
    await screen.findAllByText('一摞成果')
    expect(container.querySelector('[data-room-weekly-text]')).toBeNull()
    expect(screen.getByText('架上那几份')).toBeTruthy()
  })
})
