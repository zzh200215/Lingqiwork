// 方向 6 第五刀（2026-09-29）：自 DashboardPage 拆出的评估卡——
// 接地分、回合毛病读数、材料使用率、提示词评测、任务级基线。口径注释原样随迁。
import MetricCard from './MetricCard'
import {
  type AgentEvalBoard,
  type EngineEvalLatest,
  type PromptEvalBoard,
  type TurnSummary,
} from './api'

/** 引擎接地分（R1 · PLAN5 §3）——九条尺子里**唯一一条不是曲线而是分数**的读数。
 *
 *  它量的是「成文引擎有没有在材料之外编造」：0-5，只在「开了检索 + 命中材料 + 有产出」
 *  时才有分（`task_runs.grounded` 同一个口径）。所以**空着不是 0 分**——把两者画成一样，
 *  这张卡就会替没量过的那几次报喜（§4-8）。
 *
 *  **画成柱子，不是印一个数。** 0-5 是一个**有刻度的量**，而一个孤零零的数字
 *  ("4.25") 读不出它在刻度上的哪儿——四个引擎并排时更读不出彼此的差别。
 *  所以每一行是「名字 · 数 · **0-5 的轨道**」，柱子按 `score/5` 落位，
 *  轨道两端钉住 0 和 5（`data-grounded-scale`）。
 *
 *  **轨道上不许有目标线。** 这条最容易被下一个人"顺手加上"（画一条 4.0 的虚线
 *  看着多专业）——那会让这面墙从计量变成考核（§4-2）。柱子只回答"量到哪儿了"。
 *
 *  **警告那一格是这张卡的一半。** `engine_eval.health()` 会说「接地分全在 4.5 以上，
 *  分档压在顶部、区分度低」——一个永远读「满分」的标尺和没有标尺是一回事。
 *  所以**柱子顶到头不是好消息**：那正是「区分度低」的形状。摆它，是因为
 *  它回答的正是这张卡自己的问题：**这把尺子现在还信不信得过**。
 *
 *  红线：不设目标、不排名、不给百分比。四个引擎各摆各的分与条数，**不排座次**。
 */
