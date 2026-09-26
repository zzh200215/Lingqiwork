// 仪表盘 · 北极星（PLAN §7）：周内「重讲作答 ≥1 且 消化材料 ≥1」的天数 / 7。
//
// 这一格的规矩全在那一张卡里，所以只测卡（`NorthStarCard` 是导出的）：
// 1. **口径从后端来**：界面上照抄，不自己编一份说法（同一个词两处必须是一个意思）；
// 2. **读不到 ≠ 什么都没发生**：不摆 0/0，也不用 0 充数；
// 3. **一句话都不催**：没有目标线、没有百分比、没有「还差 N 天」。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

// 只渲染卡片、不渲染整页：把 api 换成空的，模块引进来但一次都不会调
vi.mock('./api', () => ({ api: {} }))

import { NorthStarCard, CalibrationCard, GapRateCard, ProcessCard, SkillLoopCard, GroundedCard, TurnSummaryCard, SourceUsageCard, PromptEvalCard, AgentEvalCard } from './DashboardPage'
import type {
  AgentEvalBoard,
  CardCalibration,
  CardGapRate,
  EngineEvalLatest,
  NorthStar,
  PrereqAdoption,
  ProcessMetrics,
  PromptEvalBoard,
  SessionCalibration,
  SkillLoop,
  TurnSummary,
} from './api'

const RULES = {
  retell: '当天有重讲原文的复习记录（`card_reviews.retell` 非空）',
  digested: '当天拆出了新的点（`digest_points` 有新增行）',
  bias: '同一份材料重拆不新增行（按来源+点去重），那天就不算——派生指标的代价，不为它加事件表。',
}

/** 一条 7 天曲线：前几天各给一点，最后一天两件都发生。 */
function curve(patch: Partial<NorthStar> = {}): NorthStar {
  const days = [
    { date: '2026-09-10', retell: 2, digested: 0, counted: false },
    { date: '2026-09-11', retell: 0, digested: 3, counted: false },
    { date: '2026-09-12', retell: 1, digested: 1, counted: true },
    { date: '2026-09-13', retell: 0, digested: 0, counted: false },
    { date: '2026-09-14', retell: 1, digested: 0, counted: false },
    { date: '2026-09-15', retell: 0, digested: 2, counted: false },
    { date: '2026-09-16', retell: 1, digested: 1, counted: true },
  ]
  return {
    readable: true,
    error: '',
    window: { start: '2026-09-10', end: '2026-09-16', days: 7 },
    days,
    counted: 2,
    denominator: 7,
    rate: 0.286,
    rules: RULES,
    ...patch,
  }
}

afterEach(cleanup)

describe('北极星', () => {
  it('摆出那个数与七格，算数的那天标出来', () => {
    const { container } = render(<NorthStarCard n={curve()} />)
    expect(screen.getByText('2/7')).toBeTruthy()
    const cells = [...container.querySelectorAll('[data-north-star-day]')]
    expect(cells.map((el) => el.getAttribute('data-north-star-day'))).toEqual(
      curve().days.map((d) => d.date)
    )
    expect(cells.map((el) => el.getAttribute('data-counted'))).toEqual([
      '0',
      '0',
      '1',
      '0',
      '0',
      '0',
      '1',
    ])
    // 每一格的两条柱子带着那天的真数（两条都有才点亮）
    expect(cells[0].querySelector('[data-north-star-retell]')?.getAttribute('data-north-star-retell')).toBe('2')
    expect(cells[0].querySelector('[data-north-star-digested]')?.getAttribute('data-north-star-digested')).toBe('0')
    expect(cells[2].querySelector('[data-north-star-digested]')?.getAttribute('data-north-star-digested')).toBe('1')
  })

  it('口径照抄后端，不自己编一份说法', () => {
    const { container } = render(<NorthStarCard n={curve()} />)
    const rule = container.querySelector('[data-north-star-rule]')?.textContent ?? ''
    expect(rule).toContain(RULES.retell)
    expect(rule).toContain(RULES.digested)
    // 已知偏差也照抄：别让人拿这个数去对「我明明又看了一遍」
    expect(rule).toContain(RULES.bias)
  })

  it('读不到就说读不到——**不摆 0/0、不拿零充数**', () => {
    const { container } = render(
      <NorthStarCard n={curve({ readable: false, error: 'RuntimeError: db down', days: [], counted: 0, denominator: 0, rate: null })} />
    )
    expect(screen.getByText('—')).toBeTruthy()
    expect(screen.queryByText('0/0')).toBeNull()
    expect(container.querySelector('[data-north-star-count]')?.textContent).toBe('—')
    expect(screen.getByText(/读不出来/)).toBeTruthy()
    expect(container.querySelectorAll('[data-north-star-day]').length).toBe(0)
  })

  it('一天都没算数时只陈述，不催', () => {
    const flat = curve({
      days: curve().days.map((d) => ({ ...d, retell: 0, digested: 0, counted: false })),
      counted: 0,
      rate: 0,
    })
    const { container } = render(<NorthStarCard n={flat} />)
    expect(screen.getByText('0/7')).toBeTruthy()
    expect(container.querySelector('[data-north-star-empty]')).toBeTruthy()
    // 红线：不设目标、不排名、不催（百分比也不摆——「43%」会立刻变成考核）
    expect(container.textContent).not.toMatch(/还差|还欠|加油|目标|坚持|排名/)
    expect(container.textContent).not.toContain('29%')
  })

  it('还没读到就整块不渲染（别闪一个空壳）', () => {
    const { container } = render(<NorthStarCard n={null} />)
    expect(container.querySelector('[data-north-star]')).toBeNull()
  })
})

// 校准曲线（PLAN2 T2 · N1）：滚动 30 天，自评的档位分布 vs 判分器判的档位分布。
// 与北极星同一条纪律——**只画分布**（不设目标、不排名、不催），**读不到就说读不到**
// （不拿两条全零的分布充数），差值那一格写的是事实不是判决。
//
// `NOTES[0]` 是**判分器基线**（后端 `[_baseline_note(), *CALIB_NOTES]` 的第一条）：
// 它讲的是「这把尺子准不准」，所以界面上单独占一行、不复用页脚那个标记；
// 剩下两条才是页脚须知。
const BASELINE = '判分器还没有基线（金标集没做，PLAN2 P2-1）：读趋势和变化，不读绝对值。'
const NOTES = [
  'v9（judged 列）之前的历史行是「未知」，不进这条曲线。',
  '账本里没存提示词版本，所以换版之后旧行会跟着新指纹一起算；要真按 sha 分段得再存一列。',
]

