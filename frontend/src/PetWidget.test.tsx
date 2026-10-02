// 零柒的主动提醒：跨模块看到「你欠的账」才开口，安静是默认，一天只念一次。
// 还覆盖 P1 的**此刻状态**：状态机给的姿势驱动动画、面板显示精力、人不在时降饱和。
// feed（系统事件气泡）走真实 fetch，这里一并 stub 掉。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

import PetWidget from './PetWidget'
import { ThemeProvider } from './ThemeProvider'
import { DEFAULT_THEME, installUserSkins, loadUserSkins } from './theme'
import { parseSkin } from './theme/manifest'
import { receiptLabel, toolCallLabel } from './petChat'
import type { DecisionWitness, PetRoom, PetState, PetThing, ScheduledTask } from './api'

vi.mock('./api', () => ({
  api: {
    petState: vi.fn(),
    petGrowth: vi.fn().mockResolvedValue(null),
    petPlugins: vi.fn().mockResolvedValue({ plugins: [] }),
    tutorMastery: vi.fn().mockResolvedValue(null),
    petRoom: vi.fn().mockResolvedValue({
      things: [],
      carried: null,
      shelf: [],
      today: { meals: [], date: '2026-09-14' },
      skills: [],
      form: [],
      concepts: { cards: [], total: 0 },
      flavor: '',
      empty: true,
    }),
    listTasks: vi.fn().mockResolvedValue([]),
    tutorStuck: vi.fn().mockResolvedValue({ stuck: [] }),
    cardStats: vi.fn().mockResolvedValue({ due_now: 0 }),
    // PLAN2 T1：到期卡那条会换一句话——默认没有矛盾（照旧念到期卡）
    cardContradiction: vi.fn().mockResolvedValue({ contradiction: null }),
    decisionWitness: vi.fn().mockResolvedValue({ due: null, count: 0 }),
    // M5：第 6 个来源。默认没有到点的交付（守「安静是默认」）
    deliverWitness: vi.fn().mockResolvedValue({ due: null, count: 0, total: 0, window_days: 14 }),
    petPluginCommand: vi.fn(),
    // P5 落库之后：面板挂载时从库里铺上一场的对话（默认没有）
    petChats: vi.fn().mockResolvedValue({ chats: [] }),
    tts: vi.fn(),
    transcribeAudio: vi.fn(),
    // 皮肤中心的镜像与回读（给零柒换形象那条用例会包一层 ThemeProvider）
    getTheme: vi.fn().mockResolvedValue({ theme: null }),
    putTheme: vi.fn().mockResolvedValue({ theme: null }),
  },
}))
import { api } from './api'

/** 一个「此刻」的默认值——白天、待机、精神还行。 */
function petState(patch: Partial<PetState> = {}): PetState {
  return { mode: 'idle', action: 'idle', energy: 80, line: '', path: '', ...patch }
}

/** 一条到点的决策见证（M4 · G5）。字段就是台词要引用的那几样原文。 */
function witness(patch: Partial<NonNullable<DecisionWitness['due']>> = {}): NonNullable<
  DecisionWitness['due']
> {
  return {
    id: 12,
    text: '先用 SQLite 就够',
    basis: '数据量上不去',
    topic: '',
    confidence: 70,
    created_at: null,
    reviewed_at: null,
    outcome: '',
    note: '',
    due_at: null,
    age_days: 95,
    ...patch,
  }
}

function sprite(): HTMLElement {
  return screen.getByAltText('零柒')
}

function openPanel(): void {
  fireEvent.click(sprite().closest('button') as HTMLElement)
}

function task(id: number, name: string, patch: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id,
    name,
    prompt: '',
    cron: '0 8 * * *',
    model_id: '',
    use_rag: true,
    tools_enabled: true,
    save_to_vault: true,
    enabled: true,
    mode: 'simple',
    tool_whitelist: '',
    max_rounds: 12,
    retry: 1,
    notify_on_error: true,
    trigger_kind: 'cron',
    watch_path: '',
    chain_next_id: null,
    require_approval: false,
    action: 'prompt',
    landing_dir: '',
    conversation_id: null,
    last_run: null,
    last_status: '',
    last_result: '',
    next_run: null,
    ...patch,
  }
}

function renderWidget() {
  return render(
    <MemoryRouter>
      <PetWidget />
    </MemoryRouter>
  )
}

function sseResponse(frames: string[]): Response {
  const enc = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(ctrl) {
      for (const f of frames) ctrl.enqueue(enc.encode(f))
      ctrl.close()
    },
  })
  return new Response(stream, { status: 200 })
}

/** 按 URL 分派：`/api/pet/chat` 走 SSE，其余（feed 轮询）当没有事件。
 *  返回**每次聊天请求的请求体**（Z1 要断言历史真的带上去了）。 */
function stubFetch(chatFrames: string[]) {
  const bodies: { message?: string; history?: { role: string; text: string }[] }[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn((url: unknown, init?: { body?: string }) => {
      if (String(url).includes('/api/pet/chat')) {
        bodies.push(JSON.parse(String(init?.body ?? '{}')))
        return Promise.resolve(sseResponse(chatFrames))
      }
      return Promise.resolve({ ok: true, json: async () => ({ events: [] }) })
    })
  )
  return bodies
}

function askPet(text: string) {
  openPanel()
  fireEvent.change(screen.getByPlaceholderText('跟零柒说点什么'), { target: { value: text } })
  fireEvent.click(screen.getByText('发送'))
}

/** 把 fetch / SSE 那条 await 链冲干净。

    这个文件开了 fake timers（见 beforeEach），testing-library 的 `waitFor`
    在假时钟下等不到东西——本文件其余用例也都是显式推时钟。 */
async function flush() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })
}

/** 把「挂载 → 首次 petState 落进 state」的整条 promise 链冲干净。
 *
 *  挂载那一拍并着跑的请求有六条，`advance(0)` 一拍冲不完——state 要到第二拍才落。
 *  要断言「状态机给的姿势 / 台词」的用例都得用这个，用单拍会读到 null 态。 */
async function boot() {
  await flush()
  await flush()
}

/** jsdom 有 `Audio` 但没有播放实现（调 `play()` 只会往控制台刷 not implemented）。 */
class FakeAudio {
  onended: (() => void) | null = null
  onerror: (() => void) | null = null
  play = vi.fn().mockResolvedValue(undefined)
  pause = vi.fn()
  constructor(public src: string) {}
}

