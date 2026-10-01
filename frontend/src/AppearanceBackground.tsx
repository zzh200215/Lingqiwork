/** 自定义背景：**卡片下面那一层**。
 *
 *  从 `AppearanceSettings.tsx` 拆出来（2026-10-03 完整皮肤那一轮）：它自己带着
 *  上传、图库、取景、色调一整套状态，与「皮肤」那一半没有共用状态，
 *  而那个文件已经顶到全仓 1000 行的线上了（守卫当场红了一次，这是它该做的事）。
 *
 *  **它管的是「图怎么铺」，不是「哪套皮肤」**：背景是用户自己盖的一层，
 *  皮肤自带的那张图由 `effectiveBg` 分派——用户自己设了就以用户的为准。
 */
import { useEffect, useRef, useState } from 'react'
import { ImagePlus, Loader2, Upload } from 'lucide-react'

import { api, type ImageItem } from './api'
import { useTheme } from './ThemeProvider'
import {
  GRADIENT_PRESETS,
  SOLID_PRESETS,
  safeImageUrl,
  type BgMode,
} from './theme/background'
import type { ResolvedTheme, SkinVariant } from './theme'
import { inputCls } from './settingsShared'

/** 当前生效的那一套色值（亮或暗）。 */
function variantOf(r: ResolvedTheme): SkinVariant {
  return r.dark ? r.skin.dark : r.skin.light
}

/** 本机看得到、后端看不到的图片引用：用户皮肤存在 `wb:skins`，当前主题缓存在
 *  `wb:theme`——后端的引用扫描只覆盖 config.json / 数据库 / vault，皮肤底图
 *  的引用必须由这里算好传上去（`keep`），否则清理会把皮肤正在用的图删掉。 */
function localImageRefs(): string[] {
  const refs = new Set<string>()
  for (const key of ['wb:skins', 'wb:theme'] as const) {
    let raw: string | null
    try {
      raw = localStorage.getItem(key)
    } catch {
      throw new Error(`读不到本机皮肤数据（${key}）——为不误删皮肤底图，这次先不扫`)
    }
    if (!raw) continue
    for (const m of raw.match(/img-\d{8}-\d{6}-[0-9a-f]{6}\.(?:png|jpeg|jpg|webp)/g) ?? []) {
      refs.add(m)
    }
  }
  return [...refs]
}

