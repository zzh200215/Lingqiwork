// 「提示词」库：找得到、改得动、拿得走、能变好。
//
// 这里钉的是**会悄悄错的地方**，不是「能不能渲染」：
// 复制时变量有没有真的被填、AI 的结果会不会绕过草稿直接落库、拉不到库时会不会
// 摆成一个空列表（拿「失败」冒充「没有」是本仓库点过名的毛病）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

vi.mock('./api', () => ({
  api: {
    listPrompts: vi.fn(),
    promptFacets: vi.fn(),
    promptCategories: vi.fn(),
    createPromptCategory: vi.fn(),
    updatePromptCategory: vi.fn(),
    deletePromptCategory: vi.fn(),
    createPrompt: vi.fn(),
    updatePrompt: vi.fn(),
    deletePrompt: vi.fn(),
    usePrompt: vi.fn(),
    promptVersions: vi.fn(),
    promptUsages: vi.fn(),
    restorePromptVersion: vi.fn(),
    exportPrompts: vi.fn(),
    importPrompts: vi.fn(),
    promptAiGenerate: vi.fn(),
    promptAiRefine: vi.fn(),
    promptAiVars: vi.fn(),
    // 对打区（§8.2 区2）挂载时会问「有哪些模型可选」——给空清单，
    // 于是它显示「还没有可用的模型」，不影响库本身的断言。
    listProviders: vi.fn().mockResolvedValue([]),
    arenaRun: vi.fn(),
  },
}))

import { api, type PromptItem } from './api'
import PromptLibrary from './PromptLibrary'
import { catColor, tagTone } from './PromptViews'

function item(over: Partial<PromptItem> = {}): PromptItem {
  return {
    id: 1,
    title: '周报模板',
    content: '写给{读者}的周报',
    created_at: '2026-09-01T10:00:00+00:00',
    updated_at: '',
    tags: ['写作'],
    category: '汇报',
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

const writeText = vi.fn()

beforeEach(() => {
  // **视图偏好存在 localStorage 里，用例之间会串味**：上一条把视图切成表格，
  // 下一条就从一个不是卡片的首屏开始，断言全找不到元素——而失败信息只会说
  // 「找不到某段文字」，看起来像组件坏了。测试之间不许互相带状态。
  localStorage.clear()
  writeText.mockReset().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
  })
  vi.mocked(api.listPrompts).mockResolvedValue([])
  vi.mocked(api.promptFacets).mockResolvedValue({
    categories: [],
    tags: [],
    total: 0,
    uncategorized: 0,
  })
  vi.mocked(api.exportPrompts).mockResolvedValue(undefined)
  vi.mocked(api.usePrompt).mockResolvedValue({ ok: true, used_count: 1 })
  vi.mocked(api.deletePrompt).mockResolvedValue({ ok: true })
  vi.mocked(api.promptUsages).mockResolvedValue([])
  vi.mocked(api.promptVersions).mockResolvedValue([])
})

afterEach(cleanup)

// ---------- 四种视图 ----------

describe('PromptLibrary · 视图', () => {
  it('默认是卡片；切到表格与文件夹会换一屏', async () => {
    vi.mocked(api.listPrompts).mockResolvedValue([item({ tags: ['写作', '周报'] })])
    render(<PromptLibrary />)
    await screen.findByText('周报模板')
    expect(document.querySelector('[data-prompt-list]')).toBeTruthy()

    fireEvent.click(screen.getByTitle('表格'))
    expect(document.querySelector('[data-prompt-table]')).toBeTruthy()
    expect(screen.getByText('提示词')).toBeTruthy() // 表头

    fireEvent.click(screen.getByTitle('文件夹'))
    expect(document.querySelector('[data-prompt-folders]')).toBeTruthy()
    expect(screen.getByText('1 个提示词')).toBeTruthy()

    fireEvent.click(screen.getByTitle('网格'))
    expect(document.querySelector('[data-prompt-grid]')).toBeTruthy()
  })

  it('视图选择记进 localStorage——你的偏好不该每次被重置', async () => {
    vi.mocked(api.listPrompts).mockResolvedValue([item()])
    render(<PromptLibrary />)
    await screen.findByText('周报模板')

    fireEvent.click(screen.getByTitle('表格'))
    expect(localStorage.getItem('prompt-view')).toBe('table')
  })

  it('**没选中任何一条时列表是整宽的**——右侧那半屏只在真有东西要看时才占', async () => {
    // 这一条钉的是一个真实的版面事故：照搬了 AI Gist 的「列表 + 详情」分栏，
    // 却没照搬「没选中时不占那半屏」的条件。结果列表被挤成窄条、右边空一大片，
    // 卡片标题都换了行——而所有功能测试照样全绿（它们不关心版面）。
    vi.mocked(api.listPrompts).mockResolvedValue([item()])
    render(<PromptLibrary />)
    await screen.findByText('周报模板')
    expect(document.querySelector('[data-prompt-split]')?.getAttribute('data-prompt-split')).toBe('0')

    fireEvent.click(screen.getByLabelText('编辑 周报模板'))
    expect(document.querySelector('[data-prompt-split]')?.getAttribute('data-prompt-split')).toBe('1')

    fireEvent.click(screen.getByText('关掉'))
    expect(document.querySelector('[data-prompt-split]')?.getAttribute('data-prompt-split')).toBe('0')
  })

  it('文件夹视图点一个文件夹 = 按它筛（不在这里就地展开）', async () => {
    vi.mocked(api.listPrompts).mockResolvedValue([
      item({ id: 1, title: '汇报的', category: '汇报' }),
      item({ id: 2, title: '教学的', category: '教学' }),
    ])
    vi.mocked(api.promptFacets).mockResolvedValue({
      categories: [
        { id: 1, name: '汇报', color: '', position: 1, count: 1 },
        { id: 2, name: '教学', color: '', position: 2, count: 1 },
      ],
      tags: [],
      total: 2,
      uncategorized: 0,
    })
    render(<PromptLibrary />)
    await screen.findByText('汇报的')

    fireEvent.click(screen.getByTitle('文件夹'))
    // 「汇报」在左导航里也有一个（那是筛选），所以**只在文件夹那一格里点**
    const folders = document.querySelector('[data-prompt-folders]') as HTMLElement
    fireEvent.click(within(folders).getByText('汇报'))

    // 切回卡片方便断言：只剩汇报那条
    fireEvent.click(screen.getByTitle('卡片'))
    expect(screen.getByText('汇报的')).toBeTruthy()
    expect(screen.queryByText('教学的')).toBeNull()
  })
})

