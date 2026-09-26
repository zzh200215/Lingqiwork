// `lineDelta` —— 历史版本那一格上「改了多少行」那个数。
//
// 它只是**行数增减**，不是逐行 diff（同一行挪位置、或改一个字，这里都算「一加一减」）。
// 这两条钉的就是这个口径本身：它答得了「改了多少」，答不了「改的是哪几行」。
import { describe, expect, it } from 'vitest'

import { lineDelta } from './PromptHistoryPanel'

describe('lineDelta', () => {
  it('多出来的算 add、少掉的算 del', () => {
    const older = '第一行\n共同的\n被删掉的一行'
    const newer = '第一行\n新加的一行\n共同的'
    expect(lineDelta(newer, older)).toEqual({ add: 1, del: 1 })
  })

  it('**空行不计**——空行增减是排版噪声，不是「改了内容」', () => {
    expect(lineDelta('a\n\n\nb', 'a\nb')).toEqual({ add: 0, del: 0 })
    expect(lineDelta('  a  \n b', 'a\nb')).toEqual({ add: 0, del: 0 }) // 行首尾空白也不算改
  })

  it('只加不改 / 只删不加', () => {
    expect(lineDelta('a\nb\nc', 'a')).toEqual({ add: 2, del: 0 })
    expect(lineDelta('a', 'a\nb\nc')).toEqual({ add: 0, del: 2 })
  })

  it('同一行出现两次时按**重数**算，不按「存在过」算', () => {
    // 旧版两行一样的、新版三行：多出来的那一行才是 +1
    expect(lineDelta('x\nx\nx', 'x\nx')).toEqual({ add: 1, del: 0 })
  })

  it('空输入不炸（历史列表里可能出现空正文的旧版）', () => {
    expect(lineDelta('', '')).toEqual({ add: 0, del: 0 })
    expect(lineDelta('a', '')).toEqual({ add: 1, del: 0 })
    expect(lineDelta('', 'a')).toEqual({ add: 0, del: 1 })
  })
})
