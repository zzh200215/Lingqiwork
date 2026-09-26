/** 工作流清单的一行，以及它展开之后的运行记录（方案 §8.3）。
 *
 *  ## 这一份里装的是什么
 *
 *  「一条流程长什么样」+「它跑过的每一次长什么样」。两者绑在一起是因为**它们只一起出现**：
 *  `RunRow` 只在这条流程展开时渲染，`WorkflowRow` 展开时一定要渲染 `RunRow`。拆成两个文件
 *  只会让那个唯一的调用点跨文件。
 *
 *  折叠进来的是原先散在 `WorkPage.tsx` 里的四个纯函数（耗时 / 成败 / 注入痕迹 / 读成技能
 *  那一行）——它们只服务这两个组件，放在页面那一层谁也 reuse 不到。
 *
 *  ## 四条「不编」
 *
 *  - **没跑过就不写 30 天成功率**：写「0%」是把「没跑过」说成「全挂了」。
 *  - **耗时算不出来就不摆那一格**（还没结束、或时间戳缺一个）。
 *  - **接地分够不着材料时写「未打分」**，不写 0。
 *  - **拉运行记录时两种沉默**：正在拉、拉不到，都**不在这里说话**（说话的是页级错误条）。
 *    悄悄摆一句「还没有运行记录」是最糟的选项——它把「没读到」说成了「没有」。
 */
import { useCallback, useState } from 'react'
import { Link } from 'react-router-dom'

import EmptyHint from './EmptyHint'
import RunSteps, { stepsOf } from './RunSteps'
import StatRow from './StatRow'
import { failedResult, fmtWhen } from './workShared'
import { api, type ScheduledTask, type SkillCandidateResult, type TaskRunItem } from './api'

/** 这一趟是谁叫起来的。 */
const TRIGGER_LABEL: Record<string, string> = {
  cron: '定时',
  manual: '手动',
  chain: '上游触发',
  watch: '监听',
}

/** 这一趟跑了多久。**算不出来就返回空串**（还没结束、或时间戳缺一个、或这条压根读不到）——
 *  「0 秒」是编的，「—」是实话。 */
export function elapsed(run?: TaskRunItem): string {
  if (!run?.started_at || !run.finished_at) return ''
  const a = Date.parse(run.started_at)
  const b = Date.parse(run.finished_at)
  if (Number.isNaN(a) || Number.isNaN(b) || b < a) return ''
  const s = Math.round((b - a) / 1000)
  if (s < 60) return `${s} 秒`
  return `${Math.floor(s / 60)} 分 ${s % 60} 秒`
}

/** 这次运行怎么样。`running` / 待审优先——它们还没结束，谈不上成败。 */
function runTone(r: TaskRunItem): { tone: 'bad' | 'warn' | 'good' | 'info'; text: string } {
  if (r.status === 'running') return { tone: 'warn', text: '运行中' }
  if (r.status === 'awaiting_approval') return { tone: 'warn', text: '等你点头' }
  if (r.status === 'ok') return { tone: 'good', text: '✓' }
  if (r.status === 'rejected') return { tone: 'info', text: '已驳回' }
  return { tone: 'bad', text: '✗' }
}

/** S1（PLAN3 §2 S1 第 6 条）：这次运行吃到了哪份工序——从运行日志里读。
 *
 *  没注入就没有这一项，所以这里返回空数组、界面上**一个字都不摆**（不写「注入：无」：
 *  日志只记真发生过的事）。它是 S3 试用期的同一份真值，界面这边只是它的只读视图。
 */
function injectedSkills(run: TaskRunItem): string[] {
  const entry = (run.log ?? []).find((e) => e.tool === 'skill_inject')
  const names = entry?.args?.skills
  return Array.isArray(names) ? names.map(String) : []
}

/** S2（PLAN3 §2 S2）：这次运行的一行小结——成没成、落在哪、为什么。 */
function readAsSkillLine(
  res: SkillCandidateResult,
  run: TaskRunItem
): { text: string; tone: string } {
  if (res.written) {
    const n = (res.runs ?? [run.id]).length
    return {
      text: `✓ 落了草稿「${res.name}」→ ${res.path}（按 ${n} 次运行判断 · 还是草稿：没基线不算能力）`,
      tone: 'text-emerald-700 dark:text-emerald-400',
    }
  }
  if (res.already)
    return {
      text: `没落盘：同名「${res.already}」已经在了，不覆盖`,
      tone: 'text-amber-700 dark:text-amber-400',
    }
  if (!res.usable && res.ok)
    return { text: `没出能力：${res.reason}`, tone: 'text-neutral-500 dark:text-neutral-400' }
  return { text: `✗ ${res.reason}`, tone: 'text-rose-600 dark:text-rose-400' }
}

