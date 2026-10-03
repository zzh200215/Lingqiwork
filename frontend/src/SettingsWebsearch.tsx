// mcp 分区的网页搜索偏好组（方向 6 第十五刀拆出，2026-10-02 设置中心改版）：
// web_search 的搜索源与 Keenable API Key。纯偏好组：只编辑 prefs 字段，
// 改动由页面级自动保存落盘（与全页同一机制）。
import { inputCls, type WorkbenchPrefs } from './settingsShared'
import { SettingGroup, SettingRow } from './SettingsUI'

export default function SettingsWebsearch({
  prefs,
  setPrefs,
}: {
  prefs: WorkbenchPrefs
  setPrefs: (p: WorkbenchPrefs) => void
}) {
  return (
    <SettingGroup
      title="网页搜索"
      description="web_search 工具的搜索引擎。配置 Keenable API Key 后优先走 Keenable（稳定、带正文摘要）；免费爬取 Bing / DuckDuckGo 始终作为兜底。"
    >
      <SettingRow title="搜索源" htmlFor="pref-websearch-api">
        <select
          id="pref-websearch-api"
          value={prefs.websearch_api}
          onChange={(e) => setPrefs({ ...prefs, websearch_api: e.target.value })}
          className={`${inputCls} w-52`}
        >
          <option value="keenable">Keenable（搜索 API，推荐）</option>
          <option value="">免费爬取（Bing / DDG）</option>
        </select>
      </SettingRow>
      <SettingRow title="Keenable API Key" htmlFor="pref-websearch-key">
        <input
          id="pref-websearch-key"
          value={prefs.websearch_api_key}
          onChange={(e) => setPrefs({ ...prefs, websearch_api_key: e.target.value })}
          placeholder="keen_..."
          className={`${inputCls} w-72`}
        />
      </SettingRow>
    </SettingGroup>
  )
}
