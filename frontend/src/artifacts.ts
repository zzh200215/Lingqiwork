/** 产出回执的列表操作。
 *
 *  单独拎出来是因为它有个**不变量**要守：同一份产出（同一个 `path`）在一轮里只该有
 *  一条回执。模型满足不了「300 字左右」时会写一版存一版（实测 20 轮里 5 轮存了 ≥2 次），
 *  后端已经把同一个文件的多条回执收成一条；界面这条流式路径也必须一样收，
 *  否则**流式期间**会看到 2～4 条指向同一个文件的链接，刷新之后才变成 1 条。
 *  两条链接点开是同一份东西——多出来的那条是谎话。
 */
import type { ArtifactRef, QualityNote } from './stream'

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

/** 这一轮该不该给用户一句提示，以及提示什么。 */
export interface SaveHint {
  text: string
  /** 要不要把「📄 存进产出」提到最显眼处（一键补）。
   *  **只有「用户明说要落盘、它却没落」时才为真** —— 对一次「没有素材，我不想凭空编」
   *  的正确拒绝，提那个按钮是在误导人。 */
  primary: boolean
}

/** 这一轮要显示的那一条产出提示（没有就返回 null）。
 *
 *  **判据不在前端**（W2a）：`long_body_without_a_receipt` / `invented_path` 由服务端在
 *  `core/turn_quality.py` 一处判、随 `quality` 帧发过来，这里只负责把它变成一句话。
 *  前端唯一自己判的是「说了存却没回执」——那条本来就在前端有一份（`claimsSaveWithoutArtifact`），
 *  和后端 `chat._save_claim_markers` 是成对的，两边的例句是同一批。
 */
export function saveHint(
  content: string | undefined,
  artifacts: ArtifactRef[] | undefined,
  quality?: QualityNote
): SaveHint | null {
  const has = !!artifacts?.length
  const codes = quality?.codes ?? []
  if (!has && claimsSaveWithoutArtifact(content, artifacts)) {
    return { text: '这一轮说「已存入产出」，但实际没有落盘——东西只在上面这段回复里，产出区里没有。', primary: true }
  }
  if (!has && codes.includes('long_body_without_a_receipt') && quality?.asked_to_save) {
    return { text: '这段回答是一份成品，却没进产出区（服务端补跑过一次还是没落盘）。', primary: true }
  }
  if (codes.includes('invented_path')) {
    return { text: '回复里提到的产出路径不在这一轮的回执里——点开是空的。', primary: false }
  }
  const dropped = quality?.dropped_receipts?.[0]
  if (dropped) {
    return { text: `有一条产出回执没给出去：${dropped.why ?? '过不了校验'}`, primary: false }
  }
  return null
}
