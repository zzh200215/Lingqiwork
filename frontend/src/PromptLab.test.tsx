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
function renderLab(entry = '/work?tab=lab') {
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

  it('深链 ?prompt=<key> 直接打开那一条（技能卡就是这么跳过来的）', async () => {
    renderLab('/work?tab=lab&prompt=FEYNMAN_PROMPT')
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
// 形态（`/work?tab=form`）按 golden set 的 `domain` 把这套用例算进对应那根枝；这里写空
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
