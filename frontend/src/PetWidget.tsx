import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link, useLocation, useNavigate } from 'react-router-dom'

import {
  api,
  type CardContradiction,
  type CardStats,
  type DecisionWitness,
  type DeliverWitness,
  type PetGrowth,
  type PetPlugin,
  type PetRoom,
  type PetState,
  type PetStateMode,
  type ScheduledTask,
  type TutorMastery,
  type TutorStuckRow,
} from './api'
import { historyOf, receiptLabel, streamPetChat, toolCallLabel, type PetToolReceipt } from './petChat'
// Animation states come from the Codex pet atlas (awesome-codex-pet v1):
// 9 states, each shipped as an animated webp under /pet/<state>.webp.
// The browser plays them natively, so switching state is just swapping src.
import { asPetAction, petSprite, type PetAction } from './petFace'
import { blipOn as isBlipOn, playBlip, setBlipOn as storeBlipOn } from './petSound'
import { ago } from './reltime'
import { streamPet } from './stream'
import { makeSpeech, useVoiceInput } from './voice'

export type { PetAction }

// 面板里给「此刻」一个说法。与后端 `pet_state._line()` 分工是刻意的：
// 那边是零柒的**台词**（会说话的只有它，没话说就闭嘴），这里是界面的**事实**——
// 面板是你主动打开看细节的地方，所以 `idle` 也得有字。
const MODE_LABEL: Record<PetStateMode, string> = {
  idle: '待机',
  focusing: '专注中',
  working: '陪你干活',
  learning: '陪你学',
  reviewing: '陪你过卡',
  celebrating: '刚交出成品',
  gated: '有一步等你点头',
  busy: '有活在跑',
  idling: '你走开了一会儿',
  pupil: '在听你讲',
  resting: '你走开挺久了',
  tired: '有点蔫',
  sleepy: '深夜',
  night_owl: '这几天都熬得晚',
  returning: '好几天没见',
}

// 「你人不在」的那两个模式 → 宠物区降饱和。**只降宠物自己，不动页面**：
// 陪伴不该变成管教，何况你很可能只是切去别的窗口干正事。
const DIM_MODES: PetStateMode[] = ['idling', 'resting']

// 右下角留白 = Tailwind 的 bottom-5/right-5（1.25rem = 20px）。让位计算要用到它，
// 改了 class 就得同步改这里。
const PET_CORNER = 20
// 页面上「宠物必须让开」的东西都标这个属性（目前只有对话页的输入行）。
const PET_CLEAR_SELECTOR = '[data-pet-clear]'

// ---------- 拖拽（P5 · 做活）的算术 ----------
//
// 位置记的是**离右下角自然位置的偏移**，不记绝对坐标：窗口一缩放，绝对坐标能把
// 宠物拽出屏幕外；偏移量 + 夹紧，天生跟着窗口走。
const PET_SIZE = 96 // 精灵 h-24 w-24

function clampDrag(dx: number, dy: number, w = window.innerWidth, h = window.innerHeight) {
  return {
    dx: Math.min(PET_CORNER, Math.max(-(w - PET_CORNER - PET_SIZE), dx)),
    dy: Math.min(PET_CORNER, Math.max(-(h - PET_CORNER - PET_SIZE), dy)),
  }
}

function loadDrag(): { dx: number; dy: number } {
  try {
    const v = JSON.parse(localStorage.getItem('pet:drag') || 'null')
    if (v && typeof v.dx === 'number' && typeof v.dy === 'number') return clampDrag(v.dx, v.dy)
  } catch {
    /* 记不了位置就待在右下角 */
  }
  return { dx: 0, dy: 0 }
}

// ---------- 弹出置顶（P5 · Document Picture-in-Picture）----------
//
// Chrome / Edge 116+ 能开一个**总在最前**的系统小窗：你切去写代码、看视频，零柒
// 都浮在屏幕上。浏览器给不了真透明与点击穿透（那是桌面壳的活），但「它一直在」
// 这件事先到手，且零桌面开发——同一份状态、同一条 SSE，只是换了个窗子摆。
type PipWindow = Window & { document: Document }

function copyStyles(target: Document) {
  // PiP 是另一份 document，样式得自己搬。内联 <style> 抄规则文本；跨域的 <link>
  // 读不了 cssRules，原样复制标签让浏览器自己去取。
  Array.from(document.styleSheets).forEach((sheet) => {
    try {
      const el = target.createElement('style')
      el.textContent = Array.from(sheet.cssRules)
        .map((r) => r.cssText)
        .join('\n')
      target.head.appendChild(el)
    } catch {
      const src = sheet.ownerNode
      if (src instanceof HTMLLinkElement) {
        const link = target.createElement('link')
        link.rel = 'stylesheet'
        link.href = src.href
        target.head.appendChild(link)
      }
    }
  })
}

// 零柒 — the resident companion avatar fixed to the corner of the main workspace.
//
// This is NOT a separate window (that's PetView / QuickView). This is the
// "real pet on the main screen" form: a rendered pet avatar fixed to the
// bottom-right of every main page (chat/dashboard/notes/kb/settings via
// Layout). It breathes, pops a speech bubble when the system does something,
// and expands into a chat panel on click.
//
// All data comes from the same /api/pet/* endpoints the companion already
// exposes — this is a second, visual face of the same 零柒, not a new brain.

interface PetEvent {
  id: number
  kind: string
  text: string
  detail: string
  created_at: string
}

interface ChatMsg {
  role: 'user' | 'pet'
  text: string
  /** 这一轮零柒**真的做了什么**（P3）。空 = 它只是回了句话。 */
  tools?: PetToolReceipt[]
}

function timeLabel(iso: string) {
  try {
    return new Date(iso).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  } catch {
    return ''
  }
}

// 心情 1–5 的表情。index 0 = 1 分。面板里点一下就记下今天的心情。
const MOOD_FACES = ['😞', '😕', '😐', '🙂', '😄']

/** 主动提醒：宠物跨模块看到的「你欠的账」，挑最急的一件先开口。
 *
 *  和 feed（任务/摘要/备份的系统事件）分工：feed 是「系统发生了什么」，
 *  nudge 是「**你**有什么没处理」——等你点头的工作流、跑挂的任务、攒着的卡点、
 *  到期没过的卡。安静是默认：一件都没有就一个字都不冒。
 *  同一件事一天只念一次（localStorage 按日期记账），别变成唠叨。
 */
interface Nudge {
  key: string
  text: string
  to: string
  toLabel: string
}

const nudgeStorageKey = (k: string) =>
  `pet:nudged:${new Date().toISOString().slice(0, 10)}:${k}`

function wasNudged(key: string): boolean {
  try {
    return localStorage.getItem(nudgeStorageKey(key)) === '1'
  } catch {
    return false
  }
}

function markNudged(key: string): void {
  try {
    localStorage.setItem(nudgeStorageKey(key), '1')
  } catch {
    /* 无痕模式下记不了就不记，顶多今天多念一遍 */
  }
}

/** 台词里的引文一律先裁再进句子：气泡是一行，长依据会把那一行撑成一段。 */
function cut(s: string, n: number): string {
  const t = (s || '').trim()
  return t.length > n ? `${t.slice(0, n)}…` : t
}

