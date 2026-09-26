// 报告页（方案 §8.1）：生成面板 + 报告清单 + 阅读视图。
//
// 它从 `WorkPage.tsx` 拆出来独立成域，所以测试也独立：直接渲染 `ReportPage`，
// 不必背 WorkPage 那一整套（任务/会议/候选/技能）的夹具。
//
// 原来的八条交付测试搬到这里，锚点按 §8.1 的新文案更新（「写一份交付」→「写一份报告」）；
// 另补三条新能力的：阅读视图（页内切换、不跳路由）、复制全文、导出 md。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

import ReportPage from './ReportPage'
import type { DeliverCatalogue, DeliverTemplate, WorkOutput } from './api'

vi.mock('./api', () => ({
  api: {
    deliverGenres: vi.fn(),
    deliverOutline: vi.fn(),
    deliverSave: vi.fn(),
    deliverTemplates: vi.fn(),
    deliverTemplateCreate: vi.fn(),
    deliverTemplateUpdate: vi.fn(),
    deliverTemplateDelete: vi.fn(),
    searchMaterial: vi.fn(),
    readNote: vi.fn(),
    qualityFeedback: vi.fn(),
  },
}))
vi.mock('./stream', () => ({ streamDeliver: vi.fn() }))
vi.mock('./AttachToThread', () => ({ default: () => <span data-testid="attach-stub">挂到…</span> }))
vi.mock('./FeedbackButtons', () => ({ default: () => <span data-testid="fb-stub">👍</span> }))

import { api } from './api'
import { streamDeliver } from './stream'

const CATALOGUE: DeliverCatalogue = {
  genres: [
    { id: 'weekly', label: '周报', long: true, custom: false },
    { id: 'email', label: '邮件短稿', long: false, custom: false },
    // 第二种长稿：换体裁那条用例要的是「长稿 → 长稿」，不然分不清是体裁变了还是模式变了
    { id: 'review', label: '评审意见', long: true, custom: false },
  ],
  audiences: [
    { id: 'self', label: '自己' },
    { id: 'leader', label: '领导' },
  ],
  default_genre: 'weekly',
  default_audience: 'self',
}

/** 存下一份模板之后的体裁列表：**自定义的追加在后面**（与后端 `all_genres` 同一个顺序）。 */
const TEMPLATE: DeliverTemplate = {
  id: 't-给老板的月报',
  label: '给老板的月报',
  prompt: '体裁：月报。按「本月成果 / 下月目标」两个小节写。',
  long: true,
}

const CATALOGUE_WITH_TEMPLATE: DeliverCatalogue = {
  ...CATALOGUE,
  genres: [...CATALOGUE.genres, { ...TEMPLATE, custom: true }],
}

const OUTPUTS: WorkOutput[] = [
  {
    kind: 'deliver',
    label: '交付',
    path: 'deliver/2026-09-12-weekly.md',
    title: '第 37 周周报',
    date: '2026-09-12',
    mtime: 300,
  },
  {
    kind: 'research',
    label: '研究',
    path: 'research/2026-09-12-asyncio.md',
    title: 'asyncio 事件循环',
    date: '2026-09-12',
    mtime: 200,
  },
]

const REPORT = {
  ok: true,
  report: {
    title: '第 37 周周报',
    sections: [{ heading: '结论', body: '先说结论 [1]' }],
    used: [1],
    sources: [{ n: 1, kind: 'kb', title: 'A', ref: 'notes/a.md' }],
    model_id: 'm',
    prompt_sha: 'abc123',
    genre: 'weekly',
    audience: 'self',
    outline: [],
  },
}

/** 假提纲。默认体裁「周报」是长稿，所以**每次生成前都会先出提纲**——见 `start()`。 */
const OUTLINE = {
  title: '第 37 周周报',
  sections: ['本周进展', '遇到的问题', '下周计划'],
  model_id: 'm',
}

function renderReport(over: { outputs?: WorkOutput[]; onError?: (m: string) => void } = {}) {
  const refresh = vi.fn()
  const onError = over.onError ?? vi.fn()
  const r = render(
    <MemoryRouter>
      <ReportPage
        newSignal={1}
        outputs={over.outputs ?? OUTPUTS}
        refresh={refresh}
        onError={onError}
      />
    </MemoryRouter>
  )
  return { ...r, refresh, onError }
}

