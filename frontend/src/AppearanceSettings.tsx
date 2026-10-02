import { useEffect, useMemo, useRef, useState, type ReactNode, type Ref } from 'react'
import { ChevronDown, Download, Loader2, Sparkles, Upload } from 'lucide-react'

import { api } from './api'
import AppearanceBackground from './AppearanceBackground'
import SkinCard from './SkinCard'
import SkinCenter from './SkinCenter'
import SkinCreator from './SkinCreator'
import SkinHero from './SkinHero'
import { useTheme } from './ThemeProvider'
import {
  APPEARANCE_VISITED_KEY,
  accentPalette,
  hasOverrides,
  isBuiltinSkin,
  listSkins,
  normalizeHex,
  skinById,
  skinToManifest,
  userSkinManifests,
  type Skin,
  type SkinManifest,
} from './theme'
import { GALLERY_GROUPS, MINE_KEY, SKIN_TAGS } from './skinGallery'
import { skinFromImage, type ImageSkinReport } from './theme/extract'
import { contrastRatio, contrastWithWhite, hexToRgb } from './theme/color'
import {
  MAX_EXPORT_BYTES,
  buildExport,
  buildSkinShare,
  planImport,
  serializeExport,
  type ImportPlan,
} from './theme/transfer'
import { inputCls } from './settingsShared'

/** 「刚做出来、还没落地」的那套皮肤（图片创建流程的第二幕状态）。 */
interface SkinDraft {
  manifest: SkinManifest
  report: ImageSkinReport
}

/** 「已经用上」的那一次创建：只留**事后才说得清**的话——背景切回了跟随、
 *  明暗顺手换过了。取色数字本身在创建器那一幕已经摆过，这里不再重复。 */
interface PhotoApplied {
  label: string
  report: ImageSkinReport
  /** 做之前用户自己设着背景（图 / 纯色 / 渐变），被切回「跟随皮肤」了 */
  wasOverriding: boolean
  /** 非空 = 顺手切到了这个明暗模式（当前那个托不住这张图）。值就是要显示的那两个字。 */
  switched: string
}

