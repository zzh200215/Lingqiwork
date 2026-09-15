// 语音输入：录音 → 本地转写。这段逻辑原先在聊天页与今日日记里各抄了一份，
// 抽成 hook 之后**一处**测得着——这也正是抽它的理由之一。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'

vi.mock('./api', () => ({ api: { transcribeAudio: vi.fn(), tts: vi.fn() } }))
import { api } from './api'
import { useVoiceInput } from './voice'

/** 假的 MediaRecorder：能录、能停，并把「录到多少字节」交给我们控制。 */
class FakeRecorder {
  static last: FakeRecorder | null = null
  state: 'inactive' | 'recording' = 'inactive'
  mimeType = 'audio/webm'
  ondataavailable: ((e: { data: Blob }) => void) | null = null
  onstop: (() => void) | null = null
  constructor(public stream: { getTracks: () => { stop: () => void }[] }) {
    FakeRecorder.last = this
  }
  start() {
    this.state = 'recording'
  }
  stop() {
    this.state = 'inactive'
    this.onstop?.()
  }
  /** 模拟录到 `bytes` 字节然后停下。 */
  finish(bytes: number) {
    this.ondataavailable?.({ data: new Blob([new Uint8Array(bytes)]) })
    this.stop()
  }
}

const stopTrack = vi.fn()
let getUserMedia: ReturnType<typeof vi.fn>

/** `/api/asr/transcribe` 的返回形状（测试只关心 text，其余给个合理值）。 */
function asrResult(text: string) {
  return { text, language: 'zh', duration: 3 }
}

beforeEach(() => {
  vi.mocked(api.transcribeAudio).mockReset()
  FakeRecorder.last = null
  stopTrack.mockClear()
  getUserMedia = vi.fn().mockResolvedValue({ getTracks: () => [{ stop: stopTrack }] })
  Object.defineProperty(navigator, 'mediaDevices', {
    value: { getUserMedia },
    configurable: true,
  })
  vi.stubGlobal('MediaRecorder', FakeRecorder)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function setup() {
  const onText = vi.fn()
  const onError = vi.fn()
  const hook = renderHook(() => useVoiceInput(onText, onError))
  return { ...hook, onText, onError }
}

describe('useVoiceInput', () => {
  it('点一下开始录，再点一下结束并转写', async () => {
    vi.mocked(api.transcribeAudio).mockResolvedValue(asrResult('在吗'))
    const { result, onText } = setup()

    await act(async () => {
      result.current.toggle()
    })
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true })
    expect(result.current.recording).toBe(true)

    await act(async () => {
      FakeRecorder.last!.finish(5000)
    })
    expect(result.current.recording).toBe(false)
    expect(api.transcribeAudio).toHaveBeenCalled()
    expect(onText).toHaveBeenCalledWith('在吗')
  })

  it('转写出来的文字交给调用方决定往哪放', async () => {
    vi.mocked(api.transcribeAudio).mockResolvedValue(asrResult('接着上次说'))
    const { result, onText } = setup()
    await act(async () => {
      result.current.toggle()
    })
    await act(async () => {
      FakeRecorder.last!.finish(5000)
    })
    expect(onText).toHaveBeenCalledTimes(1)
  })

  it('短于 800 字节当误触，不去转写', async () => {
    const { result, onText } = setup()
    await act(async () => {
      result.current.toggle()
    })
    await act(async () => {
      FakeRecorder.last!.finish(200)
    })
    expect(api.transcribeAudio).not.toHaveBeenCalled()
    expect(onText).not.toHaveBeenCalled()
  })

  it('录完之后麦克风必须放掉', async () => {
    // 不放的话标签页上的红点一直亮着，用户会以为还在偷听
    vi.mocked(api.transcribeAudio).mockResolvedValue(asrResult('x'))
    const { result } = setup()
    await act(async () => {
      result.current.toggle()
    })
    await act(async () => {
      FakeRecorder.last!.finish(5000)
    })
    expect(stopTrack).toHaveBeenCalled()
  })

  it('没识别出内容时说一句人话', async () => {
    vi.mocked(api.transcribeAudio).mockResolvedValue(asrResult(''))
    const { result, onError } = setup()
    await act(async () => {
      result.current.toggle()
    })
    await act(async () => {
      FakeRecorder.last!.finish(5000)
    })
    expect(onError).toHaveBeenCalledWith('没有识别到语音内容')
  })

  it('转写失败说失败，不静默', async () => {
    vi.mocked(api.transcribeAudio).mockRejectedValue(new Error('boom'))
    const { result, onError } = setup()
    await act(async () => {
      result.current.toggle()
    })
    await act(async () => {
      FakeRecorder.last!.finish(5000)
    })
    expect(String(onError.mock.calls.at(-1)?.[0])).toContain('语音识别失败')
  })

  it('麦克风拿不到时说权限问题', async () => {
    getUserMedia.mockRejectedValue(new Error('denied'))
    const { result, onError } = setup()
    await act(async () => {
      result.current.toggle()
    })
    expect(String(onError.mock.calls.at(-1)?.[0])).toContain('无法访问麦克风')
    expect(result.current.recording).toBe(false)
  })

  it('开始录之前先把上一条错清掉', async () => {
    const { result, onError } = setup()
    await act(async () => {
      result.current.toggle()
    })
    expect(onError).toHaveBeenCalledWith('')
  })

  it('卸载时把麦克风放掉', async () => {
    const { result, unmount } = setup()
    await act(async () => {
      result.current.toggle()
    })
    unmount()
    expect(FakeRecorder.last!.state).toBe('inactive')
  })
})