beforeEach(() => {
  // **先 reset 再给默认值**：`mockResolvedValue` 不会清掉上一个用例排下的 `Once` 队列，
  // 于是「某个用例多排了一个没被消费的 Once」会漏进下一个用例，表现为随机失败。
  for (const m of [
    api.deliverGenres,
    api.deliverOutline,
    api.deliverTemplates,
    api.readNote,
  ]) {
    vi.mocked(m).mockReset()
  }
  vi.mocked(api.deliverGenres).mockResolvedValue(CATALOGUE)
  vi.mocked(api.deliverOutline).mockResolvedValue(OUTLINE)
  vi.mocked(api.readNote).mockResolvedValue({ path: '', content: '' })
  vi.mocked(api.deliverTemplates).mockResolvedValue([])
})

afterEach(cleanup)

/** 走一次完整的生成。默认体裁「周报」是**长稿**，所以先出提纲、再点头——
 *  这正是默认体裁下用户实际走的那条路（短稿那条见「短稿一键直出」那条用例）。 */
async function start(topic = '这周的 RAG') {
  fireEvent.change(screen.getByPlaceholderText('写什么？（例：这周的 RAG 调研）'), {
    target: { value: topic },
  })
  fireEvent.click(screen.getByText('出提纲'))
  fireEvent.click(await screen.findByText('就按这个写'))
}

