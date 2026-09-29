// 「评估」页签：RAG 检索评估集 + 跑分 + 历史趋势（方向 6 第三刀自 KBPage 拆出）。
import { useCallback, useEffect, useRef, useState } from 'react'
import { ClipboardCheck, Play, TrendingUp } from 'lucide-react'
import { api, type EvalItem, type EvalRun } from './api'
import EmptyHint from './EmptyHint'
import RunPanel from './RunPanel'
import { box, hitColor, pct, type KbCounts } from './kbShared'

interface Props {
  /** 页签是否处于激活态——只在激活时拉数据（原实现是父组件里的 if (tab === 'eval') refreshEval()） */
  active: boolean
  onCounts: (patch: Partial<KbCounts>) => void
}

export default function KbEvalTab({ active, onCounts }: Props) {
  const [evalItems, setEvalItems] = useState<EvalItem[]>([])
  const [runs, setRuns] = useState<EvalRun[]>([])
  const [draft, setDraft] = useState({ question: '', expected_source: '', note: '' })
  const [editId, setEditId] = useState<number | null>(null)
  const [evalTopK, setEvalTopK] = useState('')
  const [judge, setJudge] = useState(true)
  const [running, setRunning] = useState(false)
  const [evalMsg, setEvalMsg] = useState('')
  const [evalStopping, setEvalStopping] = useState(false)
  const evalAbort = useRef<AbortController | null>(null)
  const [openRun, setOpenRun] = useState<EvalRun | null>(null)
  // 「期望命中文件」的候选列表。原来蹭的是 index 页签那份 /api/kb/files；
  // 拆开后自己取一份，激活时刷新——省掉页签间隐藏的数据依赖。
  const [vaultFiles, setVaultFiles] = useState<{ path: string }[] | null>(null)

  const refreshEval = useCallback(async () => {
    const [i, r] = await Promise.all([api.listEvalItems(), api.listEvalRuns()])
    setEvalItems(i)
    setRuns(r)
    onCounts({ eval: i.length })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!active) return
    refreshEval()
    let on = true
    fetch('/api/kb/files')
      .then((r) => r.json())
      .then((f) => {
        if (on) setVaultFiles(f.files)
      })
    return () => {
      on = false
    }
  }, [active, refreshEval])

  async function saveEvalItem() {
    if (!draft.question.trim()) return
    try {
      if (editId) await api.updateEvalItem(editId, draft)
      else await api.createEvalItem(draft)
      setDraft({ question: '', expected_source: '', note: '' })
      setEditId(null)
      setEvalMsg('')
      await refreshEval()
    } catch (e) {
      setEvalMsg(`❌ ${String(e)}`)
    }
  }

  async function removeEvalItem(id: number) {
    if (!window.confirm('删除这条评估问题？')) return
    await api.deleteEvalItem(id)
    if (editId === id) {
      setEditId(null)
      setDraft({ question: '', expected_source: '', note: '' })
    }
    await refreshEval()
  }

  async function runEvalNow() {
    setRunning(true)
    setEvalStopping(false)
    const controller = new AbortController()
    evalAbort.current = controller
    setEvalMsg('评估中…（每题一次检索' + (judge ? ' + 两次模型调用' : '') + '，请稍候）')
    try {
      const r = await api.runEval(evalTopK ? Number(evalTopK) : null, judge, controller.signal)
      setEvalMsg(
        (r.stopped ? '⚠️ 已按「停止」提前收工（跳过的用例不计入指标）：' : '✓ 第 ' + r.id + ' 次评估：') +
          `Hit@1 ${pct(r.hit1)} · Hit@3 ${pct(r.hit3)} · MRR ${r.mrr}` +
          (r.faithfulness !== null ? ` · 忠实度 ${r.faithfulness}/5` : '（未判分）') +
          ` · ${r.seconds}s`
      )
      setOpenRun(r)
      await refreshEval()
    } catch (e) {
      setEvalMsg(`❌ ${String(e)}`)
    } finally {
      if (evalAbort.current === controller) evalAbort.current = null
      setRunning(false)
      setEvalStopping(false)
    }
  }

  async function toggleRunDetail(run: EvalRun) {
    if (openRun?.id === run.id) {
      setOpenRun(null)
      return
    }
    setOpenRun(await api.getEvalRun(run.id))
  }

  async function removeRun(id: number) {
    await api.deleteEvalRun(id)
    if (openRun?.id === id) setOpenRun(null)
    await refreshEval()
  }

  return (
    <>
      <section className="wb-card-hero mb-6 rounded-lg p-5">
        <div className="flex flex-wrap items-center gap-x-8 gap-y-3">
          <div className="flex items-end gap-6">
            <div>
              <p className="text-2xl font-bold text-neutral-800 dark:text-neutral-100">{evalItems.length}</p>
              <p className="mt-0.5 text-xs text-neutral-500">评估集题目</p>
            </div>
            <div>
              <p className="text-2xl font-bold text-neutral-800 dark:text-neutral-100">{runs.length}</p>
              <p className="mt-0.5 text-xs text-neutral-500">评估次数</p>
            </div>
            {runs.length > 0 && (
              <div>
                <p className={`text-2xl font-bold ${hitColor(runs[0].hit1)}`}>{pct(runs[0].hit1)}</p>
                <p className="mt-0.5 text-xs text-neutral-500">最近 Hit@1</p>
              </div>
            )}
          </div>
          <span className="ml-auto text-xs text-neutral-400">改了 top_k / rerank 后重跑即可对比效果</span>
        </div>
      </section>

      {/* Eval set */}
      <section className="mb-6 wb-card p-5">
        <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold text-neutral-700 dark:text-neutral-200">
          <span><ClipboardCheck className="h-4 w-4" /></span> 评估集
          <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-xs font-normal text-neutral-500 dark:bg-neutral-800">
            {evalItems.length} 题
          </span>
        </h2>
        <p className="mb-3 text-xs leading-relaxed text-neutral-400">
          每题写一个问题 + 期望检索到的文件，跑一次就能量化 Hit@k / MRR；开启判分再让模型给回答忠实度打 0-5 分。改了 rerank / top_k 后重跑即可对比。
        </p>
        {evalItems.length > 0 && (
          <ul className="mb-3 flex flex-col divide-y divide-neutral-200 dark:divide-neutral-800">
            {evalItems.map((it) => (
              <li key={it.id} className="flex items-start justify-between gap-3 py-2 text-sm">
                <div className="min-w-0">
                  <p className="truncate">{it.question}</p>
                  <p className="mt-0.5 truncate text-xs text-neutral-400">
                    期望 <code className="text-neutral-500">{it.expected_source || '（未标注）'}</code>
                    {it.note && ` · ${it.note}`}
                  </p>
                </div>
                <span className="flex shrink-0 gap-2 text-xs">
                  <button
                    onClick={() => {
                      setEditId(it.id)
                      setDraft({ question: it.question, expected_source: it.expected_source, note: it.note })
                    }}
                    className="text-neutral-500 hover:underline"
                  >
                    编辑
                  </button>
                  <button onClick={() => removeEvalItem(it.id)} className="text-red-500 hover:underline">
                    删除
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}
        <div className="flex flex-col gap-2 rounded-md border border-neutral-200 p-3 dark:border-neutral-800">
          <p className="text-xs font-medium text-neutral-500">
            {editId ? '编辑第 ' + editId + ' 题' : '新增问题'}
          </p>
          <input
            value={draft.question}
            onChange={(e) => setDraft({ ...draft, question: e.target.value })}
            placeholder="问题，例如：RAG 的检索流程分哪几步？"
            className={box}
          />
          <div className="grid grid-cols-2 gap-2">
            <input
              value={draft.expected_source}
              onChange={(e) => setDraft({ ...draft, expected_source: e.target.value })}
              placeholder="期望命中文件（可填文件名）"
              list="vault-files"
              className={box}
            />
            <input
              value={draft.note}
              onChange={(e) => setDraft({ ...draft, note: e.target.value })}
              placeholder="备注（可选）"
              className={box}
            />
          </div>
          <datalist id="vault-files">
            {(vaultFiles ?? []).map((f) => (
              <option key={f.path} value={f.path} />
            ))}
          </datalist>
          <div className="flex gap-2">
            <button
              onClick={saveEvalItem}
              disabled={!draft.question.trim()}
              className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40 dark:bg-neutral-100 dark:text-neutral-900"
            >
              {editId ? '保存修改' : '添加'}
            </button>
            {editId && (
              <button
                onClick={() => {
                  setEditId(null)
                  setDraft({ question: '', expected_source: '', note: '' })
                }}
                className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm dark:border-neutral-700"
              >
                取消
              </button>
            )}
          </div>
        </div>
      </section>

      {/* Run */}
      <section className="mb-6 wb-card p-5">
        <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-neutral-700 dark:text-neutral-200">
          <span><Play className="h-4 w-4" /></span> 运行评估
        </h2>
        <div className="flex flex-wrap items-center gap-3">
          <button
            onClick={runEvalNow}
            disabled={running || !evalItems.length}
            className="rounded-md bg-gradient-to-r from-violet-600 to-fuchsia-600 px-3 py-1.5 text-sm font-medium text-white transition-all hover:brightness-110 disabled:from-neutral-200 disabled:to-neutral-200 disabled:text-neutral-400 dark:disabled:from-neutral-800 dark:disabled:to-neutral-800"
          >
            {running ? '评估中…' : '运行评估'}
          </button>
          <label className="flex items-center gap-1.5 text-sm text-neutral-600 dark:text-neutral-300">
            top_k
            <input
              value={evalTopK}
              onChange={(e) => setEvalTopK(e.target.value.replace(/\D/g, ''))}
              placeholder="默认"
              className={`${box} w-16`}
            />
          </label>
          <label className="flex items-center gap-1.5 text-sm text-neutral-600 dark:text-neutral-300">
            <input type="checkbox" checked={judge} onChange={(e) => setJudge(e.target.checked)} />
            用模型判忠实度（每题多 2 次调用）
          </label>
        </div>
        {running ? (
          <RunPanel
            phase="planning"
            tone="violet"
            icon="📊"
            title="运行评估"
            status={
              evalStopping
                ? '正在停…（已开跑的那条跑完，没轮到的跳过）'
                : evalMsg || undefined
            }
            onCancel={() => {
              void api.cancelEvalRun().then((r) => {
                if (r.stopped) setEvalStopping(true)
              })
            }}
          />
        ) : (
          evalMsg && (
            <p className="mt-2 whitespace-pre-wrap text-xs text-neutral-500">{evalMsg}</p>
          )
        )}
      </section>

      {/* History */}
      <section className="wb-card p-5">
        <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-neutral-700 dark:text-neutral-200">
          <span><TrendingUp className="h-4 w-4" /></span> 分数趋势
          <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-xs font-normal text-neutral-500 dark:bg-neutral-800">
            最近 {runs.length} 次
          </span>
        </h2>
        {!runs.length && (
          <EmptyHint
            pad="sm"
            title="还没有评估记录。"
            hint="先添加问题再运行评估。"
          />
        )}
        {runs.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs text-neutral-400">
                <tr>
                  <th className="py-1 pr-3 font-normal">时间</th>
                  <th className="py-1 pr-3 font-normal">配置</th>
                  <th className="py-1 pr-3 font-normal">Hit@1</th>
                  <th className="py-1 pr-3 font-normal">Hit@3</th>
                  <th className="py-1 pr-3 font-normal">Hit@k</th>
                  <th className="py-1 pr-3 font-normal">MRR</th>
                  <th className="py-1 pr-3 font-normal">忠实度</th>
                  <th className="py-1 font-normal"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-200 dark:divide-neutral-800">
                {runs.map((r) => (
                  <tr key={r.id} className={openRun?.id === r.id ? 'bg-neutral-50 dark:bg-neutral-900/60' : ''}>
                    <td className="py-1.5 pr-3 text-xs text-neutral-500">
                      {(r.created_at ?? '').slice(5, 16).replace('T', ' ')}
                    </td>
                    <td className="py-1.5 pr-3 text-xs text-neutral-500">
                      k={r.top_k}
                      {r.hybrid ? ' · 混合' : ' · 纯向量'}
                      {r.rerank ? ' · 精排' : ''}
                    </td>
                    <td className="py-1.5 pr-3">
                      <span className={`inline-block rounded px-1.5 py-0.5 text-xs font-medium ${hitColor(r.hit1)}`}>{pct(r.hit1)}</span>
                    </td>
                    <td className="py-1.5 pr-3">
                      <span className={`inline-block rounded px-1.5 py-0.5 text-xs font-medium ${hitColor(r.hit3)}`}>{pct(r.hit3)}</span>
                    </td>
                    <td className="py-1.5 pr-3">
                      <span className={`inline-block rounded px-1.5 py-0.5 text-xs font-medium ${hitColor(r.hitk)}`}>{pct(r.hitk)}</span>
                    </td>
                    <td className="py-1.5 pr-3">{r.mrr.toFixed(3)}</td>
                    <td className="py-1.5 pr-3">{r.faithfulness === null ? '—' : `${r.faithfulness}/5`}</td>
                    <td className="py-1.5 text-right text-xs">
                      <button onClick={() => toggleRunDetail(r)} className="text-violet-500 hover:underline">
                        {openRun?.id === r.id ? '收起' : '明细'}
                      </button>
                      <button onClick={() => removeRun(r.id)} className="ml-2 text-red-500 hover:underline">
                        删除
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {openRun?.detail && (
          <div className="mt-4 flex flex-col gap-2">
            <p className="text-xs text-neutral-400">
              第 {openRun.id} 次明细 · {openRun.total} 题 · {openRun.judge_model || '未判分'} · {openRun.seconds}s
            </p>
            {openRun.detail.map((d) => (
              <div key={d.id} className="rounded-md bg-neutral-100 p-3 text-sm dark:bg-neutral-900">
                <div className="flex items-start justify-between gap-3">
                  <p className="min-w-0 flex-1">{d.question}</p>
                  <span className="flex shrink-0 items-center gap-2 text-xs">
                    <span
                      className={`rounded px-1.5 py-px ${
                        d.rank === 1
                          ? 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300'
                          : d.rank
                            ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300'
                            : 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300'
                      }`}
                    >
                      {d.expected_source ? (d.rank ? `第 ${d.rank} 位命中` : '未命中') : '未标注'}
                    </span>
                    {d.score !== null && <span className="text-neutral-500">忠实度 {d.score}/5</span>}
                  </span>
                </div>
                <p className="mt-1 text-xs text-neutral-400">
                  期望 {d.expected_source || '—'} · 检索到 {d.hits.filter(Boolean).join(' , ') || '（无）'}
                </p>
                {d.reason && <p className="mt-1 text-xs text-neutral-500">判分理由：{d.reason}</p>}
                {d.error && <p className="mt-1 text-xs text-red-500">{d.error}</p>}
                {d.answer && (
                  <details className="mt-1">
                    <summary className="cursor-pointer text-xs text-neutral-500">查看回答</summary>
                    <pre className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap text-xs leading-relaxed text-neutral-600 dark:text-neutral-300">
                      {d.answer}
                    </pre>
                  </details>
                )}
              </div>
            ))}
          </div>
        )}
      </section>
    </>
  )
}
