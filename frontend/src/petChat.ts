/** 零柒聊天的同一条协议，两个入口共用：右下角的小面板，和陪伴页的整页聊天。
 *
 *  后端是 SSE：`delta` 一帧帧给正文，`tool_call` / `tool_result` 报告它**真的做了什么**
 *  （P3），`error` 事件带话。协议只写这一份，两边就不会一个修了冒泡另一个还坏着。
 *
 *  Z1（PLAN4）：一次请求还带上**最近几轮对话**——后端每一轮都是新的 `messages`
 *  （不落库是设计），不发历史它就**不记得你上一句**，「那第 2 条呢」这种追问答不上来。
 *  历史只活在内存里，随请求来、随请求走。 */

/** 一次工具调用的**副产物**：面板此刻的样子。给界面核对用，不是台词。 */
export interface PetToolReceipt {
  tool: string
  plugin: string
  command: string
  panel: Record<string, unknown>
  said: string | null
}

/** 一轮对话。`pet` 就是零柒——后端把它折成 `assistant`（`pet_context.history` 一处折）。 */
export interface PetTurn {
  role: 'user' | 'pet'
  text: string
}

/** 随请求带过去的最近几轮上限。**与后端 `pet_context.HISTORY_MESSAGES` 对齐**：
 *  那边照样会夹一遍（不信任客户端），这里先夹一次只是省一趟白跑的字节。 */
export const PET_HISTORY_MESSAGES = 6

/** 界面上那串对话 → 请求里的历史。
 *
 *  过滤掉**还没说出话**的那条（正在流的那条占位是空串），并只留最近几条。
 *  两处入口共用一个函数：各写一遍，迟早一处带上「正在流到一半的半句话」。 */
export function historyOf(chat: { role: 'user' | 'pet'; text: string }[]): PetTurn[] {
  return chat
    .filter((m) => m.text.trim())
    .map((m) => ({ role: m.role, text: m.text }))
    .slice(-PET_HISTORY_MESSAGES)
}

export interface PetChatHandlers {
  onDelta: (text: string) => void
  /** 模型决定要调某个工具（已发出、还没跑完）。 */
  onToolCall?: (name: string) => void
  /** 工具跑完了，带上可核对的事实。 */
  onToolResult?: (receipt: PetToolReceipt) => void
}

/** 一行回执怎么读。与后端 `pet_plugins.describe()` 有分工：那边给**模型**一句事实，
 *  这边给**界面**一个短标签——同一件事，两个读者要的东西不一样。 */
export function receiptLabel(r: PetToolReceipt): string {
  const p = r.panel || {}
  if (r.plugin === 'focus') {
    return r.command === 'stop'
      ? '⏱ 专注已停'
      : `⏱ 专注 ${Math.max(1, Math.round(Number(p.remaining ?? 0) / 60))} 分`
  }
  if (r.plugin === 'water') return `💧 喝水 ${p.value ?? 0}/${p.target ?? 0} 杯`
  if (r.plugin === 'mood') return `🙂 心情 ${p.value ?? 0}/${p.scale ?? 5}`
  return `🔧 ${r.tool}`
}

/** 工具正在跑时的那句话——模型还要再走一轮才开口，这段时间得有个东西说明白。 */
export function toolCallLabel(name: string): string {
  if (name === 'pet_focus_start') return '正在开始专注…'
  if (name === 'pet_focus_stop') return '正在停表…'
  if (name === 'pet_water_drink') return '正在记一杯…'
  if (name === 'pet_mood_set') return '正在记心情…'
  return '正在做事…'
}

export async function streamPetChat(
  req: { message: string; history?: PetTurn[] },
  handlers: PetChatHandlers,
  signal?: AbortSignal
): Promise<void> {
  const res = await fetch('/api/pet/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: req.message,
      history: (req.history ?? []).slice(-PET_HISTORY_MESSAGES),
    }),
    signal,
  })
  if (!res.ok || !res.body) {
    const detail = await res.json().catch(() => null)
    throw new Error(detail?.detail || `chat failed: ${res.status}`)
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let sep: number
    while ((sep = buf.indexOf('\n\n')) !== -1) {
      const raw = buf.slice(0, sep)
      buf = buf.slice(sep + 2)
      let event = 'message'
      const dataLines: string[] = []
      for (const line of raw.split('\n')) {
        if (line.startsWith('event: ')) event = line.slice(7)
        else if (line.startsWith('data: ')) dataLines.push(line.slice(6))
      }
      if (!dataLines.length) continue
      const data = JSON.parse(dataLines.join('\n'))
      if (event === 'delta') handlers.onDelta(data.text as string)
      else if (event === 'tool_call') handlers.onToolCall?.(data.name as string)
      else if (event === 'tool_result') {
        // 只有宠物插件会带 `pet` 这一段；别的工具（memory_save 之类）没有可展示的
        // 副产物，就什么都不画——空回执比没有回执更让人困惑。
        const pet = (data.meta as { pet?: PetToolReceipt } | undefined)?.pet
        if (pet) handlers.onToolResult?.(pet)
      } else if (event === 'error') throw new Error(data.message as string)
    }
  }
}