beforeEach(() => {
  localStorage.clear()
  // jsdom 没有 scrollIntoView；面板打开 / 消息追加时会调它（与陪伴页测试同一桩）
  Element.prototype.scrollIntoView = () => {}
  vi.stubGlobal('Audio', FakeAudio)
  // Date 也要伪造：半小时节流比的是 Date.now()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
  // mock 值会跨用例泄漏（mockResolvedValue 一旦设了就一直在），每例前回到「全清净」
  vi.mocked(api.petState).mockResolvedValue(petState())
  vi.mocked(api.listTasks).mockResolvedValue([])
  vi.mocked(api.tutorStuck).mockResolvedValue({ stuck: [] })
  vi.mocked(api.cardStats).mockResolvedValue({ due_now: 0 } as never)
  vi.mocked(api.cardContradiction).mockResolvedValue({ contradiction: null } as never)
  vi.mocked(api.decisionWitness).mockResolvedValue({ due: null, count: 0 })
  vi.mocked(api.deliverWitness).mockResolvedValue({ due: null, count: 0, total: 0, window_days: 14 })
  vi.mocked(api.petChats).mockResolvedValue({ chats: [] })
  vi.mocked(api.petRoom).mockResolvedValue({
    things: [],
    carried: null,
    shelf: [],
    today: { meals: [], date: '2026-09-14' },
    skills: [],
    form: [],
    concepts: { cards: [], total: 0 },
    flavor: '',
    empty: true,
  })
  // feed 轮询：没有系统事件
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok: true, json: async () => ({ events: [] }) })
  )
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  // 装过皮肤用例（换形象那一条）之后，把注册表也复位——它是模块级的活状态，
  // localStorage.clear() 清不掉已经装进内存的那几个
  loadUserSkins()
})

describe('PetWidget · 主动提醒', () => {
  it('等你点头的工作流 → 冒气泡，按钮直接带你去放行', async () => {
    vi.mocked(api.listTasks).mockResolvedValue([
      task(7, '会议闭环', { require_approval: true, awaiting_run_id: 9 }),
    ])
    renderWidget()
    await vi.advanceTimersByTimeAsync(4000)
    expect(screen.getByText('「会议闭环」跑完一步了，等你点头才继续。')).toBeTruthy()
    const go = screen.getByText('去放行 →')
    // 品牌样式的实现从散写的 violet 类收敛进了 .wb-btn-ghost（美化轮），钉子跟着真值走
    expect(go.getAttribute('class')).toContain('wb-btn-ghost')
  })

  it('急的先说：等你点头排在到期卡前面', async () => {
    vi.mocked(api.listTasks).mockResolvedValue([
      task(7, '会议闭环', { awaiting_run_id: 9 }),
    ])
    vi.mocked(api.cardStats).mockResolvedValue({ due_now: 27 } as never)
    renderWidget()
    await vi.advanceTimersByTimeAsync(4000)
    expect(screen.getByText('「会议闭环」跑完一步了，等你点头才继续。')).toBeTruthy()
    expect(screen.queryByText(/张卡没过/)).toBeNull()
  })

  it('念过一遍今天就不念了——主动不等于唠叨', async () => {
    vi.mocked(api.cardStats).mockResolvedValue({ due_now: 27 } as never)
    const first = renderWidget()
    await vi.advanceTimersByTimeAsync(4000)
    expect(screen.getByText(/27 张卡没过/)).toBeTruthy()
    first.unmount()

    const second = render(<MemoryRouter>
      <PetWidget />
    </MemoryRouter>)
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000)
    expect(screen.queryByText(/张卡没过/)).toBeNull()
    second.unmount()
  })

  it('刚念完一件，半小时内不念下一件；到了时候才接着念', async () => {
    vi.mocked(api.listTasks).mockResolvedValue([
      task(7, '会议闭环', { awaiting_run_id: 9 }),
    ])
    vi.mocked(api.cardStats).mockResolvedValue({ due_now: 27 } as never)
    renderWidget()
    await vi.advanceTimersByTimeAsync(4000)
    expect(screen.getByText('「会议闭环」跑完一步了，等你点头才继续。')).toBeTruthy()

    // 5 分钟后：下一件欠着的账存在，但不该被念
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000)
    expect(screen.queryByText(/张卡没过/)).toBeNull()

    // 过了半小时，轮询到 35 分钟那一格才念下一件；只推到弹出那一拍——
    // 再多推 12 秒，气泡的自动收起就把刚冒出来的话又收走了。
    await vi.advanceTimersByTimeAsync(29 * 60 * 1000 + 56 * 1000)
    expect(screen.getByText(/27 张卡没过/)).toBeTruthy()
  })

  it('人在那个页面，就不念那个页面的账', async () => {
    vi.mocked(api.cardStats).mockResolvedValue({ due_now: 27 } as never)
    render(
      <MemoryRouter initialEntries={['/review']}>
        <PetWidget />
      </MemoryRouter>
    )
    await vi.advanceTimersByTimeAsync(4000)
    expect(screen.queryByText(/张卡没过/)).toBeNull()
    expect(screen.queryByText(/去放行|去看看|去清卡点/)).toBeNull()
  })

  it('什么都没欠着 → 安静待机，一个字都不说', async () => {
    renderWidget()
    await vi.advanceTimersByTimeAsync(4000)
    expect(screen.queryByText(/去放行|去看看|去复习|去清卡点/)).toBeNull()
  })

  // PLAN2 T1 场景 A：到期卡那条**换内容不加来源**——概念说通 ×2、它的卡这周反复重来时，
  // 念的是那句对质；两个数字都来自后端算出来的事实，句子止步于一个问句。
  it('双轨矛盾时，到期卡那条换成对质句——还是同一个来源、同一个去处', async () => {
    vi.mocked(api.cardStats).mockResolvedValue({ due_now: 4 } as never)
    vi.mocked(api.cardContradiction).mockResolvedValue({
      contradiction: {
        card_id: 12,
        concept: 'asyncio 事件循环',
        mastered: true,
        said_n: 2,
        again_7d: 3,
        contradiction: true,
      },
    } as never)
    renderWidget()
    await vi.advanceTimersByTimeAsync(4000)
    expect(
      screen.getByText('「asyncio 事件循环」你说通过 2 次，可它的卡这周重来 3 回，再讲一遍？')
    ).toBeTruthy()
    // 换的只是那句话：去处照旧（重讲就在复习页），而且**不判谁对**——「你其实没懂」不出现
    expect(screen.getByText('去重讲 →')).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/你其实|没真懂|高估/)
  })

  it('没有矛盾时照旧念到期卡', async () => {
    vi.mocked(api.cardStats).mockResolvedValue({ due_now: 4 } as never)
    renderWidget()
    await vi.advanceTimersByTimeAsync(4000)
    expect(screen.getByText('今天还有 4 张卡没过，趁脑子还在。')).toBeTruthy()
    expect(screen.getByText('去复习 →')).toBeTruthy()
  })

  it('没有到期卡时连那句对照都不问——不为一个没人看的数开口', async () => {
    vi.mocked(api.cardContradiction).mockClear()
    renderWidget() // 默认 cardStats 是 due_now: 0
    await vi.advanceTimersByTimeAsync(4000)
    expect(api.cardContradiction).not.toHaveBeenCalled()
  })

  it('到点的决策见证：引用**原文依据**，按钮直达那一条', async () => {
    vi.mocked(api.decisionWitness).mockResolvedValue({
      due: witness({
        text: '先用 SQLite 就够，别急着上向量库',
        basis: '这台机器上的数据量一年也到不了十万条',
        topic: '架构选型',
        age_days: 199,
        created_at: '2026-03-01T10:00:00+00:00',
        due_at: '2026-05-30T10:00:00+00:00',
      }),
      count: 3,
    })
    renderWidget()
    await vi.advanceTimersByTimeAsync(4000)
    // 「几个月前你判断：X，当时七成把握，凭的是 Y」——三个事实一个都不能少，
    // 依据是**原文**（转述一遍，这条提醒的全部价值就没了）
    expect(
      screen.getByText(
        '7 个月前你判断：「先用 SQLite 就够，别急着上向量库」。当时 70% 把握，凭的是「这台机器上的数据量一年也到不了十万条」。'
      )
    ).toBeTruthy()
    expect(screen.getByText('翻回去看看 →')).toBeTruthy()
  })

  it('见证排在最后：前面几件欠着的先念（它不挡任何事）', async () => {
    vi.mocked(api.cardStats).mockResolvedValue({ due_now: 27 } as never)
    vi.mocked(api.decisionWitness).mockResolvedValue({
      due: witness({ age_days: 95 }),
      count: 1,
    })
    renderWidget()
    await vi.advanceTimersByTimeAsync(4000)
    expect(screen.getByText(/27 张卡没过/)).toBeTruthy()
    expect(screen.queryByText(/先用 SQLite 就够/)).toBeNull()
  })

  it('到点的交付见证（第 6 个来源）：多久以前 + 交给谁 + 什么东西，问句结尾', async () => {
    vi.mocked(api.deliverWitness).mockResolvedValue({
      due: {
        path: 'deliver/2026-08-28-第-35-周周报.md',
        title: '第 35 周周报',
        genre: '周报',
        audience: '领导',
        at: Math.floor(Date.now() / 1000) - 21 * 86400,
        at_iso: '2026-08-28T10:00:00',
        reviewed: false,
        due_in_days: 14,
      },
      count: 2,
      total: 5,
      window_days: 14,
    })
    renderWidget()
    await vi.advanceTimersByTimeAsync(4000)

    // 三个事实一个不少；**是问句**——「后来有回音吗」不是「你该去回访」
    expect(screen.getByText('21 天前交给领导的《第 35 周周报》—— 后来有回音吗？')).toBeTruthy()
    expect(screen.getByText('翻回去看看 →')).toBeTruthy()
  })

  it('交付见证也排在最后：决策见证先念（两条都不挡事，但判断更老）', async () => {
    vi.mocked(api.decisionWitness).mockResolvedValue({ due: witness({ age_days: 95 }), count: 1 })
    vi.mocked(api.deliverWitness).mockResolvedValue({
      due: {
        path: 'deliver/2026-08-28-周报.md',
        title: '周报',
        genre: '周报',
        audience: '',
        at: Math.floor(Date.now() / 1000) - 21 * 86400,
        at_iso: '2026-08-28T10:00:00',
        reviewed: false,
        due_in_days: 14,
      },
      count: 1,
      total: 1,
      window_days: 14,
    })
    renderWidget()
    await vi.advanceTimersByTimeAsync(4000)

    expect(screen.getByText(/先用 SQLite 就够/)).toBeTruthy()
    expect(screen.queryByText(/后来有回音吗/)).toBeNull()
  })

  it('交付没有收件人时只说「交出去的」，不替当时的你补一个', async () => {
    vi.mocked(api.deliverWitness).mockResolvedValue({
      due: {
        path: 'deliver/2026-08-28-随手一篇.md',
        title: '随手一篇',
        genre: '',
        audience: '',
        at: Math.floor(Date.now() / 1000) - 15 * 86400,
        at_iso: '2026-09-03T10:00:00',
        reviewed: false,
        due_in_days: 14,
      },
      count: 1,
      total: 1,
      window_days: 14,
    })
    renderWidget()
    await vi.advanceTimersByTimeAsync(4000)

    expect(screen.getByText('15 天前交出去的《随手一篇》—— 后来有回音吗？')).toBeTruthy()
  })

  it('没有依据就只说到把握，不替当时的你编一个理由', async () => {
    vi.mocked(api.decisionWitness).mockResolvedValue({
      due: witness({ id: 3, text: '这版先不做多端', basis: '', confidence: 60, age_days: 91 }),
      count: 1,
    })
    renderWidget()
    await vi.advanceTimersByTimeAsync(4000)
    expect(screen.getByText('3 个月前你判断：「这版先不做多端」。当时 60% 把握。')).toBeTruthy()
  })

  it('念过一条今天就够了：同一天不会再念第二条', async () => {
    vi.mocked(api.decisionWitness).mockResolvedValue({
      due: witness({ id: 5, text: '先做本地的', basis: '', confidence: 80, age_days: 100 }),
      count: 4,
    })
    const first = renderWidget()
    await vi.advanceTimersByTimeAsync(4000)
    expect(screen.getByText(/先做本地的/)).toBeTruthy()
    first.unmount()

    // 重挂一次、把时间推过半小时的节流：服务端那条**还是同一条**（一天一条），
    // 而 localStorage 已经记过账——所以它不会再冒出来。
    const second = renderWidget()
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
    expect(screen.queryByText(/先做本地的/)).toBeNull()
    second.unmount()
  })
})

