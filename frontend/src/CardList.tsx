/** 全部卡片——卡片此前**没有任何清单界面**（`api.listCards` 全前端零引用）：只有生成它们的
 *  `CardMaker` 和复习队列。于是「卡片」这一类在「事」上没有落点可挂。
 *
 *  这里补的就是那个落点：能找、能筛、能挂到某件事上。不做批量管理——那是另一件事，
 *  而这一页是复习页，不该长成卡片的控制台。
 *
 *  两处后来长出来的东西：
 *
 *  1. **`?topic=` 进来的这一份筛**（PLAN2 T1 场景 B）：学习地图上那一行小字点了就跳到这里，
 *     只看那个概念名下的卡。参数是**可重复的**（一个概念可能对应好几个话题词），
 *     筛的是 `Card.topic` **精确相等**——不是字符串搜索，别名那种情况才不会被漏掉。
 *  2. **搁置卡的「可能缺前置」**（PLAN2 T3）：一张卡答错 8 次被搁置之后，这里能翻出
 *     「半懂 / 又卡住」的那几个概念，点一个直接开一场教学。**拉取式**：点开才有，
 *     搁置那一刻一个字都不说，也不进任何提醒。
 */
import { useCallback, useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'

import { api, type CardItem, type CardPrereq } from './api'
import AttachToThread from './AttachToThread'
import { useDeepLink } from './deeplink'

const CAP = 200

/** `repo:` / `dir:` 的卡片在 vault 之外，笔记页够不着。 */
function vaultSource(s: string): string {
  return s && !s.startsWith('repo:') && !s.startsWith('dir:') ? s : ''
}

export default function CardList() {
  const [open, setOpen] = useState(false)
  const [cards, setCards] = useState<CardItem[] | null>(null)
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState(false)
  const [topics, setTopics] = useState<string[]>([])
  const [prereq, setPrereq] = useState<Record<number, CardPrereq | null>>({})
  const [preBusy, setPreBusy] = useState(0)

  const load = useCallback(async () => {
    setBusy(true)
    try {
      setCards((await api.listCards({ limit: CAP })).cards)
    } catch {
      setCards([]) // 拉不到就当作空，页面照常
    } finally {
      setBusy(false)
    }
  }, [])

  function toggle() {
    const next = !open
    setOpen(next)
    if (next && cards === null) void load()
  }

  /** 「可能缺前置」：**点一下才算一次**（拉取式）。找不到就是空表——那是答案，不是错误。
   *
   *  同时记一笔「翻过」（PLAN2 §6 回指采纳的分母）：那条数的用途是判这个功能**有没有人看**
   *  （没人看就撤），所以它必须真的对应「有人翻过」，不能靠 GET 的副作用顺手记。
   *  fire-and-forget：记不上不该让翻候选这件事失败，而漏记只会让分母偏小。 */
  async function loadPrereq(id: number) {
    setPreBusy(id)
    void api.markPrereqSeen(id).catch(() => {})
    try {
      const r = await api.cardPrereq(id)
      setPrereq((p) => ({ ...p, [id]: r }))
    } catch {
      setPrereq((p) => ({ ...p, [id]: null }))
    } finally {
      setPreBusy(0)
    }
  }

  const needle = q.trim().toLowerCase()
  const shown = (cards ?? []).filter(
    (c) =>
      (topics.length === 0 || topics.includes(c.topic)) &&
      (!needle || `${c.front}${c.back}${c.topic}`.toLowerCase().includes(needle))
  )

  // 从「一件事」点一张卡过来（`?card=7`）：这一段默认是收起的，得先展开再亮。
  // 只在 param 变化时跑一次——cards 是不是 null 用当时闭包里的值就够（首次必为 null）。
  const [params] = useSearchParams()
  const wanted = params.get('card') || ''
  useEffect(() => {
    if (!wanted) return
    setOpen(true)
    if (cards === null) void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wanted])

  // 从学习地图那一行小字过来（`?topic=…`，可重复）：同样先展开再筛。
  // key 用拼起来的字符串：SPA 里同路由换参数不会重挂组件，按数组比每次都是新引用。
  const topicParams = params.getAll('topic')
  const topicKey = topicParams.join('\u0001')
  useEffect(() => {
    if (!topicParams.length) return
    setOpen(true)
    setTopics(topicParams)
    if (cards === null) void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topicKey])

  useDeepLink('card', open && cards !== null)

  return (
    <section className="rounded-md border border-neutral-200/80 px-3 py-2.5 dark:border-neutral-800/80">
      <button
        onClick={toggle}
        className="flex w-full items-center gap-2 text-left text-xs text-neutral-500 transition-colors hover:text-violet-600 dark:text-neutral-400"
      >
        <span className="font-medium">全部卡片</span>
        {cards ? <span className="text-neutral-400">{cards.length} 张</span> : null}
        <span className="ml-auto text-neutral-400">{open ? '收起' : '展开'}</span>
      </button>

      {open ? (
        <div className="mt-2">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="筛题面 / 答案 / 主题…"
            className="w-full rounded-lg border border-neutral-300 bg-white px-2.5 py-1.5 text-xs outline-none placeholder:text-neutral-400 focus:border-violet-400 dark:border-neutral-700 dark:bg-neutral-900"
          />
          {/* 筛着的时候要说出来筛了什么、怎么撤——不然「怎么少了几张卡」是个查不出的问题 */}
          {topics.length > 0 ? (
            <p data-topic-filter className="pt-1.5 text-xs text-sky-600 dark:text-sky-400/90">
              只看 {topics.map((t) => `「${t}」`).join(' ')} 的卡
              <button
                onClick={() => setTopics([])}
                className="ml-2 text-neutral-400 underline hover:text-violet-600"
              >
                清除
              </button>
            </p>
          ) : null}
          {busy ? <p className="pt-2 text-xs text-neutral-400">读卡片…</p> : null}
          {!busy && cards !== null && shown.length === 0 ? (
            <p className="pt-2 text-xs text-neutral-400">
              {cards.length === 0 ? '还没有卡片——在笔记页划词或 🎴 出卡。' : '没有匹配的卡片。'}
            </p>
          ) : null}
          <ul className="mt-1 divide-y divide-neutral-100 dark:divide-neutral-800/70">
            {shown.map((c) => {
              const src = vaultSource(c.source)
              const pre = prereq[c.id]
              return (
                <li key={c.id} id={`card-${c.id}`} className="py-1.5">
                  <div className="flex items-center gap-2">
                    <span
                      className="min-w-0 flex-1 truncate text-xs text-neutral-700 dark:text-neutral-200"
                      title={c.back}
                    >
                      {c.front}
                    </span>
                    {c.topic ? (
                      <span className="shrink-0 text-xs text-neutral-400">{c.topic}</span>
                    ) : null}
                    {c.suspended ? (
                      <span className="shrink-0 text-xs text-neutral-300 dark:text-neutral-600">
                        已搁置
                      </span>
                    ) : null}
                    {src ? (
                      <Link
                        to={`/notes?path=${encodeURIComponent(src)}`}
                        title={src}
                        className="shrink-0 text-xs text-neutral-400 transition-colors hover:text-violet-600"
                      >
                        出处
                      </Link>
                    ) : null}
                    <AttachToThread kind="card" ref={String(c.id)} />
                  </div>
                  {/* 搁置的卡：搁置照旧发生（诊断没错），缺的是**搁置之后没有回指**。
                      这一栏把「卡坏了」变成「路不通，先修那段」——但只是**可能**缺，
                      候选是建议不是结论，界面上不写死。 */}
                  {c.suspended ? (
                    <div className="pt-0.5">
                      {pre ? (
                        pre.candidates.length > 0 ? (
                          <p data-prereq={c.id} className="text-xs text-neutral-500 dark:text-neutral-400">
                            可能缺前置：
                            {pre.candidates.map((k) => (
                              <Link
                                key={k.concept}
                                to={`/tutor?new=${encodeURIComponent(k.concept)}&prereq=${c.id}`}
                                title={`开一场教学：${k.concept}（这场课会记成「从这张卡的候选开的」）`}
                                className="ml-1 rounded-full border border-violet-200 px-1.5 py-0.5 text-violet-600 transition-colors hover:border-violet-400 dark:border-violet-500/30 dark:text-violet-300"
                              >
                                {k.concept}
                                <span className="text-neutral-400">（{k.status}）</span>
                              </Link>
                            ))}
                          </p>
                        ) : (
                          <p data-prereq-empty={c.id} className="text-xs text-neutral-400">
                            没找到可能的前置——不是每张搁置的卡都缺一段路。
                          </p>
                        )
                      ) : (
                        <button
                          data-prereq-open={c.id}
                          onClick={() => void loadPrereq(c.id)}
                          disabled={preBusy === c.id}
                          title="翻一翻：这张卡可能缺哪个前置概念"
                          className="text-xs text-neutral-400 underline transition-colors hover:text-violet-600 disabled:opacity-40"
                        >
                          {preBusy === c.id ? '翻…' : '可能缺前置？'}
                        </button>
                      )}
                    </div>
                  ) : null}
                </li>
              )
            })}
          </ul>
        </div>
      ) : null}
    </section>
  )
}
