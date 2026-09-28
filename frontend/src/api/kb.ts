import { request } from './request'

export const kbApi = {
  cancelReindex: () =>
    request<{ stopped: boolean }>('/api/kb/reindex/cancel', { method: 'POST' }),
}
