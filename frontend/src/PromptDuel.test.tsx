// 对打区（方案 §8.2 区2）：同一条提示词，几个模型谁答得好。
//
// 它从 `PromptLibrary` 拆出来独立成块，所以测试也独立——不必背库那一整套夹具。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

import PromptDuel from './PromptDuel'
import type { PromptItem, ProviderConfig } from './api'

vi.mock('./api', () => ({
  api: {
    listProviders: vi.fn(),
    arenaRun: vi.fn(),
    arenaSave: vi.fn(),
    // 历史对打清单（对打浏览器）：默认空表——「没存过」在界面上是一句实话
    listArenaRecords: vi.fn().mockResolvedValue({ records: [] }),
  },
}))

import { api } from './api'

function item(over: Partial<PromptItem> = {}): PromptItem {
  return {
    id: 1,
    title: '周报模板',
    content: '写给{读者}的周报，重点讲{主题}',
    created_at: '2026-09-01T10:00:00+00:00',
    updated_at: '',
    tags: [],
    category: '',
    favorite: false,
    rating: 0,
    source: '',
    note: '',
    used_count: 0,
    version_count: 0,
    last_vars: {},
    last_used_at: '',
    ...over,
  }
}

const PROVIDERS: ProviderConfig[] = [
  {
    id: 1,
    name: 'deepseek',
    kind: 'openai',
    base_url: '',
    api_key: '',
    api_key_set: true,
    models: ['deepseek-chat', 'deepseek-reasoner'],
    enabled: true,
  },
  {
    id: 2,
    name: 'off',
    kind: 'openai',
    base_url: '',
    api_key: '',
    api_key_set: true,
    models: ['should-not-show'],
    enabled: false,
  },
]

beforeEach(() => {
  vi.mocked(api.listProviders).mockResolvedValue(PROVIDERS)
})

afterEach(cleanup)

/** 对打区里有 `<Link>`（存成记录之后那条回执），所以**必须套 Router**——
 *  不套的话 react-router 直接抛，整棵树渲染不出来（症状是 body 空的）。 */
function renderDuel(prompts: PromptItem[] = [item()]) {
  return render(
    <MemoryRouter>
      <PromptDuel prompts={prompts} />
    </MemoryRouter>
  )
}

