// 学习记录三面板（方向 6 第七刀，2026-09-29 自 TutorPage 拆出）：
// 概念轨（railPanel）、学习概览（conceptsPanel）、会话历史（historyList）。
// 状态与处理器住在 TutorPage 本体；组件收单个 bundle prop `r`，内部只解构自己用的字段。
// conceptRow/mapGroup/openConceptRow 只服务于学习概览，成了它的组件内函数；
// mapCounts 随迁；mapCount 留在主文件（记录标签页还要用它判空）。
import { Link } from 'react-router-dom'
import AttachToThread from './AttachToThread'
import {
  api,
  type RoundtableResult,
  type TutorConceptRow,
  type TutorLearningMap,
  type TutorNeighbor,
  type TutorSessionRow,
  type TutorStats,
} from './api'
import { CONCEPT_STATE, CONCEPT_STATES, type ConceptState } from './conceptState'
import { CONCEPT_RAIL_CAP, ConceptMerge, RepeatChip, VERDICT_LABEL } from './tutorShared'
import type { Dispatch, SetStateAction } from 'react'

export interface TutorRecords {
  allConcepts: string[]
  beginWith: (topicText: string, repo?: string, m?: 'socratic' | 'feynman' | 'future' | 'interview', originPointId?: number, prereqCardId?: number) => Promise<void>
  busy: boolean
  doMerge: (source: string, into: string) => Promise<void>
  learnMap: TutorLearningMap | null
  makeRtPodcast: () => Promise<void>
  makeStuckPodcast: () => Promise<void>
  mapCount: number
  mapFilter: ConceptState | null
  mergeBusy: boolean
  mergeMsg: string
  neighbors: Record<string, TutorNeighbor[]>
  open: (id: number) => Promise<void>
  openConcept: string | null
  repeatMap: Map<string, TutorConceptRow>
  resolveStuck: (sessionId: number, resolved: boolean) => Promise<void>
  rows: TutorSessionRow[]
  rt: RoundtableResult | null
  rtAudio: string
  rtBusy: boolean
  rtMsg: string
  runRoundtable: () => Promise<void>
  setMapFilter: Dispatch<SetStateAction<ConceptState | null>>
  setNeighbors: Dispatch<SetStateAction<Record<string, TutorNeighbor[]>>>
  setOpenConcept: Dispatch<SetStateAction<string | null>>
  sid: number | null
  stats: TutorStats | null
  stuckAudio: string
  stuckBusy: boolean
  stuckMsg: string
}

