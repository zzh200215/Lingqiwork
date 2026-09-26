// 「刷新之后那一栏还在不在」那一层（A2 逐步账落库的界面端，2026-09-23）。
//
// 只钉 `toChatMessage` 这个纯函数，不起整页（同 `SettingsPage.split.test.tsx` 的形状：
// App 整页要拉一堆端点，而这里要守的规矩就三条——**三条附属事实都要 hydrate**、
// **`null` 不许变成空数组**、其余字段照抄）。
import { describe, expect, it } from 'vitest'

import { toChatMessage } from './App'
import type { Message } from './api'

const base: Message = {
  id: 7,
  role: 'assistant',
  content: '纪要正文',
  model_id: 'stub/m',
  created_at: '2026-09-24T10:00:00',
}

describe('刷新后重建那条消息', () => {
  it('逐步账跟着回来（协作那条路）', () => {
    const steps = [
      {
        step: 1,
        title: '合并 · 整理者',
        phase: 'merge',
        agent: '整理者',
        rounds: 3,
        tools: [],
        seconds: 8.1,
        parallel: false,
        rounds_exhausted: true,
      },
    ]
    const out = toChatMessage({ ...base, steps })
    expect(out.collabSteps).toEqual(steps)
  })

  it('**没有那笔账就不给空数组**——`null` 化成 undefined，那一栏根本不画', () => {
    expect(toChatMessage({ ...base, steps: null }).collabSteps).toBeUndefined()
    expect(toChatMessage(base).collabSteps).toBeUndefined()
  })

  it('另外两条附属事实也一起 hydrate（产出回执 / 校验结论）', () => {
    const art = {
      kind: 'deliver',
      label: '交付',
      title: '周报',
      href: '/notes?path=deliver/周报.md',
      path: 'deliver/周报.md',
      chunks: 1,
    }
    const out = toChatMessage({
      ...base,
      artifacts: [art],
      quality: { codes: ['not_saved'] },
      feedback: 'up',
    })
    expect(out.artifacts).toEqual([art])
    expect(out.quality).toEqual({ codes: ['not_saved'] })
    expect(out.feedback).toBe('up')
    expect(out.content).toBe('纪要正文')
  })
})