describe('ReportPage · 生成面板（§8.1）', () => {
  /** `data-run-panel="写报告"` 那一格，以及它现在的 `data-phase`。
   *
   *  **判据钉在状态上，不钉中文文案**：阶段是状态、文案是表达。
   *  所以标题仍是「写报告」而不是「写报告」以外的什么——改标题要连这里一起改，这是有意的。 */
  const panel = () => document.querySelector('[data-run-panel="写报告"]') as HTMLElement | null
  const phase = () => panel()?.getAttribute('data-phase')

  it('「写一份报告」推来的信号把面板摊开，体裁与读者默认选中后端给的那组', async () => {
    renderReport()
    // 面板由 `newSignal` 展开；体裁×读者是**后端给的唯一真值**，所以等它到位
    expect(await screen.findByText('周报')).toBeTruthy()
    expect(screen.getByText('邮件短稿')).toBeTruthy()
    expect(screen.getByText('领导')).toBeTruthy()
  })

  it('六态走得出来，且**每一步都看得见是哪一态**（P1）', async () => {
    // 六个状态里 idle 不渲染，其余五态由 deliver 流的事件推着走：
    // gathering → planning，sources/writing → progress，draft → streaming，report → done。
    const seen: string[] = []
    // 每个阶段之间让出一次宏任务：React 的状态更新是批处理的，不让出的话
    // 五帧会在同一次提交里跑完，DOM 上只留最后一态——「每一态都渲染过」就没被验到。
    const step = async () => {
      await new Promise((r) => setTimeout(r, 0))
      seen.push(phase() ?? '不动')
    }

    vi.mocked(streamDeliver).mockImplementation(async (_t, _g, _a, onStage) => {
      await step() // planning：刚点下去、还没收到任何一帧
      onStage('gathering', {})
      await step()
      onStage('sources', {})
      await step() // progress：材料到手
      onStage('writing', {})
      await step()
      onStage('draft', { title: '第 37 周周报', sections: [{ heading: '结论', body: '先说结论' }] })
      await step() // streaming：正文边生成边渲染
      return REPORT
    })

    renderReport()
    await screen.findByText('周报')
    await start()

    await waitFor(() => expect(phase()).toBe('done'))
    expect(seen).toEqual(['planning', 'planning', 'progress', 'progress', 'streaming'])
    expect(screen.getByText('先说结论')).toBeTruthy()
  })

  it('状态行说得比「材料到手」多一点：**已找到 N 个来源**（§二-2）', async () => {
    // 「材料到手」这条状态行在「找到 1 条」和「找到 12 条」时一模一样，而 N 是这一帧
    // 的全部信息量。用一道闸门把这一趟停在 sources 之后，才看得到那句状态。
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    vi.mocked(streamDeliver).mockImplementation(async (_t, _g, _a, onStage) => {
      onStage('sources', { sources: [{ n: 1 }, { n: 2 }, { n: 3 }], kb: 3 })
      await gate
      return REPORT
    })
    renderReport()
    await screen.findByText('周报')
    await start()

    expect(await screen.findByText('已找到 3 个来源，开始写…')).toBeTruthy()
    release()
    await waitFor(() => expect(phase()).toBe('done'))
  })

  it('draft 帧报「正在写第 N 节」，**不编一个分母**（§二-2）', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    vi.mocked(streamDeliver).mockImplementation(async (_t, _g, _a, onStage) => {
      onStage('draft', {
        title: 'T',
        sections: [
          { heading: 'A', body: 'a' },
          { heading: 'B', body: 'b' },
        ],
      })
      await gate
      return REPORT
    })
    renderReport()
    await screen.findByText('周报')
    await start()

    // 最后那一节就是正被打字机式补全的那一节；整篇有几节要到收尾才知道
    expect(await screen.findByText('正在写第 2 节…')).toBeTruthy()
    release()
    await waitFor(() => expect(phase()).toBe('done'))
  })

  it('失败进 error：说清原因，并给一颗**能真重跑**的「重试」（P1）', async () => {
    vi.mocked(streamDeliver)
      .mockResolvedValueOnce({ ok: false, error: '模型 503' })
      .mockResolvedValueOnce(REPORT)
    renderReport()
    await screen.findByText('周报')
    await start()

    await waitFor(() => expect(phase()).toBe('error'))
    expect(panel()?.textContent).toContain('模型 503')

    fireEvent.click(screen.getByText('重试'))
    await waitFor(() => expect(phase()).toBe('done'))
    expect(vi.mocked(streamDeliver).mock.calls.length).toBe(2)
  })

  it('点了「停止」不算失败：不留红色错误，回到没跑过的样子（P1）', async () => {
    vi.mocked(streamDeliver).mockImplementation(
      (_t, _g, _a, _onStage, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
        })
    )
    renderReport()
    await screen.findByText('周报')
    await start()

    await waitFor(() => expect(phase()).toBe('planning'))
    fireEvent.click(screen.getByText('停止'))

    await waitFor(() => expect(panel()).toBeNull()) // 回到 idle：那一格根本不渲染
    expect(screen.queryByText(/abort/i)).toBeNull()
  })

  it('预览里看得见「本次注入」，点 👍 时把注入清单一起带上（S1）', async () => {
    vi.mocked(streamDeliver).mockImplementation(async (_t, _g, _a, onStage) => {
      onStage('skills', { skills: ['给领导写汇报要结论先行'], picked: [] })
      onStage('writing', {})
      return REPORT
    })
    vi.mocked(api.qualityFeedback).mockResolvedValue({ id: 1, kind: 'deliver', verdict: 'good' })
    renderReport()
    await screen.findByText('周报')
    await start()

    const line = await screen.findByText(/本次注入：给领导写汇报要结论先行/)
    expect(line.textContent).toContain('按话题匹配出来的工序')
  })

  it('生成：按选中的体裁×读者出稿，出稿后可存进 vault（并刷新清单）', async () => {
    vi.mocked(streamDeliver).mockResolvedValue(REPORT)
    vi.mocked(api.deliverSave).mockResolvedValue({
      filename: 'deliver/2026-09-12-weekly.md',
      title: '第 37 周周报',
      chunks: 3,
    })
    const { refresh } = renderReport()
    await screen.findByText('周报')

    fireEvent.click(screen.getByText('领导'))
    await start()
    expect(await screen.findByText('第 37 周周报')).toBeTruthy()

    fireEvent.click(screen.getByText('存进 vault'))
    await waitFor(() => expect(api.deliverSave).toHaveBeenCalled())
    // 交付落盘之后**要刷新清单**——不然刚写完的那份要等下次进页面才看得见
    await waitFor(() => expect(refresh).toHaveBeenCalled())
    // 回执带上「查看」回路（方案 §五 顺手修的一条）
    expect(await screen.findByText(/已写好《第 37 周周报》· 查看/)).toBeTruthy()
  })

  it('钉一条材料：搜到、钉住，生成时带上它（§4-14）', async () => {
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
    vi.mocked(streamDeliver).mockResolvedValue(REPORT)
    renderReport()
    await screen.findByText('周报')

    fireEvent.click(screen.getByText('＋ 钉一条材料'))
    fireEvent.change(screen.getByPlaceholderText('在你自己的材料里搜一条…'), {
      target: { value: '事件循环' },
    })
    fireEvent.click(screen.getByText('搜'))
    fireEvent.click(await screen.findByText('事件循环笔记'))
    expect(screen.getByText('事件循环笔记')).toBeTruthy()

    await start()
    await waitFor(() =>
      expect(streamDeliver).toHaveBeenCalledWith(
        '这周的 RAG',
        'weekly',
        'self',
        expect.any(Function),
        expect.anything(),
        ['notes/loop.md'],
        // 第 7 个参数是定稿的提纲（长稿那条路必带）——加参数时这条会红，是有意的
        OUTLINE.sections
      )
    )
  })

  it('材料搜不到**不等于**没搜到：搜索失败要说出来，不摆成「无结果」', async () => {
    vi.mocked(api.searchMaterial).mockRejectedValue(new Error('500: {"detail":"检索服务没起来"}'))
    const onError = vi.fn()
    renderReport({ onError })
    await screen.findByText('周报')

    fireEvent.click(screen.getByText('＋ 钉一条材料'))
    fireEvent.change(screen.getByPlaceholderText('在你自己的材料里搜一条…'), {
      target: { value: '事件循环' },
    })
    fireEvent.click(screen.getByText('搜'))

    await waitFor(() => expect(onError).toHaveBeenCalled())
    expect(onError.mock.calls[0][0]).toContain('检索服务没起来')
  })
})