// ---------- 左导航与排序 ----------

describe('PromptLibrary · 左导航与排序', () => {
  it('「最近使用」按时间排，不按次数——用过 9 次但半年前的不该排前面', async () => {
    vi.mocked(api.listPrompts).mockResolvedValue([
      item({ id: 1, title: '老的爱用', used_count: 9, last_used_at: '2026-03-01T00:00:00+00:00' }),
      item({ id: 2, title: '昨天用的', used_count: 1, last_used_at: '2026-09-23T00:00:00+00:00' }),
    ])
    render(<PromptLibrary />)
    await screen.findByText('老的爱用')

    fireEvent.click(within(screen.getByLabelText('提示词导航')).getByText('最近使用'))
    fireEvent.change(screen.getByLabelText('排序'), { target: { value: 'used' } })

    const cards = [...document.querySelectorAll('[data-prompt]')].map((n) => n.getAttribute('data-prompt'))
    expect(cards).toEqual(['2', '1'])
  })

  it('左导航的「最近使用」把从没用过的挡在外面', async () => {
    vi.mocked(api.listPrompts).mockResolvedValue([
      item({ id: 1, title: '用过的', last_used_at: '2026-09-20T00:00:00+00:00' }),
      item({ id: 2, title: '没用过的' }),
    ])
    render(<PromptLibrary />)
    await screen.findByText('用过的')

    fireEvent.click(within(screen.getByLabelText('提示词导航')).getByText('最近使用'))
    expect(screen.getByText('用过的')).toBeTruthy()
    expect(screen.queryByText('没用过的')).toBeNull()
  })

  it('高级筛选：标签与评分一起算，并给得出「清空」', async () => {
    vi.mocked(api.listPrompts).mockResolvedValue([
      item({ id: 1, title: '高分周报', tags: ['周报'], rating: 5 }),
      item({ id: 2, title: '低分周报', tags: ['周报'], rating: 1 }),
      item({ id: 3, title: '高分教学', tags: ['教学'], rating: 5 }),
    ])
    vi.mocked(api.promptFacets).mockResolvedValue({
      categories: [],
      tags: [
        { name: '周报', count: 2 },
        { name: '教学', count: 1 },
      ],
      total: 3,
      uncategorized: 3,
    })
    render(<PromptLibrary />)
    await screen.findByText('高分周报')

    fireEvent.click(screen.getByText(/高级筛选/))
    fireEvent.click(screen.getByText('#周报 (2)'))
    fireEvent.change(screen.getByLabelText('最低评分'), { target: { value: '5' } })

    expect(screen.getByText('高分周报')).toBeTruthy()
    expect(screen.queryByText('低分周报')).toBeNull()
    expect(screen.queryByText('高分教学')).toBeNull()

    fireEvent.click(screen.getByText('清空筛选'))
    expect(screen.getByText('低分周报')).toBeTruthy()
  })
})

// ---------- 分类管理 ----------

