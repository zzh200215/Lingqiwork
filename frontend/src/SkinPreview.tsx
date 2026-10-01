import { panelAlpha } from './theme/surfaces'
import { hexToRgb } from './theme/color'
import type { Skin, SkinVariant } from './theme'

/** `#rrggbb` + 0–1 → `rgba(...)`。图省事的地方都用它，避免每个调用点各写一遍解析。 */
function alpha(hex: string, a: number): string {
  const c = hexToRgb(hex)
  return c ? `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${a})` : hex
}

/** 一张皮肤**长什么样**——按它自己的色值现画一个微缩的工作台。
 *
 *  ## 为什么不放一张缩略图
 *
 *  缩略图有两个绕不过去的问题：**加一套皮肤就要多准备一张图**，而且它必然与
 *  真实配色分叉（改了一个色号，缩略图不会跟着变，直到有人点进去才发现不对）。
 *  现画没有这两个问题：加皮肤时预览自动就对。
 *
 *  ## 画的是**整个工作台**，不是一块色卡
 *
 *  一块「底色 + 一个强调色方块」只能说明「这套配色是什么」，说明不了
 *  「换上它之后这里会变成什么样」——而后者才是选皮肤时想知道的事。
 *  所以这个微缩里七层都在：**底图与压暗 / 侧栏 / 顶栏 / 卡片 / 输入条 / 浮层 /
 *  强调色**。一个面板半透明的皮肤，在这个缩略里就能看出「侧栏是透的、卡片也是透的」，
 *  而一块色卡永远说不出这件事。
 *
 *  每一层取**自己那一档**（`sidebarGlass` / `topbarGlass` / `glass` /
 *  `fieldGlass` / `floatGlass`）：把五个区域画成同一档的话，预览就是在骗人——
 *  「侧栏比卡片深一档」这种皮肤必须在这个缩略里就看得出来。
 *
 *  ## 它读的是**皮肤数据**，不是 CSS 变量
 *
 *  这一点是有意的：皮肤库里要同时摆出十几套皮肤的预览，而同一时刻只有一套生效。
 *  读变量的话，所有卡片都会画成当前那一套——「预览」就成了一个笑话。 */