export function TutorConceptsPanel({ r }: { r: TutorRecords }) {
  const { allConcepts, beginWith, busy, doMerge, learnMap, makeRtPodcast, makeStuckPodcast, mapCount, mapFilter, mergeBusy, mergeMsg, neighbors, open, openConcept, repeatMap, resolveStuck, rows, rt, rtAudio, rtBusy, rtMsg, runRoundtable, setMapFilter, setNeighbors, setOpenConcept, stuckAudio, stuckBusy, stuckMsg } = r
  const mapCounts: Record<ConceptState, number> = {
    mastered: learnMap?.mastered.length ?? 0,
    learning: learnMap?.learning.length ?? 0,
    stuck: learnMap?.stuck.length ?? 0,
    untouched: learnMap?.untouched.length ?? 0,
  }
  function openConceptRow(concept: string) {
  const next = openConcept === concept ? null : concept
  setOpenConcept(next)
  if (next && neighbors[concept] === undefined) {
    void api
      .tutorNeighbors(concept)
      .then((r) => setNeighbors((m) => ({ ...m, [concept]: r.neighbors })))
      .catch(() => {})
  }
  }
  function conceptRow(c: TutorConceptRow) {
  const evo = rows.filter((r) => r.concept === c.concept)
  const expanded = openConcept === c.concept
  const nebs = neighbors[c.concept]
  return (
            <div key={c.concept} className="group/c relative">
              <button
                data-concept-row={c.concept}
                onClick={() => openConceptRow(c.concept)}
                title={expanded ? '收起' : '展开这个概念的历次记录'}
                className="block w-full rounded-lg py-1.5 pr-5 text-left transition-colors hover:bg-neutral-100 dark:hover:bg-neutral-800/70"
              >
                <span className="flex items-baseline gap-1.5">
                  <span className="min-w-0 flex-1 truncate text-xs text-neutral-700 dark:text-neutral-200">
                    {c.concept}
                  </span>
                  <RepeatChip c={repeatMap.get(c.concept) ?? null} />
                  <span
                    className={`shrink-0 text-xs ${
                      c.verdict === 'got'
                        ? 'text-emerald-600 dark:text-emerald-400'
                        : 'text-amber-600 dark:text-amber-400'
                    }`}
                  >
                    {c.verdict === 'got' ? '搞懂了' : '半懂'}
                  </span>
                  <span className="shrink-0 text-xs text-neutral-400">
                    {(c.last_at || '').slice(5, 10)}
                  </span>
                </span>
                {c.stuck ? (
                  <span className="block truncate text-xs text-neutral-400">
                    <span
                      className={
                        c.stuck_resolved
                          ? 'text-emerald-600 dark:text-emerald-400'
                          : 'text-amber-600 dark:text-amber-400'
                      }
                    >
                      {c.stuck_resolved ? '已解' : '待解'}
                    </span>{' '}
                    ↳ {c.stuck}
                  </span>
                ) : null}
                <span className="block truncate text-xs text-neutral-400">
                  {c.sessions} 场{c.recalled > 0 ? ` · 接上过 ${c.recalled} 次` : ''}
                </span>
              </button>
              {/* PLAN2 T1 场景 B：卡片轨的现状就在这一行里——**在概念按钮外面**，
                  因为按钮点的是「展开历次记录」，这一行点的是「去看这些卡」，两件事。
                  没有卡的概念后端连这个键都不带（只摆非零），这里也就不显示。 */}
              {c.cards_summary ? (
                <Link
                  data-concept-cards={c.concept}
                  to={`/review?${c.cards_summary.topics
                    .map((t) => `topic=${encodeURIComponent(t)}`)
                    .join('&')}`}
                  title="去复习页看这个概念名下的卡"
                  className="block truncate pb-1 pr-5 text-xs text-sky-600 hover:underline dark:text-sky-400/90"
                >
                  {c.cards_summary.n} 张卡 · {c.cards_summary.mature} 成熟 · 近 7 天重来{' '}
                  {c.cards_summary.again_7d} 次
                </Link>
              ) : null}
              {/* 卡点的出口主要是自动回写（同一概念后来说通了），这里是手动兜底：
                  「我不打算再管这个了」。悬停才现身，免得右栏每行都挂个按钮。 */}
              {c.stuck ? (
                <button
                  onClick={() => void resolveStuck(c.last_session_id, !c.stuck_resolved)}
                  title={c.stuck_resolved ? '标回待解' : '这条卡点不用管了'}
                  className="absolute right-0 top-1.5 text-xs text-neutral-300 opacity-0 transition-opacity hover:text-violet-600 focus:opacity-100 group-hover/c:opacity-100 dark:text-neutral-600 dark:hover:text-violet-300"
                >
                  {c.stuck_resolved ? '↺' : '✓'}
                </button>
              ) : null}
              {expanded ? (
                <div className="mb-1 ml-2 border-l border-neutral-200 pl-2 dark:border-neutral-700">
                  {/* 把这条概念挂到某件事上——念头是看到它的时候冒出来的，所以就在这里 */}
                  <AttachToThread
                    kind="session"
                    ref={String(c.last_session_id)}
                    className="block pb-1"
                  />
                  {evo.length > 0 ? (
                    evo.map((r) => (
                      <button
                        key={r.id}
                        onClick={() => void open(r.id)}
                        className="block w-full rounded py-1 text-left text-xs text-neutral-500 transition-colors hover:text-violet-600 dark:text-neutral-400 dark:hover:text-violet-300"
                      >
                        {(r.created_at || '').slice(5, 10)} · {VERDICT_LABEL[r.verdict] || '没标'}
                        {r.stuck ? <span className="text-neutral-400"> · {r.stuck}</span> : null}
                      </button>
                    ))
                  ) : (
                    <button
                      onClick={() => void open(c.last_session_id)}
                      className="block w-full rounded py-1 text-left text-xs text-neutral-500 transition-colors hover:text-violet-600 dark:text-neutral-400 dark:hover:text-violet-300"
                    >
                      打开最近一场
                    </button>
                  )}
                  {/* 「邻居」：同一件事 / 同一份材料 / 语义相近。是**观察**不是待办——
                      旁边还有谁，不催你看。第一次要算向量，先占一行说着。 */}
                  {nebs === undefined ? (
                    <div className="pt-1 text-xs text-neutral-300 dark:text-neutral-600">
                      看旁边还有谁…
                    </div>
                  ) : nebs.length > 0 ? (
                    <div className="pt-1">
                      <span className="text-xs text-neutral-400">旁边还有</span>
                      <span className="flex flex-wrap gap-1 pt-0.5">
                        {nebs.map((n) => (
                          <button
                            key={n.concept}
                            onClick={() => openConceptRow(n.concept)}
                            title={n.why || '语义相近'}
                            className="max-w-full truncate rounded bg-neutral-100 px-1.5 py-0.5 text-xs text-neutral-600 transition-colors hover:bg-violet-100 hover:text-violet-700 dark:bg-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-700"
                          >
                            {n.concept}
                          </button>
                        ))}
                      </span>
                    </div>
                  ) : null}

                  {/* 归一的人工出口（Q3.5）：机器并不了的那些由**人指认** —— 同一个领域的
                      相邻概念在向量空间里比某些该并的还近（尺子：backend/smoke_concept.py）。
                      放在展开了才看得见的地方：这是判断，不是每行都该挂的按钮。 */}
                  <ConceptMerge
                    concept={c.concept}
                    others={allConcepts}
                    busy={mergeBusy}
                    onMerge={doMerge}
                  />
                </div>
              ) : null}
            </div>
  )
  }
  function mapGroup(label: string, cls: string, items: TutorConceptRow[]) {
    return (
      items.length > 0 ? (
        <div key={label} className="pt-1.5">
          <p className={`px-1 pb-0.5 text-xs font-medium ${cls}`}>
            {label} <span className="text-neutral-400">{items.length}</span>
          </p>
          {items.slice(0, CONCEPT_RAIL_CAP).map(conceptRow)}
        </div>
      ) : null
    )
  }
  return (
    <>
      {/* 并概念的回执挂在这里而不是那一行：并完之后 source 那一行就没了。
          「机器自己换了个名字」如果界面上不说，就是一件看不见也查不到的事。 */}
      {mergeMsg ? (
        <p data-merge-msg className="px-3 pb-2 text-xs text-neutral-500">
          {mergeMsg}
        </p>
      ) : null}
      {learnMap && mapCount > 0 ? (
        <div className="px-3 pb-3">
          <div className="flex items-center justify-between pb-1.5">
            <p className="text-xs font-medium uppercase tracking-wider text-neutral-400">
              学到哪了
            </p>
            <div className="flex items-center gap-1">
              <button
                onClick={() => void runRoundtable()}
                disabled={rtBusy}
                title="开一场圆桌：三个 AI 视角（老师/同侪/考官）笔谈最近的卡点"
                className="rounded-full border border-neutral-200 px-2 py-0.5 text-xs text-neutral-500 transition-colors hover:border-sky-400 hover:text-sky-600 disabled:opacity-40 dark:border-neutral-700 dark:hover:border-sky-500 dark:hover:text-sky-300"
              >
                {rtBusy && !rt ? '讨论中…' : '👥 圆桌'}
              </button>
              <button
                onClick={() => void makeStuckPodcast()}
                disabled={stuckBusy}
                title="把最近的卡点做成一期双人讨论播客"
                className="rounded-full border border-neutral-200 px-2 py-0.5 text-xs text-neutral-500 transition-colors hover:border-violet-400 hover:text-violet-600 disabled:opacity-40 dark:border-neutral-700 dark:hover:border-violet-500 dark:hover:text-violet-300"
              >
                {stuckBusy ? '生成中…' : '🎧 做成播客'}
              </button>
            </div>
          </div>
          {/* 档位标签：点一个只看那一档，再点一次回到全部——地图先是概览，
              需要时才下钻。**词与色在 `conceptState.ts` 一份**（小屋的概念卡读同一份）。 */}
          <div className="flex flex-wrap gap-1.5 pb-2">
            {CONCEPT_STATES.map((s) => (
              <button
                key={s.key}
                onClick={() => setMapFilter(mapFilter === s.key ? null : s.key)}
                title={mapFilter === s.key ? '再点一下回到全部' : `只看${s.label}`}
                className={`rounded-full border px-2.5 py-0.5 text-xs transition-colors ${
                  mapFilter === s.key
                    ? `${s.chip} font-medium ring-2`
                    : 'border-neutral-200 text-neutral-500 hover:border-neutral-400 dark:border-neutral-700 dark:text-neutral-400 dark:hover:border-neutral-500'
                }`}
              >
                {s.label} {mapCounts[s.key]}
              </button>
            ))}
          </div>
          {(mapFilter === null || mapFilter === 'mastered')
            ? mapGroup(CONCEPT_STATE.mastered.label, CONCEPT_STATE.mastered.text, learnMap.mastered)
            : null}
          {(mapFilter === null || mapFilter === 'learning')
            ? mapGroup(CONCEPT_STATE.learning.label, CONCEPT_STATE.learning.text, learnMap.learning)
            : null}
          {(mapFilter === null || mapFilter === 'stuck')
            ? mapGroup(CONCEPT_STATE.stuck.label, CONCEPT_STATE.stuck.text, learnMap.stuck)
            : null}
          {(mapFilter === null || mapFilter === 'untouched') && learnMap.untouched.length > 0 ? (
            <div className="pt-1.5">
              <p className={`px-1 pb-0.5 text-xs font-medium ${CONCEPT_STATE.untouched.text}`}>
                {CONCEPT_STATE.untouched.label}{' '}
                <span className="text-neutral-400">{learnMap.untouched.length}</span>
              </p>
              {learnMap.untouched.slice(0, CONCEPT_RAIL_CAP).map((p) => (
                <button
                  key={p.id}
                  onClick={() => void beginWith(p.point, '', 'socratic', p.id)}
                  disabled={busy}
                  title="拆自材料、还没开教——点开就专门搞懂这个点"
                  className="block w-full rounded-lg py-1.5 pr-3 text-left transition-colors hover:bg-neutral-100 disabled:opacity-40 dark:hover:bg-neutral-800/70"
                >
                  <span className="block truncate text-xs text-neutral-700 dark:text-neutral-200">
                    {p.point}
                  </span>
                  {p.why ? (
                    <span className="block truncate text-xs text-neutral-400">{p.why}</span>
                  ) : null}
                </button>
              ))}
            </div>
          ) : null}
          {rt ? (
            <div className="mb-2 mt-2 rounded-lg border border-neutral-100 p-2 dark:border-neutral-800">
              <p className="truncate text-xs text-neutral-400">
                圆桌 · {rt.topic}
              </p>
              <ul className="mt-1 space-y-1.5">
                {rt.turns.map((t, i) => (
                  <li key={i} className="text-xs leading-relaxed text-neutral-600 dark:text-neutral-300">
                    <span className="font-medium text-neutral-800 dark:text-neutral-100">{t.name}</span>
                    ：{t.text}
                  </li>
                ))}
              </ul>
              <div className="mt-1.5 flex items-center gap-2">
                <button
                  onClick={() => void makeRtPodcast()}
                  disabled={rtBusy}
                  className="rounded-full border border-neutral-200 px-2 py-0.5 text-xs text-neutral-500 transition-colors hover:border-violet-400 hover:text-violet-600 disabled:opacity-40 dark:border-neutral-700 dark:hover:border-violet-500 dark:hover:text-violet-300"
                >
                  {rtBusy ? '生成中…' : '🎧 做成播客'}
                </button>
              </div>
              {rtMsg ? (
                <p className="mt-1 text-xs leading-relaxed text-neutral-500 dark:text-neutral-400">
                  {rtMsg}
                  {rtAudio && <audio controls src={rtAudio} className="mt-1.5 w-full" />}
                </p>
              ) : null}
            </div>
          ) : null}
          {stuckMsg ? (
            <p className="pb-1.5 pt-1 text-xs leading-relaxed text-neutral-500 dark:text-neutral-400">
              {stuckMsg}
              {stuckAudio && (
                <audio controls src={stuckAudio} className="mt-1.5 w-full" />
              )}
            </p>
          ) : null}
        </div>
      ) : null}
    </>
  )
}

