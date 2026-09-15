/** 回执列表的不变量：同一份产出（同一个 path）在一轮里只可能有一条。
 *
 *  模型满足不了「300 字左右」时会写一版存一版（实测 20 轮里 5 轮存了 ≥2 次，
 *  最坏一轮 4 次）。后端把同一个文件的多条回执收成一条；界面这条流式路径也得一样，
 *  否则流式期间会并排出现 2～4 条指向同一个文件的链接，刷新后才变回 1 条。
 */
import { describe, expect, it } from 'vitest'

import { upsertArtifact, claimsSaveWithoutArtifact, saveHint } from './artifacts'
import type { ArtifactRef, QualityNote } from './stream'

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

// W2a：提示该不该出现、要不要把「存进产出」提到最显眼处。
// **判据在服务端**（`core/turn_quality.py`，随 `quality` 帧下来），这里只负责把它
// 变成一句话 —— 唯一自己判的是上面那条「说了存却没回执」。
describe('saveHint', () => {
  const LONG_REPLY = '本周的工作可以分成三段。'.repeat(40)

  it('说了存却没回执 → 一条警告，而且按钮要提到最显眼处', () => {
    const hint = saveHint('已存入产出：周报', undefined)
    expect(hint?.primary).toBe(true)
    expect(hint?.text).toContain('没有落盘')
  })

  it('服务端判了「长文没落盘」且用户说过要存 → 警告 + 一键补', () => {
    const q: QualityNote = { codes: ['long_body_without_a_receipt'], asked_to_save: true }
    const hint = saveHint(LONG_REPLY, undefined, q)
    expect(hint?.primary).toBe(true)
  })

  it('用户没说要存 → 不提示也不给按钮（对一次正确的拒绝是在误导人）', () => {
    const q: QualityNote = { codes: ['long_body_without_a_receipt'], asked_to_save: false }
    expect(saveHint(LONG_REPLY, undefined, q)).toBeNull()
  })

  it('有回执就都不提示 —— 东西确实在产出区', () => {
    const arts = [art('deliver/x.md')]
    const q: QualityNote = { codes: ['long_body_without_a_receipt'], asked_to_save: true }
    expect(saveHint(LONG_REPLY, arts, q)).toBeNull()
  })

  it('编造路径 → 一条说明，但**不提按钮**（没有东西可补，正文就是正文）', () => {
    const hint = saveHint('见 recap/编的.md', undefined, { codes: ['invented_path'] })
    expect(hint?.primary).toBe(false)
    expect(hint?.text).toContain('不在这一轮的回执里')
  })

  it('回执没给出去 → 把原因如实说出来', () => {
    const hint = saveHint('存好了', undefined, {
      codes: [],
      dropped_receipts: [{ path: 'recap/x.md', why: '回执指向的文件不在盘上：recap/x.md' }],
    })
    expect(hint?.primary).toBe(false)
    expect(hint?.text).toContain('不在盘上')
  })

  it('一切正常 → 没有提示', () => {
    expect(saveHint('写完了，你看这样行不行。', undefined, { codes: [] })).toBeNull()
  })
})
