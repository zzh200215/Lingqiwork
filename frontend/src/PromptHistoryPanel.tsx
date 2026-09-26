/** 一条提示词的**历史版本 / 使用记录**（两栏共用一块位置）。
 *
 *  ## 为什么这两样是一块
 *
 *  它们回答的是同一类问题——「这条以前是什么样、我用过没有」——都只读、都不改东西，
 *  而且在右栏里**占的是同一个位置**（`PromptLibrary` 那条分支里，它俩轮流上）。
 *  分成两个组件的话，父组件就得把那条分支写两遍。
 *
 *  ## 为什么是**折叠区**（方案 §8.2 区1③ 的原话）
 *
 *  原来它俩是**整栏替换**：点「看历史」，编辑器就没了——看完想接着改，还得再点一次。
 *  折叠区是加在编辑器**上面**的一小块，展开时编辑器照样在那儿。这也是「详情**加**
 *  历史版本折叠区」和「详情**换成**历史版本」的区别。
 *
 *  ## 两个空态各说各的实话
 *
 *  「还没有旧版——改过一次正文才会留一版」与「还没用过——点一次复制这里就会记一行」：
 *  空着不解释，看的人会以为功能坏了；而这两件事的原因完全不同（一个是没改过，
 *  一个是没用过），所以不能共用一句。
 */
import EmptyHint from './EmptyHint'
import type { PromptItem, PromptUsageItem, PromptVersionItem } from './api'

/** 两版之间**改了多少行** → `{add, del}`。Pure.

 *  ## 这是「行数增减」，不是逐行 diff
 *
 *  方案 §8.2 区1③ 要的是「内容 **diff 摘要**」。这里给的是**多集差**：把两版的非空行
 *  各收成一个多重集，新版多出来的算 `add`、旧版剩下来的算 `del`。它答得了「这一版改了多少」
 *  ——那正是列表上要的那一个数——但**答不了「改的是哪几行」**（同一行挪了位置、或改了一个字，
 *  这里都算「一加一减」）。
 *
 *  为什么不摆逐行 diff：这一格平时很少打开，而一个能对齐、能折叠上下文的行级 diff
 *  是一整套东西（要么引库，要么自己写 Myers）。为一个「扫一眼」的位置引那些，不划算。
 *  哪天真要看具体改了哪几行，vault 里的文件本来就有全文。
 *
 *  空行不计：空行增减是排版噪声，不是「改了内容」。
 */
export function lineDelta(newer: string, older: string): { add: number; del: number } {
  const pool = new Map<string, number>()
  for (const line of (older || '').split('\n')) {
    const t = line.trim()
    if (t) pool.set(t, (pool.get(t) ?? 0) + 1)
  }
  let add = 0
  for (const line of (newer || '').split('\n')) {
    const t = line.trim()
    if (!t) continue
    const left = pool.get(t) ?? 0
    if (left > 0) pool.set(t, left - 1)
    else add += 1
  }
  let del = 0
  for (const n of pool.values()) del += n
  return { add, del }
}

/** 折叠区的外壳。`open` 是受控的——用户把它收起来 = 关掉这一块（父组件的状态跟着清）。
 *  用原生 `<details>`：键盘、读屏、锚点跳转全都白拿，与 `WorkPage` 的两个折叠区同一个做法。 */
function FoldBlock({
  anchor,
  title,
  onClose,
  children,
}: {
  anchor: string
  title: string
  onClose: () => void
  children: React.ReactNode
}) {
  return (
    <details
      open
      onToggle={(e) => {
        if (!(e.currentTarget as HTMLDetailsElement).open) onClose()
      }}
      className="wb-card px-4 py-3"
      {...{ [anchor]: true }}
    >
      <summary className="flex cursor-pointer items-baseline justify-between gap-2">
        <span className="text-sm font-semibold text-neutral-700 dark:text-neutral-200">{title}</span>
        <span className="text-xs text-neutral-400">收起</span>
      </summary>
      <div className="pt-2">{children}</div>
    </details>
  )
}

