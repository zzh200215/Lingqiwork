// 实验室（Q1 的提示词对照台）：登记表列表 + 一条的全貌 + 一次对照的报告。
//
// 三条最该被钉住的不是渲染，是**态度**：
// 1. 这一页**不能改提示词**（内容只读——它是源码的事实，不是这里的配置）；
// 2. 区间宽就说宽，不给一个好看的比例；
// 3. 候选变体只出现在报告里，绝不回写登记表。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

import PromptLab from './PromptLab'
import type { PromptCheckReport, PromptRegistryEntry, PromptRegistryEntryDetail } from './api'

vi.mock('./api', () => ({
  api: {
    promptRegistry: vi.fn(),
    promptEntry: vi.fn(),
    checkPrompt: vi.fn(),
    cancelPromptCheck: vi.fn(),
    addPromptCase: vi.fn(),
    removePromptCase: vi.fn(),
    setPromptDomain: vi.fn(),
  },
}))
import { api } from './api'

function entry(patch: Partial<PromptRegistryEntry> = {}): PromptRegistryEntry {
  return {
    name: 'FEYNMAN_PROMPT',
    module: 'app.core.tutor',
    purpose: '费曼反转教学：用户讲，模型当那个没搞懂的学生 + 考官',
    kind: 'prompt',
    sha: 'abc123def456',
    bytes: 812,
    drifted: false,
    cases: 8,
    fixture: 'feynman.json',
    domain: '',
    baseline: {
      at: '2026-09-15T10:00:00',
      passed: 6,
      cases: 8,
      rate: 0.75,
      ci_low: 0.41,
      ci_high: 0.93,
      model_id: 'sensenova/flash-lite',
      stale: false,
    },
    ...patch,
  }
}

const DETAIL: PromptRegistryEntryDetail = {
  name: 'FEYNMAN_PROMPT',
  module: 'app.core.tutor',
  purpose: '费曼反转教学：用户讲，模型当那个没搞懂的学生 + 考官',
  kind: 'prompt',
  sha: 'abc123def456',
  content: '你在「费曼模式」里扮演一个聪明但没搞懂的 学生 + 考官。',
  fixture: 'feynman.json',
  note: '第一条对照',
  domain: '教学',
  case_kind: 'chat',
  cases: [
    {
      id: 'term-dropping',
      intent: '甩术语不解释：规则 2 要求他用大白话重说一遍',
      user: 'asyncio 事件循环就是 event loop。',
      checks: ['asks_a_question', 'asks_for_plain_language'],
    },
    {
      id: 'solid-first-try',
      intent: '一次就讲圆了：规则 7 应当请他给完全外行的人再讲一遍',
      user: '事件循环就是一个不停转的圈。',
      checks: ['asks_for_layperson'],
    },
  ],
  checks: [
    { name: 'asks_a_question', why: '规则 1「像一个真诚困惑的学生那样提问」' },
    { name: 'asks_for_plain_language', why: '规则 2「要求他用大白话重说一遍」' },
    { name: 'asks_for_layperson', why: '规则 7「给完全外行的人再讲一遍」' },
    { name: 'no_list', why: '规则 6「不要列清单」' },
  ],
  runs: [
    {
      id: 3,
      at: '2026-09-15T10:00:00',
      key: 'FEYNMAN_PROMPT',
      prompt_sha: 'abc123def456',
      variant_sha: '',
      variant_label: '',
      model_id: 'sensenova/flash-lite',
      cases: 8,
      passed: 6,
      rate: 0.75,
      ci_low: 0.41,
      ci_high: 0.93,
      seconds: 42,
      detail_json: '{}',
    },
  ],
}

