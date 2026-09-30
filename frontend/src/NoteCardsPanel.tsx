import type { Dispatch, SetStateAction } from 'react'
import { Link } from 'react-router-dom'
import { Layers } from 'lucide-react'
import CardMaker from './CardMaker'

// 出复习卡面板——JSX 从 NotesPage 原样搬来（方向 6）；入口守卫（cardsOpen && activePath）
// 由宿主承担，所以这里的 activePath 必然存在。
export default function NoteCardsPanel(props: {
  activePath: string
  setCardsOpen: Dispatch<SetStateAction<boolean>>
  setSavedAt: Dispatch<SetStateAction<string>>
}) {
  const { activePath, setCardsOpen, setSavedAt } = props
  return (
          <aside className="hidden w-80 shrink-0 flex-col overflow-hidden border-l border-neutral-200/80 bg-white/60 md:flex dark:border-neutral-800/80 dark:bg-neutral-950/60">
            <div className="flex items-center justify-between border-b border-neutral-200/80 px-3 py-2 dark:border-neutral-800/80">
              <h2 className="flex items-center gap-1.5 text-xs font-semibold text-neutral-600 dark:text-neutral-300">
                <Layers className="h-4 w-4" />
                出复习卡
              </h2>
              <button
                onClick={() => setCardsOpen(false)}
                className="text-xs text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200"
              >
                收起
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-3">
              <CardMaker
                sourcePath={activePath}
                sourceLabel={activePath}
                compact
                onSaved={(n) => setSavedAt(n > 0 ? `入库 ${n} 张卡片` : '')}
              />
              <Link
                to="/review"
                className="mt-3 block text-center text-xs text-neutral-400 hover:text-violet-600 dark:hover:text-violet-300"
              >
                去复习页 →
              </Link>
            </div>
          </aside>
  )
}
