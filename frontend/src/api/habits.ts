import { request } from './request'
import type { HabitDef, HabitKind, HabitToday } from '../api'

export const habitsApi = {
  habitsToday: () => request<HabitToday>('/api/habits/today'),
  seedHabits: () =>
    request<{ added: number; message?: string }>('/api/habits/seed', { method: 'POST' }),
  createHabit: (body: {
    name: string
    icon?: string
    kind?: HabitKind
    target?: number
    unit?: string
    weekdays?: string
  }) => request<HabitDef>('/api/habits', { method: 'POST', body: JSON.stringify(body) }),
  updateHabit: (
    id: number,
    patch: Partial<Pick<HabitDef, 'name' | 'icon' | 'target' | 'unit' | 'weekdays' | 'sort' | 'archived'>>
  ) => request<HabitDef>(`/api/habits/${id}`, { method: 'PUT', body: JSON.stringify(patch) }),
  deleteHabit: (id: number) => request<{ ok: boolean }>(`/api/habits/${id}`, { method: 'DELETE' }),
  tickHabit: (id: number, body: { value?: number; day?: string } = {}) =>
    request<{ ok: boolean; value: number; done: boolean }>(`/api/habits/${id}/tick`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  untickHabit: (id: number) =>
    request<{ ok: boolean; deleted: number }>(`/api/habits/${id}/tick`, { method: 'DELETE' }),

  // ---------- 后台自检 ----------
}