describe('PromptLibrary · 分类管理', () => {
  const withCats = () => {
    vi.mocked(api.listPrompts).mockResolvedValue([
      item({ id: 1, title: '汇报的', category: '汇报' }),
    ])
    vi.mocked(api.promptFacets).mockResolvedValue({
      categories: [{ id: 9, name: '汇报', color: '#3b82f6', position: 1, count: 1 }],
      tags: [],
      total: 1,
      uncategorized: 0,
    })
  }

  it('建一个分类：名字与颜色都交上去', async () => {
    withCats()
    vi.mocked(api.createPromptCategory).mockResolvedValue({
      id: 10,
      name: '工作提效',
      color: '#8b5cf6',
      position: 2,
      count: 0,
    })
    render(<PromptLibrary />)
    await screen.findByText('汇报的')

    fireEvent.click(screen.getByLabelText('分类管理'))
    fireEvent.change(screen.getByLabelText('分类名称'), { target: { value: '工作提效' } })
    fireEvent.click(screen.getByText('创建分类'))

    await waitFor(() => expect(api.createPromptCategory).toHaveBeenCalledWith('工作提效', '#8b5cf6'))
  })

  it('改名走 update（后端会连条目一起搬）', async () => {
    withCats()
    vi.mocked(api.updatePromptCategory).mockResolvedValue({
      id: 9,
      name: '汇报稿',
      color: '#3b82f6',
      position: 1,
      count: 1,
    })
    render(<PromptLibrary />)
    await screen.findByText('汇报的')

    fireEvent.click(screen.getByLabelText('分类管理'))
    fireEvent.click(screen.getByLabelText('编辑分类 汇报'))
    fireEvent.change(screen.getByLabelText('分类名 汇报'), { target: { value: '汇报稿' } })
    fireEvent.click(screen.getByText('存'))

    await waitFor(() =>
      expect(api.updatePromptCategory).toHaveBeenCalledWith(9, { name: '汇报稿', color: '#3b82f6' })
    )
  })

  it('删分类前把后果说清楚：**条目一条都不删，只退回未分类**', async () => {
    withCats()
    vi.mocked(api.deletePromptCategory).mockResolvedValue({ ok: true, uncategorized: 1 })
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<PromptLibrary />)
    await screen.findByText('汇报的')

    fireEvent.click(screen.getByLabelText('分类管理'))
    fireEvent.click(screen.getByLabelText('删除分类 汇报'))

    expect(confirmSpy).toHaveBeenCalled()
    expect(String(confirmSpy.mock.calls[0][0])).toContain('退回「未分类」')
    expect(String(confirmSpy.mock.calls[0][0])).toContain('一条都不会删')
    await waitFor(() => expect(api.deletePromptCategory).toHaveBeenCalledWith(9))
    confirmSpy.mockRestore()
  })
})

// ---------- 库 ----------

describe('PromptLibrary · 库', () => {
  it('空库说清楚「这里空着是什么」，而不是画一个空壳', async () => {
    render(<PromptLibrary />)
    expect(await screen.findByText('库里还没有提示词。')).toBeTruthy()
  })

  it('列出来的每条带分类、标签、用过几次——「用过」是后端聚合的，不是本地记的', async () => {
    vi.mocked(api.listPrompts).mockResolvedValue([
      item({ tags: ['写作', '周报'], used_count: 3, version_count: 2 }),
    ])
    render(<PromptLibrary />)

    expect(await screen.findByText('周报模板')).toBeTruthy()
    expect(screen.getByText('汇报')).toBeTruthy()
    expect(screen.getByText('#写作')).toBeTruthy()
    // 卡片底部那行是分散的几段，按整张卡找比按某一段找稳。
    // **旧版数不摆在卡片上**：那一行已经有分类/标签/评分/用过/日期，再加就挤了；
    // 它在你打开这条之后的「看历史」里（那才是你真正关心版本的时候）。
    const card = document.querySelector('[data-prompt="1"]') as HTMLElement
    expect(card.textContent).toContain('用过 3')
  })

  it('搜的是标题、正文和标签三处', async () => {
    vi.mocked(api.listPrompts).mockResolvedValue([
      item({ id: 1, title: '费曼讲法', content: '让模型当学生', tags: ['教学'] }),
      item({ id: 2, title: '周报模板', content: '写给 leader', tags: ['汇报'] }),
    ])
    render(<PromptLibrary />)
    await screen.findByText('费曼讲法')

    const box = screen.getByPlaceholderText('搜索提示词…')
    fireEvent.change(box, { target: { value: '学生' } })
    expect(screen.queryByText('周报模板')).toBeNull()
    expect(screen.getByText('费曼讲法')).toBeTruthy()

    fireEvent.change(box, { target: { value: '汇报' } })
    expect(screen.getByText('周报模板')).toBeTruthy()
    expect(screen.queryByText('费曼讲法')).toBeNull()

    fireEvent.change(box, { target: { value: '没这个词' } })
    expect(screen.getByText('没有符合条件的。')).toBeTruthy()
  })

  it('左导航的「收藏」与工具条那颗星是同一件事', async () => {
    vi.mocked(api.listPrompts).mockResolvedValue([
      item({ id: 1, title: '收藏的', favorite: true }),
      item({ id: 2, title: '没收藏的' }),
    ])
    render(<PromptLibrary />)
    await screen.findByText('没收藏的')

    fireEvent.click(screen.getByText('★ 收藏'))
    expect(screen.queryByText('没收藏的')).toBeNull()
    expect(document.querySelector('[data-prompt="1"]')).toBeTruthy()
  })

  it('头一次读库还没回来时说「正在读」——空白分不清「还没读到」和「库里是空的」', async () => {
    vi.mocked(api.listPrompts).mockReturnValue(new Promise(() => {}))
    render(<PromptLibrary />)

    expect(await screen.findByText('正在读你的库…')).toBeTruthy()
    expect(screen.queryByText('库里还没有提示词。')).toBeNull()
  })

  it('拉不到库就说读不到——**不摆成一个空列表**', async () => {
    vi.mocked(api.listPrompts).mockRejectedValue(new Error('500: 库炸了'))
    render(<PromptLibrary />)

    expect(await screen.findByText(/库拉不出来/)).toBeTruthy()
    expect(screen.queryByText('库里还没有提示词。')).toBeNull()
  })
})