export function GroundedCard({ e }: { e: EngineEvalLatest | null }) {
  // 还没读到就整块不渲染（与页面上另外五张卡同一个写法）：壳里分不清「还没读到」
  // 和「读到了但读不出来」——后者是 `readable=false` 的载荷，那才是要说出来的那一句。
  if (!e) return null
  const runs = Object.entries(e?.by_engine || {})
  const scored = runs.filter(([, r]) => r && r.grounded !== null)
  return (
    <MetricCard
      title="接地分"
      marker="data-grounded"
      headline={`${scored.length}/${runs.length}`}
      headlineNote="个引擎量到了分"
      scope="每个引擎最近一次自动分"
      readable={!!e}
      rules={e ? GROUNDED_RULES : undefined}
      // 「空」= **一个引擎都没量到分**（四个都还没跑过、或都只跑了结构判分）——
      // 这时摆一句陈述，而不是一张四行全是 `—` 的假表
      empty={scored.length === 0}
      emptyHint="还没有引擎跑过分——先在设置页跑一遍 golden set，之后才有得比。"
    >
      <ul className="mt-4 space-y-2.5">
        {runs.map(([engine, r]) => {
          const score = r && r.grounded !== null ? r.grounded : null
          return (
            <li key={engine} data-grounded-row={engine}>
              <div className="flex items-baseline gap-2">
                <span className="w-16 shrink-0 truncate text-xs font-medium text-neutral-700 dark:text-neutral-200">
                  {engine}
                </span>
                {/* 没跑过 / 这次只跑了结构判分 → 摆 —，**不补一个 0 分** */}
                <span
                  data-grounded-score={engine}
                  className={`w-12 shrink-0 text-right text-sm font-semibold tabular-nums ${
                    score === null
                      ? 'text-neutral-300 dark:text-neutral-600'
                      : 'text-neutral-800 dark:text-neutral-100'
                  }`}
                >
                  {score === null ? '—' : score.toFixed(2)}
                </span>
                {/* 0-5 的轨道：柱子按 score/5 落位。轨道**故意画得比柱子淡**，
                    它是刻度不是数据；没量到分时整条轨道是空的（不是半格） */}
                <div
                  data-grounded-scale={engine}
                  className="relative h-2.5 min-w-0 flex-1 overflow-hidden rounded-full bg-neutral-100 dark:bg-neutral-800"
                >
                  {score === null ? null : (
                    <div
                      className="h-full rounded-full bg-violet-500 dark:bg-violet-400"
                      style={{ width: `${Math.max(0, Math.min(100, (score / 5) * 100)).toFixed(1)}%` }}
                    />
                  )}
                </div>
                <span className="w-24 shrink-0 text-right text-xs tabular-nums text-neutral-400 dark:text-neutral-500">
                  {r
                    ? `用例 ${r.total}${
                        e?.coverage?.[engine] != null ? ` · 集 ${e.coverage[engine]}` : ''
                      }`
                    : '还没跑过'}
                </span>
              </div>
            </li>
          )
        })}
      </ul>

      {/* 刻度说明：**只标两端**（0 与 5），中间不画线、不设目标值。
          这句话是这张卡的关键——柱子顶到头意味着「区分度低」，不是「满分」。 */}
      <div className="mt-3 flex items-center gap-2">
        <span className="w-16 shrink-0" />
        <span className="w-12 shrink-0" />
        <div className="flex min-w-0 flex-1 justify-between text-xs tabular-nums text-neutral-300 dark:text-neutral-600">
          <span>0</span>
          <span>5</span>
        </div>
        <span className="w-24 shrink-0" />
      </div>

      {/* 标尺自己的健康度：**原文照抄后端**，界面不自己判「这算不算顶格」。
          与校准卡的基线同一套琥珀色（都是「这条读数有个前提要知道」），
          但这里不叫「基线」——它说的是这把尺子现在**量不出差别**。 */}
      {e && e.warnings.length > 0 ? (
        <ul
          data-grounded-warnings
          className="mt-3 space-y-1 rounded-lg border border-amber-200 bg-amber-50/60 px-3 py-2 dark:border-amber-900/50 dark:bg-amber-950/20"
        >
          {e.warnings.map((w) => (
            <li key={w} className="text-xs leading-relaxed text-amber-800 dark:text-amber-200">
              {w}
            </li>
          ))}
        </ul>
      ) : null}
    </MetricCard>
  )
}

/** 接地分那张卡的口径。**不是从后端来的**（`engine_eval` 没有 rules 字段），
 *  所以只有这一处能写——它必须与 `core/engine_eval.py` 开篇那两句一致，改那边就改这里。 */
const GROUNDED_RULES: Record<string, string> = {
  score: '0-5，量的是「有没有在材料之外编造」：材料之外的编造扣分，「材料里没有」**明说出来的算有据**',
  empty:
    '只在「开了检索 + 命中材料 + 有产出」时才有分——空着不是 0 分（那是「这次没量」，不是「这次编了」）',
  selfcheck:
    '柱子顶到头不是好消息：一个永远读满分的标尺和没有标尺是一回事，所以上面那几句是标尺自己的体检结论',
}

/** 回合读数（R1 · PLAN5 §3）——聊天那条路上跑过的回合，各毛病几例。
 *
 *  **它接的是「为什么不落盘」那个缺口**（W5 的诊断工具）。上墙时只做一件事：
 *  把**计数**摆出来。**没有成功率、没有趋势箭头**——`turn_trace` 是诊断工具，
 *  不是考核仪表；一列数一旦有了分母，下一个人就会去算比率、去追。所以：
 *  `turns` 摆出来只是让那些计数有个参照，**不是让人除的**。
 *
 *  **柱子量的是「这一类占了多少轮」，不是「有多严重」。** 四类毛病之间没有可比性
 *  （「慢」和「声称存了没存」不是一回事），所以这里**不排序、不加权、不给分**——
 *  柱子只让你一眼看出「哪一类是主要的」，剩下的判断留给人。
 *
 *  只摆**有过的**毛病：一屏十二格全是 0 读起来像「什么都没发生」，
 *  而这里要回答的是「最近有没有出毛病」。
 */
