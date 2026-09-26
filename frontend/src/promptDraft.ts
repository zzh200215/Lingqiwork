/** 提示词草稿：它的形状、它的几个变体，以及 `{变量}` 那套规则。
 *
 *  ## 为什么这一小撮要单独一份文件
 *
 *  这三样东西**跨组件共用**，而它们原先都长在 `PromptLibrary` 主组件那个文件里。
 *  编辑器（`PromptEditor.tsx`）要 `Draft` 与 `varsIn`，库那边要 `blankDraft` 与
 *  `draftToItem`——放在任何一边都会变成互相 import。这里既不依赖谁、也不持有状态。
 *
 *  ## `{变量}` 的正则**只有这一处**
 *
 *  与对话页 `/` 唤起（`App.tsx::applyPrompt`）、后端 `prompt_ai.vars_in` 必须一致：
 *  不一致的症状是「模型提了一批变量，可发出去时一个都不会被问到」——那种 bug
 *  不会报错，只会安静地少问几句。所以它不能在各页面各写一遍。
 */
import type { PromptItem } from './api'

export type Draft = {
  id: number | null
  title: string
  content: string
  tags: string
  category: string
  favorite: boolean
  rating: number
  source: string
  note: string
}

export const EMPTY: Draft = {
  id: null,
  title: '',
  content: '',
  tags: '',
  category: '',
  favorite: false,
  rating: 0,
  source: '',
  note: '',
}

/** 开一条空白草稿。三处要用同一份：页头那个「＋ 新建提示词」、空库时的按钮、
 *  以及左导航「分类」下面那句提示——**一份定义，免得三处各写一遍漏掉某个字段**。 */
export function blankDraft(category = ''): Draft {
  return { ...EMPTY, category }
}

/** 正文里的 `{变量}` 名字，按出现顺序、去重。 */
export function varsIn(content: string): string[] {
  const out: string[] = []
  for (const m of content.matchAll(/\{([^{}\n]{1,30})\}/g)) {
    const name = m[1].trim()
    if (name && !out.includes(name)) out.push(name)
  }
  return out
}

/** 把 `{变量}` 换成填好的值。**没填的留着原样**——换成空串会让人以为那一段本来就没有。 */
export function fill(content: string, values: Record<string, string>): string {
  return content.replace(/\{([^{}\n]{1,30})\}/g, (whole, name: string) =>
    values[name.trim()] ? values[name.trim()] : whole
  )
}

/** 把草稿拼成一份「像 PromptItem 的东西」——只为了走同一条复制路径（含变量面板）。
 *  `base` 是库里那一条：**`last_vars` 要从它来**，否则「复制这份」会丢掉预填。 */
export function draftToItem(d: Draft, base?: PromptItem): PromptItem {
  return {
    id: d.id ?? -1,
    title: d.title,
    content: d.content,
    created_at: base?.created_at ?? '',
    updated_at: base?.updated_at ?? '',
    tags: d.tags
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean),
    category: d.category,
    favorite: d.favorite,
    rating: d.rating,
    source: d.source,
    note: d.note,
    used_count: base?.used_count ?? 0,
    version_count: base?.version_count ?? 0,
    last_vars: base?.last_vars ?? {},
    last_used_at: base?.last_used_at ?? '',
  }
}
