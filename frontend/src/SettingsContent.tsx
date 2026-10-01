// content 分区的两张偏好卡（方向 6 第十五刀，2026-09-30 自 SettingsPage 拆出）：
// Artifacts 轻执行开关 + 图片生成（配置、测试生成与图库管理）。
// 状态与处理器整体住在这里，挂载时自拉图库，失败走 failLoad 汇总到页级错误条；
// prefs/setPrefs/savePrefs/prefsSaved 是页面级横切（general 大卡仍在本体），经 props 传入；
// providers 只读传入（image_provider 的候选清单）。
import { useEffect, useState } from 'react'
import { Image, Zap } from 'lucide-react'
import { api, type ImageItem, type ProviderConfig } from './api'
import { fmtSize, inputCls, type WorkbenchPrefs } from './settingsShared'

export default function SettingsContent({
  prefs,
  setPrefs,
  savePrefs,
  prefsSaved,
  providers,
  failLoad,
}: {
  prefs: WorkbenchPrefs
  setPrefs: (p: WorkbenchPrefs) => void
  savePrefs: () => Promise<void>
  prefsSaved: boolean
  providers: ProviderConfig[]
  failLoad: (what: string, e: unknown) => void
}) {

  const [images, setImages] = useState<ImageItem[]>([])
  const [imgPrompt, setImgPrompt] = useState('一只戴着圆眼镜的橘猫坐在书桌前看书，暖色台灯，水彩插画风格')
  const [imgBusy, setImgBusy] = useState(false)
  const [imgMsg, setImgMsg] = useState('')

  useEffect(() => {
    api.listImages().then((r) => setImages(r.images)).catch((e) => failLoad('图片', e))
  }, [])

  // ---- image generation ----

  async function testImage() {
    if (!prefs || imgBusy) return
    const prompt = imgPrompt.trim()
    if (!prompt) {
      setImgMsg('先写一句图片描述')
      return
    }
    setImgBusy(true)
    setImgMsg('生成中…（qwen-image 约 30-90 秒，请勿刷新）')
    try {
      await savePrefs()
      const r = await api.generateImage(prompt)
      setImgMsg(`✓ ${r.images.length} 张 · ${r.model} · ${r.size} · ${r.api}/${r.provider} · ${r.seconds}s`)
      const list = await api.listImages()
      setImages(list.images)
    } catch (e) {
      setImgMsg(String(e))
    } finally {
      setImgBusy(false)
    }
  }

  async function removeImage(name: string) {
    if (!confirm(`删除图片「${name}」？引用它的笔记/对话会显示裂图。`)) return
    try {
      await api.deleteImage(name)
      const list = await api.listImages()
      setImages(list.images)
    } catch (e) {
      setImgMsg(String(e))
    }
  }

  return (
    <>
      {/* Artifacts light execution */}
      <section className="mb-6 wb-card p-5">
        <h2 className="mb-1 flex items-center gap-2 font-semibold"><span className="wb-chip h-6 w-6 rounded-lg bg-amber-100 text-amber-600 dark:bg-amber-400/15 dark:text-amber-300"><Zap className="h-3.5 w-3.5" /></span></h2>
        <p className="mb-4 text-xs leading-relaxed text-neutral-500">
          默认关闭。开启后聊天里的 Python / JavaScript 代码块出现「▶ 运行」按钮，HTML 代码块出现沙箱预览。
          代码在你本机以独立临时目录直接执行（Python 用工作台自带的运行环境），有超时与输出上限，但没有真正的沙箱隔离 —— 请只运行你理解用途的代码。
        </p>
        <div className="flex flex-wrap items-end gap-4">
          <label className="flex items-center gap-2 pb-2 text-sm">
            <input
              type="checkbox"
              checked={prefs.artifacts_enabled}
              onChange={(e) => setPrefs({ ...prefs, artifacts_enabled: e.target.checked })}
            />
            允许运行 AI 代码（opt-in）
          </label>
          <label className="flex flex-col gap-1 text-sm">
            单次运行超时（秒）
            <input
              type="number"
              min={1}
              max={120}
              value={prefs.artifacts_timeout}
              onChange={(e) => setPrefs({ ...prefs, artifacts_timeout: Number(e.target.value) || 30 })}
              className={`${inputCls} w-40`}
            />
          </label>
        </div>
      </section>

      {/* Image generation */}
      <section className="mb-6 wb-card p-5">
        <h2 className="mb-1 flex items-center gap-2 font-semibold"><span className="wb-chip h-6 w-6 rounded-lg bg-pink-100 text-pink-600 dark:bg-pink-400/15 dark:text-pink-300"><Image className="h-3.5 w-3.5" /></span></h2>
        <p className="mb-4 text-xs leading-relaxed text-neutral-500">
          开启后模型可调用 image_gen 工具作图，Notes 页也能用「🖼️ 配图」插入。生成的图片会下载到
          data/images/ 并以 /api/images/&lt;name&gt; 提供（DashScope 返回的原始链接带签名会过期）。
        </p>
        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-2 text-sm">
            <button
              type="button"
              onClick={() => setPrefs({ ...prefs, image_enabled: !prefs.image_enabled })}
              role="switch"
              aria-checked={prefs.image_enabled}
              aria-label="启用图片生成工具"
              className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
                prefs.image_enabled ? 'bg-violet-600' : 'bg-neutral-300 dark:bg-neutral-700'
              }`}
            >
              <span
                className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all ${
                  prefs.image_enabled ? 'left-[18px]' : 'left-0.5'
                }`}
              />
            </button>
            把 image_gen 工具暴露给模型（关闭后仅剩 Notes/设置页手动生成）
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1 text-sm">
              接口
              <select
                value={prefs.image_api}
                onChange={(e) => setPrefs({ ...prefs, image_api: e.target.value })}
                className={`${inputCls} w-52`}
              >
                <option value="dashscope">dashscope（阿里百炼原生）</option>
                <option value="openai">openai（/v1/images/generations）</option>
              </select>
            </label>
            <label className="flex flex-col gap-1 text-sm">
              Provider（取其 key 与 base_url）
              <select
                value={prefs.image_provider}
                onChange={(e) => setPrefs({ ...prefs, image_provider: e.target.value })}
                className={`${inputCls} w-44`}
              >
                <option value="">第一个已启用的</option>
                {providers.map((p) => (
                  <option key={p.id} value={p.name}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-sm">
              模型
              <input
                value={prefs.image_model}
                onChange={(e) => setPrefs({ ...prefs, image_model: e.target.value })}
                placeholder="qwen-image-3.0"
                className={`${inputCls} w-44`}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              尺寸
              <input
                value={prefs.image_size}
                onChange={(e) => setPrefs({ ...prefs, image_size: e.target.value })}
                placeholder="1024*1024 或 16:9"
                className={`${inputCls} w-40`}
              />
            </label>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex min-w-[280px] flex-1 flex-col gap-1 text-sm">
              测试描述
              <input
                value={imgPrompt}
                onChange={(e) => setImgPrompt(e.target.value)}
                className={inputCls}
              />
            </label>
            <button
              onClick={testImage}
              disabled={imgBusy}
              className="wb-btn-primary px-4 py-1.5 text-sm shadow-sm shadow-violet-300"
            >
              {imgBusy ? '生成中…' : prefsSaved ? '✓ 已保存设置' : '保存设置并测试生成'}
            </button>
          </div>
          {imgMsg && (
            <p
              className={`text-xs ${
                imgMsg.startsWith('✓') ? 'text-emerald-600 dark:text-emerald-400' : 'text-neutral-500'
              }`}
            >
              {imgMsg}
            </p>
          )}
          {images.length > 0 && (
            <div>
              <p className="mb-2 text-xs text-neutral-500">data/images/ · 共 {images.length} 张</p>
              <div className="flex flex-wrap gap-3">
                {images.slice(0, 12).map((im) => (
                  <div key={im.name} className="group relative">
                    <a href={im.url} target="_blank" rel="noreferrer" title={im.name}>
                      <img
                        src={im.url}
                        alt={im.name}
                        loading="lazy"
                        className="h-24 w-24 rounded-lg border border-neutral-200 object-cover dark:border-neutral-800"
                      />
                    </a>
                    <button
                      onClick={() => removeImage(im.name)}
                      aria-label={`删除 ${im.name}`}
                      className="absolute -right-1.5 -top-1.5 h-5 w-5 rounded-full bg-red-500 text-xs leading-5 text-white opacity-60 transition-opacity hover:opacity-100 focus-visible:opacity-100"
                    >
                      ×
                    </button>
                    <span className="mt-1 block w-24 truncate text-xs text-neutral-400">
                      {fmtSize(im.bytes)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </section>
    </>
  )
}
