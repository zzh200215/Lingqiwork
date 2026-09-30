// mcp 分区的 websearch 偏好卡（方向 6 第十五刀，2026-09-30 自 SettingsPage 拆出）：
// web_search 的搜索源与 Keenable API Key。纯表单卡：只编辑 prefs 字段，
// 没有自己的保存按钮（与拆分前一致——改动由页面级 savePrefs 统一落盘）。
import { Globe } from 'lucide-react'
import { inputCls, type WorkbenchPrefs } from './settingsShared'

export default function SettingsWebsearch({
  prefs,
  setPrefs,
}: {
  prefs: WorkbenchPrefs
  setPrefs: (p: WorkbenchPrefs) => void
}) {
  return (
    <>
      <section className="mb-6 flex flex-col gap-3 wb-card p-5">
        <h2 className="mb-1 flex items-center gap-2 font-semibold"><span className="wb-chip h-6 w-6 rounded-lg bg-sky-100 text-sky-600 dark:bg-sky-400/15 dark:text-sky-300"><Globe className="h-3.5 w-3.5" /></span></h2>
        <p className="-mt-1 text-xs leading-relaxed text-neutral-400">
          web_search 工具的搜索引擎。配置 Keenable API Key 后优先走 Keenable（稳定、带正文摘要）；
          免费爬取 Bing / DuckDuckGo 始终作为兜底。
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-sm">
            搜索源
            <select
              value={prefs.websearch_api}
              onChange={(e) => setPrefs({ ...prefs, websearch_api: e.target.value })}
              className={`${inputCls} w-52`}
            >
              <option value="keenable">Keenable（搜索 API，推荐）</option>
              <option value="">免费爬取（Bing / DDG）</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Keenable API Key
            <input
              value={prefs.websearch_api_key}
              onChange={(e) => setPrefs({ ...prefs, websearch_api_key: e.target.value })}
              placeholder="keen_..."
              className={`${inputCls} w-96`}
            />
          </label>
        </div>
      </section>
    </>
  )
}
