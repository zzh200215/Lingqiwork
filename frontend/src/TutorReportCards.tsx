// 三张成文卡（研究 / 方案 / 对质）+ 材料消化卡（方向 6 第六刀，2026-09-29 自 TutorPage 拆出）：
// 会话里和开场屏共用同一份。状态与跑批逻辑住在 TutorPage 本体，
// 这里只收一个 props 对象画 UI——TutorReports 的每个字段就是主文件里的同名状态。
import type { Dispatch, RefObject, SetStateAction } from 'react'
import FeedbackButtons from './FeedbackButtons'
import InjectedLine from './InjectedLine'
import { Markdown, reportMarkdown, SourceList } from './markdown'
import RunPanel from './RunPanel'
import { ReceiptLine } from './tutorShared'
import type { CardDraft, CardSources, TutorDigestPoint, TutorDigestResult } from './api'
import type { ConflictReport, DecideFrame, DecideReport, ReportDraft, ResearchReport } from './stream'

export interface TutorReports {
  rs: ResearchReport | null
  rsDraft: ReportDraft | null
  rsBusy: boolean
  rsMsg: string
  rsSaved: string
  rsOpen: boolean
  rsInjected: string[]
  setRsOpen: Dispatch<SetStateAction<boolean>>
  rsAbortRef: RefObject<AbortController | null>
  dc: DecideReport | null
  dcDraft: ReportDraft | null
  dcBusy: boolean
  dcFrame: DecideFrame | null
  dcMsg: string
  dcSaved: string
  dcOpen: boolean
  dcInjected: string[]
  setDcOpen: Dispatch<SetStateAction<boolean>>
  dcAbortRef: RefObject<AbortController | null>
  cf: ConflictReport | null
  cfDraft: ReportDraft | null
  cfBusy: boolean
  cfSubject: string
  cfMsg: string
  cfSaved: string
  cfOpen: boolean
  cfInjected: string[]
  setCfOpen: Dispatch<SetStateAction<boolean>>
  cfAbortRef: RefObject<AbortController | null>
  dgOpen: boolean
  dgMode: 'file' | 'text'
  dgQuery: string
  dgSources: CardSources | null
  dgSource: string
  dgText: string
  dgBusy: boolean
  dg: TutorDigestResult | null
  dgMsg: string
  setDgMode: Dispatch<SetStateAction<'file' | 'text'>>
  setDgQuery: Dispatch<SetStateAction<string>>
  setDgSource: Dispatch<SetStateAction<string>>
  setDgText: Dispatch<SetStateAction<string>>
  closeDigest: () => void
  pc: { pointId: number; busy: boolean; drafts: CardDraft[]; picked: Set<number>; msg: string; meta: { source: string; source_label: string; model_id: string } } | null
  pcNotice: string
  setPc: Dispatch<SetStateAction<{ pointId: number; busy: boolean; drafts: CardDraft[]; picked: Set<number>; msg: string; meta: { source: string; source_label: string; model_id: string } } | null>>
  runDigest: () => Promise<void>
  makePointCards: (p: TutorDigestPoint) => Promise<void>
  savePointCards: () => Promise<void>
  saveResearch: () => Promise<void>
  saveDecide: () => Promise<void>
  saveConflict: () => Promise<void>
  busy: boolean
  beginWith: (topicText: string, repo?: string, m?: 'socratic' | 'feynman' | 'future' | 'interview', originPointId?: number, prereqCardId?: number) => Promise<void>
}