const REPORT: PromptCheckReport = {
  key: 'FEYNMAN_PROMPT',
  module: 'app.core.tutor',
  purpose: DETAIL.purpose,
  kind: 'prompt',
  prompt_sha: 'abc123def456',
  variant_sha: '',
  variant_label: '',
  model_id: 'sensenova/flash-lite',
  total: 2,
  passed: 1,
  rate: 0.5,
  ci: [0.09, 0.91],
  tell: false,
  assertions: { total: 4, failed: 2 },
  seconds: 9.5,
  calls: 2,
  baseline: { at: '2026-09-15T10:00:00', passed: 6, total: 8, variant_label: '' },
  flips: [{ id: 'solid-first-try', was: true, now: false }],
  context: '空上下文（无召回 / 无材料 / 无画像）——上下文会显著改变行为',
  run_id: 4,
  cases: [
    {
      id: 'term-dropping',
      intent: '',
      user: 'asyncio 事件循环就是 event loop。',
      checks: ['asks_a_question', 'asks_for_plain_language'],
      passed: true,
      failed: [],
      reply: '那 control 交回 loop 的时候，谁记着这个函数？',
      chars: 22,
      seconds: 3,
      error: '',
    },
    {
      id: 'solid-first-try',
      intent: '',
      user: '事件循环就是一个不停转的圈。',
      checks: ['asks_for_layperson'],
      passed: false,
      failed: [{ name: 'asks_for_layperson', why: '规则 7「给完全外行的人再讲一遍」' }],
      reply: '所以它一直转？',
      chars: 7,
      seconds: 3,
      error: '',
    },
  ],
}

beforeEach(() => {
  vi.mocked(api.promptRegistry).mockResolvedValue({ prompts: [entry()], inline: [] })
  vi.mocked(api.promptEntry).mockResolvedValue(DETAIL)
  vi.mocked(api.checkPrompt).mockResolvedValue(REPORT)
})

afterEach(cleanup)

/** 实验室现在读 `?prompt=` 深链（技能卡跳过来的那条），所以测试得给它一个 Router。 */
function renderLab(entry = '/work?tab=eval') {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <PromptLab />
    </MemoryRouter>
  )
}

