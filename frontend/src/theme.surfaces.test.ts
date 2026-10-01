// 面板层（`theme/surfaces.ts`）：**一个主旋钮驱动五档面，其中三档有下限**。
//
// 这一层是「换一张壁纸」与「换一套皮肤」的分界：它决定卡片、侧栏、顶栏、输入框、
// 浮层各自的底色与通透度。下限那几条是这一层的重点——它们不是风格选项，
// 是这类界面能不能用，所以测的不是「能不能调」，而是「**调不坏**」。
//
// 另一半是**分区域**：八个值，皮肤能写、用户能拨，而「没拨过的跟着主旋钮走」
// 是一条**规则**（不是便利），所以它也有自己的用例。
import { describe, expect, it } from 'vitest'

import { parseSkin, manifestToSkin, skinToManifest } from './theme/manifest'
import {
  BORDER_FLOOR,
  DEFAULT_CHROME_GLASS,
  DEFAULT_SURFACES,
  FIELD_FLOOR,
  FLOAT_FLOOR,
  MAX_PANEL_BLUR,
  PANEL_FLOOR,
  SURF_KEYS,
  SURF_RANGE,
  applyOverrides,
  fillSurfaces,
  hasOverrides,
  panelAlpha,
  resolveChrome,
  resolveSurface,
  surfFloor,
  surfValue,
} from './theme/surfaces'

const MINIMAL = { id: 'sakura', label: '樱', accent: '#d9558a' }

/** 造一份皮肤并把它的亮色那一半取出来。 */
function lightOf(extra: Record<string, unknown>) {
  const got = parseSkin({ ...MINIMAL, light: extra })
  if (!got.ok) throw new Error(got.reason)
  return manifestToSkin(got.value).light
}

describe('面板层 · 一个旋钮四档面', () => {
  it('不写就是实心面板 + 产品今天的壳（85%）', () => {
    expect(fillSurfaces()).toEqual(DEFAULT_SURFACES)
    expect(DEFAULT_SURFACES.glass).toBe(100)
    expect(DEFAULT_SURFACES.chromeGlass).toBe(DEFAULT_CHROME_GLASS)
    expect(DEFAULT_CHROME_GLASS).toBe(85)
  })

  it('**每一档都有自己的下限，作者改不动**', () => {
    // 这是整个文件里最要紧的三条：它们挡的不是审美，是「能不能用」。
    expect(panelAlpha('card', 0)).toBe(PANEL_FLOOR.card)
    expect(panelAlpha('field', 0)).toBe(FIELD_FLOOR)
    expect(panelAlpha('float', 0)).toBe(FLOAT_FLOOR)
    // 而且顺序是对的：浮层最实、输入框次之、卡片可以最透
    expect(PANEL_FLOOR.float).toBeGreaterThan(PANEL_FLOOR.field)
    expect(PANEL_FLOOR.field).toBeGreaterThan(PANEL_FLOOR.card)
    // 卡片那一档**不是 0**：全透的卡片不是通透，是「没有卡片」
    expect(PANEL_FLOOR.card).toBeGreaterThan(0)
  })

  it('拨到 100 就完全不透明，中间的值原样给', () => {
    expect(panelAlpha('card', 100)).toBe(100)
    expect(panelAlpha('card', 72)).toBe(72)
    // 坏值用默认（100）而不是夹成 0——「值坏了」与「要全透」是两件事
    expect(panelAlpha('card', Number.NaN)).toBe(100)
  })

  it('**皮肤声明的 glass 再低也压不穿下限**', () => {
    // 一份写着 `glass: 0` 的皮肤导入进来之后，卡片仍然是 55%。
    // 「导入一份别人给的皮肤就把界面弄成不能用」这条得堵死。
    const v = lightOf({ surfaces: { glass: 0 } })
    expect(panelAlpha('card', v.surfaces.glass)).toBe(PANEL_FLOOR.card)
    expect(v.surfaces.glass).toBe(0) // 值本身照存（导出时要还原它）
  })

  it('边框浓度有下限——0 会让卡片在一张花图上糊成一片', () => {
    const v = lightOf({ surfaces: { borderAlpha: 0 } })
    expect(v.surfaces.borderAlpha).toBe(BORDER_FLOOR)
    expect(BORDER_FLOOR).toBeGreaterThan(40)
  })
})