function calib(patch: Partial<CardCalibration> = {}): CardCalibration {
  return {
    readable: true,
    error: '',
    days: 30,
    self_dist: { 1: 0, 2: 1, 3: 4, 4: 3 },
    judged_dist: { 1: 1, 2: 3, 3: 2, 4: 0 },
    delta: 1.5,
    n_self: 8,
    n_judged: 6,
    judge_sha: 'a1b2c3d4e5f6',
    segments: [
      { sha: 'a1b2c3d4e5f6', current: true, n: 4, dist: { 1: 0, 2: 2, 3: 2, 4: 0 }, mean: 2.5 },
      { sha: 'beefbeefbeef', current: false, n: 2, dist: { 1: 1, 2: 1, 3: 0, 4: 0 }, mean: 1.5 },
    ],
    mixed: false,
    notes: [BASELINE, ...NOTES],
    ...patch,
  }
}

describe('校准', () => {
  it('两条分布按四档摆出来，每一格带真数', () => {
    const { container } = render(<CalibrationCard c={calib()} />)
    const self = [...container.querySelectorAll('[data-calibration-self]')]
    const judged = [...container.querySelectorAll('[data-calibration-judged]')]
    expect(self.map((el) => el.getAttribute('data-calibration-self'))).toEqual(['1', '2', '3', '4'])
    expect(judged.map((el) => el.getAttribute('data-calibration-judged'))).toEqual(['1', '2', '3', '4'])
    // 柱子宽度按各自那一侧的最大值算（两条分布各自可读，不是同一个刻度）
    expect(self[2].getAttribute('style')).toContain('width: 100%') // 自评「良好」4 次 = 最大
    expect(judged[1].getAttribute('style')).toContain('width: 100%') // 判分「困难」3 次 = 最大
    expect(self[0].getAttribute('style')).toContain('width: 0%') // 没打过的档就是 0 宽
    expect(screen.getByText(/滚动 30 天 · 自评 8 · 判分 6/)).toBeTruthy()
  })

  it('差值写的是事实，不是判决；页脚两行原文照抄后端', () => {
    const { container } = render(<CalibrationCard c={calib()} />)
    expect(container.querySelector('[data-calibration-delta]')?.textContent).toBe('+1.5')
    expect(screen.getByText(/正数 = 给自己打的档更高/)).toBeTruthy()
    const notes = [...container.querySelectorAll('[data-calibration-note]')].map((el) => el.textContent)
    expect(notes).toEqual(NOTES)
    // **基线单独一行，不复用页脚那个标记**：它讲的是「这把尺子准不准」，
    // 与「这条曲线怎么读」是两件事（R1 把它从页脚第一条提上来的原因）
    expect(container.querySelector('[data-calibration-baseline]')?.textContent).toContain(BASELINE)
    expect(container.querySelectorAll('[data-calibration-note]').length).toBe(2)
    // **判分器指纹必须看得见**：这条曲线是按哪一版判分器算的
    expect(container.querySelector('[data-calibration-sha]')?.textContent).toBe('a1b2c3d4e5f6')
    // 红线：那句话永远不说出口（PLAN2 §8.5），也不催样本、不排名
    expect(container.textContent).not.toMatch(/高估|低估|你其实|还差|还欠|加油|目标|坚持|排名/)
    expect(container.textContent).not.toContain('%')
  })

  it('读不到分布时，判分器基线照样摆着——那正是最需要知道「尺子准不准」的时候', () => {
    const none = { 1: 0, 2: 0, 3: 0, 4: 0 }
    const { container } = render(
      <CalibrationCard
        c={calib({ readable: false, error: 'OperationalError: db down', self_dist: none, judged_dist: none, n_self: 0, n_judged: 0 })}
      />
    )
    expect(container.querySelector('[data-calibration-error]')?.textContent).toContain('db down')
    // 分布读不出来，但「这台判分器有没有基线」是另一条读数，不跟着一起消失
    expect(container.querySelector('[data-calibration-baseline]')?.textContent).toContain(BASELINE)
  })

  it('还没对过账 → delta 是 —，不是 0（0 是「你和它判得一样准」）', () => {
    const none = { 1: 0, 2: 0, 3: 0, 4: 0 }
    const { container } = render(
      <CalibrationCard c={calib({ delta: null, judged_dist: none, n_judged: 0, n_self: 3 })} />
    )
    expect(container.querySelector('[data-calibration-delta]')?.textContent).toBe('—')
    expect(container.querySelector('[data-calibration-empty]')).toBeNull() // 有自评行，不是空
  })

  it('一条都没有时只陈述，不催', () => {
    const none = { 1: 0, 2: 0, 3: 0, 4: 0 }
    const { container } = render(
      <CalibrationCard c={calib({ delta: null, self_dist: none, judged_dist: none, n_self: 0, n_judged: 0 })} />
    )
    expect(container.querySelector('[data-calibration-empty]')).toBeTruthy()
    expect(container.textContent).not.toMatch(/还差|还欠|加油|目标|坚持/)
  })

  it('读不到就说读不到——不拿两条全零的分布充数', () => {
    const { container } = render(
      <CalibrationCard
        c={calib({
          readable: false,
          error: 'OperationalError: db down',
          delta: null,
          self_dist: {},
          judged_dist: {},
          n_self: 0,
          n_judged: 0,
        })}
      />
    )
    expect(container.querySelector('[data-calibration-error]')?.textContent).toContain('db down')
    expect(container.querySelectorAll('[data-calibration-self]').length).toBe(0)
    expect(container.querySelector('[data-calibration-empty]')).toBeNull()
  })

  it('还没读到就整块不渲染（别闪一个空壳）', () => {
    const { container } = render(<CalibrationCard c={null} />)
    expect(container.querySelector('[data-calibration]')).toBeNull()
  })

  // PLAN2 §9.4：判分器换版之后，这条曲线上就不是一把尺子了。
  it('按判分器版本分段：本版 / 上一版 / 版本未知，各带条数与均值', () => {
    const { container } = render(<CalibrationCard c={calib()} />)
    const segs = [...container.querySelectorAll('[data-calibration-segment]')]
    expect(segs.map((el) => el.getAttribute('data-calibration-segment'))).toEqual([
      'a1b2c3d4e5f6',
      'beefbeefbeef',
    ])
    expect(segs[0].textContent).toContain('本版')
    expect(segs[0].textContent).toContain('4 条')
    expect(segs[0].textContent).toContain('均值 2.5')
    expect(segs[1].textContent).toContain('beefbe') // 上一版只露前六位
  })

  it('版本未知单独一格（不并进本版假装知道），混版那句警告也说得出来', () => {
    const mixed = calib({
      mixed: true,
      segments: [{ sha: '', current: false, n: 3, dist: { 1: 1, 2: 1, 3: 1, 4: 0 }, mean: 2.0 }],
      // 后端把混版那句插在 基线 之后（`notes.insert(0, ...)` 作用在 `CALIB_NOTES` 那个列表上），
      // 所以页脚第一行就是它——基线已经不在这个列表里了（它单独占一行）
      notes: [BASELINE, '这条曲线上的判分行来自不止一版判分器（本版 4 条、版本未知 3 条）——别把两把尺子当成一把量。', ...NOTES],
    })
    const { container } = render(<CalibrationCard c={mixed} />)
    expect(container.querySelector('[data-calibration-segment=""]')?.textContent).toContain('版本未知')
    const notes = [...container.querySelectorAll('[data-calibration-note]')].map((el) => el.textContent ?? '')
    expect(notes[0]).toContain('不止一版')
    expect(notes[0]).toContain('别把两把尺子当成一把量')
    // 混版警告与基线是两件事，能同时看到
    expect(container.querySelector('[data-calibration-baseline]')?.textContent).toContain(BASELINE)
  })

  // PLAN2 P2-3：会话侧那半——**自己标的** vs **让它判的**（挂在同一张卡上）。
  const SESSION: SessionCalibration = {
    readable: true,
    error: '',
    days: 90,
    self: { dist: { got: 12, half: 8, useless: 2 }, n: 20, rate: 0.6, ci: [0.37, 0.79], tell: true },
    judged: { dist: { got: 5, half: 13, useless: 1 }, n: 18, rate: 0.278, ci: [0.12, 0.51], tell: false },
    gap: 0.322,
    decidable: true,
    judge_sha: '6c6b1852e876',
    mixed: false,
    rules: {
      rate: '说通率 = 说通 /（说通 + 半懂）；「没用」不进分母（教学没成，证明不了水平）',
      window: '按**会话结束**的本地日的滚动窗口算（`ended_at`，它和 verdict 一起写）',
      confound: '两边的样本不是同一批会话：你可能把有把握的自己标、没把握的丢给它判。',
      small: '会话数比卡片少得多：两个比率的 95% Wilson 区间**不重叠**才算看得出来。',
    },
  }

  it('会话侧摆两个计数与一个差，并把「两边不是同一批会话」写在脸上', () => {
    const { container } = render(<CalibrationCard c={calib()} s={SESSION} />)
    const box = container.querySelector('[data-session-calibration]')
    expect(box?.querySelector('[data-session-self]')?.textContent).toBe('12/20')
    expect(box?.querySelector('[data-session-judged]')?.textContent).toBe('5/18')
    expect(box?.querySelector('[data-session-gap]')?.textContent).toBe('差 +0.322')
    // 口径（含那个混淆项）照抄后端，界面不自己编一份说法
    expect(box?.querySelector('[data-session-rule]')?.textContent).toContain('不是同一批会话')
    // 红线：不说「你高估了自己」，也不催样本
    expect(box?.textContent).not.toMatch(/高估|低估|你其实|还差|还欠|加油|目标|排名/)
  })

  it('没有会话侧数据就不摆那一段（也不摆一排 — 占地方）', () => {
    const { container } = render(<CalibrationCard c={calib()} />)
    expect(container.querySelector('[data-session-calibration]')).toBeNull()
  })

  it('一边还没用过「让它判」时，那一侧摆 —、差不给（不是把一边当 0）', () => {
    const { container } = render(
      <CalibrationCard
        c={calib()}
        s={{
          ...SESSION,
          judged: { dist: { got: 0, half: 0, useless: 0 }, n: 0, rate: null, ci: [0, 1], tell: false },
          gap: null,
          decidable: false,
          rules: { ...SESSION.rules, sample: '这个窗口下不了结论（说通率的 95% 区间还重叠着），如实摆着。' },
        }}
      />
    )
    const box = container.querySelector('[data-session-calibration]')
    expect(box?.querySelector('[data-session-judged]')?.textContent).toBe('—')
    expect(box?.querySelector('[data-session-gap]')?.textContent).toBe('差 —')
    expect(box?.querySelector('[data-session-rule]')?.textContent).toContain('下不了结论')
  })
})