// ---------- 复制与变量 ----------

describe('PromptLibrary · 复制', () => {
  it('没有变量的条目：直接复制，并记一次使用', async () => {
    vi.mocked(api.listPrompts).mockResolvedValue([item({ content: '没有变量' })])
    render(<PromptLibrary />)
    await screen.findByText('周报模板')

    fireEvent.click(screen.getByLabelText('复制 周报模板'))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('没有变量'))
    expect(api.usePrompt).toHaveBeenCalledWith(1, {})
  })

  it('有变量的条目：动作叫**填值使用**，弹表单，**填完再复制**（不是复制一份带 {占位符} 的）', async () => {
    vi.mocked(api.listPrompts).mockResolvedValue([item()])
    const { container } = render(<PromptLibrary />)
    await screen.findByText('周报模板')

    // 有变量 → 那个动作是「填值使用」；没变量的那条仍叫「复制」（下一条用例钉着）
    fireEvent.click(screen.getByLabelText('填值使用 周报模板'))
    // **弹窗**（§8.2 区1② 的原话），不是列表上方那块内联面板
    const modal = container.querySelector('[data-prompt-fill]') as HTMLElement
    expect(modal).toBeTruthy()
    expect(modal.getAttribute('role')).toBe('dialog')
    expect(await screen.findByText('✎ 填写 · 周报模板')).toBeTruthy()
    expect(writeText).not.toHaveBeenCalled()
    expect(screen.getByText('已填写 0/1')).toBeTruthy()

    fireEvent.change(await screen.findByLabelText('变量 读者'), {
      target: { value: 'leader' },
    })
    // **填进去之后长什么样，当场看得见**——这是这一屏最值得有的一步
    expect(await screen.findByText('写给leader的周报')).toBeTruthy()
    expect(screen.getByText('已填写 1/1')).toBeTruthy()

    fireEvent.click(screen.getByText('生成并复制'))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('写给leader的周报'))
    expect(api.usePrompt).toHaveBeenCalledWith(1, { 读者: 'leader' })
  })

  it('上次填过的值会预填——「下次复用不必重填」', async () => {
    vi.mocked(api.listPrompts).mockResolvedValue([item({ last_vars: { 读者: '团队' } })])
    render(<PromptLibrary />)
    await screen.findByText('周报模板')

    fireEvent.click(screen.getByLabelText('填值使用 周报模板'))
    const box = await screen.findByDisplayValue('团队')
    expect(box).toBeTruthy()
  })

  it('填值弹窗**按 Esc 关得掉**——键盘用户不能只有「点遮罩」一条路', async () => {
    // 仓里的约定（`QuickView` / `SelectionView` / `CommandPalette` … 11 处），
    // 而这一处是 2026-09-25 在真界面上按了下 Esc 才发现纹丝不动的。
    // 守卫在 `designRules.test.ts`（每个 role="dialog" 都得有 Escape），这条钉的是**真的关得掉**。
    vi.mocked(api.listPrompts).mockResolvedValue([item()])
    const { container } = render(<PromptLibrary />)
    await screen.findByText('周报模板')

    fireEvent.click(screen.getByLabelText('填值使用 周报模板'))
    expect(container.querySelector('[data-prompt-fill]')).toBeTruthy()

    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(container.querySelector('[data-prompt-fill]')).toBeNull())
  })

  it('剪贴板用不了就说出来，不当成复制成功', async () => {
    writeText.mockRejectedValue(new Error('denied'))
    vi.mocked(api.listPrompts).mockResolvedValue([item({ content: '没有变量' })])
    render(<PromptLibrary />)
    await screen.findByText('周报模板')

    fireEvent.click(screen.getByLabelText('复制 周报模板'))
    expect(await screen.findByText(/剪贴板用不了/)).toBeTruthy()
    expect(api.usePrompt).not.toHaveBeenCalled()
  })
})

// ---------- 编辑 ----------