describe('面板层 · 底色从哪来', () => {
  it('没写就从页面底色推，而且**往白那头推**（面板永远比页面亮一档）', () => {
    // 亮色：白底推 4% 还是白（与产品今天一模一样）
    expect(resolveSurface(fillSurfaces(), '#ffffff', false)).toBe('#ffffff')
    // 暗色：`#0a0a0a` 推 6% → 约等于 `neutral-900`，也就是今天暗色卡片那个色
    const dark = resolveSurface(fillSurfaces(), '#0a0a0a', true)
    expect(dark).toBe('#191919')
    expect(parseInt(dark.slice(1, 3), 16)).toBeGreaterThan(0x0a)
  })

  it('写了就用写的；壳不写就跟面板', () => {
    const s = fillSurfaces({ surface: '#101820', chrome: '#0a1014' })
    expect(resolveSurface(s, '#ffffff', false)).toBe('#101820')
    expect(resolveChrome(s, '#101820')).toBe('#0a1014')
    expect(resolveChrome(fillSurfaces(), '#101820')).toBe('#101820')
  })

  it('推的方向是**往白那头**：面板永远不比页面暗', () => {
    // 注意白底那一档推出来**还是白**——那是刻意的，产品今天就是
    // 「白页面 + 白卡片」。所以这里断言的是**方向**（不比页面暗），
    // 而不是「两者不相等」：后者在白底上本来就是假的。
    const shade = (h: string): number => parseInt(h.slice(1), 16)
    for (const page of ['#ffffff', '#0a0a0a', '#f4f7f9', '#0a1014']) {
      for (const dark of [false, true]) {
        expect(shade(resolveSurface(fillSurfaces(), page, dark))).toBeGreaterThanOrEqual(shade(page))
      }
    }
    // 深底那一档差别最要紧：暗色卡片不该和页面同色，否则有底图时两层糊在一起
    expect(resolveSurface(fillSurfaces(), '#0a0a0a', true)).not.toBe('#0a0a0a')
    // 而且暗色推得比亮色多——深底要推得更远才分得出来
    expect(shade(resolveSurface(fillSurfaces(), '#0a0a0a', true))).toBeGreaterThan(
      shade(resolveSurface(fillSurfaces(), '#0a0a0a', false))
    )
  })
})

describe('面板层 · 数据这一层把关', () => {
  it('**侧栏与顶栏可以分开调，但默认是一档**', () => {
    // 「壳是一个区域」是默认，不是禁令：参考实现（Codex Dream Skin）把
    // `sidebar` 与 `header` 当两个可以分别设的部件，而那样的皮肤确实存在。
    const together = fillSurfaces({ chromeGlass: 60 })
    expect(together.sidebarGlass).toBe(60)
    expect(together.topbarGlass).toBe(60)

    const apart = fillSurfaces({ chromeGlass: 60, sidebarGlass: 88 })
    expect(apart.sidebarGlass).toBe(88)
    expect(apart.topbarGlass).toBe(60) // 没写的那个跟着壳
  })

  it('**每一项都可以省**：写一个 glass 就够', () => {
    const v = lightOf({ surfaces: { glass: 70 } })
    expect(v.surfaces.glass).toBe(70)
    expect(v.surfaces.blur).toBe(0) // 其余全是默认值
    expect(v.surfaces.shadow).toBe(100)
  })

  it('颜色写错 = 整条皮肤被拒（与其余字符串字段同一条纪律）', () => {
    expect(parseSkin({ ...MINIMAL, light: { surfaces: { surface: 'not-a-color' } } }).ok).toBe(false)
    expect(parseSkin({ ...MINIMAL, light: { surfaces: 'x' } }).ok).toBe(false)
  })

  it('**空串等于没写**——不然「导出再导入」会把一份自己导出的皮肤拒掉', () => {
    // 这条是实测出来的：`fillSurfaces()` 把默认值 `surface: ''` 补进运行时对象，
    // `skinToManifest` 又把它写进导出文件，再导入时解析器把空串当成坏值
    // ——症状是「一份自己导出的皮肤导不回来」，而报的错与看到的空字符串对不上号。
    const got = parseSkin({ ...MINIMAL, light: { surfaces: { surface: '', chrome: '', glass: 66 } } })
    expect(got.ok).toBe(true)
    if (got.ok) expect(got.value.light?.surfaces?.glass).toBe(66)
  })

  it('导出再导入把面板层原样带过去', () => {
    const skin = parseSkin({ ...MINIMAL, light: { surfaces: SURF } })
    if (!skin.ok) throw new Error(skin.reason)
    const before = manifestToSkin(skin.value).light.surfaces
    expect(before).toMatchObject(SURF)

    const back = parseSkin(JSON.parse(JSON.stringify(skinToManifest(manifestToSkin(skin.value)))))
    expect(back.ok).toBe(true)
    if (!back.ok) return
    // 逐字段一样：导出省掉的那些默认值，导入时会填回同一个数
    expect(manifestToSkin(back.value).light.surfaces).toEqual(before)
  })
})

/** 一份「哪一项都不是默认值」的面板层，用来验往返不掉东西。 */
const SURF = { glass: 72, chromeGlass: 60, blur: 12, borderAlpha: 80, shadow: 40 }

