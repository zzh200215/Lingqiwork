// S1（PLAN3 §9.2 决策4）：质量卡上那一行「有注入 / 没注入 / 不知道」。
//
// 只钉这个纯函数，不起整页：整页要拉一堆端点，而这一行的规矩只有三条——三态分得开、
// 只摆非零、老数据（没有 split）不炸。
import { describe, expect, it } from 'vitest'

import type { QualityGroup } from './api'
import { injectSplit } from './SettingsPage'

function group(split: Partial<QualityGroup['split']>): QualityGroup {
  return {
    kind: 'deliver',
    prompt_sha: 'abc123',
    model_id: 'm',
    good: 3,
    bad: 1,
    total: 4,
    rate: 0.75,
    split: { injected: { good: 0, bad: 0 }, plain: { good: 0, bad: 0 }, unknown: { good: 0, bad: 0 }, ...split },
  }
}

describe('质量卡 · 注入那一行', () => {
  it('三态分开摆，不与「没注入」并成一份', () => {
    const line = injectSplit(
      group({
        injected: { good: 2, bad: 1 },
        plain: { good: 1, bad: 0 },
        unknown: { good: 0, bad: 1 },
      })
    )
    expect(line).toContain('有注入 2👍/1👎')
    expect(line).toContain('没注入 1👍/0👎')
    expect(line).toContain('不知道 0👍/1👎')
  })

  it('只摆非零：一次注入都没有的那些组，这一行根本不出现', () => {
    expect(injectSplit(group({ plain: { good: 2, bad: 0 } }))).toContain('没注入')
    expect(injectSplit(group({ plain: { good: 2, bad: 0 } }))).not.toContain('有注入')
    expect(injectSplit(group({}))).toBe('')
  })

  it('老数据没有 split 字段时当没有，不炸（不是「没注入」）', () => {
    const old = { ...group({}), split: undefined as unknown as QualityGroup['split'] }
    expect(injectSplit(old)).toBe('')
  })
})