describe('PromptLab', () => {
  it('列出登记表，并给三种事实之一：有用例 / 没有基线 / 没有用例', async () => {
    vi.mocked(api.promptRegistry).mockResolvedValue({
      prompts: [
        entry(),
        entry({ name: 'CHAT_SYSTEM', module: 'app.core.pet', cases: 0, baseline: null }),
        entry({ name: 'FEYNMAN_PROMPT_X', cases: 8, baseline: null, sha: 'zzz' }),
      ],
      inline: [],
    })
    renderLab()
    expect(await screen.findByText('6/8 · 75%')).toBeTruthy()
    expect(screen.getByText('没有基线')).toBeTruthy()
    expect(screen.getByText('没有用例')).toBeTruthy()
    expect(screen.getByText('登记表 3 条')).toBeTruthy()
  })

  it('选一条：看到用例、断言（鼠标停上去是哪句话）、内容只读折叠', async () => {
    const { container } = renderLab()
    fireEvent.click(await screen.findByText('FEYNMAN_PROMPT'))
    await waitFor(() => expect(api.promptEntry).toHaveBeenCalledWith('FEYNMAN_PROMPT'))
    expect(await screen.findByText('golden set 2 条')).toBeTruthy()
    expect(screen.getByText('「asyncio 事件循环就是 event loop。」')).toBeTruthy()

    // 内容默认收着，点开才有——而且它是 <pre>（读，不是改）
    expect(container.querySelector('pre')).toBeNull()
    fireEvent.click(screen.getByText('看内容（只读）'))
    expect(container.querySelector('pre')?.textContent).toContain('费曼模式')
    expect(container.querySelector('textarea[readonly]')).toBeNull()
  })

  it('跑一次对照：k/n、Wilson、逐条结果与失败的那条断言为什么挂', async () => {
    const { container } = renderLab()
    fireEvent.click(await screen.findByText('FEYNMAN_PROMPT'))
    fireEvent.click(await screen.findByText('跑一次对照（已登记内容）'))

    await waitFor(() => expect(api.checkPrompt).toHaveBeenCalledWith('FEYNMAN_PROMPT', {}))
    const report = await waitFor(() => {
      const el = container.querySelector('[data-lab-report]')
      if (!el) throw new Error('还没有报告')
      return el
    })
    expect(report.textContent).toContain('1/2')
    expect(report.textContent).toContain('Wilson 9%–91%')
    expect(report.textContent).toContain('2 次调用')
    // 区间太宽就说太宽，不给一个好看的比例
    expect(report.textContent).toContain('区间太宽')
    // 失败的那条 + 它挂在哪句断言上（why 是后端给的，界面不抄）
    expect(report.textContent).toContain('asks_for_layperson')
    expect(report.textContent).toContain('规则 7')
    // 翻面也写出来
    expect(report.textContent).toContain('solid-first-try')
    // 重放边界写在报告里
    expect(report.textContent).toContain('空上下文')
  })

  it('逐条结果里摊着模型的原话——失败时人能自己看一眼', async () => {
    renderLab()
    fireEvent.click(await screen.findByText('FEYNMAN_PROMPT'))
    fireEvent.click(await screen.findByText('跑一次对照（已登记内容）'))
    await screen.findByText(/1\/2/)
    expect(screen.getByText('所以它一直转？')).toBeTruthy()
  })

  it('候选变体：报告标出「候选」，并明说它不会进登记表', async () => {
    const { container } = renderLab()
    fireEvent.click(await screen.findByText('FEYNMAN_PROMPT'))
    fireEvent.click(await screen.findByText(/拿一段候选变体比一比/))
    fireEvent.change(container.querySelector('textarea') as HTMLTextAreaElement, {
      target: { value: '你是考官。反问。' },
    })
    fireEvent.change(screen.getByPlaceholderText(/给它起个名字/), {
      target: { value: '试·极简版' },
    })
    vi.mocked(api.checkPrompt).mockResolvedValue({
      ...REPORT,
      variant_sha: 'v123',
      variant_label: '试·极简版',
    })
    fireEvent.click(await screen.findByText('跑候选变体'))

    await waitFor(() =>
      expect(api.checkPrompt).toHaveBeenCalledWith('FEYNMAN_PROMPT', {
        variant: '你是考官。反问。',
        variant_label: '试·极简版',
      })
    )
    const report = await waitFor(() => {
      const el = container.querySelector('[data-lab-report]')
      if (!el) throw new Error('还没有报告')
      return el
    })
    expect(report.textContent).toContain('候选 试·极简版')
  })

  it('没有用例的那条：跑不了，按钮是禁用的（不假装能跑）', async () => {
    vi.mocked(api.promptEntry).mockResolvedValue({ ...DETAIL, cases: [] })
    renderLab()
    fireEvent.click(await screen.findByText('FEYNMAN_PROMPT'))
    const btn = (await screen.findByText('跑一次对照（已登记内容）')) as HTMLButtonElement
    expect(btn.disabled).toBe(true)
  })

  it('登记表读不到时给一句话，不是空白页', async () => {
    vi.mocked(api.promptRegistry).mockRejectedValue(new Error('后端不在'))
    renderLab()
    expect(await screen.findByText(/读登记表出错了：后端不在/)).toBeTruthy()
  })

  it('跑到一半被停：**明说这不是一次跑分**，且不摆区间（§六 停止 → 真取消）', async () => {
    // 半趟的 k/n 会被读成「变差了」，而它只是被打断了。后端因此不落库、不给区间
    // （`rate: null` / `ci: null`）——这一条钉的是界面**不许把它读成一次成绩**。
    const { container } = renderLab()
    fireEvent.click(await screen.findByText('FEYNMAN_PROMPT'))
    vi.mocked(api.checkPrompt).mockResolvedValue({
      ...REPORT,
      total: 2,
      passed: 1,
      rate: null,
      ci: null,
      tell: false,
      stopped: true,
      planned: 7,
    })
    fireEvent.click(await screen.findByText('跑一次对照（已登记内容）'))

    const banner = await waitFor(() => {
      const el = container.querySelector('[data-lab-stopped]')
      if (!el) throw new Error('没有那条「停了」的横幅')
      return el
    })
    expect(banner.textContent).toContain('停在第 2/7 条')
    expect(banner.textContent).toContain('这不算一次跑分')
    // 区间为 null 时不许崩、也不许摆一个编出来的区间
    expect(container.querySelector('[data-lab-report]')?.textContent).not.toContain('Wilson')
  })

  it('点「停止」调的是后端那条真取消（不是只把界面停掉）', async () => {
    vi.mocked(api.cancelPromptCheck).mockResolvedValue({ stopped: false }) // 假装刚好已经跑完了
    renderLab()
    fireEvent.click(await screen.findByText('FEYNMAN_PROMPT'))

    // 让这一趟挂着不返回，才看得到「正在跑」那个面板
    vi.mocked(api.checkPrompt).mockReturnValue(new Promise(() => {}))
    fireEvent.click(await screen.findByText('跑一次对照（已登记内容）'))

    fireEvent.click(await screen.findByText('停止'))
    await waitFor(() => expect(api.cancelPromptCheck).toHaveBeenCalledWith('FEYNMAN_PROMPT'))
    // 后端说「没有在跑的」→ 不假装停成功，也不停在「正在停…」上
    await waitFor(() => expect(screen.getByText('停止')).toBeTruthy())
  })

  it('深链 ?prompt=<key> 直接打开那一条（技能卡就是这么跳过来的）', async () => {
    renderLab('/work?tab=eval&prompt=FEYNMAN_PROMPT')
    await waitFor(() => expect(api.promptEntry).toHaveBeenCalledWith('FEYNMAN_PROMPT'))
    expect(await screen.findByText('golden set 2 条')).toBeTruthy()
  })
})