// 双轨矛盾率（PLAN2 §6）：已掌握的概念里，名下的卡这些天还在重来的占多少。
// 这条数是本规划**要消灭的东西**——所以这张卡尤其不许催：没有目标线、没有「还差多少」，
// 分母为 0 时说「还没有数据」，不摆 0%。
const GAP_RULE =
  '分母 = 已掌握的概念数（说通 ×2，判据只有 `is_mastered` 那一个）；分子 = 其中' +
  '「同一个话题词的卡这些天判过重来」的概念数。**它降说明两条轨接上了**。'

function gap(patch: Partial<CardGapRate> = {}): CardGapRate {
  return {
    readable: true,
    error: '',
    days: 30,
    n: 1,
    denominator: 4,
    rate: 0.25,
    rule: GAP_RULE,
    ...patch,
  }
}

describe('双轨矛盾率', () => {
  /** 这张卡里有一个去学习地图的链接（那条数点得动），所以它需要一个 Router。 */
  const renderGap = (g: CardGapRate | null, a: PrereqAdoption | null = null) =>
    render(
      <MemoryRouter>
        <GapRateCard g={g} a={a} />
      </MemoryRouter>
    )

  it('只摆分子分母与窗口，口径照抄后端', () => {
    const { container } = renderGap(gap())
    expect(container.querySelector('[data-gap-rate-count]')?.textContent).toBe('1/4')
    expect(container.querySelector('[data-gap-rate-rule]')?.textContent).toBe(GAP_RULE)
    expect(screen.getByText(/这 30 天还在重来/)).toBeTruthy()
  })

  it('分母为 0 → 摆 — 并说清为什么，不摆 0/0、不摆 0%', () => {
    const { container } = renderGap(gap({ n: 0, denominator: 0, rate: null }))
    expect(container.querySelector('[data-gap-rate-count]')?.textContent).toBe('—')
    expect(screen.queryByText('0/0')).toBeNull()
    expect(container.querySelector('[data-gap-rate-empty]')).toBeTruthy()
  })

  it('这条数越接近 0 越好，但这一页一个字都不许催', () => {
    const { container } = renderGap(gap({ n: 0, denominator: 4, rate: 0 }))
    expect(container.querySelector('[data-gap-rate-count]')?.textContent).toBe('0/4')
    // 红线：不设目标、不排名、不催——这条数一旦被追，就会变成「把概念标回半懂」的动机
    expect(container.textContent).not.toMatch(/还差|还欠|加油|目标|坚持|排名|努力|继续|保持/)
    expect(container.textContent).not.toContain('25%')
  })

  it('读不到就说读不到', () => {
    const { container } = renderGap(
      gap({ readable: false, error: 'OperationalError: db down', rate: null })
    )
    expect(container.querySelector('[data-gap-rate-error]')?.textContent).toContain('db down')
  })

  // PLAN2 §6 第三条（回指采纳）：搁置卡的候选有没有人看——拉取式功能唯一的生死指标。
  const ADOPTION: PrereqAdoption = {
    readable: true,
    error: '',
    days: 90,
    n: 1,
    denominator: 4,
    rate: 0.25,
    rule: '分母 = 这 90 天里**翻过**「可能缺前置」候选的搁置卡数；分子 = 其中**真从候选点进去开了课**的卡数。',
    bias: '「翻过」由界面在真去取候选那一下记一笔：取候选失败的那次不会记进去，所以分母**只会偏小**。',
  }

  it('回指采纳摆两个卡数、口径与那条已知偏差', () => {
    const { container } = renderGap(gap(), ADOPTION)
    const box = container.querySelector('[data-adoption]')
    expect(box?.querySelector('[data-adoption-count]')?.textContent).toBe('1/4')
    expect(box?.querySelector('[data-adoption-rule]')?.textContent).toContain('只会偏小')
    expect(screen.getByText(/翻过「可能缺前置」的搁置卡里/)).toBeTruthy()
    // 红线：这条数的用途是「没人看就撤」，所以它尤其不许被追
    expect(box?.textContent).not.toMatch(/还差|还欠|加油|目标|坚持|排名|多用/)
  })

  it('一张都没翻过时说清分母为什么是 0，不摆 0/0', () => {
    const { container } = renderGap(gap(), { ...ADOPTION, n: 0, denominator: 0, rate: null })
    expect(container.querySelector('[data-adoption-count]')?.textContent).toBe('0/0')
    expect(container.querySelector('[data-adoption-empty]')).toBeTruthy()
  })

  it('没有这份数据就不摆那一段', () => {
    const { container } = renderGap(gap())
    expect(container.querySelector('[data-adoption]')).toBeNull()
  })

  it('还没读到就整块不渲染', () => {
    const { container } = renderGap(null)
    expect(container.querySelector('[data-gap-rate]')).toBeNull()
  })
})

