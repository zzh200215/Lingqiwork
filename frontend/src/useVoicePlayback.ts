// 语音播报子系统（方向 6 第二十一刀，2026-09-30 自 App.tsx 拆出）：
// speakText 播/停同键切换、audioRef 单例、tts_auto 偏好加载（自动播报的触发点
// 在 runStream 收尾——父级经返回的 ttsAutoRef/speakText 使用）。
// 播报失败报到页级 error；tts_auto 拉不到就当没开（那笔 .catch(() => {}) 是
// **照原样搬家**，designRules 台账已记到本文件名下）。
import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { api } from './api'

export function useVoicePlayback(deps: {
  setError: Dispatch<SetStateAction<string>>
}) {
  const { setError } = deps
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const [speakingKey, setSpeakingKey] = useState<string | null>(null)
  const ttsAutoRef = useRef(false)

  async function speakText(content: string, key: string) {
    if (speakingKey === key) {
      audioRef.current?.pause()
      audioRef.current = null
      setSpeakingKey(null)
      return
    }
    audioRef.current?.pause()
    audioRef.current = null
    setSpeakingKey(key)
    try {
      const r = await api.tts(content)
      const audio = new Audio(r.url)
      audioRef.current = audio
      audio.onended = () => {
        setSpeakingKey(null)
        audioRef.current = null
      }
      audio.onerror = () => setSpeakingKey(null)
      await audio.play()
    } catch (e) {
      setSpeakingKey(null)
      setError(`语音播报失败：${String(e)}`)
    }
  }

  useEffect(() => {
    fetch('/api/settings/prefs')
      .then((r) => r.json())
      .then((p) => {
        ttsAutoRef.current = !!p.tts_auto
      })
      .catch(() => {})
  }, [])

  return { speakingKey, ttsAutoRef, speakText }
}