// Q2 · 喂食：把一次真实踩到的输入变成一条用例。
//
// 这一组的分量在于：它是整个实验室里**唯一会写盘**的动作，而写的是**用例文件**——
// 提示词一个字节都不动。所以三条必须钉住：写进去的东西三样齐全、能删回来、明说要提交。
describe('PromptLab · 喂食', () => {
  async function openFeed(container: HTMLElement) {
    fireEvent.click(await screen.findByText('FEYNMAN_PROMPT'))
    await screen.findByText(/golden set 2 条/)
    fireEvent.click(screen.getByText('喂一条进来'))
    return container.querySelector('[data-lab-feed]') as HTMLElement
  }

  it('写输入 + 意图 + 勾断言 → 喂进金标集，并提醒这次改动要提交', async () => {
    vi.mocked(api.addPromptCase).mockResolvedValue({
      id: 'from-real-life',
      intent: '它该指出「串着跑」和「等的时候让出去」是两回事',
      user: '事件循环就是把协程塞进一个线程里串着跑。',
      checks: ['asks_a_question'],
    })
    const { container } = renderLab()
    const form = await openFeed(container)
    expect(form.textContent).toContain('feynman.json') // 写哪儿，先说明白
    expect(form.textContent).toContain('提示词本身一个字节都不动')

    fireEvent.change(container.querySelector('[data-lab-feed-user]') as HTMLTextAreaElement, {
      target: { value: '事件循环就是把协程塞进一个线程里串着跑。' },
    })
    fireEvent.change(container.querySelector('[data-lab-feed-intent]') as HTMLInputElement, {
      target: { value: '它该指出「串着跑」和「等的时候让出去」是两回事' },
    })
    fireEvent.click(container.querySelector('[data-lab-feed-check="asks_a_question"]') as HTMLElement)
    fireEvent.click(container.querySelector('[data-lab-feed-save]') as HTMLElement)

    await waitFor(() =>
      expect(api.addPromptCase).toHaveBeenCalledWith('FEYNMAN_PROMPT', {
        user: '事件循环就是把协程塞进一个线程里串着跑。',
        intent: '它该指出「串着跑」和「等的时候让出去」是两回事',
        checks: ['asks_a_question'],
      })
    )
    expect(await screen.findByText(/已喂进金标集：from-real-life/)).toBeTruthy()
    expect(screen.getByText(/记得提交/)).toBeTruthy()
  })

  it('三样缺一不可：没填全 / 没勾断言时，保存按钮是禁用的', async () => {
    const { container } = renderLab()
    await openFeed(container)
    const save = () => container.querySelector('[data-lab-feed-save]') as HTMLButtonElement
    expect(save().disabled).toBe(true)

    fireEvent.change(container.querySelector('[data-lab-feed-user]') as HTMLTextAreaElement, {
      target: { value: '一个真实输入' },
    })
    expect(save().disabled).toBe(true) // 缺意图
    fireEvent.change(container.querySelector('[data-lab-feed-intent]') as HTMLInputElement, {
      target: { value: '它当时应该怎样' },
    })
    expect(save().disabled).toBe(true) // 缺断言
    fireEvent.click(container.querySelector('[data-lab-feed-check="no_list"]') as HTMLElement)
    expect(save().disabled).toBe(false)
  })

  it('从报告里那一条喂：输入原样带过来，勾上它挂掉的那条断言', async () => {
    const { container } = renderLab()
    fireEvent.click(await screen.findByText('FEYNMAN_PROMPT'))
    fireEvent.click(await screen.findByText('跑一次对照（已登记内容）'))
    await screen.findByText(/1\/2/)

    fireEvent.click(
      container.querySelector('[data-lab-feed-from="solid-first-try"]') as HTMLElement
    )
    const user = container.querySelector('[data-lab-feed-user]') as HTMLTextAreaElement
    expect(user.value).toBe('事件循环就是一个不停转的圈。') // 原样，不重编
    const checked = container.querySelector('[data-lab-feed-check="asks_for_layperson"]')
    expect(checked?.className).toContain('violet') // 它挂掉的那条已勾上
  })

  it('删一条用例：先问一句，确认了才动文件', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    vi.mocked(api.removePromptCase).mockResolvedValue({
      key: 'FEYNMAN_PROMPT',
      removed: 'vague-analogy',
      left: 1,
    })
    const { container } = renderLab()
    fireEvent.click(await screen.findByText('FEYNMAN_PROMPT'))
    await screen.findByText(/golden set 2 条/)
    fireEvent.click(
      container.querySelector('[data-lab-case-drop="solid-first-try"]') as HTMLElement
    )
    await waitFor(() => expect(api.removePromptCase).toHaveBeenCalledWith('FEYNMAN_PROMPT', 'solid-first-try'))
    expect(confirmSpy).toHaveBeenCalled()
    confirmSpy.mockRestore()
  })

  it('喂食出错（比如忘勾断言被后端拦下）时照实说', async () => {
    vi.mocked(api.addPromptCase).mockRejectedValue(new Error('至少勾一条断言'))
    const { container } = renderLab()
    await openFeed(container)
    fireEvent.change(container.querySelector('[data-lab-feed-user]') as HTMLTextAreaElement, {
      target: { value: '输入' },
    })
    fireEvent.change(container.querySelector('[data-lab-feed-intent]') as HTMLInputElement, {
      target: { value: '意图' },
    })
    fireEvent.click(container.querySelector('[data-lab-feed-check="no_list"]') as HTMLElement)
    fireEvent.click(container.querySelector('[data-lab-feed-save]') as HTMLElement)
    expect(await screen.findByText(/至少勾一条断言/)).toBeTruthy()
  })
})