export function TurnSummaryCard({ t }: { t: TurnSummary | null }) {
  if (!t) return null // 还没读到就整块不渲染（见 `GroundedCard` 那条注）
  const counts = t?.counts || {}
  const labels = new Map((t?.filters || []).map((f) => [f.key, f]))
  const hits = Object.entries(counts).filter(([, n]) => n > 0)
  // 柱子的分母是**窗口里的回合数**：这样柱长读作「这类毛病占了这些轮里的多少」
  const span = Math.max(1, t?.turns ?? 1)
  return (
    <MetricCard
      title="回合读数"
      marker="data-turn-summary"
      headline={`${t?.turns ?? 0}`}
      headlineNote="个回合里，有这些毛病"
      scope={t ? `近 ${t.days} 天` : ''}
      // **判可读性要读 `t.readable`，不是 `!!t`**：读不到时后端照样回一个对象
      // （`readable=false` + 一排 0 + 那句错误），`!!t` 于是是 true——
      // 于是这张卡会把「读不出来」渲染成一屏 0，正好是它该防的那件事。
      readable={t?.readable ?? false}
      // 错误原话要**原样带出去**：不带的话壳只会说「原因没给出来」，
      // 而读不到时那句话就是唯一的线索（与 `calibration` / `north-star` 同一个规矩）
      error={t?.error}
      rules={t?.rules}
      // 「空」只在**读到了、但这个窗口里一轮都没有**时成立。读不到是另一回事：
      // 那种情况由壳摆那句「读不出来」，不是摆「还没有聊过天」——
      // 后者会把「读不到」说成一个具体的事实（§4-8 的同一个道理，换了个方向）。
      empty={!!t && t.readable && t.turns === 0}
      emptyHint={t ? `这 ${t.days} 天里还没有聊过天——所以这条路上一轮都没有。` : ''}
    >
      {hits.length === 0 ? (
        <p data-turn-summary-clean className="mt-3 text-xs text-neutral-400 dark:text-neutral-500">
          这 {t?.turns} 轮里，上面那几类毛病一例都没有。
        </p>
      ) : (
        <ul className="mt-4 space-y-2.5">
          {hits.map(([key, n]) => (
            <li key={key} data-turn-count={key}>
              <div className="flex items-baseline gap-2">
                <span className="w-32 shrink-0 truncate text-xs text-neutral-700 dark:text-neutral-200">
                  {labels.get(key)?.label ?? key}
                </span>
                <span
                  data-turn-count-n={key}
                  className="w-8 shrink-0 text-right text-sm font-semibold tabular-nums text-neutral-800 dark:text-neutral-100"
                >
                  {n}
                </span>
                <div className="h-2.5 min-w-0 flex-1 overflow-hidden rounded-full bg-neutral-100 dark:bg-neutral-800">
                  <div
                    className="h-full rounded-full bg-rose-400 dark:bg-rose-500/80"
                    style={{ width: `${Math.min(100, (n / span) * 100).toFixed(1)}%` }}
                  />
                </div>
                <span className="w-10 shrink-0 text-right text-xs tabular-nums text-neutral-400 dark:text-neutral-500">
                  /{t?.turns}
                </span>
              </div>
              {/* 每一类的判据就是它自己的 hint（与筛选按钮同一份文案），不另立说法 */}
              <p className="mt-0.5 pl-0 text-xs leading-relaxed text-neutral-400 dark:text-neutral-500">
                {labels.get(key)?.hint ?? ''}
              </p>
            </li>
          ))}
        </ul>
      )}

      {t && t.truncated ? (
        <p data-turn-summary-truncated className="mt-3 text-xs text-amber-700 dark:text-amber-300">
          只数到最近 {t.turns} 轮（窗口里其实有 {t.total} 轮）——这个数是窗口的**下界**，
          不是全量。
        </p>
      ) : null}
    </MetricCard>
  )
}

