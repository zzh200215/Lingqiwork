import { useMemo, useRef, useState } from 'react'
import { Download, Loader2, Sparkles, Upload } from 'lucide-react'

import { api } from './api'
import AppearanceBackground from './AppearanceBackground'
import SkinCard from './SkinCard'
import SkinCenter from './SkinCenter'
import { useTheme } from './ThemeProvider'
import {
  accentPalette,
  isBuiltinSkin,
  listSkins,
  normalizeHex,
  skinById,
  userSkinManifests,
} from './theme'
import { skinFromImage, type ImageSkinReport } from './theme/extract'
import { contrastRatio, contrastWithWhite, hexToRgb } from './theme/color'
import {
  MAX_EXPORT_BYTES,
  buildExport,
  planImport,
  serializeExport,
  type ImportPlan,
} from './theme/transfer'
import { inputCls } from './settingsShared'

/** 「刚用一张图做出来的那套皮肤」。留在页面上是为了**把取色结果摆出来**：
 *  强调色换了是看得见的，但「为什么换成这个颜色」看不见——不摆出来的话，
 *  用户只会觉得「按钮怎么变绿了」。 */
interface PhotoMade {
  label: string
  report: ImageSkinReport
  /** 做之前用户自己设着背景（图 / 纯色 / 渐变），被切回「跟随皮肤」了 */
  wasOverriding: boolean
  /** 非空 = 顺手切到了这个明暗模式（当前那个托不住这张图）。值就是要显示的那两个字。 */
  switched: string
}

/** 设置 → 外观。
 *
 *  ## 它为什么长这样
 *
 *  换肤这件事有四层：**用哪套皮肤** → **亮还是暗** → **强调色** → **背景**。
 *  四层从抽象到具体排下来，用户从上面挑一个、再从下面微调，是自然的顺序；
 *  把「背景图上传」摆在最上面会让人以为换肤就是换壁纸。
 *
 *  所有改动**即时生效、自动保存**，没有「保存」按钮：外观是所见即所得的东西，
 *  一个需要点确认才生效的预览不算预览。持久化在 `ThemeProvider` 里（localStorage
 *  + 后端副本），这里只管把设置读出来、改回去。
 *
 *  ## 这一屏刻意不做的事
 *
 *  · 不做皮肤缩略图（那需要为每个皮肤准备一张图，加一个皮肤就要多一张，且必然与
 *    真实配色分叉）。预览是**用皮肤自己的色值现画的**：页面底色 + 一块卡片 + 一条
 *    强调色。加皮肤时预览自动就对。
 *  · 不做背景图滤镜预设、不做圆角/密度/字号。皮肤是外观的**大块**，
 *    剩下的旋钮留给真需要的人用自定义强调色与压暗层解决。 */