// ---------- 事件流：有事发生就立刻说（轮询退成兜底）----------

/** 一帧 SSE。`event`/`work`/`hello` 是后端约定的三种。 */
function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

/** 一条台词，行形状与 `/api/pet/feed` 给的一模一样。 */
function petLine(id: number, text: string, kind = 'output'): Record<string, unknown> {
  return { id, kind, text, detail: '', created_at: '2026-09-16T10:00:00+08:00', name: '' }
}

/** 事件流走 SSE；其余请求（兜底轮询）当没有事件。
 *
 *  `open=true` 表示**这条流不结束**（真流就是无限的）：一读完就断的假流测不出
 *  「接上了就不用再轮询」——断的那一刻兜底就该回来，那是对的。 */
function stubStream(frames: string[], open = false) {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: unknown) =>
      String(url).includes('/api/pet/stream')
        ? Promise.resolve(open ? openSseResponse(frames) : sseResponse(frames))
        : Promise.resolve({ ok: true, json: async () => ({ events: [] }) })
    )
  )
}

/** 一帧一帧往外发、**永远不 close** 的 SSE 响应。 */
function openSseResponse(frames: string[]): Response {
  const enc = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(ctrl) {
      for (const f of frames) ctrl.enqueue(enc.encode(f))
    },
  })
  return new Response(stream, { status: 200 })
}

