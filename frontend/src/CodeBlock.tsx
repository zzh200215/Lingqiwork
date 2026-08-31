import { useEffect, useState } from 'react'
import { api, type ArtifactsResult, type ArtifactsStatus } from './api'

// Code block with copy + (opt-in) run/preview buttons; used as the `pre`
// renderer in markdown. Python/JS run on the backend (artifacts feature must
// be enabled in Settings); HTML previews in a sandboxed iframe, no backend.
export default function CodeBlock({ children }: { children?: React.ReactNode }) {
  const [copied, setCopied] = useState(false)
  const [status, setStatus] = useState<ArtifactsStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<ArtifactsResult | null>(null)
  const [error, setError] = useState('')
  const [preview, setPreview] = useState(false)

  const code = extractText(children)
  const lang = extractLang(children)

  // one status fetch shared by every code block on the page
  useEffect(() => {
    if (status !== null || !lang) return
    fetchStatus().then(setStatus).catch(() => setStatus({ enabled: false, timeout: 30, python: '', node: null, languages: [] }))
  }, [lang, status])

  const runnable = lang === 'python' || lang === 'javascript' || lang === 'js'
  const previewable = lang === 'html'

  function copy() {
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  async function run() {
    if (busy || !lang) return
    setBusy(true)
    setError('')
    setResult(null)
    try {
      const r = await api.runArtifact(code, lang === 'js' ? 'javascript' : lang)
      setResult(r)
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="group relative">
      <div className="absolute right-2 top-2 z-10 flex gap-1.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
        {(runnable || previewable) && status?.enabled && (
          <button
            onClick={runnable ? run : () => setPreview((v) => !v)}
            disabled={busy}
            className="rounded-md bg-emerald-600/90 px-2 py-0.5 text-xs font-medium text-white transition-colors hover:bg-emerald-500 disabled:opacity-50"
          >
            {busy ? '运行中…' : previewable ? (preview ? '关闭预览' : '▶ 预览') : '▶ 运行'}
          </button>
        )}
        <button
          onClick={copy}
          className="rounded-md bg-neutral-200 px-2 py-0.5 text-xs text-neutral-600 dark:bg-neutral-700 dark:text-neutral-300"
        >
          {copied ? '已复制' : '复制'}
        </button>
      </div>
      <pre>{children}</pre>

      {previewable && preview && (
        <iframe
          title="HTML 预览"
          sandbox="allow-scripts"
          srcDoc={code}
          className="mt-2 h-72 w-full rounded-lg border border-neutral-200 bg-white dark:border-neutral-700"
        />
      )}

      {result && (
        <div className="mt-2 rounded-lg border border-neutral-200 bg-neutral-50 p-2.5 text-xs dark:border-neutral-700 dark:bg-neutral-900/60">
          <div className="mb-1.5 flex items-center gap-2">
            <span className={result.ok ? 'font-medium text-emerald-600 dark:text-emerald-400' : 'font-medium text-red-500'}>
              {result.timeout ? '⏱ 超时被终止' : result.ok ? '✓ 运行成功' : `✗ 退出码 ${result.exit_code}`}
            </span>
            <span className="text-neutral-400">{(result.elapsed_ms / 1000).toFixed(1)}s</span>
            <button onClick={() => setResult(null)} className="ml-auto text-neutral-400 hover:text-neutral-600">
              ×
            </button>
          </div>
          {result.stdout && (
            <pre className="max-h-60 overflow-auto whitespace-pre-wrap text-[11px] leading-relaxed text-neutral-700 dark:text-neutral-200">
              {result.stdout}
            </pre>
          )}
          {result.stderr && (
            <pre className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap text-[11px] leading-relaxed text-red-600 dark:text-red-400">
              {result.stderr}
            </pre>
          )}
        </div>
      )}
      {error && (
        <p className="mt-2 rounded-lg bg-red-50 px-2.5 py-1.5 text-xs text-red-600 dark:bg-red-950/40 dark:text-red-400">
          {error}
        </p>
      )}
    </div>
  )
}

// status is the same for every block — fetch once per page load
let statusPromise: Promise<ArtifactsStatus> | null = null
function fetchStatus(): Promise<ArtifactsStatus> {
  statusPromise ??= api.artifactsStatus()
  return statusPromise
}

function extractLang(node: React.ReactNode): string {
  // react-markdown renders <pre><code class="language-python">…</code></pre>
  if (node && typeof node === 'object' && 'props' in node) {
    const props = (node as { props?: { className?: string; children?: React.ReactNode } }).props
    const m = /language-([\w-]+)/.exec(props?.className ?? '')
    if (m) return m[1].toLowerCase()
    return extractLang(props?.children)
  }
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = extractLang(child)
      if (found) return found
    }
  }
  return ''
}

function extractText(node: React.ReactNode): string {
  if (typeof node === 'string') return node
  if (typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(extractText).join('')
  if (node && typeof node === 'object' && 'props' in node) {
    return extractText((node as { props: { children?: React.ReactNode } }).props.children)
  }
  return ''
}