describe('PromptLibrary · 编辑', () => {
  it('新建：标题与正文提交上去，标签按逗号拆成数组', async () => {
    vi.mocked(api.createPrompt).mockResolvedValue(item({ id: 9, title: '新的一条' }))
    render(<PromptLibrary />)
    await screen.findByText('库里还没有提示词。')

    fireEvent.click(screen.getByRole('button', { name: '＋ 新建提示词' }))
    fireEvent.change(screen.getByPlaceholderText('给它起个一眼能认的名字'), {
      target: { value: '新的一条' },
    })
    fireEvent.change(screen.getByPlaceholderText('写作, 周报'), {
      target: { value: '写作，周报, 写作' },
    })
    // 正文那个 textarea 没有 placeholder，按标签文字找它
    const body = document.querySelector('textarea') as HTMLTextAreaElement
    fireEvent.change(body, { target: { value: '正文' } })

    fireEvent.click(screen.getByText('存进库'))
    await waitFor(() => expect(api.createPrompt).toHaveBeenCalled())
    const payload = vi.mocked(api.createPrompt).mock.calls[0][0]
    expect(payload.title).toBe('新的一条')
    expect(payload.content).toBe('正文')
    // 前端只做形状转换；**去重与全角逗号是后端 `_tags_of` 那一处的事**（后端测试钉它）
    expect(payload.tags).toEqual(expect.arrayContaining(['写作，周报', '写作']))
  })

  it('标题空着不提交，并且说明为什么', async () => {
    render(<PromptLibrary />)
    await screen.findByText('库里还没有提示词。')

    fireEvent.click(screen.getByRole('button', { name: '＋ 新建提示词' }))
    const body = document.querySelector('textarea') as HTMLTextAreaElement
    fireEvent.change(body, { target: { value: '有正文没标题' } })
    fireEvent.click(screen.getByText('存进库'))

    expect(await screen.findByText(/标题不能空/)).toBeTruthy()
    expect(api.createPrompt).not.toHaveBeenCalled()
  })

  it('正文里写下的 {变量} 当场列出来——填的时候问的正是这几个', async () => {
    render(<PromptLibrary />)
    await screen.findByText('库里还没有提示词。')

    fireEvent.click(screen.getByRole('button', { name: '＋ 新建提示词' }))
    const body = document.querySelector('textarea') as HTMLTextAreaElement
    fireEvent.change(body, { target: { value: '写给{读者}的{周数}周报' } })

    expect(await screen.findByText('会问到的变量：{读者} {周数}')).toBeTruthy()
  })

  it('**卡片正文不能放进 button 里**——那会让 line-clamp 当场失效、整段正文全摊开', async () => {
    // 这是一个只在真浏览器里才看得见的坑，功能测试全绿也照样发生：
    // Chrome 把 `<button>` 的内容包进一个匿名 flex 容器，里面的 `<p>` 成了 flex item，
    // `display:-webkit-box` 被 blockify 成 `block`，`-webkit-line-clamp` 就此失效
    // （顺带：按钮默认把内容**垂直居中**，正文会飘到卡片中间）。
    // 所以这里钉的不是「有没有 clamp 这个类」，而是**它有没有 button 祖先**。
    vi.mocked(api.listPrompts).mockResolvedValue([item({ content: '很长的一段正文' })])
    render(<PromptLibrary />)
    await screen.findByText('周报模板')

    const card = document.querySelector('[data-prompt="1"]') as HTMLElement
    const body = card.querySelector('p.line-clamp-3')
    expect(body).toBeTruthy()
    expect(body!.closest('button')).toBeNull()
  })

  it('保存失败照实说', async () => {
    vi.mocked(api.listPrompts).mockResolvedValue([item()])
    vi.mocked(api.updatePrompt).mockRejectedValue(new Error('422: {"detail":"标题不合法"}'))
    render(<PromptLibrary />)
    await screen.findByText('周报模板')

    fireEvent.click(screen.getByLabelText('编辑 周报模板'))
    fireEvent.click(await screen.findByText('保存'))
    expect(await screen.findByText(/保存失败/)).toBeTruthy()
  })

  it('页头推来的「新建」信号会开一条草稿（按钮在页头、状态在这里）', async () => {
    vi.mocked(api.listPrompts).mockResolvedValue([item()])
    const { rerender } = render(<PromptLibrary newSignal={0} />)
    await screen.findByText('周报模板')
    expect(document.querySelector('[data-prompt-editor]')).toBeNull()

    rerender(<PromptLibrary newSignal={1} />)
    expect(await screen.findByText('新建提示词')).toBeTruthy()
    expect(document.querySelector('[data-prompt-split]')?.getAttribute('data-prompt-split')).toBe('1')
  })
})

// ---------- 小标的颜色 ----------

describe('PromptLibrary · 小标的颜色', () => {
  it('同一个标签**永远**同一个色——按名字派生，不按顺序', () => {
    // 按顺序派色的话，删掉一个标签会让后面所有标签集体换色，
    // 那比没颜色更糟：它把「认脸」变成了「重新认一遍」。
    expect(tagTone('周报')).toBe(tagTone('周报'))
    const tones = ['周报', '会议', '调研', '写作', '工程', '访谈', 'PRD', '总结'].map(tagTone)
    expect(new Set(tones).size).toBeGreaterThan(1)
  })

  it('分类：没挑过色按名字派生，挑过就用挑的那个', () => {
    expect(catColor('汇报')).toBe(catColor('汇报'))
    expect(catColor('汇报', '#123456')).toBe('#123456')
  })

  it('卡片上的标签**不是灰的**——每个带自己的色', async () => {
    vi.mocked(api.listPrompts).mockResolvedValue([
      item({ tags: ['周报', '会议'], category: '汇报' }),
    ])
    render(<PromptLibrary />)
    await screen.findByText('周报模板')

    const card = document.querySelector('[data-prompt="1"]') as HTMLElement
    const chips = [...card.querySelectorAll('span')].filter((n) =>
      /^#/.test(n.textContent ?? '')
    )
    expect(chips.length).toBe(2)
    // 至少有一个带上了色板里的类（而不是中性灰）
    const tones = chips.map((c) => c.className)
    expect(tones.some((c) => /bg-(sky|violet|emerald|amber|rose|teal|fuchsia|lime)-100/.test(c))).toBe(
      true
    )
  })
})

