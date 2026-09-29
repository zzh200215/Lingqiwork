// 会话视图（方向 6 第九刀，2026-09-29 自 TutorPage 拆出）：
// sid 起来之后的整屏：头部工具条（深入研究/理清/对质/再学一个）+ 对话流
// + 自评/快捷指令 + 输入框。状态与处理器住在 TutorPage 本体，
// 这里收单个 bundle prop `r`（TutorSessionRec），只负责画。
import type { Dispatch, Ref, ReactNode, SetStateAction } from 'react'
import type { TutorEndResult } from './api'
import type { TutorRecallHit } from './stream'
import { Link } from 'react-router-dom'
import { Markdown } from './markdown'
import RunPanel from './RunPanel'
import AttachToThread from './AttachToThread'
import { Bubble, InterviewRow, QUICK_ASKS, RecallChip, VERDICTS, shortSource, type Turn } from './tutorShared'

export interface TutorSessionRec {
  asking: boolean
  beginWith: (topicText: string, repo?: string, m?: 'socratic' | 'feynman' | 'future' | 'interview', originPointId?: number, prereqCardId?: number) => Promise<void>
  bottom: Ref<HTMLDivElement>
  busy: boolean
  cfBusy: boolean
  dcBusy: boolean
  draft: string
  ended: { concept: string; domain: string; stuck: string; transfer: string; nearby: TutorEndResult['material_nearby']; merged: TutorEndResult['merged'] } | null
  err: string
  hits: TutorRecallHit[]
  judge: () => Promise<void>
  judgeMsg: string
  judging: boolean
  mark: (v: 'got' | 'half' | 'useless') => Promise<void>
  mode: 'socratic' | 'feynman' | 'future' | 'interview'
  modelOk: boolean
  reportCards: ReactNode
  reset: () => void
  rsBusy: boolean
  runConflict: (override?: string) => Promise<void>
  runDecide: (override?: string) => Promise<void>
  runResearch: (override?: string) => Promise<void>
  send: (sessionId: number, text: string) => Promise<void>
  setDraft: Dispatch<SetStateAction<string>>
  sid: number | null
  stop: () => void
  streaming: string
  submit: () => Promise<void>
  topic: string
  turns: Turn[]
  verdict: '' | 'got' | 'half' | 'useless'
}

