import { Sparkles } from 'lucide-react'

import SkinPreview from './SkinPreview'
import { useTheme } from './ThemeProvider'
import { manifestToSkin, type SkinManifest } from './theme'
import type { ImageSkinReport } from './theme/extract'
import { MAX_LABEL } from './theme/manifest'

/** 「图片 → 皮肤」的**第二幕**：取色完成、还没落地的那个瞬间。
 *
 *  ## 为什么中间要有这一幕
 *
 *  以前这条路是一枪头的：选图 → 取色 → **装上并切过去**，然后摆一段解释。
 *  问题是「装上并切过去」发生在用户看到成品**之前**——他没得选。这一幕把
 *  决定权还给他：整套皮肤**已经按这张图配好了**（预览现画，与真的同一套推导），
 *  起个名字，然后三个出口：
 *
 *  · **使用这款皮肤** —— 落地并切过去（背景切回跟随、该换明暗就换）；
 *  · **存到我的皮肤** —— 只入库不切换，货架上也多一张卡；
 *  · **重新选一张** —— 什么都不动，取色的那几次计算白费就白费了。
 *
 *  ## 取色报告还在
 *
 *  「为什么按钮变绿了」依旧要答得上来——色块、色号、压暗与通透度的数字、
 *  托不住时的警告，全在下面的报告里。数字住在这里，**预览在最上面**：
 *  用户第一眼看到的是「你的新皮肤」，不是一堆参数。 */
export default function SkinCreator({
  draft,
  name,
  onName,
  onAccent,
  onApply,
  onKeep,
  onDiscard,
}: {
  draft: { manifest: SkinManifest; report: ImageSkinReport }
  name: string
  onName: (v: string) => void
  /** 换强调色（报告里那排色块）：改的是 manifest.accent，色阶由推导重出。 */
  onAccent: (hex: string) => void
  onApply: () => void
  onKeep: () => void
  onDiscard: () => void
}) {
  const { resolved, setMode } = useTheme()
  const r = draft.report
  const currentOk = resolved.dark ? r.okDark : r.okLight
  const currentRatio = resolved.dark ? r.ratioDark : r.ratioLight

  return (
    <div
      data-skin-creator=""
      className="mb-4 rounded-lg border border-violet-200 bg-violet-50/50 p-4 dark:border-violet-500/30 dark:bg-violet-500/10"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="flex items-center gap-1.5 text-sm font-medium">
            <Sparkles className="h-4 w-4 text-violet-500 dark:text-violet-300" />
            你的新皮肤已经生成
          </p>
          <p className="mt-0.5 text-xs text-neutral-500 dark:text-neutral-400">
            整个工作台已经按这张图配好色——先用预览看效果，再决定要不要。
          </p>
        </div>
      </div>

      {/* **预览是现画的**：与皮肤库那十一张、与「当前皮肤」那块大预览是同一个组件、
          同一套推导——这里看到的，就是「使用」之后屏幕上的样子。 */}
      <SkinPreview
        skin={manifestToSkin(draft.manifest)}
        dark={resolved.dark}
        className="mt-3 h-40 w-full"
        rounded="rounded-lg"
      />

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <input
          value={name}
          onChange={(e) => onName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onApply()
          }}
          maxLength={MAX_LABEL}
          placeholder={draft.manifest.label || '给这套皮肤起个名字'}
          spellCheck={false}
          data-skin-creator-name=""
          className="w-44 rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-sm dark:border-neutral-600 dark:bg-neutral-900"
        />
        <button onClick={onApply} data-skin-creator-apply="" className="wb-btn-primary px-3 py-1.5 text-sm">
          使用这款皮肤
        </button>
        <button onClick={onKeep} data-skin-creator-keep="" className="wb-btn-ghost px-3 py-1.5 text-sm">
          存到我的皮肤
        </button>
        <button
          onClick={onDiscard}
          data-skin-creator-dismiss=""
          className="text-xs text-neutral-500 underline hover:text-neutral-800 dark:hover:text-neutral-200"
        >
          重新选一张
        </button>
      </div>

      {/* ---------- 取色报告：为什么长这样，数字摆出来 ---------- */}
      <div
        data-skin-photo-report=""
        className="mt-3 rounded-lg border border-neutral-200 px-3 py-2 dark:border-neutral-800"
      >
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <span className="flex items-center gap-1.5 text-xs text-neutral-500">
            强调色
            <span
              className="h-4 w-4 rounded-full border border-neutral-200 dark:border-neutral-700"
              style={{ backgroundColor: draft.manifest.accent }}
            />
            <code className="font-mono">{draft.manifest.accent}</code>
          </span>
          {/* **强调色微调**：取色挑的那块不合口味，就从图里切出来的前几色里换一个
              ——全是这张图自己的颜色，怎么选都不会跳出这张图的气质（§8.11「一个
              皮肤 = 一套视觉语言」的下游义务）。换的只是强调色：色阶、面板通透、
              压暗都按这张图算好的不动，预览当场跟着变。 */}
          <span className="flex items-center gap-1" role="group" aria-label="换个强调色">
            {r.swatches.map((c) => (
              <button
                key={c}
                data-skin-creator-accent={c}
                aria-pressed={draft.manifest.accent === c}
                title={`把强调色换成 ${c}`}
                onClick={() => onAccent(c)}
                className={`rounded-sm outline-offset-1 transition-transform hover:scale-110 ${
                  draft.manifest.accent === c ? 'outline outline-2 outline-violet-500' : ''
                }`}
              >
                <span className="block h-4 w-6" style={{ backgroundColor: c }} />
              </button>
            ))}
          </span>
        </div>
        <p className="mt-1.5 text-xs leading-relaxed text-neutral-400">
          {r.chromatic
            ? '强调色取自图里最显眼的那一块，亮暗两套色阶都由它推出来。'
            : '这张图基本没有颜色，所以强调色用了它的平均灰——想要个彩色的话，套用之后在「高级调整 → 强调色」里自己填一个。'}
          {' '}压暗按这张图的明暗算好了：亮色 {r.scrimLight}%、暗色 {r.scrimDark}%（边缘加重，中间留给图）。
          {r.glass < 100 ? (
            <>
              {' '}面板通透度给到 {r.glass}%、模糊 {r.blur}px——
              这张图明暗拉得{r.spread > 0.5 ? '开' : '不算开'}
              ，透一点卡片就跟着它一起呼吸。
            </>
          ) : null}
          {' '}套用之后随时可以盖一层自己的压暗——你自己设的背景永远优先。
        </p>
        {/* 这个模式托不住这张图。**说清两件事**：差多少，以及为什么没有
            继续压——不然后半件看起来像没做完。再给一个切过去的出口。 */}
        {!currentOk ? (
          <p
            data-skin-photo-warn=""
            className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-2 py-1.5 text-xs leading-relaxed text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300"
          >
            这张图在{resolved.dark ? '暗色' : '亮色'}模式下托不住侧栏与顶栏那些小字
            （最不利的一处约 {currentRatio}:1，AA 要 4.5）。再往下压这张图就看不见了，
            所以没有继续压——压暗买不到多少对比度，图却会整片消失。
            <button
              onClick={() => setMode(resolved.dark ? 'light' : 'dark')}
              data-skin-photo-switch=""
              className="ml-1 underline"
            >
              切到{resolved.dark ? '亮色' : '暗色'}模式
            </button>
            ——那边要的是相反的方向，同一张图正好合适。
          </p>
        ) : null}
      </div>
    </div>
  )
}