describe('PromptLibrary · 未保存的改动', () => {
  const twoItems = () =>
    vi.mocked(api.listPrompts).mockResolvedValue([
      item({ id: 1, title: '第一条' }),
      item({ id: 2, title: '第二条' }),
    ])

  it('改了再点另一条：先问一句，选「取消」就留在原地', async () => {
    twoItems()
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    render(<PromptLibrary />)
    await screen.findByText('第一条')

    fireEvent.click(screen.getByLabelText('编辑 第一条'))
    fireEvent.change(document.querySelector('textarea') as HTMLTextAreaElement, {
      target: { value: '改了一大段' },
    })

    fireEvent.click(screen.getByLabelText('编辑 第二条'))

    expect(confirmSpy).toHaveBeenCalled()
    expect(String(confirmSpy.mock.calls[0][0])).toContain('还没保存')
    // 没被切走：正文还是刚改的那段
    expect((document.querySelector('textarea') as HTMLTextAreaElement).value).toBe('改了一大段')
    confirmSpy.mockRestore()
  })

  it('改了点「关掉」：同样要问，选「取消」就还在', async () => {
    twoItems()
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    render(<PromptLibrary />)
    await screen.findByText('第一条')

    fireEvent.click(screen.getByLabelText('编辑 第一条'))
    fireEvent.change(document.querySelector('textarea') as HTMLTextAreaElement, {
      target: { value: '改了一大段' },
    })
    fireEvent.click(screen.getByText('关掉'))

    expect(confirmSpy).toHaveBeenCalled()
    expect(document.querySelector('[data-prompt-editor]')).toBeTruthy()
    confirmSpy.mockRestore()
  })

  it('**没改就不问**——每次切换都弹一句，只会让人学会闭眼点确定', async () => {
    twoItems()
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    render(<PromptLibrary />)
    await screen.findByText('第一条')

    fireEvent.click(screen.getByLabelText('编辑 第一条'))
    fireEvent.click(screen.getByLabelText('编辑 第二条'))

    expect(confirmSpy).not.toHaveBeenCalled()
    // 真的切过去了（按 placeholder 找编辑器里那个标题框——`querySelector('input')` 会抓到搜索框）
    expect(
      (screen.getByPlaceholderText('给它起个一眼能认的名字') as HTMLInputElement).value
    ).toBe('第二条')
    confirmSpy.mockRestore()
  })

  it('保存之后就干净了——不能刚存完还说「有未保存的改动」', async () => {
    vi.mocked(api.listPrompts).mockResolvedValue([item({ id: 1, title: '第一条' })])
    vi.mocked(api.updatePrompt).mockResolvedValue(item({ id: 1, title: '第一条' }))
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    render(<PromptLibrary />)
    await screen.findByText('第一条')

    fireEvent.click(screen.getByLabelText('编辑 第一条'))
    fireEvent.change(document.querySelector('textarea') as HTMLTextAreaElement, {
      target: { value: '改过' },
    })
    fireEvent.click(screen.getByText('保存'))
    await waitFor(() => expect(api.updatePrompt).toHaveBeenCalled())

    fireEvent.click(screen.getByText('关掉'))
    expect(confirmSpy).not.toHaveBeenCalled()
    confirmSpy.mockRestore()
  })
})

// ---------- 历史版本 ----------

