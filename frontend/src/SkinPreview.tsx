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
 *  所以这个微缩里该有的层都在：**底图与压暗 / 侧栏（带选中态）/ 顶栏 / 两张
 *  指标卡（带迷你图表）/ 一张清单卡 / 输入条 / 浮层**。画的不是几根矩形色块，
 *  而是一屏「真的有内容」的工作台——看一秒就该知道「套上之后我的屏幕是什么感觉」。
 *
 *  每一层取**自己那一档**（`sidebarGlass` / `topbarGlass` / `glass` /
 *  `fieldGlass` / `floatGlass`）：把五个区域画成同一档的话，预览就是在骗人——
 *  「侧栏比卡片深一档」这种皮肤必须在这个缩略里就看得出来。
 *
 *  ## 图表色也进预览
 *
 *  迷你柱状图与清单上的状态点用的是**皮肤自己的 chart 调色板**（`--wb-chart-*`
 *  的那五个值，首条柱子是强调色——与真界面同一条规则）。一套皮肤「图表好不好看」
 *  是换肤体验的一半，色卡式的预览永远说不了这件事。
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
  // 迷你图表的柱高：一段有起有落的形状，不是四根一样高的棍子
  const BARS = [0.5, 0.85, 0.62, 1]
  const listDot = (i: number): string => v.chart[i % v.chart.length]

  return (
    <span
      className={`relative block overflow-hidden border border-black/10 dark:border-white/10 ${rounded} ${className}`}
      style={{ backgroundColor: v.pageBg }}
      aria-hidden="true"
    >
      {/* 底图 + 色调 + 压暗：这两三层是「氛围」，它们决定整套皮肤站在什么样的光里 */}
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

      {/* 侧栏：logo + 导航（第一项是**选中态**——强调色在这里以「淡底 + 深字」出现，
          与真界面同一条规则）+ 底部的自己 */}
      <span
        className="absolute inset-y-0 left-0 flex w-[22%] flex-col gap-[6%] p-[4%]"
        style={{ backgroundColor: alpha(v.chrome, sideA) }}
      >
        <span className="flex h-[9%] min-h-[6px] items-center gap-[7%]">
          <span className="h-full min-w-[6px] rounded-[2px]" style={{ backgroundColor: alpha(v.accent, 0.95), aspectRatio: '1' }} />
          <span className="h-[3px] min-h-[2px] w-[55%] rounded-[2px]" style={{ backgroundColor: alpha(v.chrome, 0.35) }} />
        </span>
        <span className="flex flex-col gap-[7%]">
          <span
            className="flex items-center gap-[7%] rounded-[2px] px-[5%] py-[4%]"
            style={{ backgroundColor: alpha(v.accent, 0.14) }}
          >
            <span className="h-[4px] min-h-[2px] min-w-[4px] rounded-full" style={{ backgroundColor: alpha(v.accent, 0.95), aspectRatio: '1' }} />
            <span className="h-[3px] min-h-[2px] flex-1 rounded-[2px]" style={{ backgroundColor: alpha(v.accent, 0.85) }} />
          </span>
          {[0.62, 0.78].map((w, i) => (
            <span key={i} className="flex items-center gap-[7%] px-[5%] py-[4%]">
              <span className="h-[3px] min-h-[2px] min-w-[3px] rounded-full" style={{ backgroundColor: alpha(v.chrome, 0.3), aspectRatio: '1' }} />
              <span className="h-[3px] min-h-[2px] rounded-[2px]" style={{ width: `${w * 100}%`, backgroundColor: alpha(v.chrome, 0.16) }} />
            </span>
          ))}
        </span>
        <span className="mt-auto flex items-center gap-[7%]">
          <span className="h-[9px] min-h-[5px] rounded-full" style={{ backgroundColor: alpha(v.accent, 0.8), aspectRatio: '1' }} />
          <span className="h-[3px] min-h-[2px] flex-1 rounded-[2px]" style={{ backgroundColor: alpha(v.chrome, 0.14) }} />
        </span>
      </span>

      {/* 顶栏：面包屑 + 搜索胶囊 + 头像。与侧栏**同色但各自一档**——
          壳「是一个区域」是默认，不是禁令 */}
      <span
        className="absolute inset-x-0 top-0 flex h-[14%] min-h-[10px] items-center gap-[3%] pl-[25%] pr-[4%]"
        style={{ backgroundColor: alpha(v.chrome, topA) }}
      >
        <span className="h-[3px] min-h-[2px] w-[13%] rounded-[2px]" style={{ backgroundColor: alpha(v.chrome, 0.42) }} />
        <span className="h-[3px] min-h-[2px] w-[9%] rounded-[2px]" style={{ backgroundColor: alpha(v.chrome, 0.18) }} />
        <span
          className="ml-auto h-[58%] w-[20%] rounded-full border"
          style={{ borderColor: alpha(v.chrome, 0.25) }}
        />
        <span className="h-[62%] min-h-[5px] rounded-full" style={{ backgroundColor: alpha(v.accent, 0.9), aspectRatio: '1' }} />
      </span>

      {/* 主区：两张指标卡（迷你柱状图用**皮肤自己的图表色**）+ 一张清单卡 + 输入条。
          卡片那一档的不透明度与真界面同源（`panelAlpha('card', …)`），
          所以「这套皮肤的面板透不透」在这里就能看出来。 */}
      <span className="absolute inset-x-0 bottom-0 left-[22%] right-0 top-[14%] flex flex-col gap-[4%] p-[4%]">
        <span className="flex h-[38%] gap-[4%]">
          {[0, 1].map((i) => (
            <span
              key={i}
              className="flex min-w-0 flex-1 flex-col gap-[7%] rounded-[3px] border border-black/5 p-[6%] dark:border-white/10"
              style={{ backgroundColor: alpha(v.surface, cardA) }}
            >
              <span className="flex items-center justify-between">
                <span className="h-[3px] min-h-[2px] w-[46%] rounded-[2px]" style={{ backgroundColor: alpha(v.chrome, 0.25) }} />
                <span className="h-[4px] min-h-[3px] min-w-[4px] rounded-full" style={{ backgroundColor: listDot(i + 1), aspectRatio: '1' }} />
              </span>
              <span className="h-[16%] min-h-[5px] w-[52%] rounded-[2px]" style={{ backgroundColor: alpha(v.accent, 0.9) }} />
              <span className="mt-auto flex h-[34%] min-h-[7px] items-end gap-[8%]">
                {BARS.map((h, j) => (
                  <span
                    key={j}
                    className="min-w-[2px] flex-1 rounded-t-[1px]"
                    style={{
                      height: `${h * 100}%`,
                      backgroundColor: j === 0 ? alpha(v.accent, 0.95) : listDot(i + j),
                    }}
                  />
                ))}
              </span>
            </span>
          ))}
        </span>

        {/* 清单卡：状态点也用图表色——一个皮肤「图表与状态」的观感，色卡说不出来 */}
        <span
          className="flex min-h-0 flex-1 flex-col justify-center gap-[8%] rounded-[3px] border border-black/5 px-[5%] py-[6%] dark:border-white/10"
          style={{ backgroundColor: alpha(v.surface, cardA) }}
        >
          {[0, 1, 2].map((i) => (
            <span key={i} className="flex items-center gap-[6%]">
              <span className="h-[4px] min-h-[2px] min-w-[4px] shrink-0 rounded-full" style={{ backgroundColor: listDot(i + 1), aspectRatio: '1' }} />
              <span
                className="h-[3px] min-h-[2px] flex-1 rounded-[2px]"
                style={{ backgroundColor: alpha(v.chrome, i === 0 ? 0.34 : 0.18) }}
              />
              <span className="h-[3px] min-h-[2px] w-[11%] rounded-[2px]" style={{ backgroundColor: alpha(v.chrome, 0.12) }} />
            </span>
          ))}
        </span>

        {/* 输入条：**它有自己的下限**（`FIELD_FLOOR`），所以在这个缩略里
            永远是几层里最实的一层——预览不需要解释这件事，看两次就看出来了 */}
        <span
          className="mt-auto flex h-[15%] min-h-[9px] items-center rounded-[3px] border border-black/5 px-[3%] dark:border-white/10"
          style={{ backgroundColor: alpha(v.surface, fieldA) }}
        >
          <span className="h-[3px] min-h-[2px] w-[42%] rounded-[2px]" style={{ backgroundColor: alpha(v.chrome, 0.16) }} />
          <span
            className="ml-auto h-[62%] min-h-[5px] min-w-[5px] rounded-[2px]"
            style={{ backgroundColor: alpha(v.accent, 0.95), aspectRatio: '1' }}
          />
        </span>
      </span>

      {/* 浮层：一个挂在内容**上面**的下拉。它是这一层里唯一该有阴影的东西
          （契约说分层靠边框、阴影只留给浮在上面的），而那正是 `shadow` 这个旋钮
          唯一作用的地方——所以预览里必须有一个浮层，否则拖它看不出任何变化。 */}
      <span
        className="absolute left-[27%] top-[24%] flex h-[30%] min-h-[14px] w-[30%] flex-col gap-[10%] rounded-[3px] border border-black/10 p-[4%] dark:border-white/15"
        style={{
          backgroundColor: alpha(v.surface, floatA),
          boxShadow: `0 6px 16px rgba(0,0,0,${(dark ? 0.5 : 0.18) * shadowA})`,
        }}
      >
        <span className="h-[3px] min-h-[2px] w-[62%] rounded-[2px]" style={{ backgroundColor: alpha(v.accent, 0.75) }} />
        <span className="h-[3px] min-h-[2px] w-[85%] rounded-[2px]" style={{ backgroundColor: alpha(v.chrome, 0.16) }} />
        <span className="h-[3px] min-h-[2px] w-[55%] rounded-[2px]" style={{ backgroundColor: alpha(v.chrome, 0.16) }} />
      </span>
    </span>
  )
}
