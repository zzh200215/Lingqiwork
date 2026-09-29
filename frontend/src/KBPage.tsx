// 知识库页：页签栏 + 五个页签的组合（方向 6 第三刀，2026-09-29 按页签拆分）。
// 各页签的实现住在 Kb*Tab.tsx；共享工具与类型在 kbShared.ts。
// 页签组件常驻挂载、用 hidden 收起不活跃的——和拆分前一样：页签间来回切，
// 已填的表单与结果不丢；active prop 只负责各自数据的懒加载（原 if (tab === 'x') refreshX()）。
import { useState } from 'react'
import { type LucideIcon, ClipboardCheck, FolderOpen, GitBranch, Search, Waypoints } from 'lucide-react'
import { type KbCounts, type KbTab } from './kbShared'
import KbDirsTab from './KbDirsTab'
import KbEvalTab from './KbEvalTab'
import KbIndexTab from './KbIndexTab'
import KbKgTab from './KbKgTab'
import KbReposTab from './KbReposTab'

/** 五个页签各自的线性图标（emoji 从 chrome 退役） */
const KB_TAB_ICON: Record<KbTab, LucideIcon> = {
  index: Search,
  repos: GitBranch,
  dirs: FolderOpen,
  eval: ClipboardCheck,
  kg: Waypoints,
}

export default function KbPage() {
  const [tab, setTab] = useState<KbTab>('index')
  // 页签栏角标。原来 repos/dirs 的数量由 index 页签的 refresh 顺带取回，eval 的要
  // 等第一次进评估页签才有——现在由各页签加载后自己上报，时机与原来一致。
  const [counts, setCounts] = useState<KbCounts>({ repos: 0, dirs: 0, eval: 0 })
  const reportCounts = (patch: Partial<KbCounts>) => setCounts((c) => ({ ...c, ...patch }))

  return (
    <>
      <div className="mx-auto max-w-[1600px] px-6 py-6">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">知识库</h1>
          <p className="mt-0.5 text-xs text-neutral-400">管理 RAG 的知识来源：文档、仓库、目录与图谱</p>
        </div>
        {/* 几个分页签排成一行，加起来比窄窗格宽。给个横向滚动，
            不然窄的那几页签直接被裁掉、点都点不到。 */}
        <div className="flex gap-1 overflow-x-auto rounded-md bg-neutral-100 p-1 text-sm dark:bg-neutral-900">
          {([
            ['index', '索引与检索', undefined as number | undefined],
            ['repos', '代码仓库', counts.repos],
            ['dirs', '本地目录', counts.dirs],
            ['eval', '评估', counts.eval],
            ['kg', '图谱', undefined as number | undefined],
          ] as const).map(([key, label, count]) => {
            const Icon = KB_TAB_ICON[key]
            return (
              <button
                key={key}
                onClick={() => setTab(key)}
                className={`flex items-center gap-1.5 rounded px-3 py-1 transition-colors ${
                  tab === key
                    ? 'bg-white font-medium dark:bg-neutral-800'
                    : 'text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200'
                }`}
              >
                <Icon className="h-4 w-4" />
                {label}
                {count != null && count > 0 && (
                  <span
                    className={`rounded-full px-1.5 text-xs leading-4 ${
                      tab === key
                        ? 'bg-violet-100 text-violet-700 dark:bg-violet-900/60 dark:text-violet-300'
                        : 'bg-neutral-200 text-neutral-600 dark:bg-neutral-700 dark:text-neutral-300'
                    }`}
                  >
                    {count}
                  </span>
                )}
              </button>
            )
          })}
        </div>
      </div>

      <div hidden={tab !== 'index'}>
        <KbIndexTab onCounts={reportCounts} onGoTab={setTab} />
      </div>
      <div hidden={tab !== 'repos'}>
        <KbReposTab active={tab === 'repos'} onCounts={reportCounts} />
      </div>
      <div hidden={tab !== 'dirs'}>
        <KbDirsTab active={tab === 'dirs'} onCounts={reportCounts} />
      </div>
      <div hidden={tab !== 'eval'}>
        <KbEvalTab active={tab === 'eval'} onCounts={reportCounts} />
      </div>
      <div hidden={tab !== 'kg'}>
        <KbKgTab active={tab === 'kg'} />
      </div>
      </div>
    </>
  )
}