/** 顺序即优先级：等你点头 > 跑挂了 > 卡点 > 到期卡 > 到点的决策见证 > **到点的交付见证**。
 *
 *  前四条都是「今天不处理会挡住、会过期」的事；两条见证排在最后，因为**它们不挡任何事**
 *  （`cards.reschedule` 那条纪律：主动开口越少越好）。但排在最后不等于可以永不开口——
 *  它们是唯一两个「不主动说就永远不会有下次机会」的来源：其余四条下次开机还在，
 *  而一条三个月前的判断、一份三周前交出去的东西，只有被念到才会有人回头看
 *  （理由写在 `core/decision_log.py` 与 `core/delivery.py`）。
 *  一天只念一条（服务端只回一条 + 这里的 localStorage 记账），念的是**当时的事实**：
 *  判断原文 + 当时的依据 + 当时的信心（或：交给了谁 + 什么东西 + 多久以前），不催、不评。
 *
 *  **第六个来源（交付见证）是一次明确让开**（M5 · PLAN3 §13）：同 `decision_log` 那个理由
 *  ——一份交出去的东西沉在 `deliver/` 里，纯拉取式的下场同样是没人回头看，而它比判断更短命
 *  （连一条记录都没有，真值只在文件系统里）。代价一起写在原地：这一层的「回看过」只有
 *  👍/👎 那一个动作，所以定义偏弱（`core/delivery.py` 里写明了为什么要求 24 小时的时差）。
 *  下面那句「§2 T1：不加第六个来源」说的是**当时那件事**（对质那句话只换措辞、不加来源），
 *  不是一条永久禁令——但每加一个都得像这次一样，把「为什么它值得开口」写在原地。
 *
 *  **到期卡那条会换一句话**（PLAN2 T1 场景 A）：卡对应的概念你已经说通 ×2、可它的卡这周
 *  反复重来（≥2）时，念的是那句对质——「你说通过两次，可它的卡这周重来三回，再讲一遍？」。
 *  换的只是**那句话的内容**：来源、优先级、key、去处一样没动。
 *  它只陈述两边的事实，不判谁对——「再讲一遍？」是个问句，裁决权在你。
 *
 *  每个请求各自兜底，挂了当没有。 */
async function gatherNudges(): Promise<Nudge[]> {
  const [tasks, stuck, stats, witness, delivered] = await Promise.all([
    api.listTasks().catch((): ScheduledTask[] => []),
    api.tutorStuck().catch((): { stuck: TutorStuckRow[] } => ({ stuck: [] })),
    api.cardStats().catch((): CardStats | null => null),
    api.decisionWitness().catch((): DecisionWitness | null => null),
    api.deliverWitness().catch((): DeliverWitness | null => null),
  ])
  const out: Nudge[] = []
  for (const t of tasks) {
    if (t.awaiting_run_id != null)
      out.push({
        key: `approve-${t.id}`,
        text: `「${t.name}」跑完一步了，等你点头才继续。`,
        to: `/work?tab=workflow&task=${t.id}`,
        toLabel: '去放行',
      })
  }
  for (const t of tasks) {
    if (t.enabled && t.awaiting_run_id == null && t.last_status === 'error')
      out.push({
        key: `failed-${t.id}-${t.last_run ?? ''}`,
        text: `「${t.name}」上次跑挂了，失败原因我给你留着。`,
        to: `/work?tab=workflow&task=${t.id}`,
        toLabel: '去看看',
      })
  }
  const open = stuck.stuck.filter((s) => !s.resolved_at)
  if (open.length > 0)
    out.push({
      key: 'stuck',
      text:
        open.length === 1
          ? `「${open[0].concept}」还卡着，要不要现在把它说通？`
          : `攒了 ${open.length} 个卡点没解，清一个是一个。`,
      to: '/tutor',
      toLabel: '去清卡点',
    })
  if (stats && stats.due_now > 0) {
    // 只有真的有到期卡时才去问那句对照（省一次往返，也免得为一个没人看的数开口）
    const x = await api.cardContradiction().catch((): CardContradiction | null => null)
    const c = x?.contradiction
    out.push(
      c
        ? {
            key: 'due',
            // 数字全读得出来才说：说通几次、重来几回，两个数都来自后端算出来的事实。
            // 「再讲一遍？」——**问句不是判决**：不说「你其实没懂」，不替你改任何判定。
            text: `「${cut(c.concept, 24)}」你说通过 ${c.said_n} 次，可它的卡这周重来 ${c.again_7d} 回，再讲一遍？`,
            to: '/review',
            toLabel: '去重讲',
          }
        : {
            key: 'due',
            text: `今天还有 ${stats.due_now} 张卡没过，趁脑子还在。`,
            to: '/review',
            toLabel: '去复习',
          }
    )
  }
  if (witness?.due) {
    const w = witness.due
    // 「几个月前」按天算：90 天 ≈ 3 个月。不足一个月就说天数，别把三周说成「1 个月」。
    const age = w.age_days >= 30 ? `${Math.round(w.age_days / 30)} 个月前` : `${w.age_days} 天前`
    const basis = cut(w.basis, 30)
    out.push({
      key: `witness-${w.id}`,
      // **引用原文依据**：这条提醒的全部价值就是「当时的你怎么想」，转述一遍就没了。
      // 没有依据那一栏就只说到「当时几成把握」——宁可少一句，也不替当时的你编一个理由。
      // 把握写成 `%`（与决策日志页那一行同一个写法）：`70` 后面接「成」会读成七倍。
      text: `${age}你判断：「${cut(w.text, 40)}」。当时 ${w.confidence}% 把握${
        basis ? `，凭的是「${basis}」` : ''
      }。`,
      to: `/dashboard?decision=${w.id}`,
      toLabel: '翻回去看看',
    })
  }
  if (delivered?.due) {
    const d = delivered.due
    // 交给谁那一栏可能空着（老交付没有 frontmatter，或当初就没填）——那就只说「交出去的」，
    // 不替当时的你补一个收件人。
    const who = d.audience ? `交给${d.audience}的` : '交出去的'
    out.push({
      key: `delivered-${d.path}`,
      // 事实三样：多久以前、什么东西、给谁。**问句结尾**——「后来有回音吗」不是「你该去回访」。
      text: `${ago(d.at)}${who}《${cut(d.title, 30)}》—— 后来有回音吗？`,
      to: `/notes?path=${encodeURIComponent(d.path)}`,
      toLabel: '翻回去看看',
    })
  }
  return out
}

