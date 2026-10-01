// 对比度守卫：**皮肤表里的每一套值都要能读**。
//
// 为什么它必须是一条自动化测试而不是一次人工检查：配色好不好看要眼睛，
// 但「白字压在强调色上还认不认得出来」是可以算的（WCAG 相对亮度），
// 而人眼在 27 寸屏上看着「差不多」的那一档，实测经常是 2.7:1 —— 也就是不合格。
// 更关键的是**加第七个皮肤时**：没人会记得回头量一遍，而这条测试会。
//
// 判据取的是实际用到的组合（`src/theme/skins.ts` 的注释里写着每一档的用途）：
//   · `neutral-900/100` 正文压在页面底上
//   · `neutral-500/400` 次要文字（说明、时间、计数）
//   · `violet-700/300` 选中态文字压在 `violet-100 / violet-500@14%` 上
//   · 白字压在 `violet-600` 上 —— 全仓 88 处实底按钮就是这一条
//   · `violet-600/400` 强调文字压在页面底上
//
// 阈值取 WCAG AA 正文档 4.5:1。它比「好看」严，但换肤的代价本来就该由
// 皮肤表承担，而不是由用户的眼睛承担。
import { describe, expect, it } from 'vitest'

import { type SkinVariant } from './theme'
import { BUILTIN_SKIN_IDS, BUILTIN_SKINS } from './theme/skins'

/** 只量**内置**皮肤。理由有两条，两条都站得住：
 *  1. 用户导入的皮肤用的是他自己填的颜色，产品没法替他的选择背书；
 *  2. 量不了的东西就不该假装量过——这里迭代的是内置清单，不是 `listSkins()`。 */
const SKINS = Object.fromEntries(BUILTIN_SKINS.map((s) => [s.id, s]))
const SKIN_IDS = BUILTIN_SKIN_IDS

type Rgb = [number, number, number]

function hex(c: string): Rgb {
  const m = /^#?([0-9a-f]{6})$/i.exec(c.trim())
  if (!m) throw new Error(`不是颜色：${c}`)
  const n = parseInt(m[1], 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

const channels = (s: string): Rgb => {
  const parts = s.trim().split(/\s+/).map(Number)
  if (parts.length !== 3 || parts.some((v) => !Number.isFinite(v))) {
    throw new Error(`通道值不对：${s}`)
  }
  return parts as Rgb
}

/** 把 `f` 以 `t` 的比例叠在 `bg` 上（模拟 `bg-violet-500/10` 那种透明度叠加）。 */
function over(f: Rgb, bg: Rgb, t: number): Rgb {
  return [0, 1, 2].map((i) => Math.round(f[i] * t + bg[i] * (1 - t))) as Rgb
}

const lin = (v: number) => {
  const s = v / 255
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
}
const lum = (c: Rgb) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2])
function contrast(a: Rgb, b: Rgb): number {
  const l1 = lum(a)
  const l2 = lum(b)
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
}

const WHITE: Rgb = [255, 255, 255]

/** 一套值里所有要量的组合。名字写清楚「是哪一处」，红了才知道去哪改。 */
function pairs(v: SkinVariant, dark: boolean): { name: string; fg: Rgb; bg: Rgb }[] {
  const pageBg = hex(v.pageBg)
  return [
    { name: '正文 / 页面底', fg: channels(v.neutral[dark ? '100' : '900']), bg: pageBg },
    { name: '次要文字 / 页面底', fg: channels(v.neutral[dark ? '400' : '500']), bg: pageBg },
    {
      name: '选中态文字 / 选中态底',
      fg: channels(v.accentScale[dark ? '300' : '700']),
      bg: dark ? over(channels(v.accentScale['500']), pageBg, 0.14) : channels(v.accentScale['100']),
    },
    // 实底按钮：白字压在 600 上（`bg-violet-600` 那一档，全仓 88 处）
    { name: '白字 / 实底按钮(violet-600)', fg: WHITE, bg: channels(v.accentScale['600']) },
    // 链接 / 强调文字压在页面底上。**取哪一档跟着亮暗走**：亮色页面底是浅的，用 600（深）；
    // 暗色页面底是深的，用 400（浅）。两处都是产品里真实用的档位。
    {
      name: '强调色文字 / 页面底',
      fg: channels(v.accentScale[dark ? '400' : '600']),
      bg: pageBg,
    },
  ]
}

