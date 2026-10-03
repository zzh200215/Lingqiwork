// content 分区的两组偏好（方向 6 第十五刀拆出，2026-10-02 设置中心改版）：
// Artifacts 轻执行 + 图片生成（配置、测试生成与图库管理）。
// 挂载时自拉图库，失败走 failLoad 汇总到页级错误条；
// prefs/setPrefs 走页面级自动保存；providers 只读传入（image_provider 的候选清单）。
import { useEffect, useState } from 'react'
import { api, type ImageItem, type ProviderConfig } from './api'
import { fmtSize, inputCls, type WorkbenchPrefs } from './settingsShared'
import { askConfirm, SettingField, SettingGroup, SettingRow, SettingSwitch } from './SettingsUI'

export default function SettingsContent({
  prefs,
  setPrefs,
  savePrefs,
  providers,
  failLoad,
}: {
  prefs: WorkbenchPrefs
  setPrefs: (p: WorkbenchPrefs) => void
  savePrefs: () => Promise<void>
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
    if (
      !(await askConfirm({
        title: `删除图片「${name}」？`,
        description: '引用它的笔记/对话会显示裂图。',
        confirmLabel: '删除',
      }))
    )
      return
    try {
      await api.deleteImage(name)
      const list = await api.listImages()
      setImages(list.images)
    } catch (e) {
      setImgMsg(String(e))
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Artifacts light execution */}
      <SettingGroup
        title="Artifacts 轻执行"
        description="开启后聊天里的 Python / JavaScript 代码块出现「▶ 运行」按钮，HTML 代码块出现沙箱预览。代码在你本机以独立临时目录直接执行（Python 用工作台自带的运行环境），有超时与输出上限，但没有真正的沙箱隔离 —— 请只运行你理解用途的代码。"
      >
        <SettingRow title="允许运行 AI 代码" description="默认关闭；这是一个 opt-in 能力。">
          <SettingSwitch
            checked={prefs.artifacts_enabled}
            onChange={(v) => setPrefs({ ...prefs, artifacts_enabled: v })}
            ariaLabel="允许运行 AI 代码"
          />
        </SettingRow>
        <SettingRow title="单次运行超时" description="超过这个秒数的代码执行会被中断。" htmlFor="pref-artifacts-timeout">
          <input
            id="pref-artifacts-timeout"
            type="number"
            min={1}
            max={120}
            value={prefs.artifacts_timeout}
            onChange={(e) => setPrefs({ ...prefs, artifacts_timeout: Number(e.target.value) || 30 })}
            className={`${inputCls} w-24`}
          />
        </SettingRow>
      </SettingGroup>

      {/* Image generation */}
      <SettingGroup
        title="图片生成"
        description="开启后模型可调用 image_gen 工具作图，Notes 页也能用「🖼️ 配图」插入。生成的图片会下载到 data/images/ 并以 /api/images/<name> 提供（DashScope 返回的原始链接带签名会过期）。"
      >
        <SettingRow title="暴露 image_gen 工具给模型" description="关闭后仅剩 Notes / 设置页手动生成。">
          <SettingSwitch
            checked={prefs.image_enabled}
            onChange={(v) => setPrefs({ ...prefs, image_enabled: v })}
            ariaLabel="启用图片生成工具"
          />
        </SettingRow>
        <div className="grid gap-x-6 gap-y-3 px-5 py-3.5 sm:grid-cols-2">
          <SettingField label="接口">
            <select
              value={prefs.image_api}
              onChange={(e) => setPrefs({ ...prefs, image_api: e.target.value })}
              className={inputCls}
            >
              <option value="dashscope">dashscope（阿里百炼原生）</option>
              <option value="openai">openai（/v1/images/generations）</option>
            </select>
          </SettingField>
          <SettingField label="Provider" hint="取其 key 与 base_url">
            <select
              value={prefs.image_provider}
              onChange={(e) => setPrefs({ ...prefs, image_provider: e.target.value })}
              className={inputCls}
            >
              <option value="">第一个已启用的</option>
              {providers.map((p) => (
                <option key={p.id} value={p.name}>
                  {p.name}
                </option>
              ))}
            </select>
          </SettingField>
          <SettingField label="模型">
            <input
              value={prefs.image_model}
              onChange={(e) => setPrefs({ ...prefs, image_model: e.target.value })}
              placeholder="qwen-image-3.0"
              className={inputCls}
            />
          </SettingField>
          <SettingField label="尺寸">
            <input
              value={prefs.image_size}
              onChange={(e) => setPrefs({ ...prefs, image_size: e.target.value })}
              placeholder="1024*1024 或 16:9"
              className={inputCls}
            />
          </SettingField>
        </div>
        {/* 测试生成：一行输入 + 主按钮；结果与图库紧随其后 */}
        <div className="flex flex-wrap items-end gap-2 px-5 py-3.5">
          <label className="flex min-w-[240px] flex-1 flex-col gap-1 text-sm">
            <span className="font-medium">试一张</span>
            <input
              value={imgPrompt}
              onChange={(e) => setImgPrompt(e.target.value)}
              className={inputCls}
            />
          </label>
          <button onClick={testImage} disabled={imgBusy} className="wb-btn-primary px-4 py-1.5 text-sm">
            {imgBusy ? '生成中…' : '测试生成'}
          </button>
        </div>
        {imgMsg && (
          <p
            className={`px-5 pb-3.5 text-xs ${
              imgMsg.startsWith('✓') ? 'text-emerald-600 dark:text-emerald-400' : 'text-neutral-500'
            }`}
          >
            {imgMsg}
          </p>
        )}
        {images.length > 0 && (
          <div className="px-5 pb-4">
            <p className="mb-2 text-xs text-neutral-500">图库 · data/images/ · 共 {images.length} 张</p>
            <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-6">
              {images.slice(0, 12).map((im) => (
                <div key={im.name} className="group relative">
                  <a href={im.url} target="_blank" rel="noreferrer" title={im.name}>
                    <img
                      src={im.url}
                      alt={im.name}
                      loading="lazy"
                      className="aspect-square w-full rounded-lg border border-neutral-200 object-cover dark:border-neutral-800"
                    />
                  </a>
                  <button
                    onClick={() => removeImage(im.name)}
                    aria-label={`删除 ${im.name}`}
                    className="absolute -right-1.5 -top-1.5 h-5 w-5 rounded-full bg-red-500 text-xs leading-5 text-white opacity-60 transition-opacity hover:opacity-100 focus-visible:opacity-100"
                  >
                    ×
                  </button>
                  <span className="mt-1 block truncate text-xs text-neutral-400">{fmtSize(im.bytes)}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </SettingGroup>
    </div>
  )
}