// 过程指标（PLAN §7.2）：半懂率按周。与北极星同一条红线的第二条曲线。
// 这一格的规矩：**不摆百分比**（摆两个计数）、**空的一周是空的**（不是 0）、**一处都不催**。
const PROCESS_RULES = {
  half: '半懂率 = 那一周半懂的会话 / 那一周说通或半懂的会话（`tutor_sessions.verdict`）',
  useless: '「没用」不进任何一个分母：教学没成，证明不了水平',
  week: '按**会话开始的本地时刻**分周（周一零点起算）',
}

function weeks(): ProcessMetrics['weeks'] {
  return [
    { start: '2026-07-27', end: '2026-08-02', got: 0, half: 0, n: 0, rate: null, is_current: false },
    { start: '2026-08-03', end: '2026-08-09', got: 3, half: 1, n: 4, rate: 0.25, is_current: false },
    { start: '2026-08-10', end: '2026-08-16', got: 2, half: 2, n: 4, rate: 0.5, is_current: false },
    { start: '2026-08-17', end: '2026-08-23', got: 0, half: 0, n: 0, rate: null, is_current: false },
    { start: '2026-08-24', end: '2026-08-30', got: 4, half: 1, n: 5, rate: 0.2, is_current: false },
    { start: '2026-08-31', end: '2026-09-06', got: 1, half: 3, n: 4, rate: 0.75, is_current: false },
    { start: '2026-09-07', end: '2026-09-13', got: 5, half: 0, n: 5, rate: 0, is_current: false },
    { start: '2026-09-14', end: '2026-09-20', got: 1, half: 2, n: 3, rate: 0.667, is_current: true },
  ]
}

function process(patch: Partial<ProcessMetrics> = {}): ProcessMetrics {
  const w = weeks()
  const got = w.reduce((s, x) => s + x.got, 0)
  const half = w.reduce((s, x) => s + x.half, 0)
  return {
    readable: true,
    error: '',
    window: { start: '2026-07-27', end: '2026-09-20', weeks: 8 },
    weeks: w,
    totals: { got, half, n: got + half, rate: half / (got + half) },
    rules: PROCESS_RULES,
    ...patch,
  }
}

describe('过程指标（半懂率按周）', () => {
  it('摆八格与两个计数——**不摆百分比**', () => {
    const { container } = render(<ProcessCard p={process()} />)
    expect(container.querySelector('[data-process-total]')?.textContent).toBe('9 / 25')
    expect(container.querySelectorAll('[data-process-week]').length).toBe(8)
    // 每格标的是「半懂/共」，不是比率
    const labels = [...container.querySelectorAll('[data-process-week]')].map(
      (el) => el.textContent
    )
    expect(labels[1]).toContain('1/4')
    expect(labels[6]).toContain('0/5') // 全说通那一周：0 是真的 0
    // 红线：不摆百分比、不设目标、不催、不排名
    expect(container.textContent).not.toContain('%')
    expect(container.textContent).not.toMatch(/还差|还欠|加油|目标|坚持|排名|比上周|进步/)
  })

  it('空的一周是空的——不是 0（0 读作「这周全都说通了」）', () => {
    const { container } = render(<ProcessCard p={process()} />)
    const empty = container.querySelector('[data-process-week="2026-07-27"]')
    const real = container.querySelector('[data-process-week="2026-09-07"]')
    expect(empty?.getAttribute('data-rate')).toBe('') // null 与 0 在数据上就分得开
    expect(real?.getAttribute('data-rate')).toBe('0')
    expect(empty?.textContent).toContain('—')
    expect(empty?.querySelector('[data-process-bar]')?.getAttribute('title')).toContain(
      '没开过教学'
    )
  })

  it('一周都没开过教学时只陈述，不催', () => {
    const { container } = render(
      <ProcessCard
        p={process({
          weeks: weeks().map((w) => ({ ...w, got: 0, half: 0, n: 0, rate: null })),
          totals: { got: 0, half: 0, n: 0, rate: null },
        })}
      />
    )
    expect(container.querySelector('[data-process-total]')?.textContent).toBe('0 / 0')
    expect(container.querySelector('[data-process-empty]')).toBeTruthy()
    expect(container.textContent).not.toMatch(/还差|还欠|加油|目标|坚持/)
  })

  it('口径三行照抄后端，读不到就说读不到', () => {
    const { container } = render(<ProcessCard p={process()} />)
    const rule = container.querySelector('[data-process-rule]')?.textContent ?? ''
    expect(rule).toContain(PROCESS_RULES.half)
    expect(rule).toContain(PROCESS_RULES.useless)

    const broken = render(
      <ProcessCard
        p={process({ readable: false, error: 'OperationalError: db down', weeks: [], totals: { got: 0, half: 0, n: 0, rate: null } })}
      />
    )
    expect(broken.container.querySelector('[data-process-error]')?.textContent).toContain('db down')
    expect(broken.container.querySelectorAll('[data-process-week]').length).toBe(0)
    expect(broken.container.querySelector('[data-process-empty]')).toBeNull()
  })

  it('还没读到就整块不渲染', () => {
    const { container } = render(<ProcessCard p={null} />)
    expect(container.querySelector('[data-process]')).toBeNull()
  })
})

// ---------- 技能闭环（PLAN3 §6） ----------

