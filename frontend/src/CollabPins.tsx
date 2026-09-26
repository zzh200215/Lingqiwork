/**
 * 协作面板里「这一轮读哪几份」（材料清单的第二个来源，2026-09-22）。
 *
 * **为什么要有它。** 在那之前材料清单只有一个来源：题面指涉「手头那件事」时，那件事挂着的
 * 那几份（`thread_context.materials_for`）。那是个**启发式**——没指涉就一定不给。所以
 * 「这一轮就读这两份」这种话没有地方可写；而 fanout 的读步是**每份材料一个 step**，
 * 给不给材料直接决定这一步是读一份东西还是满 vault 找。
 *
 * 三条与后端对齐的口径（界面不自己再判一遍）：
 *
 * 1. **只钉 vault 里能打开的东西**：`repo:` / `dir:` 那类索引在 vault 之外的素材，
 *    交付引擎读得动（正文它自己解析），而协作的读步手里只有 `vault_read_file`——
 *    后端会把它们跳过（`thread_context.pinned_materials`）。这里不预判，钉了没进清单
 *    是后端说了算；界面上那句提示就是为这件事写的。
 * 2. **顺序就是你钉的顺序**：fanout 的读步照这个顺序一路一份生成，所以不做排序。
 * 3. **同一份只钉一次**：按 `spec` 去重（`spec` 是后端 `MaterialHit` 给的、能直接喂
 *    `collect_material` 的那个规格）。
 *
 * 只在 `fanout` 下渲染（材料清单只有它吃）——这件事由调用方决定，本组件不认模式。
 */
import { useState } from 'react'

import { api } from './api'
import type { MaterialHit } from './api'

export interface PinnedMaterial {
  spec: string
  title: string
}

export default function CollabPins({
  pins,
  onChange,
}: {
  pins: PinnedMaterial[]
  onChange: (pins: PinnedMaterial[]) => void
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<MaterialHit[]>([])
  const [busy, setBusy] = useState(false)

  async function search() {
    const q = query.trim()
    if (!q) return
    setBusy(true)
    try {
      setHits((await api.searchMaterial(q)).hits)
    } catch {
      // 搜不到不该把面板弄炸，也不该假装搜到了：清空结果就好
      setHits([])
    } finally {
      setBusy(false)
    }
  }

  function add(hit: MaterialHit) {
    const spec = hit.spec || hit.source
    if (!spec || pins.some((p) => p.spec === spec)) return
    onChange([...pins, { spec, title: hit.title || spec }])
  }

  return (
    <div data-collab-pins className="border-t border-neutral-100 px-3 py-2 dark:border-neutral-800">
      <p className="pb-1 text-xs text-neutral-400">
        这一轮读哪几份（可选）· 钉住的排在读步最前，读步手里只有 vault 里的文件
      </p>
      <div className="flex flex-wrap items-center gap-1.5">
        {pins.map((p) => (
          <span
            key={p.spec}
            data-collab-pin={p.spec}
            title={p.spec}
            className="flex items-center gap-1 rounded-full border border-violet-300 px-2 py-0.5 text-xs text-violet-700 dark:border-violet-500/50 dark:text-violet-300"
          >
            {p.title}
            <button
              onClick={() => onChange(pins.filter((x) => x.spec !== p.spec))}
              title="取消钉住"
              className="text-violet-500 hover:text-rose-500"
            >
              ✕
            </button>
          </span>
        ))}
        <button
          onClick={() => setOpen((v) => !v)}
          className="rounded-full border border-neutral-300 px-2 py-0.5 text-xs text-neutral-500 transition-colors hover:border-violet-300 hover:text-violet-600 dark:border-neutral-700 dark:text-neutral-400"
        >
          {open ? '收起' : '＋ 钉一条材料'}
        </button>
      </div>
      {open && (
        <div className="mt-1.5">
          <div className="flex gap-1.5">
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void search()
              }}
              placeholder="在你自己的材料里搜一条…"
              className="min-w-0 flex-1 rounded-lg border border-neutral-300 bg-white px-2 py-1 text-xs outline-none placeholder:text-neutral-400 focus:border-violet-400 dark:border-neutral-700 dark:bg-neutral-900"
            />
            <button
              onClick={() => void search()}
              disabled={busy || !query.trim()}
              className="shrink-0 rounded-lg border border-neutral-300 px-2 py-1 text-xs text-neutral-600 disabled:opacity-40 dark:border-neutral-700 dark:text-neutral-300"
            >
              {busy ? '搜…' : '搜'}
            </button>
          </div>
          {hits.length > 0 && (
            <div className="mt-1 max-h-32 overflow-y-auto">
              {hits.map((h) => (
                <button
                  key={`${h.spec || h.source}-${h.chunk ?? 0}`}
                  data-collab-pin-hit={h.spec || h.source}
                  onClick={() => add(h)}
                  title={h.spec || h.source}
                  className="block w-full truncate rounded px-1.5 py-1 text-left text-xs text-neutral-600 hover:bg-violet-50 dark:text-neutral-300 dark:hover:bg-violet-500/10"
                >
                  {h.title || h.spec || h.source}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