// Q3 · 领域：技能那一边**唯一**标领域的地方。
//
// 形态（`/work?tab=eval`）按 golden set 的 `domain` 把这套用例算进对应那根枝；这里写空
// 就等于这个领域没有技能。和喂食一样，写的是**用例文件**，提示词一个字节都不动。
describe('PromptLab · 领域', () => {
  /** 领域框（golden set 表头上那个）。等它真的出来再返回，别拿 null 去断言。 */
  async function domainBox(container: HTMLElement) {
    fireEvent.click(await screen.findByText('FEYNMAN_PROMPT'))
    await screen.findByText('golden set 2 条')
    return (await waitFor(() => {
      const el = container.querySelector('[data-lab-domain]')
      if (!el) throw new Error('领域框还没出来')
      return el as HTMLInputElement
    })) as HTMLInputElement
  }

  it('显示这套 golden set 的领域，改了就写回用例文件', async () => {
    vi.mocked(api.setPromptDomain).mockResolvedValue({ key: 'FEYNMAN_PROMPT', domain: '法律' })
    const { container } = renderLab()
    const input = await domainBox(container)
    await waitFor(() => expect(input.value).toBe('教学'))

    fireEvent.change(input, { target: { value: '法律' } })
    fireEvent.blur(input)
    await waitFor(() =>
      expect(api.setPromptDomain).toHaveBeenCalledWith('FEYNMAN_PROMPT', '法律')
    )
  })

  it('没改就不写盘——只是点进点出不该动文件', async () => {
    const { container } = renderLab()
    const input = await domainBox(container)
    await waitFor(() => expect(input.value).toBe('教学'))

    // 比的是**这次 blur 前后**的调用数，所以上一个用例留下了什么记录都不影响结论
    const before = vi.mocked(api.setPromptDomain).mock.calls.length
    fireEvent.blur(input)
    await Promise.resolve()
    expect(vi.mocked(api.setPromptDomain).mock.calls.length).toBe(before)
  })
})