export function TutorHistoryList({ r }: { r: TutorRecords }) {
  const { open, rows, sid } = r
  return (
    <div>
      {rows.length === 0 ? (
        <p className="px-1 py-2 text-xs text-neutral-400">还没有记录</p>
      ) : (
        <div className="space-y-0.5">
          {rows.map((r) => (
            <button
              key={r.id}
              onClick={() => void open(r.id)}
              className={`w-full rounded-lg px-3 py-2 text-left transition-colors ${
                r.id === sid
                  ? 'bg-violet-100 dark:bg-violet-500/15'
                  : 'hover:bg-neutral-100 dark:hover:bg-neutral-800/70'
              }`}
            >
              <span className="block truncate text-sm text-neutral-700 dark:text-neutral-200">
                {r.concept || r.topic}
              </span>
              <span className="block truncate text-xs text-neutral-400">
                {r.verdict ? VERDICT_LABEL[r.verdict] : '没标'}
                {r.recalled ? ' · 接上过' : ''}
                {r.stuck ? ` · ${r.stuck}` : ''}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export function TutorRailPanel({ r }: { r: TutorRecords }) {
  const { rows, stats } = r
  return (
    <>
    <div className="px-4 pb-2 pt-4">
    <p className="text-xs font-medium uppercase tracking-wider text-neutral-400">
      学过的
    </p>
    {stats && stats.sessions > 0 ? (
      <p className="pt-1 text-xs leading-relaxed text-neutral-500">
        近 {stats.days} 天 {stats.sessions} 次，{stats.got} 次说通了
        {stats.got_with_recall > 0 ? `，其中 ${stats.got_with_recall} 次接上了以前卡的点` : ''}
      </p>
    ) : null}
    </div>
    <div className="flex-1 overflow-y-auto px-2 pb-4">
    {/* 我学到哪了：按概念收敛后的当前状态（纯派生）。一个概念一行，点开看它的
        演进——同一概念历次自评与卡点。是记录，不是待办：不催、不排期。 */}
    <TutorConceptsPanel r={r} />
    {rows.length > 0 ? (
      <p className="px-3 pb-1 pt-1 text-xs font-medium uppercase tracking-wider text-neutral-400">
        会话历史
      </p>
    ) : null}
    <TutorHistoryList r={r} />
    </div>
    </>
  )
}
