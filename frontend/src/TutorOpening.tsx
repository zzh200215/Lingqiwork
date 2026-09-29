// 开场屏（方向 6 第八刀，2026-09-29 自 TutorPage 拆出）：
// 学 / 练 / 记录三个标签的一屏式主页。状态与处理器住在 TutorPage 本体，
// 这里收单个 bundle prop `r`（TutorOpeningRec），只负责画。
import type { Dispatch, SetStateAction, ReactNode } from 'react'
import type { TutorTab } from './routes'
import {
  type CardDraft,
  type CardSources,
  type InterviewBank,
  type TutorConceptRow,
  type TutorLearningMap,
  type TutorMastery,
  type TutorSessionRow,
  type TutorStarter,
  type TutorStats,
  type TutorStuckRow,
} from './api'
import { Link } from 'react-router-dom'
import { RepeatChip } from './tutorShared'

export interface TutorOpeningRec {
  bank: InterviewBank | null
  begin: () => void
  beginWith: (topicText: string, repo?: string, m?: 'socratic' | 'feynman' | 'future' | 'interview', originPointId?: number, prereqCardId?: number) => Promise<void>
  busy: boolean
  cfBusy: boolean
  conceptsPanel: ReactNode
  dcBusy: boolean
  dgOpen: boolean
  err: string
  hasCards: boolean
  historyList: ReactNode
  learnMap: TutorLearningMap | null
  mapCount: number
  markQuiz: (m: 'hit' | 'miss') => void
  mastery: TutorMastery | null
  mode: 'socratic' | 'feynman' | 'future' | 'interview'
  open: (id: number) => Promise<void>
  qz: { cards: CardDraft[]; idx: number; revealed: boolean; answer: string; marks: (null | 'hit' | 'miss')[] } | null
  qzBusy: boolean
  qzMode: 'file' | 'text'
  qzMsg: string
  qzQuery: string
  qzSource: string
  qzSources: CardSources | null
  qzText: string
  repeatMap: Map<string, TutorConceptRow>
  reportCards: ReactNode
  resolveStuck: (sessionId: number, resolved: boolean) => Promise<void>
  rows: TutorSessionRow[]
  rsBusy: boolean
  runQuiz: () => Promise<void>
  runTool: () => void
  setDgOpen: Dispatch<SetStateAction<boolean>>
  setMode: Dispatch<SetStateAction<'socratic' | 'feynman' | 'future' | 'interview'>>
  setQz: Dispatch<SetStateAction<{ cards: CardDraft[]; idx: number; revealed: boolean; answer: string; marks: (null | 'hit' | 'miss')[] } | null>>
  setQzMode: Dispatch<SetStateAction<'file' | 'text'>>
  setQzQuery: Dispatch<SetStateAction<string>>
  setQzSource: Dispatch<SetStateAction<string>>
  setQzText: Dispatch<SetStateAction<string>>
  setTab: (t: TutorTab) => void
  setToolOpen: Dispatch<SetStateAction<'' | 'research' | 'decide' | 'conflict'>>
  setToolTopic: Dispatch<SetStateAction<string>>
  setTopic: Dispatch<SetStateAction<string>>
  starters: TutorStarter[]
  stats: TutorStats | null
  stuckRows: TutorStuckRow[]
  tab: TutorTab
  toolOpen: '' | 'research' | 'decide' | 'conflict'
  toolTopic: string
  topic: string
}