export default function TutorSessionView({ r }: { r: TutorSessionRec }) {
  const { asking, beginWith, bottom, busy, cfBusy, dcBusy, draft, ended, err, hits, judge, judgeMsg, judging, mark, mode, modelOk, reportCards, reset, rsBusy, runConflict, runDecide, runResearch, send, setDraft, sid, stop, streaming, submit, topic, turns, verdict } = r
  return (
    <>
      <header className="flex items-center gap-3 border-b border-neutral-200/80 px-6 py-3 dark:border-neutral-800/80">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">
            {mode === 'feynman' && (
              <span className="mr-1.5 rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-700 dark:bg-amber-500/20 dark:text-amber-300">
                费曼
              </span>
            )}
            {mode === 'future' && (
              <span className="mr-1.5 rounded bg-sky-100 px-1.5 py-0.5 text-xs text-sky-700 dark:bg-sky-500/20 dark:text-sky-300">
                未来的你
              </span>
            )}
            {topic || '这次'}
          </p>
          {ended?.concept ? (
            <p className="truncate text-xs text-neutral-500">
              {ended.concept}
              {ended.domain ? ` · 领域：${ended.domain}` : ''}
              {ended.stuck ? ` · 卡点：${ended.stuck}` : ''}
            </p>
          ) : null}
          {/* 这次归并了什么，必须说出来：机器自己换了个名字如果界面上不提，
              就是一件用户看不见也查不到的事。 */}
          {ended?.merged ? (
            <p data-ended-merged className="truncate text-xs text-violet-600 dark:text-violet-300">
              这次的叫法「{ended.merged.from}」并进了已有概念「{ended.merged.into}」
              （{ended.merged.why}）
            </p>
          ) : null}
        </div>
        <button
          onClick={() => void runResearch()}
          disabled={rsBusy || !topic.trim()}
          title="围绕这个话题搜资料、读正文，写一篇带引用的讲解；成品可存进知识库"
          className="shrink-0 rounded-lg px-2.5 py-1 text-xs text-sky-600 transition-colors hover:bg-sky-50 hover:text-sky-700 disabled:opacity-40 dark:text-sky-300 dark:hover:bg-sky-500/10"
        >
          {rsBusy ? '研究中…' : '🔍 深入研究'}
        </button>
        <button
          onClick={() => void runDecide()}
          disabled={dcBusy || !topic.trim()}
          title="把这个话题当成一次决策：先摆出「我理解你要决定的是什么」，再摆开选项、指出判据、给一个有条件的判断；成品可存进知识库"
          className="shrink-0 rounded-lg px-2.5 py-1 text-xs text-violet-600 transition-colors hover:bg-violet-50 hover:text-violet-700 disabled:opacity-40 dark:text-violet-300 dark:hover:bg-violet-500/10"
        >
          {dcBusy ? '理清中…' : '🤔 帮我理清'}
        </button>
        <button
          onClick={() => void runConflict()}
          disabled={cfBusy || !topic.trim()}
          title="把你自己的说法和外部来源摆在一起，看哪两处对不上；一处都没有它会直说没有。成品可存进知识库"
          className="shrink-0 rounded-lg px-2.5 py-1 text-xs text-teal-600 transition-colors hover:bg-teal-50 hover:text-teal-700 disabled:opacity-40 dark:text-teal-300 dark:hover:bg-teal-500/10"
        >
          {cfBusy ? '对质中…' : '⚔️ 对质'}
        </button>
        <button
          onClick={reset}
          className="shrink-0 rounded-lg px-2.5 py-1 text-xs text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-800 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
        >
          再学一个
        </button>
      </header>

      {modelOk ? null : (
        <p className="border-b border-amber-200 bg-amber-50 px-6 py-2 text-xs text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
          当前默认模型最近失败过，回答可能出不来。去
          <Link to="/settings" className="underline">
            设置
          </Link>
          换一个。
        </p>
      )}

      <div className="flex-1 overflow-y-auto px-6 py-4">
        <div className="mx-auto flex max-w-3xl flex-col gap-4">
          {hits.length > 0 ? <RecallChip hits={hits} /> : null}
          {turns.map((t, i) => (
            <Bubble key={i} turn={t} canSave />
          ))}
          {asking ? (
            <RunPanel
              phase={streaming ? 'streaming' : 'planning'}
              tone="violet"
              icon="🎓"
              title="讲解中"
              status={streaming ? undefined : '在想怎么讲…'}
              onCancel={stop}
            >
              {streaming ? <Markdown>{streaming}</Markdown> : null}
            </RunPanel>
          ) : null}
          {err && !asking ? (
            <RunPanel
              phase="error"
              tone="rose"
              icon="🎓"
              title="讲解中断"
              error={err}
              onRetry={() => {
                const last = [...turns].reverse().find((t) => t.role === 'user')
                if (last && sid !== null) void send(sid, last.content)
              }}
            />
          ) : null}
          {reportCards}
          <div ref={bottom} />
        </div>
      </div>

      <div className="border-t border-neutral-200/80 px-6 py-3 dark:border-neutral-800/80">
        <div className="mx-auto max-w-3xl">
          {/* 自评在输入框上方，不在会话末尾：标完还能继续问，半懂改成搞懂了
              也只是再点一次。它是记录这次的结果，不是「交作业」的按钮。
              **面试陪练没有自评**：面试不是教学，那是另一套收尾（出复盘报告）。 */}
          {mode === 'interview' ? (
            <InterviewRow
              sid={sid}
              turns={turns.length}
              busy={busy}
              onTeach={(topic) => void beginWith(topic, '', 'socratic')}
            />
          ) : (
          <>
          <div className="flex flex-wrap items-center gap-2 pb-2">
            <span className="text-xs font-medium uppercase tracking-wider text-neutral-400">
              这次
            </span>
            {VERDICTS.map((v) => (
              <button
                key={v.v}
                data-verdict={v.v}
                onClick={() => void mark(v.v)}
                disabled={busy || turns.length === 0}
                className={`rounded-lg border px-2.5 py-1 text-xs transition-colors disabled:opacity-40 ${
                  verdict === v.v ? 'ring-2 ring-violet-300 dark:ring-violet-500/50 ' : ''
                }${v.cls}`}
              >
                {v.label}
              </button>
            ))}
            {/* M1 场景 B：讲完了不想自己评？让它读一遍全文给一档。
                它判完走的是**同一条 end()**——概念/卡点、「又卡住」全都照常。 */}
            <button
              data-judge
              onClick={() => void judge()}
              disabled={busy || judging || turns.length === 0}
              title="读完整场对话判一档（一次模型调用）；判不了会退回来让你自己标"
              className="rounded-lg wb-btn-ghost px-2.5 py-1 text-xs"
            >
              {judging ? '判中…' : '让它判'}
            </button>
            {judgeMsg ? (
              <span data-judge-msg className="text-xs text-neutral-400">
                {judgeMsg}
              </span>
            ) : null}
            {verdict ? (
              <span className="text-xs text-neutral-400">
                {verdict === 'useless'
                  ? '记下了，不会再翻出来'
                  : ended?.concept
                    ? `记下了：${ended.concept}`
                    : '记下了'}
              </span>
            ) : null}
            {/* R3 · PLAN5 §3：把**这一场会话**挂到某件事上。
                放在这里是因为念头出现的时刻就是「刚聊完这一场」——
                概念卡里那个入口要你先展开一张卡才看得见，而一场课讲完的那一刻
                你手里正好有一个 sid。**不做自动挂接**（PLAN5 §4-7 一事一处：
                归到哪件事是判断，判断留给人点）。
                只在评过之后摆：没评之前这一场还没「成」，挂上去的是半场。 */}
            {verdict && sid !== null ? (
              <AttachToThread kind="session" ref={String(sid)} className="inline-flex" />
            ) : null}
            {ended && ended.nearby.length > 0 ? (
              <span className="text-xs text-neutral-400">
                材料里还有：
                {ended.nearby.map((n) => (
                  <span key={n.source} className="ml-1 rounded bg-neutral-200/70 px-1.5 py-0.5 dark:bg-neutral-700/60">
                    {shortSource(n.source)}
                  </span>
                ))}
              </span>
            ) : null}
            {/* 迁移问题（Bjork 参考项）：原场景答对不算懂，换个场景还能用才算。
                和 material_nearby 一样只在总结里出现一次，不落库。 */}
            {ended?.transfer ? (
              <span className="text-xs text-violet-500 dark:text-violet-300">
                换个场景试试：{ended.transfer}
              </span>
            ) : null}
          </div>
          </>
          )}
          {/* 讲法快捷指令：一听没跟上时最常见的四句，一键发出。
              最后「考我一题」是反转——让它出题，不是继续听讲。 */}
          <div className="flex flex-wrap items-center gap-1.5 pb-1.5">
            {QUICK_ASKS.map(([label, text]) => (
              <button
                key={label}
                onClick={() => {
                  if (sid !== null && !busy) void send(sid, text)
                }}
                disabled={busy || turns.length === 0}
                title={text}
                className="rounded-full border border-neutral-200 px-2.5 py-1 text-xs text-neutral-500 transition-colors hover:border-violet-300 hover:text-violet-600 disabled:opacity-40 dark:border-neutral-700 dark:text-neutral-400 dark:hover:border-violet-500/50 dark:hover:text-violet-300"
              >
                {label}
              </button>
            ))}
          </div>
          {/* data-pet-clear：作答那一行随会话滚——滚进右下角时零柒给它让位
              （挂件在 scroll 时补量）。窄窗上它正好压在宠物底下。 */}
          <div data-pet-clear className="flex items-end gap-2">
            <textarea
              data-tutor-say
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  void submit()
                }
              }}
              rows={2}
              placeholder="先按你自己的理解答一遍（Enter 发送，Shift+Enter 换行）"
              className="min-w-0 flex-1 resize-none rounded-md border border-neutral-300 bg-white px-3.5 py-2.5 text-sm outline-none transition-colors placeholder:text-neutral-400 focus:border-violet-400 dark:border-neutral-700 dark:bg-neutral-900"
            />
            <button
              onClick={() => void submit()}
              disabled={!draft.trim() || busy}
              className="shrink-0 rounded-md wb-btn-primary px-4 py-2.5 text-sm"
            >
              发送
            </button>
          </div>
        </div>
      </div>
    </>
  )
}
