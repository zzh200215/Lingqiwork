import { useEffect, useRef, useState } from 'react'
import { Check, Pencil, X } from 'lucide-react'

import SkinPreview from './SkinPreview'
import type { Skin } from './theme'

/** 卡片的框。改名时那一支也用它——**同一个东西不该有两个规格**，
 *  差 1px 的边框在两张卡并排时看得出来。 */
const CARD =
  'flex w-full flex-col gap-2 rounded-lg border p-2 text-left transition-colors'

function frame(active: boolean): string {
  return `${CARD} ${
    active
      ? 'border-violet-400 bg-violet-50/50 dark:border-violet-500/50 dark:bg-violet-500/10'
      : 'border-neutral-200 hover:border-neutral-300 dark:border-neutral-800 dark:hover:border-neutral-700'
  }`
}

/** 一张皮肤卡。
 *
 *  预览交给 `SkinPreview`——**与「当前皮肤」那块大预览同一个组件**。
 *  两处各画一套的话，小卡上看着通透、切过去发现不透，而那种不一致
 *  正是「预览」这个词最不该出的错。
 *
 *  外圈是 `div` 而不是 `button`：用户皮肤卡上还有「改名」「删掉」两个动作，而
 *  **button 里套 button 是非法 HTML**（浏览器会把内层那个甩出去，于是「点删掉」
 *  变成「选中这个皮肤」）。把三个动作摆成兄弟节点就没有这个问题。
 *
 *  改名那一支**整张卡换掉**（而不是在标题旁边塞一个输入框）：输入框不能放在
 *  选中按钮里面（同上），而绝对定位盖在标题上又会在名字长短不一时对不齐。
 *  换掉整张卡是最笨也最稳的做法——预览还在原处，眼睛不会跳。 */
export default function SkinCard({
  skin,
  dark,
  active,
  onPick,
  onRemove,
  onRename,
}: {
  skin: Skin
  dark: boolean
  active: boolean
  onPick: () => void
  /** 有值就说明这是本机装上的皮肤（不是内置的），可以删 */
  onRemove?: () => void
  /** 同上，可以改名。返回 false = 没改成（父组件负责把原因说出来） */
  onRename?: (label: string) => boolean
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (draft !== null) inputRef.current?.select()
  }, [draft])

  function commit(): void {
    if (draft === null) return
    const next = draft.trim()
    // 名字没变、或者清空了：直接退出编辑，不惊动注册表
    if (!next || next === skin.label) {
      setDraft(null)
      return
    }
    if (onRename?.(next)) setDraft(null)
  }

  return (
    <div className="relative">
      {draft !== null ? (
        <div className={frame(active)}>
          <SkinPreview skin={skin} dark={dark} className="h-16 w-full" />
          <input
            ref={inputRef}
            data-skin-label-input={skin.id}
            value={draft}
            spellCheck={false}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit()
              // Esc 退出编辑，**不改名也不关页面**。这里不 `stopPropagation`：
              // 设置页是一个路由（`modules.tsx` 的 `settings`），外面没有等着
              // 吃掉 Esc 的浮层——为一个不存在的抽屉加一层防御，只会让下一个人
              // 以为这里真的有抽屉。
              if (e.key === 'Escape') setDraft(null)
            }}
            // 失焦即提交：点别处是「我改完了」最常见的意思，
            // 而一个必须按回车才生效的输入框会让人以为没改上
            onBlur={commit}
            className="w-full rounded-md border border-neutral-300 bg-white px-2 py-0.5 text-sm dark:border-neutral-600 dark:bg-neutral-900"
          />
          <span className="text-xs text-neutral-400">回车确认 · Esc 取消</span>
        </div>
      ) : (
        <button onClick={onPick} data-skin={skin.id} aria-pressed={active} title={skin.hint} className={frame(active)}>
          <SkinPreview skin={skin} dark={dark} className="h-16 w-full" />
          <span className="flex items-center gap-1 text-sm font-medium">
            {skin.label}
            {active ? <Check className="h-3.5 w-3.5 text-violet-500" /> : null}
          </span>
          {/* 作者只在导入的皮肤上有——内置那几张是产品自己的，写「作者：我们」没意义 */}
          {skin.author ? <span className="text-xs text-neutral-400">by {skin.author}</span> : null}
          <span className="text-xs leading-snug text-neutral-400">{skin.hint}</span>
        </button>
      )}

      {draft === null && (onRemove || onRename) ? (
        <div className="absolute right-1 top-1 flex gap-1">
          {onRename ? (
            <button
              onClick={() => setDraft(skin.label)}
              data-skin-rename={skin.id}
              title={`给「${skin.label}」改名`}
              className="flex h-5 w-5 items-center justify-center rounded-md bg-white/85 text-neutral-400 transition-colors hover:text-neutral-800 dark:bg-neutral-900/85 dark:hover:text-neutral-100"
            >
              <Pencil className="h-3 w-3" />
            </button>
          ) : null}
          {onRemove ? (
            <button
              onClick={onRemove}
              data-skin-remove={skin.id}
              title={`删掉「${skin.label}」`}
              className="flex h-5 w-5 items-center justify-center rounded-md bg-white/85 text-neutral-400 transition-colors hover:text-rose-600 dark:bg-neutral-900/85 dark:hover:text-rose-400"
            >
              <X className="h-3 w-3" />
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
