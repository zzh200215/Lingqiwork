import { request } from './request'
import type { CardCalibration, CardContradiction, CardCrosscheck, CardDraft, CardGapRate, CardGrade, CardItem, CardPrereq } from '../api'
import type { CardQueue, CardRetellResult, CardReviewResult, CardSourceStat, CardSources, CardStats, MaterialHit, PrereqAdoption } from '../api'

export const cardsApi = {
  cardQueue: () => request<CardQueue>('/api/cards/queue'),
  cardStats: () => request<CardStats>('/api/cards/stats'),
  /** 校准曲线（PLAN2 T2）：滚动 N 天，自评 vs 判分。**只进仪表盘**。 */
  cardCalibration: (days = 30) =>
    request<CardCalibration>(`/api/cards/calibration?days=${days}`),
  /** 递卡那句对质的事实来源（PLAN2 T1 场景 A）。没有矛盾时 `contradiction=null`。 */
  cardContradiction: () => request<CardContradiction>('/api/cards/contradiction'),
  /** 双轨矛盾率（PLAN2 §6）。**只进仪表盘**——不设目标、不排名、不进零柒嘴里。 */
  cardGapRate: (days = 30) => request<CardGapRate>(`/api/cards/contradiction-rate?days=${days}`),
  /** 一张卡的对照事实（真值只有一份：与递卡那句同一个后端函数）。 */
  cardCrosscheck: (id: number) => request<CardCrosscheck>(`/api/cards/${id}/crosscheck`),
  /** 这张卡「可能缺的前置」——**拉取式**：点开才有，没有任何东西会催你（PLAN2 T3）。 */
  cardPrereq: (id: number) => request<CardPrereq>(`/api/cards/${id}/prereq`),
  /** 记一笔「这张卡的候选被翻过」（PLAN2 §6 回指采纳的分母）。
   *  **单独一个 POST，不是上面那条 GET 的副作用**：读路径带副作用的话，重试与预取
   *  都会记账，而这一条数的用途是判「这个功能有没有人看」——记不准就会把没人用的
   *  东西判成有人用。丢了不致命，所以界面那边是 fire-and-forget。 */
  markPrereqSeen: (id: number) =>
    request<{ ok: boolean }>(`/api/cards/${id}/prereq/seen`, { method: 'POST' }),
  /** 回指采纳（PLAN2 §6）：翻过多少张搁置卡的候选、其中多少张真开了课。**只进仪表盘**。 */
  prereqAdoption: (days = 90) =>
    request<PrereqAdoption>(`/api/cards/prereq-adoption?days=${days}`),
  listCards: (q: { source?: string; kind?: string; topic?: string; limit?: number } = {}) =>
    request<{ total: number; cards: CardItem[] }>(
      '/api/cards?' +
        new URLSearchParams(
          Object.entries(q)
            .filter(([, v]) => v !== undefined && v !== '')
            .map(([k, v]) => [k, String(v)])
        ).toString()
    ),
  saveCards: (body: {
    cards: CardDraft[]
    source: string
    source_label: string
    model_id: string
  }) =>
    request<{ added: number; skipped: number; ids: number[] }>('/api/cards/batch', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  reviewCard: (id: number, grade: CardGrade, seconds: number, retell = '') =>
    request<CardReviewResult>(`/api/cards/${id}/review`, {
      method: 'POST',
      body: JSON.stringify({ grade, seconds, retell }),
    }),
  /** 「讲给它听」：它判档 → 落**同一条**复习记录 → 零柒接一句（判词走 SSE 冒泡）。
   *  `ok=false` 时一个字节都没写，退回自评。判分是一次模型调用（成本写在按钮 tooltip 上）。 */
  retellCard: (id: number, text: string, seconds: number, model_id = '') =>
    request<CardRetellResult>(`/api/cards/${id}/retell`, {
      method: 'POST',
      body: JSON.stringify({ text, seconds, model_id }),
    }),
  undoCardReview: (id: number) =>
    request<{ ok: boolean; card: CardItem | null }>(`/api/cards/${id}/undo`, { method: 'POST' }),
  updateCard: (
    id: number,
    patch: Partial<Pick<CardItem, 'front' | 'back' | 'hint' | 'topic' | 'kind' | 'suspended'>>
  ) => request<CardItem>(`/api/cards/${id}`, { method: 'PUT', body: JSON.stringify(patch) }),
  deleteCard: (id: number) =>
    request<{ ok: boolean }>(`/api/cards/${id}`, { method: 'DELETE' }),
  weakSources: (days = 30) =>
    request<{ days: number; sources: CardSourceStat[] }>(`/api/cards/weak?days=${days}`),
  /** Blank out a selected span. Server-side so the rules are covered by pytest. */
  makeCloze: (body: { text: string; start: number; end: number; topic?: string }) =>
    request<CardDraft>('/api/cards/cloze', { method: 'POST', body: JSON.stringify(body) }),
  cardSources: (q = '', limit = 200) =>
    request<CardSources>(
      `/api/cards/sources?q=${encodeURIComponent(q)}&limit=${limit}`
    ),
  /** Retrieval hits ready to card. First call after a cold start takes ~6s. */
  searchMaterial: (q: string, topK = 6) =>
    request<{ query: string; hits: MaterialHit[] }>(
      `/api/cards/search?q=${encodeURIComponent(q)}&top_k=${topK}`
    ),
  cardMaterial: (source: string) =>
    request<{
      source: string
      source_label: string
      text: string
      /** the file was longer than the pane cap */
      truncated: boolean
      /** how much of it 🤖 出卡 would actually send to the model */
      gen_limit: number
    }>('/api/cards/material?source=' + encodeURIComponent(source)),

  // ---------- 习惯打卡 ----------
}
