import { request } from './request'
import type { BackupList } from '../api'

export const backupsApi = {
  listBackups: () => request<BackupList>('/api/backup'),
  runBackup: () =>
    request<{ ok: boolean; name: string; size: number; vault_files: number; pruned: string[] }>(
      '/api/backup/run',
      { method: 'POST' }
    ),
  deleteBackup: (name: string) =>
    request<{ ok: boolean }>(`/api/backup/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  backupDownloadUrl: (name: string) => `/api/backup/download/${encodeURIComponent(name)}`,

}