/** 材料使用率（P3 · 接地闭环）——「这一轮注入了 5 条、模型真用了几条」。
 *
 *  **为什么值得上墙**：它是线上唯一一条**最便宜**的检索质量反馈。离线那一套
 *  （golden set / hit@k / MRR）要人专门跑一轮；而这两个数每一轮聊天都在落账本，连续几轮
 *  「注入了 N 条、一条没引用」就是检索质量往下走最早的那个信号（答案还在说人话，
 *  只是不再引材料了）。
 *
 *  **为什么摆两个计数、不摆一个使用率**（与 `TurnSummaryCard` 同一条红线）：一列数一旦有了
 *  分母，下一个人就会去算比率、去比较、去追——而这个模块是诊断工具，不是考核仪表。
 *  更硬的一条理由是**分母本身选不出来**：没检索的回合（闲聊跳过、RAG 关）注入就是 0，
 *  把它算进分母等于拿「没检索」当「检索了没人用」。所以后端给的是
 *  `turns_with_material / injected / cited / uncited_turns` 四个事实，比率要读的人自己心算。
 */
export function SourceUsageCard({ t }: { t: TurnSummary | null }) {
  if (!t) return null // 还没读到就整块不渲染（见 `GroundedCard` 那条注）
  const src = t?.sources
  const turns = src?.turns_with_material ?? 0
  return (
    <MetricCard
      title="材料使用率"
      marker="data-source-usage"
      headline={`${src?.cited ?? 0}/${src?.injected ?? 0}`}
      headlineNote="条材料被正文引用到（引用 / 注入）"
      // 判可读性读 `t.readable`，不是 `!!t`：读不到时后端照样回一个对象
      // （`readable=false` + 一排 0 + 那句错误）——`!!t` 会把「读不出来」渲染成一屏 0，
      // 正好是它该防的那件事。
      readable={t?.readable ?? false}
      error={t?.error}
      rules={t?.rules}
      // 「空」只在**读到了、但窗口里没有一轮注入过材料**时成立（读不到由壳摆「读不出来」）
      empty={!!t && t.readable && turns === 0}
      emptyHint={t ? `这 ${t.days} 天里没有一轮注入过材料（要么没检索，要么检索没命中）。` : ''}
    >
      <ul className="mt-4 space-y-2.5">
        <li data-source-count="turns" className="flex items-baseline gap-2">
          <span className="w-32 shrink-0 text-xs text-neutral-700 dark:text-neutral-200">
            注入过材料的回合
          </span>
          <span className="text-sm font-semibold tabular-nums text-neutral-800 dark:text-neutral-100">
            {turns}
          </span>
          <span className="text-xs text-neutral-400 dark:text-neutral-500">
            / 这 {t?.days} 天共 {t?.turns ?? 0} 轮
          </span>
        </li>
        <li data-source-count="injected" className="flex items-baseline gap-2">
          <span className="w-32 shrink-0 text-xs text-neutral-700 dark:text-neutral-200">
            一共注入
          </span>
          <span className="text-sm font-semibold tabular-nums text-neutral-800 dark:text-neutral-100">
            {src?.injected ?? 0}
          </span>
          <span className="text-xs text-neutral-400 dark:text-neutral-500">条材料</span>
        </li>
        <li data-source-count="cited" className="flex items-baseline gap-2">
          <span className="w-32 shrink-0 text-xs text-neutral-700 dark:text-neutral-200">
            被正文引用到
          </span>
          <span className="text-sm font-semibold tabular-nums text-neutral-800 dark:text-neutral-100">
            {src?.cited ?? 0}
          </span>
          <span className="text-xs text-neutral-400 dark:text-neutral-500">
            条（同一份引用两次只算一次）
          </span>
        </li>
        {/* 这一行是这一格真正的用处：**毛病的个数，不是一个比率**。
            给 0 也不涂绿——它只是一条事实（红了就成了 KPI）。 */}
        <li data-source-count="uncited" className="flex items-baseline gap-2">
          <span className="w-32 shrink-0 text-xs text-neutral-700 dark:text-neutral-200">
            一条都没引用的
          </span>
          <span
            data-source-uncited
            className="text-sm font-semibold tabular-nums text-neutral-800 dark:text-neutral-100"
          >
            {src?.uncited_turns ?? 0}
          </span>
          <span className="text-xs text-neutral-400 dark:text-neutral-500">
            轮（有材料却一次没引——检索质量下滑最早的那个信号）
          </span>
        </li>
      </ul>
      {/* 口径从后端原文照抄（与筛选按钮、与逐条清单同一份说法），不自己编一份 */}
      <p className="mt-3 text-xs leading-relaxed text-neutral-400 dark:text-neutral-500">
        {t?.rules?.sources ?? ''}
      </p>
    </MetricCard>
  )
}