// 判分型金标集（PLAN2 P2-1 · `JUDGE_SYSTEM`）：用例是「卡三样 + 重讲原文 + 人工档位」，
// 判据是人工档位而不是断言。界面上要说清两件事：**每个数是什么意思**（一致 / 差一档 /
// 高判低判），以及**有争议的那条不计分**。喂食表单在这套里不出现——它的用例没有断言可勾。
describe('PromptLab · 判分金标集（P2-1）', () => {
  const GRADE_DETAIL: PromptRegistryEntryDetail = {
    ...DETAIL,
    name: 'JUDGE_SYSTEM',
    module: 'app.core.retell',
    purpose: '重讲判分：把主人的重讲判成 1–4 档',
    kind: 'system',
    sha: 'a1b2c3d4e5f6',
    fixture: 'JUDGE_SYSTEM.json',
    note: '卡三样 + 重讲原文 + 人工档位',
    domain: '判分',
    case_kind: 'grade',
    checks: [],
    cases: [
      {
        id: 'await-归属说反了',
        intent: '流利但核心错——别被文风骗了',
        user: '',
        checks: [],
        front: 'await 到底把控制权交给了谁？',
        back: '交给事件循环。',
        excerpt: 'asyncio 是单线程事件循环……',
        retell: '交给操作系统，让操作系统调度一个空闲线程。',
        grade: 1,
      },
      {
        id: '重讲与题无关',
        intent: '两处口径撞车',
        user: '',
        checks: [],
        front: '为什么 SQLite 写入要加锁？',
        back: '因为单文件。',
        excerpt: '',
        retell: '我今天想说的是，学英语最好从听力开始。',
        grade: 0,
        contested: true,
        why: '标准那行说跑题→重来，判不了那行说与题无关→fallback',
      },
    ],
  }
  const GRADE_REPORT: PromptCheckReport = {
    ...REPORT,
    key: 'JUDGE_SYSTEM',
    kind: 'system',
    report_kind: 'grade',
    total: 35,
    passed: 21,
    rate: 0.6,
    ci: [0.44, 0.74],
    tell: true,
    near: 33,
    near_rate: 0.943,
    near_ci: [0.81, 0.99],
    over: 5,
    under: 9,
    fallback: 2,
    matrix: { '1': { '0': 1, '1': 4, '2': 1, '3': 0, '4': 0 }, '3': { '0': 0, '1': 0, '2': 4, '3': 8, '4': 0 } },
    contested: [{ id: '重讲与题无关', expect: 0, got: 1, why: '两处口径撞车' }],
    expect_source: '人工档位',
    cases: [
      {
        id: 'await-归属说反了',
        intent: '',
        user: '',
        checks: ['grade_matches'],
        passed: false,
        near: false,
        fallback: false,
        over: true,
        under: false,
        expect: 1,
        got: 3,
        label: '良好',
        failed: [{ name: 'grade_matches', why: '人工定「重来」，它判「良好」——**高判**' }],
        reply: '{"grade": "良好"}',
        chars: 0,
        seconds: 2,
        error: '',
      },
    ],
  }

  beforeEach(() => {
    vi.mocked(api.promptRegistry).mockResolvedValue({
      prompts: [{ ...entry(), name: 'JUDGE_SYSTEM', cases: 36, fixture: 'JUDGE_SYSTEM.json' }],
      inline: [],
    })
    vi.mocked(api.promptEntry).mockResolvedValue(GRADE_DETAIL)
    vi.mocked(api.checkPrompt).mockResolvedValue(GRADE_REPORT)
  })

  it('用例摊的是题面/答案/重讲与人工档位，且**没有喂食入口**', async () => {
    const { container } = renderLab()
    fireEvent.click(await screen.findByText('JUDGE_SYSTEM'))
    await screen.findByText('golden set 2 条')

    expect(screen.getByText(/await 到底把控制权交给了谁/)).toBeTruthy()
    expect(screen.getByText(/交给操作系统，让操作系统调度一个空闲线程/)).toBeTruthy()
    expect(container.querySelector('[data-lab-case-grade="await-归属说反了"]')?.textContent).toBe(
      '人工 重来'
    )
    // 有争议的那条：摆出来、标明为什么
    const contested = container.querySelector('[data-lab-case-grade="重讲与题无关"]')
    expect(contested?.textContent).toContain('人工 不判')
    expect(contested?.textContent).toContain('有争议')
    // 判分型没有断言可勾 → 界面上不给「喂一条进来」（后端也会拒）
    expect(container.querySelector('[data-lab-feed-open]')).toBeNull()
    // 入口和出口都不在界面上：条数有下限，一条条删会把整套跑到跑不动
    expect(container.querySelector('[data-lab-case-drop]')).toBeNull()
  })

  it('报告说的是档位的事：一致 / 差一档 / 高判低判 / 矩阵 / 有争议不计分', async () => {
    const { container } = renderLab()
    fireEvent.click(await screen.findByText('JUDGE_SYSTEM'))
    fireEvent.click(await screen.findByText('跑一次对照（已登记内容）'))
    await waitFor(() => expect(api.checkPrompt).toHaveBeenCalledWith('JUDGE_SYSTEM', {}))

    const report = await waitFor(() => {
      const el = container.querySelector('[data-lab-report]')
      if (!el) throw new Error('还没有报告')
      return el
    })
    expect(report.textContent).toContain('档位一致 21/35')
    expect(report.textContent).toContain('差一档内')
    expect(report.textContent).toContain('94%')
    expect(report.textContent).toContain('高判 5 / 低判 9')
    expect(report.textContent).toContain('说判不了 2')
    expect(report.textContent).toContain('矩阵')
    // 有争议那条：**不计分**这件事必须写在脸上
    expect(report.textContent).toContain('有争议、不计分')
    expect(report.textContent).toContain('不进 k/n')
    // 断言那套说法不该出现在判分报告里
    expect(report.textContent).not.toContain('断言 ')
  })
})
