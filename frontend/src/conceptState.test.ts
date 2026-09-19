// 学习地图四档的**一份词与一份色**（P2 · F13）。
//
// 这张表有两个读者——学页那张地图与零柒小屋的概念卡——所以这里钉的不是渲染，是
// **词本身**：那四个词被改掉（「在学」写成「学过」），两处会同时改对；但要是有人
// 在某一页里另写一套，这几条断言就是最后一道拦网。
import { describe, expect, it } from 'vitest'

import { CONCEPT_STATE, CONCEPT_STATES, conceptState } from './conceptState'

describe('conceptState', () => {
  it('四档，顺序与地图一致，词就是界面上那四个', () => {
    expect(CONCEPT_STATES.map((s) => s.key)).toEqual([
      'mastered',
      'learning',
      'stuck',
      'untouched',
    ])
    expect(CONCEPT_STATES.map((s) => s.label)).toEqual(['已掌握', '在学', '卡住', '未触及'])
  })

  it('每一档都给全三样：标签色、那行字的色、整张卡的色', () => {
    for (const s of CONCEPT_STATES) {
      expect(s.key).toBe(CONCEPT_STATE[s.key].key) // 键与对象本身对得上
      expect(s.chip.length).toBeGreaterThan(0)
      expect(s.text.length).toBeGreaterThan(0)
      expect(s.card.length).toBeGreaterThan(0)
    }
    // 前三档各有自己的颜色（第四档「未触及」是中性灰，且它不进小屋）
    const colors = ['emerald', 'sky', 'amber']
    CONCEPT_STATES.slice(0, 3).forEach((s, i) => {
      expect(s.card).toContain(colors[i])
      expect(s.text).toContain(colors[i])
    })
  })

  it('认不出来的档返回 null——界面宁可照实写档位名，也不猜一个颜色糊上', () => {
    expect(conceptState('mastered')).toBe(CONCEPT_STATE.mastered)
    expect(conceptState('复习中')).toBeNull()
    expect(conceptState('')).toBeNull()
    expect(conceptState('constructor')).toBeNull() // 原型链上的名字也不算
  })
})
