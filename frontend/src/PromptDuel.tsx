/** 对打区（方案 §8.2 区2，仿 Langfuse Playground）——「同一条提示词，几个模型谁答得好」。
 *
 *  ## 它为什么是独立文件
 *
 *  `PromptLibrary.tsx` 已经 1562 行，而方案 §十二 对文件结构的判据是「单一域职责即停手」。
 *  对打是提示词页里**独立的一块能力**：选提示词 → 选模型 → 同一输入并排看结果。
 *
 *  ## 后端是现成的
 *
 *  `POST /api/arena`（`core/arena.py`）本来就是「同一段 prompt 并行打到几家 provider」，
 *  并行不是串行（等待 = 最慢那家，不是各家之和）。这里只做两件事：
 *  ① 把 prompt 换成**库里那一条**（可选地先把变量填上）；② 让模型**可选**
 *  （原来的 arena 一律打全部已启用 provider，对打要的是选 2–4 个）。
 *
 *  ## 三件刻意的取舍
 *
 *  - **不自动选模型**：一个都不预选，你自己点。预选「前两个」看起来体贴，
 *    实际会让「我到底比了哪两个」变成一个要回看的问题。
 *  - **失败的那列照常占位**：某家挂了就把原因写在它那一列——**不悄悄把它删掉**，
 *    否则「三家比」变成「两家比」，而你以为自己看到了全部。
 *  - **「存为用例」进的是评测区的金标集**（`promptRegistry` 那一套，key = 系统提示词 key）。
 *    库里的提示词与登记表不是一回事，所以这里只做**复制那一段输出**，不假装能一键入库。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'

import RunPanel from './RunPanel'

import { api, type ArenaResult, type PromptItem, type ProviderConfig } from './api'
import EmptyHint from './EmptyHint'

/** 与 `PromptLibrary` / `backend/core/prompt_ai.vars_in` **同一条正则**（三处必须一致）。 */
function varsIn(content: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const m of content.matchAll(/\{([^{}\n]{1,30})\}/g)) {
    const name = m[1].trim()
    if (name && !seen.has(name)) {
      seen.add(name)
      out.push(name)
    }
  }
  return out
}

function fill(content: string, values: Record<string, string>): string {
  return content.replace(/\{([^{}\n]{1,30})\}/g, (whole, name: string) =>
    values[name.trim()] ? values[name.trim()] : whole
  )
}

/** 最多比几家。方案 §三-1「选 **2–4** 个已配置模型」、§8.2 行2 的结果区是
 *  `xl:grid-cols-4` —— 选到第 5 家会换行成两块，而「并排看」正是这一块的全部意义。
 *  下界（2）在 `duel()` 里拦，这里管上界。 */
const MAX_MODELS = 4