/** 一次运行 = 一行事实（排布交给 `StatRow`，与今日概览同一套）。 */
function RunRow({ run }: { run: TaskRunItem }) {
  const tone = runTone(run)
  const injected = injectedSkills(run)
  const steps = stepsOf(run)
  // 方案 §8.3：点单次运行 → 步骤条详情（每步状态/耗时，可展开看输入输出与产物）。
  // 默认收着——一屏摊开好几条运行的步骤，反而看不清哪一趟是哪一趟。
  const [stepsOpen, setStepsOpen] = useState(false)
  // S2 的入口：**运行记录是唯一同时给得出「题目」与「产出」的地方**（成品页只有路径，
  // 拿不到那次的题目与注入痕迹）。点了才跑——拉取式，与 deliver 的护栏同一条。
  const [busy, setBusy] = useState(false)
  const [res, setRes] = useState<SkillCandidateResult | null>(null)

  const readAsSkill = useCallback(
    async (overwrite: boolean) => {
      setBusy(true)
      try {
        setRes(await api.draftFromRun(run.id, overwrite))
      } catch (e) {
        setRes(failedResult(e instanceof Error ? e.message : String(e)))
      } finally {
        setBusy(false)
      }
    },
    [run.id]
  )

  return (
    <li className="py-1">
      <StatRow
        items={[
          { label: tone.text, tone: tone.tone },
          { label: fmtWhen(run.started_at) },
          // 跑了多久（方案 §8.3：运行记录带耗时）。算不出来那一格不摆。
          ...(elapsed(run) ? [{ label: elapsed(run) }] : []),
          { label: TRIGGER_LABEL[run.trigger] ?? run.trigger },
          // 接地分：够不着材料的那几次没有分，直说「未打分」而不是显示 0
          {
            label: run.grounded == null ? '未打分' : `接地 ${run.grounded}/5`,
            title: run.judge_reason || '这次没有可判的材料',
          },
          // S1 的注入痕迹：**匹配出来的**工序，不是人指的
          ...(injected.length
            ? [{ label: `注入 ${injected.join('、')}`, title: '这次运行吃到的技能（按话题匹配出来的）' }]
            : []),
          ...(run.tool_calls > 0
            ? [{ label: `${run.rounds} 轮 · ${run.tool_calls} 次工具` }]
            : []),
        ]}
        trailing={
          run.error ? (
            <span className="min-w-0 basis-full truncate text-rose-600 dark:text-rose-400" title={run.error}>
              {run.error}
            </span>
          ) : undefined
        }
      />
      <div className="mt-0.5 flex flex-wrap items-center gap-2 pl-1">
        <button
          data-run-steps-toggle
          onClick={() => setStepsOpen((v) => !v)}
          title="这一次运行每一步干了什么：状态、耗时、输入/输出"
          className="rounded-full border border-neutral-300 px-2 py-0.5 text-xs text-neutral-500 transition-colors hover:border-violet-300 hover:text-violet-600 dark:border-neutral-700 dark:text-neutral-400"
        >
          {stepsOpen ? '收起步骤' : `步骤 ${steps.length}`}
        </button>
        <button
          onClick={() => void readAsSkill(false)}
          disabled={busy}
          title="读这次运行的过程与产出，判断有没有一套下次还能照着做的工序（会调一次模型）"
          className="rounded-full border border-violet-200 px-2 py-0.5 text-xs text-violet-700 transition-colors hover:bg-violet-50 disabled:opacity-40 dark:border-violet-500/30 dark:text-violet-300 dark:hover:bg-violet-500/10"
        >
          {busy ? '读着…' : '读成技能 →'}
        </button>
        {res && !res.written && res.already ? (
          <button
            onClick={() => void readAsSkill(true)}
            disabled={busy}
            className="rounded-full border border-amber-300 px-2 py-0.5 text-xs text-amber-700 transition-colors hover:bg-amber-50 disabled:opacity-40 dark:border-amber-700 dark:text-amber-300"
          >
            覆盖已有的「{res.already}」
          </button>
        ) : null}
        {res ? (
          <span data-read-skill className={`text-xs ${readAsSkillLine(res, run).tone}`}>
            {readAsSkillLine(res, run).text}
          </span>
        ) : null}
      </div>
      {stepsOpen ? <RunSteps run={run} /> : null}
    </li>
  )
}

