/** 分类管理（AI Gist 那一屏的「分类管理」）：改名、换色、删除。
 *
 *  ## 为什么单独一份文件
 *
 *  它是一块**自成一体的模态**（自己三个 useState，进去出来都不碰库里别的东西），
 *  而 `PromptLibrary.tsx` 主组件那份已经很长了。挪出来不改变任何行为——这一份是
 *  逐字搬过来的，`data-cat-mgr` / `data-cat` 那些锚点一个没动。
 *
 *  ## 两条写死在这里的话
 *
 *  - **删除这一条写在按钮和确认框里**：删分类不等于删提示词——这是这一屏最容易出事的地方。
 *  - 能拖拽排序是有意**没做**的：这一版的分类数量是个人级的（几个到十几个），
 *    用 position 字段定序足够了，为它引入拖拽交互换不来什么。
 */
import { useState } from 'react'

import { catColor } from './PromptViews'
import { useEscapeClose } from './workShared'
import type { PromptCategoryItem } from './api'

export default function PromptCategoryManager({
  cats,
  onClose,
  onCreate,
  onRename,
  onDelete,
}: {
  cats: PromptCategoryItem[]
  onClose: () => void
  onCreate: (name: string, color: string) => void
  onRename: (c: PromptCategoryItem, name: string, color: string) => void
  onDelete: (c: PromptCategoryItem) => void
}) {
  const [name, setName] = useState('')
  const [color, setColor] = useState('#8b5cf6')
  const [editing, setEditing] = useState<number | null>(null)
  const [editName, setEditName] = useState('')
  const [editColor, setEditColor] = useState('#8b5cf6')

  // Esc 关掉这一层（仓里 11 处浮层都守这条；这一处 2026-09-25 才补上）
  useEscapeClose(onClose)

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-label="分类管理"
      data-cat-mgr
    >
      {/* 模态是**唯一允许有阴影**的地方（契约：shadows only for modals/drawers/dropdowns），
          圆角也单独一档（10px）。头尾用次级表面 + 分隔线，与正文分开。 */}
      <div className="max-h-[80vh] w-full max-w-2xl overflow-auto rounded-[10px] border border-neutral-200 bg-white shadow-2xl dark:border-neutral-800 dark:bg-neutral-900">
        <div className="flex items-start justify-between border-b border-neutral-200 bg-neutral-50 px-5 py-4 dark:border-neutral-800 dark:bg-neutral-800/50">
          <div>
            <h2 className="text-base font-semibold text-neutral-800 dark:text-neutral-100">分类管理</h2>
            <p className="pt-0.5 text-[13px] text-neutral-500 dark:text-neutral-400">
              管好你的提示词分类。删一个分类不会删掉里面的提示词——它们退回「未分类」。
            </p>
          </div>
          <button onClick={onClose} className="text-neutral-400 hover:text-neutral-700" aria-label="关闭">
            ✕
          </button>
        </div>

        <div className="grid gap-4 p-5 md:grid-cols-2">
          <section>
            <h3 className="pb-2 text-xs font-medium text-neutral-500 dark:text-neutral-400">
              现有分类 · 共 {cats.length} 个
            </h3>
            {cats.length === 0 ? (
              <p className="rounded-lg border border-dashed border-neutral-300 px-3 py-6 text-center text-xs text-neutral-400 dark:border-neutral-700">
                还没有分类。右边建一个。
              </p>
            ) : (
              <ul className="space-y-1.5">
                {cats.map((c) => (
                  <li
                    key={c.id}
                    className="rounded-lg border border-neutral-200 p-2 dark:border-neutral-800"
                    data-cat={c.id}
                  >
                    {editing === c.id ? (
                      <div className="flex flex-wrap items-center gap-2">
                        <input
                          value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                          aria-label={`分类名 ${c.name}`}
                          className="min-w-0 flex-1 rounded-lg border border-neutral-300 bg-white px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-900"
                        />
                        <input
                          type="color"
                          value={editColor}
                          onChange={(e) => setEditColor(e.target.value)}
                          aria-label={`分类颜色 ${c.name}`}
                          className="h-7 w-10 rounded border border-neutral-300 dark:border-neutral-700"
                        />
                        <button
                          onClick={() => {
                            onRename(c, editName, editColor)
                            setEditing(null)
                          }}
                          className="rounded-md border border-neutral-300 px-2.5 py-1 text-sm text-neutral-700 transition-colors hover:border-neutral-400 dark:border-neutral-600 dark:text-neutral-200"
                        >
                          存
                        </button>
                        <button
                          onClick={() => setEditing(null)}
                          className="text-xs text-neutral-400"
                        >
                          取消
                        </button>
                      </div>
                    ) : (
                      <div className="flex items-center gap-2">
                        <span
                          className="h-2.5 w-2.5 shrink-0 rounded-full"
                          style={{ backgroundColor: catColor(c.name, c.color) }}
                        />
                        <span className="min-w-0 flex-1 truncate text-xs text-neutral-700 dark:text-neutral-200">
                          {c.name}
                        </span>
                        <span className="shrink-0 text-xs text-neutral-400">{c.count} 个提示词</span>
                        <button
                          onClick={() => {
                            setEditing(c.id)
                            setEditName(c.name)
                            setEditColor(catColor(c.name, c.color))
                          }}
                          className="shrink-0 text-xs text-neutral-400 hover:text-violet-600"
                          aria-label={`编辑分类 ${c.name}`}
                        >
                          编辑
                        </button>
                        <button
                          onClick={() => onDelete(c)}
                          className="shrink-0 text-xs text-neutral-400 hover:text-rose-600"
                          aria-label={`删除分类 ${c.name}`}
                        >
                          删除
                        </button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section>
            <h3 className="pb-2 text-[13px] font-medium text-neutral-500 dark:text-neutral-400">建一个新的</h3>
            <label className="block">
              <span className="text-[13px] text-neutral-500 dark:text-neutral-400">分类名称</span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && name.trim()) {
                    onCreate(name.trim(), color)
                    setName('')
                  }
                }}
                placeholder="例：工作提效"
                aria-label="分类名称"
                className="mt-1 w-full rounded-lg border border-neutral-300 bg-white px-2 py-1.5 text-sm outline-none focus:border-violet-400 dark:border-neutral-700 dark:bg-neutral-900"
              />
            </label>
            <label className="mt-3 block">
              <span className="text-[13px] text-neutral-500 dark:text-neutral-400">颜色</span>
              <div className="mt-1 flex items-center gap-2">
                <input
                  type="color"
                  value={color}
                  onChange={(e) => setColor(e.target.value)}
                  aria-label="分类颜色"
                  className="h-8 w-14 rounded border border-neutral-300 dark:border-neutral-700"
                />
                <span className="font-mono text-xs text-neutral-400">{color}</span>
              </div>
            </label>
            <button
              onClick={() => {
                if (!name.trim()) return
                onCreate(name.trim(), color)
                setName('')
              }}
              disabled={!name.trim()}
              className="mt-4 w-full rounded-md bg-violet-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-violet-700 disabled:opacity-40"
            >
              创建分类
            </button>
          </section>
        </div>

        <div className="flex justify-end border-t border-neutral-200 bg-neutral-50 px-5 py-3 dark:border-neutral-800 dark:bg-neutral-800/50">
          <button
            onClick={onClose}
            className="rounded-md border border-neutral-300 px-4 py-1.5 text-sm text-neutral-500 dark:border-neutral-700 dark:text-neutral-400"
          >
            关闭
          </button>
        </div>
      </div>
    </div>
  )
}