export default function AppearanceSettings() {
  const {
    config,
    resolved,
    setSkin,
    setMode,
    setAccent,
    patchBg,
    applyImport,
    addSkin,
    renameSkin,
    dropSkin,
    skinsRev,
  } = useTheme()
  /** 从图片做皮肤的那一次操作：忙着 / 做完了。 */
  const [skinBusy, setSkinBusy] = useState(false)
  const [photo, setPhoto] = useState<PhotoMade | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const importRef = useRef<HTMLInputElement>(null)
  const photoRef = useRef<HTMLInputElement>(null)

  /** 「用这张图做一套皮肤」。
   *
   *  与上面那个 `upload()` 是**两条不同的路**，两条都留着，因为它们回答的是两个问题：
   *    · `upload()` 换的是**背景**——图盖上去，强调色不动；
   *    · 这一条换的是**皮肤**——图 + 从图里取的强调色 + 按这张图算出来的压暗。
   *      它出现在皮肤表里，于是可以切走再切回来、可以改名、可以跟着导出。
   *
   *  看着像同一件事的两个入口，其实是「我就想换个底」与「我想让整个工作台变成
   *  这个样子」——后者正是人上传一张图时心里想的事。 */
  async function makeSkin(file: File) {
    setError('')
    setNotice('')
    if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) {
      setError('只支持 png / jpg / webp 图片')
      return
    }
    setSkinBusy(true)
    try {
      const item = await api.uploadImage(file)
      const made = await skinFromImage(item.url, file.name)
      if (!made.ok) {
        setError(`没做成皮肤：${made.reason}`)
        return
      }
      const report = addSkin(made.value.manifest)
      if (!report.added.length) {
        setError(`没装上：${report.refused.map((r) => r.reason).join('；') || '未知原因'}`)
        return
      }
      setSkin(made.value.manifest.id)
      // **背景要切回「跟随皮肤」。** 不切的话，原来自己设的那张背景图（或纯色、
      // 渐变）会盖在这套新皮肤上面——用户看到的是「我做了皮肤，屏幕上什么都没变」。
      // 那正是「上传了却没被选中」这一类困惑，只不过换了个地方发生。
      const wasOverriding = config.bg.mode !== 'skin'
      if (wasOverriding) patchBg({ mode: 'skin' })
      // **这张图在当前明暗下托不住、而另一边托得住 → 直接落过去。**
      // 用户点「用这张图做一款」要的是一个能用的结果，不是「一套读不清的皮肤 +
      // 一句警告」；而警告里那个按钮做的本来就是这同一个动作。
      // 只在「一边坏、另一边好」时才动——两边都好时不替他选（他可能特意开着跟随系统）。
      const r = made.value.report
      const currentOk = resolved.dark ? r.okDark : r.okLight
      const otherOk = resolved.dark ? r.okLight : r.okDark
      const switched = !currentOk && otherOk
      if (switched) setMode(resolved.dark ? 'light' : 'dark')
      setPhoto({
        label: made.value.manifest.label,
        report: r,
        wasOverriding,
        switched: switched ? (resolved.dark ? '亮色' : '暗色') : '',
      })
    } catch (e) {
      setError(`做皮肤失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setSkinBusy(false)
    }
  }

  /** 改名。失败的原因（名字太长、重名…）走这一页统一的错误条——
   *  `SkinCard` 只负责「改成了没有」，怎么说不该它管。 */
  function doRename(id: string, label: string): boolean {
    setError('')
    const got = renameSkin(id, label)
    if (!got.ok) {
      setError(`没改成：${got.reason}`)
      return false
    }
    return true
  }

  /** 导出：把当前设置与本机导入的皮肤写成一份文件。
   *
   *  用 `<a download>` + `Blob` 而不是「复制到剪贴板」：这是一份**档案**，它该落到
   *  磁盘上、该能进版本管理、该能在另一台机器上打开。复制到剪贴板的下一步动作
   *  多半是粘进聊天窗口，那会把「备份」变成「发消息」。 */
  function doExport() {
    setError('')
    const stamp = new Date().toISOString().slice(0, 10)
    const text = serializeExport(buildExport(config, userSkinManifests()))
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `外观设置-${stamp}.json`
    a.click()
    // 立刻撤销：Blob 的 URL 会一直把这份数据留在内存里，直到页面关掉
    URL.revokeObjectURL(url)
    setNotice(`已导出（含 ${userSkinManifests().length} 个导入的皮肤）`)
  }

  /** 导入：**先算出会发生什么，再决定要不要改**。见 `theme/transfer.ts`。 */
  async function doImport(file: File) {
    setError('')
    setNotice('')
    let text: string
    try {
      text = await file.text()
    } catch (e) {
      // 读不出来（文件在选完之后被删了、浏览器不给读、老环境没有 `Blob.text()`）
      // 也要有句话：静默什么都不发生的话，用户看到的是「点了没反应」。
      setError(`这个文件读不出来：${e instanceof Error ? e.message : String(e)}`)
      return
    }
    // 「装完之后会有哪些皮肤」= 内置 + 本机现有的 + 这份文件里认得的。
    // 这个集合要在动手之前算给 `planImport`——「装没装」的真相在注册表里，不在它那儿。
    const plan = planImport(text, userSkinManifests(), new Set(listSkins().map((s) => s.id)))
    if (!plan.ok) {
      setError(`导入失败：${plan.reason}`)
      return
    }
    applyImport(plan.value)
    // 说明里用**皮肤的名字**而不是 id：用户认的是卡上那两个字，
    // 而「已套用 sakura 这套皮肤」对他来说是一句关于内部标识的话。
    const label = plan.value.missingSkin
      ? plan.value.missingSkin
      : skinById(plan.value.config.skin).label
    setNotice(describePlan(plan.value, label))
  }

  const customAccent = normalizeHex(config.accent)
  // 对比度实时读数：`theme/color.ts` 的工具早就存在，接到界面上比写在文档里有用。
  // 强调色只有两种真实用法——按钮是**白字压强调色**，链接/选中态是**强调色字压页面底色**；
  // 两个数都对着 WCAG AA 的 4.5:1 说实话。皮肤自带的强调色也照量——够不够是用户的事，
  // 但「够不够」得看得见，而不是等哪天觉得按钮字发虚才想起这里。
  const accentHex = customAccent ?? normalizeHex(resolved.accent)
  const pageBgHex = normalizeHex(resolved.skin[resolved.dark ? 'dark' : 'light'].pageBg)
  const accentRgb = accentHex ? hexToRgb(accentHex) : null
  const pageBgRgb = pageBgHex ? hexToRgb(pageBgHex) : null
  const whiteOnAccent = accentRgb ? contrastWithWhite(accentRgb) : null
  const accentOnBg = accentRgb && pageBgRgb ? contrastRatio(accentRgb, pageBgRgb) : null
  // `listSkins()` 读的是注册表里那份模块级索引，React 看不见它什么时候变，
  // 所以这里把 `skinsRev`（装上 / 删掉皮肤时加一）显式写成依赖——
  // 少了它，导入成功的那一刻界面还是旧的皮肤表。
  const skins = useMemo(() => listSkins(), [skinsRev])

  return (
    <section className="mb-6 flex flex-col gap-6" data-appearance="">
      {/* ---------- 当前皮肤（皮肤中心的上半） ---------- */}
      <SkinCenter />

      {/* ---------- 皮肤库 ---------- */}
      <div className="wb-card p-5">
        <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-semibold">皮肤库</h2>
          <div className="flex flex-wrap items-center gap-2">
            {/* 入口摆在**皮肤表这一格**里，不摆到下面「自定义背景」那儿：
                用户在这里看到的是「有哪些皮肤」，那么「再加一款」也该在这里。
                这也是 Warp 的做法（主题选择器里一个 `+`）。 */}
            <button
              onClick={() => photoRef.current?.click()}
              disabled={skinBusy}
              data-skin-from-image=""
              className="flex items-center gap-1.5 rounded-md border border-neutral-300 px-2 py-1 text-xs transition-colors hover:border-violet-400 hover:text-violet-600 disabled:opacity-60 dark:border-neutral-700 dark:text-neutral-300 dark:hover:border-violet-500/50 dark:hover:text-violet-300"
            >
              {skinBusy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Sparkles className="h-3.5 w-3.5" />
              )}
              {skinBusy ? '取色中…' : '用图片做一款'}
            </button>
            <input
              ref={photoRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              data-skin-photo-file=""
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0]
                // 清空 value：同一个文件再选一次也要能触发 change
                e.target.value = ''
                if (f) void makeSkin(f)
              }}
            />
          </div>
        </div>
        <p className="mb-4 text-xs leading-relaxed text-neutral-500">
          皮肤决定强调色、页面底色、面板与侧栏的通透度。每个皮肤都有亮色和暗色两套值，
          顶栏那个月亮按钮切的是亮暗，不是换皮肤——所以换皮肤不会把你切到亮色去。
          传一张自己的图可以<b>现做一款</b>：强调色从图里取，压暗按这张图的明暗算。
        </p>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
          {skins.map((s) => (
            <SkinCard
              key={s.id}
              skin={s}
              dark={resolved.dark}
              active={config.skin === s.id}
              onPick={() => setSkin(s.id)}
              // 内置那六张不给删也不给改名：它们的定义在产品代码里，
              // 改了名下次构建就回来了，那是一次会被悄悄撤销的操作
              onRemove={isBuiltinSkin(s.id) ? undefined : () => dropSkin(s.id)}
              onRename={isBuiltinSkin(s.id) ? undefined : (label) => doRename(s.id, label)}
            />
          ))}
        </div>

        {/* 刚做出来的那一套：**把取色结果摆出来**。强调色换了是看得见的，
            「为什么换成这个颜色」看不见——不摆出来的话，用户只会觉得
            「按钮怎么变绿了」。 */}
        {photo ? (
          (() => {
            // 当前这个明暗下「够不够」——两个数一起读，因为它们是一件事的两半
            const currentOk = resolved.dark ? photo.report.okDark : photo.report.okLight
            const currentRatio = resolved.dark ? photo.report.ratioDark : photo.report.ratioLight
            return (
              <div
                data-skin-photo-report=""
                className="mt-4 rounded-lg border border-neutral-200 px-3 py-2 dark:border-neutral-800"
              >
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                  <span className="text-sm">已按这张图做出「{photo.label}」，并切了过去</span>
                  <span
                    className="flex overflow-hidden rounded-md border border-neutral-200 dark:border-neutral-700"
                    title="从图里切出来的前几色，按占比排"
                  >
                    {photo.report.swatches.map((c) => (
                      <span key={c} className="h-4 w-6" style={{ backgroundColor: c }} />
                    ))}
                  </span>
                  <span className="flex items-center gap-1.5 text-xs text-neutral-500">
                    强调色
                    <span
                      className="h-4 w-4 rounded-full border border-neutral-200 dark:border-neutral-700"
                      style={{ backgroundColor: photo.report.accent }}
                    />
                    <code className="font-mono">{photo.report.accent}</code>
                  </span>
                  <button
                    onClick={() => setPhoto(null)}
                    data-skin-photo-dismiss=""
                    className="text-xs text-neutral-500 underline hover:text-neutral-800 dark:hover:text-neutral-200"
                  >
                    知道了
                  </button>
                </div>
                <p className="mt-2 text-xs leading-relaxed text-neutral-400">
                  {photo.report.chromatic
                    ? '强调色取自图里最显眼的那一块，亮暗两套色阶都由它推出来。'
                    : '这张图基本没有颜色，所以强调色用了它的平均灰——想要个彩色的话，在上面「强调色」里自己填一个。'}
                  {' '}压暗按这张图的明暗算好了：亮色 {photo.report.scrimLight}%、暗色{' '}
                  {photo.report.scrimDark}%（边缘加重，中间留给图）。
                  {/* **面板层也是从这张图算出来的**——这是「一整套皮肤」与
                      「一张壁纸」的差别，所以要摆出来，否则用户不知道卡片为什么变透了。 */}
                  {photo.report.glass < 100 ? (
                    <>
                      {' '}面板通透度给到 {photo.report.glass}%、模糊 {photo.report.blur}px——
                      这张图明暗拉得
                      {photo.report.spread > 0.5 ? '开' : '不算开'}
                      ，透一点卡片就跟着它一起呼吸。
                    </>
                  ) : null}
                  {' '}不满意可以在下面「自定义背景 → 图片」里盖一层自己的压暗——
                  你自己设的背景永远优先。
                  {photo.wasOverriding
                    ? ' 你原来自己设的背景已经切回「跟随皮肤」了，否则它会盖住这套皮肤。'
                    : ''}
                  {photo.switched
                    ? ` 这张图在原来那个明暗下托不住小字，所以顺手切到了${photo.switched}——不对的话顶栏那个月亮按钮换回来。`
                    : ''}
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
            )
          })()
        ) : null}

        {/* 亮暗：与皮肤分开成一行，因为它是**正交**的一维——
            摆进皮肤网格里会让人以为「暗色」也是一种皮肤 */}
        <div className="mt-5 flex flex-wrap items-center gap-3 border-t border-neutral-200/80 pt-4 dark:border-neutral-800/80">
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
                现在系统是{resolved.dark ? '暗色' : '亮色'}——系统自己换的时候这一页跟着换，
                不用回来点
              </>
            ) : (
              '暗色下会换用这套皮肤的另一组值，不是简单地把亮色反相'
            )}
          </span>
        </div>
      </div>

      {/* ---------- 强调色 ---------- */}
      <div className="wb-card p-5">
        <h2 className="mb-1 font-semibold">强调色</h2>
        <p className="mb-4 text-xs leading-relaxed text-neutral-500">
          按钮、选中态、链接、焦点环、图表首色都用它。留空即跟随皮肤——
          填了之后整条色阶（浅底 chip 到深色实底）由这一个颜色推导，不用逐档配。
        </p>

        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="color"
              data-appearance-accent-picker=""
              value={customAccent ?? resolved.accent}
              onChange={(e) => setAccent(e.target.value)}
              className="h-9 w-12 cursor-pointer rounded-md border border-neutral-200 bg-transparent dark:border-neutral-700"
            />
            自定义
          </label>
          <input
            data-appearance-accent=""
            value={config.accent}
            onChange={(e) => setAccent(e.target.value)}
            placeholder="留空 = 跟随皮肤"
            spellCheck={false}
            className={`${inputCls} max-w-[180px] font-mono`}
          />
          {customAccent ? (
            <button
              onClick={() => setAccent('')}
              data-appearance-accent-clear=""
              className="text-xs text-neutral-500 underline hover:text-neutral-800 dark:hover:text-neutral-200"
            >
              跟随皮肤
            </button>
          ) : null}
        </div>

        {whiteOnAccent !== null && accentOnBg !== null ? (
          <p data-accent-contrast="" className="mt-2 text-xs text-neutral-400">
            白字压这色 <span className="tabular-nums">{whiteOnAccent.toFixed(1)}:1</span>
            {whiteOnAccent >= 4.5 ? ' ✓' : '（低于 AA）'} · 彩字压底色{' '}
            <span className="tabular-nums">{accentOnBg.toFixed(1)}:1</span>
            {accentOnBg >= 4.5 ? ' ✓' : '（低于 AA）'}
            <span className="text-neutral-300 dark:text-neutral-600">
              （AA 线 4.5:1——按钮是白字压强调色，链接/选中态是强调字压底色）
            </span>
          </p>
        ) : null}

        {customAccent ? (
          <div className="mt-3">
            <p className="pb-1.5 text-xs text-neutral-400">推导出的色阶</p>
            <div className="flex overflow-hidden rounded-md border border-neutral-200 dark:border-neutral-700">
              {Object.entries(accentPalette(customAccent)).map(([step, channels]) => (
                <span
                  key={step}
                  title={`${step} · rgb(${channels})`}
                  className="h-6 min-w-0 flex-1"
                  style={{ backgroundColor: `rgb(${channels})` }}
                />
              ))}
            </div>
          </div>
        ) : null}

        {/* 当前皮肤自带的几个候选：不填自定义色也能一键换一个接近的口味 */}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="text-xs text-neutral-400">换一个</span>
          {skins.map((s) => {
            const c = s[resolved.dark ? 'dark' : 'light'].accent
            return (
              <button
                key={s.id}
                title={s.label}
                onClick={() => setAccent(c)}
                className="h-6 w-6 rounded-full border border-neutral-200 transition-transform hover:scale-110 dark:border-neutral-700"
                style={{ backgroundColor: c }}
              />
            )
          })}
        </div>
      </div>


      {error ? (
        <p
          data-appearance-err=""
          className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300"
        >
          {error}
        </p>
      ) : null}

      {/* ---------- 自定义背景 ---------- */}
      <AppearanceBackground />

      {/* ---------- 导入 / 导出 ---------- */}
      <div className="wb-card p-5">
        <h2 className="mb-1 font-semibold">导入 / 导出</h2>
        <p className="mb-4 text-xs leading-relaxed text-neutral-500">
          把这一页的设置（皮肤、明暗、强调色、背景）连自己导入的皮肤一起存成一份文件，
          换台机器、或者重装之后再导回来。文件是普通 JSON，可以直接手改：
          <span className="text-neutral-400">
            {' '}
            只写 <code>{"{ \"id\": \"sakura\", \"label\": \"樱\", \"accent\": \"#d9558a\" }"}</code>{' '}
            就是一个能用的皮肤——亮暗两套、十一条色阶、页面底色都由这一个色号推出来。
          </span>
          {userSkinManifests().length > 0 ? (
            <span data-skins-local-only="" className="mt-1 block text-amber-700 dark:text-amber-300">
              本机现在有 {userSkinManifests().length} 个导入的皮肤——它们<b>只存在这个浏览器里</b>
              （localStorage），后端不备份。清缓存、换浏览器、换机器都会丢，唯一的退路是导出的那份文件。
            </span>
          ) : (
            <span data-skins-local-only="" className="mt-1 block">
              自己导入的皮肤<b>只存在这个浏览器里</b>（localStorage），后端不备份——记得导出留底。
            </span>
          )}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={doExport}
            data-appearance-export=""
            className="flex items-center gap-1.5 rounded-md border border-neutral-300 px-3 py-1.5 text-sm transition-colors hover:border-violet-400 hover:text-violet-600 dark:border-neutral-700 dark:text-neutral-300 dark:hover:border-violet-500/50 dark:hover:text-violet-300"
          >
            <Download className="h-3.5 w-3.5" />
            导出这份设置
          </button>
          <button
            onClick={() => importRef.current?.click()}
            data-appearance-import=""
            className="flex items-center gap-1.5 rounded-md border border-neutral-300 px-3 py-1.5 text-sm transition-colors hover:border-violet-400 hover:text-violet-600 dark:border-neutral-700 dark:text-neutral-300 dark:hover:border-violet-500/50 dark:hover:text-violet-300"
          >
            <Upload className="h-3.5 w-3.5" />
            从文件导入
          </button>
          <input
            ref={importRef}
            type="file"
            accept="application/json,.json"
            data-appearance-import-file=""
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0]
              // 先把 input 清空再处理：不清的话「同一个文件再导入一次」不会触发
              // onChange，而重试同一份文件正是最常发生的事。
              e.target.value = ''
              if (f) void doImport(f)
            }}
          />
          <span className="text-xs text-neutral-400">
            导入是<b>合并</b>：文件里没提到的皮肤留在本机不动。单份文件上限{' '}
            {Math.round(MAX_EXPORT_BYTES / 1024)} KB。
          </span>
        </div>
        {notice ? (
          <p
            data-appearance-notice=""
            className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300"
          >
            {notice}
          </p>
        ) : null}
      </div>

      <p className="text-xs text-neutral-400">
        改动即时生效并自动保存（本机 + 后端各一份，换浏览器打开也还在）。顶栏那个调色板图标随时回到这一页。
      </p>
    </section>
  )
}

/** 把「这份文件会做什么」说成一句人话。**导入完必须说清楚发生了什么**：
 *  「导入成功」四个字盖不住「有一个皮肤被跳过了」「你原来的皮肤不在了」这类事。
 *  `label` 由调用方给——它得先看看那个皮肤到底装上了没有（见 `doImport`）。 */
function describePlan(p: ImportPlan, label: string): string {
  const bits: string[] = []
  bits.push(`已套用「${label}」这套皮肤`)
  if (p.merged.length) bits.push(`本机现有 ${p.merged.length} 个导入的皮肤`)
  if (p.refused.length) {
    bits.push(`跳过了 ${p.refused.length} 个（${p.refused.map((r) => `${r.id}：${r.reason}`).join('；')}）`)
  }
  if (p.missingSkin) {
    bits.push('这份设置用的皮肤文件里没有、本机也没装，暂时按默认皮肤显示')
  }
  return bits.join('；')
}
