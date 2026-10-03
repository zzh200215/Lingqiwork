import { Pencil, RotateCcw } from 'lucide-react'

import SkinPreview from './SkinPreview'
import { useTheme } from './ThemeProvider'
import { GroupHead } from './SettingsUI'
import { SKIN_TAGS } from './skinGallery'

/** **当前皮肤**——皮肤中心的开门第一块。
 *
 *  ## 它与皮肤库那张小卡不是同一个问题
 *
 *  小卡回答「这套皮肤大概什么样」，这一块回答「**我现在这个工作台具体长什么样**」
 *  ——所以它的预览比任何一张卡都大，且跟着生效值走（皮肤 + 用户的覆盖）。
 *  「正在使用」那枚徽章把「这套已经套在屏幕上了」说成一眼可见的状态，
 *  而不是让人去十一张卡里找哪张带勾。
 *
 *  ## 换皮肤时那一下淡入
 *
 *  预览按 `skin.id` 作 key，换肤时整块重挂 + 0.25s 淡入（`animate-fade-in`，
 *  全站已有的一条动画）。**轻微**是刻意的：这是一次确认（「换了， indeed 换了」），
 *  不是一场表演——大动画会让连着试三套皮肤的人等动画。
 *
 *  ## 三个出口各管一件事
 *
 *  · **编辑皮肤** → 展开「高级调整」折叠区（通透 / 模糊 / 强调色 / 存成新皮肤）；
 *  · **恢复默认外观** → 整份设置回到出厂（`ThemeProvider.reset`，不动导入的皮肤）；
 *  · 明暗在这里而不在画廊里：它是**正交的一维**——摆进皮肤网格会让人以为
 *    「暗色」也是一种皮肤，摆在当前皮肤边上才是「这块屏幕现在亮着还是暗着」。 */
export default function SkinHero({ onEdit }: { onEdit: () => void }) {
  const { config, resolved, setMode, reset } = useTheme()
  const skin = resolved.skin
  const tags = SKIN_TAGS[skin.id] ?? []

  return (
    <div className="wb-card" data-skin-hero="">
      <GroupHead
        title="当前皮肤"
        description="这块屏幕现在的样子。预览跟着生效值走——皮肤给了底色，你拨过的通透度也画在里面。"
        actions={
          <>
            <button
              onClick={onEdit}
              data-skin-edit=""
              className="flex items-center gap-1.5 rounded-md border border-neutral-300 px-2.5 py-1.5 text-xs font-medium transition-colors hover:border-violet-400 hover:text-violet-600 dark:border-neutral-700 dark:text-neutral-300 dark:hover:border-violet-500/50 dark:hover:text-violet-300"
            >
              <Pencil className="h-3.5 w-3.5" />
              编辑皮肤
            </button>
            <button
              onClick={reset}
              data-appearance-reset=""
              className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-800 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              恢复默认外观
            </button>
          </>
        }
      />
      <div className="p-5">
      {/* 大预览：**它跟着生效值走**——皮肤给了底色，用户拨过的通透度也画在里面。 */}
      <SkinPreview
        key={`${skin.id}-${resolved.dark}`}
        skin={skin}
        dark={resolved.dark}
        className="h-44 w-full animate-fade-in sm:h-56"
        rounded="rounded-lg"
      />

      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="text-sm font-medium">{skin.label}</span>
        <span
          data-skin-active-badge=""
          className="rounded-full bg-violet-100 px-2 py-0.5 text-xs font-medium text-violet-700 dark:bg-violet-500/15 dark:text-violet-300"
        >
          正在使用
        </span>
        {tags.map((t) => (
          <span
            key={t}
            className="rounded-full bg-neutral-100 px-1.5 py-0.5 text-xs text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400"
          >
            {t}
          </span>
        ))}
        <span className="text-xs text-neutral-400">{skin.hint}</span>
      </div>

      {/* 明暗：与皮肤分开成一行，因为它是**正交**的一维——暗色不是「一种皮肤」 */}
      <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-neutral-200/80 pt-4 dark:border-neutral-800/80">
        <span className="text-sm">明暗</span>
        <div className="flex rounded-md border border-neutral-200 p-0.5 dark:border-neutral-700">
          {[
            { v: 'light' as const, label: '亮色' },
            { v: 'dark' as const, label: '暗色' },
            { v: 'system' as const, label: '跟随系统' },
          ].map((o) => (
            <button
              key={o.v}
              data-appearance-mode={o.v}
              aria-pressed={config.mode === o.v}
              onClick={() => setMode(o.v)}
              className={`rounded-[5px] px-3 py-1 text-sm transition-colors ${
                config.mode === o.v
                  ? 'bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900'
                  : 'text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200'
              }`}
            >
              {o.label}
            </button>
          ))}
        </div>
        <span className="text-xs text-neutral-400">
          {config.mode === 'system' ? (
            <>
              现在系统是{resolved.dark ? '暗色' : '亮色'}——系统自己换的时候这里跟着换，不用回来点
            </>
          ) : (
            '暗色下会换用这套皮肤的另一组值，不是简单地把亮色反相'
          )}
        </span>
      </div>
      </div>
    </div>
  )
}