describe('面板层 · 分区域（八个值，皮肤能写、用户能拨）', () => {
  it('**闭集与接口不脱节**：`SURF_KEYS` 恰好就是「皮肤能写的那些数」', () => {
    // 这一条挡的是「加了字段忘了加进闭集」：那种漏项的症状是
    // 「皮肤里写了，用户拨不动」或者「用户拨了，导出时丢了」，
    // 而两处各自看起来都对。底色那两项是**颜色**，不在这个集合里。
    const numeric = Object.keys(DEFAULT_SURFACES).filter((k) => typeof DEFAULT_SURFACES[k as never] === 'number')
    expect([...SURF_KEYS].sort()).toEqual([...numeric].sort())
    // 每一项都有值域，否则滑块算不出上下限
    for (const k of SURF_KEYS) expect(SURF_RANGE[k], `${k} 没有值域`).toBeTruthy()
  })

  it('**输入框与浮层不写就跟面板那一档**（而不是各自一个常数）', () => {
    const s = fillSurfaces({ glass: 62 })
    expect(s.fieldGlass).toBe(62)
    expect(s.floatGlass).toBe(62)
    // 侧栏 / 顶栏跟的是壳那一档，不是面板那一档——两条链互不干扰
    expect(s.sidebarGlass).toBe(DEFAULT_CHROME_GLASS)
  })

  it('拨主旋钮：**没单独拨过的跟着走，拨过的定住**', () => {
    const base = fillSurfaces({ glass: 82, chromeGlass: 72 })
    const s = applyOverrides(base, { glass: 40 })

    expect(s.glass).toBe(40)
    // 下游跟着走（这正是旧版那根滑块的行为，用户拖它时预期「整个界面透一点」）
    expect(s.chromeGlass).toBe(40)
    expect(s.sidebarGlass).toBe(40)
    expect(s.topbarGlass).toBe(40)
    expect(s.fieldGlass).toBe(40)
    expect(s.floatGlass).toBe(40)

    // 单独拨过的那一项**不被主旋钮吃掉**
    const mixed = applyOverrides(base, { glass: 40, sidebarGlass: 96 })
    expect(mixed.sidebarGlass).toBe(96)
    expect(mixed.topbarGlass).toBe(40)
  })

  it('原对象不被改（覆盖合成是纯函数）', () => {
    const base = fillSurfaces({ glass: 82 })
    applyOverrides(base, { glass: 10, blur: 20 })
    expect(base.glass).toBe(82)
    expect(base.blur).toBe(0)
  })

  it('手改进来的坏值进不来：认不出的项丢掉，超范围的夹回区间', () => {
    const base = fillSurfaces({ glass: 80 })
    const s = applyOverrides(base, {
      glass: Number.NaN,
      blur: 400,
      borderAlpha: 0,
      shadow: -20,
      // 认不出的键（旧版本、手改、别的实现）一个都不该进来
      nope: 5,
    } as never)
    expect(s.glass).toBe(80) // NaN 不算数，退回皮肤那一档
    expect(s.blur).toBe(MAX_PANEL_BLUR) // 400 夹到 24——不是每帧重采样 400px
    expect(s.borderAlpha).toBe(BORDER_FLOOR)
    expect(s.shadow).toBe(0)
    expect('nope' in s).toBe(false)
  })

  it('`hasOverrides` 只认得出数的项（`{}` 与全是垃圾都算「没拨过」）', () => {
    expect(hasOverrides()).toBe(false)
    expect(hasOverrides({})).toBe(false)
    expect(hasOverrides({ glass: Number.NaN })).toBe(false)
    expect(hasOverrides({ glass: 0 })).toBe(true) // 0 是一次明确的表态
  })

  it('**界面显示的是「看到的那个数」**：过下限之后的结果', () => {
    // 一份写着 `glass: 0` 的皮肤：卡片渲染 55%、输入框 80%、浮层 95%。
    // 界面显示 0 的话，就成了「滑块说 0、屏幕上是 55」——那会让人不再相信这块面板。
    const s = fillSurfaces({ glass: 0 })
    expect(surfValue(s, 'glass')).toBe(PANEL_FLOOR.card)
    expect(surfValue(s, 'fieldGlass')).toBe(FIELD_FLOOR)
    expect(surfValue(s, 'floatGlass')).toBe(FLOAT_FLOOR)
    // 没下限的那几项就是它自己
    expect(surfValue(fillSurfaces({ blur: 8, shadow: 40 }), 'blur')).toBe(8)
    expect(surfValue(fillSurfaces({ shadow: 40 }), 'shadow')).toBe(40)
  })

  it('滑块的**下限就是那一层的地板**（拨不到看不见的地方去）', () => {
    expect(surfFloor('glass')).toBe(PANEL_FLOOR.card)
    expect(surfFloor('fieldGlass')).toBe(FIELD_FLOOR)
    expect(surfFloor('floatGlass')).toBe(FLOAT_FLOOR)
    expect(surfFloor('borderAlpha')).toBe(BORDER_FLOOR)
    // 地板 ≥ 值域下限，否则滑块会显示一个算不出来的数
    for (const k of SURF_KEYS) {
      expect(surfFloor(k), `${k} 的地板比值域下限还低`).toBeGreaterThanOrEqual(SURF_RANGE[k][0])
    }
  })
})