export default function TutorOpening({ r }: { r: TutorOpeningRec }) {
  const { bank, begin, beginWith, busy, cfBusy, conceptsPanel, dcBusy, dgOpen, err, hasCards, historyList, learnMap, mapCount, markQuiz, mastery, mode, open, qz, qzBusy, qzMode, qzMsg, qzQuery, qzSource, qzSources, qzText, repeatMap, reportCards, resolveStuck, rows, rsBusy, runQuiz, runTool, setDgOpen, setMode, setQz, setQzMode, setQzQuery, setQzSource, setQzText, setTab, setToolOpen, setToolTopic, setTopic, starters, stats, stuckRows, tab, toolOpen, toolTopic, topic } = r
  return (
      <div className="wb-page flex-1 overflow-y-auto px-6 py-6">
        {/* 开场屏 = 一屏式主页：学 / 练 / 记录 三个标签，一屏只做一类事。
            2026-09-18 版面改版：容器从 5xl（1024px）放到 1600px，与别的页对齐——
            它原来是全站最窄的一页，1920 窗口下两侧空掉一半还多。 */}
        <div className="mx-auto flex max-w-[1600px] flex-col gap-6">
          {/* 「学 / 练 / 记录」那排标签已经搬到**侧栏**（2026-09-18 导航改版）：
              同一件事不留两个入口。这一档仍然走 `?tab=`，所以
              `/tutor?tab=record` 这种深链、以及页内那几处 setTab 都照旧。 */}
          {tab === 'learn' ? (
          <section className="mx-auto w-full max-w-2xl pt-2 text-center">
          <h1 className="pb-1 text-2xl font-semibold tracking-tight">
            {mode === 'interview' ? '面试什么方向？' : '你想搞懂什么？'}
          </h1>
          <p className="pb-4 text-sm text-neutral-500">
            {mode === 'interview'
              ? '它扮面试官：一次只问一个问题，答得含糊就追一层。散场出一份复盘报告。'
              : '说一个具体的东西。它会先问你现在怎么理解，再讲。'}
          </p>
          {/* 模式切换：学（苏格拉底）还是讲（费曼）。是会话级选择，不是设置。 */}
          <div className="mb-3 flex justify-center gap-2 text-xs">
            <button
              onClick={() => setMode('socratic')}
              className={`rounded-full border px-3 py-1.5 transition-colors ${
                mode === 'socratic'
                  ? 'border-violet-500 bg-violet-500/10 font-medium text-violet-600 dark:text-violet-300'
                  : 'border-neutral-300 text-neutral-500 hover:border-violet-300 dark:border-neutral-700'
              }`}
            >
              🎓 老师教我
            </button>
            <button
              onClick={() => setMode('feynman')}
              className={`rounded-full border px-3 py-1.5 transition-colors ${
                mode === 'feynman'
                  ? 'border-amber-500 bg-amber-500/10 font-medium text-amber-600 dark:text-amber-300'
                  : 'border-neutral-300 text-neutral-500 hover:border-amber-300 dark:border-neutral-700'
              }`}
              title="反转：你来讲，它当较真的学生追问，检验你是不是真懂"
            >
              🗣 我来讲（费曼）
            </button>
            <button
              onClick={() => setMode('future')}
              className={`rounded-full border px-3 py-1.5 transition-colors ${
                mode === 'future'
                  ? 'border-sky-500 bg-sky-500/10 font-medium text-sky-600 dark:text-sky-300'
                  : 'border-neutral-300 text-neutral-500 hover:border-sky-300 dark:border-neutral-700'
              }`}
              title="和一年后的自己聊聊：用你的记忆、日记、学习记录合成「一年后的档案」"
            >
              🔮 未来的你
            </button>
            {/* M3 面试陪练：只问不教，散场出复盘报告。题库是**他自己的**东西
                （面试准备.md + 半懂/又卡住的概念 + 到期卡），只读。 */}
            <button
              data-mode="interview"
              onClick={() => setMode('interview')}
              className={`rounded-full border px-3 py-1.5 transition-colors ${
                mode === 'interview'
                  ? 'border-amber-500 bg-amber-500/10 font-medium text-amber-600 dark:text-amber-300'
                  : 'border-neutral-300 text-neutral-500 hover:border-amber-300 dark:border-neutral-700'
              }`}
              title="它扮面试官：一次一问、答得含糊就追一层，一场 5–8 题，散场出一份复盘报告到 vault/reports/"
            >
              🎤 面试陪练
            </button>
          </div>
          {/* 选中面试陪练时看一眼题库（**只读**）：它问什么，你自己得能查得到。
              只在选中时拉——不选它的人不该为它付一次请求。 */}
          {mode === 'interview' ? (
            <p data-interview-bank className="pb-2 text-xs text-neutral-400">
              {bank
                ? `题库：${
                    bank.file ? `${bank.file} ${bank.questions.length} 条` : '没有 面试准备.md'
                  } · 半懂/又卡住 ${bank.concepts.length} 个 · 到期卡 ${bank.cards.length} 张`
                : '看一眼题库…'}
            </p>
          ) : null}
          <div className="flex gap-2">
            <input
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void begin()
              }}
              autoFocus
              data-tutor-topic
              placeholder={
                mode === 'interview'
                  ? '例如：Python 后端'
                  : '例如：asyncio 里 await 到底把控制权交给了谁'
              }
              className="min-w-0 flex-1 rounded-md border border-neutral-300 bg-white px-3.5 py-2.5 text-left text-sm outline-none transition-colors placeholder:text-neutral-400 focus:border-violet-400 dark:border-neutral-700 dark:bg-neutral-900"
            />
            <button
              data-tutor-begin
              onClick={() => void begin()}
              disabled={!topic.trim() || busy}
              className="shrink-0 rounded-md bg-gradient-to-r from-violet-600 to-fuchsia-600 px-5 py-2.5 text-sm font-medium text-white transition-all hover:brightness-110 disabled:opacity-40"
            >
              开始
            </button>
          </div>
          {err ? <p className="pt-3 text-sm text-rose-600 dark:text-rose-400">{err}</p> : null}
          {/* 开场建议：你自己的记录放在手边（DeepTutor 参考项）。点了才开会话，
              不是队列——没有计数、没有到期，想不理就不理。 */}
          {starters.length > 0 ? (
            <div className="flex flex-wrap justify-center gap-2 pt-4">
              {starters.map((s) => (
                <button
                  key={s.kind + s.topic}
                  onClick={() => void beginWith(s.topic)}
                  title={
                    s.kind === 'half'
                      ? '上次没完全搞懂，点它从上次的状态接着来'
                      : '你日记里写下的困惑，点它开一场会话'
                  }
                  className="rounded-full border border-neutral-300 px-3 py-1 text-xs text-neutral-500 transition-colors hover:border-violet-300 hover:text-violet-600 dark:border-neutral-700 dark:text-neutral-400 dark:hover:border-violet-500/50 dark:hover:text-violet-300"
                >
                  {s.kind === 'half' ? '↳' : '📔'} {s.note}：{s.topic}
                </button>
              ))}
            </div>
          ) : null}
          </section>
          ) : null}

          {/* 继续上次：最近的会话一跳直达，不用去历史列表里翻 */}
          {tab === 'learn' && rows.length > 0 ? (
            <div className="mx-auto flex w-full max-w-2xl items-center gap-3 rounded-lg border border-neutral-200/80 bg-white px-4 py-2.5 dark:border-neutral-800 dark:bg-neutral-900/60">
              <span className="shrink-0 rounded-full bg-violet-100 px-2 py-0.5 text-xs font-medium text-violet-700 dark:bg-violet-500/20 dark:text-violet-300">
                继续上次
              </span>
              <span className="min-w-0 flex-1 truncate text-xs text-neutral-600 dark:text-neutral-300">
                {rows[0].concept || rows[0].topic}
                {rows[0].stuck ? ` · 卡在：${rows[0].stuck}` : ''}
              </span>
              <button
                onClick={() => void open(rows[0].id)}
                className="shrink-0 rounded-lg wb-btn-ghost px-2.5 py-1 text-xs"
              >
                接着学 →
              </button>
            </div>
          ) : null}

          {/* 练：一进来就是测验，不摆别的 */}
          {tab === 'practice' ? (
            <div className="flex items-center justify-between gap-3 rounded-lg border border-neutral-200/80 bg-white px-4 py-3 dark:border-neutral-800 dark:bg-neutral-900/60">
              <p className="text-sm text-neutral-600 dark:text-neutral-300">
                出几道题考你，找出没懂的地方；没答上的就地开教学补课。
              </p>
              <Link
                to="/review"
                className="shrink-0 rounded-lg wb-btn-ghost px-2.5 py-1 text-xs"
              >
                出好的卡片去「今日」复习 →
              </Link>
            </div>
          ) : null}

          {/* 工具台：一张卡一个工具，点卡片展开它自己的输入面板——话题
              就地收，不用先去顶部输入框写一遍。跑完的成品卡出现在下面。
              卡片行只在「学」标签出现；「练」标签下这一节只剩测验面板。 */}
          <section>
            {tab === 'learn' ? (
            <>
            <p className="pb-2 text-xs font-medium uppercase tracking-wider text-neutral-400">
              或者直接用这些工具 · 不用先开一场教学
            </p>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
              <button
                onClick={() => {
                  setToolTopic(topic)
                  setToolOpen(toolOpen === 'research' ? '' : 'research')
                }}
                className={`flex h-full flex-col gap-1 rounded-lg border p-4 text-left transition-all ${
                  toolOpen === 'research'
                    ? 'border-sky-400 ring-2 ring-sky-200 dark:ring-sky-500/30'
                    : 'border-neutral-200 bg-white hover:border-sky-300 dark:border-neutral-800 dark:bg-neutral-900/60 dark:hover:border-sky-500/40'
                }`}
              >
                <span className="text-xl">🔍</span>
                <span className="text-sm font-medium text-neutral-800 dark:text-neutral-100">
                  深入研究{rsBusy ? '…' : ''}
                </span>
                <span className="text-xs leading-relaxed text-neutral-500 dark:text-neutral-400">
                  围绕话题搜资料、读正文，写一篇带引用的讲解；成品可存进知识库。
                </span>
              </button>
              <button
                onClick={() => {
                  setToolTopic(topic)
                  setToolOpen(toolOpen === 'decide' ? '' : 'decide')
                }}
                className={`flex h-full flex-col gap-1 rounded-lg border p-4 text-left transition-all ${
                  toolOpen === 'decide'
                    ? 'border-violet-400 ring-2 ring-violet-200 dark:ring-violet-500/30'
                    : 'border-neutral-200 bg-white hover:border-violet-300 dark:border-neutral-800 dark:bg-neutral-900/60 dark:hover:border-violet-500/40'
                }`}
              >
                <span className="text-xl">🤔</span>
                <span className="text-sm font-medium text-neutral-800 dark:text-neutral-100">
                  帮我理清{dcBusy ? '…' : ''}
                </span>
                <span className="text-xs leading-relaxed text-neutral-500 dark:text-neutral-400">
                  把它当成一次决策：先复述题面，再摆开选项、指出判据，给有条件的判断。
                </span>
              </button>
              <button
                onClick={() => {
                  setToolTopic(topic)
                  setToolOpen(toolOpen === 'conflict' ? '' : 'conflict')
                }}
                className={`flex h-full flex-col gap-1 rounded-lg border p-4 text-left transition-all ${
                  toolOpen === 'conflict'
                    ? 'border-rose-400 ring-2 ring-rose-200 dark:ring-rose-500/30'
                    : 'border-neutral-200 bg-white hover:border-rose-300 dark:border-neutral-800 dark:bg-neutral-900/60 dark:hover:border-rose-500/40'
                }`}
              >
                <span className="text-xl">⚔️</span>
                <span className="text-sm font-medium text-neutral-800 dark:text-neutral-100">
                  对质{cfBusy ? '…' : ''}
                </span>
                <span className="text-xs leading-relaxed text-neutral-500 dark:text-neutral-400">
                  把你的说法和外部来源摆在一起，逐处找对不上的地方。
                </span>
              </button>
              <button
                onClick={() => setDgOpen(true)}
                className={`flex h-full flex-col gap-1 rounded-lg border p-4 text-left transition-all ${
                  dgOpen
                    ? 'border-teal-400 ring-2 ring-teal-200 dark:ring-teal-500/30'
                    : 'border-neutral-200 bg-white hover:border-teal-300 dark:border-neutral-800 dark:bg-neutral-900/60 dark:hover:border-teal-500/40'
                }`}
              >
                <span className="text-xl">🎒</span>
                <span className="text-sm font-medium text-neutral-800 dark:text-neutral-100">
                  消化一份材料
                </span>
                <span className="text-xs leading-relaxed text-neutral-500 dark:text-neutral-400">
                  拿一份教程 / 长文 / 仓库，拆成「要搞懂的点」，逐点开教、顺手出卡。
                </span>
              </button>
              <button
                onClick={() => setTab('practice')}
                className="flex h-full flex-col gap-1 rounded-lg border border-neutral-200 bg-white p-4 text-left transition-all hover:border-orange-300 dark:border-neutral-800 dark:bg-neutral-900/60 dark:hover:border-orange-500/40"
              >
                <span className="text-xl">📝</span>
                <span className="text-sm font-medium text-neutral-800 dark:text-neutral-100">
                  模拟测验
                </span>
                <span className="text-xs leading-relaxed text-neutral-500 dark:text-neutral-400">
                  拿一份材料出几道题考你，逐题自判；没答上的一键开教学补课。
                </span>
              </button>
            </div>
            </>
            ) : null}
            {/* 点开的工具面板：就地收话题、就地开跑 */}
            {toolOpen ? (
              <div
                className={`mt-3 rounded-lg border p-4 ${
                  toolOpen === 'research'
                    ? 'border-sky-200 bg-sky-50/40 dark:border-sky-500/30 dark:bg-sky-500/10'
                    : toolOpen === 'decide'
                      ? 'border-violet-200 bg-violet-50/40 dark:border-violet-500/30 dark:bg-violet-500/10'
                      : 'border-rose-200 bg-rose-50/40 dark:border-rose-500/30 dark:bg-rose-500/10'
                }`}
              >
                <div className="flex items-center justify-between pb-2">
                  <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">
                    {toolOpen === 'research'
                      ? '🔍 研究什么？'
                      : toolOpen === 'decide'
                        ? '🤔 要理清什么？'
                        : '⚔️ 拿什么去对质？'}
                  </p>
                  <button
                    onClick={() => setToolOpen('')}
                    className="text-xs text-neutral-400 transition-colors hover:text-neutral-600 dark:hover:text-neutral-300"
                  >
                    收起
                  </button>
                </div>
                <div className="flex gap-2">
                  <input
                    value={toolTopic}
                    onChange={(e) => setToolTopic(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') runTool()
                    }}
                    autoFocus
                    placeholder="说一个具体的东西…"
                    className="min-w-0 flex-1 rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none transition-colors focus:border-violet-400 dark:border-neutral-700 dark:bg-neutral-900"
                  />
                  <button
                    onClick={runTool}
                    disabled={!toolTopic.trim()}
                    className="shrink-0 rounded-md bg-neutral-800 px-4 py-2 text-sm font-medium text-white transition-all hover:brightness-125 disabled:opacity-40 dark:bg-neutral-100 dark:text-neutral-900"
                  >
                    开跑
                  </button>
                </div>
              </div>
            ) : null}

            {/* 模拟测验面板：选材料 → 出题 → 逐题作答自判 → 总结。
                没答上的题就地开一场教学，题面就是开场话题。 */}
            {tab === 'practice' ? (
              <div className="mt-3 rounded-lg border border-orange-200 bg-orange-50/40 p-4 dark:border-orange-500/30 dark:bg-orange-500/10">
                <div className="flex items-center justify-between pb-2">
                  <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">
                    📝 拿什么材料考你？
                  </p>
                  <button
                    onClick={() => setTab('learn')}
                    className="text-xs text-neutral-400 transition-colors hover:text-neutral-600 dark:hover:text-neutral-300"
                  >
                    收起
                  </button>
                </div>

                {!qz ? (
                  <>
                    <div className="mb-2 flex gap-1 text-xs">
                      {(['file', 'text'] as const).map((m) => (
                        <button
                          key={m}
                          onClick={() => setQzMode(m)}
                          className={`rounded-full border px-2.5 py-1 transition-colors ${
                            qzMode === m
                              ? 'border-orange-500 bg-orange-500/10 font-medium text-orange-700 dark:text-orange-300'
                              : 'border-neutral-300 text-neutral-500 hover:border-orange-300 dark:border-neutral-700'
                          }`}
                        >
                          {m === 'file' ? '📄 选一份材料' : '✍️ 粘一段'}
                        </button>
                      ))}
                    </div>
                    {qzMode === 'file' ? (
                      <div className="space-y-1">
                        <input
                          value={qzQuery}
                          onChange={(e) => setQzQuery(e.target.value)}
                          placeholder="筛选文件名…"
                          className="w-full rounded-lg border border-neutral-300 bg-white px-2.5 py-1.5 text-sm outline-none focus:border-orange-400 dark:border-neutral-700 dark:bg-neutral-900"
                        />
                        <select
                          value={qzSource}
                          onChange={(e) => setQzSource(e.target.value)}
                          size={6}
                          className="w-full rounded-lg border border-neutral-300 bg-white px-2 py-1 text-sm outline-none focus:border-orange-400 dark:border-neutral-700 dark:bg-neutral-900"
                        >
                          {(
                            [
                              ['vault 笔记', qzSources?.vault],
                              ['代码仓库', qzSources?.repos],
                              ['本地目录', qzSources?.dirs],
                            ] as const
                          ).map(([label, items]) =>
                            items?.length ? (
                              <optgroup key={label} label={label}>
                                {items.map((p) => (
                                  <option key={p} value={p}>
                                    {p}
                                  </option>
                                ))}
                              </optgroup>
                            ) : null
                          )}
                        </select>
                      </div>
                    ) : (
                      <textarea
                        value={qzText}
                        onChange={(e) => setQzText(e.target.value)}
                        rows={5}
                        placeholder="把要考的材料粘进来…"
                        className="w-full rounded-lg border border-neutral-300 bg-white px-2.5 py-1.5 text-sm outline-none focus:border-orange-400 dark:border-neutral-700 dark:bg-neutral-900"
                      />
                    )}
                    <div className="mt-2 flex items-center gap-2">
                      <button
                        onClick={() => void runQuiz()}
                        disabled={qzBusy || (qzMode === 'text' ? !qzText.trim() : !qzSource)}
                        className="rounded-lg bg-gradient-to-r from-orange-500 to-amber-500 px-3 py-1.5 text-sm font-medium text-white transition-all hover:brightness-110 disabled:opacity-40"
                      >
                        {qzBusy ? '出题中…' : '出 5 道题考我'}
                      </button>
                      {qzMsg ? (
                        <p className="text-xs text-rose-600 dark:text-rose-400">{qzMsg}</p>
                      ) : null}
                    </div>
                  </>
                ) : null}

                {/* 逐题作答：先自己想（可写下来），看答案，再自判 */}
                {qz && qz.idx < qz.cards.length ? (
                  <div className="rounded-md border border-orange-200/70 bg-white/80 p-4 dark:border-orange-500/20 dark:bg-neutral-900/50">
                    <p className="pb-1 text-xs text-neutral-400">
                      第 {qz.idx + 1} / {qz.cards.length} 题 · 已答上{' '}
                      {qz.marks.filter((m) => m === 'hit').length} · 没答上{' '}
                      {qz.marks.filter((m) => m === 'miss').length}
                    </p>
                    <p className="pb-3 text-sm font-medium text-neutral-800 dark:text-neutral-100">
                      {qz.cards[qz.idx].front}
                    </p>
                    {!qz.revealed ? (
                      <>
                        <textarea
                          value={qz.answer}
                          onChange={(e) =>
                            setQz((c) => (c ? { ...c, answer: e.target.value } : c))
                          }
                          rows={2}
                          placeholder="先把你记得的答案写下来（也可以空着，直接在心里想）"
                          className="w-full resize-none rounded-lg border border-neutral-300 bg-white px-2.5 py-1.5 text-sm outline-none focus:border-orange-400 dark:border-neutral-700 dark:bg-neutral-900"
                        />
                        <div className="pt-2">
                          <button
                            onClick={() => setQz({ ...qz, revealed: true })}
                            className="rounded-lg bg-neutral-800 px-3 py-1.5 text-xs font-medium text-white transition-all hover:brightness-125 dark:bg-neutral-100 dark:text-neutral-900"
                          >
                            看答案
                          </button>
                        </div>
                      </>
                    ) : (
                      <>
                        <div className="rounded-lg bg-neutral-100 p-3 text-sm leading-relaxed text-neutral-700 dark:bg-neutral-800/70 dark:text-neutral-200">
                          {qz.cards[qz.idx].back}
                        </div>
                        {qz.cards[qz.idx].hint ? (
                          <p className="pt-1.5 text-xs text-neutral-400">
                            提示：{qz.cards[qz.idx].hint}
                          </p>
                        ) : null}
                        <div className="flex gap-2 pt-3">
                          <button
                            onClick={() => markQuiz('hit')}
                            className="rounded-lg border border-emerald-300 px-3 py-1.5 text-xs text-emerald-700 transition-colors hover:bg-emerald-50 dark:border-emerald-700 dark:text-emerald-300 dark:hover:bg-emerald-500/10"
                          >
                            ✓ 答上了
                          </button>
                          <button
                            onClick={() => markQuiz('miss')}
                            className="rounded-lg border border-rose-300 px-3 py-1.5 text-xs text-rose-700 transition-colors hover:bg-rose-50 dark:border-rose-700 dark:text-rose-300 dark:hover:bg-rose-500/10"
                          >
                            ✗ 没答上
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                ) : null}

                {/* 总结：全判完才出现。没答上的题就地开教学，题面当开场话题 */}
                {qz && qz.marks.every((m) => m !== null) ? (
                  <div className="rounded-md border border-orange-200/70 bg-white/80 p-4 dark:border-orange-500/20 dark:bg-neutral-900/50">
                    <p className="pb-2 text-sm font-medium text-neutral-800 dark:text-neutral-100">
                      测验完成：{qz.marks.filter((m) => m === 'hit').length} / {qz.cards.length}{' '}
                      答上了
                    </p>
                    {qz.marks.some((m) => m === 'miss') ? (
                      <div className="space-y-1.5">
                        <p className="text-xs text-neutral-400">
                          这几道没答上——点一题，专门开一场教学把它搞懂：
                        </p>
                        {qz.cards.map((c, i) =>
                          qz.marks[i] === 'miss' ? (
                            <button
                              key={i}
                              onClick={() => {
                                setTab('learn')
                                void beginWith(c.front)
                              }}
                              className="block w-full rounded-lg px-2 py-1.5 text-left text-sm text-neutral-700 transition-colors hover:bg-orange-100/70 hover:text-orange-800 dark:text-neutral-200 dark:hover:bg-orange-500/10 dark:hover:text-orange-300"
                            >
                              ↳ {c.front}
                            </button>
                          ) : null
                        )}
                      </div>
                    ) : (
                      <p className="text-xs text-emerald-600 dark:text-emerald-400">
                        全部答上了——这份材料你是真懂了。
                      </p>
                    )}
                    <button
                      onClick={() => setQz(null)}
                      className="pt-2 text-xs text-neutral-400 transition-colors hover:text-neutral-600 dark:hover:text-neutral-300"
                    >
                      再测一份
                    </button>
                  </div>
                ) : null}
              </div>
            ) : null}
          </section>
          {tab === 'learn' && hasCards ? (
            <div className="flex flex-col gap-4">{reportCards}</div>
          ) : null}

          {tab === 'record' ? (
          <>
          {/* 全空的时候只摆一张欢迎卡：四个「还没有」的空盒子各自漂在页面上，
              不如把「从哪开始」一次说清。三条入口全是真链接，不造假数据。 */}
          {(!learnMap || mapCount === 0) &&
          (!mastery || mastery.events.length === 0) &&
          stuckRows.length === 0 &&
          (!stats || stats.sessions === 0) ? (
            <section className="wb-card-hero rounded-lg p-6">
              <h2 className="text-base font-semibold text-neutral-800 dark:text-neutral-100">
                从一场教学开始
              </h2>
              <p className="mt-1 max-w-2xl text-sm leading-relaxed text-neutral-500 dark:text-neutral-400">
                这里会记下你学到哪了：说通的概念、挂着的卡点、每一次会话。
                现在这页还是白的——下面三条路都能让它长出内容。
              </p>
              <div className="mt-4 grid gap-3 sm:grid-cols-3">
                <Link
                  to="/tutor"
                  className="rounded-md border border-violet-200/70 bg-white p-3 transition-colors hover:border-violet-400 dark:border-violet-500/30 dark:bg-neutral-900/60 dark:hover:border-violet-500/60"
                >
                  <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">
                    🗣 开一场教学
                  </p>
                  <p className="mt-1 text-xs leading-relaxed text-neutral-400 dark:text-neutral-500">
                    挑一个概念讲给零柒听——说通了它就记住，地图上多一颗星。
                  </p>
                </Link>
                <Link
                  to="/notes"
                  className="rounded-md border border-violet-200/70 bg-white p-3 transition-colors hover:border-violet-400 dark:border-violet-500/30 dark:bg-neutral-900/60 dark:hover:border-violet-500/60"
                >
                  <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">
                    📝 消化一份材料
                  </p>
                  <p className="mt-1 text-xs leading-relaxed text-neutral-400 dark:text-neutral-500">
                    在笔记页划词挖空、让它出题——学的东西带着出处，以后可考。
                  </p>
                </Link>
                <Link
                  to="/companion?tab=audio"
                  className="rounded-md border border-violet-200/70 bg-white p-3 transition-colors hover:border-violet-400 dark:border-violet-500/30 dark:bg-neutral-900/60 dark:hover:border-violet-500/60"
                >
                  <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">
                    🎙 拿卡点录一期播客
                  </p>
                  <p className="mt-1 text-xs leading-relaxed text-neutral-400 dark:text-neutral-500">
                    没解的卡点让它讲成人话——通勤路上也能把没懂的过一遍。
                  </p>
                </Link>
              </div>
            </section>
          ) : (
          <>
          {/* 学习概览：数据块、概念地图、最近搞懂、卡点清单、会话历史——
              都收在「记录」标签下，一屏看完自己学到哪了。 */}
          {stats && stats.sessions + stats.concepts > 0 ? (
            <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {([
                ['近 14 天', `${stats.sessions} 场`, '教学会话'],
                ['学过的概念', `${stats.concepts} 个`, '说过「搞懂了」或「半懂」的'],
                ['说通了', `${stats.got} 次`, '最近一次自评是搞懂'],
                [
                  '从半懂到懂',
                  `${mastery?.events.filter((e) => e.from_half).length ?? 0} 个`,
                  '以前半懂、后来真说通了',
                ],
              ] as const).map(([label, value, hint]) => (
                <div
                  key={label}
                  className="wb-card p-4"
                >
                  <p className="text-xs text-neutral-400">{label}</p>
                  <p className="pb-0.5 text-xl font-semibold text-neutral-800 dark:text-neutral-100">
                    {value}
                  </p>
                  <p className="text-xs leading-relaxed text-neutral-400">{hint}</p>
                </div>
              ))}
            </section>
          ) : null}

          <section className="grid items-start gap-6 lg:grid-cols-2">
            <div className="wb-card p-4">
              {conceptsPanel}
              {!learnMap || mapCount === 0 ? (
                <p className="px-1 py-2 text-xs leading-relaxed text-neutral-400">
                  还没有学习记录。在上面开一场，或者消化一份材料，这里会长出你的概念地图。
                </p>
              ) : null}
            </div>
            <div className="flex flex-col gap-6">
              {/* 最近搞懂：学会一个东西的「时刻」。从半懂到懂的格外标出来——
                  那是这份记录里最值钱的线索 */}
              <div className="wb-card p-4">
                <p className="pb-2 text-xs font-medium uppercase tracking-wider text-neutral-400">
                  最近搞懂
                </p>
                {mastery && mastery.events.length > 0 ? (
                  <ul className="space-y-1.5">
                    {mastery.events.slice(0, 6).map((e) => (
                      <li key={e.concept + e.at} className="flex items-baseline gap-2">
                        <span className="shrink-0 text-emerald-500">✦</span>
                        <span className="min-w-0 flex-1 truncate text-sm text-neutral-700 dark:text-neutral-200">
                          {e.concept}
                        </span>
                        {e.from_half ? (
                          <span className="shrink-0 rounded-full bg-emerald-50 px-1.5 py-0.5 text-xs text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-300">
                            从半懂到懂
                          </span>
                        ) : null}
                        <span className="shrink-0 text-xs text-neutral-400">
                          {(e.at || '').slice(5, 10)}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="px-1 py-1 text-xs leading-relaxed text-neutral-400">
                    还没有「说通了」的记录。学完标一次「搞懂了」，这里会记下那个时刻。
                  </p>
                )}
              </div>
              {/* 待解的卡点：全库的卡点集中在这里，逐条可以关掉；做成播客、
                  开圆桌的入口在左边地图的标题行 */}
              <div className="wb-card p-4">
                <p className="pb-2 text-xs font-medium uppercase tracking-wider text-neutral-400">
                  待解的卡点 {stuckRows.filter((s) => !s.resolved_at).length > 0 ? stuckRows.filter((s) => !s.resolved_at).length : ''}
                </p>
                {stuckRows.some((s) => !s.resolved_at) ? (
                  <ul className="space-y-2">
                    {stuckRows
                      .filter((s) => !s.resolved_at)
                      .slice(0, 8)
                      .map((s) => (
                        <li key={s.id} className="group/st flex items-start gap-2">
                          <span className="min-w-0 flex-1">
                            <span className="flex items-baseline gap-1.5">
                              <span className="min-w-0 flex-1 truncate text-sm text-neutral-700 dark:text-neutral-200">
                                {s.concept}
                              </span>
                              {/* 同一个标也出现在这里：这条卡点所属的概念要正是
                                  「又卡住」的那一批，扫描这一列时才不会看漏 */}
                              <RepeatChip c={repeatMap.get(s.concept) ?? null} />
                            </span>
                            <span className="block text-xs leading-relaxed text-neutral-400">
                              ↳ {s.stuck}
                            </span>
                          </span>
                          <button
                            onClick={() => void resolveStuck(s.id, true)}
                            title="这条不用再管了"
                            className="shrink-0 text-xs text-neutral-300 opacity-0 transition-opacity hover:text-emerald-600 focus:opacity-100 group-hover/st:opacity-100 dark:text-neutral-600 dark:hover:text-emerald-300"
                          >
                            ✓
                          </button>
                        </li>
                      ))}
                  </ul>
                ) : (
                  <p className="px-1 py-1 text-xs leading-relaxed text-neutral-400">
                    没有挂着的卡点。学的时候说「这里没懂」，它会记在这里，等哪天回头解决。
                  </p>
                )}
              </div>
            </div>
          </section>

          {/* 学过的：统计一句话 + 完整会话历史，通栏铺开 */}
          <section className="wb-card p-4">
            <div className="flex items-baseline justify-between pb-2">
              <p className="text-xs font-medium uppercase tracking-wider text-neutral-400">
                学过的
              </p>
              {stats && stats.sessions > 0 ? (
                <p className="text-xs text-neutral-400">
                  近 {stats.days} 天 {stats.sessions} 次，{stats.got} 次说通了
                  {stats.got_with_recall > 0
                    ? `，其中 ${stats.got_with_recall} 次接上了以前卡的点`
                    : ''}
                </p>
              ) : null}
            </div>
            {historyList}
          </section>
          </>
          )}
          </>
          ) : null}
        </div>
      </div>
  )
}
