import { request } from './request'
import type { Conversation } from '../api'

export const conversationsApi = {
  listConversations: () => request<Conversation[]>('/api/conversations'),
  getConversation: (id: number) => request<Conversation>(`/api/conversations/${id}`),
  createConversation: (modelId: string) =>
    request<Conversation>('/api/conversations', {
      method: 'POST',
      body: JSON.stringify({ model_id: modelId }),
    }),
  deleteConversation: (id: number) =>
    request<{ ok: boolean }>(`/api/conversations/${id}`, { method: 'DELETE' }),
  forkConversation: (id: number, messageId: number) =>
    request<Conversation>(`/api/conversations/${id}/fork`, {
      method: 'POST',
      body: JSON.stringify({ message_id: messageId }),
    }),
  exportConversation: async (id: number): Promise<void> => {
    const res = await fetch(`/api/conversations/${id}/export`)
    if (!res.ok) throw new Error(`export failed: ${res.status}`)
    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `chat-${id}.md`
    a.click()
    URL.revokeObjectURL(url)
  },
  editMessage: (convId: number, messageId: number, content: string) =>
    request<{ ok: boolean; dropped: number }>(
      `/api/conversations/${convId}/messages/${messageId}`,
      { method: 'PUT', body: JSON.stringify({ content }) }
    ),
  setFeedback: (convId: number, messageId: number, rating: 'up' | 'down' | null) =>
    request<{ ok: boolean; feedback: 'up' | 'down' | null }>(
      `/api/conversations/${convId}/messages/${messageId}/feedback`,
      { method: 'PUT', body: JSON.stringify({ rating }) }
    ),

}