describe('PromptLibrary · 历史版本', () => {
  it('列出来并能回到某一版', async () => {
    vi.mocked(api.listPrompts).mockResolvedValue([item({ version_count: 1 })])
    vi.mocked(api.promptVersions).mockResolvedValue([
      { id: 7, title: '周报模板', content: '旧版正文', at: '2026-09-01T10:00:00+00:00', sha: 'abc123' },
    ])
    vi.mocked(api.restorePromptVersion).mockResolvedValue(item({ content: '旧版正文' }))
    render(<PromptLibrary />)
    await screen.findByText('周报模板')

    // 历史在编辑面板里（卡片上不再挂一排按钮）
    fireEvent.click(screen.getByLabelText('编辑 周报模板'))
    fireEvent.click(await screen.findByText('看历史'))
    expect(await screen.findByText('旧版正文')).toBeTruthy()

    fireEvent.click(screen.getByText('回到这一版'))
    await waitFor(() => expect(api.restorePromptVersion).toHaveBeenCalledWith(1, 7))
  })

  it('历史是**折叠区**加在编辑器上面，不是把编辑器替掉（§8.2 区1③）', async () => {
    // 原来是整栏替换：点「看历史」编辑器就没了，看完想接着改还得再点一次。
    // 方案的原话是「详情**加**『历史版本』折叠区」——加，不是换。
    vi.mocked(api.listPrompts).mockResolvedValue([item({ version_count: 1 })])
    vi.mocked(api.promptVersions).mockResolvedValue([
      { id: 7, title: '周报模板', content: '旧版正文', at: '2026-09-01T10:00:00+00:00', sha: 'abc123' },
    ])
    const { container } = render(<PromptLibrary />)
    await screen.findByText('周报模板')

    fireEvent.click(screen.getByLabelText('编辑 周报模板'))
    await screen.findByText('编辑《周报模板》')
    fireEvent.click(await screen.findByText('看历史'))
    await screen.findByText('旧版正文')

    // 两样同时在：折叠区在上面，编辑器一个字没少
    const fold = container.querySelector('details[data-prompt-history]') as HTMLDetailsElement
    expect(fold).toBeTruthy()
    expect(fold.tagName).toBe('DETAILS')
    expect(fold.open).toBe(true)
    expect(screen.getByText('编辑《周报模板》')).toBeTruthy()
  })

  it('对打那一段带着 `#prompt-duel` —— 五区锚点的「对打」指的就是它', async () => {
    // 原来那是 `WorkPage` 里一个**空 div**：点「对打」滚到一个没有内容的锚点上，
    // 落到隔壁那一区。空 div 也「有落点」，所以只有查它**是不是真的那一段**才拦得住。
    vi.mocked(api.listPrompts).mockResolvedValue([item()])
    const { container } = render(<PromptLibrary />)
    await screen.findByText('周报模板')

    const sec = container.querySelector('#prompt-duel') as HTMLElement
    expect(sec).toBeTruthy()
    expect(sec.tagName).toBe('SECTION')
    expect(sec.textContent).toContain('同一条提示词，几个模型谁答得好')
  })

  it('每条旧版标「改了多少行」；**最初那一版不标 ±0**（§8.2 区1③ 的 diff 摘要）', async () => {
    vi.mocked(api.listPrompts).mockResolvedValue([item({ version_count: 2 })])
    // 列表是**新→旧**：第一条是最新，第二条是它上一版
    vi.mocked(api.promptVersions).mockResolvedValue([
      { id: 9, title: '周报模板', content: '第一行\n新加的一行\n共同的', at: '2026-09-05T10:00:00+00:00', sha: 'bbb' },
      { id: 7, title: '周报模板', content: '第一行\n共同的\n被删掉的一行', at: '2026-09-01T10:00:00+00:00', sha: 'aaa' },
    ])
    render(<PromptLibrary />)
    await screen.findByText('周报模板')

    fireEvent.click(screen.getByLabelText('编辑 周报模板'))
    fireEvent.click(await screen.findByText('看历史'))
    // 等折叠区真的展开（正文是一整段多行文本，两版都含这句，所以用 findAll）
    expect((await screen.findAllByText(/第一行[\s\S]*共同的/)).length).toBeGreaterThan(0)

    // 新的那条：比上一版多 1 行、少 1 行
    expect(screen.getByText('+1')).toBeTruthy()
    expect(screen.getByText('−1')).toBeTruthy()
    // 最老的那条**没有可比对象**，写「最初的一版」——写 ±0 会读成「没改」
    expect(screen.getByText('最初的一版')).toBeTruthy()
  })

  it('没有旧版时说清楚「改过一次正文才会留一版」', async () => {
    vi.mocked(api.listPrompts).mockResolvedValue([item({ version_count: 1 })])
    vi.mocked(api.promptVersions).mockResolvedValue([])
    render(<PromptLibrary />)
    await screen.findByText('周报模板')

    fireEvent.click(screen.getByLabelText('编辑 周报模板'))
    fireEvent.click(await screen.findByText('看历史'))
    expect(await screen.findByText(/还没有旧版/)).toBeTruthy()
  })
})

describe('PromptLibrary · 使用记录', () => {
  it('记了就要能看：什么时候用过、当时填了什么', async () => {
    vi.mocked(api.listPrompts).mockResolvedValue([item({ used_count: 1 })])
    vi.mocked(api.promptUsages).mockResolvedValue([
      {
        id: 3,
        at: '2026-09-20T09:30:00+00:00',
        sha: 'deadbeef',
        vars: { 读者: 'leader' },
      },
    ])
    render(<PromptLibrary />)
    await screen.findByText('周报模板')

    fireEvent.click(screen.getByLabelText('编辑 周报模板'))
    fireEvent.click(await screen.findByText('看使用记录'))

    expect(await screen.findByText('2026-09-20 09:30')).toBeTruthy()
    expect(screen.getByText('读者=leader')).toBeTruthy()
  })

  it('没用过就说没用过，不摆一个空壳', async () => {
    vi.mocked(api.listPrompts).mockResolvedValue([item()])
    vi.mocked(api.promptUsages).mockResolvedValue([])
    render(<PromptLibrary />)
    await screen.findByText('周报模板')

    fireEvent.click(screen.getByLabelText('编辑 周报模板'))
    fireEvent.click(await screen.findByText('看使用记录'))
    expect(await screen.findByText(/还没用过/)).toBeTruthy()
  })
})