/** 提示词评测（R1 补齐 · PLAN5 §2-2 点名的九条之一）——九条里最后补上的一格。
 *
 *  **它量的是「尺子本身有没有被量过」，不是「哪条提示词更好」。** 与接地分同族
 *  （资产指标）：登记表里那些提示词，跑过 golden set 的有几条、量出来的结论站得住的
 *  又有几条——回答的是「提示词这一层到底有没有基线」。
 *
 *  **这一格最容易变成排行榜**（后端 `prompt_eval.cards()` 本来就是按分数倒序排的，
 *  那是给小屋的技能卡用的），所以三层都堵住：
 *  1. 后端载荷里**没有一条提示词的名字或分数**（`board()` 只给计数）；
 *  2. 这里只摆计数——**不排序、不给条形图**：条形一比长短，它立刻就成了排名；
 *  3. 空态说的是「一条都还没跑过，去哪跑」，不是「你还差 N 条」。
 */
export function PromptEvalCard({ p }: { p: PromptEvalBoard | null }) {
  if (!p) return null // 还没读到就整块不渲染（见 `GroundedCard` 那条注）
  const rows = [
    {
      key: 'decidable',
      label: '下得了结论',
      n: p?.decidable ?? 0,
      hint: 'Wilson 区间够窄的那些——样本小的时候区间很宽，那是真相不是 bug',
    },
    {
      key: 'stale',
      label: '分数已过期',
      n: p?.stale ?? 0,
      hint: '基线跑完之后内容又改过（sha 变了）：那个分数不是现在这一版的',
    },
    {
      key: 'cases',
      label: '跑过的用例',
      n: p?.cases ?? 0,
      hint: '有成绩的那些提示词一共跑过多少条 golden set 用例',
    },
  ]
  return (
    <MetricCard
      title="提示词评测"
      marker="data-prompt-eval"
      headline={`${p?.measured ?? 0}/${p?.registered ?? 0}`}
      headlineNote="条量过（跑过 golden set）"
      // 判可读性读 `p.readable`，不是 `!!p`：读不到时后端照样回一个对象（同一个坑，
      // 回合读数那张卡踩过一次——见它上面那段注释）
      readable={p?.readable ?? false}
      error={p?.error}
      rules={p?.rules}
      bias={p?.bias}
      // 「空」只在读到了、但一条都没跑过时成立；读不到是另一回事（§4-8）
      empty={!!p && p.readable && p.measured === 0}
      emptyHint={
        p
          ? `登记表里 ${p.registered} 条提示词，一条都还没跑过 golden set——去提示词实验室跑一遍，这里就有数了。`
          : ''
      }
    >
      <ul className="mt-4 space-y-2.5">
        {rows.map((r) => (
          <li key={r.key} className="flex items-baseline gap-3" data-prompt-eval-row={r.key}>
            <span className="w-24 shrink-0 text-xs text-neutral-700 dark:text-neutral-200">
              {r.label}
            </span>
            <span
              {...{ [`data-prompt-eval-${r.key}`]: '' }}
              className="w-10 shrink-0 text-right text-sm font-semibold tabular-nums text-neutral-800 dark:text-neutral-100"
            >
              {r.n}
            </span>
            <span className="min-w-0 flex-1 text-xs leading-relaxed text-neutral-400 dark:text-neutral-500">
              {r.hint}
            </span>
          </li>
        ))}
      </ul>
      {/* 这一句是这一格的**结论**：没有它，那三个数会被读成「还有多少没做」 */}
      <p className="mt-3 text-xs leading-relaxed text-neutral-400 dark:text-neutral-500">
        这一格数的是「尺子有没有被量过」，不是「哪条提示词更好」——所以这里不摆任何一条的名字或分数。
      </p>
    </MetricCard>
  )
}