export default function PromptDuel({ prompts, id }: { prompts: PromptItem[]; id?: string }) {
  const [open, setOpen] = useState(false)
  const [promptId, setPromptId] = useState<number | null>(null)
  const [vals, setVals] = useState<Record<string, string>>({})
  /** 这一问（答什么）。**与提示词分开**——对打量的是「同一条提示词 + 同一段输入，几家谁答得好」，
   *  合成一段就量不出「换了模型」这一件事。 */
  const [input, setInput] = useState('')
  const [models, setModels] = useState<string[]>([])
  const [providers, setProviders] = useState<ProviderConfig[]>([])
  const [busy, setBusy] = useState(false)
  const [results, setResults] = useState<ArenaResult[] | null>(null)
  const [err, setErr] = useState('')
  const [copied, setCopied] = useState<number | null>(null)
  const [saved, setSaved] = useState('')
  /** 这一局的 AbortController。**「不等了」不是「停止」**：`/api/arena` 是一次性 POST，
   *  断开连接之后服务端那几家照样跑完（每家最多 90 秒），钱照花。 */
  const abortRef = useRef<AbortController | null>(null)

  // 可选的模型 = 已启用 provider 的模型清单（对打的候选就是降级链的候选）
  useEffect(() => {
    api
      .listProviders()
      .then((ps) => setProviders(ps.filter((p) => p.enabled)))
      .catch(() => setProviders([]))
  }, [])

  const picked = useMemo(() => prompts.find((p) => p.id === promptId) ?? null, [prompts, promptId])
  const vars = useMemo(() => (picked ? varsIn(picked.content) : []), [picked])
  /** 提示词那一段（system）：选了提示词就用它，变量填过的填上、没填的留着 `{变量}` 原样。 */
  const systemText = picked ? fill(picked.content, vals) : ''

  const choose = useCallback((p: PromptItem) => {
    setPromptId(p.id)
    setVals(Object.fromEntries(varsIn(p.content).map((v) => [v, p.last_vars?.[v] ?? ''])))
    setResults(null)
    setErr('')
    setSaved('')
  }, [])

  const toggleModel = useCallback((m: string) => {
    setModels((cur) => {
      if (cur.includes(m)) return cur.filter((x) => x !== m)
      if (cur.length >= MAX_MODELS) return cur // 到顶了就不加（chip 那边也是禁用的）
      return [...cur, m]
    })
  }, [])

  const canGo = Boolean(systemText.trim() || input.trim())

  async function duel() {
    if (!canGo || busy) return
    if (models.length < 2) {
      setErr('至少选两个模型——只选一个那叫「跑一下」，不叫对打。')
      return
    }
    abortRef.current?.abort()
    const ctl = new AbortController()
    abortRef.current = ctl
    setBusy(true)
    setErr('')
    setSaved('')
    setResults(null)
    try {
      // 两段分开送：提示词当 system，输入框当 user（§8.2 区2）
      const r = await api.arenaRun(input, models, systemText, ctl.signal)
      if (ctl.signal.aborted) return
      setResults(r.results)
    } catch (e) {
      if (ctl.signal.aborted) return // 自己点的不等了，不当成失败
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      if (abortRef.current === ctl) abortRef.current = null
      setBusy(false)
    }
  }

  /** 存成一条对打记录（落 `vault/prompts/duels/` 并进索引）。
   *  **不是「存为用例」**：评测区那个金标集挂的是登记表里的系统提示词，而库里这些不在那张表里
   *  —— 硬塞进去要先编一个「这条对应哪一条」的对应关系。存的是它本来的东西：这次比了什么、
   *  各家答了什么。可回看、可 diff、能被下一次取材捞回来。 */
  async function saveRecord() {
    if (!results || busy) return
    setBusy(true)
    setErr('')
    try {
      const r = await api.arenaSave({
        title: picked?.title ?? '',
        system: systemText,
        prompt: input,
        results,
      })
      setSaved(r.filename)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function copyOne(i: number, s: string) {
    try {
      await navigator.clipboard.writeText(s)
      setCopied(i)
      window.setTimeout(() => setCopied(null), 1500)
    } catch {
      setErr('复制没成功——浏览器没给剪贴板权限。')
    }
  }

  const allModels = providers.flatMap((p) => p.models.map((m) => ({ id: m, provider: p.name })))

  if (!open) {
    return (
      <section id={id} className="wb-card scroll-mt-14 px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-sm font-semibold text-neutral-800 dark:text-neutral-100">对打</h2>
          <span className="min-w-0 flex-1 text-xs text-neutral-400">
            同一条提示词，几个模型谁答得好
          </span>
          <button
            data-duel-open
            onClick={() => setOpen(true)}
            className="shrink-0 rounded-md border border-violet-300 px-3 py-1.5 text-sm text-violet-700 transition-colors hover:bg-violet-50 dark:border-violet-600 dark:text-violet-300 dark:hover:bg-violet-500/10"
          >
            开一局
          </button>
        </div>
      </section>
    )
  }

  return (
    <section id={id} data-duel className="wb-card scroll-mt-14 space-y-3 px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold text-neutral-800 dark:text-neutral-100">对打</h2>
        <span className="min-w-0 flex-1 text-xs text-neutral-400">
          同一条提示词，几个模型谁答得好
        </span>
        <button
          onClick={() => setOpen(false)}
          className="shrink-0 text-xs text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-200"
        >
          收起
        </button>
      </div>

      {/* 行1：提示词 + 模型多选 + 开打 */}
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={promptId ?? ''}
          onChange={(e) => {
            const p = prompts.find((x) => x.id === Number(e.target.value))
            if (p) choose(p)
          }}
          aria-label="选提示词"
          className="min-w-0 flex-1 rounded-md border border-neutral-300 bg-white px-2 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
        >
          <option value="">选一条提示词…</option>
          {prompts.map((p) => (
            <option key={p.id} value={p.id}>
              {p.title}
            </option>
          ))}
        </select>
        <button
          data-duel-go
          onClick={() => void duel()}
          disabled={!canGo || busy || models.length < 2}
          title={models.length < 2 ? '至少选两个模型' : '同一段提示词 + 同一段输入，并行打到这几个模型'}
          className="shrink-0 rounded-md wb-btn-primary px-4 py-2 text-sm"
        >
          {busy ? '打着…' : '开打'}
        </button>
      </div>

      {/* 行1 后半：**这一问**（user 消息）。与上面那条提示词分开，才是「同一输入并排比」——
          合成一段的话，你比的是「换了模型 + 换了问法」两件事。
          留空是正当用法：提示词自己把话说全了（那就只发 system）。 */}
      <textarea
        value={input}
        onChange={(e) => setInput(e.target.value)}
        rows={2}
        aria-label="输入"
        placeholder="这一问（例：用一句话说说这周做了什么）。留空也行——提示词里说全了就不用它。"
        className="w-full resize-y rounded-md border border-neutral-300 bg-white px-2.5 py-2 text-sm outline-none placeholder:text-neutral-400 focus:border-violet-400 dark:border-neutral-700 dark:bg-neutral-900"
      />

      {/* 变量：选了带 {变量} 的提示词才出现。填了就用填的，没填的原样发出去。 */}
      {vars.length ? (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-neutral-200 px-2.5 py-2 dark:border-neutral-800">
          <span className="text-xs text-neutral-400">变量</span>
          {vars.map((v) => (
            <label key={v} className="flex items-center gap-1 text-xs text-neutral-500">
              {`{${v}}`}
              <input
                value={vals[v] ?? ''}
                onChange={(e) => setVals((c) => ({ ...c, [v]: e.target.value }))}
                aria-label={`变量 ${v}`}
                className="w-28 rounded border border-neutral-300 bg-white px-1.5 py-0.5 text-xs outline-none focus:border-violet-400 dark:border-neutral-700 dark:bg-neutral-900"
              />
            </label>
          ))}
        </div>
      ) : null}

      {/* 模型多选（2–4 个）。**一个都不预选**——预选会让「我比了哪两个」变成要回看的问题。 */}
      {allModels.length === 0 ? (
        <p className="text-xs text-neutral-400">
          还没有可用的模型——去「设置 · 模型」配一家 provider。
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-neutral-400">模型</span>
          {allModels.map((m) => {
            const on = models.includes(m.id)
            // 选满之后**没选中的那些禁用**：点得动却没反应，比点不动更难懂。
            const full = !on && models.length >= MAX_MODELS
            return (
              <button
                key={m.id}
                data-duel-model={m.id}
                onClick={() => toggleModel(m.id)}
                disabled={full}
                title={
                  full ? `最多比 ${MAX_MODELS} 家（结果区就是 ${MAX_MODELS} 列，再多会换行）` : m.provider
                }
                className={`rounded-full border px-2.5 py-0.5 text-xs transition-colors disabled:opacity-40 ${
                  on
                    ? 'border-violet-400 text-violet-700 dark:border-violet-600 dark:text-violet-300'
                    : 'border-neutral-200 text-neutral-500 hover:border-neutral-300 dark:border-neutral-700 dark:text-neutral-400'
                }`}
              >
                {m.id}
              </button>
            )
          })}
          {models.length ? (
            <span className="text-xs text-neutral-400">
              已选 {models.length}/{MAX_MODELS}
            </span>
          ) : null}
        </div>
      )}

      {/* 长任务走 RunPanel 六态（方案 §六）。
          **这里的「不等了」不是「停止」**：`/api/arena` 是一次性 POST，断开连接之后
          服务端那几家照样跑完（每家最多 90 秒），钱照花——所以不写「停止」。 */}
      {busy ? (
        <RunPanel
          phase="progress"
          tone="violet"
          icon="⚔️"
          title="对打"
          status={`正在并行打 ${models.length} 家——一次点击的等待 = 最慢的那家`}
          onCancel={() => abortRef.current?.abort()}
          cancelLabel="不等了"
        />
      ) : null}

      {err ? (
        <p data-duel-err className="text-xs text-rose-600 dark:text-rose-400">
          {err}
        </p>
      ) : null}

      {results ? (
        results.length === 0 ? (
          <EmptyHint title="没有结果" hint="换一条提示词再试。" />
        ) : (
          <>
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
              {results.map((r, i) => (
                <div key={`${r.label}-${i}`} className="wb-card flex flex-col p-3">
                  <div className="flex items-baseline justify-between gap-2 pb-1.5">
                    <span className="min-w-0 flex-1 truncate text-xs font-medium text-neutral-700 dark:text-neutral-200">
                      {r.label || '（没有配上的模型）'}
                    </span>
                    {/* 耗时 / token 小字（方案 §8.2 区2 行2）。两个都读不到就不摆那一格、
                        也不写「0」——`0` 与「没报」是两件事。 */}
                    <span className="shrink-0 text-xs text-neutral-400">
                      {r.ok ? `${r.seconds}s` : '失败'}
                      {r.ok && (r.tokens_out ?? 0) > 0
                        ? ` · ${r.tokens_in ?? 0}+${r.tokens_out} tok`
                        : ''}
                    </span>
                  </div>
                  {r.ok ? (
                    <>
                      <p className="min-w-0 flex-1 whitespace-pre-wrap break-words text-xs leading-relaxed text-neutral-600 dark:text-neutral-300">
                        {r.text}
                      </p>
                      <button
                        onClick={() => void copyOne(i, r.text ?? '')}
                        className="mt-2 shrink-0 self-start rounded-full border border-neutral-300 px-2 py-0.5 text-xs text-neutral-500 transition-colors hover:border-violet-300 hover:text-violet-600 dark:border-neutral-700 dark:text-neutral-400"
                      >
                        {copied === i ? '已复制' : '复制这段'}
                      </button>
                    </>
                  ) : (
                    /* **失败的那列照常占位**：删掉它「三家比」就变成「两家比」，
                       而你以为自己看到了全部。 */
                    <p className="min-w-0 flex-1 break-words text-xs leading-relaxed text-rose-600 dark:text-rose-400">
                      {r.error || '这一家没答上来'}
                    </p>
                  )}
                </div>
              ))}
            </div>

            {/* 行3：存成一条**对打记录**（§8.2 区2 行3）。
                方案原话是「存为用例 → 进评测区 golden set」，但那个金标集挂的是**登记表**里的
                系统提示词，库里的这些不在那张表里——硬塞要先编一个对应关系。所以存的是它本来
                的东西：这次比了什么、各家答了什么。落 `vault/prompts/duels/` 并进索引。 */}
            <div className="flex flex-wrap items-center gap-2">
              <button
                data-duel-save
                onClick={() => void saveRecord()}
                disabled={busy || !!saved}
                title="把这次对打（提示词 + 输入 + 各家输出）落成 vault 里一篇 md"
                className="rounded-md border border-violet-300 px-3 py-1.5 text-sm text-violet-700 transition-colors hover:bg-violet-50 disabled:opacity-40 dark:border-violet-600 dark:text-violet-300 dark:hover:bg-violet-500/10"
              >
                {saved ? '已存进 vault' : busy ? '存着…' : '存成对打记录'}
              </button>
              {saved ? (
                <Link
                  to={`/notes?path=${encodeURIComponent(saved)}`}
                  className="min-w-0 truncate text-xs text-teal-600 hover:underline dark:text-teal-400"
                  title={saved}
                >
                  {saved}
                </Link>
              ) : (
                <span className="text-xs text-neutral-400">
                  同一条提示词、同一段输入，这次几家答得怎么样——留下来以后能对着看。
                </span>
              )}
            </div>
          </>
        )
      ) : null}

      <ArenaHistory />
    </section>
  )
}

/** 历史对打（2026-09-26）：落盘的记录就是普通 md，这里只列清单、点开走笔记页——
 *  同一份文件不做第二个查看器。没存过就一句实话，不摆空架子。 */
function ArenaHistory() {
  const [records, setRecords] = useState<{ path: string; title: string; mtime: number }[] | null>(
    null,
  )

  useEffect(() => {
    api
      .listArenaRecords()
      .then((r) => setRecords(r.records))
      .catch(() => setRecords(null)) // 读不到就整个不摆：拉清单失败 ≠ 没存过
  }, [])

  if (records === null) return null
  return (
    <details data-arena-history className="border-t border-neutral-100 pt-2 dark:border-neutral-800">
      <summary className="cursor-pointer text-xs text-neutral-500 transition-colors hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-200">
        历史对打 · {records.length} 篇
      </summary>
      {records.length === 0 ? (
        <p className="pt-2 text-xs text-neutral-400">一篇都没有——对打后点「存为记录」就会落在这里。</p>
      ) : (
        <ul className="mt-2 divide-y divide-neutral-100 dark:divide-neutral-800/70">
          {records.map((r) => (
            <li key={r.path} className="py-1.5">
              <Link
                to={`/notes?path=${encodeURIComponent(r.path)}`}
                title={r.path}
                className="flex items-baseline gap-2 text-xs"
              >
                <span className="min-w-0 flex-1 truncate text-neutral-700 hover:text-violet-600 dark:text-neutral-200 dark:hover:text-violet-300">
                  {r.title}
                </span>
                <span className="shrink-0 text-neutral-400">
                  {new Date(r.mtime * 1000).toISOString().slice(5, 10)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </details>
  )
}
