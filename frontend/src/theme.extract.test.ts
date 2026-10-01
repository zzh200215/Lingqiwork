// 从图片取色 + 按图算压暗。
//
// 这个文件测的是**纯的那两半**：量化挑色、以及「该压多暗」。读像素那一半
// （`readImageStats`）在 jsdom 里跑不了——它没有 canvas——所以那一半的验收
// 一直在真浏览器里做（见 `docs/ui-design-contract.md` §8.3）。
//
// 对比度这一块**自己算一遍**，不复用 `color.ts` 的 `relativeLuminance`：
// 测试要能独立地量出生产代码算错了，共用一份实现的话，两边一起错就一起过。
// 这也是 `theme.contrast.test.ts` 的规矩。
import { describe, expect, it } from 'vitest'

import { VEIL_FACTORS } from './theme/background'
import { CHROME_VEIL } from './theme/surfaces'
import { accentPalette, contrastWithWhite, mix, rgbToHsl, type Rgb } from './theme/color'
import {
  MAX_IMAGE_BLUR,
  TYPICAL_DETAIL,
  blurFor,
  coverRect,
  deriveSkinColors,
  detailLevel,
  glassFor,
  labelFromFilename,
  manifestFromImage,
  medianCut,
  newPhotoId,
  pickAccent,
  preferredMode,
  scrimForImage,
  skinFromImage,
  tintFor,
  tonalSpread,
  type ImageStats,
  type Sample,
} from './theme/extract'
import {
  MAX_LABEL,
  MIN_SKIN_SCRIM,
  SKIN_ID_RE,
  manifestToSkin,
  parseSkin,
  skinToManifest,
} from './theme/manifest'

// ---------- 独立的一份对比度 ----------

/** 相对亮度。用 WCAG 2.2 的断点 0.04045（`color.ts` 里用的是老版 0.03928），
 *  差得极小，但正因为是两份独立的实现，这里不该去对齐它。 */
function lum(c: Rgb): number {
  const f = (v: number): number => {
    const s = v / 255
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2])
}

