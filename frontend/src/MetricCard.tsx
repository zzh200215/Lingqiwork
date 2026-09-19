/** 读数块（R1 · PLAN5 §3）——九条尺子上墙时共用的那张壳。
 *
 *  **它不是重构。** 仪表盘上原来那六张卡（北极星 / 过程 / 校准 / 矛盾率 / 技能闭环）
 *  各自把下面这四件事写了一遍，也都各有测试钉着。这里先只给**新上墙的三条**
 *  （接地分 / 判分基线 / 回合读数）用——等新三条稳了再议要不要回迁，
 *  免得一次动六张有测试的卡。
 *
 *  **四件事就是这四条纪律，一条都不许省**：
 *  1. **读不到就说读不到**（§4-8）：`readable=false` 时标题旁摆 `—`，
 *     正文只留那句错误原话——**不拿一排 0 充数**（零是「一条都没有」，两回事）；
 *  2. **口径从后端来**：`rules` 原文照抄。同一个词在两处必须是一个意思，
 *     界面自己编一句说法，分叉那天就没人知道该信哪句；
 *  3. **空数据只陈述不催**：`emptyHint` 是陈述句，不许出现「还差 / 加油 / 目标」；
 *  4. **未读到整块不渲染**：**由调用方挡在壳外面**（`if (!x) return null`，与页面上另外
 *     五张卡同一个写法）。壳自己分不清「还没读到」和「读到了但读不出来」——后者是
 *     `readable=false` 的**载荷**，那正是要说出来的那一句。所以这一条不在壳里做：
 *     早期版本以为壳里能判，结果三张卡在首屏都闪一下「这条读数现在读不出来」。
 *     （对应的三条测试也踩了同一个坑：它们查的是 `[data-turn-summary]` 这种**不存在**的
 *     属性名——壳给的是 `data-metric="data-turn-summary"`，于是那三条**永远为真**。）
 *
 *  红线（§4-2）：这面墙上**没有目标值、没有排名、没有同比环比颜色**。
 *  所以这张壳只提供「标题 + 一个数 + 若干标签」，不提供任何态势色。
 */
import type { ReactNode } from 'react'

export interface MetricCardProps {
  /** 卡名（与后端那条读数的名字一致） */
  title: string
  /** 一个 DOM 标记，给测试与深链用（如 `data-turn-summary`） */
  marker: string
  /** 标题旁那个数，如 `3/4`、`2 / 2`。读不到时**由调用方传 `—`**，别传 0 */
  headline?: string
  /** 那个数后面的一句说明（它是什么） */
  headlineNote?: string
  /** 右上角的窗口/范围说明，如 `滚动 30 天`。没有就不摆 */
  scope?: string
  readable: boolean
  error?: string
  /** 读得到时的正文（柱状、分布、清单…）。**空/读不到时的那些话由这张壳自己说**，
   *  所以调用方只管「有数据时摆什么」，不必自己判空。 */
  children?: ReactNode
  /** `readable=true` 但确实没有任何数据时摆的**陈述句**（不催） */
  emptyHint?: string
  /** 是不是「空」——由调用方判（只有它知道这个读数的空长什么样） */
  empty?: boolean
  /** 口径原文（后端 `rules`）：逐行照抄 */
  rules?: Record<string, string>
  /** 已知偏差（后端 `bias`）：与口径分开摆，它说的是「这个数什么时候会骗你」 */
  bias?: string
  className?: string
}

export default function MetricCard({
  title,
  marker,
  headline,
  headlineNote,
  scope,
  readable,
  error,
  children,
  emptyHint,
  empty = false,
  rules,
  bias,
  className = '',
}: MetricCardProps) {
  const ruleLines = Object.values(rules || {}).filter(Boolean)
  return (
    <section
      data-metric={marker}
      className={`wb-card p-5 ${className}`}
    >
      {/* **数是主角，标题是标签。** 早期版本把 `title`（text-sm semibold）和那个数
          （text-2xl bold）并排、字号只差一级——两个都在喊，读的人不知道先看哪儿。
          现在标题降成小号字距微开的标签，数独占视觉重量。
          左边那条竖线是「一条读数」的记号：墙上九条，每条都从这条线开始。 */}
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <div className="flex items-baseline gap-2">
          <span className="h-3.5 w-0.5 shrink-0 self-center rounded-full bg-violet-300 dark:bg-violet-500/60" />
          <h2 className="text-[11px] font-medium uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
            {title}
          </h2>
        </div>
        {/* 读不到时**也要摆那个 `—`**：它是「这条读数现在读不出来」的那一眼凭据。
            所以这里判的是「要么有 headline，要么压根没读到」——不能只看 headline
            （未读到那种情况下调用方手里没有数，headline 是 undefined）。 */}
        {headline !== undefined || !readable ? (
          <span
            {...{ [`${marker}-headline`]: '' }}
            className="text-2xl font-bold tabular-nums text-violet-600 dark:text-violet-300"
          >
            {readable ? headline : '—'}
          </span>
        ) : null}
        {headlineNote ? (
          <span className="text-xs text-neutral-500 dark:text-neutral-400">{headlineNote}</span>
        ) : null}
        <div className="flex-1" />
        {scope ? (
          <span className="text-[11px] tabular-nums text-neutral-400 dark:text-neutral-500">
            {scope}
          </span>
        ) : null}
      </div>

      {/* 正文单独包一层：测试里那条「一处都不催」的断言要盯的是**这里**——
          口径原文（`rules`）里正当地含「不设目标」这类字，把它一起扫会误报。 */}
      <div {...{ [`${marker}-body`]: '' }}>
        {!readable ? (
          <p {...{ [`${marker}-error`]: '' }} className="mt-2 text-xs text-rose-500">
            这条读数现在读不出来（{error || '原因没给出来'}）。零是「什么都没发生」，
            读不到是另一回事——不拿零充数。
          </p>
        ) : empty ? (
          <p
            {...{ [`${marker}-empty`]: '' }}
            className="mt-3 text-xs text-neutral-400 dark:text-neutral-500"
          >
            {emptyHint || '这里现在没有数据。'}
          </p>
        ) : (
          children
        )}
      </div>

      {/* 口径与已知偏差：**原文来自后端**，界面一个字都不自己编。
          读不到时**也要摆**——那正是最需要知道「这条读数本来量的是什么」的时候。 */}
      {ruleLines.length > 0 || bias ? (
        <p
          {...{ [`${marker}-rule`]: '' }}
          className="mt-3 text-[11px] leading-relaxed text-neutral-400 dark:text-neutral-500"
        >
          {ruleLines.join('；')}
          {bias ? `。${bias}` : ''}
        </p>
      ) : null}
    </section>
  )
}
