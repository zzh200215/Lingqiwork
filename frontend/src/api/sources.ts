import { request } from './request'
import type { DirItem, DirList, FeedItem, FeedList, RepoItem, RepoList } from '../api'

export const sourcesApi = {
  listRepos: () => request<RepoList>('/api/repos'),
  cloneRepo: (url: string, name?: string) =>
    request<RepoItem>('/api/repos', { method: 'POST', body: JSON.stringify({ url, name }) }),
  syncRepo: (name: string) =>
    request<RepoItem>(`/api/repos/${encodeURIComponent(name)}/sync`, { method: 'POST' }),
  deleteRepo: (name: string) =>
    request<{ ok: boolean; sources_removed: number; dir_removed: boolean }>(
      `/api/repos/${encodeURIComponent(name)}`,
      { method: 'DELETE' }
    ),

  listDirs: () => request<DirList>('/api/dirs'),
  addDir: (name: string, path: string) =>
    request<DirItem>('/api/dirs', { method: 'POST', body: JSON.stringify({ name, path }) }),
  syncDir: (name: string) =>
    request<DirItem>(`/api/dirs/${encodeURIComponent(name)}/sync`, { method: 'POST' }),
  toggleDir: (name: string, enabled: boolean) =>
    request<DirItem>(`/api/dirs/${encodeURIComponent(name)}`, {
      method: 'PUT',
      body: JSON.stringify({ enabled }),
    }),
  deleteDir: (name: string) =>
    request<{ ok: boolean; sources_removed: number }>(`/api/dirs/${encodeURIComponent(name)}`, {
      method: 'DELETE',
    }),

  listFeeds: () => request<FeedList>('/api/feeds'),
  addFeed: (url: string, name?: string) =>
    request<FeedItem>('/api/feeds', { method: 'POST', body: JSON.stringify({ url, name }) }),
  syncFeed: (name: string) =>
    request<{ new: number; total: number; written_to: string | null }>(
      `/api/feeds/${encodeURIComponent(name)}/sync`,
      { method: 'POST' }
    ),
  syncAllFeeds: () =>
    request<{ feeds: number; new: number; results: Record<string, { new?: number; error?: string }> }>(
      '/api/feeds/sync',
      { method: 'POST' }
    ),
  toggleFeed: (name: string, enabled: boolean) =>
    request<FeedItem>(`/api/feeds/${encodeURIComponent(name)}`, {
      method: 'PUT',
      body: JSON.stringify({ enabled }),
    }),
  deleteFeed: (name: string) =>
    request<{ ok: boolean }>(`/api/feeds/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  testMail: () =>
    request<{ ok: boolean; to: string[]; subject: string }>('/api/mail/test', {
      method: 'POST',
      body: JSON.stringify({}),
    }),

}