const LOOP_RULES = {
  window: '被用过的次数是**窗口内**的：每个任务只留最近 20 条运行',
}
const INJECT_RULES = {
  bias: '这是观察性差异、不是对照：技能是因为话题相关才被注入的（自选择）',
  grounded: '接地分 0-5，只在「开了检索 + 命中材料 + 有产出」时才有；空着不是 0 分',
}

/** 技能闭环那张卡：三段计数 + 注入那一格。 `patch` 只覆盖关心的部分。 */
function loop(patch: Partial<SkillLoop> = {}): SkillLoop {
  return {
    funnel: {
      readable: true,
      error: '',
      window: 20,
      skills: [
        { name: '给领导写汇报要结论先行', used: 2, last_ts: 1_789_000_000, cases: 0, registered: false, stale: false },
        { name: '材料缺口分析', used: 0, last_ts: null, cases: 0, registered: false, stale: false },
      ],
      totals: { skills: 2, used: 2, with_cases: 0, cases: 0, registered: 0 },
    },
    funnel_rules: LOOP_RULES,
    injection: {
      readable: true,
      error: '',
      days: 30,
      runs: { total: 2, injected: 2, plain: 0 },
      grounded: { injected: { n: 0, mean: null }, plain: { n: 0, mean: null } },
      by_engine: [],
    },
    injection_rules: INJECT_RULES,
    ...patch,
  }
}

describe('SkillLoopCard（PLAN3 §6）', () => {
  it('漏斗摆三段计数与箭头，**不摆转化率**（三段数的是不同单位）', () => {
    const { container } = render(<SkillLoopCard s={loop()} />)
    expect(container.querySelector('[data-skill-funnel-total]')?.textContent).toBe('2 → 0 → 0')
    const rows = container.querySelectorAll('[data-skill-row]')
    expect(rows.length).toBe(2)
    expect(rows[0].textContent).toContain('2 次')
    expect(rows[0].textContent).toContain('还没量过')
    expect(container.textContent).not.toMatch(/%|转化率|目标|加油/)
  })

  it('注入那一格：只数引擎运行，接地分读不到就说读不到（不补 0）', () => {
    const { container } = render(<SkillLoopCard s={loop()} />)
    expect(container.querySelector('[data-skill-inject-total]')?.textContent).toBe('2 / 2')
    expect(container.querySelector('[data-skill-inject-grounded]')?.textContent).toContain('读不到')
    expect(container.querySelector('[data-skill-inject-grounded]')?.textContent).not.toContain('0（')
  })

  it('接地分读得出来时摆两个计数', () => {
    const s = loop()
    s.injection.grounded = { injected: { n: 2, mean: 4.5 }, plain: { n: 3, mean: 3.67 } }
    const { container } = render(<SkillLoopCard s={s} />)
    const line = container.querySelector('[data-skill-inject-grounded]')?.textContent ?? ''
    expect(line).toContain('4.5（2 次有分）')
    expect(line).toContain('3.67（3 次有分）')
  })

  it('一份草稿都没有时说清去哪弄一份，不摆空表', () => {
    const s = loop()
    s.funnel.skills = []
    s.funnel.totals = { skills: 0, used: 0, with_cases: 0, cases: 0, registered: 0 }
    const { container } = render(<SkillLoopCard s={s} />)
    expect(container.querySelector('[data-skill-funnel-empty]')).toBeTruthy()
    expect(container.querySelectorAll('[data-skill-row]').length).toBe(0)
  })

  it('一次引擎运行都没有时如实说，不摆 0/0 的对照', () => {
    const s = loop()
    s.injection.runs = { total: 0, injected: 0, plain: 0 }
    const { container } = render(<SkillLoopCard s={s} />)
    expect(container.querySelector('[data-skill-inject-empty]')).toBeTruthy()
    expect(container.querySelector('[data-skill-inject-grounded]')).toBeNull()
  })

  it('读不到就写读不到', () => {
    const s = loop()
    s.funnel.readable = false
    s.funnel.error = 'OperationalError: db down'
    s.funnel.skills = []
    const { container } = render(<SkillLoopCard s={s} />)
    expect(container.querySelector('[data-skill-funnel-error]')?.textContent).toContain('db down')
    expect(container.querySelector('[data-skill-funnel-total]')?.textContent).toBe('—')
  })

  it('口径三句照抄后端（窗口 / 观察性差异 / 接地分空着不是 0 分）', () => {
    const { container } = render(<SkillLoopCard s={loop()} />)
    const rule = container.querySelector('[data-skill-loop-rule]')?.textContent ?? ''
    expect(rule).toContain(LOOP_RULES.window)
    expect(rule).toContain(INJECT_RULES.bias)
    expect(rule).toContain(INJECT_RULES.grounded)
  })

  it('还没读到就整块不渲染', () => {
    const { container } = render(<SkillLoopCard s={null} />)
    expect(container.querySelector('[data-skill-loop]')).toBeNull()
  })
})

// ---------- R1（PLAN5 §3）：接地分 + 回合读数 ----------
//
// 这两条是「资产指标」那一段：量的是这台机器的零件还准不准。
// 与别的曲线同一条纪律——**读不到就说读不到**（不拿 0 充数）、**口径从后端来**、
// **一处都不催**；而回合读数多一条它自己的：**只给计数，不给成功率**。

/** 四个引擎，两个量到了分、一个只跑了结构判分、一个还没跑过。 */
function grounded(patch: Partial<EngineEvalLatest> = {}): EngineEvalLatest {
  return {
    by_engine: {
      research: { id: 3, engine: 'research', created_at: '2026-09-17T02:00:00+00:00', prompt_sha: 'aa', model_id: 'm', total: 8, structural: 0.88, grounded: 4.25, seconds: 60 },
      compose: { id: 2, engine: 'compose', created_at: '2026-09-16T02:00:00+00:00', prompt_sha: 'bb', model_id: 'm', total: 6, structural: 0.83, grounded: 3.5, seconds: 50 },
      // 只跑了结构判分 → grounded 是 null，**空着不是 0 分**
      decide: { id: 1, engine: 'decide', created_at: '2026-09-15T02:00:00+00:00', prompt_sha: 'cc', model_id: 'm', total: 5, structural: 1, grounded: null, seconds: 40 },
      recap: null,
    },
    coverage: { research: 8, compose: 6, decide: 5, recap: 4 },
    warnings: [],
    ...patch,
  }
}

const WARNING =
  '接地分全在 4.5 以上，分档压在顶部、区分度低——要接得住回归，得补「材料互相冲突」「材料明显不足」「材料里没有答案」这类刁用例'

