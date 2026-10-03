import { useState } from 'react'
import { BookmarkPlus, Save } from 'lucide-react'

import { useTheme } from './ThemeProvider'
import { GroupHead } from './SettingsUI'
import { isBuiltinSkin, type SkinManifest, type VariantManifest } from './theme'
import { newPhotoId } from './theme/extract'
import { SKIN_FORMAT } from './theme/manifest'
import {
  PANEL_FLOOR,
  applyOverrides,
  hasOverrides,
  surfFloor,
  surfValue,
  SURF_RANGE,
  type SkinSurfaces,
  type SurfKey,
} from './theme/surfaces'
import { inputCls } from './settingsShared'

/** 「高级调整」里的**分区域面板**：八个旋钮 + 「存成新皮肤」的出口。
 *
 *  （当前皮肤的大预览与「恢复默认」在页首的 `SkinHero`——大预览是挑与看的东西，
 *  离画廊近；这里是调的东西，收在折叠区里。两者各答各的问题，别再挤在一起。）
 *
 *  ## 分区域：八个旋钮，不是两个
 *
 *  早先只有「面板通透度」与「面板模糊」两根滑块。那时面板层只有一个入口，
 *  而现在数据层是**分区域**的（`theme/surfaces.ts` 的 `SURF_KEYS`）——
 *  侧栏、顶栏、卡片、输入框、浮层各自一档，界面上就得各自一根。
 *  只给两根的话，「侧栏比卡片深一档」这件事只有写皮肤的人做得到，
 *  而换肤这件事的一半用户价值恰恰在「拨出来」。
 *
 *  两根变八根不是把界面变复杂：**「跟随」是默认**。八个值里没拨过的都跟着
 *  皮肤（拖动主旋钮时没单独拨过的还会跟着一起走，见 `applyOverrides`），
 *  所以一个人什么都不用拨就得到一套完整的皮肤；想分的人才分。
 *  界面上没有任何一个是「必须先设置」的。
 *
 *  ## 旋钮的下限就是那一层的地板
 *
 *  卡片 55 / 输入框 80 / 浮层 95 / 边框 55 是**能不能用**的下限（`PANEL_FLOOR`）。
 *  滑块的下限直接取那几个数，而不是 0：一个能拨到 0 而渲染出来是 55 的滑块
 *  是在骗人（「我明明拨到底了，怎么还这么实」）。显示的数与看到的像素
 *  是同一个数——`surfValue()` 就是那个数。
 *
 *  ## 存成新皮肤 / 保存修改 = 把生效值固化
 *
 *  「自定义皮肤可以保存」的出口。存的是**生效值**而不是「皮肤 + 覆盖」：
 *  用户拨出来的这一套东西就是他想要的那套，而一份「皮肤 + 三个覆盖项」
 *  换台机器打开时，任何一个覆盖项丢了都会变成另一套外观。
 *
 *  出口有两个，按**当前皮肤是谁的**分叉：
 *  · 内置皮肤 → **存成新皮肤**（生成一个新 id，进「我的皮肤」）；
 *  · 用户皮肤 → **保存修改**（同一个 id 覆盖回去——这就是「编辑我的皮肤」：
 *    套用 → 拨旋钮 → 保存。不改 id，改名走卡片上那支笔）。 */