/** 面板底部的一格插件。三种面板（计数 / 计时 / 心情）各是一行动作。 */
function PluginRow({
  p,
  onCommand,
}: {
  p: PetPlugin
  onCommand: (name: string, command: string, args?: Record<string, unknown>) => void
}) {
  const row = 'flex items-center gap-2 text-xs text-neutral-600 dark:text-neutral-300'
  const btn =
    'rounded-md border border-neutral-300 px-2 py-0.5 text-xs transition-colors hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800'

  if (p.panel.kind === 'counter') {
    return (
      <div className={row}>
        <span>💧 {p.label}</span>
        <span className="text-neutral-400 dark:text-neutral-500">
          {p.panel.value ?? 0}/{p.panel.target ?? 0} {p.panel.unit ?? ''}
        </span>
        <div className="flex-1" />
        <button className={btn} onClick={() => onCommand(p.name, 'drink')}>
          +1 杯
        </button>
      </div>
    )
  }

  if (p.panel.kind === 'mood') {
    const v = p.panel.value ?? 0
    return (
      <div className={row}>
        <span>🙂 {p.label}</span>
        <span className="text-neutral-400 dark:text-neutral-500">
          {v ? `今天 ${v}/${p.panel.scale ?? 5}` : '今天还没记'}
        </span>
        <div className="flex-1" />
        <div className="flex gap-0.5">
          {MOOD_FACES.map((face, i) => (
            <button
              key={face}
              title={`${i + 1} 分`}
              onClick={() => onCommand(p.name, 'set', { value: i + 1 })}
              className={
                'rounded px-0.5 text-base leading-none transition-opacity ' +
                (v === i + 1 ? '' : 'opacity-35 hover:opacity-100')
              }
            >
              {face}
            </button>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className={row}>
      <span>⏱ {p.label}</span>
      <span className="text-neutral-400 dark:text-neutral-500">
        {p.panel.running
          ? `剩余 ${Math.ceil((p.panel.remaining ?? 0) / 60)} 分`
          : `${p.panel.minutes ?? p.panel.default_minutes ?? 25} 分`}
      </span>
      <div className="flex-1" />
      <button
        className={btn}
        onClick={() => onCommand(p.name, p.panel.running ? 'stop' : 'start')}
      >
        {p.panel.running ? '停' : '开始'}
      </button>
    </div>
  )
}

export default function PetWidget() {
  const navigate = useNavigate()
  const location = useLocation()
  const [open, setOpen] = useState(false)
  const [bubble, setBubble] = useState<string | null>(null)
  const [nudge, setNudge] = useState<Nudge | null>(null)
  // 姿势分两层：**状态机给底**（你这会儿在干嘛），**feed 事件与主动提醒给一次性覆盖**
  // （系统出事了、你欠账了——那两件事该盖过日常状态几秒）。
  const [flash, setFlash] = useState<PetAction | null>(null)
  const [thinking, setThinking] = useState(false)
  const [state, setState] = useState<PetState | null>(null)
  // 事件流通着没有。它决定两件事：状态多久重算一回、兜底轮询跑不跑。
  const [live, setLive] = useState(false)
  const actionTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [events, setEvents] = useState<PetEvent[]>([])
  const [growth, setGrowth] = useState<PetGrowth | null>(null)
  const [mastery, setMastery] = useState<TutorMastery | null>(null)
  const [room, setRoom] = useState<PetRoom | null>(null)
  const [plugins, setPlugins] = useState<PetPlugin[]>([])
  const [chat, setChat] = useState<ChatMsg[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  // 工具正在跑时的一句话：模型调完工具还要再走一轮才开口，那段空白得有个交代
  const [toolBusy, setToolBusy] = useState<string | null>(null)
  // 朗读：开着的话，零柒说完一句就读出来。**说完了才读**——边流边读会念成一堆碎片。
  const [speakOn, setSpeakOn] = useState(false)
  const [speaking, setSpeaking] = useState(false)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const [error, setError] = useState<string | null>(null)
  const lastIdRef = useRef(0)
  const openRef = useRef(false)
  const bubbleTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  // ---------- 做活（P5）：点击 Q 弹 + 一声合成音效 ----------
  //
  // 反馈是给「摸到它」的那个瞬间的：scale 压下去再弹回来，配一声 WebAudio 现做的
  // 「啵」（oscillator 合成，零素材，实现与开关在 `petSound.ts`——桌面壳那只小窗
  // 共用同一声）。关得掉（记在 localStorage）；摸不出声的环境就安静，都不算错。
  const [squash, setSquash] = useState(false)
  const squashTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [blipOn, setBlipOn] = useState(true)

  // ---------- 拖拽（P5 · 做活）----------
  const [drag, setDrag] = useState(loadDrag)
  const [dragging, setDragging] = useState(false)
  const draggedRef = useRef(false) // 拖完那一下 click 是拖拽的尾巴，不是点击
  const rafRef = useRef(0)
  // 惯性滑行要从**最新的**位置接着算：move/up 挂在 window 上，闭包里那个 drag
  // 是按下那一刻的旧值——每次渲染同步一份到 ref，glide 只读这份。
  const dragPosRef = useRef(drag)
  dragPosRef.current = drag
  const dragRef = useRef<{
    sx: number
    sy: number
    bx: number
    by: number
    moved: boolean
    lx: number
    ly: number
    lt: number
    vx: number
    vy: number
  } | null>(null)

  // ---------- 弹出置顶（P5 · Document PiP）----------
  const [pipWin, setPipWin] = useState<PipWindow | null>(null)
  const pipWinRef = useRef<PipWindow | null>(null)
  pipWinRef.current = pipWin

  // 此刻摆哪个姿势：一次性覆盖 > 正在想 > 状态机。
  const action: PetAction = flash ?? (thinking ? 'review' : asPetAction(state?.action))
  const dimmed = state != null && DIM_MODES.includes(state.mode)

  // 宠物是 fixed 悬浮层，页面排版不知道它占着右下角。对话页的输入行正好在那儿——
  // 窄屏（实测窗口 <1240px）上「发送」会被压住，Playwright 点击直接报
  // `img[alt="零柒"]` 拦截。与其让每个页面自己留白躲它，不如让宠物**自己让开**：
  // 量一量有没有撞上标了 `[data-pet-clear]` 的东西，撞了就整块上移。
  const [dodge, setDodge] = useState(0)

  useEffect(() => {
    const measure = () => {
      const el = panelRef.current
      if (!el) return
      // 用 offset* 而不是 getBoundingClientRect：位移不能反馈进下一次测量，
      // 否则每次 setDodge 都把结果再推一遍，收不住。
      const w = el.offsetWidth
      const h = el.offsetHeight
      const right = window.innerWidth - PET_CORNER
      const bottom = window.innerHeight - PET_CORNER
      const left = right - w
      const top = bottom - h
      let lift = 0
      document.querySelectorAll(PET_CLEAR_SELECTOR).forEach((target) => {
        const r = target.getBoundingClientRect()
        if (r.width === 0 && r.height === 0) return  // 还没排版出来
        if (right > r.left && left < r.right && bottom > r.top && top < r.bottom) {
          lift = Math.max(lift, bottom - r.top + 8)
        }
      })
      setDodge(lift)
    }
    measure()
    window.addEventListener('resize', measure)
    // 面板展开 / 气泡冒出来都会改变占地，撞没撞上要重算。jsdom 没有
    // ResizeObserver，测试环境下跳过（那边本来也量不出布局）。
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    if (ro && panelRef.current) ro.observe(panelRef.current)
    // 首屏输入行是异步量出来的，补一次；路由换了也要重算
    const late = window.setTimeout(measure, 400)
    return () => {
      window.removeEventListener('resize', measure)
      ro?.disconnect()
      window.clearTimeout(late)
    }
  }, [open, bubble, nudge, location.pathname])

  useEffect(() => {
    openRef.current = open
  }, [open])

  // ---------- 此刻：状态机（P1 · 维度一）----------
  //
  // 键鼠活动**只在浏览器里算**：`lastInput` 从不发送、不落库、不写日志，只换算成
  // 一个「几秒没动」的**瞬时**数字带在请求上。服务端因此只知道「该显示无聊了」，
  // 不知道你在不在电脑前——同 `pet.sanitize()` 那道隐私闸门的精神。
  const lastInput = useRef(Date.now())
  useEffect(() => {
    const bump = () => {
      lastInput.current = Date.now()
    }
    const evs = ['mousemove', 'mousedown', 'keydown', 'wheel', 'touchstart'] as const
    evs.forEach((e) => window.addEventListener(e, bump, { passive: true }))
    // 切回这个标签页 = 你回来了。切走时故意不碰：idle 自己会往上长。
    const onVis = () => {
      if (document.visibilityState === 'visible') bump()
    }
    document.addEventListener('visibilitychange', onVis)
    return () => {
      evs.forEach((e) => window.removeEventListener(e, bump))
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [])

  // 路由换了立刻重算（学/工作/复习是三种不同的状态），其余时候 15 秒一回；
  // 事件流接上以后退到 60 秒——它已经不再负责「及时」，只负责兜底。
  //
  // 读的都是 ref（`lastInput` / `pathRef`），所以流的回调里拿到的也一定是**最新**的值，
  // 不会因为闭包停在某一次渲染上。
  const pathRef = useRef(location.pathname)
  useEffect(() => {
    pathRef.current = location.pathname
  }, [location.pathname])

  const loadState = useCallback(() => {
    const idleSec = (Date.now() - lastInput.current) / 1000
    return api
      .petState(idleSec, pathRef.current)
      .then((s) => setState(s))
      .catch(() => {
        /* 拿不到就沿用上一次的姿势，别闪 */
      })
  }, [])

  // 慢慢变的那几样（成长 / 学到了什么 / 屋里的东西）：流说「有活跑完了」时值得重看一眼，
  // 平时 60 秒一次也够——它们不是「此刻」。
  const loadSlow = useCallback(() => {
    void api.petGrowth().then(setGrowth).catch(() => {})
    void api.tutorMastery().then(setMastery).catch(() => {})
    void api.petRoom().then(setRoom).catch(() => {})
  }, [])

  useEffect(() => {
    void loadState()
    const t = setInterval(() => void loadState(), live ? 60000 : 15000)
    return () => clearInterval(t)
  }, [loadState, live, location.pathname])

  // 久别重逢（P5）：状态机说「好几天没见」时，把那句话当**气泡**说一次——
  // 这趟到访值得它先开口，且这次会话只说这一回。不落 localStorage：它是
  // 「这一趟」的问候，不是一天一条的账；页面刷新重挂，重逢还在，就该再见面。
  const reunionShown = useRef(false)
  useEffect(() => {
    if (reunionShown.current || state?.mode !== 'returning' || !state.line) return
    reunionShown.current = true
    setNudge(null)
    setBubble(state.line)
    if (bubbleTimer.current) clearTimeout(bubbleTimer.current)
    bubbleTimer.current = setTimeout(() => setBubble(null), 8000)
  }, [state])

  // ---------- 语音（P3 的另一半）----------
  //
  // 录音→转写那份实现在 `voice.ts`，聊天页与今日日记共用同一份。
  // 这里**说完就直接发**：对着零柒说话要的是「说完它答」，不是先落进输入框
  // 再让你按一下（聊天页那边落进输入框是对的——你可能在口述一段长 prompt）。
  const voice = useVoiceInput((t) => {
    setInput('')
    void send(t)
  }, setError)

  const speak = useCallback(async (text: string) => {
    audioRef.current?.pause()
    audioRef.current = null
    setSpeaking(false)
    const t = text.trim()
    if (!t) return
    try {
      const audio = await makeSpeech(t)
      audioRef.current = audio
      setSpeaking(true)
      audio.onended = () => {
        setSpeaking(false)
        audioRef.current = null
      }
      audio.onerror = () => setSpeaking(false)
      await audio.play()
    } catch (e) {
      setSpeaking(false)
      setError(`语音播报失败：${String(e)}`)
    }
  }, [])

  // 关掉朗读要**立刻闭嘴**，不能等这一句念完——那正是你关它的原因。
  function toggleSpeak() {
    const next = !speakOn
    setSpeakOn(next)
    try {
      localStorage.setItem('pet:speak', next ? '1' : '0')
    } catch {
      /* 无痕模式记不了就算了，只是下次要重新打开 */
    }
    if (!next) {
      audioRef.current?.pause()
      audioRef.current = null
      setSpeaking(false)
    }
  }

  useEffect(() => {
    try {
      setSpeakOn(localStorage.getItem('pet:speak') === '1')
      setBlipOn(isBlipOn())
    } catch {
      /* 无痕模式：朗读默认关、音效默认开 */
    }
    // 卸载时把嘴闭上、把没弹完的 Q 弹收掉：不然离开这一页它还在念
    return () => {
      audioRef.current?.pause()
      audioRef.current = null
      if (squashTimer.current) clearTimeout(squashTimer.current)
    }
  }, [])

  // play a one-shot action, then fall back to whatever the state machine says
  const playAction = useCallback((a: PetAction, ms: number) => {
    setFlash(a)
    if (actionTimer.current) clearTimeout(actionTimer.current)
    actionTimer.current = setTimeout(() => setFlash(null), ms)
  }, [])

  // ---------- 随机小动作（P5 · 做活）----------
  //
  // 状态机说 idle（没活、没提醒，你也安静）时，隔一阵子它自己动一下——挥挥手、
  // 蹦一下、溜两步。**只动 idle**：状态机给的任何别的姿势（在跑 / 在等 / 蔫了）都是
  // 事实，盖不得；小动作是一次性 flash，到点自然回到状态机。姿势随机——「它自己
  // 想动一下」本就不需要可复现。读 ref 而不是进依赖：状态每 15 秒重取一次，
  // 依赖一变 interval 就重置，小动作会被永远饿死在 30 秒之前。
  const stateRef = useRef(state)
  stateRef.current = state
  const flashRef = useRef(flash)
  flashRef.current = flash
  const thinkingRef = useRef(thinking)
  thinkingRef.current = thinking
  useEffect(() => {
    const t = setInterval(() => {
      if (document.hidden) return
      if (flashRef.current || thinkingRef.current) return
      if (asPetAction(stateRef.current?.action) !== 'idle') return
      const pool: PetAction[] = ['waving', 'jumping', 'running-left', 'running-right']
      playAction(pool[Math.floor(Math.random() * pool.length)], 2600 + Math.floor(Math.random() * 1600))
    }, 30000)
    return () => clearInterval(t)
  }, [playAction])

  // 气泡区一次只说一句话：feed 和 nudge 谁开口，另一个闭嘴
  const showNudge = useCallback(
    (n: Nudge) => {
      setBubble(null)
      setNudge(n)
      playAction('waving', 6000)
      if (bubbleTimer.current) clearTimeout(bubbleTimer.current)
      bubbleTimer.current = setTimeout(() => setNudge(null), 12000)
    },
    [playAction]
  )

  // 主动提醒的节奏：进页面缓一口气再看（别跟首屏抢），之后每 5 分钟看一眼，
  // 但**刚念完一件，半小时内不念下一件**——4 件事欠着也不该 20 分钟被念 4 回。
  // 面板开着不念（你自己已经在看了）；人在哪个页面就不念那个页面的账；
  // 当天念过的不再念（localStorage 按日期记账）。
  const lastShownAt = useRef(0)
  const considerNudges = useCallback(() => {
    void (async () => {
      if (openRef.current) return
      if (lastShownAt.current && Date.now() - lastShownAt.current < 30 * 60 * 1000) return
      const here = location.pathname
      const list = (await gatherNudges()).filter((n) => n.to.split('?')[0] !== here)
      const fresh = list.find((n) => !wasNudged(n.key))
      if (!fresh || openRef.current) return
      markNudged(fresh.key)
      lastShownAt.current = Date.now()
      showNudge(fresh)
    })()
  }, [showNudge, location.pathname])

  useEffect(() => {
    const first = setTimeout(considerNudges, 4000)
    const t = setInterval(considerNudges, 5 * 60 * 1000)
    return () => {
      clearTimeout(first)
      clearInterval(t)
    }
  }, [considerNudges])

  // initial load
  useEffect(() => {
    void (async () => {
      try {
        const [f, g, p, m, rm, pc] = await Promise.all([
          fetch('/api/pet/feed?limit=30').then((r) => r.json()),
          api.petGrowth().catch(() => null),
          api.petPlugins().then((r) => r.plugins).catch(() => []),
          api.tutorMastery().catch(() => null),
          api.petRoom().catch(() => null),
          // P5 落库之后：上一场的对话从库里铺出来。「它记得你」不再只活在
          // 这一次会话的内存里——刷新、隔天回来，上一句还在。
          api.petChats(30).catch(() => ({ chats: [] })),
        ])
        const evs: PetEvent[] = f.events ?? []
        setEvents([...evs].reverse())
        if (evs.length) lastIdRef.current = Math.max(...evs.map((e) => e.id))
        setGrowth(g)
        setPlugins(p)
        setMastery(m)
        setRoom(rm)
        // **合入而不是覆盖**：这几条 promise 是并着跑的，谁都有可能后到——
        // 直接 setChat(历史) 会把你已经打出去、正在等回复的那几条冲掉。
        // 库里的历史摆在前面，这一场会话的排在后面。
        setChat((prev) => [
          ...pc.chats.map((c) => ({
            role: c.role,
            text: c.text,
            tools: c.tools?.length ? (c.tools as ChatMsg['tools']) : undefined,
          })),
          ...prev,
        ])
      } catch {
        /* offline — the pet just sits quietly */
      }
    })()
  }, [])

  // 新台词到了 → 说（气泡 + 一次性姿势）。**流与兜底轮询共用这一段**：
  // 两处各写一遍，迟早会长出两种行为（一条一次性的规矩在第 47 天被改了一半）。
  const speakFresh = useCallback(
    (fresh: PetEvent[]) => {
      if (!fresh.length) return
      setEvents((prev) => {
        const ids = new Set(prev.map((e) => e.id))
        const add = fresh.filter((e) => !ids.has(e.id))
        return add.length ? [...prev, ...add.reverse()] : prev
      })
      for (const e of fresh) lastIdRef.current = Math.max(lastIdRef.current, e.id)
      // react to what happened: failures slump, everything else waves hello
      const isFail = fresh.some((e) => e.kind === 'task_failed')
      playAction(isFail ? 'failed' : 'waving', 6000)
      if (!openRef.current) {
        setNudge(null) // 轮到系统事件说话，主动提醒先让位
        setBubble(fresh[0].text)
        if (bubbleTimer.current) clearTimeout(bubbleTimer.current)
        bubbleTimer.current = setTimeout(() => setBubble(null), 6000)
      }
    },
    [playAction]
  )

  // ---------- 事件流（SSE）：有事发生就立刻说 ----------
  //
  // 轮询留下来当**兜底**：流断了不该让零柒变成哑巴——那正是最看不出问题的坏法
  // （页面一切正常，只是它再也不说话）。所以 `live=false` 时那条 15 秒的轮询照旧跑。
  // 重连用退避（5→10→20→30 秒封顶）：服务端重启、网线拔了，都不该刷屏。
  useEffect(() => {
    const ctl = new AbortController()
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | null = null
    let wait = 5000

    const connect = async () => {
      let heard = false
      try {
        await streamPet(
          lastIdRef.current,
          (event, data) => {
            heard = true
            if (event === 'hello') setLive(true)
            else if (event === 'event') {
              setLive(true)
              const line = data as unknown as PetEvent
              speakFresh([line])
              // 这两句背后是**累计量变了**：交出一份成品 → 屋里的架子多一件、EXP 涨；
              // 说通一个概念 → 最近搞懂那栏换人。慢的那几样这时候值得立刻重看一眼。
              if (line.kind === 'output' || line.kind === 'mastered') loadSlow()
            } else if (event === 'work') {
              // 有活开始 / 跑完 / 卡住了：立刻重算「此刻」，顺带看一眼慢的那几样
              // （成品可能刚落地，屋里的架子上就多一件）。
              void loadState()
              loadSlow()
            }
          },
          ctl.signal
        )
      } catch {
        /* 断了：下面按退避重连，这期间轮询兜着 */
      }
      if (stopped) return
      setLive(false)
      if (heard) wait = 5000 // 刚才是通着的，那就从最短的间隔重来
      timer = setTimeout(() => void connect(), wait)
      wait = Math.min(wait * 2, 30000)
    }

    void connect()
    return () => {
      stopped = true
      ctl.abort()
      if (timer) clearTimeout(timer)
    }
  }, [speakFresh, loadState, loadSlow])

  // 兜底轮询：流接上了就停（`live`），断了自然接着跑
  useEffect(() => {
    if (live) return
    const t = setInterval(() => {
      void (async () => {
        try {
          const r = await fetch(`/api/pet/feed?since_id=${lastIdRef.current}&limit=20`)
          if (!r.ok) return
          const data = await r.json()
          speakFresh(data.events ?? [])
        } catch {
          /* retry next tick */
        }
      })()
    }, 15000)
    return () => clearInterval(t)
  }, [live, speakFresh])

  useEffect(() => {
    // 成长是累计量，慢慢变——每次轮询顺带刷新，等级/EXP/最近搞懂跟上就好。
    // 小屋同频：**它身上带着的那件东西**是同一份真值里最新的一件。
    const growthTimer = setInterval(() => loadSlow(), 60000)
    return () => clearInterval(growthTimer)
  }, [loadSlow])

  // a plugin command (drink / start / stop / set) → 更新那一格的面板
  const runPlugin = useCallback(
    async (name: string, command: string, args?: Record<string, unknown>) => {
      try {
        const r = await api.petPluginCommand(name, command, args)
        setPlugins((prev) =>
          prev.map((p) => (p.name === name ? { ...p, panel: r.panel } : p))
        )
        if (r.said) {
          setBubble(r.said)
          if (bubbleTimer.current) clearTimeout(bubbleTimer.current)
          bubbleTimer.current = setTimeout(() => setBubble(null), 6000)
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      }
    },
    []
  )

  // close panel on outside click
  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  async function send(text?: string) {
    const msg = (text ?? input).trim()
    if (!msg || busy) return
    setInput('')
    setError(null)
    // **必须 push 两条**（用户那条 + 一条空的宠物占位，正文往里填）。
    // 早先这里只 push 用户那条，然后在 delta 里写 `n[n.length - 1] = {role:'pet',…}`——
    // 那是**把用户刚问的那句直接覆盖掉**：零柒一开口，你打的字就从面板上消失了。
    setChat((c) => [...c, { role: 'user', text: msg }, { role: 'pet', text: '' }])
    setBusy(true)
    setThinking(true) // focused/inspecting while it thinks
    const ac = new AbortController()
    abortRef.current = ac
    let acc = ''
    const receipts: PetToolReceipt[] = []
    const paint = () =>
      setChat((c) => {
        const n = [...c]
        n[n.length - 1] = {
          role: 'pet',
          text: acc,
          tools: receipts.length ? [...receipts] : undefined,
        }
        return n
      })
    try {
      await streamPetChat(
        // Z1：把面板上已有的那几轮一起带上——后端不落库，不带它就等于每一句都是新会话
        { message: msg, history: historyOf(chat) },
        {
          onDelta: (t) => {
            acc += t
            setToolBusy(null)
            paint()
          },
          onToolCall: (name) => setToolBusy(toolCallLabel(name)),
          onToolResult: (r) => {
            setToolBusy(null)
            receipts.push(r)
            // 零柒刚动过这个插件 —— 面板**那一格也得跟着变**。
            // 不刷新的话，它做的事只有别处看得见：面板还写着「25 分 / 开始」，
            // 而后端其实已经在倒计时了。回执里带的就是权威面板状态，直接用。
            if (r.plugin) {
              setPlugins((prev) =>
                prev.map((p) =>
                  p.name === r.plugin
                    ? { ...p, panel: r.panel as unknown as PetPlugin['panel'] }
                    : p
                )
              )
            }
            paint()
          },
        },
        ac.signal
      )
    } catch (e) {
      if (!ac.signal.aborted) setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
      setThinking(false)
      setToolBusy(null)
      abortRef.current = null
      // 朗读放在**说完了**这一刻：边流边读会念成一堆碎片
      const said = acc.trim()
      if (speakOn && said) void speak(said)
    }
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault()
      void send()
    } else if (e.key === 'Escape') {
      if (busy) abortRef.current?.abort()
      setOpen(false)
    }
  }

  // ---------- 摸它一下（P5 · 做活）：Q 弹 + 一声「啵」（音效本体在 petSound.ts） ----------
  function onSpriteClick() {
    if (draggedRef.current) {
      draggedRef.current = false // 这是拖完松手的那个 click，不是「点开面板」
      return
    }
    setSquash(true)
    if (squashTimer.current) clearTimeout(squashTimer.current)
    squashTimer.current = setTimeout(() => setSquash(false), 380)
    playBlip()
    setOpen((v) => !v)
  }

  // ---------- 拖拽（P5 · 做活）：拽着走，松手带一点惯性，撞墙就停 ----------
  //
  // 指针事件挂在精灵上（touch-none 免得拖动变成滚动）；位移与「给输入行让位」
  // 共用同一套 translate 轴。6px 死区把「点」和「拖」分开；惯性只做衰减不做反弹
  // ——弹来弹去像球，不像猫。
  function saveDrag(v: { dx: number; dy: number }) {
    try {
      localStorage.setItem('pet:drag', JSON.stringify(v))
    } catch {
      /* 无痕模式记不了就算了 */
    }
  }

  function glide(vx: number, vy: number) {
    const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : null
    if (!raf || Math.abs(vx) + Math.abs(vy) < 0.05) {
      saveDrag(dragPosRef.current)
      return
    }
    cancelAnimationFrame(rafRef.current)
    let { dx, dy } = dragPosRef.current
    const step = () => {
      vx *= 0.9
      vy *= 0.9
      if (Math.abs(vx) + Math.abs(vy) < 0.02) {
        saveDrag({ dx, dy })
        return
      }
      const next = clampDrag(dx + vx * 16, dy + vy * 16)
      dx = next.dx
      dy = next.dy
      setDrag({ dx, dy })
      rafRef.current = raf(step)
    }
    rafRef.current = raf(step)
  }

  function onSpritePointerDown(e: React.PointerEvent) {
    if (e.button !== 0) return
    const d = {
      sx: e.clientX,
      sy: e.clientY,
      bx: drag.dx,
      by: drag.dy,
      moved: false,
      lx: e.clientX,
      ly: e.clientY,
      lt: performance.now(),
      vx: 0,
      vy: 0,
    }
    dragRef.current = d
    // move / up 挂在 **window** 上而不是精灵上：宠物一挪就跑到了指针下面之外，
    // 靠元素收事件的话，抓住一半就断（真机验收撞过：只走到路径第二个点）。
    // 收尾在 pointerup 与 pointercancel 两处（触屏拖出屏幕是 cancel）。
    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - d.sx
      const dy = ev.clientY - d.sy
      if (!d.moved && Math.hypot(dx, dy) < 6) return // 过了死区才算拖，点一下还是点
      if (!d.moved) setDragging(true)
      d.moved = true
      const now = performance.now()
      const dt = Math.max(1, now - d.lt)
      d.vx = 0.7 * d.vx + 0.3 * ((ev.clientX - d.lx) / dt)
      d.vy = 0.7 * d.vy + 0.3 * ((ev.clientY - d.ly) / dt)
      d.lx = ev.clientX
      d.ly = ev.clientY
      d.lt = now
      setDrag(clampDrag(d.bx + dx, d.by + dy))
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      dragRef.current = null
      setDragging(false)
      if (!d.moved) return
      draggedRef.current = true // 松手那下的 click 是拖拽的尾巴，不是点击
      glide(d.vx, d.vy)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }

  // ---------- 音效开关（P5 · 做活）----------
  function toggleBlip() {
    const next = !blipOn
    setBlipOn(next)
    storeBlipOn(next)
  }

  // ---------- 弹出置顶（P5 · Document PiP）----------
  async function openPip() {
    if (pipWinRef.current) {
      pipWinRef.current.close()
      setPipWin(null)
      return
    }
    const dpip = (
      window as unknown as {
        documentPictureInPicture?: {
          requestWindow: (o: { width: number; height: number }) => Promise<PipWindow>
        }
      }
    ).documentPictureInPicture
    if (!dpip) {
      setError('这个浏览器还不支持弹出置顶（要 Chrome / Edge 116+）。')
      return
    }
    try {
      const win = await dpip.requestWindow({ width: 240, height: 300 })
      copyStyles(win.document)
      // 暗色跟主页面走一份（主题中途切换不重拷：收回再弹就是新的）
      win.document.documentElement.className = document.documentElement.className
      win.addEventListener('pagehide', () => setPipWin(null))
      setPipWin(win)
    } catch (e) {
      setError(`弹出失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // 主页面一走，小窗里的 React 树就没了——把窗口也带上，别留一个空壳钉在屏幕上
  useEffect(
    () => () => {
      pipWinRef.current?.close()
    },
    []
  )

  return (
    <>
      {/* 零柒的三个动画（pet-idle / pet-squash / pet-bubble-in）已搬进 index.css：
          桌面壳那只小窗（pet.html）共用同一份，这里不再各抄一份。 */}

      {/* 分栏（SplitPane）已移除，不再需要躲开 `--aside-w`——宠物就固定在右下角。 */}
      {/* 拖拽的位移与「让位」共用 translate 轴：拖过就走偏移量，没拖过保持原来的
          写法（让位那条测试与旧习惯都钉着 `translateY` 的样子）。拖动进行中关掉
          transition——200ms 的过渡追着每一帧 move 跑，手感是橡皮。 */}
      <div
        ref={panelRef}
        data-pet-root
        // pointer-events-none 在外层：这个 flex 盒子的宽度由最宽的子元素决定
        // （气泡能到 280px），不关掉的话，离精灵很远的地方点下去也会被它吃掉。
        // 真正要能点的三块（气泡 / 面板 / 精灵本体）各自 pointer-events-auto。
        className={`pointer-events-none fixed bottom-5 right-5 z-50 flex flex-col items-end ${
          dragging ? '' : 'transition-transform duration-200'
        }`}
        style={
          drag.dx || drag.dy
            ? { transform: `translate(${drag.dx}px, ${drag.dy - dodge}px)` }
            : dodge
              ? { transform: `translateY(-${dodge}px)` }
              : undefined
        }
      >
        {/* speech bubble above the sprite：主动提醒（带去处）优先，系统气泡让位 */}
        {nudge && !open ? (
          <div className="pet-bubble pointer-events-auto mb-2 max-w-[280px] rounded-lg rounded-br-sm border border-violet-200 bg-white px-3.5 py-2.5 text-left text-sm leading-relaxed text-neutral-800 shadow-lg shadow-violet-900/10 dark:border-violet-500/40 dark:bg-neutral-800 dark:text-neutral-100">
            <div className="flex items-start gap-2">
              <span className="min-w-0 flex-1">{nudge.text}</span>
              <button
                onClick={() => setNudge(null)}
                title="知道了，今天别念了"
                className="shrink-0 text-xs text-neutral-400 transition-colors hover:text-neutral-600 dark:hover:text-neutral-300"
              >
                ✕
              </button>
            </div>
            <div className="mt-1.5">
              <button
                onClick={() => {
                  setNudge(null)
                  navigate(nudge.to)
                }}
                className="rounded-full border border-violet-300 px-2.5 py-0.5 text-xs text-violet-700 transition-colors hover:bg-violet-50 dark:border-violet-500/50 dark:text-violet-300 dark:hover:bg-violet-500/10"
              >
                {nudge.toLabel} →
              </button>
            </div>
          </div>
        ) : bubble && !open ? (
          <button
            onClick={() => setOpen(true)}
            className="pet-bubble pointer-events-auto mb-2 max-w-[260px] rounded-lg rounded-br-sm border border-neutral-200 bg-white px-3.5 py-2.5 text-left text-sm leading-relaxed text-neutral-800 shadow-lg shadow-neutral-900/10 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100"
          >
            {bubble}
          </button>
        ) : null}

        {/* expanded panel */}
        {open && (
          <div className="pet-bubble pointer-events-auto mb-2 flex h-[380px] w-[320px] flex-col overflow-hidden rounded-lg border border-neutral-200 bg-white shadow-2xl shadow-neutral-900/20 dark:border-neutral-700 dark:bg-neutral-900">
            <div className="flex items-center gap-2 border-b border-neutral-200 px-3 py-2 dark:border-neutral-800">
              <span className="text-sm font-semibold text-neutral-800 dark:text-neutral-100">零柒</span>
              {growth && (
                <Link
                  to="/growth"
                  onClick={() => setOpen(false)}
                  title="看成长"
                  className="text-xs text-neutral-400 transition-colors hover:text-violet-500 dark:text-neutral-500"
                >
                  Lv.{growth.level} {growth.title} · EXP {growth.exp}
                  {growth.next_title && ` · 正在靠近「${growth.next_title}」`}
                </Link>
              )}
              <div className="flex-1" />
              <button
                onClick={toggleSpeak}
                title={speakOn ? '朗读：开（点一下关掉）' : '朗读：关'}
                className={`text-xs transition-colors ${
                  speakOn ? 'text-violet-500' : 'text-neutral-400 dark:text-neutral-500'
                } hover:text-violet-500`}
              >
                {speaking ? '🔊' : speakOn ? '🔈' : '🔇'}
              </button>
              <button
                onClick={toggleBlip}
                title={blipOn ? '音效：开（点一下关掉）' : '音效：关'}
                className={`text-xs transition-colors ${
                  blipOn ? 'text-violet-500' : 'text-neutral-400 dark:text-neutral-500'
                } hover:text-violet-500`}
              >
                {blipOn ? '🔔' : '🔕'}
              </button>
              <button
                onClick={() => void openPip()}
                title={
                  pipWin ? '收回置顶小窗' : '弹出置顶小窗：切去别的应用，它也浮在屏幕上'
                }
                className={`text-xs transition-colors ${
                  pipWin ? 'text-violet-500' : 'text-neutral-400 dark:text-neutral-500'
                } hover:text-violet-500`}
              >
                📌
              </button>
              <Link
                to="/companion"
                onClick={() => setOpen(false)}
                title="整页聊天 / 教它 / 成长 / 小屋 / 有声"
                className="text-xs text-neutral-400 transition-colors hover:text-violet-500 dark:text-neutral-500"
              >
                陪伴页 →
              </Link>
              <button
                onClick={() => setOpen(false)}
                className="rounded-md px-1.5 text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-neutral-700 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
              >
                ✕
              </button>
            </div>

            {/* 成长进度条：只画「正在靠近」，不写「还差 N」 */}
            {growth && (
              <div className="h-0.5 w-full bg-neutral-100 dark:bg-neutral-800">
                <div
                  className="h-0.5 bg-violet-500 transition-all"
                  style={{ width: `${Math.round(growth.progress * 100)}%` }}
                />
              </div>
            )}

            {/* 此刻（P1）：状态机给的姿势与精力。零柒的台词放在前，界面的说法在后——
                它是**当下**的量，跨天归零，不是「还欠 N」的账。 */}
            {state && (
              <div className="flex items-center gap-2 border-b border-neutral-100 px-3 py-1.5 text-xs text-neutral-400 dark:border-neutral-800 dark:text-neutral-500">
                <span className="min-w-0 flex-1 truncate" data-pet-mode={state.mode}>
                  {state.line || MODE_LABEL[state.mode]}
                </span>
                <span className="shrink-0" title="此刻的精神——只描述现在，不是要还的债">
                  精力
                </span>
                <div
                  data-pet-energy={state.energy}
                  className="h-1 w-10 shrink-0 overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-700"
                >
                  <div
                    className="h-full bg-violet-400 transition-all"
                    style={{ width: `${Math.max(0, Math.min(100, state.energy))}%` }}
                  />
                </div>
              </div>
            )}

            <div className="flex-1 space-y-2 overflow-y-auto px-3 py-2 text-sm leading-relaxed">
              {growth && growth.parts.length > 0 && (
                <div className="flex flex-wrap gap-x-2 gap-y-0.5 text-xs text-neutral-400 dark:text-neutral-500">
                  {growth.parts.map((p) => (
                    <span key={p.key}>
                      {p.label} +{p.exp}
                    </span>
                  ))}
                </div>
              )}
              {mastery && mastery.events.length > 0 && (
                <div className="text-xs leading-relaxed text-neutral-400 dark:text-neutral-500">
                  最近搞懂：
                  {mastery.events.slice(0, 3).map((e) => e.concept).join('、')}
                  {mastery.mastered > 3 ? ` 等 ${mastery.mastered} 个` : ''}
                  <Link
                    to="/tutor"
                    onClick={() => setOpen(false)}
                    className="ml-1 text-violet-500 hover:underline"
                  >
                    看学习地图
                  </Link>
                </div>
              )}
              {room?.carried && (
                <div className="text-xs leading-relaxed text-neutral-400 dark:text-neutral-500">
                  它最近叼回来：{room.carried.icon} {room.carried.label}
                  <Link
                    to="/companion?tab=room"
                    onClick={() => setOpen(false)}
                    className="ml-1 text-violet-500 hover:underline"
                  >
                    去小屋
                  </Link>
                </div>
              )}
              {!events.length && !chat.length && !error && (
                <div className="text-neutral-400 dark:text-neutral-500">
                  零柒还没说过话。它会在任务、摘要、备份、订阅有动静时主动开口——你也可以现在跟它聊。
                </div>
              )}
              {events.map((e) => (
                <div key={`e${e.id}`} className="max-w-[92%] rounded-lg rounded-bl-sm bg-neutral-100 px-3 py-2 dark:bg-neutral-800">
                  <div className="whitespace-pre-wrap text-neutral-700 dark:text-neutral-200">{e.text}</div>
                  <div className="mt-0.5 text-xs text-neutral-400 dark:text-neutral-500">{timeLabel(e.created_at)}</div>
                </div>
              ))}
              {chat.map((m, i) =>
                m.role === 'user' ? (
                  <div key={`u${i}`} className="ml-auto max-w-[92%] whitespace-pre-wrap rounded-lg rounded-br-sm bg-violet-600 px-3 py-2 text-white">
                    {m.text}
                  </div>
                ) : (
                  <div
                    key={`p${i}`}
                    className="max-w-[92%] rounded-lg rounded-bl-sm bg-neutral-100 px-3 py-2 dark:bg-neutral-800"
                  >
                    {/* 它真的做了什么。写在话**前面**：先有动作，再有解释。 */}
                    {m.tools && m.tools.length > 0 && (
                      <ul className="mb-1 flex flex-wrap gap-1">
                        {m.tools.map((r, k) => (
                          <li
                            key={k}
                            className="rounded bg-violet-100 px-1.5 py-0.5 text-xs text-violet-700 dark:bg-violet-500/20 dark:text-violet-300"
                          >
                            {receiptLabel(r)}
                          </li>
                        ))}
                      </ul>
                    )}
                    {m.text ? (
                      <span className="whitespace-pre-wrap text-neutral-700 dark:text-neutral-200">
                        {m.text}
                      </span>
                    ) : null}
                    {!m.text && (
                      <span className="text-xs text-neutral-400 dark:text-neutral-500">
                        {toolBusy ?? (
                          <span className="inline-block animate-pulse text-violet-400">▊</span>
                        )}
                      </span>
                    )}
                  </div>
                ),
              )}
              {error && <div className="rounded-lg bg-red-100 px-3 py-2 text-xs text-red-600 dark:bg-red-950/60 dark:text-red-300">{error}</div>}
            </div>

            {plugins.length > 0 && (
              <div className="flex flex-col gap-1 border-t border-neutral-200 px-3 py-2 dark:border-neutral-800">
                {plugins.map((p) => (
                  <PluginRow
                    key={p.name}
                    p={p}
                    onCommand={(name, command, args) => void runPlugin(name, command, args)}
                  />
                ))}
              </div>
            )}

            {/* 快捷对话条：还没开聊的时候，一键起头——开口的门槛越低，陪伴越真 */}
            {chat.length === 0 && (
              <div className="flex flex-wrap gap-1.5 border-t border-neutral-200 px-3 pt-2 dark:border-neutral-800">
                {(
                  [
                    ['排一下今天', '帮我看看现在都欠着什么，排个先后。'],
                    ['陪我聊两句', '陪我聊两句，随便什么都行。'],
                    ['总结今天', '总结一下我今天都干了什么。'],
                  ] as const
                ).map(([label, q]) => (
                  <button
                    key={label}
                    onClick={() => void send(q)}
                    disabled={busy}
                    className="rounded-full border border-neutral-300 px-2.5 py-1 text-xs text-neutral-600 transition-colors hover:border-violet-300 hover:text-violet-600 disabled:opacity-40 dark:border-neutral-700 dark:text-neutral-400 dark:hover:border-violet-500/50"
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}

            <div className="border-t border-neutral-200 p-2 dark:border-neutral-800">
              <div className="flex gap-2">
                {/* 对着零柒说话：说完直接发，不用再按一下（见 voice 那段注释） */}
                <button
                  onClick={voice.toggle}
                  disabled={voice.transcribing || busy}
                  title={voice.recording ? '停止并转写' : '对着零柒说话（说完直接发）'}
                  className={`flex w-9 shrink-0 items-center justify-center rounded-lg border text-sm transition-colors disabled:opacity-40 ${
                    voice.recording
                      ? 'border-red-400 bg-red-50 text-red-500 dark:border-red-500/50 dark:bg-red-500/10'
                      : 'border-neutral-300 text-neutral-400 hover:border-violet-300 hover:text-violet-600 dark:border-neutral-700 dark:hover:border-violet-500/50'
                  }`}
                >
                  {voice.transcribing ? (
                    '⏳'
                  ) : voice.recording ? (
                    <span className="h-2 w-2 animate-pulse rounded-full bg-red-500" />
                  ) : (
                    '🎤'
                  )}
                </button>
                <input
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={onKeyDown}
                  placeholder="跟零柒说点什么"
                  className="min-w-0 flex-1 rounded-lg border border-neutral-300 bg-white px-3 py-1.5 text-sm text-neutral-800 outline-none focus:border-violet-500 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100"
                />
                <button
                  onClick={() => void send()}
                  disabled={busy || !input.trim()}
                  className="rounded-lg bg-violet-600 px-3 text-sm text-white transition-colors hover:bg-violet-500 disabled:opacity-50"
                >
                  发送
                </button>
              </div>
            </div>
          </div>
        )}

        {/* the avatar itself — animated webp per state, PNG fallback on error.
            P5 做活：能拽着走（指针事件 + 惯性），点一下有 Q 弹和一声「啵」。 */}
        <button
          onClick={onSpriteClick}
          onPointerDown={onSpritePointerDown}
          title={state ? `零柒 · ${MODE_LABEL[state.mode]}` : '零柒'}
          className="pointer-events-auto relative flex h-24 w-24 touch-none items-center justify-center transition-transform hover:scale-105 active:scale-95"
        >
          <div className="pet-idle flex items-center justify-center">
            <img
              key={action}
              src={petSprite(action)}
              alt="零柒"
              data-pet-action={action}
              // 你走开久了 → 只把宠物自己降饱和（陪伴不是管教，页面不动）
              style={dimmed ? { filter: 'saturate(0.25)' } : undefined}
              className={
                'h-[88px] w-[88px] object-contain drop-shadow-md transition-[filter] duration-700' +
                (squash ? ' pet-squash' : '')
              }
              onError={(e) => {
                e.currentTarget.src = '/pet-avatar.png'
              }}
            />
          </div>
          {/* 它身上带着的那件东西（P4）：屋里**最近到手**的一件，或刚交出去的成品。
              不看状态、不看今天——攒下来的东西不该因为今天没干活就被摘掉。 */}
          {room?.carried && (
            <span
              data-pet-item={room.carried.id}
              title={`${room.carried.label} · ${room.carried.detail}`}
              className="absolute -bottom-0.5 -right-0.5 flex h-7 w-7 items-center justify-center rounded-full border border-neutral-200 bg-white text-sm shadow-sm dark:border-neutral-700 dark:bg-neutral-800"
            >
              {room.carried.icon}
            </span>
          )}
        </button>
      </div>

      {/* 置顶小窗（P5 · Document PiP）：同一份状态、同一个气泡，只是搬到了一个
          **总在最前**的系统小窗里。样式是 copyStyles 搬过去的，暗色随主页面。 */}
      {pipWin &&
        createPortal(
          <div className="flex h-screen flex-col items-center justify-center gap-2 bg-neutral-50 px-3 py-2 dark:bg-neutral-900">
            {bubble ? (
              <p className="pet-bubble max-w-[200px] rounded-lg rounded-br-sm border border-neutral-200 bg-white px-3 py-2 text-xs leading-relaxed text-neutral-800 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100">
                {bubble}
              </p>
            ) : null}
            <div className="pet-idle">
              <img
                src={petSprite(action)}
                alt="零柒"
                className={'h-24 w-24 object-contain drop-shadow-md' + (squash ? ' pet-squash' : '')}
                style={dimmed ? { filter: 'saturate(0.25)' } : undefined}
                onError={(e) => {
                  e.currentTarget.src = '/pet-avatar.png'
                }}
              />
            </div>
            {state?.line ? (
              <p className="max-w-[200px] text-center text-xs leading-relaxed text-neutral-500 dark:text-neutral-400">
                {state.line}
              </p>
            ) : null}
            <button
              onClick={() => {
                pipWin.close()
                setPipWin(null)
              }}
              className="rounded-full border border-neutral-300 px-2.5 py-0.5 text-xs text-neutral-500 transition-colors hover:border-violet-300 hover:text-violet-600 dark:border-neutral-700 dark:text-neutral-400"
            >
              收回
            </button>
          </div>,
          pipWin.document.body
        )}
    </>
  )
}
