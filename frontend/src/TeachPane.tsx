// 陪伴页 · 教学面板（方向 6 第二十二刀，2026-09-30 自 CompanionPage 拆出）：
// 费曼教学：你讲它听 → 自评「听懂了/一半/没讲通」→ 成长值当场回执 → 顺手结卡点。
// 状态与处理器自含（零 props）；卡着的概念是选题来源，讲通就地闭环。
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, type PetGrowth, type PetState, type TutorStuckRow } from './api'
import ArtifactReceipt from './ArtifactReceipt'
import { upsertArtifact } from './artifacts'
import { StarterGrid, StarterTile, starterTileClass } from './StarterCards'
import { petSprite } from './petFace'
import { SaveTextToVault } from './SaveToVault'
import { streamTutorSay, type ArtifactRef } from './stream'
import type { ChatMsg } from './companionShared'

/** 教它 — 费曼法，而那个「什么都不懂的学生」就是零柒。
 *
 *  这里**一行宠物代码都没有**，这是刻意的：费曼会话一开，后端状态机自己就进了
 *  `pupil`（零柒摆出「我在听」）；verdict=got 时后端会发一条 `mastered` 事件，
 *  状态机随即进 `celebrating`（它自己跳一下）。成长值同理，早就在 `pet.growth` 里
 *  算好了。所以这个组件只管教学本身——宠物那边不需要被「通知」。
 */
