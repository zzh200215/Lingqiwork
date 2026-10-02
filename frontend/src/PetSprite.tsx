import type { CSSProperties, ImgHTMLAttributes } from 'react'

import { useTheme } from './ThemeProvider'
import { asPetAction, petSprite } from './petFace'

/** 零柒的一张脸——**四个渲染点共用这一个组件**（悬浮挂件 / 置顶小窗 / 陪伴页 / 小屋）。
 *
 *  ## 图从哪来
 *
 *  皮肤给了 `pet.sprite` 就画皮肤那张（**一套皮肤可以换一只「零柒」**，见
 *  `manifest.ts` 的 `SkinPetManifest`——「挂件风格」是皮肤三条腿里最后一条）；
 *  没给就是内置的动作 webp。动作清单与拼路径仍在 `petFace` 一处——
 *  这里只多「要不要用皮肤那张」一个分叉，不抄第二份清单。
 *
 *  ## 加载失败逐级退回
 *
 *  皮肤那张图挂了（被清了、跨域坏了）不该让零柒从屏幕上消失：
 *  **自定义图 → 内置动作 webp → `/pet-avatar.png`**，退到哪一级记在 `dataset`
 *  上，onError 顺着走。`key` 里含自定义图地址——换皮肤（或换图）时整张
 *  `<img>` 重挂，退回级数跟着清零，不会出现「换回好图却停在兜底上」。
 *
 *  其余属性（小屋的 `data-room-*` 锚点等）原样透传给 `<img>`——调用方
 *  原来把锚点写在 img 上，测试靠着它们，换了组件不能把锚点弄丢。 */
export default function PetSprite({
  action,
  className = '',
  style,
  ...rest
}: {
  action: string | undefined | null
  className?: string
  style?: CSSProperties
} & Omit<ImgHTMLAttributes<HTMLImageElement>, 'src' | 'alt' | 'onError'> &
  Record<`data-${string}`, string | undefined>) {
  const { resolved } = useTheme()
  const custom = resolved.skin.pet?.sprite
  const act = asPetAction(action)
  return (
    <img
      {...rest}
      key={`${act}|${custom ?? ''}`}
      src={custom ?? petSprite(act)}
      alt="零柒"
      data-pet-action={act}
      className={className}
      style={style}
      onError={(e) => {
        const img = e.currentTarget
        const step = img.dataset.petSpriteFb ?? ''
        if (!step && custom) {
          img.dataset.petSpriteFb = 'builtin'
          img.src = petSprite(act)
          return
        }
        if (step !== 'avatar') {
          img.dataset.petSpriteFb = 'avatar'
          img.src = '/pet-avatar.png'
        }
      }}
    />
  )
}
