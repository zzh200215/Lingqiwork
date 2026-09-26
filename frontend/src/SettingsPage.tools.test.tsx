// A3 那一栏的成本读数（2026-09-22：A3 改成**症状驱动**，不再是"工具数 > 20"）。
//
// 只钉这个纯函数，不起整页（同 `SettingsPage.split.test.tsx` 的形状：整页要拉一堆端点，
// 而这一行的规矩只有三条——读数照实念、最占地方的排前面、**读不到不许印 0**）。
import { describe, expect, it } from 'vitest'

import type { McpView } from './api'
import { toolCostLine } from './SettingsPage'

const tools = (over: Partial<NonNullable<McpView['tools']>> = {}): McpView['tools'] => ({
  count: 12,
  names: [],
  mcp: 0,
  chars: 4206,
  biggest: [
    { name: 'save_artifact', chars: 827 },
    { name: 'delegate', chars: 746 },
    { name: 'image_gen', chars: 404 },
  ],
  review_hint: 20,
  ...over,
})

describe('设置页 · A3 成本那一行', () => {
  it('照实念读数：总字数 + 最占地方的三个', () => {
    const line = toolCostLine(tools())
    expect(line).toContain('4206 字')
    expect(line).toContain('save_artifact 827 字')
    expect(line).toContain('delegate 746 字')
    expect(line).toContain('每一轮都重发一遍')
  })

  it('提示是提示：句子里没有"到线/没到线"这种判词', () => {
    const line = toolCostLine(tools())
    expect(line).toContain('到 20 个工具就复看一遍')
    expect(line).toContain('不是及格线')
    expect(line).not.toContain('到线')
  })

  it('读不到就明说读不到，**不印 0**', () => {
    const line = toolCostLine(undefined)
    expect(line).toContain('没拿到')
    expect(line).not.toContain('0 字')
  })

  it('只有一条描述时也读得通（不出现空的最占地方那一截）', () => {
    const line = toolCostLine(tools({ biggest: [{ name: 'kb_search', chars: 314 }] }))
    expect(line).toContain('kb_search 314 字')
    expect(line).not.toContain('最占地方的是 。')
  })
})