export default function TutorReportCards({
  rs,
  rsDraft,
  rsBusy,
  rsMsg,
  rsSaved,
  rsOpen,
  rsInjected,
  setRsOpen,
  rsAbortRef,
  dc,
  dcDraft,
  dcBusy,
  dcFrame,
  dcMsg,
  dcSaved,
  dcOpen,
  dcInjected,
  setDcOpen,
  dcAbortRef,
  cf,
  cfDraft,
  cfBusy,
  cfSubject,
  cfMsg,
  cfSaved,
  cfOpen,
  cfInjected,
  setCfOpen,
  cfAbortRef,
  dgOpen,
  dgMode,
  dgQuery,
  dgSources,
  dgSource,
  dgText,
  dgBusy,
  dg,
  dgMsg,
  setDgMode,
  setDgQuery,
  setDgSource,
  setDgText,
  closeDigest,
  pc,
  pcNotice,
  setPc,
  runDigest,
  makePointCards,
  savePointCards,
  saveResearch,
  saveDecide,
  saveConflict,
  busy,
  beginWith,
}: TutorReports) {
  return (
    <>
      {/* 研究卡：RunPanel 统一壳——进度/停止/重试/成品动作都归框架，
          卡里只剩这个动作自己的内容。 */}
      {rs || rsDraft || rsBusy || rsMsg ? (
        <RunPanel
          phase={rs ? 'done' : rsDraft ? 'streaming' : rsBusy ? 'progress' : 'error'}
          tone="sky"
          icon="🔍"
          title={`研究${rs && rs.rounds && rs.rounds > 1 ? ` · 搜了 ${rs.rounds} 轮` : ''}`}
          status={rs || rsDraft ? undefined : rsMsg || undefined}
          error={!rs && !rsDraft && !rsBusy && rsMsg ? rsMsg : undefined}
          onCancel={() => rsAbortRef.current?.abort()}
          actions={
            <>
              {rs ? (
                <button
                  onClick={() => setRsOpen((v) => !v)}
                  className="rounded-full border border-neutral-300 px-2 py-0.5 text-xs text-neutral-500 transition-colors hover:border-neutral-400 dark:border-neutral-700 dark:text-neutral-400"
                >
                  {rsOpen ? '收起' : '读全文'}
                </button>
              ) : null}
              <button
                onClick={() => void saveResearch()}
                disabled={rsBusy || !!rsSaved}
                className="rounded-full border border-sky-300 px-2 py-0.5 text-xs text-sky-700 transition-colors hover:bg-sky-100 disabled:opacity-40 dark:border-sky-500/40 dark:text-sky-300 dark:hover:bg-sky-500/20"
              >
                {rsSaved ? '已存进知识库' : rsBusy ? '保存中…' : '存进知识库'}
              </button>
              <InjectedLine
                names={rsInjected}
                className="rounded-full border border-sky-200 px-2 py-0.5 text-xs text-sky-700 dark:border-sky-500/30 dark:text-sky-300"
              />
            </>
          }
          footer={
            rs ? (
              <FeedbackButtons
                kind="research"
                promptSha={rs.prompt_sha}
                modelId={rs.model_id}
                artifactRef={rsSaved}
                injected={rsInjected}
              />
            ) : undefined
          }
        >
          {/* 跑完了就收成一行回执：正文只活在 /notes 详情页，「读全文」能展开回来。
              draft 期间照旧边生成边看——那时候正文正是要看的。 */}
          {rs && !rsOpen ? (
            <ReceiptLine
              title={rs.title || '研究'}
              meta={`来源 ${rs.sources.length} 条 · 你的材料 ${
                rs.sources.filter((s) => s.kind === 'kb').length
              } 条`}
              saved={rsSaved}
            />
          ) : rs || rsDraft ? (
            <>
              <Markdown sources={rs?.sources}>{reportMarkdown(rs ?? rsDraft!)}</Markdown>
              {rs ? (
                <>
                  <SourceList
                    sources={rs.sources}
                    used={rs.used}
                    className="border-sky-200/70 dark:border-sky-500/20"
                    summary={
                      <>
                        来源 {rs.sources.length} 条（你自己的材料{' '}
                        {rs.sources.filter((s) => s.kind === 'kb').length} 条）
                      </>
                    }
                  />
                  {rsSaved ? (
                    <p className="mt-1.5 text-xs text-emerald-600 dark:text-emerald-400">
                      已存到 {rsSaved}，已进索引——下次相关话题的取材会先捞到它
                    </p>
                  ) : null}
                </>
              ) : null}
            </>
          ) : null}
        </RunPanel>
      ) : null}
      {/* 方案卡：先摆「我理解你要决定的是什么」再出正文——读错题是这类功能
          第一位的失败模式，题面必须在成文之前就看得见。同样是这一场会话的
          动作，不落右栏、不计数。 */}
      {dc || dcFrame || dcDraft || dcBusy || dcMsg ? (
        <RunPanel
          phase={dc ? 'done' : dcDraft ? 'streaming' : dcBusy ? 'progress' : 'error'}
          tone="violet"
          icon="🤔"
          title="方案"
          status={dc || dcDraft ? undefined : dcMsg || undefined}
          error={!dc && !dcDraft && !dcBusy && dcMsg ? dcMsg : undefined}
          onCancel={() => dcAbortRef.current?.abort()}
          actions={
            <>
              {dc ? (
                <button
                  onClick={() => setDcOpen((v) => !v)}
                  className="rounded-full border border-neutral-300 px-2 py-0.5 text-xs text-neutral-500 transition-colors hover:border-neutral-400 dark:border-neutral-700 dark:text-neutral-400"
                >
                  {dcOpen ? '收起' : '读全文'}
                </button>
              ) : null}
              {dc ? (
                <button
                  onClick={() => void saveDecide()}
                  disabled={dcBusy || !!dcSaved}
                  className="rounded-full wb-btn-ghost px-2 py-0.5 text-xs"
                >
                  {dcSaved ? '已存进知识库' : dcBusy ? '保存中…' : '存进知识库'}
                </button>
              ) : null}
              <InjectedLine
                names={dcInjected}
                className="rounded-full border border-violet-200 px-2 py-0.5 text-xs text-violet-700 dark:border-violet-500/30 dark:text-violet-300"
              />
            </>
          }
          footer={
            dc ? (
              <FeedbackButtons
                kind="decide"
                promptSha={dc.prompt_sha}
                modelId={dc.model_id}
                artifactRef={dcSaved}
                injected={dcInjected}
              />
            ) : undefined
          }
        >
          {dc && !dcOpen ? (
            <>
              {dcFrame ? (
                <p className="mb-1.5 text-xs text-neutral-500">要决定的是：{dcFrame.decision}</p>
              ) : null}
              <ReceiptLine
                title={dc.title || '方案'}
                meta={`来源 ${dc.sources.length} 条 · 你的材料 ${
                  dc.sources.filter((s) => s.kind === 'kb').length
                } 条 · 记忆 ${dc.sources.filter((s) => s.kind === 'memory').length} 条`}
                saved={dcSaved}
              />
            </>
          ) : (
            <>
              {dcFrame ? (
            <div className="mb-2 rounded-lg border border-violet-200/70 bg-white/70 p-2.5 dark:border-violet-500/20 dark:bg-neutral-900/40">
              <p className="text-xs text-neutral-500">我理解你要决定的是</p>
              <p className="text-sm font-medium text-neutral-800 dark:text-neutral-100">
                {dcFrame.decision}
              </p>
              {dcFrame.options.length > 0 ? (
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {dcFrame.options.map((o) => (
                    <span
                      key={o}
                      className="rounded-full bg-violet-100 px-2 py-0.5 text-xs text-violet-700 dark:bg-violet-500/20 dark:text-violet-300"
                    >
                      {o}
                    </span>
                  ))}
                </div>
              ) : null}
              {dcFrame.criteria.length > 0 ? (
                <p className="mt-1.5 text-xs text-neutral-500">
                  会比：{dcFrame.criteria.join(' · ')}
                </p>
              ) : null}
            </div>
          ) : null}

          {dc || dcDraft ? (
            <Markdown sources={dc?.sources}>{reportMarkdown(dc ?? dcDraft!)}</Markdown>
          ) : null}
          {dc ? (
            <>
              <SourceList
                sources={dc.sources}
                used={dc.used}
                className="border-violet-200/70 dark:border-violet-500/20"
                summary={
                  <>
                    来源 {dc.sources.length} 条（你的材料{' '}
                    {dc.sources.filter((s) => s.kind === 'kb').length} 条 · 记忆{' '}
                    {dc.sources.filter((s) => s.kind === 'memory').length} 条）
                  </>
                }
              />
              {dcSaved ? (
                <p className="mt-1.5 text-xs text-emerald-600 dark:text-emerald-400">
                  已存到 {dcSaved}，已进索引——下次相关话题的取材会先捞到它
                </p>
              ) : null}
            </>
          ) : null}
            </>
          )}
        </RunPanel>
      ) : null}
      {/* 对质卡：先摆「这次比的是什么」，再出正文。零冲突时它直接给一句实话
          （标题就写着「没有对不上的」），那是正常结果不是失败。同一场会话的
          动作，不落右栏、不计数。 */}
      {cf || cfSubject || cfDraft || cfBusy || cfMsg ? (
        <RunPanel
          phase={cf ? 'done' : cfDraft ? 'streaming' : cfBusy ? 'progress' : 'error'}
          tone="teal"
          icon="⚔️"
          title="对质"
          status={cf || cfDraft ? undefined : cfMsg || undefined}
          error={!cf && !cfDraft && !cfBusy && cfMsg ? cfMsg : undefined}
          onCancel={() => cfAbortRef.current?.abort()}
          actions={
            <>
              {cf ? (
                <button
                  onClick={() => setCfOpen((v) => !v)}
                  className="rounded-full border border-neutral-300 px-2 py-0.5 text-xs text-neutral-500 transition-colors hover:border-neutral-400 dark:border-neutral-700 dark:text-neutral-400"
                >
                  {cfOpen ? '收起' : '读全文'}
                </button>
              ) : null}
              {cf ? (
                <button
                  onClick={() => void saveConflict()}
                  disabled={cfBusy || !!cfSaved}
                  className="rounded-full border border-teal-300 px-2 py-0.5 text-xs text-teal-700 transition-colors hover:bg-teal-100 disabled:opacity-40 dark:border-teal-500/40 dark:text-teal-300 dark:hover:bg-teal-500/20"
                >
                  {cfSaved ? '已存进知识库' : cfBusy ? '保存中…' : '存进知识库'}
                </button>
              ) : null}
              <InjectedLine
                names={cfInjected}
                className="rounded-full border border-teal-200 px-2 py-0.5 text-xs text-teal-700 dark:border-teal-500/30 dark:text-teal-300"
              />
            </>
          }
          footer={
            cf ? (
              <FeedbackButtons
                kind="conflict"
                promptSha={cf.prompt_sha}
                modelId={cf.model_id}
                artifactRef={cfSaved}
                injected={cfInjected}
              />
            ) : undefined
          }
        >
          {cf && !cfOpen ? (
            <>
              {cfSubject ? (
                <p className="mb-1.5 text-xs text-neutral-500">比的是：{cfSubject}</p>
              ) : null}
              <ReceiptLine
                title={cf.title || '对质'}
                meta={`来源 ${cf.sources.length} 条 · 你的材料 ${
                  cf.sources.filter((s) => s.kind === 'kb').length
                } 条 · 记忆 ${cf.sources.filter((s) => s.kind === 'memory').length} 条`}
                saved={cfSaved}
              />
            </>
          ) : (
            <>
              {cfSubject ? (
            <div className="mb-2 rounded-lg border border-teal-200/70 bg-white/70 p-2.5 dark:border-teal-500/20 dark:bg-neutral-900/40">
              <p className="text-xs text-neutral-500">这次比的是</p>
              <p className="text-sm font-medium text-neutral-800 dark:text-neutral-100">
                {cfSubject}
              </p>
              {cf && cf.pairs && cf.pairs.length > 0 ? (
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {cf.pairs.map((p) => (
                    <span
                      key={`${p.a_n}-${p.b_n}`}
                      title={p.basis}
                      className="rounded-full bg-teal-100 px-2 py-0.5 text-xs text-teal-700 dark:bg-teal-500/20 dark:text-teal-300"
                    >
                      [{p.a_n}] × [{p.b_n}]
                    </span>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}

          {cf || cfDraft ? (
            <Markdown sources={cf?.sources}>{reportMarkdown(cf ?? cfDraft!)}</Markdown>
          ) : null}
          {cf ? (
            <>
              <SourceList
                sources={cf.sources}
                used={cf.used}
                className="border-teal-200/70 dark:border-teal-500/20"
                summary={
                  <>
                    来源 {cf.sources.length} 条（你的材料{' '}
                    {cf.sources.filter((s) => s.kind === 'kb').length} 条 · 记忆{' '}
                    {cf.sources.filter((s) => s.kind === 'memory').length} 条）
                  </>
                }
              />
              {cfSaved ? (
                <p className="mt-1.5 text-xs text-emerald-600 dark:text-emerald-400">
                  已存到 {cfSaved}，已进索引——下次相关话题的取材会先捞到它
                </p>
              ) : null}
            </>
          ) : null}
            </>
          )}
        </RunPanel>
      ) : null}

      {/* 材料消化卡：一份材料 → 要搞懂的点 → 逐点去搞懂。「逐点」走的是普通教学会话，
          所以点一下就从这张卡切换进会话视图，不需要另一套机制。 */}
      {dgOpen || dg || dgBusy || dgMsg ? (
        <div className="rounded-md border border-teal-200 bg-teal-50/60 p-4 dark:border-teal-500/30 dark:bg-teal-500/10">
          <div className="flex items-center justify-between gap-2 pb-2">
            <p className="text-xs font-medium uppercase tracking-wider text-teal-700 dark:text-teal-300">
              🎒 材料消化
            </p>
            <button
              onClick={closeDigest}
              className="rounded-full border border-teal-300 px-2 py-0.5 text-xs text-teal-700 transition-colors hover:bg-teal-100 dark:border-teal-500/40 dark:text-teal-300 dark:hover:bg-teal-500/20"
            >
              收起
            </button>
          </div>

          <div className="mb-2 flex gap-1 text-xs">
            {(['file', 'text'] as const).map((m) => (
              <button
                key={m}
                onClick={() => setDgMode(m)}
                className={`rounded-full border px-2.5 py-1 transition-colors ${
                  dgMode === m
                    ? 'border-teal-500 bg-teal-500/10 font-medium text-teal-700 dark:text-teal-300'
                    : 'border-neutral-300 text-neutral-500 hover:border-teal-300 dark:border-neutral-700'
                }`}
              >
                {m === 'file' ? '📄 选一份材料' : '✍️ 粘一段'}
              </button>
            ))}
          </div>

          {dgMode === 'file' ? (
            <div className="space-y-1">
              <input
                value={dgQuery}
                onChange={(e) => setDgQuery(e.target.value)}
                placeholder="筛选文件名…"
                className="w-full rounded-lg border border-neutral-300 bg-white px-2.5 py-1.5 text-sm outline-none focus:border-teal-400 dark:border-neutral-700 dark:bg-neutral-900"
              />
              <select
                value={dgSource}
                onChange={(e) => setDgSource(e.target.value)}
                size={6}
                className="w-full rounded-lg border border-neutral-300 bg-white px-2 py-1 text-sm outline-none focus:border-teal-400 dark:border-neutral-700 dark:bg-neutral-900"
              >
                {(
                  [
                    ['vault 笔记', dgSources?.vault],
                    ['代码仓库', dgSources?.repos],
                    ['本地目录', dgSources?.dirs],
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
              value={dgText}
              onChange={(e) => setDgText(e.target.value)}
              rows={5}
              placeholder="把材料粘进来…"
              className="w-full rounded-lg border border-neutral-300 bg-white px-2.5 py-1.5 text-sm outline-none focus:border-teal-400 dark:border-neutral-700 dark:bg-neutral-900"
            />
          )}

          <div className="mt-2 flex items-center gap-2">
            <button
              onClick={() => void runDigest()}
              disabled={dgBusy || (dgMode === 'text' ? !dgText.trim() : !dgSource)}
              className="shrink-0 rounded-lg bg-gradient-to-r from-teal-600 to-emerald-600 px-3 py-1.5 text-sm font-medium text-white transition-all hover:brightness-110 disabled:opacity-40"
            >
              {dgBusy ? '拆点中…' : '拆成要搞懂的点'}
            </button>
            {dg?.source_label ? (
              <span className="min-w-0 truncate text-xs text-neutral-500">{dg.source_label}</span>
            ) : null}
          </div>

          {dgMsg ? <p className="pt-2 text-xs text-rose-600 dark:text-rose-400">{dgMsg}</p> : null}

          {pcNotice ? (
            <p className="pt-2 text-xs text-teal-700 dark:text-teal-400">{pcNotice}</p>
          ) : null}

          {dg && dg.points.length > 0 ? (
            <ol className="mt-3 space-y-1.5 border-t border-teal-200/70 pt-2 dark:border-teal-500/20">
              {dg.points.map((p, i) => (
                <li key={`${i}-${p.title}`}>
                  <div className="flex items-stretch gap-1">
                    <button
                      onClick={() => void beginWith(p.title, '', 'socratic', p.id)}
                      disabled={busy}
                      title="开一场教学，专门搞懂这个点"
                      className="block min-w-0 flex-1 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-white/70 disabled:opacity-40 dark:hover:bg-neutral-900/40"
                    >
                      <span className="block text-sm text-neutral-700 dark:text-neutral-200">{p.title}</span>
                      {p.why ? <span className="block text-xs text-neutral-400">{p.why}</span> : null}
                    </button>
                    {/* 「按点出卡」：卡面只覆盖这一点，不离开学页 */}
                    <button
                      onClick={() => void makePointCards(p)}
                      disabled={busy || pc?.busy}
                      title="只围绕这一点出几张卡，不离开学页"
                      className="shrink-0 rounded-lg border border-neutral-200 px-2 text-xs text-neutral-500 transition-colors hover:border-teal-400 hover:text-teal-600 disabled:opacity-40 dark:border-neutral-700 dark:hover:border-teal-500 dark:hover:text-teal-300"
                    >
                      {pc?.busy && pc.pointId === p.id ? '…' : '🃏'}
                    </button>
                  </div>
                  {pc?.pointId === p.id ? (
                    <div className="ml-2 mt-1 rounded-lg border border-teal-200/70 p-2 dark:border-teal-500/20">
                      {pc.busy ? (
                        <p className="text-xs text-neutral-400">出卡中…</p>
                      ) : pc.drafts.length > 0 ? (
                        <>
                          {pc.drafts.map((d, j) => (
                            <label key={j} className="flex cursor-pointer gap-1.5 py-1">
                              <input
                                type="checkbox"
                                checked={pc.picked.has(j)}
                                onChange={() =>
                                  setPc((c) => {
                                    if (!c) return c
                                    const next = new Set(c.picked)
                                    if (next.has(j)) next.delete(j)
                                    else next.add(j)
                                    return { ...c, picked: next, msg: '' }
                                  })
                                }
                                className="mt-0.5 shrink-0"
                              />
                              <span className="min-w-0">
                                <span className="block text-xs text-neutral-700 dark:text-neutral-200">
                                  {d.front}
                                </span>
                                <span className="block text-xs text-neutral-500 dark:text-neutral-400">
                                  {d.back}
                                </span>
                                {d.duplicate_of ? (
                                  <span className="block text-xs text-amber-600 dark:text-amber-400">
                                    可能的重复
                                  </span>
                                ) : null}
                              </span>
                            </label>
                          ))}
                          <div className="mt-1 flex items-center gap-2">
                            <button
                              onClick={() => void savePointCards()}
                              className="rounded-full border border-teal-300 px-2 py-0.5 text-xs text-teal-700 transition-colors hover:bg-teal-50 dark:border-teal-600 dark:text-teal-300 dark:hover:bg-teal-950/40"
                            >
                              入库选中的
                            </button>
                            <button
                              onClick={() => setPc(null)}
                              className="text-xs text-neutral-400 transition-colors hover:text-neutral-600 dark:hover:text-neutral-300"
                            >
                              收起
                            </button>
                          </div>
                        </>
                      ) : null}
                      {pc.msg ? (
                        <p className="mt-1 text-xs text-rose-600 dark:text-rose-400">{pc.msg}</p>
                      ) : null}
                    </div>
                  ) : null}
                </li>
              ))}
            </ol>
          ) : null}
        </div>
      ) : null}
    </>
  )
}
