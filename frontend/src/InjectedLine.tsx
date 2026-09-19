/**
 * S1（PLAN3 §2 S1 第 6 条）：本次注入的工序。
 *
 * **手动跑引擎没有运行记录**（`TaskRun` 只在 `tasks._new_run` 落地，`routers/work.py`
 * 开头写着「产出没有登记表」），所以这一行是那条路上唯一的窗口——不摆它，用得最多的
 * 一条路人永远不知道自己吃到了什么。
 *
 * 两条规矩：
 * - **没命中就什么都不渲染**：不写「注入：无」——只摆真发生过的事（同「只摆非零」）。
 * - 它是**匹配出来的**，不是人指的：标题上就写清楚，免得被当成设置。
 */
export default function InjectedLine({ names, className = '' }: { names: string[]; className?: string }) {
  if (!names.length) return null
  return (
    <span data-injected className={className}>
      本次注入：{names.join('、')}
      <span className="text-neutral-400">（按话题匹配出来的工序，跟着 system 一起进的模型）</span>
    </span>
  )
}
