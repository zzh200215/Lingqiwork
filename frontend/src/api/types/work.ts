// 方向 6 第二刀（2026-09-29）：从 api.ts 拆出的 work 域类型；api.ts 做 type-only 转发，全仓导入路径不变。

/** 一条已生成的产出。`kind` 是哪个引擎写的，`path` 是 vault 相对路径（可直接交给
 *  笔记页打开——它和用户自己的笔记同在一片 vault 里）。 */
export interface WorkOutput {
  kind: 'research' | 'compose' | 'recap' | 'decide' | 'conflict' | 'task' | 'deliver'
  label: string
  path: string
  title: string
  date: string
  mtime: number
  /** 正文字数（后端 `_chars_of`：剥 front-matter 后的非空白字符）。
   *  `undefined` = 旧响应没带——界面就不摆这一格，不摆 0。 */
  chars?: number
}

/** 交付（工作侧成文）：一种体裁或一种读者。定义在后端 `core/deliver.py`，前端不硬编码。 */
export interface DeliverOption {
  id: string
  label: string
}

/** 体裁：比读者多一个「长稿」判据——它决定界面走哪一模（先出提纲 / 一键直出）。
 *  **判据在后端**：哪个体裁算长稿是体裁的属性，不是界面的属性。 */
export interface DeliverGenre extends DeliverOption {
  long: boolean
  /** 你自己写的模板（能编辑/删除）。内置那五条是代码，改不了。 */
  custom: boolean
}

/** 自定义体裁模板（§8.1 行2）：**带结构指令**——编辑要用。
 *  `/deliver/genres` 那份列表不带 `prompt`（chips 用不上），这一份才带。 */
export interface DeliverTemplate {
  id: string
  label: string
  prompt: string
  long: boolean
}

export interface DeliverCatalogue {
  genres: DeliverGenre[]
  audiences: DeliverOption[]
  default_genre: string
  default_audience: string
}

/** 提纲（§8.1 长稿那一模）：**只有小节名，没有正文**——正文等提纲定下来再写。 */
export interface DeliverOutline {
  title: string
  sections: string[]
  model_id?: string
}

/** 会议闭环（§4-13）的一场：`vault/meetings/<日期>-<名>/` 一个文件夹。
 *  录音、转写、纪要、待办、短稿是同一件事的五个面，所以按"一场"给，不按文件平铺。 */
export interface WorkMeeting {
  name: string
  path: string
  date: string
  title: string
  mtime: number
  /** vault 相对路径；空 = 这一场没留录音 */
  audio: string
  files: { path: string; title: string }[]
}

/** 到点的**交付**见证（M5 · PLAN3 §13）：一份交出去之后就没人回头看的东西。
 *
 *  真值在文件系统：`vault/deliver/` 里的文件就是交出去的东西本身，`at` 是它的 mtime（epoch 秒）。
 *  「回看过了」= 有一条隔了 24 小时以上的 👍/👎（当天点的赞说的是「写得好」）。
 *  **只回一条 + 一个计数**，与决策见证同一个形状。 */
export interface DeliverWitness {
  due: {
    path: string
    title: string
    /** 文件头 frontmatter 里的体裁 / 读者（老文件可能没有，那就是空串） */
    genre: string
    audience: string
    /** 交出去的时刻（epoch 秒） */
    at: number
    at_iso: string
    reviewed: boolean
    due_in_days: number
  } | null
  count: number
  /** 交付目录里一共有几份（含没到点的） */
  total: number
  window_days: number
}
