// data 分区（方向 6 第十五刀拆出，2026-10-02 设置中心改版）：
// 数据概览（知识库 / 备份状态）→ 自动备份 → 手动备份 → 备份记录，像个数据管理中心，
// 不再是一张 checkbox 与输入框挤在一行的大表单。
// 偏好字段编辑走页面级自动保存；备份列表挂载时自拉，失败走 failLoad。
import { useEffect, useState } from 'react'
import { api, type BackupList, type HealthReport } from './api'
import { fmtSize, inputCls, type WorkbenchPrefs } from './settingsShared'
import { askConfirm, SettingGroup, SettingRow, SettingSwitch } from './SettingsUI'

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
  const [health, setHealth] = useState<HealthReport | null>(null)
  const [backupBusy, setBackupBusy] = useState(false)
  const [backupMsg, setBackupMsg] = useState('')

  useEffect(() => {
    api.listBackups().then(setBackups).catch((e) => failLoad('备份', e))
    // 概览读数复用体检报告的现成端点：知识库规模与备份状态都在里面
    api.healthReport().then(setHealth).catch(() => {/* 概览拿不到就摆「—」，不必进页级错误条 */})
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
    if (
      !(await askConfirm({
        title: `删除备份 ${name}？`,
        description: '此操作不可恢复。',
        confirmLabel: '删除',
      }))
    )
      return
    await api.deleteBackup(name).catch((e) => setBackupMsg(`✗ ${String(e)}`))
    setBackups(await api.listBackups())
  }

  const backupCount = backups?.backups.length ?? health?.backups.count ?? 0
  const lastBackup = backups?.backups[0]?.created_at ?? health?.backups.latest_at ?? null

  return (
    <div className="flex flex-col gap-4">
      {/* 数据概览：进页先看到「现在手里有什么、最后一次安全网是什么时候」 */}
      <SettingGroup title="数据概览" description="工作台的数据资产与它们的安全网。">
        <div className="grid grid-cols-2 gap-x-6 gap-y-4 px-5 py-4 sm:grid-cols-4">
          <div>
            <p className="text-xl font-semibold tabular-nums text-neutral-800 dark:text-neutral-100">
              {health ? (health.kb.indexer?.files ?? 0).toLocaleString() : '—'}
            </p>
            <p className="mt-0.5 text-xs text-neutral-500">知识库来源</p>
          </div>
          <div>
            <p className="text-xl font-semibold tabular-nums text-neutral-800 dark:text-neutral-100">
              {health ? (health.kb.indexer?.chunks ?? 0).toLocaleString() : '—'}
            </p>
            <p className="mt-0.5 text-xs text-neutral-500">索引块</p>
          </div>
          <div>
            <p className="text-xl font-semibold tabular-nums text-neutral-800 dark:text-neutral-100">{backupCount}</p>
            <p className="mt-0.5 text-xs text-neutral-500">备份份数</p>
          </div>
          <div>
            <p className="text-xl font-semibold tabular-nums text-neutral-800 dark:text-neutral-100">
              {lastBackup ? lastBackup.slice(5, 16).replace('T', ' ') : '—'}
            </p>
            <p className="mt-0.5 text-xs text-neutral-500">最后备份（月-日 时:分）</p>
          </div>
        </div>
      </SettingGroup>

      <SettingGroup
        title="自动备份"
        description="打包 vault/（全部笔记）+ data/workbench.db（会话/记忆/配置库，一致性快照）+ data/config.json 为 zip。向量索引不入包，可由 vault 重建。"
      >
        <SettingRow title="每日自动备份" description="到点自动打包一次；备份是唯一不可重建资产的安全网。">
          <div className="flex items-center gap-2.5">
            <input
              type="time"
              value={prefs.backup_time}
              disabled={!prefs.backup_enabled}
              onChange={(e) => setPrefs({ ...prefs, backup_time: e.target.value })}
              className={`${inputCls} w-28 disabled:opacity-40`}
            />
            <SettingSwitch
              checked={prefs.backup_enabled}
              onChange={(v) => setPrefs({ ...prefs, backup_enabled: v })}
              ariaLabel="每日自动备份"
            />
          </div>
        </SettingRow>
        <SettingRow title="保留份数" description="超出后自动滚动删除最旧的。" htmlFor="pref-backup-keep">
          <input
            id="pref-backup-keep"
            type="number"
            min={1}
            max={99}
            value={prefs.backup_keep}
            onChange={(e) => setPrefs({ ...prefs, backup_keep: Number(e.target.value) })}
            className={`${inputCls} w-20`}
          />
        </SettingRow>
        <SettingRow
          title="落到外接盘"
          description="自动探测 U 盘/移动硬盘，插上才备；正本与备份不同盘，盘坏不两失。"
        >
          <SettingSwitch
            checked={prefs.backup_removable}
            onChange={(v) => setPrefs({ ...prefs, backup_removable: v })}
            ariaLabel="备份落到外接盘"
          />
        </SettingRow>
        <SettingRow
          title="备份目录"
          description="留空 = 项目下 backups/；勾了外接盘时忽略此项。"
          htmlFor="pref-backup-dir"
        >
          <input
            id="pref-backup-dir"
            value={prefs.backup_dir}
            disabled={prefs.backup_removable}
            onChange={(e) => setPrefs({ ...prefs, backup_dir: e.target.value })}
            placeholder={backups?.dir || 'D:\\TP\\A\\backups'}
            className={`${inputCls} w-64 disabled:opacity-40`}
          />
        </SettingRow>
      </SettingGroup>

      <SettingGroup title="手动备份" description="想做一个「改动前的定格」时用——不用等凌晨三点。">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3.5">
          <button
            onClick={runBackup}
            disabled={backupBusy}
            className="wb-btn-primary px-4 py-1.5 text-sm"
          >
            {backupBusy ? '打包中…' : '立即备份'}
          </button>
          <span className="text-xs text-neutral-500">
            保存路径 {backups?.dir || '—'}
            {backups?.next_run ? ` · 下次自动备份 ${backups.next_run.slice(5, 16).replace('T', ' ')}` : ''}
          </span>
        </div>
        {backupMsg && <div className="px-5 pb-3.5 text-xs text-neutral-600 dark:text-neutral-300">{backupMsg}</div>}
        {backups?.removable_missing && (
          <div className="px-5 pb-3.5 text-xs text-amber-600 dark:text-amber-400">🔌 {backups.removable_missing}</div>
        )}
      </SettingGroup>

      <SettingGroup title="备份记录" divide={false}>
        <div className="flex flex-col gap-1.5 px-5 py-4">
          {(backups?.backups ?? []).map((b) => (
            <div
              key={b.name}
              className="flex items-center justify-between gap-3 rounded-md border border-neutral-200 px-3 py-2 text-xs dark:border-neutral-800"
            >
              <span className="min-w-0 truncate font-mono">{b.name}</span>
              <span className="flex shrink-0 items-center gap-3">
                <span className="text-neutral-500">{fmtSize(b.size)}</span>
                <span className="text-neutral-400">{b.created_at.slice(0, 16).replace('T', ' ')}</span>
                <a href={api.backupDownloadUrl(b.name)} className="text-violet-600 hover:underline dark:text-violet-300">
                  下载
                </a>
                <button onClick={() => removeBackup(b.name)} className="text-red-500 hover:underline">
                  删除
                </button>
              </span>
            </div>
          ))}
          {(backups?.backups ?? []).length === 0 && (
            <p className="text-xs text-neutral-400">还没有备份。</p>
          )}
          <details className="mt-1 text-xs text-neutral-500">
            <summary className="cursor-pointer select-none">如何恢复？</summary>
            <p className="mt-2 leading-relaxed">{backups?.restore_hint || ''}</p>
          </details>
        </div>
      </SettingGroup>
    </div>
  )
}
