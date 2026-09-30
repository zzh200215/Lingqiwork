// data 分区的备份卡（方向 6 第十五刀，2026-09-30 自 SettingsPage 拆出）：
// 备份开关 / 时刻 / 保留份数 / 目录 + 手动备份与备份列表管理。
// 状态与处理器自含，挂载时自拉备份列表，失败走 failLoad；偏好字段编辑经 props。
import { useEffect, useState } from 'react'
import { Save } from 'lucide-react'
import { api, type BackupList } from './api'
import { fmtSize, inputCls, type WorkbenchPrefs } from './settingsShared'

export default function SettingsData({
  prefs,
  setPrefs,
  failLoad,
}: {
  prefs: WorkbenchPrefs
  setPrefs: (p: WorkbenchPrefs) => void
  failLoad: (what: string, e: unknown) => void
}) {

  const [backups, setBackups] = useState<BackupList | null>(null)
  const [backupBusy, setBackupBusy] = useState(false)
  const [backupMsg, setBackupMsg] = useState('')

  useEffect(() => {
    api.listBackups().then(setBackups).catch((e) => failLoad('备份', e))
  }, [])

  // ---- backups ----

  async function runBackup() {
    setBackupBusy(true)
    setBackupMsg('')
    try {
      const r = await api.runBackup()
      setBackupMsg(
        `✓ 已生成 ${r.name}（${fmtSize(r.size)}，${r.vault_files} 个笔记文件` +
          (r.pruned.length ? `，滚动清理 ${r.pruned.length} 份旧备份` : '') +
          '）'
      )
      setBackups(await api.listBackups())
    } catch (e) {
      setBackupMsg(`✗ ${String(e)}`)
    } finally {
      setBackupBusy(false)
    }
  }

  async function removeBackup(name: string) {
    if (!window.confirm(`删除备份 ${name}？此操作不可恢复。`)) return
    await api.deleteBackup(name).catch((e) => setBackupMsg(`✗ ${String(e)}`))
    setBackups(await api.listBackups())
  }

  return (
    <>
      {/* Backup & restore */}
      <section className="mb-6 wb-card p-5">
        <h2 className="mb-1 flex items-center gap-2 font-semibold"><span className="wb-chip h-6 w-6 rounded-lg bg-sky-100 text-sky-600 dark:bg-sky-400/15 dark:text-sky-300"><Save className="h-3.5 w-3.5" /></span></h2>
        <p className="mb-4 text-xs text-neutral-500">
          打包 vault/（全部笔记）+ data/workbench.db（会话/记忆/配置库，一致性快照）+ data/config.json 为 zip。
          向量索引不入包，可由 vault 重建。
        </p>
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={prefs.backup_enabled}
              onChange={(e) => setPrefs({ ...prefs, backup_enabled: e.target.checked })}
            />
            每日自动备份
            <input
              type="time"
              value={prefs.backup_time}
              disabled={!prefs.backup_enabled}
              onChange={(e) => setPrefs({ ...prefs, backup_time: e.target.value })}
              className={`${inputCls} w-28 disabled:opacity-40`}
            />
            <span className="ml-2 text-neutral-500">保留最近</span>
            <input
              type="number"
              min={1}
              max={99}
              value={prefs.backup_keep}
              onChange={(e) => setPrefs({ ...prefs, backup_keep: Number(e.target.value) })}
              className={`${inputCls} w-16`}
            />
            <span className="text-neutral-500">份（超出自动滚动删除）</span>
          </div>
          <label className="flex flex-col gap-1 text-sm">
            备份目录（留空 = 项目下 backups/）
            <input
              value={prefs.backup_dir}
              onChange={(e) => setPrefs({ ...prefs, backup_dir: e.target.value })}
              placeholder={backups?.dir || 'D:\\TP\\A\\backups'}
              className={inputCls}
            />
          </label>
          <div className="flex flex-wrap items-center gap-3">
            <button
              onClick={runBackup}
              disabled={backupBusy}
              className="rounded-md border border-violet-500 px-3 py-1.5 text-sm font-medium text-violet-600 transition-colors hover:bg-violet-50 disabled:opacity-50 dark:text-violet-300 dark:hover:bg-violet-950"
            >
              {backupBusy ? '打包中…' : '立即备份'}
            </button>
            <span className="text-xs text-neutral-500">
              保存路径 {backups?.dir || '—'}
              {backups?.next_run ? ` · 下次自动备份 ${backups.next_run.slice(5, 16).replace('T', ' ')}` : ''}
            </span>
          </div>
          {backupMsg && <div className="text-xs text-neutral-600 dark:text-neutral-300">{backupMsg}</div>}
          <div className="flex flex-col gap-1">
            {(backups?.backups ?? []).length === 0 && (
              <div className="text-xs text-neutral-400">还没有备份</div>
            )}
            {(backups?.backups ?? []).map((b) => (
              <div
                key={b.name}
                className="flex items-center justify-between rounded-md border border-neutral-200 px-3 py-1.5 text-xs dark:border-neutral-800"
              >
                <span className="truncate font-mono">{b.name}</span>
                <span className="flex shrink-0 items-center gap-3">
                  <span className="text-neutral-500">{fmtSize(b.size)}</span>
                  <span className="text-neutral-400">{b.created_at.slice(0, 16).replace('T', ' ')}</span>
                  <a
                    href={api.backupDownloadUrl(b.name)}
                    className="text-violet-600 hover:underline dark:text-violet-300"
                  >
                    下载
                  </a>
                  <button onClick={() => removeBackup(b.name)} className="text-red-500 hover:underline">
                    删除
                  </button>
                </span>
              </div>
            ))}
          </div>
          <details className="text-xs text-neutral-500">
            <summary className="cursor-pointer select-none">如何恢复？</summary>
            <p className="mt-2 leading-relaxed">{backups?.restore_hint || ''}</p>
          </details>
        </div>
      </section>
    </>
  )
}