describe('ReportPage · 提纲确认（§8.1 长稿那一模）', () => {
  const outlineBox = () => document.querySelector('[data-report-outline]') as HTMLElement | null
  const sectionInputs = () => screen.getAllByLabelText(/^第 \d+ 节$/) as HTMLInputElement[]

  it('长稿点「出提纲」：摆出提纲区，逐条**可改可删**，还能加一节', async () => {
    renderReport()
    await screen.findByText('周报')
    expect(outlineBox()).toBeNull() // 还没出提纲，那一格不占位

    fireEvent.change(screen.getByPlaceholderText('写什么？（例：这周的 RAG 调研）'), {
      target: { value: '这周的 RAG' },
    })
    fireEvent.click(screen.getByText('出提纲'))

    await screen.findByText('就按这个写')
    expect(sectionInputs().map((i) => i.value)).toEqual(['本周进展', '遇到的问题', '下周计划'])

    // 改一条
    fireEvent.change(sectionInputs()[0], { target: { value: '本周进展（RAG 那条线）' } })
    expect(sectionInputs()[0].value).toBe('本周进展（RAG 那条线）')

    // 删一条
    fireEvent.click(screen.getAllByTitle('删掉这一节')[1])
    expect(sectionInputs().map((i) => i.value)).toEqual(['本周进展（RAG 那条线）', '下周计划'])

    // 加一条
    fireEvent.click(screen.getByText('＋ 加一节'))
    expect(sectionInputs().length).toBe(3)
  })

  it('「就按这个写」把**定稿的**小节交给成文那一步', async () => {
    vi.mocked(streamDeliver).mockResolvedValue(REPORT)
    renderReport()
    await screen.findByText('周报')

    fireEvent.change(screen.getByPlaceholderText('写什么？（例：这周的 RAG 调研）'), {
      target: { value: '这周的 RAG' },
    })
    fireEvent.click(screen.getByText('出提纲'))
    await screen.findByText('就按这个写')

    // 删掉「遇到的问题」、另加一节「风险」——确认区改的东西必须真的走到成文那一步
    fireEvent.click(screen.getAllByTitle('删掉这一节')[1])
    fireEvent.click(screen.getByText('＋ 加一节'))
    fireEvent.change(sectionInputs()[2], { target: { value: '风险' } })
    fireEvent.click(screen.getByText('就按这个写'))

    await waitFor(() =>
      expect(streamDeliver).toHaveBeenCalledWith(
        '这周的 RAG',
        'weekly',
        'self',
        expect.any(Function),
        expect.anything(),
        [],
        ['本周进展', '下周计划', '风险']
      )
    )
  })

  it('「直接写」：不要提纲，照体裁默认结构写', async () => {
    vi.mocked(streamDeliver).mockResolvedValue(REPORT)
    renderReport()
    await screen.findByText('周报')

    fireEvent.change(screen.getByPlaceholderText('写什么？（例：这周的 RAG 调研）'), {
      target: { value: '这周的 RAG' },
    })
    fireEvent.click(screen.getByText('出提纲'))
    await screen.findByText('直接写')
    fireEvent.click(screen.getByText('直接写'))

    await waitFor(() => expect(streamDeliver).toHaveBeenCalled())
    expect(vi.mocked(streamDeliver).mock.calls[0][6]).toEqual([]) // 第 7 个参数：空 = 没走提纲
  })

  it('短稿一键直出：不调提纲接口，按钮就叫「生成」', async () => {
    vi.mocked(streamDeliver).mockResolvedValue(REPORT)
    renderReport()
    await screen.findByText('邮件短稿')

    fireEvent.click(screen.getByText('邮件短稿'))
    expect(screen.getByText('生成')).toBeTruthy() // 不是「出提纲」
    fireEvent.change(screen.getByPlaceholderText('写什么？（例：这周的 RAG 调研）'), {
      target: { value: '回个话' },
    })
    fireEvent.click(screen.getByText('生成'))

    await waitFor(() => expect(streamDeliver).toHaveBeenCalled())
    expect(api.deliverOutline).not.toHaveBeenCalled()
    expect(vi.mocked(streamDeliver).mock.calls[0][6]).toEqual([])
  })

  it('提纲出不来要**说出来**，不摆一份默认提纲顶上', async () => {
    vi.mocked(api.deliverOutline).mockRejectedValue(
      new Error('502: {"detail":"提纲没出来——默认模型不可用，或输出无法解析"}')
    )
    renderReport()
    await screen.findByText('周报')

    fireEvent.change(screen.getByPlaceholderText('写什么？（例：这周的 RAG 调研）'), {
      target: { value: '这周的 RAG' },
    })
    fireEvent.click(screen.getByText('出提纲'))

    const err = await screen.findByText(/提纲没出来/)
    expect(err.textContent).toContain('输出无法解析')
    // 编一份顶上会让人以为模型真看过他的题目——所以那一格根本不出现
    expect(outlineBox()).toBeNull()
  })

  it('题目改了之后那份提纲**过期**：说出来，不装作还算数', async () => {
    renderReport()
    await screen.findByText('周报')

    const topicInput = screen.getByPlaceholderText('写什么？（例：这周的 RAG 调研）')
    fireEvent.change(topicInput, { target: { value: '这周的 RAG' } })
    fireEvent.click(screen.getByText('出提纲'))
    await screen.findByText('就按这个写')
    expect(document.querySelector('[data-report-outline-stale]')).toBeNull()

    fireEvent.change(topicInput, { target: { value: '下周的评测' } })
    expect(await screen.findByText(/这份提纲是按「这周的 RAG」出的/)).toBeTruthy()
  })

  it('重试复用上一次定稿的提纲（不用再点一遍提纲）', async () => {
    vi.mocked(streamDeliver)
      .mockResolvedValueOnce({ ok: false, error: '模型 503' })
      .mockResolvedValueOnce(REPORT)
    renderReport()
    await screen.findByText('周报')
    await start()

    await screen.findByText('重试')
    fireEvent.click(screen.getByText('重试'))
    await waitFor(() => expect(vi.mocked(streamDeliver).mock.calls.length).toBe(2))

    // 两趟带的是同一份提纲：重试是「再写一次」，不是「换一份结构再写一次」
    expect(vi.mocked(streamDeliver).mock.calls[1][6]).toEqual(OUTLINE.sections)
  })

  it('换了体裁之后重试：不拿**别的体裁**的小节去写这一份', async () => {
    vi.mocked(streamDeliver)
      .mockResolvedValueOnce({ ok: false, error: '模型 503' })
      .mockResolvedValueOnce(REPORT)
    renderReport()
    await screen.findByText('周报')
    await start()
    await screen.findByText('重试')

    // 失败之后改主意：不写周报了，写一页纸提案。上一份提纲是周报的结构，不能跟着走
    fireEvent.click(screen.getByText('评审意见'))
    fireEvent.click(screen.getByText('重试'))
    await waitFor(() => expect(vi.mocked(streamDeliver).mock.calls.length).toBe(2))

    expect(vi.mocked(streamDeliver).mock.calls[1][1]).toBe('review')
    expect(vi.mocked(streamDeliver).mock.calls[1][6]).toEqual([])
  })
})