describe('接地分（R1）', () => {
  it('四个引擎各摆各的分与条数，**不排座次**', () => {
    const { container } = render(<GroundedCard e={grounded()} />)
    const rows = [...container.querySelectorAll('[data-grounded-row]')]
    // 顺序就是后端给的顺序，不按分高低重排
    expect(rows.map((el) => el.getAttribute('data-grounded-row'))).toEqual([
      'research',
      'compose',
      'decide',
      'recap',
    ])
    const score = (k: string) =>
      container.querySelector(`[data-grounded-score="${k}"]`)?.textContent
    expect(score('research')).toBe('4.25')
    expect(score('compose')).toBe('3.50')
    // 只跑了结构判分 / 还没跑过 → 摆 —，**不补一个 0 分**
    expect(score('decide')).toBe('—')
    expect(score('recap')).toBe('—')
    expect(container.querySelector('[data-grounded-headline]')?.textContent).toBe('2/4')
    // 红线：不设目标、不排名、不给百分比
    expect(container.textContent).not.toMatch(/还差|还欠|加油|目标|坚持|排名|最好|最差/)
    expect(container.textContent).not.toContain('%')
  })

  it('每一行有一根 **0-5 的柱子**：按 score/5 落位，没量到分时是空的', () => {
    const { container } = render(<GroundedCard e={grounded()} />)
    const fill = (k: string) =>
      container.querySelector(`[data-grounded-scale="${k}"] > div`)?.getAttribute('style') ?? ''
    // 4.25 / 5 = 85%，3.50 / 5 = 70% —— 柱长是**算出来的**，不是一个凑的数
    // （jsdom 会把 `85.0%` 规整成 `85%`，所以这里比数值不比字面）
    expect(fill('research')).toContain('85%')
    expect(fill('compose')).toContain('70%')
    // 只跑了结构判分 / 还没跑过 → **整条轨道是空的**，不是半格、更不是一个 0 分的柱子
    expect(container.querySelector('[data-grounded-scale="decide"] > div')).toBeNull()
    expect(container.querySelector('[data-grounded-scale="recap"] > div')).toBeNull()
  })

  it('轨道上**没有目标线**——柱顶到头是「区分度低」，不是「达标」', () => {
    const { container } = render(<GroundedCard e={grounded({ warnings: [WARNING] })} />)
    // 这是这条读数最容易被下一个人"顺手加上"的东西（画一条 4.0 的虚线看着多专业），
    // 而它一旦出现，这面墙就从计量变成考核（§4-2）。所以钉住：整卡不许有 dashed/dotted。
    expect(container.innerHTML).not.toContain('dashed')
    expect(container.innerHTML).not.toContain('dotted')
    // 而且那句「柱顶到头不是好消息」必须写在口径里，免得柱长被读成成绩
    expect(container.querySelector('[data-grounded-rule]')?.textContent).toContain('不是好消息')
  })

  it('标尺自己的体检结论照抄后端——一个永远读满分的标尺等于没有标尺', () => {
    const { container } = render(<GroundedCard e={grounded({ warnings: [WARNING] })} />)
    const box = container.querySelector('[data-grounded-warnings]')
    expect(box?.textContent).toContain(WARNING)
    // 没有警告时那一块整个不摆（不是摆一句「一切正常」）
    const clean = render(<GroundedCard e={grounded()} />)
    expect(clean.container.querySelector('[data-grounded-warnings]')).toBeNull()
  })

  it('口径摆出来，而且明说「空着不是 0 分」', () => {
    const { container } = render(<GroundedCard e={grounded()} />)
    const rule = container.querySelector('[data-grounded-rule]')?.textContent ?? ''
    expect(rule).toContain('空着不是 0 分')
    expect(rule).toContain('材料里没有')
  })

  it('一次都没跑过时只陈述，不摆一排 — 的假表', () => {
    const { container } = render(
      <GroundedCard
        e={grounded({
          by_engine: { research: null, compose: null, decide: null, recap: null },
        })}
      />
    )
    expect(container.querySelector('[data-grounded-empty]')).toBeTruthy()
    expect(container.querySelector('[data-grounded-row]')).toBeNull()
    expect(container.textContent).not.toMatch(/还差|还欠|加油|目标|坚持/)
  })

  it('还没读到就整块不渲染（也不拿 0 充数）', () => {
    const { container } = render(<GroundedCard e={null} />)
    // **查的是 `data-metric` 的「值」，不是 `[data-grounded]` 这个属性名**：壳给的是
    // `data-metric="data-grounded"`，而 `[data-grounded]` 根本不存在——早先这条断言
    // 就是这么写的，于是它**永远为真**（真缺陷：首屏会闪一下「这条读数现在读不出来」）。
    expect(container.querySelector('[data-metric="data-grounded"]')).toBeNull()
    expect(container.textContent).toBe('')
  })
})

/** 一条回合读数：十二类毛病各有格子，这里只让三类非零。 */
function turnSummary(patch: Partial<TurnSummary> = {}): TurnSummary {
  const keys = [
    'lie',
    'no_save',
    'retried',
    'repaired',
    'invented_path',
    'dropped_receipt',
    'over',
    'rewrote',
    'multi',
    'slow',
    'expensive',
    'error',
  ]
  const counts: Record<string, number> = {}
  for (const k of keys) counts[k] = 0
  counts.lie = 2
  counts.slow = 5
  counts.no_save = 1
  return {
    readable: true,
    error: '',
    days: 30,
    turns: 14,
    total: 14,
    truncated: false,
    counts,
    // P3：材料那几个数。默认「有材料、也用了一些、其中一轮一条没引」
    sources: { turns_with_material: 6, injected: 28, cited: 11, uncited_turns: 1 },
    filters: [
      { key: 'lie', label: '声称存了没存', hint: '校验过的回合里，说了已存入但这一轮没落盘' },
      { key: 'no_save', label: '长正文没落盘', hint: '正文很长、却没有任何产出回执' },
      { key: 'slow', label: '慢', hint: '这一轮超过 10 秒' },
      { key: 'error', label: '出错', hint: '这一轮以错误结束' },
    ],
    rules: {
      window: '窗口 = 最近 N 天（默认 30 天）里落过账的聊天回合',
      counts: '每一格是「窗口内命中这一类毛病的回合数」，判据与逐条清单、与筛选项同一份实现',
      no_rate: '这里没有成功率：这个模块是诊断工具，不是考核仪表（不设目标、不排名、不催）',
      sources: '材料那几个数只数注入过材料的回合（注入 > 0）：没检索的回合注入本来就是 0',
      truncated: '库很大时只数最近 2000 轮（内存在此打住）——超了会标出来，不静默截断',
    },
    ...patch,
  }
}

