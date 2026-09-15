/** 回执列表的不变量：同一份产出（同一个 path）在一轮里只可能有一条。
 *
 *  模型满足不了「300 字左右」时会写一版存一版（实测 20 轮里 5 轮存了 ≥2 次，
 *  最坏一轮 4 次）。后端把同一个文件的多条回执收成一条；界面这条流式路径也得一样，
 *  否则流式期间会并排出现 2～4 条指向同一个文件的链接，刷新后才变回 1 条。
 */
import { describe, expect, it } from 'vitest'

import { upsertArtifact, claimsSaveWithoutArtifact } from './artifacts'
import type { ArtifactRef } from './stream'

function art(path: string, extra: Partial<ArtifactRef> = {}): ArtifactRef {
  return {
    kind: 'recap',
    label: '复盘',
    title: '本周周报',
    path,
    href: `/notes?path=${encodeURIComponent(path)}`,
    chunks: 1,
    ...extra,
  }
}

describe('upsertArtifact', () => {
  it('同一个 path 的第二次落盘收成一条，留最后那条（带着最新的动作）', () => {
    const first = art('recap/2026-09-14-本周周报.md', { action: '存为' })
    const second = art('recap/2026-09-14-本周周报.md', { action: '更新', title: '本周周报（精简版）' })

    const out = upsertArtifact(upsertArtifact([], first), second)

    expect(out).toHaveLength(1)
    expect(out[0].action).toBe('更新')
    expect(out[0].title).toBe('本周周报（精简版）')
  })

  it('不同 path 各留一条', () => {
    const a = art('recap/a.md')
    const b = art('deliver/b.md')
    expect(upsertArtifact(upsertArtifact([], a), b)).toHaveLength(2)
  })

  it('第一次时列表可以为 undefined，不清空也不报错', () => {
    expect(upsertArtifact(undefined, art('recap/a.md'))).toHaveLength(1)
  })
})

// 双方（`backend/app/routers/chat.py::claims_a_save_without_one` 与这里）用
// **同一批例句**，改了一边另一边就会红。
describe('claimsSaveWithoutArtifact', () => {
  const LYING = [
    '已存入产出（约 100 字）。',
    '已存入产出：**本周周报**。本周：导出需求收敛…',
    '已存为复盘「本周周报」→ recap/x.md',
    '已更新交付「本周周报」→ deliver/x.md',
    '已另存为交付「本周周报」→ deliver/x-2.md',
  ]
  const HONEST = [
    '这是本周周报的正文：\n\n# 本周周报\n\n…',
    '我没法写，工作区里没有素材。',
    '',
  ]

  it('说了存、又没有回执 → 是谎报', () => {
    for (const text of LYING) {
      expect(claimsSaveWithoutArtifact(text, undefined), text).toBe(true)
    }
  })

  it('有回执就不算——那句话是模型多说的，东西确实在产出区', () => {
    for (const text of LYING) {
      expect(claimsSaveWithoutArtifact(text, [art('recap/x.md')]), text).toBe(false)
    }
  })

  it('正常回答不会被误报', () => {
    for (const text of HONEST) {
      expect(claimsSaveWithoutArtifact(text, undefined), text).toBe(false)
    }
  })
})