describe('PetWidget · 事件流', () => {
  it('流里来的台词立刻冒气泡，不用等那 15 秒', async () => {
    stubStream([
      sseFrame('hello', { since_id: 0, poll: 2 }),
      sseFrame('event', petLine(7, '「周报」交出去了。第一份。')),
    ])
    renderWidget()
    await flush()
    expect(screen.getByText('「周报」交出去了。第一份。')).toBeTruthy()
  })

  it('一个 work 帧 → 立刻重算「此刻」，姿势跟着变', async () => {
    vi.mocked(api.petState)
      .mockResolvedValueOnce(petState({ mode: 'working', action: 'running' }))
      .mockResolvedValue(
        petState({ mode: 'busy', action: 'running-right', line: '复盘正在跑，我去盯着。', busy_with: '复盘' })
      )
    stubStream([
      sseFrame('hello', { since_id: 0, poll: 2 }),
      sseFrame('work', { fingerprint: 'engines:recap|running:0|gated:0' }),
    ])
    renderWidget()
    await flush()
    await flush() // 「重算」是 work 帧触发的第二次请求
    expect(sprite().getAttribute('src')).toBe('/pet/running-right.webp')
  })

  it('流断了 → 退回轮询，零柒不会变成哑巴', async () => {
    // 流那半条永远 500；feed 那半条有话说。**这条流的最大风险不是慢，是静默**：
    // 页面一切正常，只是它再也不开口——所以兜底必须真的还在跑。
    vi.stubGlobal(
      'fetch',
      vi.fn((url: unknown) =>
        String(url).includes('/api/pet/stream')
          ? Promise.resolve({ ok: false, status: 500 })
          : Promise.resolve({ ok: true, json: async () => ({ events: [petLine(9, '兜底的这一句')] }) })
      )
    )
    renderWidget()
    await flush()
    expect(screen.queryByText('兜底的这一句')).toBeNull() // 15 秒还没到
    await vi.advanceTimersByTimeAsync(15000)
    expect(screen.getByText('兜底的这一句')).toBeTruthy()
  })

  it('流接上了就不再打 feed 那一份空请求', async () => {
    stubStream([sseFrame('hello', { since_id: 0, poll: 2 })], true)
    renderWidget()
    await flush()
    await vi.advanceTimersByTimeAsync(120000)
    const urls = vi.mocked(fetch).mock.calls.map((c) => String(c[0]))
    expect(urls.some((u) => u.includes('/api/pet/stream'))).toBe(true)
    // 首屏那一次 `/api/pet/feed?limit=30`（把面板里的历史铺出来）不算轮询
    expect(urls.filter((u) => u.includes('/api/pet/feed?since_id='))).toEqual([])
  })

  it('断了会自己接回来（退避），不是一次就躺平', async () => {
    stubStream([]) // 一帧都没有：连上就立即结束 = 断了
    renderWidget()
    await flush()
    const first = vi.mocked(fetch).mock.calls.filter((c) => String(c[0]).includes('/api/pet/stream')).length
    await vi.advanceTimersByTimeAsync(5000)
    const second = vi.mocked(fetch).mock.calls.filter((c) => String(c[0]).includes('/api/pet/stream')).length
    expect(second).toBeGreaterThan(first)
  })
})

// jsdom 没有排版：offset* 一律 0、getBoundingClientRect 一律全零，所以这里
// 把两边的量法都桩掉，只验「撞上了就让开、没撞就不动」这套算术。
describe('PetWidget · 给输入行让位', () => {
  afterEach(() => {
    document.querySelectorAll('[data-pet-clear]').forEach((el) => el.remove())
  })

  /** 放一个「必须让开」的东西，并给出它的矩形（jsdom 默认视口 1024×768）。 */
  function placeTarget(rect: { left: number; right: number; top: number; bottom: number }) {
    const el = document.createElement('div')
    el.setAttribute('data-pet-clear', '')
    el.getBoundingClientRect = () =>
      ({
        ...rect,
        x: rect.left,
        y: rect.top,
        width: rect.right - rect.left,
        height: rect.bottom - rect.top,
        toJSON: () => rect,
      }) as DOMRect
    document.body.appendChild(el)
  }

  /** 宠物 96×96、右下角留白 20px —— 和真实 class（h-24 w-24 bottom-5 right-5）一致。 */
  async function renderAndMeasure() {
    renderWidget()
    const root = document.querySelector('[data-pet-root]') as HTMLElement
    Object.defineProperty(root, 'offsetWidth', { value: 96, configurable: true })
    Object.defineProperty(root, 'offsetHeight', { value: 96, configurable: true })
    // 首屏那次补量挂在 400ms 上——桩要在它之前生效
    await vi.advanceTimersByTimeAsync(400)
    return root
  }

  it('输入行压在宠物底下 → 整块上移，让出那一段', async () => {
    // 视口 1024×768：宠物自然位置 left 908 / top 652 / bottom 748
    // 目标 top=700 → 要抬到 700 以上：748-700+8 = 56
    placeTarget({ left: 900, right: 1000, top: 700, bottom: 746 })
    const root = await renderAndMeasure()
    expect(root.style.transform).toBe('translateY(-56px)')
  })

  it('mount 之后才冒出来的遮挡也躲得开（DOM 变化触发补量）', async () => {
    // 笔记页「问笔记」侧栏是后开的：开的那一刻没有 resize，量要跟着 DOM 走。
    // 两拍让观察器的微任务把定时器排上并冲走；末尾 act 一拍等 React 提交。
    const root = await renderAndMeasure()
    placeTarget({ left: 900, right: 1000, top: 700, bottom: 746 })
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(0)
    await act(async () => {})
    expect(root.style.transform).toBe('translateY(-56px)')
  })

  it('内容滚进角落也躲得开（捕获阶段监听 scroll）', async () => {
    // 学页的作答行随会话滚动：滚进右下角的那一刻 resize 不会响，scroll 要响
    const root = await renderAndMeasure()
    placeTarget({ left: 900, right: 1000, top: 700, bottom: 746 })
    fireEvent.scroll(window)
    await vi.advanceTimersByTimeAsync(0)
    await act(async () => {})
    expect(root.style.transform).toBe('translateY(-56px)')
  })

  it('够不着（宽屏上输入行在中间）→ 一动不动', async () => {
    placeTarget({ left: 200, right: 700, top: 700, bottom: 746 })
    const root = await renderAndMeasure()
    expect(root.style.transform).toBe('')
  })

  it('再怎么让位也不能被顶出屏幕：上移量夹在「面板顶离屏顶 8px」（§#19）', async () => {
    // 视口 1024×768、面板高 700：自然 top = 748-700 = 48，夹紧上限 = 748-700-8 = 40。
    // 不夹紧的话 lift=56，面板顶会被推到 -8——横屏矮视口上「让位」等于把整块扔出屏外。
    renderWidget()
    const root = document.querySelector('[data-pet-root]') as HTMLElement
    Object.defineProperty(root, 'offsetWidth', { value: 96, configurable: true })
    Object.defineProperty(root, 'offsetHeight', { value: 700, configurable: true })
    await vi.advanceTimersByTimeAsync(400)
    placeTarget({ left: 900, right: 1000, top: 700, bottom: 746 })
    fireEvent.scroll(window)
    await vi.advanceTimersByTimeAsync(0)
    await act(async () => {})
    expect(root.style.transform).toBe('translateY(-40px)')
  })

  it('挂件在 z-30 档（§H 弹层分级）：模态与命令面板（z-50）永远压得住它', async () => {
    // 历史上它和命令面板同为 z-50 且 DOM 靠后，精灵盖住 Ctrl+K——降档是 P0 的一等事
    await renderAndMeasure()
    const root = document.querySelector('[data-pet-root]') as HTMLElement
    expect(root.getAttribute('class')).toContain('z-30')
    expect(root.getAttribute('class')).not.toContain('z-50')
  })

  it('纵向够不着（输入行在宠物上方）→ 一动不动', async () => {
    placeTarget({ left: 900, right: 1000, top: 300, bottom: 400 })
    const root = await renderAndMeasure()
    expect(root.style.transform).toBe('')
  })

  it('外层不吃点击、要能点的三块各自吃回来', async () => {
    await renderAndMeasure()
    const root = document.querySelector('[data-pet-root]') as HTMLElement
    // 气泡最宽能到 280px，外层不吃 pointer-events 的话，离精灵很远的地方
    // 点下去也会被这个空盒子吃掉。
    expect(root.getAttribute('class')).toContain('pointer-events-none')
    expect(screen.getByAltText('零柒').closest('button')?.getAttribute('class')).toContain(
      'pointer-events-auto'
    )
  })
})

