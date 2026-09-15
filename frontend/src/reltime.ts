/** 「多久以前」——全站一份。
 *
 *  原先 NotesPage 里有个局部函数 `relTime`（文件列表按今天/本周/更早分组，所以 ≥7 天
 *  就退回绝对日期），P4 的小屋又要一个相对时间。第三次抄之前先合：这里放**通用**的
 *  那一段，NotesPage 保留它自己那条「≥7 天换成日期」的界面决定。
 *
 *  入参是 **epoch 秒**（后端各处的约定），不是毫秒。
 */
export function ago(ts: number, now = Date.now()): string {
  const s = Math.max(0, now / 1000 - ts)
  if (s < 60) return '刚刚'
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`
  const d = Math.floor(s / 86400)
  if (d === 1) return '昨天'
  if (d < 30) return `${d} 天前`
  if (d < 365) return `${Math.floor(d / 30)} 个月前`
  return `${Math.floor(d / 365)} 年前`
}

/** 24 小时内到手的：值得圈一下。**不落任何状态**——纯算，所以刷新多少次都一样。 */
export function isFresh(ts: number, now = Date.now()): boolean {
  return now / 1000 - ts < 86400
}
