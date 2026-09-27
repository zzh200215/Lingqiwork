/** 小屋 —— 零柒攒下的东西（P4 · 维度四）。
 *
 *  这一页**没有任何「发奖」逻辑**：每一件东西都是后端从真实数据里算出来的
 *  （`core/pet_room.py`）——交出一份成品、说通一个概念、打一次卡，屋里就多一件。
 *  所以这里也不需要「领取」按钮：真值一变，刷新就有。
 *
 *  两条语气上的讲究，都是刻意的：
 *  - 屋里**没有进度条说「还差 N 件解锁」**，也没有「它饿了」。空的屋子只是空的。
 *  - 每件东西标的是**到手那天**（第 5 份成品落盘的时刻），不是「最近更新」——
 *    攒下来的东西不该因为今天没干活就显得旧。
 */
import { useEffect, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'

import {
  api,
  type FormDomain,
  type PetConceptCard,
  type PetMeal,
  type PetRoom,
  type PetSkillCard,
  type PetState,
  type PetThing,
  type PodcastEntry,
  type WeeklyReport,
} from './api'
import { conceptState } from './conceptState'
import EmptyHint from './EmptyHint'
import { petSprite } from './petFace'
import { ago, isFresh } from './reltime'

/** 服务端那句人话（`{"detail": "..."}`）——`request()` 抛的是「状态码: 原文」，
 *  直接把原文摆到界面上会是一串 JSON。解析不出来就照实说，不吞掉。 */
function errLine(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  const i = msg.indexOf(':')
  if (i > 0) {
    try {
      const detail = (JSON.parse(msg.slice(i + 1).trim()) as { detail?: string }).detail
      if (detail) return detail
    } catch {
      /* 不是 JSON（网络错误之类）就照原样说 */
    }
  }
  return msg
}

/** 周报上那几个小格子：**只摆非零的**（与成长页 `parts` 同一条规矩）。
 *  一排「0 份材料 0 个概念」就是一份自找的欠账清单。 */
function Fact({ k, label }: { k: string; label: string }) {
  return (
    <span
      data-room-weekly-fact={k}
      className="rounded-full border border-neutral-200 bg-white px-2.5 py-1 text-xs text-neutral-600 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-300"
    >
      {label}
    </span>
  )
}

/** 技能卡上的小图标：按提示词的种类给，四种，不多不少。 */
const KIND_ICON: Record<string, string> = {
  system: '⚙️',
  prompt: '📣',
  instruction: '🔧',
  persona: '🎭',
}

function Thing({ t, now }: { t: PetThing; now: number }) {
  const fresh = isFresh(t.at_ts, now)
  return (
    <div
      data-room-thing={t.id}
      data-room-module={t.module}
      title={`${t.detail} · ${t.at.replace('T', ' ')}`}
      className={`rounded-md border px-3 py-2.5 text-center ${
        fresh
          ? 'border-violet-300 bg-violet-50/60 dark:border-violet-500/50 dark:bg-violet-500/10'
          : 'border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900'
      }`}
    >
      <div className="text-2xl leading-none">{t.icon}</div>
      <div className="mt-1.5 text-xs font-medium text-neutral-700 dark:text-neutral-200">
        {t.label}
      </div>
      <div className="mt-0.5 text-xs text-neutral-400 dark:text-neutral-500">
        {t.detail} · {ago(t.at_ts, now)}
      </div>
    </div>
  )
}

/** 一张概念卡（P2 · F13）：学习地图在小屋里的**镜子**。
 *
 *  它与屋里别的东西不是一类：技能卡是「被证明有效过」这件事（到手就不再变），
 *  概念卡照的是**此刻在哪一档**——同一个概念会从「在学」变成「已掌握」，
 *  也可能又挂上「卡住」。所以卡上写的是现状：哪一档、讲过几次、最近一次什么时候、
 *  卡在哪儿（只有卡住那一档有这句话）。
 *
 *  点开走**既有的那条深链**（`/tutor?new=<概念>`，搁置卡的前置候选用的是同一条）：
 *  专门为这个概念开一场教学。这里不另造一个「开始学习」的入口。
 *
 *  「未触及」那张卡在这儿不存在：后端连读都不读它（`pet_room.concept_cards`）。 */
function Concept({ c, now }: { c: PetConceptCard; now: number }) {
  const st = conceptState(c.state)
  return (
    <Link
      to={`/tutor?new=${encodeURIComponent(c.name)}`}
      data-room-concept={c.name}
      data-room-concept-state={c.state}
      title="点开就专门搞懂这个概念"
      className={`block rounded-md border px-3 py-2.5 transition-colors hover:border-violet-300 dark:hover:border-violet-500/50 ${
        st?.card ?? 'border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900'
      }`}
    >
      <div className="flex items-baseline gap-2">
        <span className="min-w-0 truncate text-sm font-medium text-neutral-700 dark:text-neutral-200">
          {c.name}
        </span>
        <div className="flex-1" />
        <span
          className={`shrink-0 text-xs ${st?.text ?? 'text-neutral-500 dark:text-neutral-400'}`}
        >
          {/* 认不出来的档就把档位名照实写出来，不猜一个颜色糊上 */}
          {st?.label ?? c.state}
        </span>
      </div>
      <div className="mt-0.5 flex items-center gap-1.5 text-xs text-neutral-400 dark:text-neutral-500">
        <span className="shrink-0">讲过 {c.sessions} 次</span>
        {c.stuck ? (
          <span className="min-w-0 truncate">· 卡在「{c.stuck}」</span>
        ) : null}
        <div className="flex-1" />
        <span className="shrink-0 tabular-nums">{ago(c.at_ts, now)}</span>
      </div>
    </Link>
  )
}

/** 一张技能卡（Q2）：**跑过对照**的提示词。
 *  卡上写的是事实：过了几条、区间多宽、什么时候跑的。**没有进度条、没有熟练度**——
 *  技能不是攒出来的经验条，是「它被证明有效过」这件事本身。基线过期就直说。 */
function Skill({ s, now }: { s: PetSkillCard; now: number }) {
  return (
    <Link
      to={`/work?tab=prompt&prompt=${encodeURIComponent(s.name)}`}
      data-room-skill={s.name}
      title={`${s.purpose}｜最近的对照：${s.passed}/${s.cases}（${s.model_id}）`}
      className="block rounded-md border border-neutral-200 bg-white px-3 py-2.5 transition-colors hover:border-violet-300 dark:border-neutral-800 dark:bg-neutral-900 dark:hover:border-violet-500/50"
    >
      <div className="flex items-baseline gap-2">
        <span className="text-lg leading-none">{KIND_ICON[s.kind] ?? '🔧'}</span>
        <span className="truncate font-mono text-xs text-neutral-700 dark:text-neutral-200">
          {s.name}
        </span>
        <div className="flex-1" />
        <span className="shrink-0 text-xs tabular-nums text-neutral-500 dark:text-neutral-400">
          {s.passed}/{s.cases}
        </span>
      </div>
      <div className="mt-1 line-clamp-2 text-xs leading-relaxed text-neutral-500 dark:text-neutral-400">
        {s.purpose}
      </div>
      <div className="mt-1 flex items-center gap-2 text-xs text-neutral-400">
        <span>
          最近对照 {Math.round(s.rate * 100)}%（{Math.round(s.ci_low * 100)}–
          {Math.round(s.ci_high * 100)}%）
        </span>
        <div className="flex-1" />
        {s.stale ? (
          <span className="text-amber-600 dark:text-amber-400" title="内容改过，卡上的分数不是这一版的了">
            基线过期
          </span>
        ) : (
          <span>{ago(new Date(s.at).getTime() / 1000, now)}</span>
        )}
      </div>
    </Link>
  )
}

/** 一根枝（Q3 形态）：三样可验证的东西都站住的领域。
 *
 *  卡上只有三个数和它们的样本量。**必须写出「它没学会它」**——「检索得住」和「懂了」
 *  是两件事，把前者讲成后者是这个功能最容易撒的那个谎。这句话写在这里、不写在后端，
 *  是因为它是一句人话，而事实（几条命中、区间多宽）已经由 `/api/form` 给全了。 */
function Branch({ b }: { b: FormDomain }) {
  const r = b.retrieval
  const parts = [
    r.hit_rate == null
      ? `检索 ${r.hits}/${r.cases}`
      : `检索 ${r.hits}/${r.cases}（${Math.round(r.hit_rate * 100)}%，区间 ${Math.round(
          (r.ci_low ?? 0) * 100
        )}–${Math.round((r.ci_high ?? 1) * 100)}%）`,
    `搞懂 ${b.concepts.mastered} 个概念`,
    b.skills.length > 0
      ? `技能卡 ${b.skills.map((s) => `${s.passed}/${s.cases}`).join('、')}`
      : '',
  ].filter(Boolean)

  return (
    <div
      data-room-form={b.domain}
      className="rounded-md border border-emerald-200 bg-emerald-50/40 px-3 py-2.5 dark:border-emerald-500/30 dark:bg-emerald-500/5"
    >
      <div className="flex items-baseline gap-2">
        <span className="text-lg leading-none">🌿</span>
        <span className="truncate text-sm font-medium text-neutral-700 dark:text-neutral-200">
          {b.domain}
        </span>
      </div>
      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs tabular-nums text-neutral-500 dark:text-neutral-400">
        {parts.map((p) => (
          <span key={p}>{p}</span>
        ))}
      </div>
      {r.faithfulness != null && r.judged > 0 ? (
        <div className="mt-0.5 text-xs tabular-nums text-neutral-400 dark:text-neutral-500">
          忠实度 {r.faithfulness}/5（判过 {r.judged} 条）
        </div>
      ) : null}
      <p className="mt-1.5 text-xs leading-relaxed text-neutral-500 dark:text-neutral-400">
        它没有学会{b.domain}。这三个数说的是「在你的材料里找得到、讲得有据、这一条跑通过」
        ——没有一样测过它对你这类问题的判断。
      </p>
      {b.concepts.names.length > 0 ? (
        <div className="mt-1 truncate text-xs text-neutral-400 dark:text-neutral-500">
          搞懂的是：{b.concepts.names.join('、')}
        </div>
      ) : null}
    </div>
  )
}

function Meal({ m }: { m: PetMeal }) {  return (
    <span
      data-room-meal={m.key}
      className="inline-flex items-center gap-1.5 rounded-full border border-neutral-200 bg-white px-2.5 py-1 text-xs dark:border-neutral-800 dark:bg-neutral-900"
    >
      <span>{m.icon}</span>
      <span className="text-neutral-400 dark:text-neutral-500">{m.module_label}</span>
      <span className="text-neutral-700 dark:text-neutral-200">{m.label}</span>
    </span>
  )
}

export default function RoomPane() {
  const [room, setRoom] = useState<PetRoom | null>(null)
  const [state, setState] = useState<PetState | null>(null)
  // 这一周（M4 · G4）：与屋子同一次轮询里取——它是**读出来的事实**，不是另一份存储，
  // 所以不存在「什么时候刷新它」的问题：每次进这一页都是最新的。
  const [week, setWeek] = useState<WeeklyReport | null>(null)
  const [pod, setPod] = useState<PodcastEntry | null>(null)
  const [podBusy, setPodBusy] = useState(false)
  const [weekMsg, setWeekMsg] = useState('')
  const [error, setError] = useState<string | null>(null)
  // 一次渲染里只取一次「现在」：同一个列表里每行各算一次 Date.now()，
  // 会出现同一屏上「刚刚」与「1 分钟前」并列这种自相矛盾。
  const [now] = useState(() => Date.now())
  const path = useLocation().pathname

  // 屋子要**自己能动**：你在这一页待着的时候，后台跑完一条流程、对话里存下一份成品，
  // 这里当场就该多一件——不用你按刷新。
  //
  // 每 15 秒重取一次，而不是也去接一条事件流：这一页只在**你正看着它**的时候挂着，
  // 切进来时本来就会重新取一遍；再开一条 SSE 只为了省这 15 秒，不值得（服务端那条流
  // 是给「它先开口」用的，那是另一个问题）。
  useEffect(() => {
    let alive = true
    const load = () => {
      void (async () => {
        try {
          const r = await api.petRoom()
          if (alive) setRoom(r)
        } catch (e) {
          if (alive) setError(e instanceof Error ? e.message : String(e))
        }
        // 「此刻摆哪个姿势」与悬浮的零柒读的是同一个接口——**它是一只宠物，
        // 两处画它就该是同一个姿势**（`/companion` 落回 idle，除非真有活在跑）。
        try {
          const s = await api.petState(0, path)
          if (alive) setState(s)
        } catch {
          /* 拿不到就摆 idle，别闪 */
        }
        // 周报读不出来**不拖垮整间屋子**：少说一句，别的地方照常
        try {
          const w = await api.weeklyReport()
          if (alive) setWeek(w)
        } catch {
          if (alive) setWeek(null)
        }
      })()
    }
    load()
    const t = setInterval(load, 15000)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [path])

  // 加载/错误也套卡（§F）：裸文本在整页 bento 里读起来像「页面坏了」
  if (error) {
    return (
      <div className="wb-card p-4 text-sm text-rose-600 dark:text-rose-300">
        读小屋出错了：{error}
      </div>
    )
  }
  if (!room)
    return <div className="wb-card p-4 text-sm text-neutral-400">正在看它屋里有什么…</div>

  const props = room.things.filter((t) => t.kind === 'prop')
  const badges = room.things.filter((t) => t.kind === 'badge')
  const concepts = room.concepts
  const meals = room.today.meals
  const ate = meals.reduce((n, m) => n + m.count, 0)

  // 转播客：**单音色念稿**，稿子就是上面那句话（服务端不过模型）。空的一周按钮不出现，
  // 所以走到这里的失败只有「合成挂了」——照实说，不假装成功。
  const makePodcast = () => {
    setPodBusy(true)
    setWeekMsg('')
    void (async () => {
      try {
        setPod(await api.weeklyPodcast())
      } catch (e) {
        setWeekMsg(errLine(e))
      } finally {
        setPodBusy(false)
      }
    })()
  }

  return (
    <div data-room-root className="space-y-4">
      {/* bento 第一行：零柒本尊（5 列）+ 屋里攒下的东西（7 列）。
          本尊卡只摆姿势、那句话、身上叼着什么——「它此刻的样子」；
          右卡是它攒下的实物。两卡等高，谁也不孤零零漂在渐变里。 */}
      <div className="grid grid-cols-1 items-stretch gap-4 md:grid-cols-2 xl:grid-cols-12">
        {/* hero 在 md 档占满一行（§C：hero 卡占满行或 8/12 跨度），xl 起才是 5/7 分栏 */}
        <section className="wb-card-hero rounded-lg p-5 md:col-span-2 xl:col-span-5">
          <div className="flex h-full flex-col items-center justify-center">
            <img
              data-room-pet
              data-room-action={state?.action || 'idle'}
              src={petSprite(state?.action)}
              alt="零柒"
              className="h-24 w-24 object-contain drop-shadow-md"
              onError={(e) => {
                e.currentTarget.src = '/pet-avatar.png'
              }}
            />
            {/* 它此刻的一句话。**空着就不画**——安静是默认（与悬浮那个同一份台词，
                来自 `pet_state._line()`，不是这里另编一句）。 */}
            {state?.line ? (
              <p
                data-room-line
                className="mt-1 text-xs text-neutral-500 dark:text-neutral-400"
              >
                {state.line}
              </p>
            ) : null}
            {room.carried ? (
              <div
                data-room-carried={room.carried.id}
                className="mt-1 inline-flex items-center gap-1.5 rounded-full border border-violet-200 bg-white px-3 py-1 text-xs dark:border-violet-500/40 dark:bg-neutral-900"
              >
                <span className="text-neutral-400 dark:text-neutral-500">它最近叼回来</span>
                <span>{room.carried.icon}</span>
                <span className="text-neutral-700 dark:text-neutral-200">{room.carried.label}</span>
                <span className="text-neutral-400 dark:text-neutral-500">
                  {ago(room.carried.at_ts, now)}
                </span>
              </div>
            ) : (
              <p className="mt-1 text-xs text-neutral-400 dark:text-neutral-500">
                它两手空空，正等你做出点什么。
              </p>
            )}
            {/* 喂养风味（Z4）：它这阵子被喂成了什么味道——一句**读出来的事实**。
                与成长页称号旁那一行同源（`pet_tone.flavor()`）；数不出来时一个字都不摆。 */}
            {room.flavor ? (
              <p data-room-flavor className="mt-1.5 text-xs text-neutral-400 dark:text-neutral-500">
                {room.flavor}
              </p>
            ) : null}
          </div>
        </section>

        <section className="wb-card flex flex-col p-4 md:col-span-2 xl:col-span-7">
          {room.empty ? (
            <EmptyHint
              title="小屋还是空的。"
              hint="交出一份成品、说通一个概念、打一次卡——屋里就会多一件东西，不用来这儿点任何按钮。"
              action={
                <Link to="/work" className="text-xs text-violet-500 hover:underline">
                  去工作页
                </Link>
              }
            />
          ) : (
            <div className="flex-1 space-y-5">
              {props.length > 0 && (
                <div>
                  <h2 className="mb-2 text-sm font-semibold text-neutral-700 dark:text-neutral-200">
                    屋里摆着
                  </h2>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
                    {props.map((t) => (
                      <Thing key={t.id} t={t} now={now} />
                    ))}
                  </div>
                </div>
              )}
              {badges.length > 0 && (
                <div>
                  <h2 className="mb-2 text-sm font-semibold text-neutral-700 dark:text-neutral-200">
                    徽章
                  </h2>
                  {/* 徽章与摆件同一铺法（网格均分）——同组件两种铺法会显乱（§#12） */}
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
                    {badges.map((t) => (
                      <Thing key={t.id} t={t} now={now} />
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </section>
      </div>

      {/* bento 第二行：它记住的概念（5 列）+ 架上那几份（7 列）。
          概念是「它脑子里此刻记着什么」，架子是「它交出过什么」——并排正好一面两窗。 */}
      <div className="grid grid-cols-1 items-stretch gap-4 md:grid-cols-2 xl:grid-cols-12">
        {/* 它记住的概念（P2 · F13）：学页那张**学习地图在小屋里的镜子**。
            **屋里的一类新东西**——不是徽章（攒下的）、不是技能卡（跑过对照的）、
            不是枝（三样都够的领域），是「它脑子里现在记着哪些概念、各在哪一档」。
            「未触及」不进这一节：那是「还没做的事」的清单，屋里不摆账。 */}
        <section className="wb-card flex flex-col p-4 xl:col-span-5">
          <div className="mb-2 flex items-baseline gap-2">
            <h2 className="text-sm font-semibold text-neutral-700 dark:text-neutral-200">
              它记住的概念
            </h2>
            {concepts.total > concepts.cards.length ? (
              // 摆不下的那些**不是没了**：屋里这一屏放得下 12 张，全部在地图上
              <span className="text-xs tabular-nums text-neutral-400 dark:text-neutral-500">
                共 {concepts.total} 个
              </span>
            ) : null}
            <div className="flex-1" />
            <Link to="/tutor" className="text-xs text-violet-500 hover:underline">
              看学习地图
            </Link>
          </div>
          {concepts.cards.length === 0 ? (
            <EmptyHint
              className="flex-1"
              title="还没有一张概念卡。"
              hint="它记不记得一个概念只由一件事决定：你为它开过一场教学——说通了、半懂、卡在哪儿，都是从那些会话里读出来的。"
            />
          ) : (
            <div data-room-concepts className="grid flex-1 gap-2 sm:grid-cols-2">
              {concepts.cards.map((c) => (
                <Concept key={c.id} c={c} now={now} />
              ))}
            </div>
          )}
        </section>

        {/* 架上：真产出，点开就是那篇原文 */}
        <section className="wb-card flex flex-col p-4 xl:col-span-7">
          <div className="mb-2 flex items-baseline gap-2">
            <h2 className="text-sm font-semibold text-neutral-700 dark:text-neutral-200">
              架上那几份
            </h2>
            <div className="flex-1" />
            <Link to="/work" className="text-xs text-violet-500 hover:underline">
              全部产出
            </Link>
          </div>
          {room.shelf.length === 0 ? (
            <EmptyHint
              className="flex-1"
              title="架上还空着。"
              hint="工作页跑一条流程，或让对话里的回答「存进产出」。"
            />
          ) : (
            <ul
              data-room-shelf
              className="-mx-4 divide-y divide-neutral-100 dark:divide-neutral-800/70"
            >
              {room.shelf.map((o) => {
                // 它身上叼着的就是这一份（同一份真值：后端 `carried.ref` 就是这条 `path`）。
                // 不另算一次「谁最新」——两处各算各的，迟早有一处会说是另一件。
                const carried = !!room.carried?.ref && room.carried.ref === o.path
                const fresh = isFresh(o.mtime, now)
                return (
                  <li key={o.path} className="flex items-center gap-2 px-4 py-2.5 text-sm">
                    <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-xs text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400">
                      {o.label}
                    </span>
                    <Link
                      to={`/notes?path=${encodeURIComponent(o.path)}`}
                      title={`打开 ${o.path}`}
                      className="min-w-0 truncate text-neutral-700 hover:text-violet-600 hover:underline dark:text-neutral-200"
                    >
                      {o.title}
                    </Link>
                    {carried ? (
                      <span
                        data-room-shelf-carried={o.path}
                        className="shrink-0 rounded-full border border-violet-200 bg-violet-50 px-1.5 py-0.5 text-xs text-violet-600 dark:border-violet-500/40 dark:bg-violet-500/10 dark:text-violet-300"
                      >
                        它刚叼回来的
                      </span>
                    ) : null}
                    <div className="flex-1" />
                    <span
                      className={`shrink-0 text-xs tabular-nums ${
                        fresh
                          ? 'text-violet-600 dark:text-violet-300'
                          : 'text-neutral-400 dark:text-neutral-500'
                      }`}
                    >
                      {/* 24 小时内到手的标「多久以前」，更早的回到日期——屋里别摆一片
                          「3 天前 4 天前 5 天前」，那是流水账，不是攒下来的东西。 */}
                      {fresh ? ago(o.mtime, now) : o.date}
                    </span>
                  </li>
                )
              })}
            </ul>
          )}
        </section>
      </div>

      {/* bento 第三行：它学会的技能（6 列）+ 它长出的枝（6 列）。 */}
      <div className="grid grid-cols-1 items-stretch gap-4 md:grid-cols-2 xl:grid-cols-12">
        {/* 它学会的技能：跑过对照的提示词。**没跑过的不摆**——没验过的不是技能。 */}
        <section className="wb-card flex flex-col p-4 xl:col-span-6">
          <div className="mb-2 flex items-baseline gap-2">
            <h2 className="text-sm font-semibold text-neutral-700 dark:text-neutral-200">
              它学会的技能
            </h2>
            <div className="flex-1" />
            <Link to="/work?tab=prompt" className="text-xs text-violet-500 hover:underline">
              去提示词页
            </Link>
          </div>
          {room.skills.length === 0 ? (
            <EmptyHint
              className="flex-1"
              title="还没有一张技能卡。"
              hint="技能只有一个到手方式：一条提示词在实验室里跑过一次对照。"
            />
          ) : (
            <div data-room-skills className="grid flex-1 gap-2 sm:grid-cols-2">
              {room.skills.map((s) => (
                <Skill key={s.name} s={s} now={now} />
              ))}
            </div>
          )}
        </section>

        {/* 它长出的枝（Q3 形态）：三样都够的领域。**差一样就不长**——一个数好看不算能力。 */}
        <section className="wb-card flex flex-col p-4 xl:col-span-6">
          <div className="mb-2 flex items-baseline gap-2">
            <h2 className="text-sm font-semibold text-neutral-700 dark:text-neutral-200">
              它长出的枝
            </h2>
            <div className="flex-1" />
            <Link to="/work?tab=prompt" className="text-xs text-violet-500 hover:underline">
              看全部领域
            </Link>
          </div>
          {room.form.length === 0 ? (
            <EmptyHint
              className="flex-1"
              title="还没有长出枝。"
              hint="一根枝要三样在同一个领域里都有足够的证据：检索得住的命中率、搞懂过的概念、跑通过的技能卡。领域是你在证据上自己写的一个短词——样例题上、教学会话上、实验室那套用例上，只写在一个地方还不算。"
            />
          ) : (
            <div data-room-form-list className="grid flex-1 gap-2">
              {room.form.map((b) => (
                <Branch key={b.domain} b={b} />
              ))}
            </div>
          )}
        </section>
      </div>

      {/* bento 第四行：今天喂了它什么（5 列）+ 这一周（7 列）。 */}
      <div className="grid grid-cols-1 items-stretch gap-4 md:grid-cols-2 xl:grid-cols-12">
        {/* 今天喂了它什么：每条线今天的真实成果，一条一件 */}
        <section className="wb-card flex flex-col p-4 xl:col-span-5">
          <div className="mb-2 flex items-baseline gap-2">
            <h2 className="text-sm font-semibold text-neutral-700 dark:text-neutral-200">
              今天喂了它什么
            </h2>
            <div className="flex-1" />
            {meals.length > 0 && (
              <span className="text-xs tabular-nums text-neutral-400 dark:text-neutral-500">
                {ate} 件
              </span>
            )}
          </div>
          {meals.length === 0 ? (
            <EmptyHint
              className="flex-1"
              title="它不饿，今天还没吃的。"
              hint="等你做完点什么，它就有得吃了。"
            />
          ) : (
            <div data-room-meals className="flex flex-1 flex-wrap content-start gap-1.5">
              {meals.map((m) => (
                <Meal key={m.key} m={m} />
              ))}
            </div>
          )}
        </section>

        {/* 这一周（M4 · PLAN §3 G4）：**全部读出来的事实**，一句话说完。
            这里不是又一张清单：那句话就是全部，下面几个小格子只是让你核数
            （「数字与库、与目录一致」是这一条的验收）。周日 21:00 那句问候说的是同一份
            ——`text` 来自后端 `weekly.text()`，界面不另写文案，也就不可能出现两种说法。 */}
        {week ? (
          <section className="wb-card p-4 xl:col-span-7">
            <div className="mb-2 flex items-baseline gap-2">
              <h2 className="text-sm font-semibold text-neutral-700 dark:text-neutral-200">
                这一周
              </h2>
              <span className="text-xs tabular-nums text-neutral-400 dark:text-neutral-500">
                {week.week.start.slice(5)} – {week.week.end.slice(5)}
              </span>
              <div className="flex-1" />
              {week.empty ? null : (
                <button
                  data-room-weekly-podcast
                  onClick={makePodcast}
                  disabled={podBusy}
                  title="念的就是上面那句话，单音色"
                  className="rounded-md border border-neutral-300 px-2 py-0.5 text-xs text-neutral-600 transition-colors hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
                >
                  {podBusy ? '正在录…' : '转成播客'}
                </button>
              )}
            </div>
            {week.empty ? (
              <p data-room-weekly-empty className="text-sm text-neutral-400 dark:text-neutral-500">
                这一周还没什么可说的——它只在真有事实的时候开口。
              </p>
            ) : (
              <>
                <p data-room-weekly-text className="text-sm leading-relaxed text-neutral-700 dark:text-neutral-200">
                  {week.text}
                </p>
                <div data-room-weekly-facts className="mt-2 flex flex-wrap gap-1.5">
                  {week.facts.sources > 0 ? (
                    <Fact
                      k="sources"
                      label={`材料 ${week.facts.sources} 份 · 点 ${week.facts.points} 个`}
                    />
                  ) : null}
                  {week.facts.got > 0 ? <Fact k="got" label={`说通 ${week.facts.got} 个概念`} /> : null}
                  {week.facts.half > 0 ? <Fact k="half" label={`半懂 ${week.facts.half} 个`} /> : null}
                  {week.facts.outputs > 0 ? (
                    <Fact k="outputs" label={`成品 ${week.facts.outputs} 份`} />
                  ) : null}
                  {week.facts.recurring.map((c) => (
                    <span
                      key={c}
                      data-room-weekly-recurring={c}
                      className="rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 text-xs text-amber-700 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-300"
                    >
                      「{c}」又卡住
                    </span>
                  ))}
                </div>
                {pod ? (
                  <audio
                    data-room-weekly-audio={pod.file}
                    controls
                    preload="none"
                    src={`/api/podcast/audio/${pod.file}`}
                    className="mt-2 h-9 w-full max-w-xl"
                  />
                ) : null}
              </>
            )}
            {weekMsg ? (
              <p data-room-weekly-msg className="mt-1 text-xs text-rose-500">
                {weekMsg}
              </p>
            ) : null}
          </section>
        ) : null}
      </div>
    </div>
  )
}