// ---------- AI：只进草稿，不落库 ----------

describe('PromptLibrary · AI', () => {
  it('AI 生成的结果进草稿，**不调 createPrompt**——用之前改一改', async () => {
    vi.mocked(api.promptAiGenerate).mockResolvedValue({
      title: '给人讲技术',
      content: '把{材料}讲给非技术的人听',
    })
    render(<PromptLibrary />)
    await screen.findByText('库里还没有提示词。')

    fireEvent.click(screen.getByText('AI 生成'))
    fireEvent.change(screen.getByLabelText('想要的提示词'), {
      target: { value: '讲给 leader 听' },
    })
    fireEvent.click(screen.getByText('生成'))

    // 第 2 个参数是 AbortSignal（「不等了」用）——每次都不同，所以判形状
    await waitFor(() =>
      expect(api.promptAiGenerate).toHaveBeenCalledWith('讲给 leader 听', expect.any(AbortSignal))
    )
    // 进了编辑器，但一个字都没落库
    expect(await screen.findByDisplayValue('给人讲技术')).toBeTruthy()
    expect(api.createPrompt).not.toHaveBeenCalled()
  })

  it('AI 调优只改草稿，库里那条没动', async () => {
    vi.mocked(api.listPrompts).mockResolvedValue([item()])
    vi.mocked(api.promptAiRefine).mockResolvedValue({ content: '改过的正文' })
    render(<PromptLibrary />)
    await screen.findByText('周报模板')

    fireEvent.click(screen.getByLabelText('编辑 周报模板'))
    fireEvent.click(await screen.findByText('更清晰'))

    await waitFor(() => expect(api.promptAiRefine).toHaveBeenCalled())
    expect(await screen.findByDisplayValue('改过的正文')).toBeTruthy()
    expect(api.updatePrompt).not.toHaveBeenCalled()
  })

  it('AI 失败照实说，不静默', async () => {
    vi.mocked(api.listPrompts).mockResolvedValue([item()])
    vi.mocked(api.promptAiRefine).mockRejectedValue(
      new Error('503: {"detail":"还没有启用的模型——先去「设置 · 模型」里加一个"}')
    )
    render(<PromptLibrary />)
    await screen.findByText('周报模板')

    fireEvent.click(screen.getByLabelText('编辑 周报模板'))
    fireEvent.click(await screen.findByText('更清晰'))

    expect(await screen.findByText(/还没有启用的模型/)).toBeTruthy()
  })

  it('提取变量退回本地时会如实说这一次是谁提的', async () => {
    vi.mocked(api.listPrompts).mockResolvedValue([item({ content: '写给读者的周报' })])
    vi.mocked(api.promptAiVars).mockResolvedValue({ vars: ['读者'], via: 'local' })
    render(<PromptLibrary />)
    await screen.findByText('周报模板')

    fireEvent.click(screen.getByLabelText('编辑 周报模板'))
    fireEvent.click(await screen.findByText('提取变量'))

    expect(await screen.findByText(/模型用不了，按本地规则提取了 1 个/)).toBeTruthy()
  })
})

// ---------- 带走 ----------

describe('PromptLibrary · 带走', () => {
  it('导出两种格式都走 api（收在一个下拉里）', async () => {
    render(<PromptLibrary />)
    await screen.findByText('库里还没有提示词。')

    fireEvent.change(screen.getByLabelText('导出'), { target: { value: 'json' } })
    await waitFor(() => expect(api.exportPrompts).toHaveBeenCalledWith('json'))
    fireEvent.change(screen.getByLabelText('导出'), { target: { value: 'csv' } })
    await waitFor(() => expect(api.exportPrompts).toHaveBeenCalledWith('csv'))
  })

  it('导入同名跳过时把「跳过了几条」说出来，不闷着', async () => {
    vi.mocked(api.importPrompts).mockResolvedValue({ added: ['新的'], skipped: ['同名的'] })
    render(<PromptLibrary />)
    await screen.findByText('库里还没有提示词。')

    const file = new File(
      [JSON.stringify({ prompts: [{ title: '新的', content: 'x' }] })],
      'prompts.json',
      { type: 'application/json' }
    )
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(input, { target: { files: [file] } })

    expect(await screen.findByText(/进 1 条，跳过 1 条同名的/)).toBeTruthy()
  })

  it('文件里没有 prompts 数组时说清楚，不装作导入了', async () => {
    render(<PromptLibrary />)
    await screen.findByText('库里还没有提示词。')

    const file = new File([JSON.stringify({ 别的: 1 })], 'x.json', { type: 'application/json' })
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(input, { target: { files: [file] } })

    expect(await screen.findByText(/没有 prompts 数组/)).toBeTruthy()
    expect(api.importPrompts).not.toHaveBeenCalled()
  })
})
