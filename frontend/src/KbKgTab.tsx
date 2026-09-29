// 「图谱」页签：本机 Neo4j 知识图谱的配置、增量抽取与检索测试（方向 6 第三刀自 KBPage 拆出）。
import { useCallback, useEffect, useState } from 'react'
import { Search, Waypoints } from 'lucide-react'
import { api, type KgRetrieval, type KgStatus } from './api'
import { box } from './kbShared'

interface Props {
  /** 页签是否处于激活态——只在激活时拉数据（原实现是父组件里的 if (tab === 'kg') refreshKg()） */
  active: boolean
}

export default function KbKgTab({ active }: Props) {
  const [kg, setKg] = useState<KgStatus | null>(null)
  const [kgForm, setKgForm] = useState({ uri: 'bolt://localhost:7687', user: 'neo4j', password: '', enabled: false })
  const [kgBusy, setKgBusy] = useState('')
  const [kgMsg, setKgMsg] = useState('')
  const [kgQ, setKgQ] = useState('')
  const [kgResult, setKgResult] = useState<KgRetrieval | null>(null)

  const refreshKg = useCallback(async () => {
    const s = await api.getKgStatus()
    setKg(s)
    setKgForm((f) => ({ ...f, uri: s.uri, user: s.user, enabled: s.enabled }))
  }, [])

  useEffect(() => {
    if (active) refreshKg()
  }, [active, refreshKg])

  async function saveKg() {
    if (kgBusy) return
    setKgBusy('save')
    setKgMsg('')
    try {
      const r = await api.saveKgConfig({ ...kgForm, password: kgForm.password })
      setKgForm((f) => ({ ...f, password: '' }))
      setKgMsg(`已连接 · 实体 ${r.entities ?? 0} / 关系 ${r.relations ?? 0} / 文件 ${r.files ?? 0}`)
      await refreshKg()
    } catch (e) {
      setKgMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setKgBusy('')
    }
  }

  async function buildKg() {
    if (kgBusy) return
    setKgBusy('build')
    setKgMsg('抽取中：每个文件一次模型调用，请稍候…')
    try {
      const r = await api.buildKg(8)
      const failNote = r.failed.length ? `，失败 ${r.failed.length} 个（${r.failed[0].error.slice(0, 80)}）` : ''
      setKgMsg(`本轮抽取 ${r.extracted} 个文件（${r.unchanged} 个未变化跳过）${failNote}。文件较多时可多次点击继续。`)
      await refreshKg()
    } catch (e) {
      setKgMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setKgBusy('')
    }
  }

  async function queryKg() {
    if (!kgQ.trim() || kgBusy) return
    setKgBusy('query')
    setKgResult(null)
    try {
      setKgResult(await api.queryKg(kgQ.trim(), 6))
    } catch (e) {
      setKgMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setKgBusy('')
    }
  }

  async function clearKg() {
    if (!confirm('清空知识图谱中的全部实体与关系？（不影响笔记本体）')) return
    setKgBusy('clear')
    try {
      await api.clearKg()
      setKgMsg('图谱已清空')
      await refreshKg()
    } catch (e) {
      setKgMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setKgBusy('')
    }
  }

  return (
    <>
      <section className="wb-card-hero mb-6 rounded-lg p-5">
        <div className="flex flex-wrap items-center gap-x-8 gap-y-3">
          <div className="flex items-end gap-6">
            <div>
              <p className="text-2xl font-bold text-neutral-800 dark:text-neutral-100">{kg?.entities ?? 0}</p>
              <p className="mt-0.5 text-xs text-neutral-500">实体</p>
            </div>
            <div>
              <p className="text-2xl font-bold text-neutral-800 dark:text-neutral-100">{kg?.relations ?? 0}</p>
              <p className="mt-0.5 text-xs text-neutral-500">关系</p>
            </div>
            <div>
              <p className="text-2xl font-bold text-neutral-800 dark:text-neutral-100">{kg?.files ?? 0}</p>
              <p className="mt-0.5 text-xs text-neutral-500">文件</p>
            </div>
          </div>
          {kg && (
            <span
              className={`ml-auto flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs ${
                kg.ok
                  ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300'
                  : 'bg-neutral-100 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400'
              }`}
            >
              <span className={`h-2 w-2 rounded-full ${kg.ok ? 'bg-emerald-500' : 'bg-neutral-400'}`} />
              {kg.ok ? '已连接' : '未连接'}
            </span>
          )}
        </div>
      </section>

      <section className="mb-6 wb-card p-5">
        <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold text-neutral-700 dark:text-neutral-200">
          <span><Waypoints className="h-4 w-4" /></span> 知识图谱配置
          <span className="text-xs font-normal text-neutral-400">本地 Neo4j</span>
        </h2>
        <p className="-mt-1 mb-3 text-xs leading-relaxed text-neutral-400">
          用模型从笔记中抽取实体与关系，存入你本机的 Neo4j（实体标签 KgEntity，不影响库里已有数据）。开启后聊天里勾选知识库检索时会叠加「向量匹配实体 → 一跳扩展」的图谱上下文。构建按文件增量抽取，文件多时可多次点击。
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-sm">
            Bolt 地址
            <input
              value={kgForm.uri}
              onChange={(e) => setKgForm({ ...kgForm, uri: e.target.value })}
              placeholder="bolt://localhost:7687"
              className={`${box} w-64`}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            用户名
            <input
              value={kgForm.user}
              onChange={(e) => setKgForm({ ...kgForm, user: e.target.value })}
              className={`${box} w-32`}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            密码{kg?.password_set ? '（已保存，留空则不修改）' : ''}
            <input
              type="password"
              value={kgForm.password}
              onChange={(e) => setKgForm({ ...kgForm, password: e.target.value })}
              className={`${box} w-44`}
            />
          </label>
          <label className="flex items-center gap-2 pb-1.5 text-sm">
            <input
              type="checkbox"
              checked={kgForm.enabled}
              onChange={(e) => setKgForm({ ...kgForm, enabled: e.target.checked })}
            />
            启用图谱检索
          </label>
          <button
            onClick={saveKg}
            disabled={kgBusy !== ''}
            className="rounded-md bg-gradient-to-r from-violet-600 to-fuchsia-600 px-3 py-1.5 text-sm font-medium text-white transition-all hover:brightness-110 disabled:opacity-40"
          >
            {kgBusy === 'save' ? '连接中…' : '保存并测试连接'}
          </button>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            onClick={buildKg}
            disabled={kgBusy !== '' || !kg?.ok || !kg?.enabled}
            className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm disabled:opacity-40 dark:border-neutral-700"
          >
            {kgBusy === 'build' ? '抽取中…' : '构建图谱（增量 8 个文件）'}
          </button>
          <button
            onClick={clearKg}
            disabled={kgBusy !== '' || !kg?.ok}
            className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm disabled:opacity-40 dark:border-neutral-700 text-red-400 hover:text-red-600"
          >
            清空图谱
          </button>
          {kgMsg && <span className="text-xs text-neutral-400">{kgMsg}</span>}
        </div>
      </section>
      <section className="wb-card p-5">
        <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-neutral-700 dark:text-neutral-200">
          <span><Search className="h-4 w-4" /></span> 图谱检索测试
        </h2>
        <div className="flex gap-2">
          <input
            value={kgQ}
            onChange={(e) => setKgQ(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && queryKg()}
            placeholder="输入一个问题，看图谱能匹配到哪些实体与关系"
            className={`${box} flex-1`}
          />
          <button
            onClick={queryKg}
            disabled={kgBusy !== '' || !kg?.ok || !kgQ.trim()}
            className="rounded-md bg-neutral-900 px-4 py-1.5 text-sm font-medium text-white disabled:opacity-40 dark:bg-neutral-100 dark:text-neutral-900"
          >
            {kgBusy === 'query' ? '检索中…' : '检索'}
          </button>
        </div>
        {kgResult && (
          <div className="mt-3 space-y-2">
            <p className="text-xs font-medium text-neutral-500">实体（{kgResult.entities.length}）</p>
            {kgResult.entities.map((e) => (
              <div key={e.name} className="rounded-md bg-neutral-50 p-2 text-xs dark:bg-neutral-900">
                <span className="font-medium">{e.name}</span>
                <span className="ml-2 text-neutral-400">相似度 {e.score}</span>
                {e.description && <p className="mt-0.5 text-neutral-500">{e.description}</p>}
              </div>
            ))}
            {kgResult.relations.length > 0 && (
              <>
                <p className="text-xs font-medium text-neutral-500">关系（{kgResult.relations.length}）</p>
                {kgResult.relations.slice(0, 12).map((r, i) => (
                  <p key={i} className="text-xs text-neutral-500">
                    {r.src} —<span className="text-violet-500">{r.type}</span>→ {r.dst}
                    {r.description && <span className="text-neutral-400">：{r.description}</span>}
                  </p>
                ))}
              </>
            )}
            {!kgResult.entities.length && <p className="text-xs text-neutral-400">没有匹配到实体 — 先构建图谱，或换个说法试试</p>}
          </div>
        )}
      </section>
    </>
  )
}
