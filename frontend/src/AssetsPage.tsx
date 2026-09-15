/** 资产 — 你攒下的一切，和装它们的地方。
 *
 *  导航收缩成五区之后，散落的几个库（笔记 / 知识库 / 仪表盘 / 成长）需要一个集中点，
 *  否则「我记得我存过一样什么东西」就无处可去。产出物在这里只做**速览**（最近几件 +
 *  去全部清单的路），全部清单仍归工作页——归宿和入口分开，别做成两份一样的列表。
 */
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'

import { api, type WorkOutput } from './api'
import EmptyHint from './EmptyHint'
import OutputCard from './OutputCard'
import PageShell from './PageShell'

/** 库的入口卡。东西都在各自的页面里，这里只负责让你想得起它们。 */
const LIBRARIES: { href: string; icon: string; name: string; desc: string }[] = [
  { href: '/notes', icon: '📝', name: '笔记', desc: '你写下的、剪藏进来的，都在 vault/notes' },
  { href: '/kb', icon: '📚', name: '知识库', desc: '建过索引的文档——各处取材先捞这里' },
  { href: '/dashboard', icon: '📊', name: '仪表盘', desc: '复盘、决策回顾和日志' },
  { href: '/growth', icon: '🌱', name: '成长', desc: '你和这件事的关系，只累计不记账' },
]

export default function AssetsPage() {
  const [outputs, setOutputs] = useState<WorkOutput[] | null>(null)

  useEffect(() => {
    api
      .workOutputs()
      .then((r) => setOutputs(r.outputs))
      .catch(() => setOutputs([])) // 拉不到就当没有，页面的其余部分照常
  }, [])

  const recent = (outputs ?? []).slice(0, 8)

  return (
    <PageShell
      title="资产"
      description="你攒下的一切：写过的、剪过的、跑出来的——入口都在这。"
      maxWidth="4xl"
    >
      <section className="mb-8">
        <div className="flex items-baseline justify-between pb-2">
          <h2 className="text-sm font-semibold text-neutral-700 dark:text-neutral-200">产出物</h2>
          {(outputs?.length ?? 0) > 0 ? (
            <Link to="/work?tab=output" className="text-xs text-violet-500 hover:underline">
              全部 {outputs!.length} 件 → 工作页
            </Link>
          ) : null}
        </div>

        {outputs === null ? null : recent.length === 0 ? (
          <EmptyHint
            title="还没有产出。"
            hint={
              <>
                去
                <Link to="/work" className="text-violet-500 hover:underline">
                  工作
                </Link>
                写一份交付，或在
                <Link to="/tutor" className="text-violet-500 hover:underline">
                  学
                </Link>
                里跑一轮研究——成品会自动落到这里。
              </>
            }
          />
        ) : (
          <ul className="divide-y divide-neutral-100 dark:divide-neutral-800/70">
            {recent.map((o) => (
              <li key={o.path}>
                <OutputCard
                  kind={o.kind}
                  label={o.label}
                  title={o.title}
                  href={`/notes?path=${encodeURIComponent(o.path)}`}
                  actions={<span className="text-[11px] text-neutral-400">{o.date.slice(5)}</span>}
                />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <div className="flex items-baseline justify-between pb-2">
          <h2 className="text-sm font-semibold text-neutral-700 dark:text-neutral-200">库与记录</h2>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          {LIBRARIES.map((l) => (
            <Link
              key={l.href}
              to={l.href}
              className="rounded-xl border border-neutral-200 p-4 transition-colors hover:border-violet-300 hover:bg-violet-50/40 dark:border-neutral-800 dark:hover:border-violet-500/40 dark:hover:bg-violet-500/5"
            >
              <p className="flex items-center gap-2 text-sm font-medium text-neutral-800 dark:text-neutral-100">
                <span className="text-base leading-none">{l.icon}</span>
                {l.name}
              </p>
              <p className="mt-1 text-xs leading-relaxed text-neutral-500 dark:text-neutral-400">
                {l.desc}
              </p>
            </Link>
          ))}
        </div>
      </section>
    </PageShell>
  )
}