function fmtBytes(n: number): string {
  return n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`
}

export default function AppearanceBackground() {
  const { config, resolved, patchBg } = useTheme()
  const [library, setLibrary] = useState<ImageItem[]>([])
  const [libraryOpen, setLibraryOpen] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)
  // 清理未引用：null = 还没扫过；扫出来只报数，用户点确认才真的删。
  const [sweep, setSweep] = useState<{ images: ImageItem[]; bytes: number } | null>(null)
  const [sweepBusy, setSweepBusy] = useState(false)
  const [sweepMsg, setSweepMsg] = useState('')

  // 图片库：只在打开「从图库选」时才拉——绝大多数人不会用到，不该占首屏的取数。
  // 拉不到就摆一句「读不到」，不冒充「你还没有图」（本页的纪律，见 SettingsPage 顶注）。
  useEffect(() => {
    if (!libraryOpen || library.length) return
    api
      .listImages()
      .then((r) => setLibrary(r.images))
      .catch((e) => setError(`图片库没读出来：${e instanceof Error ? e.message : String(e)}`))
  }, [libraryOpen, library.length])

  async function upload(file: File) {
    setError('')
    if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) {
      setError('只支持 png / jpg / webp 图片')
      return
    }
    setUploading(true)
    try {
      const item = await api.uploadImage(file)
      // 上传完直接设为背景——用户点「上传」的意思是「用它」，不是「存起来」
      patchBg({ mode: 'image', image: item.url })
      setLibrary((cur) => [item, ...cur])
    } catch (e) {
      setError(`上传失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setUploading(false)
    }
  }

  async function scanUnreferenced() {
    setError('')
    setSweepMsg('')
    let keep: string[]
    try {
      keep = localImageRefs()
    } catch (e) {
      // 读不到本机皮肤就不扫——少报一个 keep 的方向是「多删」，宁可不扫也不冒这个险
      setError(e instanceof Error ? e.message : String(e))
      return
    }
    setSweepBusy(true)
    try {
      const r = await api.unreferencedImages(keep)
      setSweep({ images: r.images, bytes: r.bytes })
    } catch (e) {
      setError(`扫不动：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setSweepBusy(false)
    }
  }

  async function deleteUnreferenced() {
    if (!sweep) return
    setSweepBusy(true)
    try {
      // 删之前把 keep 重算一遍——扫与确认之间用户可能刚导入一张用图的皮肤
      const r = await api.cleanupImages(localImageRefs())
      const gone = new Set(r.deleted)
      setLibrary((cur) => cur.filter((i) => !gone.has(i.name)))
      setSweep(null)
      setSweepMsg(
        r.count
          ? `已删除 ${r.count} 张，释放 ${fmtBytes(r.bytes)}。`
          : '没有要删的——刚才扫出的图这会儿又被引用上了。',
      )
    } catch (e) {
      setError(`删除失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setSweepBusy(false)
    }
  }

  return (
    <>
      {/* ---------- 自定义背景 ---------- */}
      <div className="wb-card p-5">
        <h2 className="mb-1 font-semibold">自定义背景</h2>
        <p className="mb-4 text-xs leading-relaxed text-neutral-500">
          背景是<b>卡片下面那一层</b>。图片会铺满整窗，侧栏与顶栏是半透明的，所以图会从它们下面透出来；
          正文与卡片保持不透明——可读性优先于通透。
        </p>

        <div className="mb-4 flex flex-wrap gap-1.5">
          {(
            [
              { v: 'skin', label: '跟随皮肤' },
              { v: 'solid', label: '纯色' },
              { v: 'gradient', label: '渐变' },
              { v: 'image', label: '图片' },
            ] as { v: BgMode; label: string }[]
          ).map((o) => (
            <button
              key={o.v}
              data-bg-mode={o.v}
              aria-pressed={config.bg.mode === o.v}
              onClick={() => patchBg({ mode: o.v })}
              className={`rounded-md border px-3 py-1.5 text-sm transition-colors ${
                config.bg.mode === o.v
                  ? 'border-violet-300 bg-violet-50 font-medium text-violet-700 dark:border-violet-500/40 dark:bg-violet-500/10 dark:text-violet-300'
                  : 'border-neutral-200 text-neutral-600 hover:border-neutral-300 dark:border-neutral-700 dark:text-neutral-300 dark:hover:border-neutral-600'
              }`}
            >
              {o.label}
            </button>
          ))}
        </div>

        {config.bg.mode === 'skin' ? (
          <p className="text-xs text-neutral-400">
            {resolved.bgFromSkin ? (
              <>
                当前用「{resolved.skin.label}」自带的那张底图（{resolved.image}）。
                下面是它自带的页面底色（{variantOf(resolved).pageBg}）。
              </>
            ) : (
              <>
                当前用「{resolved.skin.label}」自带的页面底色（{variantOf(resolved).pageBg}）。
                这套皮肤没有底图——想要图的皮肤在「远山 / 素纸 / 格纸」那几张里。
              </>
            )}
          </p>
        ) : null}

        {config.bg.mode === 'solid' ? (
          <div className="flex flex-wrap items-center gap-3">
            <input
              type="color"
              data-bg-color=""
              value={config.bg.color}
              onChange={(e) => patchBg({ color: e.target.value })}
              className="h-9 w-12 cursor-pointer rounded-md border border-neutral-200 bg-transparent dark:border-neutral-700"
            />
            <input
              value={config.bg.color}
              onChange={(e) => patchBg({ color: e.target.value })}
              spellCheck={false}
              className={`${inputCls} max-w-[140px] font-mono`}
            />
            <Swatches onPick={(c) => patchBg({ color: c })} />
          </div>
        ) : null}

        {config.bg.mode === 'gradient' ? (
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-2 text-sm">
                起
                <input
                  type="color"
                  data-bg-from=""
                  value={config.bg.from}
                  onChange={(e) => patchBg({ from: e.target.value })}
                  className="h-9 w-12 cursor-pointer rounded-md border border-neutral-200 bg-transparent dark:border-neutral-700"
                />
              </label>
              <label className="flex items-center gap-2 text-sm">
                止
                <input
                  type="color"
                  data-bg-to=""
                  value={config.bg.to}
                  onChange={(e) => patchBg({ to: e.target.value })}
                  className="h-9 w-12 cursor-pointer rounded-md border border-neutral-200 bg-transparent dark:border-neutral-700"
                />
              </label>
              <label className="flex items-center gap-2 text-sm">
                角度
                <input
                  type="range"
                  data-bg-angle=""
                  min={0}
                  max={360}
                  value={config.bg.angle}
                  onChange={(e) => patchBg({ angle: Number(e.target.value) })}
                  className="w-32 accent-violet-600"
                />
                <span className="w-9 text-xs tabular-nums text-neutral-400">{config.bg.angle}°</span>
              </label>
            </div>
            <div className="flex flex-wrap gap-2">
              {GRADIENT_PRESETS.map((p) => (
                <button
                  key={p.label}
                  title={p.label}
                  onClick={() => patchBg({ from: p.from, to: p.to, angle: p.angle })}
                  className="h-9 w-16 rounded-md border border-neutral-200 transition-transform hover:scale-105 dark:border-neutral-700"
                  style={{ backgroundImage: `linear-gradient(${p.angle}deg, ${p.from}, ${p.to})` }}
                />
              ))}
            </div>
          </div>
        ) : null}

        {config.bg.mode === 'image' ? (
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-2">
              <button
                onClick={() => fileRef.current?.click()}
                disabled={uploading}
                data-bg-upload=""
                className="wb-btn-primary px-3 py-1.5 text-sm"
              >
                {uploading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Upload className="h-4 w-4" />
                )}
                {uploading ? '上传中…' : '上传图片'}
              </button>
              <button
                onClick={() => setLibraryOpen((v) => !v)}
                data-bg-library=""
                className="wb-btn-ghost px-3 py-1.5 text-sm"
              >
                <ImagePlus className="h-4 w-4" />
                从图库选
              </button>
              <input
                ref={fileRef}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                data-bg-file=""
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  // 清空 value：同一个文件再选一次也要能触发 change
                  e.target.value = ''
                  if (f) void upload(f)
                }}
              />
              <span className="text-xs text-neutral-400">png / jpg / webp，单张 20MB 以内</span>
            </div>

            <label className="flex flex-col gap-1 text-sm">
              图片地址
              <input
                data-bg-url=""
                value={config.bg.image}
                onChange={(e) => patchBg({ image: e.target.value })}
                placeholder="/api/images/img-… 或 https://…"
                spellCheck={false}
                className={`${inputCls} font-mono`}
              />
            </label>
            {config.bg.image && !safeImageUrl(config.bg.image) ? (
              <p className="text-xs text-rose-600 dark:text-rose-400">
                这个地址不能用——只接受站内图片（/api/images/…）或 http(s) 地址。
              </p>
            ) : null}

            {libraryOpen ? (
              <div className="rounded-lg border border-neutral-200 p-3 dark:border-neutral-800">
                <div className="flex items-center justify-between pb-2">
                  <p className="text-xs font-medium text-neutral-500">图片库（{library.length} 张）</p>
                  <button
                    onClick={() => void scanUnreferenced()}
                    disabled={sweepBusy}
                    data-bg-cleanup=""
                    title="找出没被聊天附件、笔记、背景或皮肤引用的图，确认后删掉"
                    className="text-xs text-neutral-500 underline hover:text-neutral-800 disabled:opacity-40 dark:hover:text-neutral-200"
                  >
                    清理未引用
                  </button>
                </div>
                {sweep ? (
                  sweep.images.length === 0 ? (
                    <p data-bg-cleanup-result="" className="pb-2 text-xs text-neutral-400">
                      没有未引用的图片——聊天附件、笔记和皮肤用到的都在。
                    </p>
                  ) : (
                    <div
                      data-bg-cleanup-result=""
                      className="mb-2 rounded-md border border-amber-200 bg-amber-50 p-2 text-xs leading-relaxed dark:border-amber-500/30 dark:bg-amber-500/10"
                    >
                      <p className="text-amber-800 dark:text-amber-200">
                        扫出 {sweep.images.length} 张没被任何地方引用的图（约 {fmtBytes(sweep.bytes)}）。
                        聊天附件、笔记和皮肤底图引用到的不会动。
                      </p>
                      <div className="mt-1.5 flex gap-3">
                        <button
                          data-bg-cleanup-confirm=""
                          onClick={() => void deleteUnreferenced()}
                          disabled={sweepBusy}
                          className="font-medium text-amber-900 underline disabled:opacity-40 dark:text-amber-100"
                        >
                          {sweepBusy ? '删除中…' : `删除这 ${sweep.images.length} 张`}
                        </button>
                        <button
                          onClick={() => setSweep(null)}
                          className="text-amber-700 underline dark:text-amber-300"
                        >
                          先不删
                        </button>
                      </div>
                    </div>
                  )
                ) : null}
                {sweepMsg ? (
                  <p data-bg-cleanup-msg="" className="pb-2 text-xs text-neutral-400">
                    {sweepMsg}
                  </p>
                ) : null}
                {library.length === 0 ? (
                  <p className="py-2 text-xs text-neutral-400">图库里还没有图——上面传一张。</p>
                ) : (
                  <div className="grid max-h-64 grid-cols-4 gap-2 overflow-y-auto sm:grid-cols-6 xl:grid-cols-8">
                    {library.map((img) => (
                      <button
                        key={img.name}
                        data-bg-pick={img.name}
                        title={img.name}
                        onClick={() => patchBg({ image: img.url })}
                        className={`aspect-video overflow-hidden rounded-md border-2 transition-colors ${
                          config.bg.image === img.url
                            ? 'border-violet-400'
                            : 'border-transparent hover:border-neutral-300 dark:hover:border-neutral-600'
                        }`}
                      >
                        <img src={img.url} alt={img.name} className="h-full w-full object-cover" />
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ) : null}

            <div className="grid gap-4 sm:grid-cols-2">
              <Slider
                label="压暗"
                hint="图太亮时把正文救回来"
                value={config.bg.scrim}
                min={0}
                max={95}
                suffix="%"
                name="scrim"
                onChange={(v) => patchBg({ scrim: v })}
              />
              <Slider
                label="模糊"
                hint="细节退场，只留色块"
                value={config.bg.blur}
                min={0}
                max={40}
                suffix="px"
                name="blur"
                // 平铺的纹理不给模糊：图案糊了之后不是「朦胧」而是一片脏色
                disabled={config.bg.fit === 'repeat'}
                onChange={(v) => patchBg({ blur: v })}
              />
            </div>

            {/* **取景**：焦点 + 缩放。一张竖图铺在宽屏上，默认的居中裁切会把要露的
                东西切掉——这类「图选对了、位置不对」的抱怨，修法是给两个数，
                而不是给一个裁剪工具。两样都只在 `cover` 下有意义（平铺时格子
                自己多大就是多大）。 */}
            {config.bg.fit === 'cover' ? (
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                <Slider
                  label="焦点 横"
                  hint="往左 / 往右挪"
                  value={config.bg.focusX}
                  min={0}
                  max={100}
                  suffix="%"
                  name="focus-x"
                  onChange={(v) => patchBg({ focusX: v })}
                />
                <Slider
                  label="焦点 纵"
                  hint="竖图往上 / 往下挪"
                  value={config.bg.focusY}
                  min={0}
                  max={100}
                  suffix="%"
                  name="focus-y"
                  onChange={(v) => patchBg({ focusY: v })}
                />
                <Slider
                  label="缩放"
                  hint="想把局部放大当背景"
                  value={config.bg.zoom}
                  min={100}
                  max={250}
                  suffix="%"
                  name="zoom"
                  onChange={(v) => patchBg({ zoom: v })}
                />
                <Slider
                  label="图的不透明度"
                  hint="把图淡出到底色上"
                  value={config.bg.opacity}
                  min={0}
                  max={100}
                  suffix="%"
                  name="opacity"
                  onChange={(v) => patchBg({ opacity: v })}
                />
              </div>
            ) : null}

            {/* **色调薄纱**：与压暗层分开的一层。压暗是可读性机制（颜色由明暗模式
                定死、强度按图算出来），色调是风格机制（一层深海蓝、一层暖褐）。
                想做「整体偏青」这种氛围，只有压暗层是做不出来的——它只能把图压向
                白或黑。 */}
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-sm">色调</span>
              <input
                type="color"
                data-bg-tint=""
                value={config.bg.tint.color || '#0b1f2a'}
                onChange={(e) => patchBg({ tint: { color: e.target.value, alpha: config.bg.tint.alpha || 25 } })}
                className="h-9 w-12 cursor-pointer rounded-md border border-neutral-200 bg-transparent dark:border-neutral-700"
              />
              <input
                type="range"
                data-bg-tint-alpha=""
                min={0}
                max={100}
                value={config.bg.tint.alpha}
                onChange={(e) => patchBg({ tint: { ...config.bg.tint, alpha: Number(e.target.value) } })}
                className="w-32 accent-violet-600"
              />
              <span className="w-9 text-xs tabular-nums text-neutral-400">{config.bg.tint.alpha}%</span>
              {config.bg.tint.alpha > 0 ? (
                <button
                  onClick={() => patchBg({ tint: { color: '', alpha: 0 } })}
                  data-bg-tint-clear=""
                  className="text-xs text-neutral-500 underline hover:text-neutral-800 dark:hover:text-neutral-200"
                >
                  去掉
                </button>
              ) : (
                <span className="text-xs text-neutral-400">一层颜色盖在图上（与压暗分开）</span>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <span className="text-sm">铺法</span>
              <div className="flex rounded-md border border-neutral-200 p-0.5 dark:border-neutral-700">
                {(
                  [
                    { f: 'cover', label: '铺满' },
                    { f: 'contain', label: '完整显示' },
                    { f: 'repeat', label: '平铺' },
                  ] as const
                ).map((o) => (
                  <button
                    key={o.f}
                    data-bg-fit={o.f}
                    aria-pressed={config.bg.fit === o.f}
                    onClick={() => patchBg({ fit: o.f, ...(o.f === 'repeat' ? { blur: 0 } : {}) })}
                    className={`rounded-[5px] px-3 py-1 text-sm transition-colors ${
                      config.bg.fit === o.f
                        ? 'bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900'
                        : 'text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200'
                    }`}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
              <button
                onClick={() => patchBg({ image: '' })}
                className="text-xs text-neutral-500 underline hover:text-neutral-800 dark:hover:text-neutral-200"
              >
                移除背景图
              </button>
            </div>

            {/* 压暗方向：这一条是「图很美」与「字看得清」能同时成立的地方。
                平铺的纹理不给这个选项——图案被不均匀地压暗看起来像渲染坏了。 */}
            {config.bg.fit === 'repeat' ? (
              <p className="text-xs text-neutral-400">
                平铺的纹理一律均匀压暗：图案被压得一边深一边浅，看起来不像有明暗，像渲染坏了。
              </p>
            ) : (
              <div className="flex flex-wrap items-center gap-3">
                <span className="text-sm">压暗分布</span>
                <div className="flex rounded-md border border-neutral-200 p-0.5 dark:border-neutral-700">
                  {(
                    [
                      { d: 'flat', label: '均匀' },
                      { d: 'edge', label: '边缘加重' },
                    ] as const
                  ).map((o) => (
                    <button
                      key={o.d}
                      data-bg-scrim-dir={o.d}
                      aria-pressed={config.bg.scrimDir === o.d}
                      onClick={() => patchBg({ scrimDir: o.d })}
                      className={`rounded-[5px] px-3 py-1 text-sm transition-colors ${
                        config.bg.scrimDir === o.d
                          ? 'bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900'
                          : 'text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200'
                      }`}
                    >
                      {o.label}
                    </button>
                  ))}
                </div>
                <span className="text-xs text-neutral-400">
                  {config.bg.scrimDir === 'edge'
                    ? '文字多在左边和上边——压暗往那两处堆，中间留出来给图'
                    : '整屏压一样重，最直白，也最费图'}
                </span>
              </div>
            )}
          </div>
        ) : null}
      </div>
      {error ? (
        <p
          data-bg-err=""
          className="mt-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300"
        >
          {error}
        </p>
      ) : null}
    </>
  )
}

function Swatches({ onPick }: { onPick: (c: string) => void }) {
  return (
<div className="flex flex-wrap gap-1.5">
  {SOLID_PRESETS.map((c) => (
    <button
      key={c}
      title={c}
      onClick={() => onPick(c)}
      className="h-6 w-6 rounded-full border border-neutral-200 transition-transform hover:scale-110 dark:border-neutral-700"
      style={{ backgroundColor: c }}
    />
  ))}
</div>
  )
}


function Slider({
  label,
  hint,
  value,
  min,
  max,
  suffix,
  name,
  disabled,
  onChange,
}: {
  label: string
  hint: string
  value: number
  min: number
  max: number
  suffix: string
  name: string
  /** 这一档在当前组合下不适用（例如平铺纹理不给模糊）。**禁用而不是隐藏**：
   *  隐藏会让「刚才那个滑块去哪了」变成一个问题，禁用加一句说明只会有半个问题。 */
  disabled?: boolean
  onChange: (v: number) => void
}) {
  return (
<label className={`flex flex-col gap-1 text-sm ${disabled ? 'opacity-50' : ''}`}>
  <span className="flex items-center justify-between">
    <span>
      {label}
      <span className="pl-2 text-xs text-neutral-400">{hint}</span>
    </span>
    <span className="text-xs tabular-nums text-neutral-400">
      {value}
      {suffix}
    </span>
  </span>
  <input
    type="range"
    data-bg-slider={name}
    min={min}
    max={max}
    value={value}
    disabled={disabled}
    onChange={(e) => onChange(Number(e.target.value))}
    className="accent-violet-600 disabled:cursor-not-allowed"
  />
</label>
  )
}