export default function SkinCenter() {
  const { config, resolved, setSurface, clearSurfaces, addSkin, setSkin } = useTheme()
  const [notice, setNotice] = useState('')
  const [name, setName] = useState('')
  const [naming, setNaming] = useState(false)

  const surf: SkinSurfaces = resolved.surfaces
  const custom = hasOverrides(config.surfaces)
  /** 当前套着的是不是自己装的皮肤 → 这一块是「编辑」还是「另存」。 */
  const editing = !isBuiltinSkin(config.skin)

  /** 把**现在生效的这一套**存下来。`editing` 时覆盖回原来的 id（保存修改），
   *  否则生成一个新 id（存成新皮肤）。两条路存的都是**生效值**：
   *  皮肤给一套、用户拨过的覆盖叠上去之后的结果。 */
  function save(name: string): void {
    const variant = (side: 'light' | 'dark'): VariantManifest => {
      const sv = side === 'light' ? resolved.skin.light : resolved.skin.dark
      const out: VariantManifest = {
        accent: sv.accent,
        pageBg: sv.pageBg,
        // **生效值**，不是皮肤那一份：`config.surfaces` 是用户拨过的覆盖，
        // 而「存成新皮肤」要存下来的正是他现在看到的这一套。
        // 直接用 `sv.surfaces` 的话，拨到 40 再存，存下来的还是皮肤原本的 82
        // ——而界面上明明写着「存的是现在生效的这一套」。
        surfaces: applyOverrides(sv.surfaces, config.surfaces),
        // 图表色**跟着原皮肤走**：这是修正「另存会丢图表配色」的一笔——
        // 以前这里不写 chart，导出与运行时都退回默认调色板，深海存的副本
        // 图表变成了出厂蓝绿。与 `skinToManifest` 同一条规矩（chart 恒写）。
        chart: sv.chart,
      }
      // 底图只在这一刻**生效的是图**的时候才写进去——用户把背景换成纯色之后
      // 再存一份皮肤，那套皮肤不该还带着一张看不见的图。
      if (config.bg.mode === 'image' || (config.bg.mode === 'skin' && sv.bg)) {
        const src = config.bg.mode === 'image' ? config.bg : null
        out.bg = src
          ? {
              image: src.image,
              fit: src.fit,
              scrim: src.scrim,
              scrimDir: src.scrimDir,
              blur: src.blur,
              focusX: src.focusX,
              focusY: src.focusY,
              zoom: src.zoom,
              opacity: src.opacity,
              tint: src.tint,
            }
          : sv.bg
      }
      return out
    }
    const manifest: SkinManifest = editing
      ? {
          format: SKIN_FORMAT,
          id: config.skin,
          label: (name.trim() || resolved.skin.label).slice(0, 16),
          hint: resolved.skin.hint || undefined,
          author: resolved.skin.author,
          particles: resolved.skin.particles === 'sakura' ? undefined : resolved.skin.particles,
          accent: resolved.accent,
          light: variant('light'),
          dark: variant('dark'),
        }
      : {
          format: SKIN_FORMAT,
          id: newPhotoId().replace(/^photo-/, 'mine-'),
          label: (name.trim() || '我的皮肤').slice(0, 16),
          hint: '从当前外观存下来的',
          accent: resolved.accent,
          light: variant('light'),
          dark: variant('dark'),
        }
    const report = addSkin(manifest)
    if (!report.added.length && !report.replaced.length) {
      setNotice(`没存上：${report.refused.map((r) => r.reason).join('；') || '未知原因'}`)
      return
    }
    if (!editing) setSkin(manifest.id)
    // 存成皮肤之后，那一层覆盖就该让位了——它已经被写进新皮肤的数据里，
    // 留着的话「跟随皮肤」与「覆盖」会同时生效，而它们说的是同一件事。
    clearSurfaces()
    setNaming(false)
    setName('')
    setNotice(
      editing
        ? `已把修改保存进「${manifest.label}」`
        : `已存成「${manifest.label}」，进了「我的皮肤」并切了过去`
    )
  }

  return (
    <section data-skin-center="" className="flex flex-col gap-4">
      <GroupHead
        bare
        title="分区域微调"
        description={`没拨过的跟着「${resolved.skin.label}」走——只拖第一根就是整套界面一起通透。`}
        actions={
          <button
            onClick={() => setNaming((v) => !v)}
            data-skin-save=""
            className="flex items-center gap-1.5 rounded-md border border-neutral-300 px-2 py-1 text-xs transition-colors hover:border-violet-400 hover:text-violet-600 dark:border-neutral-700 dark:text-neutral-300 dark:hover:border-violet-500/50 dark:hover:text-violet-300"
          >
            {editing ? <Save className="h-3.5 w-3.5" /> : <BookmarkPlus className="h-3.5 w-3.5" />}
            {editing ? '保存修改' : '存成新皮肤'}
          </button>
        }
      />

      {naming ? (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') save(name)
              if (e.key === 'Escape') setNaming(false)
            }}
            placeholder="给这套皮肤起个名字"
            spellCheck={false}
            data-skin-save-name=""
            className={`${inputCls} max-w-[220px]`}
          />
          <button
            onClick={() => save(name)}
            data-skin-save-confirm=""
            className="wb-btn-primary px-3 py-1.5 text-sm"
          >
            存下来
          </button>
          <span className="text-xs text-neutral-400">
            {editing
              ? `覆盖「${resolved.skin.label}」——存的是现在生效的这一套（含你拨过的通透度与背景）`
              : '存的是现在生效的这一套（含你拨过的通透度与背景）'}
          </span>
        </div>
      ) : null}

      <div>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">分区域</h3>
          {custom ? (
            <button
              onClick={clearSurfaces}
              data-skin-follow=""
              className="text-xs text-neutral-500 underline hover:text-neutral-800 dark:hover:text-neutral-200"
            >
              全部跟随皮肤（{resolved.skin.label} 自己那档）
            </button>
          ) : (
            <span className="text-xs text-neutral-400">
              每一项都是「{resolved.skin.label}」自己那档
            </span>
          )}
        </div>

        <div className="grid gap-x-6 gap-y-2.5 sm:grid-cols-2">
          {SURF_ROWS.map((row) => (
            <SurfRow
              key={row.key}
              row={row}
              value={surfValue(surf, row.key)}
              min={surfFloor(row.key)}
              max={SURF_RANGE[row.key][1]}
              // 「这一项被拨过没有」问的是**覆盖表**，不是「值与皮肤不同」：
              // 一个皮肤本来就把侧栏定在 70，用户没拨过它，那 ↺ 不该出现
              // ——那个按钮的意思是「回到皮肤那一档」，而不是「回到某个基准值」。
              overridden={config.surfaces[row.key] !== undefined}
              onPick={(n) => setSurface(row.key, n)}
              onFollow={() => setSurface(row.key, null)}
            />
          ))}
        </div>

        <p className="mt-3 text-xs leading-relaxed text-neutral-400">
          没拨过的跟着「卡片与面板」走，所以只拖那一根就是整套界面一起通透；单独拨了某一项，
          它就定住了。输入框与浮层各有下限（{PANEL_FLOOR.field}% / {PANEL_FLOOR.float}%），
          边框的下限是 {PANEL_FLOOR.card}%——它们管的是「字还读不读得清、这一层还在不在」，
          不是风格，所以滑块到那儿就到底了。
        </p>
      </div>

      {notice ? (
        <p
          data-skin-center-notice=""
          className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300"
        >
          {notice}
        </p>
      ) : null}
    </section>
  )
}