export default function PromptHistoryPanel({
  history,
  usages,
  onRestore,
  onCloseHistory,
  onCloseUsages,
}: {
  /** 打开着的历史版本（`null` = 没看这个）。 */
  history: { of: PromptItem; items: PromptVersionItem[] } | null
  /** 打开着的使用记录（`null` = 没看这个）。 */
  usages: { of: PromptItem; items: PromptUsageItem[] } | null
  onRestore: (p: PromptItem, v: PromptVersionItem) => void
  onCloseHistory: () => void
  onCloseUsages: () => void
}) {
  return (
    <>
      {history ? (
        <FoldBlock
          anchor="data-prompt-history"
          title={`历史版本 · ${history.of.title}`}
          onClose={onCloseHistory}
        >
          {history.items.length === 0 ? (
            // 空态一律 EmptyHint（方案 §七：虚线框 + 标题 + 一句引导），**禁裸文本**。
            <EmptyHint title="还没有旧版。" hint="改过一次正文才会留一版——正文没变过就不占历史。" />
          ) : (
            <ul className="space-y-2">
              {history.items.map((v, i) => {
                // 列表是**新→旧**，所以「上一版」是它后面那一条；最老的那条没有可比对象。
                const older = history.items[i + 1]
                const d = older ? lineDelta(v.content, older.content) : null
                return (
                  <li
                    key={v.id}
                    className="rounded-lg border border-neutral-200 p-2 dark:border-neutral-800"
                    data-version={v.id}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="flex min-w-0 items-baseline gap-2">
                        <span className="shrink-0 text-xs text-neutral-400">
                          {v.at.slice(0, 16).replace('T', ' ')} · {v.sha}
                        </span>
                        {/* 改了多少行（§8.2 区1③ 的「内容 diff 摘要」）。
                            **算不出来就不摆**——第一版没有可比对象，写「±0」会读成「没改」。 */}
                        {d ? (
                          <span
                            className="shrink-0 text-xs text-neutral-400"
                            title="与上一版比：多出来的行 / 少掉的行（按行比对，不看具体位置）"
                          >
                            <span className="text-emerald-600 dark:text-emerald-400">+{d.add}</span>{' '}
                            <span className="text-rose-600 dark:text-rose-400">−{d.del}</span>
                          </span>
                        ) : (
                          <span className="shrink-0 text-xs text-neutral-400">最初的一版</span>
                        )}
                      </span>
                      <button
                        onClick={() => onRestore(history.of, v)}
                        className="shrink-0 text-xs text-violet-600 hover:text-violet-700 dark:text-violet-400"
                      >
                        回到这一版
                      </button>
                    </div>
                    <p className="mt-1 line-clamp-3 whitespace-pre-wrap text-xs text-neutral-500 dark:text-neutral-400">
                      {v.content}
                    </p>
                  </li>
                )
              })}
            </ul>
          )}
        </FoldBlock>
      ) : null}

      {usages ? (
        <FoldBlock
          anchor="data-prompt-usages"
          title={`使用记录 · ${usages.of.title}`}
          onClose={onCloseUsages}
        >
          {usages.items.length === 0 ? (
            <EmptyHint title="还没用过。" hint="点一次「复制」这里就会记一行——记了才看得到用得多不多。" />
          ) : (
            <ul className="space-y-1.5">
              {usages.items.map((u) => (
                <li key={u.id} className="rounded-lg border border-neutral-200 p-2 dark:border-neutral-800">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs text-neutral-500 dark:text-neutral-400">
                      {u.at.slice(0, 16).replace('T', ' ')}
                    </span>
                    <span className="font-mono text-xs text-neutral-400">{u.sha}</span>
                  </div>
                  {Object.keys(u.vars).length ? (
                    <p className="mt-1 text-[13px] text-neutral-400">
                      {Object.entries(u.vars)
                        .map(([k, v]) => `${k}=${v}`)
                        .join(' · ')}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </FoldBlock>
      ) : null}
    </>
  )
}