describe('PromptDuel · 对打区（§8.2 区2）', () => {
  it('默认收起：只摆标题与「开一局」，不占首屏', async () => {
    renderDuel()
    expect(screen.getByText('对打')).toBeTruthy()
    expect(screen.queryByLabelText('选提示词')).toBeNull()
    fireEvent.click(screen.getByText('开一局'))
    expect(await screen.findByLabelText('选提示词')).toBeTruthy()
  })

  it('模型候选来自**已启用**的 provider——关掉的那家不该出现在候选里', async () => {
    renderDuel()
    fireEvent.click(screen.getByText('开一局'))

    expect(await screen.findByText('deepseek-chat')).toBeTruthy()
    expect(screen.getByText('deepseek-reasoner')).toBeTruthy()
    expect(screen.queryByText('should-not-show')).toBeNull()
  })

  it('一个模型都不预选：预选会让「我到底比了哪两个」变成要回看的问题', async () => {
    renderDuel()
    fireEvent.click(screen.getByText('开一局'))
    await screen.findByText('deepseek-chat')

    // 「开打」在选够两个之前是禁用的
    expect((screen.getByText('开打') as HTMLButtonElement).disabled).toBe(true)
  })

  it('模型多选**上限 4 家**：选满之后没选中的那些点不动，并说清为什么（§三-1「2–4 个」）', async () => {
    // 结果区是 `xl:grid-cols-4`（§8.2 行2）——选到第 5 家会换行成两块，
    // 而「并排看」正是这一块的全部意义。
    vi.mocked(api.listProviders).mockResolvedValue([
      { ...PROVIDERS[0], models: ['m1', 'm2', 'm3', 'm4', 'm5'] },
    ])
    renderDuel()
    fireEvent.click(screen.getByText('开一局'))
    await screen.findByText('m1')

    for (const m of ['m1', 'm2', 'm3', 'm4']) fireEvent.click(screen.getByText(m))
    expect(screen.getByText('已选 4/4')).toBeTruthy()

    // 第 5 家：**点不动**（不是点得动却没反应），且标题里写着为什么
    const fifth = screen.getByText('m5') as HTMLButtonElement
    expect(fifth.disabled).toBe(true)
    expect(fifth.getAttribute('title')).toContain('最多比 4 家')

    // 取消一个之后它又能选了
    fireEvent.click(screen.getByText('m2'))
    expect(screen.getByText('已选 3/4')).toBeTruthy()
    expect((screen.getByText('m5') as HTMLButtonElement).disabled).toBe(false)
  })

  it('少于两个模型时明说理由，不去打', async () => {
    renderDuel()
    fireEvent.click(screen.getByText('开一局'))
    await screen.findByText('deepseek-chat')

    fireEvent.change(screen.getByLabelText('选提示词'), { target: { value: '1' } })
    fireEvent.click(screen.getByText('deepseek-chat')) // 只选一个
    // 按钮禁用时点不动，所以直接验它禁用 + 提示语
    expect((screen.getByText('开打') as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByTitle('至少选两个模型')).toBeTruthy()
  })

  it('开打：**提示词当 system、输入框当 user**，带上选中的模型（§8.2 区2）', async () => {
    vi.mocked(api.arenaRun).mockResolvedValue({
      results: [{ label: 'deepseek-chat', ok: true, text: 'A 的答案', seconds: 1.2 }],
    })
    renderDuel()
    fireEvent.click(screen.getByText('开一局'))
    await screen.findByText('deepseek-chat')

    fireEvent.change(screen.getByLabelText('选提示词'), { target: { value: '1' } })
    // 变量面板出现，填一个
    fireEvent.change(await screen.findByLabelText('变量 读者'), { target: { value: '领导' } })
    // 这一问——与提示词分开的那一段
    fireEvent.change(screen.getByLabelText('输入'), { target: { value: '这周做了什么' } })
    fireEvent.click(screen.getByText('deepseek-chat'))
    fireEvent.click(screen.getByText('deepseek-reasoner'))
    fireEvent.click(screen.getByText('开打'))

    // 位置参数：prompt（user）= 输入框；system = 填过的提示词正文；
    // 第 4 个是 AbortSignal（「不等了」用）——它每次都不同，所以单独判它的形状
    await waitFor(() =>
      expect(api.arenaRun).toHaveBeenCalledWith(
        '这周做了什么',
        ['deepseek-chat', 'deepseek-reasoner'],
        '写给领导的周报，重点讲{主题}',
        expect.any(AbortSignal)
      )
    )
  })

  it('「存成对打记录」：两段输入 + 各家结果一起交上去，存完给回执（§8.2 区2 行3）', async () => {
    // **存的是「对照记录」，不是「用例」**：评测区的金标集挂的是登记表里的系统提示词，
    // 库里的这些不在那张表里。存的是它本来的东西——这次比了什么、各家答了什么。
    const results = [
      { label: 'deepseek-chat', ok: true, text: 'A 的答案', seconds: 1.2, tokens_in: 5, tokens_out: 9 },
      { label: 'deepseek-reasoner', ok: false, error: '503', seconds: 0.1 },
    ]
    vi.mocked(api.arenaRun).mockResolvedValue({ results })
    vi.mocked(api.arenaSave).mockResolvedValue({ filename: 'prompts/duels/2026-09-25-x.md', chunks: 2 })
    renderDuel()
    fireEvent.click(screen.getByText('开一局'))
    await screen.findByText('deepseek-chat')
    fireEvent.change(screen.getByLabelText('选提示词'), { target: { value: '1' } })
    fireEvent.change(await screen.findByLabelText('变量 读者'), { target: { value: '领导' } })
    fireEvent.change(screen.getByLabelText('输入'), { target: { value: '这周做了什么' } })
    fireEvent.click(screen.getByText('deepseek-chat'))
    fireEvent.click(screen.getByText('deepseek-reasoner'))
    fireEvent.click(screen.getByText('开打'))
    await screen.findByText('A 的答案')

    fireEvent.click(screen.getByText('存成对打记录'))
    await waitFor(() =>
      expect(api.arenaSave).toHaveBeenCalledWith({
        title: '周报模板',
        system: '写给领导的周报，重点讲{主题}',
        prompt: '这周做了什么',
        results,
      })
    )
    // 回执带一条能点进去看原文的路（存了却找不着等于没存）
    const link = (await screen.findByText('prompts/duels/2026-09-25-x.md')) as HTMLAnchorElement
    expect(link.getAttribute('href')).toBe('/notes?path=prompts%2Fduels%2F2026-09-25-x.md')
  })

  it('每列摆「耗时 / token 小字」，上游没报 token 时**不写 0**（§8.2 区2 行2）', async () => {    vi.mocked(api.arenaRun).mockResolvedValue({
      results: [
        // 报了用量：两样都摆
        { label: 'a', ok: true, text: '答上来了', seconds: 1.2, tokens_in: 120, tokens_out: 340 },
        // 上游不回用量：只摆耗时——`0` 与「没报」是两件事
        { label: 'b', ok: true, text: '也答了', seconds: 2.0, tokens_in: null, tokens_out: null },
      ],
    })
    renderDuel()
    fireEvent.click(screen.getByText('开一局'))
    await screen.findByText('deepseek-chat')
    fireEvent.change(screen.getByLabelText('选提示词'), { target: { value: '1' } })
    fireEvent.click(screen.getByText('deepseek-chat'))
    fireEvent.click(screen.getByText('deepseek-reasoner'))
    fireEvent.click(screen.getByText('开打'))

    expect(await screen.findByText('1.2s · 120+340 tok')).toBeTruthy()
    // 没报用量的那一列**只有耗时**——不是「2s · 0+0 tok」
    expect(screen.getByText('2s').textContent).toBe('2s')
  })

  it('失败的那一列**照常占位**：删掉它「三家比」就变成「两家比」', async () => {
    vi.mocked(api.arenaRun).mockResolvedValue({
      results: [
        { label: 'a', ok: true, text: '答上来了', seconds: 1 },
        { label: 'b', ok: false, error: '503: 后端没起来', seconds: 0.2 },
      ],
    })
    renderDuel()
    fireEvent.click(screen.getByText('开一局'))
    await screen.findByText('deepseek-chat')
    fireEvent.change(screen.getByLabelText('选提示词'), { target: { value: '1' } })
    fireEvent.click(screen.getByText('deepseek-chat'))
    fireEvent.click(screen.getByText('deepseek-reasoner'))
    fireEvent.click(screen.getByText('开打'))

    expect(await screen.findByText('答上来了')).toBeTruthy()
    // 挂掉的那家照常有一列，原因写在它那一列里
    expect(screen.getByText('503: 后端没起来')).toBeTruthy()
    expect(screen.getByText('a')).toBeTruthy()
    expect(screen.getByText('b')).toBeTruthy()
  })

  it('拉不到模型清单时说清「去哪配」，而不是摆一个空的多选', async () => {
    vi.mocked(api.listProviders).mockResolvedValue([])
    renderDuel()
    fireEvent.click(screen.getByText('开一局'))
    expect(await screen.findByText(/去「设置 · 模型」配一家 provider/)).toBeTruthy()
  })
})