/** 设置 → 外观——**皮肤中心**。
 *
 *  ## 这一屏的信息架构（2026-10-02 重排为 Skin Center）
 *
 *  这页九成的用途是「挑一套好看的样子」，所以从上往下是：
 *
 *    1. **当前皮肤**（`SkinHero`）——大预览 + 「正在使用」徽章 + 编辑 / 恢复默认 +
 *       明暗。先回答「我现在穿着什么」。
 *    2. **皮肤库**——策展分组（推荐 / 氛围 / 极简 / 色彩 / 我的皮肤）+ 一级入口
 *       「创建皮肤」。选皮肤这件事本身是主角。
 *    3. **高级调整 / 自定义壁纸 / 导入导出**（折叠区）——强调色、八个面板旋钮、
 *       取景与色调、JSON 进出。这些是「调参」，普通用户不该被它们挡住去路；
 *       `<details>` 收起来的是「不吵」，不是「不在」。
 *
 *  早先的顺序（微调八根滑块压在画廊前面）把调参摆在了选择前面，那是「平铺感」
 *  的来源；再往前（当前皮肤 + 明暗 + 强调色全平铺）连画廊都没有。
 *
 *  所有改动**即时生效、自动保存**，没有「保存」按钮：外观是所见即所得的东西，
 *  一个需要点确认才生效的预览不算预览。持久化在 `ThemeProvider` 里（localStorage
 *  + 后端副本），这里只管把设置读出来、改回去。
 *
 *  ## 图片 → 皮肤是一条**连续体验**
 *
 *  「创建皮肤」之后：选图 → 自动取色 → **创建器那一幕**（`SkinCreator`：整套
 *  工作台的预览 + 起名 + 使用 / 收藏 / 重选）→ 落地。后端的取色、推导、装表
 *  全部已经存在，这里只是把它们摆成用户读得懂的顺序——用户感觉自己是在
 *  「做一套皮肤」，不是在「上传一张图触发一条管线」。 */
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
  /** 图片取色进行中（「创建皮肤」按钮上的转圈）。 */
  const [skinBusy, setSkinBusy] = useState(false)
  /** 取色完成、还没落地的那一套。非空 = 创建器那一幕开着。 */
  const [draft, setDraft] = useState<SkinDraft | null>(null)
  const [draftName, setDraftName] = useState('')
  /** 已落地的那一次（事后说明条）。 */
  const [photo, setPhoto] = useState<PhotoApplied | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  /** 画廊筛选：全部 / 某个策展分组 / 我的皮肤。 */
  const [group, setGroup] = useState<string>('all')
  const importRef = useRef<HTMLInputElement>(null)
  const photoRef = useRef<HTMLInputElement>(null)
  const tuningRef = useRef<HTMLDetailsElement>(null)

  // 进过一次外观页就落「来过」的键——顶栏调色盘上的那颗提示圆点从此永远消失
  // （键与圆点见 `theme.ts` 的 APPEARANCE_VISITED_KEY 与 Layout 的 AppearanceLink）。
  useEffect(() => {
    try {
      localStorage.setItem(APPEARANCE_VISITED_KEY, '1')
    } catch {
      /* 存不下（隐私模式）就让它下次再亮一次，不值得为它报错 */
    }
  }, [])

  /** 「用这张图做一套皮肤」的**第一幕**：上传 + 取色。
   *
   *  取完色**不落地**——结果交给创建器（`SkinCreator`）那一幕，由用户决定
   *  用不用。它与「上传当背景」是两条不同的路：那条换的是背景（图盖上去，
   *  强调色不动），这条换的是皮肤（图 + 从图里取的强调色 + 按图算的压暗与通透），
   *  会成为皮肤表里可以改名、导出、再切回来的一张卡。 */
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
      setDraft({ manifest: made.value.manifest, report: made.value.report })
      setDraftName(made.value.manifest.label)
    } catch (e) {
      setError(`做皮肤失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setSkinBusy(false)
    }
  }

  /** 创建器的出口：**使用**（入库 + 切过去）或**收藏**（只入库）。
   *
   *  「使用」顺手做两件事，都是为了让结果**当场就能看**：
   *  背景切回「跟随皮肤」（不切的话用户自己设的那张图会盖住新皮肤——
   *  「我做了皮肤，屏幕上什么都没变」正是这一类困惑）；这张图在当前明暗下
   *  托不住、另一边托得住时**直接落过去**（用户要的是一个能用的结果，
   *  不是「一套读不清的皮肤 + 一句警告」）。两边都好或都坏时不替他选。 */
  function applyDraft(kind: 'apply' | 'keep') {
    if (!draft) return
    const label = (draftName.trim() || draft.manifest.label).slice(0, 16)
    const manifest: SkinManifest = { ...draft.manifest, label }
    const report = addSkin(manifest)
    if (!report.added.length) {
      setError(`没装上：${report.refused.map((r) => r.reason).join('；') || '未知原因'}`)
      return
    }
    if (kind === 'apply') {
      setSkin(manifest.id)
      const wasOverriding = config.bg.mode !== 'skin'
      if (wasOverriding) patchBg({ mode: 'skin' })
      const r = draft.report
      const currentOk = resolved.dark ? r.okDark : r.okLight
      const otherOk = resolved.dark ? r.okLight : r.okDark
      const switched = !currentOk && otherOk
      if (switched) setMode(resolved.dark ? 'light' : 'dark')
      setPhoto({
        label: manifest.label,
        report: r,
        wasOverriding,
        switched: switched ? (resolved.dark ? '亮色' : '暗色') : '',
      })
      setNotice('')
    } else {
      setNotice(`已存进「我的皮肤」：「${manifest.label}」——想套上就点它的卡片`)
    }
    setDraft(null)
    setDraftName('')
  }

  /** 创建器里的「换个强调色」：只改 manifest.accent——色阶、页面底色由推导重出，
   *  压暗与面板通透是**按图算的**，跟着图走不跟着色号走，所以不动。 */
  function setDraftAccent(hex: string) {
    setDraft((d) => (d ? { ...d, manifest: { ...d.manifest, accent: hex } } : d))
  }

  /** Hero 的「编辑皮肤」：展开「高级调整」并把它滚进视野。
   *  `<details>` 默认不受控，这里只动它这一下——用户随后自己开合，界面不抢。 */
  function openTuning() {
    const d = tuningRef.current
    if (!d) return
    d.open = true
    try {
      d.scrollIntoView({ behavior: 'smooth', block: 'start' })
    } catch {
      /* 滚不动（老环境 / jsdom）就算了——折叠区已经开着，信息没有丢 */
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
    downloadFile(`外观设置-${stamp}.json`, serializeExport(buildExport(config, userSkinManifests())))
    setNotice(`已导出（含 ${userSkinManifests().length} 个导入的皮肤）`)
  }

  /** 导出**一个**皮肤：皮肤分享文件——只有皮肤、不带外观设置。
   *
   *  收的人要的是「装上这张卡」，不是「连你的亮暗、强调色、壁纸一起搬过来」。
   *  文件是 `buildSkinShare` 的形状（没有 config 字段），`planImport` 认得它：
   *  导入时只装皮肤，对方的外观一动不动。 */
  function exportSkin(s: Skin) {
    setError('')
    downloadFile(`皮肤-${s.label}.json`, serializeExport(buildSkinShare([skinToManifest(s)])))
    setNotice(`已导出「${s.label}」——这份文件只有皮肤，导入它不会动别人的外观`)
  }

  /** 下载一份文本文件。导出全家设置与导出单个皮肤共用这一条路。 */
  function downloadFile(filename: string, text: string) {
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }))
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.click()
    // 立刻撤销：Blob 的 URL 会一直把这份数据留在内存里，直到页面关掉
    URL.revokeObjectURL(url)
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
    // 第四个参数是**现在这份设置**：皮肤分享文件（只有皮肤的那种）不带 config，
    // 导入它不该动外观——计划里的设置就是现在这份。
    const plan = planImport(text, userSkinManifests(), new Set(listSkins().map((s) => s.id)), config)
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
  // 对比度实时读数：**量的是真实用法上的那两档**，不是「显示用的那个色号」。
  // 按钮是白字压**色阶 600 的实底**（亮暗都是 600，暗色的 600 是特意压深的，见
  // `skins.ts` 的说明）；强调文字是**字压页面底色**——亮色取 600、暗色取 400
  // （与 `theme.contrast.test.ts` 量的同两对）。以前量的是 `resolved.accent`：
  // 暗色下那是提亮过的那一档（400 上下），于是流萤暗色会显示「白字 1.5:1 低于 AA」
  // 而按钮其实是 5.4:1——读数吓人，按钮没事，读数自己错了。
  const variant = resolved.skin[resolved.dark ? 'dark' : 'light']
  const effScale = customAccent ? accentPalette(customAccent) : variant.accentScale
  const rgbOfChannels = (ch: string): [number, number, number] => {
    const p = ch.split(/\s+/).map(Number)
    return [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0]
  }
  const pageBgRgb = hexToRgb(normalizeHex(variant.pageBg) ?? '#ffffff')
  const whiteOnAccent = contrastWithWhite(rgbOfChannels(effScale['600']))
  const accentOnBg = pageBgRgb
    ? contrastRatio(rgbOfChannels(effScale[resolved.dark ? '400' : '600']), pageBgRgb)
    : null
  // `listSkins()` 读的是注册表里那份模块级索引，React 看不见它什么时候变，
  // 所以这里把 `skinsRev`（装上 / 删掉皮肤时加一）显式写成依赖——
  // 少了它，导入成功的那一刻界面还是旧的皮肤表。
  const skins = useMemo(() => listSkins(), [skinsRev])
  const userSkins = skins.filter((s) => !isBuiltinSkin(s.id))

  /** 壁纸折叠行右侧的摘要：现在是什么模式，轮换开着带几张。 */
  const wallpaperMeta =
    config.bg.mode === 'image'
      ? `图片${config.bg.pool.length > 0 && config.bg.rotateMin > 0 ? ` · 轮换 ${config.bg.pool.length} 张` : ''}`
      : config.bg.mode === 'solid'
        ? '纯色'
        : config.bg.mode === 'gradient'
          ? '渐变'
          : '跟随皮肤'

  // ---------- 皮肤库的分组 ----------
  //
  // 策展表（`skinGallery.ts`）给的是内置皮肤的货架；用户皮肤是**活的清单**，
  // 单独一栏「我的皮肤」。「更多」是策展漏掉时的兜底——`skinGallery` 的守卫测试
  // 会让漏配当场红，这里只是别把卡藏没。
  const byId = new Map(skins.map((s) => [s.id, s]))
  const covered = new Set(GALLERY_GROUPS.flatMap((g) => g.ids))
  const rest = skins.filter((s) => isBuiltinSkin(s.id) && !covered.has(s.id))
  const sections: { key: string; label: string; note?: string; skins: Skin[] }[] = [
    ...GALLERY_GROUPS.map((g) => ({
      key: g.key,
      label: g.label,
      skins: g.ids.map((id) => byId.get(id)).filter((s): s is Skin => Boolean(s)),
    })),
    { key: MINE_KEY, label: '我的皮肤', note: '从图片做的、导入的、存下来的都在这里', skins: userSkins },
    ...(rest.length ? [{ key: 'more', label: '更多', skins: rest }] : []),
  ]
  const visible = sections.filter((sec) => (group === 'all' || group === sec.key) && sec.skins.length)
  const filterChips = [
    { key: 'all', label: '全部' },
    ...GALLERY_GROUPS.map((g) => ({ key: g.key, label: g.label })),
    ...(userSkins.length ? [{ key: MINE_KEY, label: `我的皮肤 · ${userSkins.length}` }] : []),
  ]

  return (
    <section className="mb-6 flex flex-col gap-4" data-appearance="">
      {/* ---------- 当前皮肤：开门第一块 ---------- */}
      <SkinHero onEdit={openTuning} />

      {/* ---------- 皮肤库：这一页的主角 ---------- */}
      <div className="wb-card p-5" data-skin-gallery="">
        <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-semibold">
            皮肤库 <span className="text-xs font-normal text-neutral-400">{skins.length} 套</span>
          </h2>
          {/* 一级入口「创建皮肤」：与「换背景」那条路分开——它做的是一整套皮肤
              （强调色从图里取、压暗按图算），做完先进创建器，由你决定用不用。 */}
          <button
            onClick={() => photoRef.current?.click()}
            disabled={skinBusy}
            data-skin-from-image=""
            className="wb-btn-primary px-3 py-1.5 text-sm"
          >
            {skinBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
            {skinBusy ? '取色中…' : '创建皮肤'}
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
        <p className="mb-3 text-xs text-neutral-500">
          点一下就换上——底色、强调色、面板通透一起走。想要自己的那套，传一张图现做。
        </p>

        {/* 筛选条：**全部**展开所有栏目；选中某一栏只看那一栏。
            这是「收藏感」的最廉价实现——不用动皮肤数据，货架换一种摆法而已。 */}
        <div className="mb-4 flex flex-wrap items-center gap-1.5">
          {filterChips.map((c) => (
            <button
              key={c.key}
              data-gallery-filter={c.key}
              aria-pressed={group === c.key}
              onClick={() => setGroup(c.key)}
              className={`rounded-full px-3 py-1 text-xs transition-colors ${
                group === c.key
                  ? 'bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900'
                  : 'border border-neutral-200 text-neutral-500 hover:text-neutral-800 dark:border-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-200'
              }`}
            >
              {c.label}
            </button>
          ))}
        </div>

        {/* 图片创建的第二幕：预览 + 起名 + 三个出口。占的是画廊最显眼的位置——
            它开着的时候，用户的任务就是「决定这套要不要」。 */}
        {draft ? (
          <SkinCreator
            draft={draft}
            name={draftName}
            onName={setDraftName}
            onAccent={setDraftAccent}
            onApply={() => applyDraft('apply')}
            onKeep={() => applyDraft('keep')}
            onDiscard={() => {
              setDraft(null)
              setDraftName('')
            }}
          />
        ) : null}

        {visible.map((sec, i) => (
          <div key={sec.key} className={i > 0 ? 'mt-5' : ''} data-gallery-section={sec.key}>
            <div className="mb-2 flex flex-wrap items-baseline gap-2">
              <h3 className="text-xs font-medium tracking-wider text-neutral-400">{sec.label}</h3>
              <span className="text-xs text-neutral-300 dark:text-neutral-600">{sec.skins.length}</span>
              {sec.note ? <span className="text-xs text-neutral-400">{sec.note}</span> : null}
            </div>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
              {sec.skins.map((s) => (
                <SkinCard
                  key={s.id}
                  skin={s}
                  dark={resolved.dark}
                  active={config.skin === s.id}
                  tags={isBuiltinSkin(s.id) ? SKIN_TAGS[s.id] : undefined}
                  onPick={() => setSkin(s.id)}
                  // 内置那些不给删也不给改名：它们的定义在产品代码里，
                  // 改了名下次构建就回来了，那是一次会被悄悄撤销的操作
                  onRemove={isBuiltinSkin(s.id) ? undefined : () => dropSkin(s.id)}
                  onRename={isBuiltinSkin(s.id) ? undefined : (label) => doRename(s.id, label)}
                  onExport={isBuiltinSkin(s.id) ? undefined : () => exportSkin(s)}
                />
              ))}
            </div>
          </div>
        ))}
        {visible.length === 0 ? (
          <p data-gallery-empty="" className="text-xs text-neutral-400">
            还没有自己的皮肤——上面「创建皮肤」传一张图现做一套，或在「导入 / 导出」里装一份 JSON。
          </p>
        ) : null}

        {/* 「使用」落地之后的事后说明：只说**这一刻才说得清**的话——背景切回了跟随、
            明暗顺手换过了。取色数字在创建器那一幕已经摆过，这里不再重复。 */}
        {photo ? (
          (() => {
            const currentOk = resolved.dark ? photo.report.okDark : photo.report.okLight
            const currentRatio = resolved.dark ? photo.report.ratioDark : photo.report.ratioLight
            return (
              <div
                data-skin-photo-report=""
                className="mt-4 rounded-lg border border-neutral-200 px-3 py-2 dark:border-neutral-800"
              >
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                  <span className="text-sm">已按这张图做出「{photo.label}」，并切了过去</span>
                  <button
                    onClick={() => setPhoto(null)}
                    data-skin-photo-dismiss=""
                    className="text-xs text-neutral-500 underline hover:text-neutral-800 dark:hover:text-neutral-200"
                  >
                    知道了
                  </button>
                </div>
                <p className="mt-2 text-xs leading-relaxed text-neutral-400">
                  {photo.wasOverriding
                    ? '你原来自己设的背景已经切回「跟随皮肤」了，否则它会盖住这套皮肤。'
                    : ''}
                  {photo.switched
                    ? ` 这张图在原来那个明暗下托不住小字，所以顺手切到了${photo.switched}——不对的话顶栏那个月亮按钮换回来。`
                    : ''}
                  {!photo.wasOverriding && !photo.switched
                    ? '强调色、压暗与面板通透度都是从这张图算出来的；想微调去「高级调整」。'
                    : ''}
                </p>
                {/* 两边都托不住时不替他选——只把差多少说出来（与创建器里同一句话） */}
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
      </div>

      {error ? (
        <p
          data-appearance-err=""
          className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300"
        >
          {error}
        </p>
      ) : null}

      {/* ---------- 高级调整（折叠：默认收起） ---------- */}
      <Fold
        id="tuning"
        title="高级调整"
        meta="强调色 · 通透 · 模糊 · 存成新皮肤"
        detailsRef={tuningRef}
        badge={
          hasOverrides(config.surfaces) ? (
            <span
              data-appearance-tuned=""
              className="rounded-full bg-violet-100 px-1.5 py-0.5 text-xs text-violet-700 dark:bg-violet-500/15 dark:text-violet-300"
            >
              已自定义
            </span>
          ) : null
        }
      >
        <div className="flex flex-col gap-4">
          <div className="wb-card p-5">
            <h2 className="mb-1 font-semibold">强调色</h2>
            <p className="mb-4 text-xs text-neutral-500">
              按钮、选中态、链接、图表首色都跟它。留空即跟随皮肤——填了之后整条色阶由它推导。
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
                白字压按钮 <span className="tabular-nums">{whiteOnAccent.toFixed(1)}:1</span>
                {whiteOnAccent >= 4.5 ? ' ✓' : '（低于 AA）'} · 强调字压底色{' '}
                <span className="tabular-nums">{accentOnBg.toFixed(1)}:1</span>
                {accentOnBg >= 4.5 ? ' ✓' : '（低于 AA）'}
                <span className="text-neutral-300 dark:text-neutral-600">
                  （AA 线 4.5:1——量的是按钮实底那档 600，与压在底色上的强调字：亮色 600 / 暗色 400）
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

          <SkinCenter />
        </div>
      </Fold>

      {/* ---------- 自定义壁纸与轮换（折叠） ---------- */}
      <Fold id="wallpaper" title="自定义壁纸" meta={wallpaperMeta}>
        <AppearanceBackground onMakeSkin={makeSkin} />
      </Fold>

      {/* ---------- 导入 / 导出（折叠） ---------- */}
      <Fold
        id="transfer"
        title="导入 / 导出"
        meta={
          userSkinManifests().length
            ? `${userSkinManifests().length} 个导入的皮肤`
            : '备份 · 迁移'
        }
      >
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
                本机现在有 {userSkinManifests().length} 个导入的皮肤——它们会自动同步一份到后端
                （data/skins.json），清缓存、换浏览器都能从后端找回来；换台机器时跟着 data/ 目录走。
                导出 JSON 仍是留底的正路。
              </span>
            ) : (
              <span data-skins-local-only="" className="mt-1 block">
                自己导入的皮肤会自动同步一份到后端（data/skins.json）——清缓存、换浏览器能找回来。
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
      </Fold>

      <p className="text-xs text-neutral-400">
        改动即时生效并自动保存（本机 + 后端各一份，换浏览器打开也还在）。顶栏那个调色板图标随时回到这一页。
      </p>
    </section>
  )
}

/** 把「这份文件会做什么」说成一句人话。**导入完必须说清楚发生了什么**：
 *  「导入成功」四个字盖不住「有一个皮肤被跳过了」「你原来的皮肤不在了」这类事。
 *  `label` 由调用方给——它得先看看那个皮肤到底装上了没有（见 `doImport`）。
 *  皮肤分享文件（不带 config）**不套用**：说「外观没动」，别说「已套用」。 */
function describePlan(p: ImportPlan, label: string): string {
  const bits: string[] = []
  if (p.appliesConfig) {
    bits.push(`已套用「${label}」这套皮肤`)
  } else {
    bits.push('已装上皮肤，外观没动——想套用就点它的卡片')
  }
  if (p.merged.length) bits.push(`本机现有 ${p.merged.length} 个导入的皮肤`)
  if (p.refused.length) {
    bits.push(`跳过了 ${p.refused.length} 个（${p.refused.map((r) => `${r.id}：${r.reason}`).join('；')}）`)
  }
  if (p.missingSkin) {
    bits.push('这份设置用的皮肤文件里没有、本机也没装，暂时按默认皮肤显示')
  }
  return bits.join('；')
}

/** 折叠区。**用 `<details>` 而不是 state + 卸载**：收起来的是「不吵」，不是「不在」
 *  ——内容常在 DOM 里，行为、测试与窄屏的规矩都不为它让路（与 §9 那条
 *  「藏字不藏节点」是同一条纪律的另一头）。徽标（badge）把「这里有你改过的东西」
 *  摆在收起的那一行上——「已自定义」不该被藏起来才被发现。
 *
 *  `detailsRef` 是给**别的控件**开这一层用的（`SkinHero` 的「编辑皮肤」）：
 *  只在用户点的那一刻被程序拨一下 `open`，之后开合权交还用户。 */
function Fold({
  id,
  title,
  meta,
  badge,
  detailsRef,
  children,
}: {
  id: string
  title: string
  meta: string
  badge?: ReactNode
  detailsRef?: Ref<HTMLDetailsElement>
  children: ReactNode
}) {
  return (
    <details ref={detailsRef} data-appearance-fold={id} className="group">
      <summary className="flex cursor-pointer select-none list-none items-center gap-2 rounded-lg border border-neutral-200 px-4 py-3 text-sm transition-colors hover:bg-neutral-50 dark:border-neutral-800 dark:hover:bg-neutral-900/60 [&::-webkit-details-marker]:hidden">
        <ChevronDown className="h-4 w-4 shrink-0 text-neutral-400 transition-transform group-open:rotate-180" />
        <span className="font-medium">{title}</span>
        {badge}
        <span className="ml-auto text-xs text-neutral-400">{meta}</span>
      </summary>
      <div className="mt-3">{children}</div>
    </details>
  )
}
