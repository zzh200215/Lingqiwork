// 成长页：等级卡 + 四个来源 + 最近搞懂 + 坚持 + 最近交出去。
// 数据全是派生量，所以这里全用固定数据喂它，不碰网络。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

import GrowthPage from './GrowthPage'
import type { HabitToday, PetGrowth, TutorMastery, WorkOutput } from './api'

vi.mock('./api', () => ({
  api: {
    petGrowth: vi.fn(),
    tutorMastery: vi.fn(),
    habitsToday: vi.fn(),
    workOutputs: vi.fn(),
    petPlugins: vi.fn(),
  },
}))
import { api } from './api'

const GROWTH: PetGrowth = {
  level: 2,
  title: '同行',
  exp: 137,
  next_title: '顺手',
  progress: 0.42,
  parts: [
    { key: 'learning', label: '把东西搞懂', exp: 120 },
    { key: 'work', label: '把东西做出来', exp: 12 },
    { key: 'habits', label: '坚持', exp: 4 },
    { key: 'review', label: '复习', exp: 1 },
  ],
  counts: { mastered: 3, sessions: 6, runs_ok: 1, outputs: 0, habit_days: 1, reviews: 1 },
}

const MASTERY: TutorMastery = {
  events: [
    { concept: 'asyncio 事件循环', at: '2026-09-13T06:00:00+00:00', sessions: 2, recalled: 1, from_half: true },
    { concept: 'JS 闭包', at: '2026-09-12T06:00:00+00:00', sessions: 2, recalled: 0, from_half: false },
  ],
  mastered: 2,
  learning: 1,
  sessions: 6,
}

const HABITS: HabitToday = {
  day: '2026-09-13',
  habits: [
    {
      id: 1, name: '写代码', icon: '💻', kind: 'count', target: 30, unit: '分钟',
      weekdays: '1111111', auto: '', sort: 0, value: 30, done: true, scheduled: true,
      streak: 4, history: ['2026-09-10', '2026-09-11', '2026-09-12', '2026-09-13'],
    },
    {
      id: 2, name: '读文档', icon: '📖', kind: 'check', target: 1, unit: '',
      weekdays: '1111111', auto: '', sort: 1, value: 0, done: false, scheduled: true,
      streak: 0, history: [],
    },
  ],
  done: 1,
  total: 2,
  pending: ['读文档'],
  heatmap_days: 30,
}

const OUTPUTS: WorkOutput[] = [
  { kind: 'deliver', label: '交付', title: '给领导的汇报', date: '2026-09-12', path: 'deliver/a.md', mtime: 1 },
]

const MOOD_PLUGIN = {
  name: 'mood',
  label: '心情打卡',
  enabled: true,
  permissions: ['notify', 'store', 'schedule', 'command', 'panel'],
  commands: ['set', 'clear'],
  panel: {
    kind: 'mood' as const,
    scale: 5,
    value: 4,
    days: 2,
    recent: [
      { day: '2026-09-12', value: 2 },
      { day: '2026-09-13', value: 4 },
    ],
  },
  quota: { used: 0, cap: 2 },
}

function renderPage() {
  return render(
    <MemoryRouter>
      <GrowthPage />
    </MemoryRouter>
  )
}

beforeEach(() => {
  vi.mocked(api.petGrowth).mockResolvedValue(GROWTH)
  vi.mocked(api.tutorMastery).mockResolvedValue(MASTERY)
  vi.mocked(api.habitsToday).mockResolvedValue(HABITS)
  vi.mocked(api.workOutputs).mockResolvedValue({ outputs: OUTPUTS })
  vi.mocked(api.petPlugins).mockResolvedValue({
    plugins: [
      {
        name: 'water', label: '喝水提醒', enabled: true, permissions: [], commands: ['drink'],
        panel: { kind: 'counter', unit: '杯', target: 8, value: 2 }, quota: { used: 0, cap: 4 },
      },
      MOOD_PLUGIN,
    ],
  })
})

afterEach(cleanup)

describe('GrowthPage', () => {
  it('等级卡写累计与「正在靠近」，来源格子里是背后那几个真实的数', async () => {
    renderPage()
    expect(await screen.findByText('Lv.2')).toBeTruthy()
    expect(screen.getByText('同行')).toBeTruthy()
    expect(screen.getByText('累计 EXP 137')).toBeTruthy()
    expect(screen.getByText('正在靠近「顺手」')).toBeTruthy()
    expect(screen.getByText('+120')).toBeTruthy()
    expect(screen.getByText('掌握 3 个 · 教学 6 场')).toBeTruthy()
    expect(screen.getByText('跑成 1 次 · 交出 0 份')).toBeTruthy()
  })

  it('最近搞懂：列出概念，半懂过来的带标记', async () => {
    renderPage()
    expect(await screen.findByText('asyncio 事件循环')).toBeTruthy()
    expect(screen.getByText('从半懂到懂')).toBeTruthy()
    expect(screen.getByText('JS 闭包')).toBeTruthy()
  })

  it('坚持：有连续才写连续，累计天数一直在——不写「连续 0 天」', async () => {
    renderPage()
    expect(await screen.findByText('写代码')).toBeTruthy()
    expect(screen.getByText('连续 4 天')).toBeTruthy()
    expect(screen.getByText('累计 4 天')).toBeTruthy()
    // 没打过卡的那条只给累计，不给「连续 0 天」的欠债口吻
    expect(screen.getByText('读文档')).toBeTruthy()
    expect(screen.getByText('累计 0 天')).toBeTruthy()
    expect(screen.queryByText('连续 0 天')).toBeNull()
  })

  it('最近交出去：列出产出', async () => {
    renderPage()
    expect(await screen.findByText('给领导的汇报')).toBeTruthy()
    expect(screen.getByText('交付')).toBeTruthy()
  })

  it('心情：把记过的日子画一排，并说「最近 N 天」', async () => {
    renderPage()
    expect(await screen.findByText('心情')).toBeTruthy()
    expect(screen.getByText('最近 2 天')).toBeTruthy()
  })

  it('没有心情记录时，整段不出现（不摆空档）', async () => {
    vi.mocked(api.petPlugins).mockResolvedValue({
      plugins: [{ ...MOOD_PLUGIN, panel: { ...MOOD_PLUGIN.panel, value: 0, recent: [] } }],
    })
    renderPage()
    await screen.findByText('最近搞懂')
    expect(screen.queryByText('心情')).toBeNull()
  })

  it('什么都没有时给一句实话，不摆空档', async () => {
    vi.mocked(api.petGrowth).mockResolvedValue({
      level: 1, title: '初识', exp: 0, next_title: '同行', progress: 0,
      parts: [], counts: {},
    })
    vi.mocked(api.tutorMastery).mockResolvedValue({ events: [], mastered: 0, learning: 0, sessions: 0 })
    vi.mocked(api.habitsToday).mockResolvedValue({ ...HABITS, habits: [], pending: [] })
    vi.mocked(api.workOutputs).mockResolvedValue({ outputs: [] })
    vi.mocked(api.petPlugins).mockResolvedValue({ plugins: [] })
    renderPage()

    expect(await screen.findByText(/还没有积累/)).toBeTruthy()
    expect(screen.queryByText(/\+\d/)).toBeNull()
  })
})