describe('ReportPage · 体裁模板（§8.1 行2）', () => {
  /** 选中的体裁 chip 会拿到 `KIND_BADGE.deliver`（青）。用**类名**判「选中了哪个」，
   *  不靠中文文案——文案是表达，选中是状态。 */
  const SELECTED = 'border-teal-300'
  const chip = (label: string) => screen.getByText(label).className

  it('内置体裁不给编辑入口——它是代码，界面上改不了', async () => {
    renderReport()
    await screen.findByText('周报')
    expect(screen.getByText('＋ 新建模板')).toBeTruthy()
    expect(screen.queryByText('编辑这份模板')).toBeNull()
  })

  it('自定义体裁用**虚线**区分，不靠颜色（颜色在这个仓里都是有语义的）', async () => {
    vi.mocked(api.deliverGenres).mockResolvedValue(CATALOGUE_WITH_TEMPLATE)
    renderReport()
    const custom = await screen.findByText('给老板的月报')

    expect(custom.className).toContain('border-dashed')
    expect(custom.getAttribute('title')).toBe('自定义模板')
    expect(chip('周报')).not.toContain('border-dashed')
    // 自定义的也是体裁：选上它照样给「出提纲」（它是长稿），也照样有编辑入口
    fireEvent.click(custom)
    expect(screen.getByText('编辑这份模板')).toBeTruthy()
    expect(screen.getByText('出提纲')).toBeTruthy()
  })

  it('新建模板：填名字与结构指令 → 存下来，出现在 chips 上并被选中', async () => {
    vi.mocked(api.deliverTemplateCreate).mockResolvedValue(TEMPLATE)
    vi.mocked(api.deliverGenres)
      .mockResolvedValueOnce(CATALOGUE) // 挂载时：还没有自定义模板
      .mockResolvedValue(CATALOGUE_WITH_TEMPLATE) // 存完之后重拉
    renderReport()
    await screen.findByText('周报')

    fireEvent.click(screen.getByText('＋ 新建模板'))
    fireEvent.change(screen.getByLabelText('模板名'), { target: { value: '给老板的月报' } })
    fireEvent.change(screen.getByLabelText('结构指令'), { target: { value: TEMPLATE.prompt } })
    fireEvent.click(screen.getByText('存成模板'))

    await waitFor(() =>
      expect(api.deliverTemplateCreate).toHaveBeenCalledWith({
        label: '给老板的月报',
        prompt: TEMPLATE.prompt,
        long: true, // 新建默认长稿
      })
    )
    // **存完就选上它**——你刚定义的那种体裁就是你要用的那种
    await waitFor(() => expect(chip('给老板的月报')).toContain(SELECTED))
    // 编辑器收起来（存完还摊着会让人以为没存上）
    expect(document.querySelector('[data-template-editor]')).toBeNull()
  })

  it('名字或结构指令空着时存不动——那颗按钮是禁用的', async () => {
    renderReport()
    await screen.findByText('周报')
    fireEvent.click(screen.getByText('＋ 新建模板'))

    const save = screen.getByText('存成模板') as HTMLButtonElement
    expect(save.disabled).toBe(true) // 两格都空

    fireEvent.change(screen.getByLabelText('模板名'), { target: { value: '月报' } })
    expect((screen.getByText('存成模板') as HTMLButtonElement).disabled).toBe(true) // 结构指令还空着

    fireEvent.change(screen.getByLabelText('结构指令'), { target: { value: '体裁：月报。' } })
    expect((screen.getByText('存成模板') as HTMLButtonElement).disabled).toBe(false)
  })

  it('存不进去就**说出来**（名字重了），不静默', async () => {
    vi.mocked(api.deliverTemplateCreate).mockRejectedValue(
      new Error('422: {"detail":"已经有叫「周报」的体裁了"}')
    )
    renderReport()
    await screen.findByText('周报')

    fireEvent.click(screen.getByText('＋ 新建模板'))
    fireEvent.change(screen.getByLabelText('模板名'), { target: { value: '周报' } })
    fireEvent.change(screen.getByLabelText('结构指令'), { target: { value: '体裁：随便' } })
    fireEvent.click(screen.getByText('存成模板'))

    const err = await screen.findByText(/已经有叫/)
    expect(err.textContent).toContain('周报')
    // 编辑器还摊着——错误就在那一格里，收起来用户就看不见为什么没存上
    expect(document.querySelector('[data-template-editor]')).not.toBeNull()
  })

  it('编辑：结构指令是**当场从盘上拉的**，不是 chips 那份列表里的副本', async () => {
    vi.mocked(api.deliverGenres).mockResolvedValue(CATALOGUE_WITH_TEMPLATE)
    vi.mocked(api.deliverTemplates).mockResolvedValue([TEMPLATE])
    vi.mocked(api.deliverTemplateUpdate).mockResolvedValue({ ...TEMPLATE, label: '月报（老板）' })
    renderReport()

    fireEvent.click(await screen.findByText('给老板的月报'))
    fireEvent.click(screen.getByText('编辑这份模板'))

    // `/genres` 那份列表**不带** prompt（chips 用不上），所以这一格只能来自 `/templates`
    await waitFor(() => expect(api.deliverTemplates).toHaveBeenCalled())
    await waitFor(() =>
      expect((screen.getByLabelText('结构指令') as HTMLTextAreaElement).value).toBe(TEMPLATE.prompt)
    )
    expect((screen.getByLabelText('模板名') as HTMLInputElement).value).toBe('给老板的月报')

    fireEvent.change(screen.getByLabelText('模板名'), { target: { value: '月报（老板）' } })
    fireEvent.click(screen.getByText('保存'))
    await waitFor(() =>
      expect(api.deliverTemplateUpdate).toHaveBeenCalledWith(TEMPLATE.id, {
        label: '月报（老板）',
        prompt: TEMPLATE.prompt,
        long: true,
      })
    )
  })

  it('删掉选中的模板：退回默认体裁，chips 上也没有了', async () => {
    vi.mocked(api.deliverGenres)
      .mockResolvedValueOnce(CATALOGUE_WITH_TEMPLATE)
      .mockResolvedValue(CATALOGUE) // 删完之后重拉
    vi.mocked(api.deliverTemplates).mockResolvedValue([TEMPLATE])
    vi.mocked(api.deliverTemplateDelete).mockResolvedValue({ deleted: TEMPLATE.id })
    renderReport()

    fireEvent.click(await screen.findByText('给老板的月报'))
    fireEvent.click(screen.getByText('编辑这份模板'))
    await screen.findByLabelText('结构指令')
    fireEvent.click(screen.getByText('删掉这份模板'))

    await waitFor(() => expect(api.deliverTemplateDelete).toHaveBeenCalledWith(TEMPLATE.id))
    await waitFor(() => expect(screen.queryByText('给老板的月报')).toBeNull())
    // **不留在那个 id 上**：它已经没有定义了，留着下一次生成会撞「unknown genre」
    await waitFor(() => expect(chip('周报')).toContain(SELECTED))
  })
})

