/** 产出回执的列表操作。
 *
 *  单独拎出来是因为它有个**不变量**要守：同一份产出（同一个 `path`）在一轮里只该有
 *  一条回执。模型满足不了「300 字左右」时会写一版存一版（实测 20 轮里 5 轮存了 ≥2 次），
 *  后端已经把同一个文件的多条回执收成一条；界面这条流式路径也必须一样收，
 *  否则**流式期间**会看到 2～4 条指向同一个文件的链接，刷新之后才变成 1 条。
 *  两条链接点开是同一份东西——多出来的那条是谎话。
 */
import type { ArtifactRef } from './stream'

/** 按 `path` 去重、留最后一条（最后一条带着最新的落盘动作，如「更新」）。 */
export function upsertArtifact(
  list: ArtifactRef[] | undefined,
  art: ArtifactRef
): ArtifactRef[] {
  return [...(list ?? []).filter((a) => a.path !== art.path), art]
}

/** 工具成功时回的是「已更新交付「X」→ 路径」，模型会照抄这个句式。
 *  这份清单和 `backend/app/routers/chat.py::_save_claim_markers` 是一对，
 *  改一边就要改另一边（两边的测试用的是同一批例句）。 */
const SAVE_CLAIM_MARKERS = [
  '已存入产出',
  '已存为',
  '已另存为',
  '已更新研究',
  '已更新方案',
  '已更新对质',
  '已更新复盘',
  '已更新交付',
  '已更新成文',
]

/** 这一轮的回复**声称**存了产出，但这条消息上没有任何回执。
 *
 *  实测 22 轮里 2 轮这样：模型模仿自己上一轮的开场白写了「已存入产出（约 100 字）」，
 *  却没调工具——新写的那版只活在对话里，产出区还是上一轮的旧版本。用户会以为存好了。
 *  有回执就一律不算（真存了），所以这里不会误伤。
 *
 *  只在界面上给一条提示，**不动内容**：那句话是模型真说过的，删掉等于替它圆谎。
 */
export function claimsSaveWithoutArtifact(
  content: string | undefined,
  artifacts: ArtifactRef[] | undefined
): boolean {
  if (artifacts?.length) return false
  const text = (content ?? '').trim()
  if (!text) return false
  return SAVE_CLAIM_MARKERS.some((m) => text.includes(m))
}
