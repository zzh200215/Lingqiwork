/** 提纲确认区（方案 §8.1 行5）——长稿那一模里「点头之前」的那一屏。
 *
 *  ## 它为什么是独立文件
 *
 *  报告页已经有生成面板 + 清单 + 阅读视图三块，再算上体裁模板那两处，`ReportPage.tsx`
 *  就越过方案 §十二 的规模线了。而这一块**边界很清楚**：进去一份提纲与当前题目，
 *  出来「就按这个写」「直接写」两个动作，中间只有改、删、加三种编辑。
 *
 *  ## 两处「说出来」是有意的
 *
 *  - **过期**：题目改过之后这份提纲就不再对应它了。不说的话，「就按这个写」会让人以为
 *    写的是新题目那份提纲——那是**界面在替模型撒谎**。
 *  - **出不来**：`err` 单独一行摆着，且**不编一份默认提纲顶上**（编的话用户会以为模型
 *    真看过他的题目）。
 */
export default function DeliverOutlineBox({
  outline,
  /** 出这份提纲时的话题。与 `topic` 不同就提示过期。 */
  staleFor,
  topic,
  err,
  busy,
  onEdit,
  onDrop,
  onAdd,
  onConfirm,
  onDirect,
}: {
  outline: { title: string; sections: string[] } | null
  staleFor: string
  topic: string
  err: string
  busy: boolean
  onEdit: (i: number, text: string) => void
  onDrop: (i: number) => void
  onAdd: () => void
  onConfirm: () => void
  onDirect: () => void
}) {
  return (
    <>
      {err ? (
        <p
          data-report-outline-err
          className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300"
        >
          {err}
        </p>
      ) : null}

      {outline ? (
        <div
          data-report-outline
          // `wb-card`：方案 §8.1 行5 的原话是「**wb-card 白底**」，而且 §七 那条纪律
          // （`index.css` 里也写着）是「一处改，全站 wb-card 一起变」。手抄一份
          // `rounded-lg border bg-white …` 正是它警告的病根——两份迟早会不一样。
          className="wb-card space-y-2 p-3"
        >
          <p className="text-xs text-neutral-500">
            提纲——可以改、可以删。确认之后才去取材成文。
            {outline.title ? (
              <span className="pl-1 text-neutral-400">拟标题：{outline.title}</span>
            ) : null}
          </p>

          {staleFor !== topic.trim() ? (
            <p data-report-outline-stale className="text-xs text-amber-600 dark:text-amber-400">
              这份提纲是按「{staleFor}」出的，题目已经改了——建议重新出一次。
            </p>
          ) : null}

          {outline.sections.map((s, i) => (
            <div key={i} className="flex items-center gap-2">
              <span className="w-4 shrink-0 text-right text-xs text-neutral-400">{i + 1}</span>
              <input
                value={s}
                aria-label={`第 ${i + 1} 节`}
                onChange={(e) => onEdit(i, e.target.value)}
                className="min-w-0 flex-1 rounded-md border border-neutral-300 bg-white px-2 py-1 text-sm outline-none focus:border-teal-400 dark:border-neutral-700 dark:bg-neutral-900"
              />
              <button
                onClick={() => onDrop(i)}
                title="删掉这一节"
                className="shrink-0 rounded-md px-1.5 py-0.5 text-xs text-neutral-400 transition-colors hover:text-rose-500"
              >
                ✕
              </button>
            </div>
          ))}

          <button
            onClick={onAdd}
            className="rounded-full border border-neutral-300 px-2 py-0.5 text-xs text-neutral-500 transition-colors hover:border-teal-300 hover:text-teal-600 dark:border-neutral-700 dark:text-neutral-400"
          >
            ＋ 加一节
          </button>

          <div className="flex flex-wrap items-center gap-3 pt-1">
            <button
              onClick={onConfirm}
              disabled={busy}
              className="rounded-lg bg-teal-600 px-3.5 py-1.5 text-sm font-medium text-white transition-colors hover:bg-teal-700 disabled:opacity-40"
            >
              就按这个写
            </button>
            <button
              onClick={onDirect}
              disabled={busy}
              title="不要提纲，照体裁默认的结构写"
              className="text-xs text-neutral-500 underline decoration-neutral-300 underline-offset-2 transition-colors hover:text-teal-600 disabled:opacity-40 dark:text-neutral-400"
            >
              直接写
            </button>
          </div>
        </div>
      ) : null}
    </>
  )
}