describe('ReportPage · 报告清单（§8.1）', () => {
  it('清单为主体：体裁徽章、标题、路径、日期都在', async () => {
    renderReport()
    expect(await screen.findByText('第 37 周周报')).toBeTruthy()
    expect(screen.getByText('deliver/2026-09-12-weekly.md')).toBeTruthy()
    expect(screen.getByText('asyncio 事件循环')).toBeTruthy()
  })

  it('筛选按方案的四组给计数：全部 / 研究 / 成文 / 工作流', async () => {
    renderReport()
    await screen.findByText('第 37 周周报')
    expect(screen.getByText(/全部 2/)).toBeTruthy()
    expect(screen.getByText(/研究 1/)).toBeTruthy()
    expect(screen.getByText(/成文 1/)).toBeTruthy()
  })

  it('筛选真的筛掉别的', async () => {
    renderReport()
    await screen.findByText('第 37 周周报')
    fireEvent.click(screen.getByText(/研究 1/))
    expect(screen.queryByText('第 37 周周报')).toBeNull()
    expect(screen.getByText('asyncio 事件循环')).toBeTruthy()
  })

  it('一份都没有时说一句实话并给去处，而不是空白', async () => {
    renderReport({ outputs: [] })
    expect(await screen.findByText('还没有报告')).toBeTruthy()
    expect(screen.getByText(/点右上「写一份报告」起一份/)).toBeTruthy()
  })

  it('「改写成」「挂到…」**常显**——hidden 的元素不在 Tab 序列里，键盘够不着', async () => {
    renderReport()
    await screen.findByText('第 37 周周报')
    const rewrite = screen.getAllByText('改写成')[0]
    expect(rewrite.className).not.toContain('hidden')
    expect(rewrite.className).toContain('opacity-60')
  })

  it('改写成：拿这份当钉住材料，开生成面板换体裁重写（J4）', async () => {
    renderReport()
    fireEvent.click((await screen.findAllByText('改写成'))[0])

    // 面板摊开，题目与钉住材料都带上了这一份
    expect(await screen.findByText('周报')).toBeTruthy()
    const input = screen.getByPlaceholderText('写什么？（例：这周的 RAG 调研）') as HTMLInputElement
    expect(input.value).toContain('第 37 周周报')
  })
})