export default function WorkflowRow({
  task,
  nextName,
  open,
  runs,
  rate,
  lastRun,
  busy,
  reviewBusy,
  onToggle,
  onRerun,
  onReview,
}: {
  task: ScheduledTask
  nextName: string
  open: boolean
  /** `null` = 还不知道（正在拉 / 拉不到）；`[]` = 拉到了、确实没有。 */
  runs: TaskRunItem[] | null
  /** 这条流程 30 天内的成绩（`task_stats.by_task`）。**没跑过就没有这一项**，
   *  界面上一个字都不摆——摆 0% 等于把「没跑过」说成「全挂了」。 */
  rate?: { runs: number; ok: number; rate: number | null }
  /** 这条流程**最近一次**运行（批量只读接口给的）。用来在行内写「上次跑于何时、跑了多久」
   *  —— 方案 §8.3 的原话是「上次运行**+耗时**」，而耗时只活在 `TaskRun` 上
   *  （任务的 `last_run` 只有开始时刻）。`undefined` = 还没跑到 / 读不到，那就不摆耗时。 */
  lastRun?: TaskRunItem
  busy: boolean
  reviewBusy: boolean
  onToggle: () => void
  /** 不传参数 = 原样重跑；传了 = 这一次换题目（运行期覆盖）。 */
  onRerun: (topic?: string) => void
  onReview: (approve: boolean) => void
}) {
  const [paramOpen, setParamOpen] = useState(false)
  const [topic, setTopic] = useState('')
  const waiting = task.awaiting_run_id ?? null
  /** 状态点（方案 §七：直径 `h-2 w-2` + 语义色）。**行首一眼可见**，
   *  不用读到右边那列字才知道这条是成是败。 */
  const dot = task.running
    ? { cls: 'bg-amber-500', text: '运行中', tone: 'text-amber-600 dark:text-amber-400' }
    : waiting
      ? { cls: 'bg-amber-500', text: '等你点头', tone: 'text-amber-600 dark:text-amber-400' }
      : task.last_status === 'ok'
        ? { cls: 'bg-emerald-500', text: '✓', tone: 'text-emerald-600 dark:text-emerald-400' }
        : task.last_status === 'error'
          ? { cls: 'bg-rose-500', text: '✗', tone: 'text-rose-600 dark:text-rose-400' }
          : { cls: 'bg-neutral-300 dark:bg-neutral-600', text: '—', tone: 'text-neutral-400' }

  return (
    <li id={`task-${task.id}`} className="px-4 py-2.5">
      <div className="flex items-center gap-2">
        <span className={`h-2 w-2 shrink-0 rounded-full ${dot.cls}`} aria-hidden />
        {/* 待放行的排头徽章（方案 §8.3：行首 amber 徽章「等你放行」） */}
        {waiting ? (
          <span className="shrink-0 rounded border border-amber-300 px-1.5 py-0.5 text-xs text-amber-700 dark:border-amber-600 dark:text-amber-300">
            等你放行
          </span>
        ) : null}
        <button onClick={onToggle} className="min-w-0 flex-1 text-left" title={task.prompt}>
          <span className="block truncate text-sm text-neutral-700 dark:text-neutral-200">
            {task.name}
            {task.require_approval ? (
              <span className="pl-1.5 text-xs text-neutral-400">卡点</span>
            ) : null}
            {!task.enabled ? <span className="pl-1.5 text-xs text-neutral-400">已停用</span> : null}
          </span>
          <span className="block truncate text-xs text-neutral-400">
            {task.trigger_kind === 'watch' ? `监听 ${task.watch_path || '（未设路径）'}` : task.cron}
            {nextName ? ` → ${nextName}` : ''}
            {task.last_run ? ` · 上次 ${fmtWhen(task.last_run)}` : ' · 还没跑过'}
            {/* 上次跑了多久（方案 §8.3：行内是「上次运行**+耗时**」）。
                耗时只活在 `TaskRun` 上，所以拿的是批量接口给的那一条（`lastRun`）。
                **算不出来就不摆**——还没结束、或时间戳缺一个时 `elapsed` 返回空串，
                这里不编一个「0 秒」出来。 */}
            {task.last_run && elapsed(lastRun) ? `（${elapsed(lastRun)}）` : ''}
            {/* 30 天成绩（方案 §8.3 每行一条）。**没跑过就不写**——
                写「0%」是把「没跑过」说成「全挂了」。 */}
            {rate && rate.rate != null ? ` · 30 天 ${Math.round(rate.rate * 100)}%` : ''}
          </span>
        </button>
        {/* M2：这条流程的成品挂在哪件「事」上——挂接是自动发生的，但得看得见，
            否则「产物去哪了」又变成一个要猜的问题。 */}
        {task.thread_id ? (
          <Link
            to={`/work?tab=thread&thread=${task.thread_id}`}
            title="这条流程的成品都挂在这件事上"
            className="shrink-0 rounded-full border border-violet-200 px-2 py-0.5 text-xs text-violet-600 transition-colors hover:bg-violet-50 dark:border-violet-500/40 dark:text-violet-300 dark:hover:bg-violet-500/10"
          >
            🗂 这件事
          </Link>
        ) : null}
        <span className={`shrink-0 text-xs ${dot.tone}`}>{dot.text}</span>
        {/* 停在卡点上时，这里就该是放行/驳回——它才是此刻唯一该做的动作 */}
        {waiting ? (
          <>
            <button
              onClick={() => onReview(true)}
              disabled={reviewBusy}
              className="shrink-0 rounded-full border border-emerald-300 px-2 py-0.5 text-xs text-emerald-700 transition-colors hover:bg-emerald-50 disabled:opacity-40 dark:border-emerald-700 dark:text-emerald-300 dark:hover:bg-emerald-500/10"
            >
              通过
            </button>
            <button
              onClick={() => onReview(false)}
              disabled={reviewBusy}
              className="shrink-0 rounded-full border border-neutral-300 px-2 py-0.5 text-xs text-neutral-500 transition-colors hover:bg-neutral-50 disabled:opacity-40 dark:border-neutral-700 dark:hover:bg-neutral-800"
            >
              驳回
            </button>
          </>
        ) : (
          <button
            data-rerun
            onClick={() => void onRerun()}
            disabled={busy || task.running}
            className="shrink-0 rounded-full border border-neutral-300 px-2 py-0.5 text-xs text-neutral-500 transition-colors hover:border-violet-300 hover:text-violet-600 disabled:opacity-40 dark:border-neutral-700 dark:text-neutral-400"
          >
            {busy ? '跑着…' : '重跑'}
          </button>
        )}
        {/* 方案 §8.3 第 5 条：**重跑可改本次参数**。「改参数」与「重跑」分成两颗，
            因为多数重跑就是想原样再来一遍——为那多数人加一步展开是打扰。 */}
        {!waiting ? (
          <button
            data-rerun-params
            onClick={() => {
              setTopic(task.prompt)
              setParamOpen((v) => !v)
            }}
            title="这次换一个题目跑（只覆盖这一次，不改任务模板）"
            className="shrink-0 rounded-full border border-neutral-300 px-2 py-0.5 text-xs text-neutral-500 transition-colors hover:border-violet-300 hover:text-violet-600 disabled:opacity-40 dark:border-neutral-700 dark:text-neutral-400"
          >
            {paramOpen ? '收起' : '改参数'}
          </button>
        ) : null}
      </div>

      {paramOpen && !waiting ? (
        <div className="mt-2 flex gap-2 pl-4">
          <input
            autoFocus
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && topic.trim()) {
                void onRerun(topic.trim())
                setParamOpen(false)
              }
            }}
            placeholder="这次跑什么？（只覆盖这一次）"
            className="min-w-0 flex-1 rounded-lg border border-neutral-300 bg-white px-2.5 py-1.5 text-xs outline-none focus:border-violet-400 dark:border-neutral-700 dark:bg-neutral-900"
          />
          <button
            data-rerun-params-go
            onClick={() => {
              void onRerun(topic.trim())
              setParamOpen(false)
            }}
            disabled={busy || !topic.trim()}
            className="shrink-0 rounded-lg bg-violet-600 px-3 py-1 text-xs text-white transition-colors hover:bg-violet-500 disabled:opacity-40"
          >
            {busy ? '跑着…' : '按这个跑'}
          </button>
        </div>
      ) : null}

      {/* 失败原因直接摊在行下——「为什么失败」不该要再点一次才看得到 */}
      {task.last_status === 'error' && task.last_result ? (
        <p className="mt-1 truncate text-xs text-rose-600 dark:text-rose-400" title={task.last_result}>
          {task.last_result}
        </p>
      ) : null}
      {waiting ? (
        <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">
          这一步跑完了，等你点头才交给下游{nextName ? `（${nextName}）` : ''}——展开可以看它的产出。
        </p>
      ) : null}

      {open ? (
        runs === null ? (
          // 正在拉、或者拉不到 —— 两种都**不说话**：说话的是页级错误条。
          // 悄悄地摆一句「还没有运行记录」在这里是最糟的选项（§4-8）。
          <p className="mt-1 pl-1 text-xs text-neutral-400">正在读运行记录…</p>
        ) : runs.length === 0 ? (
          // 空态一律 EmptyHint（方案 §七：虚线框 + 标题 + 一句引导），**禁裸文本**。
          <EmptyHint title="还没有运行记录。" hint="点「重跑」跑一次，这里就会留一行。" />
        ) : (
          <ul className="mt-1 divide-y divide-neutral-100 border-l-2 border-neutral-100 pl-2 dark:divide-neutral-800/70 dark:border-neutral-800">
            {runs.map((r) => (
              <RunRow key={r.id} run={r} />
            ))}
          </ul>
        )
      ) : null}
    </li>
  )
}
