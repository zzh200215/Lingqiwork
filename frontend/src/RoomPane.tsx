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
import { Link } from 'react-router-dom'

import { api, type PetMeal, type PetRoom, type PetSkillCard, type PetThing } from './api'
import EmptyHint from './EmptyHint'
import { ago, isFresh } from './reltime'

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
      className={`rounded-xl border px-3 py-2.5 text-center ${
        fresh
          ? 'border-violet-300 bg-violet-50/60 dark:border-violet-500/50 dark:bg-violet-500/10'
          : 'border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900'
      }`}
    >
      <div className="text-2xl leading-none">{t.icon}</div>
      <div className="mt-1.5 text-xs font-medium text-neutral-700 dark:text-neutral-200">
        {t.label}
      </div>
      <div className="mt-0.5 text-[10px] text-neutral-400 dark:text-neutral-500">
        {t.detail} · {ago(t.at_ts, now)}
      </div>
    </div>
  )
}

/** 一张技能卡（Q2）：**跑过对照**的提示词。
 *
 *  卡上写的是事实：过了几条、区间多宽、什么时候跑的。**没有进度条、没有熟练度**——
 *  技能不是攒出来的经验条，是「它被证明有效过」这件事本身。基线过期就直说。 */
function Skill({ s, now }: { s: PetSkillCard; now: number }) {
  return (
    <Link
      to={`/work?tab=lab&prompt=${encodeURIComponent(s.name)}`}
      data-room-skill={s.name}
      title={`${s.purpose}｜最近的对照：${s.passed}/${s.cases}（${s.model_id}）`}
      className="block rounded-xl border border-neutral-200 bg-white px-3 py-2.5 transition-colors hover:border-violet-300 dark:border-neutral-800 dark:bg-neutral-900 dark:hover:border-violet-500/50"
    >
      <div className="flex items-baseline gap-2">
        <span className="text-lg leading-none">{KIND_ICON[s.kind] ?? '🔧'}</span>
        <span className="truncate font-mono text-xs text-neutral-700 dark:text-neutral-200">
          {s.name}
        </span>
        <div className="flex-1" />
        <span className="shrink-0 text-[11px] tabular-nums text-neutral-500 dark:text-neutral-400">
          {s.passed}/{s.cases}
        </span>
      </div>
      <div className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-neutral-500 dark:text-neutral-400">
        {s.purpose}
      </div>
      <div className="mt-1 flex items-center gap-2 text-[10px] text-neutral-400">
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

function Meal({ m }: { m: PetMeal }) {  return (
    <span
      data-room-meal={m.key}
      className="inline-flex items-center gap-1.5 rounded-full border border-neutral-200 bg-white px-2.5 py-1 text-[11px] dark:border-neutral-800 dark:bg-neutral-900"
    >
      <span>{m.icon}</span>
      <span className="text-neutral-400 dark:text-neutral-500">{m.module_label}</span>
      <span className="text-neutral-700 dark:text-neutral-200">{m.label}</span>
    </span>
  )
}

export default function RoomPane() {
  const [room, setRoom] = useState<PetRoom | null>(null)
  const [error, setError] = useState<string | null>(null)
  // 一次渲染里只取一次「现在」：同一个列表里每行各算一次 Date.now()，
  // 会出现同一屏上「刚刚」与「1 分钟前」并列这种自相矛盾。
  const [now] = useState(() => Date.now())

  useEffect(() => {
    void (async () => {
      try {
        setRoom(await api.petRoom())
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      }
    })()
  }, [])

  if (error) {
    return (
      <div className="text-sm text-red-600 dark:text-red-300">读小屋出错了：{error}</div>
    )
  }
  if (!room) return <div className="text-sm text-neutral-400">正在看它屋里有什么…</div>

  const props = room.things.filter((t) => t.kind === 'prop')
  const badges = room.things.filter((t) => t.kind === 'badge')
  const meals = room.today.meals
  const ate = meals.reduce((n, m) => n + m.count, 0)

  return (
    <div data-room-root className="space-y-6">
      {/* 屋子本身：零柒站在中间，身上带着它最近到手的那件东西 */}
      <section className="rounded-2xl border border-neutral-200 bg-gradient-to-b from-white to-neutral-50 p-5 dark:border-neutral-800 dark:from-neutral-900 dark:to-neutral-950">
        <div className="flex flex-col items-center">
          <img
            data-room-pet
            src="/pet/idle.webp"
            alt="零柒"
            className="h-24 w-24 object-contain drop-shadow-md"
            onError={(e) => {
              e.currentTarget.src = '/pet-avatar.png'
            }}
          />
          {room.carried ? (
            <div
              data-room-carried={room.carried.id}
              className="mt-1 inline-flex items-center gap-1.5 rounded-full border border-violet-200 bg-white px-3 py-1 text-[11px] dark:border-violet-500/40 dark:bg-neutral-900"
            >
              <span className="text-neutral-400 dark:text-neutral-500">它最近叼回来</span>
              <span>{room.carried.icon}</span>
              <span className="text-neutral-700 dark:text-neutral-200">{room.carried.label}</span>
              <span className="text-neutral-400 dark:text-neutral-500">
                {ago(room.carried.at_ts, now)}
              </span>
            </div>
          ) : (
            <p className="mt-1 text-[11px] text-neutral-400 dark:text-neutral-500">
              它两手空空，正等你做出点什么。
            </p>
          )}
        </div>

        {room.empty ? (
          <EmptyHint
            className="mt-4"
            title="小屋还是空的。"
            hint="交出一份成品、说通一个概念、打一次卡——屋里就会多一件东西，不用来这儿点任何按钮。"
            action={
              <Link to="/work" className="text-xs text-violet-500 hover:underline">
                去工作页
              </Link>
            }
          />
        ) : (
          <div className="mt-5 space-y-5">
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
                <div className="flex flex-wrap gap-2">
                  {badges.map((t) => (
                    <Thing key={t.id} t={t} now={now} />
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </section>

      {/* 它学会的技能：跑过对照的提示词。**没跑过的不摆**——没验过的不是技能。 */}
      <section>
        <div className="mb-2 flex items-baseline gap-2">
          <h2 className="text-sm font-semibold text-neutral-700 dark:text-neutral-200">
            它学会的技能
          </h2>
          <div className="flex-1" />
          <Link to="/work?tab=lab" className="text-xs text-violet-500 hover:underline">
            去实验室
          </Link>
        </div>
        {room.skills.length === 0 ? (
          <p className="text-sm text-neutral-400 dark:text-neutral-500">
            还没有一张技能卡。技能只有一个到手方式：一条提示词在实验室里跑过一次对照。
          </p>
        ) : (
          <div data-room-skills className="grid gap-2 sm:grid-cols-2">
            {room.skills.map((s) => (
              <Skill key={s.name} s={s} now={now} />
            ))}
          </div>
        )}
      </section>

      {/* 今天喂了它什么：每条线今天的真实成果，一条一件 */}
      <section>
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
          <p className="text-sm text-neutral-400 dark:text-neutral-500">
            它不饿，今天还没吃的。等你做完点什么，它就有得吃了。
          </p>
        ) : (
          <div data-room-meals className="flex flex-wrap gap-1.5">
            {meals.map((m) => (
              <Meal key={m.key} m={m} />
            ))}
          </div>
        )}
      </section>

      {/* 架上：真产出，点开就是那篇原文 */}
      <section>
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
          <p className="text-sm text-neutral-400 dark:text-neutral-500">
            架上还空着。工作页跑一条流程，或让对话里的回答「存进产出」。
          </p>
        ) : (
          <ul
            data-room-shelf
            className="divide-y divide-neutral-100 rounded-xl border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800"
          >
            {room.shelf.map((o) => (
              <li key={o.path} className="flex items-center gap-2 px-4 py-2.5 text-sm">
                <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-[10px] text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400">
                  {o.label}
                </span>
                <Link
                  to={`/notes?path=${encodeURIComponent(o.path)}`}
                  title={`打开 ${o.path}`}
                  className="min-w-0 truncate text-neutral-700 hover:text-violet-600 hover:underline dark:text-neutral-200"
                >
                  {o.title}
                </Link>
                <div className="flex-1" />
                <span className="shrink-0 text-xs tabular-nums text-neutral-400 dark:text-neutral-500">
                  {o.date}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