// P1 · 维度一：零柒照见你此刻在干什么。
//
// 状态机的规则本身在后端（`backend/tests/test_pet_state.py`，37 条纯函数用例）；
// 这里只验**界面接住了它**——姿势、台词、精力，以及人不在时只降宠物自己。
describe('PetWidget · 此刻的状态', () => {
  it('状态机给的姿势驱动动画', async () => {
    vi.mocked(api.petState).mockResolvedValue(
      petState({ mode: 'focusing', action: 'running', energy: 70, line: '专注中，我不吵你。' })
    )
    renderWidget()
    await vi.advanceTimersByTimeAsync(0)
    expect(sprite().getAttribute('src')).toBe('/pet/running.webp')
  })

  it('面板里看得到此刻与精力', async () => {
    vi.mocked(api.petState).mockResolvedValue(
      petState({ mode: 'learning', action: 'review', energy: 62, line: '在学东西。我在旁边看着。' })
    )
    renderWidget()
    await vi.advanceTimersByTimeAsync(0)
    openPanel()
    expect(screen.getByText('在学东西。我在旁边看着。')).toBeTruthy()
    expect(screen.getByText('精力')).toBeTruthy()
    expect(document.querySelector('[data-pet-energy]')?.getAttribute('data-pet-energy')).toBe('62')
  })

  it('零柒不说话时（idle）面板给出界面的说法', async () => {
    renderWidget()
    await vi.advanceTimersByTimeAsync(0)
    openPanel()
    expect(screen.getByText('待机')).toBeTruthy()
  })

  it('有一步停着等你点头 → 姿势是「等」，面板里说清为什么', async () => {
    // 提醒（`gatherNudges`）是**一次**带按钮的气泡，一天只念一遍；这里是**持续**的姿势：
    // 卡点还在，它就一直是这个状态，不用等人再被提醒一次。
    vi.mocked(api.petState).mockResolvedValue(
      petState({ mode: 'gated', action: 'waiting', energy: 66, line: '有一步停着，等你点头。', gated: 1 })
    )
    renderWidget()
    await vi.advanceTimersByTimeAsync(0)
    expect(sprite().getAttribute('src')).toBe('/pet/waiting.webp')
    openPanel()
    expect(screen.getByText('有一步停着，等你点头。')).toBeTruthy()
  })

  it('有活在跑时说得清在跑什么', async () => {
    vi.mocked(api.petState).mockResolvedValue(
      petState({ mode: 'busy', action: 'running-right', line: '复盘正在跑，我去盯着。', busy_with: '复盘' })
    )
    renderWidget()
    await vi.advanceTimersByTimeAsync(0)
    expect(sprite().getAttribute('src')).toBe('/pet/running-right.webp')
    openPanel()
    expect(screen.getByText('复盘正在跑，我去盯着。')).toBeTruthy()
  })

  it('你走开久了 → 只把宠物自己降饱和，页面不动', async () => {
    vi.mocked(api.petState).mockResolvedValue(
      petState({ mode: 'idling', action: 'waiting', energy: 55, line: '12 分钟没动了。要不要……算了。' })
    )
    renderWidget()
    await vi.advanceTimersByTimeAsync(0)
    expect(sprite().getAttribute('src')).toBe('/pet/waiting.webp')
    expect(sprite().getAttribute('style')).toContain('saturate(0.25)')
    // 「陪伴不是管教」：整页一点没动
    expect(document.body.getAttribute('style')).toBeNull()
  })

  it('人在的时候不降饱和', async () => {
    renderWidget()
    await vi.advanceTimersByTimeAsync(0)
    expect(sprite().getAttribute('style')).toBeNull()
  })

  it('连着熬夜蔫了 → 摆蔫的姿势，但**不降饱和**（它只是蔫，不是走了）', async () => {
    vi.mocked(api.petState).mockResolvedValue(
      petState({ mode: 'night_owl', action: 'failed', energy: 62, line: '连着三个晚上都过了十点。我有点蔫。' })
    )
    renderWidget()
    await vi.advanceTimersByTimeAsync(0)
    expect(sprite().getAttribute('src')).toBe('/pet/failed.webp')
    // 蔫 ≠ 你人不在：降饱和只留给 idling / resting（陪伴不是管教，它也没走开）
    expect(sprite().getAttribute('style')).toBeNull()
    // 台词在面板里（悬浮那只是不说话的）
    openPanel()
    expect(screen.getByText('连着三个晚上都过了十点。我有点蔫。')).toBeTruthy()
  })

  it('系统事件临时盖过状态机，过后回到状态机', async () => {
    vi.mocked(api.petState).mockResolvedValue(petState({ mode: 'working', action: 'running' }))
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          events: [
            {
              id: 1,
              kind: 'task_done',
              text: '「每日摘要」跑完了。',
              detail: '',
              created_at: '2026-09-14T10:00:00',
            },
          ],
        }),
      })
    )
    renderWidget()
    await vi.advanceTimersByTimeAsync(0)
    expect(sprite().getAttribute('src')).toBe('/pet/running.webp')

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15000) // feed 轮询到点：先挥个手
    })
    expect(sprite().getAttribute('src')).toBe('/pet/waving.webp')

    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000) // 一次性覆盖到期：回到状态机
    })
    expect(sprite().getAttribute('src')).toBe('/pet/running.webp')
  })

  it('服务端发来不认识的姿势 → 退回 idle，不破图', async () => {
    vi.mocked(api.petState).mockResolvedValue(petState({ action: 'moonwalk' }))
    renderWidget()
    await vi.advanceTimersByTimeAsync(0)
    expect(sprite().getAttribute('src')).toBe('/pet/idle.webp')
  })

  it('路由换了立刻重算，不用等下一次轮询', async () => {
    render(
      <MemoryRouter initialEntries={['/work']}>
        <PetWidget />
      </MemoryRouter>
    )
    await vi.advanceTimersByTimeAsync(0)
    expect(vi.mocked(api.petState)).toHaveBeenCalledWith(expect.any(Number), '/work')
  })
})

