// 附件与联想输入子系统（方向 6 第二十刀，2026-09-30 自 App.tsx 拆出）：
// 提示词斜杠联想（/）、笔记引用联想（#）、文件与图片附件、发送队列、本地 OCR、截图。
// 状态 + 匹配 memo + 六个处理器自含；与 ChatView 的耦合只有输入草稿三件套
// （input/setInput/setError），经 deps 注入。send/dispatchMessage/runStream 在父级，
// 经返回的 attached*/queued* 成员读写附件与队列——同名返回，父级 JSX 零改动。
// 两个 `.catch(() => {})`（提示词/笔记清单拉不到就当空）是**照原样搬家**，
// 不是新加的吞错——designRules 台账已把这两笔记到本文件名下。
import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { api, type PromptItem } from './api'

export function useAttachments(deps: {
  input: string
  setInput: Dispatch<SetStateAction<string>>
  setError: Dispatch<SetStateAction<string>>
}) {
  const { input, setInput, setError } = deps
  const [prompts, setPrompts] = useState<PromptItem[]>([])
  const [slashOpen, setSlashOpen] = useState(false)
  const [hashOpen, setHashOpen] = useState(false)
  const [noteFiles, setNoteFiles] = useState<string[]>([])
  const [attachedFiles, setAttachedFiles] = useState<string[]>([])
  const [attachedImages, setAttachedImages] = useState<{ name: string; url: string; uploading: boolean }[]>([])
  const [queuedMsgs, setQueuedMsgs] = useState<string[]>([])
  const queuedRef = useRef<string[]>([])
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const [ocrBusy, setOcrBusy] = useState('')

  useEffect(() => {
    queuedRef.current = queuedMsgs
  }, [queuedMsgs])

  useEffect(() => {
    api.listPrompts().then(setPrompts).catch(() => {})
    api.listNotes().then((r) => setNoteFiles(r.files.map((f) => f.path))).catch(() => {})
  }, [])

  const slashMatches = useMemo(() => {
    if (!slashOpen) return []
    const q = input.slice(1).trim().toLowerCase()
    return prompts.filter(
      (p) => !q || p.title.toLowerCase().includes(q) || p.content.toLowerCase().includes(q)
    )
  }, [slashOpen, input, prompts])

  // # command: last whitespace-delimited token starting with # picks a vault file
  const hashToken = useMemo(() => {
    const m = input.match(/(?:^|\s)#([^\s#]*)$/)
    return m ? m[1] : null
  }, [input])
  const hashMatches = useMemo(() => {
    if (!hashOpen || hashToken === null) return []
    const q = hashToken.toLowerCase()
    return noteFiles.filter((f) => !q || f.toLowerCase().includes(q)).slice(0, 20)
  }, [hashOpen, hashToken, noteFiles])

  function applyPrompt(p: PromptItem) {
    setSlashOpen(false)
    const vars = [...p.content.matchAll(/\{([^{}\n]{1,30})\}/g)].map((m) => m[1])
    if (!vars.length) {
      setInput(p.content)
      return
    }
    const original = input
    setInput(p.content)
    for (const v of vars) {
      const val = window.prompt(`提示词「${p.title}」中的 {${v}} 填入：`, '')
      if (val === null) {
        setInput(original)
        return
      }
      if (val) setInput((prev) => prev.replace(`{${v}}`, val))
    }
  }

  function attachFile(path: string) {
    setHashOpen(false)
    setAttachedFiles((prev) => (prev.includes(path) ? prev : [...prev, path]))
    // strip the trailing "#token" fragment from the input
    setInput((prev) => prev.replace(/(?:^|\s)#[^\s#]*$/, (m) => (m[0] === '#' ? '' : m[0])))
  }

  async function attachImage(file: File) {
    if (!file.type.startsWith('image/')) {
      setError('只支持图片文件（png/jpg/webp）')
      return
    }
    if (file.size > 20 * 1024 * 1024) {
      setError('图片超过 20MB 上限')
      return
    }
    const placeholder = { name: file.name, url: URL.createObjectURL(file), uploading: true }
    setAttachedImages((prev) => [...prev, placeholder])
    try {
      const saved = await api.uploadImage(file)
      setAttachedImages((prev) =>
        prev.map((im) => (im === placeholder ? { name: saved.name, url: saved.url, uploading: false } : im))
      )
    } catch (e) {
      setAttachedImages((prev) => prev.filter((im) => im !== placeholder))
      setError(String(e))
    }
  }

  function handlePaste(e: React.ClipboardEvent) {
    const imgs = [...e.clipboardData.items].filter((it) => it.type.startsWith('image/'))
    if (!imgs.length) return
    e.preventDefault()
    for (const it of imgs) {
      const f = it.getAsFile()
      if (f) void attachImage(f)
    }
  }

  async function captureScreen() {
    let stream: MediaStream | null = null
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false })
      const video = document.createElement('video')
      video.srcObject = stream
      video.muted = true
      await video.play()
      await new Promise((r) => setTimeout(r, 150)) // let the first frame land
      if (!video.videoWidth) throw new Error('画面尚未就绪')
      const canvas = document.createElement('canvas')
      canvas.width = video.videoWidth
      canvas.height = video.videoHeight
      canvas.getContext('2d')!.drawImage(video, 0, 0)
      const blob = await new Promise<Blob | null>((res) => canvas.toBlob((b) => res(b), 'image/png'))
      if (blob) {
        await attachImage(new File([blob], `screenshot-${Date.now()}.png`, { type: 'image/png' }))
      }
    } catch (e) {
      const msg = String(e)
      if (!msg.includes('Permission denied') && !msg.includes('NotAllowedError')) {
        setError(`截图失败：${msg}`)
      } // 否则视为用户取消了系统选择框
    } finally {
      stream?.getTracks().forEach((t) => t.stop())
    }
  }

  async function ocrAttached(im: { name: string; url: string }) {
    const name = im.url.startsWith('/api/images/') ? im.url.split('/').pop()! : im.name
    if (ocrBusy) return
    setOcrBusy(name)
    setError('')
    try {
      const r = await api.ocrImage(name)
      if (r.text) setInput((prev) => (prev ? `${prev}\n${r.text}` : r.text))
      else setError('没有识别到图中的文字')
    } catch (e) {
      setError(`OCR 失败：${String(e)}`)
    } finally {
      setOcrBusy('')
    }
  }

  return {
    slashOpen,
    setSlashOpen,
    hashOpen,
    setHashOpen,
    attachedFiles,
    setAttachedFiles,
    attachedImages,
    setAttachedImages,
    queuedMsgs,
    setQueuedMsgs,
    queuedRef,
    fileInputRef,
    ocrBusy,
    slashMatches,
    hashMatches,
    applyPrompt,
    attachFile,
    attachImage,
    handlePaste,
    captureScreen,
    ocrAttached,
  }
}
