/** 零柒的九个姿势，与那道闸——**只能有一份**。
 *
 *  小屋（`RoomPane`）与悬浮的零柒（`PetWidget`）画的是同一只宠物：两边各抄一份清单，
 *  迟早分叉（`public/pet/` 里加了新图、或服务端加了新模式，总有一处忘了改），而症状是
 *  一张破图——**不是报错，所以没人会发现**。
 *
 *  这与后端 `pet_state.ACTIONS` 是同一份清单的两侧；那边的
 *  `test_every_mapped_action_is_a_real_file` 与 `test_every_action_value_is_in_the_atlas`
 *  守着「服务端映射出来的动作真的落在 `frontend/public/pet/` 里」。
 */

export type PetAction =
  | 'idle'
  | 'waving'
  | 'jumping'
  | 'failed'
  | 'waiting'
  | 'running'
  | 'running-right'
  | 'running-left'
  | 'review'

/** 九个动画的运行时清单。服务端日后可能加新模式，也可能发来一个手滑的字符串；
 *  落到界面上就是一张破图。这里当一道闸：不认识的一律退回 idle。 */
export const PET_ACTIONS: PetAction[] = [
  'idle',
  'waving',
  'jumping',
  'failed',
  'waiting',
  'running',
  'running-right',
  'running-left',
  'review',
]

export function asPetAction(a: string | undefined | null): PetAction {
  return a && (PET_ACTIONS as string[]).includes(a) ? (a as PetAction) : 'idle'
}

/** 姿势对应的图。**拼路径这件事也只留一处**：拼错了就是 404，而 404 是静默的。 */
export function petSprite(a: string | undefined | null): string {
  return `/pet/${asPetAction(a)}.webp`
}