// P3 · 会干活：零柒手上有工具了，它调了就真的生效，面板上留下可核对的回执。
describe('PetWidget · 跟零柒说话', () => {
  it('问一句：用户那条**留着**，零柒的话另起一条', async () => {
    stubFetch(['event: delta\ndata: {"text": "在。"}\n\n', 'event: done\ndata: {}\n\n'])
    renderWidget()
    askPet('在吗')
    await flush()
    expect(screen.getByText('在。')).toBeTruthy()
    // 这条是**回归网**：早先 delta 写的是 `n[n.length - 1] = {role:'pet',…}`，
    // 那是把用户刚问的那句直接覆盖掉——零柒一开口，你打的字就从面板上消失了。
    expect(screen.getByText('在吗')).toBeTruthy()
  })

  it('Z1：第二句带上了第一轮——后端不落库，不带历史它就记不得你上一句', async () => {
    const bodies = stubFetch([
      'event: delta\ndata: {"text": "在。"}\n\n',
      'event: done\ndata: {}\n\n',
    ])
    renderWidget()
    openPanel() // 只开一次：`askPet` 会再点一下宠物，那是**关**面板
    const box = () => screen.getByPlaceholderText('跟零柒说点什么')
    fireEvent.change(box(), { target: { value: '第一问' } })
    fireEvent.click(screen.getByText('发送'))
    await flush()
    fireEvent.change(box(), { target: { value: '那第 2 条呢' } })
    fireEvent.click(screen.getByText('发送'))
    await flush()

    expect(bodies.length).toBe(2)
    expect(bodies[0].message).toBe('第一问')
    expect(bodies[0].history).toEqual([]) // 第一句之前没有历史
    expect(bodies[1].message).toBe('那第 2 条呢')
    // `pet` 就是零柒（后端折成 assistant）；正在流的那条空占位不许混进去
    expect(bodies[1].history).toEqual([
      { role: 'user', text: '第一问' },
      { role: 'pet', text: '在。' },
    ])
  })

  it('它真的做了事 → 回执画在话**前面**', async () => {
    stubFetch([
      'event: tool_call\ndata: {"name": "pet_focus_start", "arguments": {"minutes": 25}}\n\n',
      'event: tool_result\ndata: {"name": "pet_focus_start", "meta": {"pet": {"tool": "pet_focus_start", "plugin": "focus", "command": "start", "panel": {"kind": "timer", "running": true, "remaining": 1500, "minutes": 25}, "said": null}}}\n\n',
      'event: delta\ndata: {"text": "25 分钟，我看着。"}\n\n',
      'event: done\ndata: {}\n\n',
    ])
    renderWidget()
    askPet('开始 25 分钟专注')
    await flush()
    expect(screen.getByText('⏱ 专注 25 分')).toBeTruthy()
    expect(screen.getByText('25 分钟，我看着。')).toBeTruthy()
    // 动作排在解释之前
    const bubble = screen.getByText('25 分钟，我看着。').closest('div') as HTMLElement
    expect(bubble.textContent?.indexOf('⏱')).toBeLessThan(
      bubble.textContent?.indexOf('25 分钟，我看着。') ?? -1
    )
  })

  it('工具正在跑时有一句话，别让那几秒是空白', () => {
    // 直接验映射，**不验时序**：流是瞬间跑完的，`onToolCall` 会被下一帧 delta
    // 立刻清掉，去断言它出现在 DOM 里就是一条注定偶发失败的测试。
    expect(toolCallLabel('pet_focus_start')).toBe('正在开始专注…')
    expect(toolCallLabel('pet_water_drink')).toBe('正在记一杯…')
    expect(toolCallLabel('whatever')).toBe('正在做事…')
  })

  it('回执怎么读（纯函数）', () => {
    const r = (plugin: string, command: string, panel: Record<string, unknown>) => ({
      tool: `pet_${plugin}_${command}`,
      plugin,
      command,
      panel,
      said: null,
    })
    expect(receiptLabel(r('focus', 'start', { remaining: 1500 }))).toBe('⏱ 专注 25 分')
    expect(receiptLabel(r('focus', 'stop', {}))).toBe('⏱ 专注已停')
    expect(receiptLabel(r('water', 'drink', { value: 3, target: 8 }))).toBe('💧 喝水 3/8 杯')
    expect(receiptLabel(r('mood', 'set', { value: 4, scale: 5 }))).toBe('🙂 心情 4/5')
  })

  it('只是聊天就不该有回执', async () => {
    stubFetch(['event: delta\ndata: {"text": "嗯。"}\n\n', 'event: done\ndata: {}\n\n'])
    renderWidget()
    askPet('陪我聊两句')
    await flush()
    expect(screen.getByText('嗯。')).toBeTruthy()
    expect(screen.queryByText(/⏱|💧|🙂/)).toBeNull()
  })

  it('零柒动过的插件，面板**那一格**也跟着变', async () => {
    // 这条是 P3 的视觉验收抓出来的：模型把计时器开起来了，可面板还写着
    // 「25 分 / 开始」——因为前端只在**你自己点面板按钮**时才刷新插件状态。
    // 零柒做的事在面板上看不见，「会干活」就只对了一半。
    vi.mocked(api.petPlugins).mockResolvedValue({
      plugins: [
        {
          name: 'focus',
          label: '专注计时',
          enabled: true,
          permissions: [],
          commands: ['start', 'stop'],
          panel: { kind: 'timer', running: false, remaining: 0, minutes: 25 },
          quota: { used: 0, cap: 30 },
        },
      ],
    })
    stubFetch([
      'event: tool_result\ndata: {"name": "pet_focus_start", "meta": {"pet": {"tool": "pet_focus_start", "plugin": "focus", "command": "start", "panel": {"kind": "timer", "running": true, "remaining": 1500, "minutes": 25}, "said": null}}}\n\n',
      'event: delta\ndata: {"text": "开着了。"}\n\n',
      'event: done\ndata: {}\n\n',
    ])
    renderWidget()
    await flush()
    openPanel()
    expect(screen.getByText('25 分')).toBeTruthy() // 对话前：没在跑
    fireEvent.change(screen.getByPlaceholderText('跟零柒说点什么'), {
      target: { value: '开始 25 分钟专注' },
    })
    fireEvent.click(screen.getByText('发送'))
    await flush()
    expect(screen.getByText('剩余 25 分')).toBeTruthy()
  })
})

