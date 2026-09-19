/** 学习地图那四档的**一套词、一套色**（P2 · F13）。
 *
 *  为什么单独一个文件：这四档现在有两处读者——学页那张地图（档位标签 + 分组小标题）
 *  和零柒小屋里的**概念卡**（F13 的后半：把地图的镜像摆进屋里）。词与色各写一遍，
 *  两处迟早各说一套（一处叫「在学」、另一处叫「学过」，色号差一档），而它们说的是
 *  同一件事。
 *
 *  后端那半边（`pet_room.CONCEPT_STATES`）只给**档位名**、不发词：词与色是界面的事。
 *  两边同形有测试盯着（`tests/test_pet_room.py` 那条「屋里那三档与地图的三档同形」）。
 *
 *  「未触及」也在这张表里（地图上它就是第四档标签），但**屋里没有这一档**——
 *  那是「拆出来还没开成教」的点，一张「还没做的事」的清单，小屋不摆账。
 */
export type ConceptState = 'mastered' | 'learning' | 'stuck' | 'untouched'

export interface ConceptStateStyle {
  key: ConceptState
  /** 界面上就写这两个字 */
  label: string
  /** 选中的档位标签：底 + 边 + 字 + ring */
  chip: string
  /** 分组小标题那行字（只有颜色那一半） */
  text: string
  /** 概念卡整张卡：底 + 边。**认不出来的档不给颜色**（见下面那个兜底） */
  card: string
}

export const CONCEPT_STATE: Record<ConceptState, ConceptStateStyle> = {
  mastered: {
    key: 'mastered',
    label: '已掌握',
    chip: 'border-emerald-300 bg-emerald-50 text-emerald-700 ring-emerald-200 dark:border-emerald-500/40 dark:bg-emerald-500/10 dark:text-emerald-300 dark:ring-emerald-500/30',
    text: 'text-emerald-600 dark:text-emerald-400',
    card: 'border-emerald-200 bg-emerald-50/40 dark:border-emerald-500/30 dark:bg-emerald-500/5',
  },
  learning: {
    key: 'learning',
    label: '在学',
    chip: 'border-sky-300 bg-sky-50 text-sky-700 ring-sky-200 dark:border-sky-500/40 dark:bg-sky-500/10 dark:text-sky-300 dark:ring-sky-500/30',
    text: 'text-sky-600 dark:text-sky-400',
    card: 'border-sky-200 bg-sky-50/40 dark:border-sky-500/30 dark:bg-sky-500/5',
  },
  stuck: {
    key: 'stuck',
    label: '卡住',
    chip: 'border-amber-300 bg-amber-50 text-amber-700 ring-amber-200 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-500/30',
    text: 'text-amber-600 dark:text-amber-400',
    card: 'border-amber-200 bg-amber-50/40 dark:border-amber-500/30 dark:bg-amber-500/5',
  },
  untouched: {
    key: 'untouched',
    label: '未触及',
    chip: 'border-neutral-300 bg-neutral-100 text-neutral-600 ring-neutral-200 dark:border-neutral-600 dark:bg-neutral-800 dark:text-neutral-300 dark:ring-neutral-500/30',
    text: 'text-neutral-500 dark:text-neutral-400',
    card: 'border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900',
  },
}

/** 四档的顺序 = 地图上的顺序（已掌握 / 在学 / 卡住 / 未触及），界面按它摆。 */
export const CONCEPT_STATES: ConceptStateStyle[] = [
  CONCEPT_STATE.mastered,
  CONCEPT_STATE.learning,
  CONCEPT_STATE.stuck,
  CONCEPT_STATE.untouched,
]

/** 档位名 → 那一档的词与色。**认不出来返回 null**：后端哪天加了新档，
 *  界面照实把档位名显示出来，而不是猜一个颜色糊上（猜出来的颜色是假信息）。
 *
 *  `hasOwnProperty` 那一步不是多余的：`STATE['constructor']` 会从原型链上捞到一个函数，
 *  于是「认不出来」变成「认出来了一个函数」。 */
export function conceptState(key: string): ConceptStateStyle | null {
  if (!Object.prototype.hasOwnProperty.call(CONCEPT_STATE, key)) return null
  return (CONCEPT_STATE as Record<string, ConceptStateStyle>)[key]
}
