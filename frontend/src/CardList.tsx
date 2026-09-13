/** 全部卡片——卡片此前**没有任何清单界面**（`api.listCards` 全前端零引用）：只有生成它们的
 *  `CardMaker` 和复习队列。于是「卡片」这一类在「事」上没有落点可挂。
 *
 *  这里补的就是那个落点：能找、能筛、能挂到某件事上。不做批量管理——那是另一件事，
 *  而这一页是复习页，不该长成卡片的控制台。
 */
import { useCallback, useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'

import { api, type CardItem } from './api'
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

  const needle = q.trim().toLowerCase()
  const shown = (cards ?? []).filter(
    (c) => !needle || `${c.front}${c.back}${c.topic}`.toLowerCase().includes(needle)
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
  useDeepLink('card', open && cards !== null)

  return (
    <section className="rounded-xl border border-neutral-200/80 px-3 py-2.5 dark:border-neutral-800/80">
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
            className="w-full rounded-lg border border-neutral-300 bg-white px-2.5 py-1.5 text-[11px] outline-none placeholder:text-neutral-400 focus:border-violet-400 dark:border-neutral-700 dark:bg-neutral-900"
          />
          {busy ? <p className="pt-2 text-[11px] text-neutral-400">读卡片…</p> : null}
          {!busy && cards !== null && shown.length === 0 ? (
            <p className="pt-2 text-[11px] text-neutral-400">
              {cards.length === 0 ? '还没有卡片——在笔记页划词或 🎴 出卡。' : '没有匹配的卡片。'}
            </p>
          ) : null}
          <ul className="mt-1 divide-y divide-neutral-100 dark:divide-neutral-800/70">
            {shown.map((c) => {
              const src = vaultSource(c.source)
              return (
                <li key={c.id} id={`card-${c.id}`} className="flex items-center gap-2 py-1.5">
                  <span
                    className="min-w-0 flex-1 truncate text-[11px] text-neutral-700 dark:text-neutral-200"
                    title={c.back}
                  >
                    {c.front}
                  </span>
                  {c.topic ? (
                    <span className="shrink-0 text-[10px] text-neutral-400">{c.topic}</span>
                  ) : null}
                  {c.suspended ? (
                    <span className="shrink-0 text-[10px] text-neutral-300 dark:text-neutral-600">
                      已搁置
                    </span>
                  ) : null}
                  {src ? (
                    <Link
                      to={`/notes?path=${encodeURIComponent(src)}`}
                      title={src}
                      className="shrink-0 text-[10px] text-neutral-400 transition-colors hover:text-violet-600"
                    >
                      出处
                    </Link>
                  ) : null}
                  <AttachToThread kind="card" ref={String(c.id)} />
                </li>
              )
            })}
          </ul>
        </div>
      ) : null}
    </section>
  )
}