/**
 * 任务级基线（A0 · `Agent升级.md` §5 点名的「进计量局」那一笔）。
 *
 * **这一格读的是「跑分当时」的成绩**，所以标题行必须带两样东西：什么时候跑的（`at`）、
 * 跑的是哪一版金标（`tasks_sha`）。金标改过（A4 就加了一条任务）之后指纹会变，
 * 那时这格里的数**仍然是真的，只是旧了**——`--compare` 会如实报「不可比」，
 * 界面不替它下结论（红线：运行时不许碰金标，指纹归尺子算）。
 */
export function AgentEvalCard({ p }: { p: AgentEvalBoard | null }) {
  if (!p) return null // 还没读到就整块不渲染（见 `GroundedCard` 那条注）
  const rounds = p.rounds
  const rows = [
    {
      key: 'done',
      label: '办成',
      value: p.done != null ? `${p.done}/${p.tasks ?? 0}` : '—',
      hint: '该落盘的落了、该拒的拒了（完成率不含轮数——轮数是成本，完成是结果）',
    },
    {
      key: 'clean',
      label: '干净',
      value: p.clean != null ? `${p.clean}/${p.tasks ?? 0}` : '—',
      hint: '办成了、而且一条规矩都没破（含工具越界与超预算）',
    },
    {
      key: 'floor',
      label: '底线失守',
      value: `${p.floor_failures ?? 0}`,
      hint: '谎报 / 编造路径 / 伪引用——这三条之外的不算底线（长文没落盘单列）',
    },
    {
      key: 'tool',
      label: '工具越界',
      value: `${p.tool_not_allowed ?? 0} · 该用的没用 ${p.tool_not_used ?? 0}`,
      hint: '用了白名单外的工具 · 该查材料却一次都没查',
    },
    {
      key: 'rounds',
      label: '轮数',
      value: rounds ? `中位 ${rounds.median} · p90 ${rounds.p90} · 均值 ${rounds.mean}` : '—',
      hint: '成本基线：A1 的 delegate 要压的就是它',
    },
    {
      key: 'delegate',
      label: '该委托而没委托',
      value: `${p.delegate_missed ?? 0}/${p.delegate_expected ?? 0}`,
      hint: '委托名额用了几个——**能力有没有被用上**，不是失败',
    },
  ]
  return (
    <MetricCard
      title="任务级基线"
      marker="data-agent-eval"
      headline={p.done_rate != null ? `${Math.round(p.done_rate * 100)}%` : '—'}
      headlineNote={`办成率（${p.tasks ?? 0} 条任务）`}
      // 判可读性读 `p.readable`，不是 `!!p`：读不到时后端照样回一个对象（同一个坑）
      readable={p.readable}
      error={p.error}
      rules={p.rules}
      empty={p.readable && (p.tasks ?? 0) === 0}
      emptyHint="报告在，但里面一条任务都没有——那多半是跑分那一轮没跑成，重跑一次。"
    >
      <ul className="mt-4 space-y-2.5">
        {rows.map((r) => (
          <li key={r.key} className="flex items-baseline gap-3" data-agent-eval-row={r.key}>
            <span className="w-28 shrink-0 text-xs text-neutral-700 dark:text-neutral-200">
              {r.label}
            </span>
            <span
              {...{ [`data-agent-eval-${r.key}`]: '' }}
              className="w-40 shrink-0 text-right text-sm font-semibold tabular-nums text-neutral-800 dark:text-neutral-100"
            >
              {r.value}
            </span>
            <span className="min-w-0 flex-1 text-xs leading-relaxed text-neutral-400 dark:text-neutral-500">
              {r.hint}
            </span>
          </li>
        ))}
      </ul>
      {/* **这一行是这一格最重要的东西**：它读的是哪一版、什么时候跑的那一版 */}
      <p
        data-agent-eval-stamp
        className="mt-3 text-xs leading-relaxed text-neutral-400 dark:text-neutral-500"
      >
        {p.at ? `跑于 ${p.at}` : '报告里没写时间'}
        {p.model_id ? ` · 模型 ${p.model_id}` : ''}
        {p.tasks_sha ? ` · 金标指纹 ${p.tasks_sha}` : ''}
        {p.sha_missing ? '（报告里没有指纹，这一格比不了）' : ''}
        {'——金标改过之后要重跑才有新数；拿它跟新报告比，尺子会如实说「不可比」。'}
      </p>
    </MetricCard>
  )
}
