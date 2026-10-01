// 热切换零残留。钉的是 §8.2 那句「皮肤是**数据**,不是代码」的另一半:
// 正因为皮肤没有 activate/deactivate 钩子,切换是 `applyTheme` 的一次**全量重写**,
// 所以「忘了卸载」「卸载了一半」这一类 bug 在结构上就不该存在。
// 这两条测试让这个结构性的保证变成可回归的断言——哪天有人往切换路径上加
// 一条条件写入,这里就会叫。
//
// 与 `theme.test.ts` 的 applyTheme 用例分工:那边测「写了什么」,这边测
// 「**来回切**之后还剩什么」。
import { describe, expect, it } from 'vitest'

import { DEFAULT_THEME, applyTheme, resolveTheme, type ThemeConfig } from './theme'
import { BUILTIN_SKINS } from './theme/skins'

/** 出发点:出厂外观。遍历一圈之后必须回到和它逐字节相同的样子。 */
const START: ThemeConfig = { ...DEFAULT_THEME }

/** 全部 `--wb-*` 变量的名单。`applyTheme` 返回的就是它写进 DOM 的那一份,
 *  名单从这里取,而不是从 DOM 枚举——名单该是**声明的**,不是碰巧在场的。 */
const VAR_NAMES = Object.keys(applyTheme(resolveTheme(START))).sort()

/** <html> 上与外观有关的一切:dark 类、三个 data 属性、color-scheme、全部变量。 */
function appearanceSnapshot(): Record<string, string> {
  const root = document.documentElement
  const out: Record<string, string> = {
    dark: root.classList.contains('dark') ? '1' : '0',
    scheme: root.style.colorScheme,
    bg: root.dataset.wbBg ?? '',
    skin: root.dataset.wbSkin ?? '',
    mode: root.dataset.wbMode ?? '',
  }
  for (const name of VAR_NAMES) out[name] = root.style.getPropertyValue(name)
  return out
}

/** DOM 里**实际在场**的 `--wb-*` 名单(枚举内联样式)。 */
function domVarNames(): string[] {
  const style = document.documentElement.style
  const names: string[] = []
  for (let i = 0; i < style.length; i++) {
    const name = style.item(i)
    if (name.startsWith('--wb-')) names.push(name)
  }
  return names.sort()
}

function sameSnapshot(a: Record<string, string>, b: Record<string, string>): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

describe('热切换零残留', () => {
  it('把内置皮肤×亮暗遍历一遍再回到出发点,<html> 上的一切与出发时逐项相同', () => {
    applyTheme(resolveTheme(START))
    const before = appearanceSnapshot()

    let sawDifference = false
    for (const skin of BUILTIN_SKINS) {
      for (const mode of ['light', 'dark'] as const) {
        applyTheme(resolveTheme({ ...START, skin: skin.id, mode }))
        if (!sameSnapshot(appearanceSnapshot(), before)) sawDifference = true
      }
    }
    // 中途必须**真的不一样过**——不然这条测试只是在证明 applyTheme 什么都没做
    expect(sawDifference).toBe(true)

    applyTheme(resolveTheme(START))
    const after = appearanceSnapshot()
    // 逐项对比而不是整对象比较:真残留了,失败信息要能说出是哪一项
    const keys = new Set([...Object.keys(before), ...Object.keys(after)])
    const drifted = [...keys].filter((k) => before[k] !== after[k])
    expect(drifted).toEqual([])
  })

  it('变量名单是恒定的:任何皮肤×亮暗写出来的都是同一组名字——残留只可能是值,不可能是名字', () => {
    for (const skin of BUILTIN_SKINS) {
      for (const mode of ['light', 'dark'] as const) {
        const r = resolveTheme({ ...START, skin: skin.id, mode })
        expect(Object.keys(r.vars).sort()).toEqual(VAR_NAMES)
        // DOM 那一侧也验一遍:不许有多写的(上一套留下的),也不许有少写的
        applyTheme(r)
        expect(domVarNames()).toEqual(VAR_NAMES)
      }
    }
  })
})