export default function SkinPreview({
  skin,
  dark,
  className = '',
  rounded = 'rounded-md',
}: {
  skin: Skin
  dark: boolean
  className?: string
  rounded?: string
}) {
  const v: SkinVariant = dark ? skin.dark : skin.light
  const bg = v.bg
  // **每一层取自己那一档**，不再拿壳那一档当所有人的值：分区域是这套皮肤系统里
  // 最要紧的一件事，而预览要是把五个区域画成同一档，它就是在骗人——
  // 「侧栏比卡片深一档」这种皮肤在这个缩略里必须看得出来。
  const sideA = v.surfaces.sidebarGlass / 100
  const topA = v.surfaces.topbarGlass / 100
  const cardA = panelAlpha('card', v.surfaces.glass) / 100
  const fieldA = panelAlpha('field', v.surfaces.fieldGlass) / 100
  const floatA = panelAlpha('float', v.surfaces.floatGlass) / 100
  const shadowA = v.surfaces.shadow / 100

  return (
    <span
      className={`relative block overflow-hidden border border-black/10 dark:border-white/10 ${rounded} ${className}`}
      style={{ backgroundColor: v.pageBg }}
      aria-hidden="true"
    >
      {/* 底图 + 压暗：这两层是「氛围」，它们决定整套皮肤站在什么样的光里 */}
      {bg ? (
        <>
          <span
            className="pointer-events-none absolute inset-0"
            style={{
              backgroundImage: `url("${bg.image}")`,
              backgroundSize: bg.fit === 'repeat' ? undefined : bg.fit,
              backgroundRepeat: bg.fit === 'repeat' ? 'repeat' : 'no-repeat',
              backgroundPosition:
                bg.fit === 'repeat' ? 'top left' : `${bg.focusX ?? 50}% ${bg.focusY ?? 50}%`,
              transform: (bg.zoom ?? 100) > 100 ? `scale(${(bg.zoom ?? 100) / 100})` : undefined,
              opacity: (bg.opacity ?? 100) / 100,
            }}
          />
          {/* 色调薄纱：与真界面同序——图 → 色调 → 压暗 */}
          {bg.tint && bg.tint.color && bg.tint.alpha > 0 ? (
            <span
              className="pointer-events-none absolute inset-0"
              style={{ backgroundColor: alpha(bg.tint.color, bg.tint.alpha / 100) }}
            />
          ) : null}
          <span
            className="pointer-events-none absolute inset-0"
            style={{ backgroundColor: dark ? `rgba(0,0,0,${bg.scrim / 100})` : `rgba(255,255,255,${bg.scrim / 100})` }}
          />
        </>
      ) : null}

      {/* 侧栏：一整条竖边，里面几道导航条 */}
      <span
        className="absolute inset-y-0 left-0 flex w-[22%] flex-col gap-[6%] p-[4%]"
        style={{ backgroundColor: alpha(v.chrome, sideA) }}
      >
        <span className="h-[9%] w-full rounded-[2px]" style={{ backgroundColor: alpha(v.accent, 0.9) }} />
        {[0.5, 0.35, 0.4].map((w, i) => (
          <span
            key={i}
            className="h-[6%] rounded-[2px]"
            style={{ width: `${w * 100}%`, backgroundColor: alpha(v.chrome, 0.16) }}
          />
        ))}
      </span>

      {/* 顶栏：与侧栏**同色但各自一档**——壳「是一个区域」是默认，不是禁令 */}
      <span
        className="absolute inset-x-0 top-0 flex h-[16%] items-center gap-[3%] pl-[25%] pr-[4%]"
        style={{ backgroundColor: alpha(v.chrome, topA) }}
      >
        <span className="h-[38%] w-[26%] rounded-[2px]" style={{ backgroundColor: alpha(v.chrome, 0.18) }} />
        <span className="ml-auto h-[38%] w-[12%] rounded-[2px]" style={{ backgroundColor: alpha(v.chrome, 0.12) }} />
      </span>

      {/* 主区：两张卡片。卡片那一档的不透明度与真界面同源（`panelAlpha('card', …)`），
          所以「这套皮肤的面板透不透」在这里就能看出来。 */}
      <span className="absolute inset-x-0 bottom-0 left-[22%] right-0 top-[16%] flex flex-col gap-[5%] p-[4%]">
        <span className="flex gap-[4%]">
          {[0, 1].map((i) => (
            <span
              key={i}
              className="h-[42px] flex-1 rounded-[3px] border border-black/5 dark:border-white/10"
              style={{ backgroundColor: alpha(v.surface, cardA) }}
            />
          ))}
        </span>
        {/* 输入条：**它有自己的下限**（`FIELD_FLOOR`），所以在这个缩略里
            永远是几层里最实的一层——预览不需要解释这件事，看两次就看出来了 */}
        <span
          className="mt-auto flex h-[16%] min-h-[9px] items-center rounded-[3px] border border-black/5 px-[3%] dark:border-white/10"
          style={{ backgroundColor: alpha(v.surface, fieldA) }}
        >
          <span className="h-[30%] w-[40%] rounded-[2px]" style={{ backgroundColor: alpha(v.chrome, 0.14) }} />
          <span
            className="ml-auto h-[70%] w-[14%] rounded-[2px]"
            style={{ backgroundColor: alpha(v.accent, 0.95) }}
          />
        </span>
      </span>

      {/* 浮层：一个挂在内容**上面**的下拉。它是这一层里唯一该有阴影的东西
          （契约说分层靠边框、阴影只留给浮在上面的），而那正是 `shadow` 这个旋钮
          唯一作用的地方——所以预览里必须有一个浮层，否则拖它看不出任何变化。 */}
      <span
        className="absolute left-[27%] top-[26%] flex h-[30%] w-[30%] flex-col gap-[8%] rounded-[3px] border border-black/10 p-[3%] dark:border-white/15"
        style={{
          backgroundColor: alpha(v.surface, floatA),
          boxShadow: `0 6px 16px rgba(0,0,0,${(dark ? 0.5 : 0.18) * shadowA})`,
        }}
      >
        <span className="h-[12%] w-[70%] rounded-[2px]" style={{ backgroundColor: alpha(v.chrome, 0.22) }} />
        <span className="h-[12%] w-[85%] rounded-[2px]" style={{ backgroundColor: alpha(v.chrome, 0.14) }} />
        <span className="h-[12%] w-[55%] rounded-[2px]" style={{ backgroundColor: alpha(v.chrome, 0.14) }} />
      </span>
    </span>
  )
}
