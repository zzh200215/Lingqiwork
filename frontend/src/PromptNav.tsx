/** 提示词库的左导航：三个「不是分类」的入口 + 分类清单。
 *
 *  ## 为什么单独一份
 *
 *  它是一整块**只读导航**（除了 `onPick` 与 `onManage` 两个回调，什么都不持有），
 *  而 `PromptLibrary.tsx` 主组件那份已经很长了。挪出来不改变行为：`data-prompt-nav` /
 *  `data-cat-manage` 两个锚点、以及每一行的计数口径都原样。
 *
 *  ## 三种「入口」与分类是两回事
 *
 *  「全部 / 最近使用 / 收藏」是**看的方式**，「分类」是**东西的归属**——所以中间有一条
 *  分隔（`pt-3`）。混在一起排，看的人会以为「收藏」也是一个分类。
 *
 *  ## 那两句空话是有意写的
 *
 *  一个分类都没有时不留空白，而是说清**怎么建**（齿轮或编辑器里填）——不然那一栏
 *  看起来像加载失败。
 */
import { Clock, Library, Settings2, Star } from 'lucide-react'

import { UNCATEGORIZED, catColor } from './PromptViews'
import type { PromptCategoryItem, PromptFacets, PromptItem } from './api'

export default function PromptNav({
  nav,
  onPick,
  onManage,
  facets,
  list,
  cats,
}: {
  /** 当前选中的那一个：三个关键字之一、一个分类名、或空串（未分类）。 */
  nav: string
  onPick: (key: string) => void
  onManage: () => void
  facets: PromptFacets | null
  /** 整个库。两个计数（最近用过几条 / 收藏几条）从它现算——**不另存一份计数**，
   *  否则改完一条之后那一栏会继续显示旧数。 */
  list: PromptItem[]
  cats: PromptCategoryItem[]
}) {
  /** 选中态：浅底 + 加重字。与「分类色 / 标签色」分工不同——那里说的是**这是什么**，
   *  这里说的是**你正在看这个**。 */
  const navBtn = (active: boolean) =>
    `flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors ${
      active
        ? 'bg-neutral-100 font-medium text-neutral-900 dark:bg-neutral-800 dark:text-neutral-100'
        : 'text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800'
    }`

  return (
    <nav className="shrink-0 space-y-0.5 lg:w-44" aria-label="提示词导航" data-prompt-nav>
      <button onClick={() => onPick('all')} className={navBtn(nav === 'all')}>
        <Library className="h-4 w-4 shrink-0" />
        <span className="flex-1">全部提示词</span>
        <span className="text-xs text-neutral-400">{facets?.total ?? 0}</span>
      </button>
      <button onClick={() => onPick('recent')} className={navBtn(nav === 'recent')}>
        <Clock className="h-4 w-4 shrink-0" />
        <span className="flex-1">最近使用</span>
        <span className="text-xs text-neutral-400">
          {list.filter((p) => p.last_used_at).length}
        </span>
      </button>
      <button onClick={() => onPick('fav')} className={navBtn(nav === 'fav')}>
        <Star className="h-4 w-4 shrink-0" />
        <span className="flex-1">收藏</span>
        <span className="text-xs text-neutral-400">
          {list.filter((p) => p.favorite).length}
        </span>
      </button>

      <div className="pt-3">
        <div className="flex items-center justify-between px-2.5 pb-1">
          <span className="text-[13px] uppercase tracking-wider text-neutral-400">分类</span>
          <button
            onClick={onManage}
            className="text-neutral-400 transition-colors hover:text-violet-600"
            title="分类管理"
            aria-label="分类管理"
            data-cat-manage
          >
            <Settings2 className="h-4 w-4" />
          </button>
        </div>
        {cats.map((c) => (
          <button key={c.name} onClick={() => onPick(c.name)} className={navBtn(nav === c.name)}>
            <span
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ backgroundColor: catColor(c.name, c.color) }}
            />
            <span className="min-w-0 flex-1 truncate">{c.name}</span>
            <span className="text-xs text-neutral-400">{c.count}</span>
          </button>
        ))}
        {facets?.uncategorized ? (
          <button onClick={() => onPick('')} className={navBtn(nav === '')}>
            <span className="h-2 w-2 shrink-0 rounded-full bg-neutral-300 dark:bg-neutral-600" />
            <span className="min-w-0 flex-1 truncate">{UNCATEGORIZED}</span>
            <span className="text-xs text-neutral-400">{facets.uncategorized}</span>
          </button>
        ) : null}
        {!cats.length && !facets?.uncategorized ? (
          <p className="px-2.5 py-1 text-sm leading-relaxed text-neutral-400">
            还没有分类。点上面的齿轮建一个，或者在编辑里给一条填上分类。
          </p>
        ) : null}
      </div>
    </nav>
  )
}