/** 界面上的八行。**顺序与 `SURF_KEYS` 一致**（五个区域在前，三样整层的在后），
 *  名称与提示只在这一处——数据层那边管的是值域与跟随，不管怎么称呼它们。 */
const SURF_ROWS: { key: SurfKey; label: string; hint: string; suffix: string }[] = [
  { key: 'glass', label: '卡片与面板', hint: '', suffix: '%' },
  { key: 'sidebarGlass', label: '侧栏', hint: '', suffix: '%' },
  { key: 'topbarGlass', label: '顶栏', hint: '', suffix: '%' },
  { key: 'fieldGlass', label: '输入框', hint: '下限 ' + PANEL_FLOOR.field, suffix: '%' },
  { key: 'floatGlass', label: '浮层', hint: '下拉与弹窗', suffix: '%' },
  { key: 'blur', label: '模糊', hint: '有底图才看得出', suffix: 'px' },
  { key: 'borderAlpha', label: '边框', hint: '分层靠它', suffix: '%' },
  { key: 'shadow', label: '浮层阴影', hint: '只在浮层上', suffix: '%' },
]

/** 一行：名字 + 一根滑块 + 当前值 + （拨过才有的）回到皮肤那一档。
 *
 *  行内那根滑块**与面板层同源**：值来自 `surfValue()`（过下限之后的结果），
 *  下限来自 `surfFloor()`。所以「显示的数」「滑块到头的位置」「渲染出来的像素」
 *  是同一个数——三处各算一遍的话，最先出错的总是那个显示的数。 */
function SurfRow({
  row,
  value,
  min,
  max,
  overridden,
  onPick,
  onFollow,
}: {
  row: { key: SurfKey; label: string; hint: string; suffix: string }
  value: number
  min: number
  max: number
  overridden: boolean
  onPick: (v: number) => void
  onFollow: () => void
}) {
  return (
    // ↺ **在 `<label>` 外面**：button 也是「可被 label 标记的控件」，
    // 放进同一个 label 里，谁是谁的控件就取决于树序了——这种模糊在
    // 「点一下 ↺，结果聚焦到了滑块上」这类症状里才会暴露出来。
    <div className="flex items-center gap-2 text-sm">
      <label className="flex min-w-0 flex-1 items-center gap-2">
        <span className="flex w-24 shrink-0 flex-col leading-tight">
          <span className="truncate">{row.label}</span>
          {row.hint ? <span className="truncate text-xs text-neutral-400">{row.hint}</span> : null}
        </span>
        <input
          type="range"
          data-surf-slider={row.key}
          min={min}
          max={max}
          value={value}
          onChange={(e) => onPick(Number(e.target.value))}
          className="min-w-0 flex-1 accent-violet-600"
        />
        <span className="w-10 shrink-0 text-right text-xs tabular-nums text-neutral-400">
          {value}
          {row.suffix}
        </span>
      </label>
      <button
        type="button"
        onClick={onFollow}
        // 没拨过就**不占位**（`invisible` 而不是不渲染）：不这样的话，
        // 拨过一项会让整行左右跳一下——八行里任何一行的宽度变化都会带着滑块动。
        className={`w-4 shrink-0 text-xs text-neutral-400 transition-colors hover:text-violet-600 ${
          overridden ? '' : 'invisible'
        }`}
        data-surf-follow={row.key}
        title="这一项回到皮肤自己那档"
        aria-label={`${row.label}回到皮肤那一档`}
      >
        ↺
      </button>
    </div>
  )
}