describe('ReportPage · 阅读视图（§8.1 阅读视图）', () => {
  const MD = '## 第 37 周周报\n\n### 结论\n\n先说结论 [1]\n\n### 进展\n\n做了 A\n'

  it('点清单行进阅读视图：页内切换，三栏（大纲 / 正文 / 引用）都在', async () => {
    vi.mocked(api.readNote).mockResolvedValue({ path: 'deliver/x.md', content: MD })
    renderReport()
    fireEvent.click(await screen.findByText('第 37 周周报'))

    expect(await screen.findByText('先说结论 [1]')).toBeTruthy()
    // 大纲在左栏（章节标题出现两次：正文一次、大纲一次）
    expect(screen.getAllByText('结论').length).toBeGreaterThanOrEqual(2)
    expect(screen.getByText('导出 md')).toBeTruthy()
    // 右边那句解释：这份读的是 vault 原文，没带来源表
    expect(screen.getByText(/没带来源表/)).toBeTruthy()
  })

  it('返回清单：回到列表，不再停在阅读视图', async () => {
    vi.mocked(api.readNote).mockResolvedValue({ path: 'deliver/x.md', content: MD })
    renderReport()
    fireEvent.click(await screen.findByText('第 37 周周报'))
    await screen.findByText('先说结论 [1]')

    fireEvent.click(screen.getByText('← 返回清单'))
    expect(await screen.findByText('asyncio 事件循环')).toBeTruthy()
  })

  it('正文读不出来要说出来，不摆一个空正文假装这份是空的', async () => {
    vi.mocked(api.readNote).mockRejectedValue(new Error('500: {"detail":"文件读不到"}'))
    renderReport()
    fireEvent.click(await screen.findByText('第 37 周周报'))

    const err = await screen.findByText(/正文读不出来/)
    expect(err.textContent).toContain('文件读不到')
  })

  it('文件在但内容是空的，也照实说（不当成「没有正文」）', async () => {
    vi.mocked(api.readNote).mockResolvedValue({ path: 'deliver/x.md', content: '' })
    renderReport()
    fireEvent.click(await screen.findByText('第 37 周周报'))
    expect(await screen.findByText(/读出来是空的/)).toBeTruthy()
  })
})

describe('ReportPage · 复制与导出（§8.1 操作行）', () => {
  beforeEach(() => {
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    })
  })

  it('复制全文把正文交给剪贴板', async () => {
    vi.mocked(api.readNote).mockResolvedValue({ path: 'deliver/x.md', content: '## 周报\n\n正文\n' })
    renderReport()
    fireEvent.click(await screen.findByText('第 37 周周报'))
    await screen.findByText('正文')

    fireEvent.click(screen.getByText('复制全文'))
    await waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith('## 周报\n\n正文\n')
    )
  })

  it('导出 md 走一条下载链接，文件名用标题', async () => {
    vi.mocked(api.readNote).mockResolvedValue({ path: 'deliver/x.md', content: '## 周报\n\n正文\n' })
    const createObjectURL = vi.fn(() => 'blob:x')
    const revokeObjectURL = vi.fn()
    Object.assign(URL, { createObjectURL, revokeObjectURL })
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

    renderReport()
    fireEvent.click(await screen.findByText('第 37 周周报'))
    await screen.findByText('正文')
    fireEvent.click(screen.getByText('导出 md'))

    expect(createObjectURL).toHaveBeenCalled()
    expect(click).toHaveBeenCalled()
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:x')
    click.mockRestore()
  })
})