// P3 的另一半：语音。输入（对着它说话）+ 输出（它念给你听）。
describe('PetWidget · 语音', () => {
  it('面板上有个麦克风，点一下就开口要权限', async () => {
    const getUserMedia = vi.fn().mockResolvedValue({ getTracks: () => [{ stop: vi.fn() }] })
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getUserMedia },
      configurable: true,
    })
    class Rec {
      state = 'inactive'
      mimeType = 'audio/webm'
      ondataavailable: unknown = null
      onstop: unknown = null
      start() {
        this.state = 'recording'
      }
      stop() {
        this.state = 'inactive'
      }
    }
    vi.stubGlobal('MediaRecorder', Rec)

    renderWidget()
    openPanel()
    fireEvent.click(screen.getByTitle(/对着零柒说话/))
    await flush()
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true })
  })

  it('朗读开着：零柒**说完了**才念，而且开关记得住', async () => {
    vi.mocked(api.tts).mockResolvedValue({
      url: '/api/tts/audio/x.mp3',
      cached: false,
      engine: 'edge',
    })
    stubFetch(['event: delta\ndata: {"text": "在。"}\n\n', 'event: done\ndata: {}\n\n'])
    renderWidget()
    openPanel()

    expect(screen.getByTitle('朗读：关')).toBeTruthy() // 默认关着，不擅自出声
    fireEvent.click(screen.getByTitle('朗读：关'))
    expect(screen.getByTitle('朗读：开（点一下关掉）')).toBeTruthy()
    expect(localStorage.getItem('pet:speak')).toBe('1')

    fireEvent.change(screen.getByPlaceholderText('跟零柒说点什么'), {
      target: { value: '在吗' },
    })
    fireEvent.click(screen.getByText('发送'))
    await flush()
    expect(api.tts).toHaveBeenCalledWith('在。', '', 'edge')
  })

  it('朗读关着：一个字都不念', async () => {
    stubFetch(['event: delta\ndata: {"text": "在。"}\n\n', 'event: done\ndata: {}\n\n'])
    renderWidget()
    askPet('在吗')
    await flush()
    expect(screen.getByText('在。')).toBeTruthy()
    expect(api.tts).not.toHaveBeenCalled()
  })

  it('开关存过就用存的（下次打开面板还是开着）', async () => {
    localStorage.setItem('pet:speak', '1')
    renderWidget()
    openPanel()
    expect(screen.getByTitle('朗读：开（点一下关掉）')).toBeTruthy()
  })
})

// P4 · 小屋：它攒下的东西里**最近到手**的那件，挂在它身上。
describe('PetWidget · 它身上带着的那件东西', () => {
  const THING: PetThing = {
    id: 'work:5',
    kind: 'prop',
    module: 'work',
    module_label: '工作',
    icon: '📦',
    label: '一摞成果',
    detail: '第 5 份成品',
    at: '2026-09-14T09:00:00',
    at_ts: 1,
    count: 5,
  }

  function room(carried: PetThing | null): PetRoom {
    return {
      things: carried ? [carried] : [],
      carried,
      shelf: [],
      today: { meals: [], date: '2026-09-14' },
      skills: [],
      form: [],
      concepts: { cards: [], total: 0 },
      flavor: '',
      empty: !carried,
    }
  }

  it('最近到手的那件挂在精灵角上，点开面板还能进小屋', async () => {
    vi.mocked(api.petRoom).mockResolvedValue(room(THING))
    const { container } = renderWidget()
    await flush()
    const item = container.querySelector('[data-pet-item]')
    expect(item?.getAttribute('data-pet-item')).toBe('work:5')
    expect(item?.textContent).toBe('📦')

    openPanel()
    expect(screen.getByText(/它最近叼回来/)).toBeTruthy()
    expect(screen.getByText('去小屋')).toBeTruthy()
  })

  it('屋里什么都没有时，它身上不挂任何东西（也不画一个空位）', async () => {
    const { container } = renderWidget()
    await flush()
    expect(container.querySelector('[data-pet-item]')).toBeNull()
    openPanel()
    expect(screen.queryByText(/它最近叼回来/)).toBeNull()
  })
})

// ---------- P5 · 做活与加深脑子：摸它、拽它、弹出它；它记得你 ----------

describe('PetWidget · 聊天落库（它记得你）', () => {
  it('上一场的对话从库里铺出来，接着聊会带上它', async () => {
    vi.mocked(api.petChats).mockResolvedValue({
      chats: [
        { id: 1, created_at: '2026-09-17T10:00:00+08:00', role: 'user', text: '上次我问的那个' },
        { id: 2, created_at: '2026-09-17T10:00:05+08:00', role: 'pet', text: '上次答的那句' },
      ],
    })
    const bodies = stubFetch(['event: delta\ndata: {"text": "接着说。"}\n\n', 'event: done\ndata: {}\n\n'])
    renderWidget()
    await flush()
    openPanel()
    expect(screen.getByText('上次我问的那个')).toBeTruthy()
    expect(screen.getByText('上次答的那句')).toBeTruthy()

    // 只开一次面板（再点一下宠物是「关」），手动问一句
    const box = () => screen.getByPlaceholderText('跟零柒说点什么')
    fireEvent.change(box(), { target: { value: '那后来呢' } })
    fireEvent.click(screen.getByText('发送'))
    await flush()
    // 新一轮的 history 带上了从库里铺出来的那两轮——「记得你」跨会话成立
    expect(bodies[0].history).toEqual([
      { role: 'user', text: '上次我问的那个' },
      { role: 'pet', text: '上次答的那句' },
    ])
  })
})

describe('PetWidget · 久别重逢', () => {
  it('好几天没见 → 重逢那句当气泡说一次，姿势是挥手', async () => {
    vi.mocked(api.petState).mockResolvedValue(
      petState({ mode: 'returning', action: 'waving', energy: 90, line: '5 天没见。走的时候你在拆「事件循环」。' })
    )
    renderWidget()
    await boot()
    expect(screen.getByText('5 天没见。走的时候你在拆「事件循环」。')).toBeTruthy()
    expect(sprite().getAttribute('src')).toBe('/pet/waving.webp')
  })

  it('没隔几天就是普通待机，不冒重逢的气泡', async () => {
    renderWidget()
    await vi.advanceTimersByTimeAsync(0)
    expect(screen.queryByText(/天没见/)).toBeNull()
  })
})

