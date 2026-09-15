/** 语音：录音 → 本地转写；以及把一段文字读出来。
 *
 *  `useVoiceInput` 这段逻辑原先在 `App.tsx`（聊天输入）与 `DashboardPage.tsx`
 *  （今日日记）里**各抄了一份，逐字相同**——只有「文字往哪放、错往哪说」不一样。
 *  第三处（零柒面板）要用时，抄第三份就太不像话了：抽出来，并把那两处一并迁过来。
 *
 *  转写全程在本地（faster-whisper），音频不上网——所以这里只关心麦克风权限与
 *  「别忘了把麦克风放掉」。 */
import { useCallback, useEffect, useRef, useState } from 'react'

import { api } from './api'

/** 短于这个字节数当误触：一次点击大约就是这个量级，里面没有可听内容。 */
const MIN_BLOB_BYTES = 800

export interface VoiceInput {
  recording: boolean
  transcribing: boolean
  /** 点一下开始录，再点一下结束并转写。 */
  toggle: () => void
  /** 主动放掉麦克风（组件卸载时也会自动放）。 */
  stop: () => void
}

export function useVoiceInput(
  onText: (text: string) => void,
  /** 出错往哪说。**空串 = 清干净**——与原来那两处 `setError('')` 的写法一致，
   *  所以调用方直接把自己的 setter 传进来就行，不用再包一层。 */
  onError: (message: string) => void
): VoiceInput {
  const [recording, setRecording] = useState(false)
  const [transcribing, setTranscribing] = useState(false)
  const recRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])

  // 回调每次渲染都是新函数，而 `onstop` 是异步触发的——必须存进 ref。
  // 否则它读到的是一年前那次渲染的闭包：`setInput(prev => prev + t)` 那种写法
  // 会因此把用户已经打进去的内容丢掉。
  const cb = useRef({ onText, onError })
  cb.current = { onText, onError }

  const stop = useCallback(() => {
    try {
      recRef.current?.stop()
    } catch {
      /* 已经停了 */
    }
  }, [])

  // 卸载时把麦克风放掉。不放的话标签页上的红点会一直亮着——用户会以为还在偷听。
  useEffect(() => stop, [stop])

  const toggle = useCallback(() => {
    if (recRef.current && recRef.current.state === 'recording') {
      stop()
      return
    }
    if (transcribing) return
    cb.current.onError('')
    navigator.mediaDevices
      .getUserMedia({ audio: true })
      .then((stream) => {
        const rec = new MediaRecorder(stream)
        chunksRef.current = []
        rec.ondataavailable = (e) => {
          if (e.data.size > 0) chunksRef.current.push(e.data)
        }
        rec.onstop = async () => {
          stream.getTracks().forEach((t) => t.stop())
          setRecording(false)
          const blob = new Blob(chunksRef.current, { type: rec.mimeType || 'audio/webm' })
          if (blob.size < MIN_BLOB_BYTES) return // 误触，没有可听内容
          setTranscribing(true)
          try {
            const r = await api.transcribeAudio(blob)
            if (r.text) cb.current.onText(r.text)
            else cb.current.onError('没有识别到语音内容')
          } catch (e) {
            cb.current.onError(`语音识别失败：${String(e)}`)
          } finally {
            setTranscribing(false)
          }
        }
        rec.start()
        recRef.current = rec
        setRecording(true)
      })
      .catch(() => cb.current.onError('无法访问麦克风 — 请检查系统/浏览器权限'))
  }, [transcribing, stop])

  return { recording, transcribing, toggle, stop }
}

/** 一段文字 → 可以播的音频元素。**不在这里播**：调用方要先挂 `onended`
 *  再调 `play()`，否则很短的句子可能在挂回调之前就播完了。 */
export async function makeSpeech(
  text: string,
  voice = '',
  engine = 'edge'
): Promise<HTMLAudioElement> {
  const r = await api.tts(text, voice, engine)
  return new Audio(r.url)
}