function ratio(a: Rgb, b: Rgb): number {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

function hex(h: string): Rgb {
  const n = parseInt(h.replace('#', ''), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/** 这两档中性色**故意手写出来**，不从 `manifest.ts` 导入：契约里的值一改，
 *  这个文件就该红一次。导入的话它会跟着一起变，于是「改了契约」这件事没人看得见。 */
const NEUTRAL_LIGHT_500 = hex('#6b6b6b')
const NEUTRAL_DARK_400 = hex('#a1a1aa')

// ---------- 造样本 ----------

const S = (c: Rgb, a = 255): Sample => [c[0], c[1], c[2], a]

/** 造一份样本。**位置可控是必要的**——压暗是按「文字带」（左侧 20% + 顶部 20%）
 *  算的，要测它就得能指定哪一块是什么色。 */
function grid(at: (x: number, y: number) => Sample, w = 20, h = 20): ImageStats {
  const pixels: Sample[] = []
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) pixels.push(at(x, y))
  return { width: w, height: h, pixels }
}

const flat = (c: Rgb, w = 20, h = 20): ImageStats => grid(() => S(c), w, h)

/** 采样出来的像素是四元的（带 alpha），`medianCut` 收的是三元的。
 *  生产代码里这一步在 `accentPixels()`，这里手写一遍。 */
const rgbs = (s: ImageStats): Rgb[] => s.pixels.map((p) => [p[0], p[1], p[2]])

/** 三处文字带在 20×20 的样本里各占哪一块——**与 `surfaces()` 的 rect 对齐**。
 *  写死在这里是刻意的：改了那边的 rect，这些用例会红，而那正是该发生的事。 */
const SIDE = (x: number): boolean => x < 4
const BAR = (_x: number, y: number): boolean => y < 2
const MAIN = (x: number, y: number): boolean => x >= 4 && x < 7 && y >= 1 && y < 4

/** 只有指定的那一块是 `c`，其余是 `base`。 */
function onlyIn(
  where: (x: number, y: number) => boolean,
  c: Rgb,
  base: Rgb = [235, 235, 235]
): ImageStats {
  return grid((x, y) => S(where(x, y) ? c : base))
}

/** 三处文字带都是 `zone`，其余是 `rest`——「文字那一带」这个概念的最小样本。 */
function textBands(zone: Rgb, rest: Rgb, w = 20, h = 20): ImageStats {
  return grid((x, y) => S(SIDE(x) || BAR(x, y) || MAIN(x, y) ? zone : rest), w, h)
}

describe('取色 · 量化', () => {
  it('一张纯色图不会把切分循环转死，只出一个盒子', () => {
    // 这条防的是 `while (boxes.length < count)` 在没有盒子可切时转成死循环
    // ——一张纯色图就能把页面卡住，而那是最容易上传的一种图（截图）
    expect(medianCut(rgbs(flat([10, 10, 10])))).toHaveLength(1)
  })

  it('两种颜色切出两个盒子，均值就是那两个色', () => {
    const stats = grid((x) => S(x < 10 ? [255, 0, 0] : [0, 0, 255]))
    const boxes = medianCut(rgbs(stats))
    expect(boxes).toHaveLength(2)
    const means = boxes.map((b) => b.mean.map(Math.round).join(',')).sort()
    expect(means).toEqual(['0,0,255', '255,0,0'])
  })

  it('**没有随机性**：同一份输入跑两次结果完全一样', () => {
    // 这条对「保存下来的皮肤」是要紧的：结果随机的话，导出再导入会得到另一个颜色
    const stats = grid((x, y) => S([(x * 12) % 256, (y * 12) % 256, ((x + y) * 6) % 256]))
    const a = medianCut(rgbs(stats)).map((b) => b.mean.join(','))
    const b = medianCut(rgbs(stats)).map((b) => b.mean.join(','))
    expect(a).toEqual(b)
  })

  it('盒子数不超过请求数；空输入给空数组', () => {
    const stats = grid((x, y) => S([(x * 13) % 256, (y * 7) % 256, 128]))
    expect(medianCut(rgbs(stats), 4).length).toBeLessThanOrEqual(4)
    expect(medianCut([])).toEqual([])
  })

  it('占比加起来是 1（每个盒子都算了自己那一份）', () => {
    const stats = grid((x, y) => S([(x * 13) % 256, (y * 7) % 256, 128]))
    const sum = medianCut(rgbs(stats)).reduce((acc, b) => acc + b.pop, 0)
    expect(sum).toBeCloseTo(1, 6)
  })
})

describe('取色 · 挑一个强调色', () => {
  it('**大片灰里的一小块鲜艳赢的是鲜艳那一块**，不是那片灰', () => {
    // 这正是 color-thief 的 `getColor()` 栽的地方：它返回最大的那一簇，
    // 于是在任何截图或白底商品图上取到的都是背景色
    const stats = grid((x, y) => S(x < 9 && y < 9 ? [220, 30, 30] : [128, 128, 128]))
    const d = deriveSkinColors(stats)
    const c = hex(d.accent)
    expect(c[0], '取到的不是那块红').toBeGreaterThan(150)
    expect(c[1]).toBeLessThan(110)
  })

  it('占比低于 0.2% 的盒子不参与挑色——那是一个像素级的噪点，不是一块颜色', () => {
    const tiny = { pixels: [], mean: [255, 0, 0] as Rgb, pop: 0.0005, sat: 1, lum: 0.5 }
    expect(pickAccent([tiny]), '一个 0.05% 的噪点被当成了强调色').toBeNull()
    // 过了那条线就算数（这里只有它一个候选，所以它必须赢）
    expect(pickAccent([{ ...tiny, pop: 0.05 }])?.mean).toEqual([255, 0, 0])
  })

  it('一张全灰的图**不编色相**：给平均灰，并如实说「没有颜色」', () => {
    const d = deriveSkinColors(flat([128, 128, 128]))
    expect(d.chromatic).toBe(false)
    expect(d.accent).toBe('#808080')
    expect(rgbToHsl(hex(d.accent))[1]).toBeLessThan(0.01)
  })

  it('黑白照片（深浅两档灰）同样报「没有颜色」，强调色是那个平均灰', () => {
    const d = deriveSkinColors(grid((x) => S(x < 10 ? [40, 40, 40] : [210, 210, 210])))
    expect(d.chromatic).toBe(false)
    expect(rgbToHsl(hex(d.accent))[1]).toBeLessThan(0.01)
  })

  it('闷得几乎没颜色的图会被提到饱和度下限——再低按钮就看不出是彩色的了', () => {
    // 一个只带一点点暖调的浅褐（HSL 约 38° / 13% / 53%）
    const src: Rgb = [152, 140, 120]
    const d = deriveSkinColors(flat(src))
    expect(d.chromatic, '这点色相够了，不该当成无彩色').toBe(true)
    expect(rgbToHsl(hex(d.accent))[1]).toBeGreaterThanOrEqual(0.21)
    // 色相与明度不动：「这张图是暖的」归色相管。
    // 容差给 2°：色号是八位整数，往返一次本来就有一点点量化误差（实测 0.6°）
    const [h2, , l2] = rgbToHsl(hex(d.accent))
    const [h0, , l0] = rgbToHsl(src)
    expect(l2).toBeCloseTo(l0, 1)
    expect(Math.abs(h2 - h0), '色相被那一提改掉了').toBeLessThan(2)
  })

  it('深黄绿会被提亮——那是最讨嫌的一类颜色，不该拿来当强调色', () => {
    // Material 的 `DislikeAnalyzer`：色相 90–111、够彩、够暗 → 提亮到 0.70。
    // 这个色是照着那条判据造出来的（HSL 100° / 50% / 35%）
    const d = deriveSkinColors(flat([74, 134, 45]))
    const [h, , l] = rgbToHsl(hex(d.accent))
    expect(h).toBeGreaterThan(85)
    expect(h).toBeLessThan(115)
    expect(l, '还是那么闷').toBeGreaterThan(0.6)
  })

  it('强调色永远是合法的 `#rrggbb`，swatches 最多 5 个', () => {
    for (const c of [
      [0, 0, 0],
      [255, 255, 255],
      [255, 0, 0],
      [12, 240, 90],
    ] as Rgb[]) {
      const d = deriveSkinColors(flat(c))
      expect(d.accent, JSON.stringify(c)).toMatch(/^#[0-9a-f]{6}$/)
      expect(d.swatches.length).toBeLessThanOrEqual(5)
      expect(d.swatches.length).toBeGreaterThan(0)
    }
  })

  it('接近纯白的像素不参与挑色（截图/白底商品图整张都是白的）', () => {
    // 白底 + 一块颜色：不该因为白色占比最大就取到白色
    const stats = grid((x, y) => S(x < 10 && y < 10 ? [30, 90, 200] : [253, 253, 253]))
    const d = deriveSkinColors(stats)
    expect(rgbToHsl(hex(d.accent))[1]).toBeGreaterThan(0.2)
    expect(hex(d.accent)[2], '取到的应该是那块蓝，不是白').toBeGreaterThan(hex(d.accent)[0])
  })

  it('**全白图不会因为滤掉白色而一个候选都不剩**（逐级放宽那条阶梯）', () => {
    const d = deriveSkinColors(flat([255, 255, 255]))
    expect(d.accent).toMatch(/^#[0-9a-f]{6}$/)
    expect(d.chromatic).toBe(false)
  })
})

describe('压暗 · 按图算', () => {
  /** 生产代码那句「够」到底是不是真的够——**自己把那几层合成出来再量一遍**。
   *  位置照抄 `Layout.tsx` 的结构（侧栏 / 顶栏 / 主栏顶部），
   *  但合成与对比度都不复用 `surfaceColor()` 与 `contrastRatio()`。 */
  function check(stats: ImageStats, dark: boolean, p: number): number {
    const c = dark ? CHROME_VEIL.dark : CHROME_VEIL.light
    const chrome: Rgb = dark ? hex('#18181b') : [255, 255, 255]
    const text = dark ? NEUTRAL_DARK_400 : NEUTRAL_LIGHT_500
    const veil: Rgb = dark ? [0, 0, 0] : [255, 255, 255]
    const stack = (as: number[]): number => 1 - as.reduce((k, a) => k * (1 - a), 1)

    /** 一块里最不利的那个像素：亮色要最暗的，暗色要最亮的（5% / 95% 分位）。 */
    function worst(x0f: number, y0f: number, x1f: number, y1f: number): Rgb {
      const zone: Rgb[] = []
      const x1 = Math.min(Math.ceil(x1f * stats.width), stats.width)
      const y1 = Math.min(Math.ceil(y1f * stats.height), stats.height)
      for (let y = Math.floor(y0f * stats.height); y < y1; y++) {
        for (let x = Math.floor(x0f * stats.width); x < x1; x++) {
          const s = stats.pixels[y * stats.width + x]
          zone.push([s[0], s[1], s[2]])
        }
      }
      zone.sort((a, b) => lum(a) - lum(b))
      const q = dark ? 0.95 : 0.05
      return zone[Math.min(zone.length - 1, Math.floor(q * (zone.length - 1)))]
    }

    /** 一处：压暗叠上去，再叠壳自己的底色，然后量它和正文的对比度。 */
    function at(px: Rgb, factors: number[], ch: number): number {
      const a = stack(factors.map((f) => f * (p / 100)))
      const scrimmed = mix(px, veil, a)
      return ratio(ch > 0 ? mix(scrimmed, chrome, ch) : scrimmed, text)
    }

    return Math.min(
      at(worst(0, 0, 0.2, 1), [VEIL_FACTORS.sideMid, VEIL_FACTORS.base], c.side),
      at(worst(0, 0, 1, 0.08), [VEIL_FACTORS.top, VEIL_FACTORS.base], c.top),
      at(
        worst(0.2, 0.08, 0.35, 0.2),
        [VEIL_FACTORS.sideMid, VEIL_FACTORS.top, VEIL_FACTORS.base],
        0
      )
    )
  }

  it('**它说够了就是真的够了**——自己把那几层合成出来量一遍', () => {
    for (const v of [0, 40, 110, 128, 190, 235, 255]) {
      for (const dark of [false, true]) {
        const plan = scrimForImage(flat([v, v, v]), dark)
        if (!plan.ok) continue // 报「不够」的那些由下面那条用例管
        const got = check(flat([v, v, v]), dark, plan.scrim)
        expect(
          got,
          `rgb(${v}) ${dark ? '暗' : '亮'} 说压 ${plan.scrim}% 够了，实际只有 ${got.toFixed(2)}`
        ).toBeGreaterThanOrEqual(4.5)
      }
    }
  })

  it('**够不够要如实报**，而且**够不到时不往死里压**', () => {
    // 够不到 AA 时停在 62%（内置图片皮肤用的那一档），**不是 95**：
    // 实测从 62 压到 95 只把最不利那一处抬高不到 0.5，代价是那张图彻底看不见了。
    const plan = scrimForImage(flat([30, 30, 30]), false)
    expect(plan.ok).toBe(false)
    expect(plan.scrim, '够不到就压到 95 的话，用户上传的那张图会变成一块白板').toBeLessThan(80)
    // 报出来的比值也要是**那一档**的，不是 95% 那一档的
    expect(plan.ratio).toBeLessThan(3.5)
    // 反过来，同一张图在暗色模式下要的是相反的方向，够
    expect(scrimForImage(flat([30, 30, 30]), true).ok).toBe(true)
  })

  it('灰阶的实测表：够得到就压到够，够不到就停在 62%', () => {
    // 这张表是量出来的（`zzz.probe` 那类一次性脚本），钉住它是因为它说明了
    // 这条规则**有一道硬边**：130 的灰停在 62%，140 的灰压到 95%。
    // 看起来跳，但那正是「再压也买不到对比度」的实情。
    const at = (v: number) => scrimForImage(flat([v, v, v]), false)
    expect(at(235)).toMatchObject({ scrim: MIN_SKIN_SCRIM, ok: true })
    expect(at(190).scrim).toBeGreaterThan(60)
    expect(at(140).ok).toBe(true)
    expect(at(140).scrim).toBeGreaterThan(90)
    expect(at(130).ok).toBe(false)
    expect(at(130).scrim).toBe(62)
    expect(at(130).ratio).toBeLessThan(4)
  })

  it('报出来的那个比值就是**压到最重时实际能到的那个**（自己合成一遍对一遍）', () => {
    for (const v of [0, 30, 80, 140, 200, 255]) {
      for (const dark of [false, true]) {
        const plan = scrimForImage(flat([v, v, v]), dark)
        const got = check(flat([v, v, v]), dark, plan.scrim)
        expect(plan.ratio, `rgb(${v}) ${dark ? '暗' : '亮'} 报的比值对不上`).toBeCloseTo(got, 1)
        expect(plan.ok).toBe(plan.ratio >= 4.5)
      }
    }
  })

  it('很亮的图在亮色模式下够，压到下限就停（不会白压一层）', () => {
    const plan = scrimForImage(flat([235, 235, 235]), false)
    expect(plan.ok).toBe(true)
    expect(plan.scrim).toBe(MIN_SKIN_SCRIM)
  })

  it('**单调**：够得到的那些里，图越暗要的压暗越大（或持平）', () => {
    // 只断言**够得到**的那一段：够不到时停在 62%（见 `FALLBACK_SCRIM`），
    // 那一段本来就不单调，而且是有意的——硬凑单调会把图压没。
    let prev = -1
    for (const v of [250, 210, 190, 170, 150, 140]) {
      const { scrim, ok } = scrimForImage(flat([v, v, v]), false)
      expect(ok, `亮度 ${v} 处本该够得到`).toBe(true)
      expect(scrim, `亮度 ${v} 处压暗反而变小了`).toBeGreaterThanOrEqual(prev)
      prev = scrim
    }
    // 暗色那边方向相反：越亮要压得越重
    let darkPrev = -1
    for (const v of [0, 80, 130, 170, 210, 235]) {
      const { scrim, ok } = scrimForImage(flat([v, v, v]), true)
      expect(ok).toBe(true)
      expect(scrim).toBeGreaterThanOrEqual(darkPrev)
      darkPrev = scrim
    }
  })

  it('压暗永远落在 `[MIN_SKIN_SCRIM, 95]` 里', () => {
    for (const v of [0, 60, 128, 200, 255]) {
      for (const dark of [false, true]) {
        const { scrim } = scrimForImage(flat([v, v, v]), dark)
        expect(scrim).toBeGreaterThanOrEqual(MIN_SKIN_SCRIM)
        expect(scrim).toBeLessThanOrEqual(95)
      }
    }
  })

  it('压暗只按**文字那三块**算，不按整图平均——右下角亮不该逼着全图压', () => {
    const bands = deriveSkinColors(textBands([30, 30, 30], [250, 250, 250]))
    const rest = deriveSkinColors(textBands([250, 250, 250], [30, 30, 30]))
    expect(bands.scrimLight).toBeGreaterThan(rest.scrimLight)
    expect(bands.okLight).toBe(false)
    expect(rest.okLight).toBe(true)
  })

  it('**每一处各取各的最不利像素**——侧栏那块暗不该按「没有壳底色」的主栏去要求', () => {
    // 同一个色（120）放在侧栏里 vs 放在主栏顶部：
    // 侧栏自己有 70% 白底兜着（压 69% 就够），主栏顶部直接压在图上（压到 62%
    // 也只有 3.41，够不到）。两处的判据不同，结果也必须不同。
    //
    // 第一版是「全图取一个最不利像素、套到所有地方」，于是侧栏那块暗会把主栏的
    // 要求一起抬高——两处都会变成「够不到」，多要的那一截压暗全白压了。
    const inSide = deriveSkinColors(onlyIn(SIDE, [120, 120, 120]))
    const inMain = deriveSkinColors(onlyIn(MAIN, [120, 120, 120]))
    expect(inSide.okLight, '侧栏有白底兜着，这个色够得到').toBe(true)
    expect(inSide.scrimLight, '不该被主栏的要求带上去').toBeLessThan(80)
    expect(inMain.okLight, '主栏顶部没有壳底色，同一个色就够不到了').toBe(false)
    expect(inMain.ratioLight).toBeLessThan(inSide.ratioLight)
  })

  it('取的是 5% 分位，不是极值——一个黑点不该把全图压死', () => {
    // 侧栏那一块里只有一个黑点（1/400），其余是浅的：按 5% 分位取到的仍是浅色
    const stats = grid((x, y) => S(x === 0 && y === 0 ? [0, 0, 0] : [235, 235, 235]))
    const d = deriveSkinColors(stats)
    expect(d.scrimLight, '被一个黑点拉到底了').toBe(MIN_SKIN_SCRIM)
  })
})

describe('取色 · 一张图 → **一整套**皮肤（不只是壁纸）', () => {
  it('量「有多花」：分位差，极值不算数', () => {
    expect(tonalSpread(flat([128, 128, 128]))).toBe(0)
    // 一个黑点（在 400 个像素里占 0.25%）落不进 5% 分位，所以它不该代表整张图
    const speck = grid((x, y) => S(x === 0 && y === 0 ? [0, 0, 0] : [235, 235, 235]))
    expect(tonalSpread(speck), '一个黑点把「有多花」拉满了').toBe(0)
    // 真正对半分的一张图，分位差接近满值
    expect(tonalSpread(grid((x) => S(x < 10 ? [0, 0, 0] : [255, 255, 255])))).toBeGreaterThan(0.9)
  })

  it('量「有多密」：相邻差；平图约 0，噪声图高', () => {
    expect(detailLevel(flat([128, 128, 128]))).toBe(0)
    // 一张软渐变：相邻差很小
    const soft = grid((x, y) => S([x * 6, y * 6, 128]))
    // 一张棋盘：相邻差很大
    const checker = grid((x, y) => S((x + y) % 2 ? [0, 0, 0] : [255, 255, 255]))
    expect(detailLevel(soft)).toBeLessThan(0.1)
    expect(detailLevel(checker)).toBeGreaterThan(0.5)
  })

  it('**面板该多实**：图越花越实，但两端都不到 100', () => {
    // 一张平的图（雾、纸、单色）透一点什么也不会发生
    expect(glassFor(0)).toBe(88)
    // 明暗拉满的图，卡片透了就是字与图打架
    expect(glassFor(1)).toBeLessThan(75)
    // **两端都不是 100**：一张图当背景的皮肤，面板实心了就白搭了那张图
    for (const s of [0, 0.5, 1, 2, -1]) {
      expect(glassFor(s)).toBeLessThan(100)
      expect(glassFor(s)).toBeGreaterThanOrEqual(70)
    }
    // 单调：越花越实
    expect(glassFor(0.2)).toBeGreaterThan(glassFor(0.8))
  })

  it('**面板该多模糊**：细节越密越糊，且有上限（算出来的东西该保守）', () => {
    // 值的量级以 `TYPICAL_DETAIL`（0.003，实测的一张普通照片）为准——
    // 第一版把量级估错了一个数量级，于是每张图都算出 0px，整段推导成了死代码。
    expect(blurFor(0)).toBe(0)
    expect(blurFor(TYPICAL_DETAIL), '普通照片该给中档，不是 0').toBe(5)
    expect(blurFor(0.001)).toBeLessThan(blurFor(TYPICAL_DETAIL))
    expect(blurFor(TYPICAL_DETAIL)).toBeLessThan(blurFor(0.006))
    expect(blurFor(0.05), '噪声图必须有上限截住').toBe(MAX_IMAGE_BLUR)
    expect(MAX_IMAGE_BLUR).toBeLessThanOrEqual(14)
    // 平的图不该白花一次合成
    expect(blurFor(0)).toBe(0)
  })

  it('**色调的方向永远往这一模式的压暗色靠**——这样它只会让字更好读', () => {
    // 亮色下往白里推、暗色下往黑里推。反过来（亮色下压暗）的话，
    // 按原图解出来的压暗就不够了，而「字读不清」是这一整套里最不能出的问题。
    const base: Rgb = [180, 90, 60]
    const light = tintFor(base, true, false)
    const dark = tintFor(base, true, true)
    expect(rgbToHsl(hex(light.color))[2], '亮色的薄纱该是浅的').toBeGreaterThan(0.7)
    expect(rgbToHsl(hex(dark.color))[2], '暗色的薄纱该是深的').toBeLessThan(0.35)
    expect(light.alpha).toBeGreaterThan(0)
    expect(dark.alpha).toBeGreaterThan(light.alpha)
    // 它是**薄纱不是滤镜**：色相留着，饱和度压到很低
    expect(rgbToHsl(hex(light.color))[1]).toBeLessThan(0.3)

    // 无彩色的图不叠色调：一层灰纱只会让画面发闷
    expect(tintFor([128, 128, 128], false, false)).toEqual({ color: '', alpha: 0 })
  })

  it('**先用在哪个明暗**：亮色能用就用亮色，只有一边坏时才反过来', () => {
    expect(preferredMode(true, true)).toBe('light')
    expect(preferredMode(true, false)).toBe('light')
    expect(preferredMode(false, true)).toBe('dark')
    // 两边都坏：仍然报亮色（出厂值），界面去说「差多少」
    expect(preferredMode(false, false)).toBe('light')
  })

  it('**生成的皮肤真的写上了面板层与色调**（不是只有一张图）', () => {
    const d = deriveSkinColors(textBands([220, 220, 220], [180, 120, 60]))
    const m = parseSkin(
      manifestFromImage({ id: 'photo-x', label: '海边', image: '/api/images/a.png', derived: d })
    )
    expect(m.ok).toBe(true)
    if (!m.ok) return
    // 面板层：通透度按图算出来了，而且壳比面板更透（层级靠通透度的差别读出来）
    for (const side of ['light', 'dark'] as const) {
      const s = m.value[side]?.surfaces
      expect(s?.glass, `${side} 缺 glass`).toBe(d.surfaces.glass)
      expect(s?.blur).toBe(d.surfaces.blur)
      expect(s?.chromeGlass, `${side} 的壳该比面板更透`).toBeLessThan(s!.glass!)
    }
    // 色调：两个模式各一份，方向相反
    expect(m.value.light?.bg?.tint?.color).not.toBe(m.value.dark?.bg?.tint?.color)

    // 推到运行时之后，面板底色**带着这张图的色偏**——因为 `resolveSurface`
    // 是从 `pageBg` 推的，而 `pageBg` 是从强调色推的。
    const skin = manifestToSkin(m.value)
    expect(skin.light.surfaces.glass).toBe(d.surfaces.glass)
    expect(skin.light.surface).not.toBe(skin.dark.surface)
  })

  it('**一张平的图 → 面板更透；一张花的图 → 面板更实**（端到端的那条结论）', () => {
    const flatImage = deriveSkinColors(flat([200, 200, 200]))
    const busy = deriveSkinColors(grid((x, y) => S((x + y) % 2 ? [10, 10, 10] : [245, 245, 245])))
    expect(flatImage.surfaces.glass!).toBeGreaterThan(busy.surfaces.glass!)
    // 花的图细节密 → 模糊也更高（糊一片高频细节才买得到可读性）
    expect(busy.surfaces.blur!).toBeGreaterThan(flatImage.surfaces.blur!)
  })
})

describe('取色 · cover 裁哪一块', () => {
  it('宽图裁左右、高图裁上下、比例正好就不裁', () => {
    const aspect = 16 / 9
    const wide = coverRect(4000, 1000, aspect)
    expect(wide.sy).toBe(0)
    expect(wide.sh).toBe(1000)
    expect(wide.sw).toBeCloseTo(1000 * aspect, 6)
    expect(wide.sx).toBeCloseTo((4000 - 1000 * aspect) / 2, 6)

    const tall = coverRect(1000, 4000, aspect)
    expect(tall.sx).toBe(0)
    expect(tall.sw).toBe(1000)
    expect(tall.sh).toBeCloseTo(1000 / aspect, 6)
    expect(tall.sy).toBeCloseTo((4000 - 1000 / aspect) / 2, 6)

    const exact = coverRect(1600, 900, aspect)
    expect(exact.sx).toBe(0)
    expect(exact.sy).toBe(0)
    expect(exact.sw).toBe(1600)
    expect(exact.sh).toBeCloseTo(900, 6)
  })

  it('裁出来的那一块整个落在原图里', () => {
    for (const [iw, ih] of [
      [4000, 1000],
      [1000, 4000],
      [1600, 900],
      [900, 1600],
    ]) {
      const r = coverRect(iw, ih, 16 / 9)
      expect(r.sx).toBeGreaterThanOrEqual(0)
      expect(r.sy).toBeGreaterThanOrEqual(0)
      expect(r.sx + r.sw).toBeLessThanOrEqual(iw + 1e-6)
      expect(r.sy + r.sh).toBeLessThanOrEqual(ih + 1e-6)
    }
  })
})

describe('取色 · 名字与 id', () => {
  it('名字来自文件名：去扩展名、去路径、限长', () => {
    expect(labelFromFilename('IMG_2043.jpg')).toBe('IMG_2043')
    expect(labelFromFilename('C:\\Users\\me\\海边日落.PNG')).toBe('海边日落')
    expect(labelFromFilename('/tmp/a/b/wallpaper-with-a-very-long-name.png')).toHaveLength(MAX_LABEL)
    expect(labelFromFilename('')).toBe('图片皮肤')
    expect(labelFromFilename('.gitignore')).toBe('图片皮肤')
  })

  it('id 合皮肤 id 的规则，而且两次不一样', () => {
    const a = newPhotoId()
    const b = newPhotoId()
    expect(a).toMatch(SKIN_ID_RE)
    expect(a.length).toBeLessThanOrEqual(32)
    expect(a).not.toBe(b)
    expect(a.startsWith('photo-')).toBe(true)
  })
})

describe('取色 · 变成一套皮肤', () => {
  const derived = deriveSkinColors(textBands([220, 220, 220], [180, 120, 60]))
  const IMG = '/api/images/img-20261001-120000-abcdef.png'

  it('生成的皮肤**过同一个闸**（`parseSkin`），两个变体各带一张底图', () => {
    const m = parseSkin(
      manifestFromImage({
        id: 'photo-x',
        label: '海边',
        image: IMG,
        hint: '从「海边.jpg」取的色',
        derived,
      })
    )
    expect(m.ok).toBe(true)
    if (!m.ok) return
    expect(m.value.light?.bg?.image).toBe(IMG)
    expect(m.value.dark?.bg?.image).toBe(IMG)
    expect(m.value.light?.bg?.scrimDir).toBe('edge')
  })

  it('亮暗两套的压暗**是分开算的**，而色阶与页面底色交给推导（一个字都不写）', () => {
    const m = parseSkin(manifestFromImage({ id: 'photo-x', label: '海边', image: IMG, derived }))
    if (!m.ok) throw new Error('fixture')
    expect(m.value.light?.accentScale).toBeUndefined()
    expect(m.value.light?.pageBg).toBeUndefined()
    expect(m.value.dark?.accent).toBeUndefined()

    const skin = manifestToSkin(m.value)
    // 暗色那一边的强调色是自动提亮的（同一个色号在暗底上会发闷）
    expect(skin.dark.accent).not.toBe(skin.light.accent)
    expect(skin.light.accentScale['500']).toBe(accentPalette(derived.accent)['500'])
    // 十一条色阶由那一个色号推出来
    expect(Object.keys(skin.light.accentScale)).toHaveLength(11)
    // 两个变体的压暗就是算出来的那两个
    expect(skin.light.bg?.scrim).toBe(derived.scrimLight)
    expect(skin.dark.bg?.scrim).toBe(derived.scrimDark)
  })

  it('**白字压在实底按钮上仍然合格**——生成的皮肤也要守这条纪律', () => {
    // 淡色当强调色时 `accentPalette` 的 600 会一路压到白字够为止
    for (const c of ['#fde047', '#a3e635', '#7dd3fc', '#f0abfc']) {
      const d = deriveSkinColors(flat(hex(c)))
      const [r, g, b] = accentPalette(d.accent)['600'].split(' ').map(Number)
      expect(
        contrastWithWhite([r, g, b]),
        `${c} → ${d.accent} 的 600 压不住白字`
      ).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('导出之后**带得走**：底图与色号都在，且能再导入回来', () => {
    const m = parseSkin(manifestFromImage({ id: 'photo-x', label: '海边', image: IMG, derived }))
    if (!m.ok) throw new Error('fixture')
    const out = skinToManifest(manifestToSkin(m.value))
    expect(out.accent).toBe(derived.accent)
    expect(out.light?.bg?.image).toBe(IMG)
    // 再导入回来还是同一套（往返不掉东西）
    const back = parseSkin(out)
    expect(back.ok).toBe(true)
    if (back.ok) expect(manifestToSkin(back.value).light.bg?.scrim).toBe(derived.scrimLight)
  })

  it('地址不合法时**当场拒绝，连图都不去加载**', async () => {
    // 这条也顺便保证了这一层不会在 jsdom 里挂住：`Image()` 在 jsdom 里既不 load
    // 也不 error，真去加载的话这个 promise 永远不 resolve
    const got = await skinFromImage('javascript:alert(1)', 'x.png', 'photo-x')
    expect(got.ok).toBe(false)
    if (!got.ok) expect(got.reason).toContain('地址')
  })
})
