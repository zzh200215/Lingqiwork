// 通用分区的六张分组卡（2026-10-02 设置中心改版自 SettingsPage 拆出）：
// AI 行为 / 知识检索 / 记忆 / 语音 / 播报 / 播客 / 摘要与通知。
// 此前它们是同一张卡里的连续表单（原生 checkbox + 长说明混排）；
// 现在每组一张 SettingGroup，每行 SettingRow（左标题+说明，右控件）。
// prefs/setPrefs 经 props 传入，改动由页面级自动保存落盘。
import { inputCls, type WorkbenchPrefs } from './settingsShared'
import { SettingGroup, SettingRow, SettingSwitch } from './SettingsUI'

export default function SettingsGeneral({
  prefs,
  setPrefs,
  ttsVoices,
}: {
  prefs: WorkbenchPrefs
  setPrefs: (p: WorkbenchPrefs) => void
  /** 后端音色清单（TTS / 播客的下拉候选）；拉不到时各下拉用自己的兜底一项 */
  ttsVoices: string[]
}) {
  const voices = ttsVoices.length ? ttsVoices : ['zh-CN-XiaoxiaoNeural']
  return (
    <div className="flex flex-col gap-4">
      <SettingGroup title="AI 行为" description="每次对话都生效的全局行为。">
        <SettingRow
          stacked
          title="系统提示词"
          description="每次对话都会作为 system 消息注入，模型先读它再回答。"
        >
          <textarea
            value={prefs.system_prompt}
            onChange={(e) => setPrefs({ ...prefs, system_prompt: e.target.value })}
            rows={3}
            placeholder="例如：你是一个简洁的中文助手，回答尽量给出要点式结构。"
            className={`${inputCls} resize-y`}
          />
        </SettingRow>
      </SettingGroup>

      <SettingGroup title="知识检索" description="控制 AI 如何从知识库中获取信息。">
        <SettingRow
          title="RAG 检索片段数"
          description="控制每次查询最多带回多少相关片段。"
          htmlFor="pref-rag-top-k"
        >
          <input
            id="pref-rag-top-k"
            type="number"
            min={1}
            max={20}
            value={prefs.rag_top_k}
            onChange={(e) => setPrefs({ ...prefs, rag_top_k: Number(e.target.value) })}
            className={`${inputCls} w-24`}
          />
        </SettingRow>
        <SettingRow
          title="混合检索"
          description="同时使用 BM25 关键词与向量语义检索（RRF 融合）；关闭则仅向量检索。"
        >
          <SettingSwitch
            checked={prefs.hybrid_search}
            onChange={(v) => setPrefs({ ...prefs, hybrid_search: v })}
            ariaLabel="混合检索"
          />
        </SettingRow>
        <SettingRow
          title="Rerank 精排"
          description="对候选片段做交叉编码器二次排序，更准但检索稍慢（本地模型已缓存）。"
        >
          <SettingSwitch
            checked={prefs.rerank_enabled}
            onChange={(v) => setPrefs({ ...prefs, rerank_enabled: v })}
            ariaLabel="Rerank 精排"
          />
        </SettingRow>
        <SettingRow title="全上下文模式" description="命中的短文档整篇注入，不只给切块片段。">
          <SettingSwitch
            checked={prefs.full_context}
            onChange={(v) => setPrefs({ ...prefs, full_context: v })}
            ariaLabel="全上下文模式"
          />
        </SettingRow>
        {prefs.full_context && (
          <SettingRow
            title="整篇注入上限"
            description="超过这个长度的文档仍回退为切块片段。"
            className="pl-14"
            htmlFor="pref-fc-max-chars"
          >
            <input
              id="pref-fc-max-chars"
              type="number"
              min={500}
              max={20000}
              step={500}
              value={prefs.full_context_max_chars}
              onChange={(e) => setPrefs({ ...prefs, full_context_max_chars: Number(e.target.value) })}
              className={`${inputCls} w-28`}
            />
          </SettingRow>
        )}
      </SettingGroup>

      <SettingGroup title="记忆" description="长期记忆与它的夜间整理。">
        <SettingRow
          title="长期记忆"
          description="把已记住的用户事实注入每次对话；关闭后模型也不能读写记忆。"
        >
          <SettingSwitch
            checked={prefs.memory_enabled}
            onChange={(v) => setPrefs({ ...prefs, memory_enabled: v })}
            ariaLabel="长期记忆"
          />
        </SettingRow>
        <SettingRow
          title="自动记忆"
          description="每轮对话结束后让模型自主判断是否值得记住（开销：每轮一次轻量调用）。"
        >
          <SettingSwitch
            checked={prefs.automemory_enabled}
            onChange={(v) => setPrefs({ ...prefs, automemory_enabled: v })}
            ariaLabel="自动记忆"
          />
        </SettingRow>
        <SettingRow
          title="睡眠期整理"
          description="每天凌晨自动合并语义重复的记忆，只在发现重复时才调用模型。"
        >
          <div className="flex items-center gap-2.5">
            <input
              type="time"
              value={prefs.memory_tidy_time}
              disabled={!prefs.memory_tidy_enabled}
              onChange={(e) => setPrefs({ ...prefs, memory_tidy_time: e.target.value })}
              className={`${inputCls} w-28 disabled:opacity-40`}
            />
            <SettingSwitch
              checked={prefs.memory_tidy_enabled}
              onChange={(v) => setPrefs({ ...prefs, memory_tidy_enabled: v })}
              ariaLabel="睡眠期整理"
            />
          </div>
        </SettingRow>
      </SettingGroup>

      <SettingGroup title="语音" description="本地语音识别，音频不出本机；聊天输入框旁点 🎤 即可语音输入。">
        <SettingRow
          title="识别模型"
          description="本地 faster-whisper，首次使用时下载。"
          htmlFor="pref-asr-model"
        >
          <select
            id="pref-asr-model"
            value={prefs.asr_model}
            onChange={(e) => setPrefs({ ...prefs, asr_model: e.target.value })}
            className={`${inputCls} w-64`}
          >
            <option value="tiny">tiny — 最快，中文一般（75MB）</option>
            <option value="base">base — 快（145MB）</option>
            <option value="small">small — 推荐（480MB）</option>
            <option value="medium">medium — 最准（1.5GB）</option>
          </select>
        </SettingRow>
        <SettingRow title="说话语言" htmlFor="pref-asr-lang">
          <select
            id="pref-asr-lang"
            value={prefs.asr_language}
            onChange={(e) => setPrefs({ ...prefs, asr_language: e.target.value })}
            className={`${inputCls} w-40`}
          >
            <option value="auto">自动检测</option>
            <option value="zh">中文</option>
            <option value="en">English</option>
            <option value="ja">日本語</option>
          </select>
        </SettingRow>
      </SettingGroup>

      <SettingGroup title="播报" description="悬停 AI 回答点 🔊 播报；edge 失败自动回退本地语音。">
        <SettingRow title="播报音色" htmlFor="pref-tts-voice">
          <select
            id="pref-tts-voice"
            value={prefs.tts_voice}
            onChange={(e) => setPrefs({ ...prefs, tts_voice: e.target.value })}
            className={`${inputCls} w-60`}
          >
            {voices.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </SettingRow>
        <SettingRow title="播报引擎" htmlFor="pref-tts-engine">
          <select
            id="pref-tts-engine"
            value={prefs.tts_engine}
            onChange={(e) => setPrefs({ ...prefs, tts_engine: e.target.value })}
            className={`${inputCls} w-64`}
          >
            <option value="edge">edge-tts — 微软神经音色，自然（联网）</option>
            <option value="sapi">Windows 本地语音 — 离线可用（音色较机械）</option>
          </select>
        </SettingRow>
        <SettingRow title="回答完成后自动朗读">
          <SettingSwitch
            checked={prefs.tts_auto}
            onChange={(v) => setPrefs({ ...prefs, tts_auto: v })}
            ariaLabel="回答完成后自动朗读"
          />
        </SettingRow>
      </SettingGroup>

      <SettingGroup title="播客" description="笔记页 🎙 把笔记变成双人对谈音频；两个音色选不同的才有对话感。">
        <SettingRow title="主持人音色" htmlFor="pref-podcast-host">
          <select
            id="pref-podcast-host"
            value={prefs.podcast_host_voice}
            onChange={(e) => setPrefs({ ...prefs, podcast_host_voice: e.target.value })}
            className={`${inputCls} w-60`}
          >
            {(ttsVoices.length ? ttsVoices : ['zh-CN-YunxiNeural']).map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </SettingRow>
        <SettingRow title="嘉宾音色" htmlFor="pref-podcast-guest">
          <select
            id="pref-podcast-guest"
            value={prefs.podcast_guest_voice}
            onChange={(e) => setPrefs({ ...prefs, podcast_guest_voice: e.target.value })}
            className={`${inputCls} w-60`}
          >
            {(ttsVoices.length ? ttsVoices : ['zh-CN-XiaoxiaoNeural']).map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </SettingRow>
      </SettingGroup>

      <SettingGroup title="摘要与通知" description="每天自动生成的简报，与任务失败时的系统通知。">
        <SettingRow
          title="每日定时笔记摘要"
          description="到点把当天笔记合成一份摘要，写入 vault/digests/ 并自动进知识库索引。"
        >
          <div className="flex items-center gap-2.5">
            <input
              type="time"
              value={prefs.digest_time}
              disabled={!prefs.digest_enabled}
              onChange={(e) => setPrefs({ ...prefs, digest_time: e.target.value })}
              className={`${inputCls} w-28 disabled:opacity-40`}
            />
            <SettingSwitch
              checked={prefs.digest_enabled}
              onChange={(v) => setPrefs({ ...prefs, digest_enabled: v })}
              ariaLabel="每日定时笔记摘要"
            />
          </div>
        </SettingRow>
        <SettingRow
          title="摘要生成后自动转为一期双人播客"
          description="每天定时把摘要读成音频，出现在笔记页 🎙 播客列表（标题「笔记简报 · 日期」）。"
        >
          <SettingSwitch
            checked={prefs.podcast_daily_enabled}
            disabled={!prefs.digest_enabled}
            onChange={(v) => setPrefs({ ...prefs, podcast_daily_enabled: v })}
            ariaLabel="摘要生成后自动转为一期双人播客"
          />
        </SettingRow>
        <SettingRow
          title="任务桌面通知"
          description="定时与自动任务失败时弹 Windows 通知；智能体任务完成也通知。"
        >
          <SettingSwitch
            checked={prefs.desktop_notify}
            onChange={(v) => setPrefs({ ...prefs, desktop_notify: v })}
            ariaLabel="任务桌面通知"
          />
        </SettingRow>
      </SettingGroup>
    </div>
  )
}