export default function TeachPane() {
  const [topic, setTopic] = useState('')
  const [sid, setSid] = useState<number | null>(null)
  const [who, setWho] = useState('')
  const [turns, setTurns] = useState<ChatMsg[]>([])
  // 方向 1：零柒的回复也能沉淀成产出——存完就地给一行回执（按回合序号挂）。
  const [savedArts, setSavedArts] = useState<Record<number, ArtifactRef[]>>({})
  const [streaming, setStreaming] = useState('')
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [verdict, setVerdict] = useState<'' | 'got' | 'half' | 'useless'>('')
  const [concept, setConcept] = useState('')
  const [growth, setGrowth] = useState<PetGrowth | null>(null)
  const [stuck, setStuck] = useState<TutorStuckRow[]>([])
  // 空态头图上那只零柒摆的是**此刻的姿势**（与挂件、小屋同一接口同一只）
  const [pet, setPet] = useState<PetState | null>(null)
  useEffect(() => {
    api.petState(0, '/companion').then(setPet).catch(() => {})
  }, [])
  // 会话开始前的成长快照：用来报**真实的**增量，而不是把后端的 EXP 常数
  // 抄一份到前端（抄了就会漂移）。
  const beforeRef = useRef<PetGrowth | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)

  // 你卡着的东西是「讲给它听」最好的选题——本来就没搞明白，才最需要讲一遍。
  // 只是建议，不是待办：一件都没有就一个字都不提。
  useEffect(() => {
    api
      .tutorStuck()
      .then((r) => setStuck(r.stuck.filter((s) => !s.resolved_at).slice(0, 3)))
      .catch(() => {})
  }, [])

  // 讲通了一个之前卡着的概念？当场把那条卡点结掉——教学与卡点是同一本账的两面，
  // 这个闭环以前要跑去「学 → 记录」手动打勾，现在讲完顺手就完成了。
  const [stuckMsg, setStuckMsg] = useState('')
  const resolveStuck = useCallback(async (s: TutorStuckRow) => {
    try {
      await api.tutorResolveStuck(s.id, true)
      setStuck((prev) => prev.filter((x) => x.id !== s.id))
      setStuckMsg(`卡点「${s.concept}」结了。`)
    } catch (e) {
      setStuckMsg(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' })
  }, [turns, streaming, verdict])

  useEffect(() => () => abortRef.current?.abort(), [])

  const say = useCallback(async (id: number, text: string) => {
    abortRef.current?.abort()
    const ac = new AbortController()
    abortRef.current = ac
    setErr('')
    setBusy(true)
    setTurns((t) => [...t, { role: 'user', text }])
    let acc = ''
    try {
      const done = await streamTutorSay(
        { session_id: id, text },
        {
          onDelta: (d) => {
            acc += d
            setStreaming(acc)
          },
        },
        ac.signal
      )
      if (!done.ok) setErr(done.error ?? '出错了')
    } catch (e) {
      // 主动掐断不是错误（换选题、离开页面时的中断），安静收尾即可
      if (!ac.signal.aborted) setErr(e instanceof Error ? e.message : String(e))
    } finally {
      if (abortRef.current === ac) abortRef.current = null
      setStreaming('')
      // 半截回复后端也存了一份，这边留着才与它一致
      if (acc) setTurns((t) => [...t, { role: 'pet', text: acc }])
      setBusy(false)
    }
  }, [])

  const begin = useCallback(
    async (raw: string) => {
      const text = raw.trim()
      if (!text || busy) return
      setWho(text)
      setErr('')
      setTurns([])
      setStreaming('')
      setVerdict('')
      setConcept('')
      setGrowth(null)
      beforeRef.current = await api.petGrowth().catch(() => null)
      try {
        const s = await api.tutorStart(text, '', 'feynman')
        setSid(s.id)
        // 选题本身就是第一轮——没有「先问候一句」的特殊路径
        await say(s.id, text)
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e))
      }
    },
    [busy, say]
  )

  const submit = useCallback(async () => {
    const t = draft.trim()
    if (!t || sid === null || busy) return
    setDraft('')
    await say(sid, t)
  }, [draft, sid, busy, say])

  const mark = useCallback(
    async (v: 'got' | 'half' | 'useless') => {
      if (sid === null || busy) return
      setBusy(true)
      try {
        const done = await api.tutorEnd(sid, v)
        setVerdict(v)
        setConcept(done.concept)
        setSid(null)
        // 当场把「它长了多少」报出来——宠物挂件自己 60 秒才轮询一次成长，
        // 而你刚做完的这件事值得立刻有回音。
        setGrowth(await api.petGrowth().catch(() => null))
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e))
      } finally {
        setBusy(false)
      }
    },
    [sid, busy]
  )

  const before = beforeRef.current
  const gained = growth && before && growth.exp > before.exp ? growth.exp - before.exp : 0
  const levelUp = Boolean(growth && before && growth.level > before.level)
  const idle = sid === null

  return (
    <div className="flex min-h-[380px] min-w-0 flex-1 flex-col wb-card">
      {/* 还没开讲：空态头图——居中的它 + 原话 + 一个大的开讲框 + 选题卡
          （卡着的概念优先；一张都没有就给两条真入口）。讲起来之后回到普通聊天流。 */}
      {idle && !verdict ? (
        <div className="flex flex-1 flex-col items-center justify-center overflow-y-auto px-6 py-8">
          <img
            src={petSprite(pet?.action)}
            alt="零柒"
            className="h-20 w-20 object-contain drop-shadow-md"
            onError={(e) => {
              e.currentTarget.src = '/pet-avatar.png'
            }}
          />
          <h2 className="mt-3 max-w-xl text-center text-lg font-semibold leading-relaxed text-neutral-800 dark:text-neutral-100">
            我什么都不懂。你挑一个东西，用大白话讲给我听——讲到我听明白，我就学会了。
          </h2>
          <div className="mt-5 flex w-full max-w-xl gap-2">
            <input
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  void begin(topic)
                }
              }}
              placeholder="你要教它什么？比如 asyncio 事件循环"
              className="min-w-0 flex-1 rounded-md border border-neutral-300 bg-white px-4 py-3 text-sm text-neutral-800 outline-none focus:border-violet-500 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100"
            />
            <button
              onClick={() => void begin(topic)}
              disabled={busy || !topic.trim()}
              className="shrink-0 rounded-md wb-btn-primary px-5 text-sm"
            >
              开始讲
            </button>
          </div>
          <StarterGrid>
            {stuck.map((s) => (
              <StarterTile
                key={s.id}
                icon="🎯"
                title={s.concept}
                desc={s.stuck ? `↳ ${s.stuck}` : undefined}
                descTitle={s.stuck || undefined}
                descTruncate
                footer="讲这个 →"
                disabled={busy}
                onClick={() => void begin(s.concept)}
              />
            ))}
            {stuck.length === 0 && (
              <>
                <Link
                  to="/notes"
                  className={starterTileClass}
                >
                  <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">
                    📝 去笔记挑一段
                  </p>
                  <p className="mt-0.5 text-xs leading-relaxed text-neutral-400 dark:text-neutral-500">
                    学过的东西带着出处，以后可考。
                  </p>
                </Link>
                <Link
                  to="/tutor?tab=learn"
                  className={starterTileClass}
                >
                  <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">
                    🧭 消化一份材料
                  </p>
                  <p className="mt-0.5 text-xs leading-relaxed text-neutral-400 dark:text-neutral-500">
                    要搞懂的点列出来，逐个讲给它听。
                  </p>
                </Link>
              </>
            )}
          </StarterGrid>
        </div>
      ) : (
        <div className="flex-1 space-y-3 overflow-y-auto px-5 py-4 text-sm leading-relaxed">
        {turns.map((m, i) =>
          m.role === 'user' ? (
            <div
              key={`u${i}`}
              className="ml-auto max-w-[75%] whitespace-pre-wrap break-words rounded-lg rounded-br-sm bg-violet-600 px-4 py-3 text-white"
            >
              {m.text}
            </div>
          ) : (
            <div key={`p${i}`} className="max-w-[75%]">
              <div className="whitespace-pre-wrap break-words rounded-lg rounded-bl-sm bg-neutral-100 px-4 py-3 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-200">
                {m.text}
              </div>
              <div className="mt-0.5">
                <SaveTextToVault
                  content={m.text}
                  label="📄 存"
                  title="把这条回复存进 vault 的产出区"
                  onSaved={(a) => setSavedArts((p) => ({ ...p, [i]: upsertArtifact(p[i], a) }))}
                />
              </div>
              {(savedArts[i] ?? []).map((a) => (
                <div key={a.path} className="mt-1">
                  <ArtifactReceipt art={a} />
                </div>
              ))}
            </div>
          )
        )}

        {streaming ? (
          <div className="max-w-[75%] whitespace-pre-wrap break-words rounded-lg rounded-bl-sm bg-neutral-100 px-4 py-3 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-200">
            {streaming}
          </div>
        ) : busy ? (
          <div className="max-w-[75%] rounded-lg rounded-bl-sm bg-neutral-100 px-4 py-3 text-violet-400 dark:bg-neutral-800">
            <span className="inline-block animate-pulse">▊</span>
          </div>
        ) : null}

        {verdict && (
          <div className="rounded-lg border border-violet-200 bg-violet-50/60 px-4 py-3 text-neutral-700 dark:border-violet-500/40 dark:bg-violet-500/10 dark:text-neutral-200">
            {verdict === 'got' ? (
              <>
                <div className="font-medium">零柒把「{concept || who}」记住了。</div>
                {growth && (
                  <div className="mt-0.5 text-xs text-neutral-500 dark:text-neutral-400">
                    {gained > 0 && `+${gained} EXP · `}
                    现在是 Lv.{growth.level}「{growth.title}」
                    {levelUp && ' · 升级了'}
                    {growth.next_title && ` · 正在靠近「${growth.next_title}」`}
                  </div>
                )}
              </>
            ) : verdict === 'half' ? (
              <div>它听懂了一半。换个说法再讲一遍——第二遍通常就通了。</div>
            ) : (
              <div>这次没讲通。不记账，想讲的时候再来。</div>
            )}
            {verdict === 'got' &&
              (() => {
                const hit = stuck.find((s) => s.concept === (concept || who) && !s.resolved_at)
                return hit ? (
                  <button
                    onClick={() => void resolveStuck(hit)}
                    className="mt-1.5 block text-xs text-amber-600 transition-colors hover:text-amber-700 dark:text-amber-400"
                  >
                    这条之前卡过——把卡点「{hit.concept}」标记为已解
                  </button>
                ) : null
              })()}
            {stuckMsg ? (
              <p className="mt-1 text-xs text-emerald-600 dark:text-emerald-400">{stuckMsg}</p>
            ) : null}
            <button
              onClick={() => {
                setVerdict('')
                setTurns([])
                setWho('')
              }}
              className="mt-2 rounded-full wb-btn-ghost px-3 py-1 text-xs"
            >
              再教一个
            </button>
          </div>
        )}

        {err && (
          <div className="rounded-lg bg-rose-100 px-3 py-2 text-xs text-rose-600 dark:bg-rose-950/60 dark:text-rose-300">
            {err}
          </div>
        )}
        <div ref={bottomRef} />
        </div>
      )}

      {/* 自评那一行：这是「它学没学会」的唯一输入，也是成长值的来源 */}
      {!idle && (
        <div className="flex flex-wrap items-center gap-1.5 border-t border-neutral-200 px-5 py-2 dark:border-neutral-800">
          <span className="text-xs text-neutral-400">它听明白了吗：</span>
          {(
            [
              ['got', '听懂了'],
              ['half', '一半'],
              ['useless', '没讲通'],
            ] as const
          ).map(([v, label]) => (
            <button
              key={v}
              onClick={() => void mark(v)}
              disabled={busy}
              className="rounded-full border border-neutral-300 px-3 py-1 text-xs text-neutral-600 transition-colors hover:border-violet-300 hover:text-violet-600 disabled:opacity-40 dark:border-neutral-700 dark:text-neutral-400 dark:hover:border-violet-500/50"
            >
              {label}
            </button>
          ))}
        </div>
      )}

      {!idle && (
        <div className="border-t border-neutral-200 p-3 dark:border-neutral-800">
          <div className="flex gap-2">
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  void submit()
                }
              }}
              placeholder="接着说（Esc 停止生成）"
              className="flex-1 rounded-md border border-neutral-300 bg-white px-4 py-2.5 text-sm text-neutral-800 outline-none focus:border-violet-500 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100"
            />
            <button
              onClick={() => (busy ? abortRef.current?.abort() : void submit())}
              disabled={!busy && !draft.trim()}
              className="rounded-md wb-btn-primary px-5 text-sm"
            >
              {busy ? '停' : '发送'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

