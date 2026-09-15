// 零柒的主动提醒：跨模块看到「你欠的账」才开口，安静是默认，一天只念一次。
// 还覆盖 P1 的**此刻状态**：状态机给的姿势驱动动画、面板显示精力、人不在时降饱和。
// feed（系统事件气泡）走真实 fetch，这里一并 stub 掉。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

import PetWidget from './PetWidget'
import { receiptLabel, toolCallLabel } from './petChat'
import type { PetRoom, PetState, PetThing, ScheduledTask } from './api'

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
      empty: true,
    }),
    listTasks: vi.fn().mockResolvedValue([]),
    tutorStuck: vi.fn().mockResolvedValue({ stuck: [] }),
    cardStats: vi.fn().mockResolvedValue({ due_now: 0 }),
    petPluginCommand: vi.fn(),
    tts: vi.fn(),
    transcribeAudio: vi.fn(),
  },
}))
import { api } from './api'

/** 一个「此刻」的默认值——白天、待机、精神还行。 */
function petState(patch: Partial<PetState> = {}): PetState {
  return { mode: 'idle', action: 'idle', energy: 80, line: '', path: '', ...patch }
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

/** 按 URL 分派：`/api/pet/chat` 走 SSE，其余（feed 轮询）当没有事件。 */
function stubFetch(chatFrames: string[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: unknown) =>
      String(url).includes('/api/pet/chat')
        ? Promise.resolve(sseResponse(chatFrames))
        : Promise.resolve({ ok: true, json: async () => ({ events: [] }) })
    )
  )
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
  vi.stubGlobal('Audio', FakeAudio)
  // Date 也要伪造：半小时节流比的是 Date.now()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
  // mock 值会跨用例泄漏（mockResolvedValue 一旦设了就一直在），每例前回到「全清净」
  vi.mocked(api.petState).mockResolvedValue(petState())
  vi.mocked(api.listTasks).mockResolvedValue([])
  vi.mocked(api.tutorStuck).mockResolvedValue({ stuck: [] })
  vi.mocked(api.cardStats).mockResolvedValue({ due_now: 0 } as never)
  vi.mocked(api.petRoom).mockResolvedValue({
    things: [],
    carried: null,
    shelf: [],
    today: { meals: [], date: '2026-09-14' },
    skills: [],
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
    expect(go.getAttribute('class')).toContain('violet')
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

  it('够不着（宽屏上输入行在中间）→ 一动不动', async () => {
    placeTarget({ left: 200, right: 700, top: 700, bottom: 746 })
    const root = await renderAndMeasure()
    expect(root.style.transform).toBe('')
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
