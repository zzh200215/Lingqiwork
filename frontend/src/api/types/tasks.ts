// 方向 6 第二刀（2026-09-29）：从 api.ts 拆出的 tasks 域类型；api.ts 做 type-only 转发，全仓导入路径不变。
import type { ThreadRow } from './threads'

/** Q4 调度台：一步的状态与它能点的动作。**状态与动作都由后端算**（界面不自己推）。 */
export interface DispatchStep {
  index: number
  task_id: number
  name: string
  /** running / awaiting / ok / error / rejected / idle / blocked / off */
  state: string
  state_label: string
  blocked_by?: number | null
  who: string
  model_id: string
  mode: string
  run_id?: number | null
  error?: string
  grounded?: number | null
  require_approval?: boolean
  next_task_id?: number | null
  /** 这一步能点的按钮（**由后端算**：awaiting 给 approve+reject，其余给 run）。 */
  actions?: { kind: 'run' | 'approve' | 'reject'; task_id?: number; run_id?: number; label: string }[]
}

export interface DispatchChain {
  root_id: number
  name: string
  length: number
  steps: DispatchStep[]
  stuck_at?: DispatchStep | null
  needs_attention: boolean
  enabled: boolean
}

export interface DispatchBoard {
  chains: DispatchChain[]
  counts: { chains: number; steps: number; needs_attention: number; running: number }
  states: Record<string, string>
  broadcast: string
}

export interface ScheduledTask {
  id: number
  name: string
  prompt: string
  cron: string
  model_id: string
  use_rag: boolean
  tools_enabled: boolean
  save_to_vault: boolean
  enabled: boolean
  mode: 'simple' | 'agent'
  tool_whitelist: string
  max_rounds: number
  retry: number
  notify_on_error: boolean
  trigger_kind: 'cron' | 'watch' | 'chain'
  watch_path: string
  chain_next_id: number | null
  /** 人工卡点：这一步跑完停下等人点头，才触发下游 */
  require_approval: boolean
  /** 这一步做什么：prompt = 跑提示词；transcribe = 本地 ASR 转写录音；
   *  其余 = 把一个成文引擎按表跑一遍（见 ENGINES），产出落进引擎自己的 vault 目录 */
  action: 'prompt' | 'transcribe' | 'research' | 'compose' | 'recap' | 'decide' | 'conflict'
  /** 产物落哪个 vault 子目录（空 = tasks/）。沿链条继承，所以一条流水线的各步同目录。 */
  landing_dir: string
  /** 这条流程处理的是哪件「事」（M2）；null = 没挂（普通定时任务就是这样）。
   *  起链时按题目写进来，下游继承——所以三步看到的是同一个 id。 */
  thread_id?: number | null
  /** 停在人工卡点上的那次运行；null/缺省 = 没有待审的。放行/驳回用它。 */
  awaiting_run_id?: number | null
  conversation_id: number | null
  last_run: string | null
  last_status: string
  last_result: string
  next_run: string | null
  running?: boolean
  /** 步级超时（秒）：一次执行最多等多久。null/缺省 = 引擎默认（900）。 */
  timeout_seconds?: number | null
  /** 接地分门禁（0-5）：低于它停在卡点等人，不自动流向下游。null/缺省 = 只记分。 */
  gate_min_grounded?: number | null
}

export interface TaskTool {
  name: string
  description: string
}

/** 运行日志的一项。**两种形状同一个数组**（顺序就是发生的顺序，而步骤条要的正是顺序）：
 *  - 工具调用：`{tool, args, ok, result, ms}`；
 *  - 一步工序：`{step, ok, ms, note?, ref?}`（引擎跑的那几步，**没有 `tool` 键**）。
 *
 *  为什么不分两个数组：两边都没有时间戳，插不回正确的位置。读的人按 `tool` / `step`
 *  各自过滤，互不干扰（`skill_inject` 那项是注入痕迹，不是一步工序）。 */
export interface TaskRunLogEntry {
  tool?: string
  args?: Record<string, unknown>
  ok?: boolean
  result?: string
  /** 一步工序的名字（引擎相位：取材 / 成文 / 落盘） */
  step?: string
  /** 这一步花了多久（毫秒）。工具调用与引擎相位都有。 */
  ms?: number
  /** 一句话说明：找到几条材料、写了几节、为什么失败 */
  note?: string
  /** 这一步落了什么（vault 相对路径） */
  ref?: string
}

export interface TaskRunItem {
  id: number
  task_id: number
  trigger: 'cron' | 'manual' | 'chain' | 'watch'
  upstream_task_id: number | null
  started_at: string | null
  finished_at: string | null
  status: string
  mode: string
  model_id: string
  rounds: number
  tool_calls: number
  error: string
  answer: string
  /** 接地分 0-5（LLM 判分：这次的答案 vs 本次检索到的材料）。null = 没打分（没材料 / 判分没跑成）。 */
  grounded: number | null
  /** 判分给的一句话理由 */
  judge_reason: string
  /** 这次运行的落点目录（vault 相对；空 = tasks/） */
  run_dir: string
  /** 这趟运行在处理哪件「事」（M2）。S2 的「读成技能」按它把三步合成一次输入。 */
  thread_id: number | null
  log: TaskRunLogEntry[]
}

export interface TaskRunResult {
  status: string
  error: string
  answer: string
  model_id: string
  conversation_id: number | null
  vault_file: string | null
  sources: number
  run_id: number
  rounds: number
  tool_calls: number
  log: TaskRunLogEntry[]
  /** 这次运行在处理的哪件「事」（M2）；null = 没挂（普通定时任务就是这样） */
  thread_id: number | null
  /** 起链时按题目落的那件「事」——`created=false` 表示复用了同名的 */
  thread?: ThreadRow & { created: boolean }
}