describe('PetWidget · 摸它一下（Q 弹 + 音效）', () => {
  it('点一下压下去弹回来，380ms 后回原样', async () => {
    renderWidget()
    await vi.advanceTimersByTimeAsync(0)
    fireEvent.click(sprite().closest('button') as HTMLElement)
    expect(sprite().getAttribute('class')).toContain('pet-squash')
    await vi.advanceTimersByTimeAsync(400)
    expect(sprite().getAttribute('class')).not.toContain('pet-squash')
  })

  it('音效默认开；关掉记在 localStorage，下次打开还是关', async () => {
    renderWidget()
    await vi.advanceTimersByTimeAsync(0)
    openPanel() // 点一下已把面板打开；再点一次是关——注意 askPet 那套不能照抄
    fireEvent.click(sprite().closest('button') as HTMLElement)
    fireEvent.click(sprite().closest('button') as HTMLElement)
    expect(screen.getByTitle('音效：开（点一下关掉）')).toBeTruthy()
    fireEvent.click(screen.getByTitle('音效：开（点一下关掉）'))
    expect(localStorage.getItem('pet:blip')).toBe('0')
    expect(screen.getByTitle('音效：关')).toBeTruthy()
  })

  it('关过一次就一直关（开关读的是存档）', async () => {
    localStorage.setItem('pet:blip', '0')
    renderWidget()
    await vi.advanceTimersByTimeAsync(0)
    openPanel()
    expect(screen.getByTitle('音效：关')).toBeTruthy()
  })
})

describe('PetWidget · 随机小动作', () => {
  it('待机时它自己动一下，到点回到状态机', async () => {
    renderWidget()
    await vi.advanceTimersByTimeAsync(0)
    expect(sprite().getAttribute('src')).toBe('/pet/idle.webp')
    await vi.advanceTimersByTimeAsync(30000)
    const src = sprite().getAttribute('src') || ''
    expect([
      '/pet/waving.webp',
      '/pet/jumping.webp',
      '/pet/running-left.webp',
      '/pet/running-right.webp',
    ]).toContain(src)
    await vi.advanceTimersByTimeAsync(5000)
    expect(sprite().getAttribute('src')).toBe('/pet/idle.webp')
  })
})

describe('PetWidget · 拖拽', () => {
  it('能拽着走；拖完松手的那一下 click 不算点击', async () => {
    renderWidget()
    await vi.advanceTimersByTimeAsync(0)
    const btn = sprite().closest('button') as HTMLElement
    fireEvent.pointerDown(btn, { button: 0, pointerId: 1, clientX: 950, clientY: 700 })
    fireEvent.pointerMove(btn, { pointerId: 1, clientX: 750, clientY: 600 })
    const root = document.querySelector('[data-pet-root]') as HTMLElement
    expect(root.style.transform).toBe('translate(-200px, -100px)')
    fireEvent.pointerUp(btn, { pointerId: 1 })
    fireEvent.click(btn)
    expect(screen.queryByPlaceholderText('跟零柒说点什么')).toBeNull()
    // 再来一次干净的点击 → 面板照常开
    fireEvent.click(btn)
    expect(screen.getByPlaceholderText('跟零柒说点什么')).toBeTruthy()
  })
})

describe('PetWidget · 弹出置顶（Document PiP）', () => {
  it('浏览器不支持就照实说，不炸', async () => {
    renderWidget()
    await vi.advanceTimersByTimeAsync(0)
    openPanel()
    fireEvent.click(screen.getByTitle('弹出置顶小窗：切去别的应用，它也浮在屏幕上'))
    await flush()
    expect(screen.getByText('这个浏览器还不支持弹出置顶（要 Chrome / Edge 116+）。')).toBeTruthy()
  })

  it('点 📌 → 小窗里画着同一只零柒，收回就 close', async () => {
    const body = document.createElement('div')
    document.body.appendChild(body)
    const close = vi.fn()
    const requestWindow = vi.fn(async () => ({
      document: {
        createElement: (...a: Parameters<typeof document.createElement>) => document.createElement(...a),
        head: { appendChild: vi.fn() },
        documentElement: { className: '' },
        body,
      },
      addEventListener: vi.fn(),
      close,
    }))
    vi.stubGlobal('documentPictureInPicture', { requestWindow })
    try {
      renderWidget()
      await vi.advanceTimersByTimeAsync(0)
      openPanel()
      fireEvent.click(screen.getByTitle('弹出置顶小窗：切去别的应用，它也浮在屏幕上'))
      await flush()
      expect(requestWindow).toHaveBeenCalledWith({ width: 240, height: 300 })
      // portal 长在假窗口的 body（这里就是真 document 里那个容器）——
      // 查询要圈定在这个容器里，不然会和主页面那只零柒撞车
      expect(within(body).getByText('收回')).toBeTruthy()
      expect(within(body).getByAltText('零柒').getAttribute('src')).toContain('/pet/')
      fireEvent.click(within(body).getByText('收回'))
      expect(close).toHaveBeenCalled()
    } finally {
      body.remove()
    }
  })
})

// 皮肤给零柒换形象：`pet.sprite`（§8.11 挂件风格那条腿）。
// 钉住的是渲染层的两件事——**皮肤那张图真的被画出来**，以及**图挂了逐级退回**
// （自定义图 → 内置动作图 → 头像兜底），退回的级数记在 dataset 上。
describe('PetWidget · 皮肤给零柒换形象', () => {
  it('pet.sprite → 挂件画皮肤那张；图挂了先退内置动作图，再挂才退头像', () => {
    const got = parseSkin({
      format: 1,
      id: 'cat',
      label: '猫',
      accent: '#8a6a4a',
      pet: { sprite: '/api/images/cat.png' },
    })
    if (!got.ok) throw new Error('fixture')
    installUserSkins([got.value])
    localStorage.setItem('wb:theme', JSON.stringify({ ...DEFAULT_THEME, skin: 'cat' }))

    render(
      <MemoryRouter>
        <ThemeProvider>
          <PetWidget />
        </ThemeProvider>
      </MemoryRouter>
    )

    const img = sprite() as HTMLImageElement
    expect(img.getAttribute('src')).toBe('/api/images/cat.png')

    // 皮肤那张图挂了 → 退回内置动作图（不是直接跳头像——动作还在就先像零柒）
    fireEvent.error(img)
    expect(img.getAttribute('src')).toBe('/pet/idle.webp')
    // 内置那张也挂了（公共资源级别的灾难）→ 头像兜底，零柒不消失
    fireEvent.error(img)
    expect(img.getAttribute('src')).toBe('/pet-avatar.png')
  })

  it('没写 pet 的皮肤不改变任何现状', () => {
    renderWidget()
    expect((sprite() as HTMLImageElement).getAttribute('src')).toBe('/pet/idle.webp')
  })
})