describe('回合读数（R1）', () => {
  it('摆出分母与**只摆有过的**那几类毛病', () => {
    const { container } = render(<TurnSummaryCard t={turnSummary()} />)
    expect(container.querySelector('[data-turn-summary-headline]')?.textContent).toBe('14')
    const rows = [...container.querySelectorAll('[data-turn-count]')]
    expect(rows.map((el) => el.getAttribute('data-turn-count'))).toEqual(['lie', 'no_save', 'slow'])
    // 计数单独带标记（**不靠 textContent 的位置**：行里还有 label 与 hint，
    // 排版一动「以数字开头」这种断言就会挂——那测的是版式，不是数）
    const n = (k: string) => container.querySelector(`[data-turn-count-n="${k}"]`)?.textContent
    expect(n('lie')).toBe('2')
    expect(n('no_save')).toBe('1')
    expect(n('slow')).toBe('5')
    // 柱长读作「这一类占了多少轮」，分母是窗口里的回合数（14）：2/14 = 14.3%
    const bar = rows[0].querySelector('[style]')
    expect(bar?.getAttribute('style')).toContain('14.3%')
  })

  it('**没有成功率**：这一栏是诊断工具，不是考核仪表', () => {
    const { container } = render(<TurnSummaryCard t={turnSummary()} />)
    // 红线：一个比率都不摆（2/14 = 14% 这种最容易顺手加进来）。
    // 扫正文与标题区，不扫口径原文——那一行**故意**写着「这里没有成功率」。
    const surface = `${container.querySelector('[data-turn-summary-headline]')?.parentElement?.textContent ?? ''}${container.querySelector('[data-turn-summary-body]')?.textContent ?? ''}`
    expect(surface).not.toContain('%')
    expect(surface).not.toMatch(/成功率|通过率|健康度|得分|还差|还欠|加油|目标|排名/)
  })

  it('口径三句照抄后端，其中一句就是「这里没有成功率」', () => {
    const { container } = render(<TurnSummaryCard t={turnSummary()} />)
    const rule = container.querySelector('[data-turn-summary-rule]')?.textContent ?? ''
    expect(rule).toContain('没有成功率')
    expect(rule).toContain('诊断工具')
  })

  it('一例都没有时只陈述，不催', () => {
    const clean = turnSummary()
    for (const k of Object.keys(clean.counts)) clean.counts[k] = 0
    const { container } = render(<TurnSummaryCard t={clean} />)
    expect(container.querySelector('[data-turn-summary-clean]')).toBeTruthy()
    expect(container.querySelector('[data-turn-count]')).toBeNull()
    // 只扫**正文**：口径原文（`rules`）里正当地含「不设目标 / 不排名」这些字，扫全卡会误报
    const body = container.querySelector('[data-turn-summary-body]')?.textContent ?? ''
    expect(body).not.toMatch(/还差|还欠|加油|目标|坚持|排名/)
  })

  it('一轮都没聊过时说清为什么是空，不摆一排 0', () => {
    const none = turnSummary({ turns: 0, total: 0 })
    for (const k of Object.keys(none.counts)) none.counts[k] = 0
    const { container } = render(<TurnSummaryCard t={none} />)
    expect(container.querySelector('[data-turn-summary-empty]')).toBeTruthy()
    expect(container.textContent).toContain('还没有聊过天')
  })

  it('截断过就照实说：这个数是窗口的**下界**，不是全量', () => {
    const { container } = render(<TurnSummaryCard t={turnSummary({ turns: 2, total: 40, truncated: true })} />)
    expect(container.querySelector('[data-turn-summary-truncated]')?.textContent).toContain('下界')
    expect(container.querySelector('[data-turn-summary-truncated]')?.textContent).toContain('40')
  })

  it('读不到就说读不到——不拿一排 0 充数', () => {
    const broken = turnSummary({ readable: false, error: 'OperationalError: db down', turns: 0 })
    const { container } = render(<TurnSummaryCard t={broken} />)
    expect(container.querySelector('[data-turn-summary-error]')?.textContent).toContain('db down')
    expect(container.querySelector('[data-turn-summary-headline]')?.textContent).toBe('—')
    expect(container.querySelectorAll('[data-turn-count]').length).toBe(0)
  })

  it('还没读到就整块不渲染', () => {
    const { container } = render(<TurnSummaryCard t={null} />)
    // 与接地分那条同一个坑：属性名不存在的话，这条断言永远为真
    expect(container.querySelector('[data-metric="data-turn-summary"]')).toBeNull()
    expect(container.textContent).toBe('')
  })
})

describe('材料使用率（P3）', () => {
  it('摆四个计数：注入过材料的回合 / 一共注入 / 被引用 / 一条都没引用的', () => {
    const { container } = render(<SourceUsageCard t={turnSummary()} />)
    const n = (k: string) =>
      container.querySelector(`[data-source-count="${k}"]`)?.textContent ?? ''
    expect(n('turns')).toContain('6')
    expect(n('injected')).toContain('28')
    expect(n('cited')).toContain('11')
    expect(container.querySelector('[data-source-uncited]')?.textContent).toBe('1')
    // 标题行是「引用 / 注入」两个原始计数
    expect(container.querySelector('[data-source-usage-headline]')?.textContent).toBe('11/28')
  })

  it('**没有使用率**：一列数有了分母就会被当成 KPI 追', () => {
    const { container } = render(<SourceUsageCard t={turnSummary()} />)
    const body = container.querySelector('[data-source-usage-body]')?.textContent ?? ''
    expect(body).not.toContain('%')
    expect(body).not.toMatch(/使用率是|占比|命中率|得分|目标|还差/)
  })

  it('口径照抄后端那一句（分母为什么是「注入过材料的回合」）', () => {
    const { container } = render(<SourceUsageCard t={turnSummary()} />)
    expect(container.querySelector('[data-source-usage-rule]')?.textContent).toContain(
      '没检索的回合'
    )
  })

  it('一轮都没注入过材料时说清是空，不摆一排 0', () => {
    const none = turnSummary({
      sources: { turns_with_material: 0, injected: 0, cited: 0, uncited_turns: 0 },
    })
    const { container } = render(<SourceUsageCard t={none} />)
    expect(container.querySelector('[data-source-usage-empty]')).toBeTruthy()
    expect(container.textContent).toContain('没有一轮注入过材料')
  })

  it('读不到就说读不到——不拿一排 0 充数', () => {
    const broken = turnSummary({
      readable: false,
      error: 'OperationalError: db down',
      sources: { turns_with_material: 0, injected: 0, cited: 0, uncited_turns: 0 },
    })
    const { container } = render(<SourceUsageCard t={broken} />)
    expect(container.querySelector('[data-source-usage-error]')?.textContent).toContain('db down')
    expect(container.querySelector('[data-source-usage-headline]')?.textContent).toBe('—')
  })

  it('还没读到就整块不渲染', () => {
    const { container } = render(<SourceUsageCard t={null} />)
    expect(container.querySelector('[data-metric="data-source-usage"]')).toBeNull()
    expect(container.textContent).toBe('')
  })
})