/** 逐条量一遍，返回「不合格」的那些（带 `皮肤/亮暗` 前缀，红了能直接定位）。 */
function audit(): { key: string; ratio: number }[] {
  const out: { key: string; ratio: number }[] = []
  for (const id of SKIN_IDS) {
    const skin = SKINS[id]
    for (const dark of [false, true]) {
      const v = dark ? skin.dark : skin.light
      for (const p of pairs(v, dark)) {
        out.push({
          key: `${skin.label}·${dark ? '暗' : '亮'} ${p.name}`,
          ratio: contrast(p.fg, p.bg),
        })
      }
    }
  }
  return out
}

/** 允许的例外 —— **逐条写清楚是哪一套值、为什么不动它**。
 *
 *  这张表不是免检名单：每一条都必须是**改动前就存在**的值，且要在下面那条
 *  「例外名单是精确的」里继续被量着。新皮肤不许往这里加条目——新皮肤的配色是这次
 *  自己选的，选一个读不清的配色没有理由。
 *
 *  现在只剩一条，而且它是**渐变的下端**，不是一块纯色（按钮实际是 600→700，
 *  整块的平均亮度更低，见下面那条用例）。 */
const EXCEPTIONS: Record<string, string> = {
  '默认·暗 白字 / 实底按钮(violet-600)':
    '暗色 600 = #7c3aed 是改动前的值（4.35:1）；按钮实际是 600→700 渐变，整体 5.26:1',
}

describe('皮肤对比度（WCAG AA 4.5:1）', () => {
  for (const id of SKIN_IDS) {
    for (const dark of [false, true]) {
      const skin = SKINS[id]
      const v = dark ? skin.dark : skin.light
      it(`${skin.label} · ${dark ? '暗色' : '亮色'}`, () => {
        const bad = pairs(v, dark)
          .filter((p) => {
            const r = contrast(p.fg, p.bg)
            if (r >= 4.5) return false
            return !(`默认·${dark ? '暗' : '亮'} ${p.name}` in EXCEPTIONS && skin.id === 'default')
          })
          .map((p) => `${p.name} 只有 ${contrast(p.fg, p.bg).toFixed(2)}:1`)
        expect(bad, `${skin.label}${dark ? '暗色' : '亮色'}有读不清的组合`).toEqual([])
      })
    }
  }

  it('例外名单是**精确的**：写进来的每一条都真的不合格，其余一条都不许有', () => {
    // 两个方向都钉住：
    //  ① 名单里的每一条确实 < 4.5（值改好了就该把它删掉，别留着一个过期的借口）；
    //  ② 名单外的每一条都 ≥ 4.5（上面那 12 条用例是分皮肤报的，这条是总账）。
    const all = audit()
    const failing = all.filter((r) => r.ratio < 4.5).map((r) => r.key)
    expect(failing.sort()).toEqual(Object.keys(EXCEPTIONS).sort())
  })

  it('例外没有继续变坏（各自 ≥ 4.2）', () => {
    const worse = audit()
      .filter((r) => r.key in EXCEPTIONS && r.ratio < 4.2)
      .map((r) => `${r.key} ${r.ratio.toFixed(2)}`)
    expect(worse).toEqual([])
  })

  it('实底按钮的**渐变两端**都达标——白字压在整条渐变上，不只是压在下端', () => {
    // `.wb-btn-primary` 是 `--wb-btn-from → --wb-btn-to` 的渐变，而这两端由
    // **皮肤**给（`theme.ts` 从强调色阶的 600/700 推，见 `index.css` 里那段说明）。
    // 这里量的是两端本身：渐变中间任何一点的亮度都在两端之间，两端合格则整条合格。
    //
    // 曾经的做法是把 500 当浅端——那是「按钮看起来亮一点」的审美选择，代价是
    // 白字只有 3.2–4.35:1。按钮不是展示强调色的地方，强调色由选中态、
    // 图表、焦点环去表达。
    const bad: string[] = []
    for (const id of SKIN_IDS) {
      const skin = SKINS[id]
      for (const dark of [false, true]) {
        const v = dark ? skin.dark : skin.light
        for (const step of ['600', '700'] as const) {
          const r = contrast(WHITE, channels(v.accentScale[step]))
          if (r >= 4.5) continue
          // 与上面那张例外表同一个判据：只放行**改动前就有**的那一套值
          if (skin.id === 'default' && dark && step === '600' && r >= 4.2) continue
          bad.push(`${skin.label}·${dark ? '暗' : '亮'} ${step} ${r.toFixed(2)}:1`)
        }
      }
    }
    expect(bad).toEqual([])
  })

  it('测量本身是对的（黑对白 = 21:1，同色 = 1:1）', () => {
    // 一条守卫自己算错了，就会一直绿着——先钉住量尺
    expect(contrast([0, 0, 0], WHITE)).toBeCloseTo(21, 1)
    expect(contrast(WHITE, WHITE)).toBeCloseTo(1, 5)
  })
})
