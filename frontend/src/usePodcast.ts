import { useCallback, useState } from 'react'
import { api, type PodcastEntry } from './api'
import { streamPodcastGenerate } from './stream'

// 双人播客（右侧栏）领域——从 NotesPage 抽出（方向 6）。面板的开合与互斥也在这里：
// 打开播客要收起对话/出卡面板，宿主传入那两块面板的开关。
export function usePodcast(deps: {
  activePath: string | null
  setChatOpen: (v: boolean) => void
  setCardsOpen: (v: boolean) => void
}) {
  const { activePath, setChatOpen, setCardsOpen } = deps
  const [podOpen, setPodOpen] = useState(false)
  const [podBusy, setPodBusy] = useState(false)
  const [podMsg, setPodMsg] = useState('')
  const [podList, setPodList] = useState<PodcastEntry[]>([])
  const [podHost, setPodHost] = useState('')
  const [podGuest, setPodGuest] = useState('')
  const [podVoices, setPodVoices] = useState<string[]>([])
  const [podScriptId, setPodScriptId] = useState<string | null>(null)
  const [podSources, setPodSources] = useState<string[]>([])
  const [podStage, setPodStage] = useState('')

  const loadPodcasts = useCallback(async () => {
    try {
      const { podcasts } = await api.listPodcasts()
      setPodList(podcasts)
    } catch (e) {
      setPodMsg(String(e))
    }
  }, [])

  function togglePod() {
    const next = !podOpen
    setPodOpen(next)
    if (next) {
      setChatOpen(false)
      setCardsOpen(false)
      setPodSources(activePath ? [activePath] : [])
      if (!podVoices.length)
        api
          .ttsVoices()
          .then((r) => setPodVoices(r.voices))
          .catch(() => setPodVoices([]))
      void loadPodcasts()
    }
  }

  function addPodSource(rel: string) {
    if (!rel || podSources.includes(rel) || podSources.length >= 5) return
    setPodSources((prev) => [...prev, rel])
  }

  async function generatePod() {
    if (podBusy || !podSources.length) return
    if (podHost && podGuest && podHost === podGuest) {
      if (!confirm('主持人与嘉宾音色相同，会听不出对话感。仍要继续吗？')) return
    }
    const label = podSources.length > 1 ? `${podSources.length} 篇笔记合并` : `「${podSources[0]}」`
    if (!confirm(`把${label}生成为双人播客音频？LLM 写脚本 + 逐句配音，约 1-3 分钟。`)) return
    setPodBusy(true)
    setPodMsg('')
    setPodStage('准备中')
    try {
      const done = await streamPodcastGenerate(podSources, podHost, podGuest, '', (s) => {
        setPodStage(
          s.stage === 'script'
            ? '写脚本中'
            : s.stage === 'tts'
              ? `配音 ${s.index ?? '?'}/${s.total ?? '?'} 句`
              : s.stage === 'assemble'
                ? '拼接音频'
                : s.stage
        )
      })
      if (done.ok) await loadPodcasts()
      else setPodMsg(done.error || '生成失败')
    } catch (e) {
      setPodMsg(String(e))
    } finally {
      setPodBusy(false)
      setPodStage('')
    }
  }

  async function removePod(id: string) {
    if (!confirm('删除这期播客音频？')) return
    try {
      await api.deletePodcast(id)
      setPodScriptId((s) => (s === id ? null : s))
      await loadPodcasts()
    } catch (e) {
      setPodMsg(String(e))
    }
  }

  return {
    podOpen,
    setPodOpen,
    togglePod,
    podBusy,
    podMsg,
    podList,
    podHost,
    setPodHost,
    podGuest,
    setPodGuest,
    podVoices,
    podScriptId,
    setPodScriptId,
    podSources,
    setPodSources,
    podStage,
    addPodSource,
    generatePod,
    removePod,
  }
}