function promptBoard(patch: Partial<PromptEvalBoard> = {}): PromptEvalBoard {
  return {
    readable: true,
    error: '',
    registered: 40,
    measured: 6,
    decidable: 2,
    stale: 1,
    cases: 41,
    rules: {
      registered: '分母 = 登记表里的提示词条数',
      measured: '分子 = 其中跑过 golden set、有成绩的条数',
      decidable: '「站得住」= Wilson 区间宽度 ≤ 0.34（`can_tell`）',
      stale: '「过期」= 基线跑完之后这条提示词的内容又改过（sha 变了）',
    },
    bias: '基线是**某一个模型**跑出来的（每行都记着 `model_id`）：换模型之后这个分数不适用。',
    ...patch,
  }
}

describe('提示词评测（R1 补齐）', () => {
  it('摆出「量过几条 / 登记几条」与三个计数', () => {
    const { container } = render(<PromptEvalCard p={promptBoard()} />)
    expect(container.querySelector('[data-prompt-eval-headline]')?.textContent).toBe('6/40')
    const n = (k: string) => container.querySelector(`[data-prompt-eval-${k}]`)?.textContent
    expect(n('decidable')).toBe('2')
    expect(n('stale')).toBe('1')
    expect(n('cases')).toBe('41')
  })

  it('**它不是排行榜**：不摆任何一条提示词的名字或分数，也不给条形图', () => {
    const { container } = render(<PromptEvalCard p={promptBoard()} />)
    const surface = `${container.querySelector('[data-prompt-eval-headline]')?.parentElement?.textContent ?? ''}${container.querySelector('[data-prompt-eval-body]')?.textContent ?? ''}`
    // 红线（§4-2）：不设目标、不排名、不催
    expect(surface).not.toMatch(/还差|还欠|加油|目标|排名|最好|最差|排行/)
    expect(surface).not.toContain('%') // 一个比率都不摆
    // 条形图会把三个计数变成「比长短」——这一格一条都不给
    expect(container.querySelectorAll('[data-prompt-eval-body] [style]').length).toBe(0)
  })

  it('口径与已知偏差照抄后端，不自己编一份说法', () => {
    const { container } = render(<PromptEvalCard p={promptBoard()} />)
    const rule = container.querySelector('[data-prompt-eval-rule]')?.textContent ?? ''
    expect(rule).toContain('Wilson')
    expect(rule).toContain('某一个模型')
  })

  it('一条都没跑过时说清去哪跑，不摆一排 0', () => {
    const { container } = render(
      <PromptEvalCard p={promptBoard({ measured: 0, decidable: 0, stale: 0, cases: 0 })} />,
    )
    expect(container.querySelector('[data-prompt-eval-empty]')).toBeTruthy()
    expect(container.textContent).toContain('提示词实验室')
    expect(container.querySelector('[data-prompt-eval-row]')).toBeNull()
  })

  it('读不到就说读不到——不拿一排 0 充数', () => {
    const broken = promptBoard({ readable: false, error: 'OperationalError: db down', measured: 0 })
    const { container } = render(<PromptEvalCard p={broken} />)
    expect(container.querySelector('[data-prompt-eval-error]')?.textContent).toContain('db down')
    expect(container.querySelector('[data-prompt-eval-headline]')?.textContent).toBe('—')
    expect(container.querySelector('[data-prompt-eval-row]')).toBeNull()
  })

  it('还没读到就整块不渲染（别闪一个空壳）', () => {
    const { container } = render(<PromptEvalCard p={null} />)
    // 与上面两条同一个坑：`[data-prompt-eval]` 是不存在的属性名，
    // 真属性是 `data-metric="data-prompt-eval"`
    expect(container.querySelector('[data-metric="data-prompt-eval"]')).toBeNull()
    expect(container.textContent).toBe('')
  })
})

function agentBoard(patch: Partial<AgentEvalBoard> = {}): AgentEvalBoard {
  return {
    readable: true,
    at: '2026-09-20 23:10:00',
    model_id: 'sensenova/sensenova-6.8-flash-lite',
    tasks: 19,
    tasks_sha: '7432ac9669fd',
    done: 19,
    done_rate: 1,
    clean: 12,
    floor_failures: 0,
    tool_not_allowed: 1,
    tool_not_used: 0,
    over_budget: 3,
    rounds: { median: 3, p90: 5, max: 7, mean: 3.68 },
    delegate_expected: 3,
    delegate_missed: 3,
    rules: { when: '这是**跑分当时**那一版金标的成绩', done: '完成率**不含轮数**' },
    ...patch,
  }
}

describe('任务级基线（A0 进计量局）', () => {
  it('摆出办成率与那几个数', () => {
    const { container } = render(<AgentEvalCard p={agentBoard()} />)
    expect(container.querySelector('[data-agent-eval-headline]')?.textContent).toBe('100%')
    const n = (k: string) => container.querySelector(`[data-agent-eval-${k}]`)?.textContent
    expect(n('done')).toBe('19/19')
    expect(n('clean')).toBe('12/19')
    expect(n('floor')).toBe('0')
    expect(n('delegate')).toBe('3/3')
  })

  it('**这一格读的是「跑分当时」的成绩**：时间、模型、金标指纹都得印在卡上', () => {
    const { container } = render(<AgentEvalCard p={agentBoard()} />)
    const stamp = container.querySelector('[data-agent-eval-stamp]')?.textContent ?? ''
    expect(stamp).toContain('2026-09-20 23:10:00')
    expect(stamp).toContain('sensenova/sensenova-6.8-flash-lite')
    expect(stamp).toContain('7432ac9669fd') // 没有它，读的人不知道这是哪一版金标的数
    expect(stamp).toContain('不可比')
  })

  it('报告里没有指纹时说清楚「这一格比不了」', () => {
    const { container } = render(<AgentEvalCard p={agentBoard({ tasks_sha: undefined, sha_missing: true })} />)
    expect(container.querySelector('[data-agent-eval-stamp]')?.textContent).toContain('比不了')
  })

  it('读不到就说读不到——不拿一排 0 充数', () => {
    const broken = agentBoard({ readable: false, error: '还没有跑过任务级基线', done_rate: undefined })
    const { container } = render(<AgentEvalCard p={broken} />)
    expect(container.querySelector('[data-agent-eval-error]')?.textContent).toContain('还没有跑过')
    expect(container.querySelector('[data-agent-eval-headline]')?.textContent).toBe('—')
    expect(container.querySelector('[data-agent-eval-row]')).toBeNull()
  })

  it('还没读到就整块不渲染', () => {
    const { container } = render(<AgentEvalCard p={null} />)
    expect(container.querySelector('[data-metric="data-agent-eval"]')).toBeNull()
    expect(container.textContent).toBe('')
  })

  it('口径原文来自后端（界面不自己编一句说法）', () => {
    const { container } = render(<AgentEvalCard p={agentBoard()} />)
    const rule = container.querySelector('[data-agent-eval-rule]')?.textContent ?? ''
    expect(rule).toContain('跑分当时')
    expect(rule).toContain('不含轮数')
  })
})
