// 小屋（P4）：屋里摆着什么、今天喂了它什么、架上那几份产出。
//
// 两条最该被钉住的不是渲染，是**语气**：
// 1. 每件东西标的是「到手那天」，不是「最近更新」；
// 2. 屋里空着 / 今天没吃东西时，说的是实话，**没有「还差 N 件」「它饿了」这种欠账口吻**。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

import RoomPane from './RoomPane'
import type { PetMeal, PetRoom, PetSkillCard, PetThing, WorkOutput } from './api'

vi.mock('./api', () => ({ api: { petRoom: vi.fn() } }))
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
  passed: 2,
  cases: 8,
  rate: 0.25,
  ci_low: 0.07,
  ci_high: 0.59,
  at: '2026-09-15T10:00:00',
  model_id: 'sensenova/flash-lite',
  stale: false,
}

const ROOM: PetRoom = {
  things: [STACK, thing({})],
  carried: STACK,
  shelf: SHELF,
  today: { meals: [MEAL], date: '2026-09-14' },
  skills: [SKILL],
  empty: false,
}

const EMPTY: PetRoom = {
  things: [],
  carried: null,
  shelf: [],
  today: { meals: [], date: '2026-09-14' },
  skills: [],
  empty: true,
}

function renderPane() {
  return render(
    <MemoryRouter>
      <RoomPane />
    </MemoryRouter>
  )
}

beforeEach(() => {
  vi.mocked(api.petRoom).mockResolvedValue(ROOM)
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

  it('读出错给一句话，不是空白页', async () => {
    vi.mocked(api.petRoom).mockRejectedValue(new Error('后端不在'))
    renderPane()
    expect(await screen.findByText(/读小屋出错了：后端不在/)).toBeTruthy()
  })
})

// Q2 · 技能卡：技能只有一个到手方式——一条提示词跑过一次对照。
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
