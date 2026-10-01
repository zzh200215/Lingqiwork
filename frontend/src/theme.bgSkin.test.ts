// 「图片式背景皮肤」：皮肤自带的那张底图，与用户自定义背景的**分派规则**，
// 以及压暗怎么分布。
//
// 这一份盯的是三件事：
//   1. **谁说了算**——用户设了背景就是用户的，没设才是皮肤的（只有这一条规则）。
//   2. **边缘加重真的算出了两个梯度**，而且底子那一层被减弱了（不减弱就不是边缘加重）。
//   3. **不合法/看不下去的底图进不来**——地址白名单，以及压暗有一个下限。
import { describe, expect, it } from 'vitest'

import {
  DEFAULT_BG,
  DEFAULT_THEME,
  MIN_SKIN_SCRIM,
  accentPalette,
  effectiveBg,
  isSafeImageUrl,
  manifestToSkin,
  parseSkin,
  resolveTheme,
  scrimVeilFor,
  skinById,
  skinToManifest,
} from './theme'
import { BUILTIN_SKINS } from './theme/skins'

const withBg = (skin: string, dark = false) => resolveTheme({ ...DEFAULT_THEME, skin, mode: dark ? 'dark' : 'light' })

describe('图片式背景皮肤 · 分派规则', () => {
  it('七张纯色皮肤没有底图，`mode: skin` 就是纯色底', () => {
    for (const id of ['default', 'night', 'ink', 'forest', 'ocean', 'warm', 'firefly']) {
      const r = withBg(id)
      expect(r.bgFromSkin, id).toBe(false)
      expect(r.image, id).toBe('')
      expect(r.bg.mode, id).toBe('skin')
      expect(r.vars['--wb-page-bg'], id).toBe(skinById(id).light.pageBg)
      expect(r.vars['--wb-bg-blur'], id).toBe('0px')
    }
  })

  it('带底图的三张：`mode: skin` 时用的是**皮肤那张图**，而且背景层真的会被画出来', () => {
    for (const id of ['paper', 'ridge', 'grid']) {
      const r = withBg(id)
      expect(r.bgFromSkin, id).toBe(true)
      expect(r.bg.mode, id).toBe('image')
      expect(r.image, id).toBe(skinById(id).light.bg?.image)
      // 底色仍然要在：图没加载出来的那一瞬看到的就是它
      expect(r.vars['--wb-page-bg'], id).toBe(skinById(id).light.pageBg)
    }
  })

  it('**用户自己设了背景就以用户的为准**，皮肤的图让位（暗色也一样）', () => {
    for (const mode of ['solid', 'gradient', 'image'] as const) {
      const cfg = {
        ...DEFAULT_THEME,
        skin: 'ridge',
        bg: { ...DEFAULT_BG, mode, image: '/api/images/mine.png' },
      }
      const r = resolveTheme(cfg)
      expect(r.bgFromSkin, mode).toBe(false)
      expect(r.bg.mode, mode).toBe(mode)
      expect(r.image, mode).toBe(mode === 'image' ? '/api/images/mine.png' : '')
    }
    // 暗色那一半也是同一条规则
    const dark = resolveTheme({
      ...DEFAULT_THEME,
      skin: 'ridge',
      mode: 'dark',
      bg: { ...DEFAULT_BG, mode: 'solid', color: '#123456' },
    })
    expect(dark.bgFromSkin).toBe(false)
    expect(dark.vars['--wb-page-bg']).toBe('#123456')
  })

  it('跟着皮肤时**不继承**用户那份里遗留的压暗/模糊值', () => {
    // 用户上次把压暗拉到头、模糊拉满，然后切成「跟随皮肤」——
    // 继承的话会得到「换了张自带图，压暗却还是上次那个数」这种说不清的结果
    const cfg = {
      ...DEFAULT_THEME,
      skin: 'grid',
      bg: { ...DEFAULT_BG, mode: 'skin' as const, scrim: 95, blur: 40, fit: 'contain' as const },
    }
    const r = resolveTheme(cfg)
    const declared = skinById('grid').light.bg!
    expect(r.bg.scrim).toBe(declared.scrim)
    expect(r.bg.blur).toBe(declared.blur)
    expect(r.bg.fit).toBe(declared.fit)
  })

  it('「恢复默认外观」回到皮肤自带的那张图——那句话的意思就是回到这套皮肤的样子', () => {
    const mine = resolveTheme({
      ...DEFAULT_THEME,
      skin: 'ridge',
      bg: { ...DEFAULT_BG, mode: 'image', image: '/api/images/mine.png' },
    })
    expect(mine.image).toBe('/api/images/mine.png')
    const back = resolveTheme({ ...DEFAULT_THEME, skin: 'ridge' })
    expect(back.image).toBe('/skins/ridge-light.svg')
    expect(back.bgFromSkin).toBe(true)
  })
})

describe('图片式背景皮肤 · 压暗怎么分布', () => {
  it('`flat` 只有一个均匀的底，没有梯度', () => {
    const r = withBg('grid')
    expect(r.bg.scrimDir).toBe('flat')
    expect(r.vars['--wb-scrim-veil']).toBe('none')
    expect(r.vars['--wb-scrim']).toBe('rgba(255, 255, 255, 0.48)')
  })

  it('`edge` 出**两个方向**的梯度（横向管侧栏、纵向管顶栏），且底子被减弱', () => {
    const r = withBg('ridge')
    expect(r.bg.scrimDir).toBe('edge')
    const veil = r.vars['--wb-scrim-veil']
    expect(veil).toContain('linear-gradient(to right')
    expect(veil).toContain('linear-gradient(to bottom')
    // 底子那一层要明显弱于滑块上的数：不减弱的话它和梯度叠起来，
    // 效果就变成「均匀压暗 + 一圈更黑」，不是边缘加重
    const base = Number(/([\d.]+)\)$/.exec(r.vars['--wb-scrim'])![1])
    expect(base).toBeLessThan(58 / 100)
    expect(base).toBeGreaterThan(0)
  })

  it('**平铺的纹理一律均匀压**：图案被压得一边深一边浅，看起来像渲染坏了', () => {
    for (const id of ['paper', 'grid']) {
      const r = withBg(id)
      expect(skinById(id).light.bg?.fit, id).toBe('repeat')
      expect(r.vars['--wb-scrim-veil'], id).toBe('none')
      expect(r.bg.scrimDir, id).toBe('flat')
    }
  })

  it('梯度在文字那一侧最重、往中间归零（不是整屏一起变暗）', () => {
    const veil = scrimVeilFor(60, false)
    const alphas = [...veil.matchAll(/rgba\(255, 255, 255, ([\d.]+)\)/g)].map((m) => Number(m[1]))
    expect(alphas.length).toBe(6) // 横向 4 停 + 纵向 2 停
    const h = alphas.slice(0, 4)
    const v = alphas.slice(4)
    // 横向：左边最重，中间两停仍留大半强度（侧栏占了屏宽约 18%，那里字最密），
    // 到 62% 归零
    expect(h[0]).toBeGreaterThan(h[1])
    expect(h[1]).toBeGreaterThan(h[2])
    expect(h[2]).toBeGreaterThan(h[3])
    expect(h[3]).toBe(0)
    expect(h[1] / h[0]).toBeGreaterThan(0.75) // 20% 处几乎没衰减
    // 纵向：上重 → 下无
    expect(v[0]).toBeGreaterThan(v[1])
    expect(v[1]).toBe(0)
    // 侧栏是整条竖边，比一行顶栏更需要压
    expect(h[0]).toBeGreaterThan(v[0])
  })

  it('暗色压黑、亮色压白', () => {
    expect(scrimVeilFor(60, true)).toContain('rgba(0, 0, 0,')
    expect(scrimVeilFor(60, false)).toContain('rgba(255, 255, 255,')
  })
})

describe('图片式背景皮肤 · 数据这一层把关', () => {
  const base = { id: 'mine', label: '我的', accent: '#4a6b8a' }

  it('底图地址只放行站内 `/skins/`、图片接口与 http(s)', () => {
    for (const ok of ['/skins/a.svg', '/api/images/a.png', 'https://x.test/a.jpg']) {
      expect(isSafeImageUrl(ok), ok).toBe(true)
      expect(parseSkin({ ...base, light: { bg: { image: ok } } }).ok, ok).toBe(true)
    }
    for (const no of [
      'javascript:alert(1)',
      // **`data:` 也不放行**：皮肤是数据、可能来自别人的一份 JSON，
      // 那种值会进 `url()` 且完全不可审阅
      'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
      '/etc/passwd',
      'skins/a.svg',
      '//evil.test/a.png',
      '',
    ]) {
      expect(isSafeImageUrl(no), no).toBe(false)
      expect(parseSkin({ ...base, light: { bg: { image: no } } }).ok, no).toBe(false)
    }
  })

  it('压暗有**下限**：底图上的字能不能看清，不该由作者记不记得压一层决定', () => {
    const got = parseSkin({ ...base, light: { bg: { image: '/skins/a.svg', scrim: 0 } } })
    expect(got.ok).toBe(true)
    if (got.ok) expect(got.value.light?.bg?.scrim).toBe(MIN_SKIN_SCRIM)
    // 上限仍然夹得住
    const hi = parseSkin({ ...base, light: { bg: { image: '/skins/a.svg', scrim: 200 } } })
    if (hi.ok) expect(hi.value.light?.bg?.scrim).toBe(95)
  })

  it('平铺的纹理**强制不模糊**，并且方向强制均匀', () => {
    const got = parseSkin({
      ...base,
      light: { bg: { image: '/skins/a.svg', fit: 'repeat', blur: 30, scrimDir: 'edge' } },
    })
    expect(got.ok).toBe(true)
    if (!got.ok) return
    expect(got.value.light?.bg?.blur).toBe(0)
    // 参数里写 edge 也留不住：平铺 + 边缘加重在**渲染出来之后**是矛盾的，
    // 所以在数据这一层就归一，而不是等到画的时候再判一次
    const skin = resolveTheme({ ...DEFAULT_THEME, skin: 'grid' })
    expect(skin.bg.scrimDir).toBe('flat')
  })

  it('认不出的 `fit` / `scrimDir` 退回默认，不整条拒绝（它们不是安全问题，只是参数）', () => {
    const got = parseSkin({ ...base, light: { bg: { image: '/skins/a.svg', fit: 'stretch', scrimDir: 'weird' } } })
    expect(got.ok).toBe(true)
    if (got.ok) {
      expect(got.value.light?.bg?.fit).toBe('cover')
      expect(got.value.light?.bg?.scrimDir).toBe('edge')
    }
  })

  it('**每一张自带底图的内置皮肤都声明了压暗**（产品自己的图也不许裸奔）', () => {
    const withImages = BUILTIN_SKINS.flatMap((s) => [s.light, s.dark]).filter((v) => v.bg)
    // 数的是「有几张自带底图」而不是「有几套皮肤」：写死一个数是为了**加皮肤时
    // 这一行会红一次**，逼着人确认新那张图的压暗与地址都交代过了。
    expect(withImages.length).toBe(8) // 四套皮肤（素纸/远山/格纸/极光）× 亮暗
    for (const v of withImages) {
      expect(v.bg!.scrim).toBeGreaterThanOrEqual(MIN_SKIN_SCRIM)
      expect(isSafeImageUrl(v.bg!.image)).toBe(true)
    }
  })

  it('**带图的内置皮肤都给了面板层**——不然「图片式皮肤」仍然只是换壁纸', () => {
    // 这一条钉的是这一轮升级的**目的**：有底图的皮肤该让面板跟着透，
    // 否则底图只是铺在卡片后面，观感上仍然是「换了一张壁纸」。
    // 素纸与格纸是**平铺纹理**，压在实心卡片下面看不见，所以那两套没给——
    // 这是有意的例外，写在这里免得下次有人以为漏了。
    const glassy = BUILTIN_SKINS.filter((s) => s.light.bg && s.light.surfaces.glass < 100)
    const ids = glassy.map((s) => s.id).sort()
    expect(ids).toEqual(['aurora', 'ridge'])
    for (const s of glassy) {
      expect(s.dark.surfaces.glass, `${s.id} 的暗色没跟着透`).toBeLessThan(100)
      expect(s.light.surfaces.chromeGlass, `${s.id} 的壳该比面板更透`).toBeLessThan(
        s.light.surfaces.glass
      )
    }
  })

  it('导出再导入把底图原样带过去（底图是皮肤的一部分，不该在导出时丢掉）', () => {
    const got = parseSkin({
      ...base,
      light: { bg: { image: '/skins/a.svg', fit: 'repeat', scrim: 40, scrimDir: 'edge', blur: 9 } },
    })
    expect(got.ok).toBe(true)
    if (!got.ok) return
    const skin = manifestToSkin(got.value)
    const declared = skin.light.bg!
    // 平铺 → 模糊被归一成 0（见上面那条用例）。
    // 用 `toMatchObject` 而不是 `toEqual`：解析出来的底图还带着取景那几项的
    // **显式默认值**（居中 / 原样 / 不透明），而它们不是这条用例要断言的东西。
    expect(declared).toMatchObject({
      image: '/skins/a.svg',
      fit: 'repeat',
      scrim: 45,
      scrimDir: 'edge',
      blur: 0,
    })

    // **往返稳定**才是这条用例真正钉的东西：导出时那些默认值会被省掉
    // （`compactBg`），再导入时又被填回来——两次的形状必须逐字段一样。
    const back = parseSkin(JSON.parse(JSON.stringify(skinToManifest(skin))))
    expect(back.ok).toBe(true)
    if (back.ok) expect(manifestToSkin(back.value).light.bg).toEqual(declared)
  })

  it('取景与色调也跟着底图来回：焦点 / 缩放 / 不透明度 / 色调', () => {
    const got = parseSkin({
      ...base,
      light: {
        bg: {
          image: '/skins/a.svg',
          fit: 'cover',
          scrim: 60,
          scrimDir: 'edge',
          blur: 0,
          focusX: 30,
          focusY: 72,
          zoom: 150,
          opacity: 80,
          tint: { color: '#102030', alpha: 35 },
        },
      },
    })
    expect(got.ok).toBe(true)
    if (!got.ok) return
    const skin = manifestToSkin(got.value)
    expect(skin.light.bg).toMatchObject({
      focusX: 30,
      focusY: 72,
      zoom: 150,
      opacity: 80,
      tint: { color: '#102030', alpha: 35 },
    })
    // 导出时这五项**不是默认值**，所以必须写出去——省掉的话换台机器打开就变成居中了
    const out = skinToManifest(skin)
    expect(out.light?.bg).toMatchObject({
      focusX: 30,
      focusY: 72,
      zoom: 150,
      opacity: 80,
      tint: { color: '#102030', alpha: 35 },
    })
  })

  it('取景的取值域与「认不出就当默认」：越界的夹回来，坏类型不炸', () => {
    const got = parseSkin({
      ...base,
      light: {
        bg: {
          image: '/skins/a.svg',
          fit: 'cover',
          scrim: 60,
          scrimDir: 'edge',
          blur: 0,
          focusX: 999,
          zoom: -50,
          opacity: 'x',
        },
      },
    })
    expect(got.ok).toBe(true)
    if (!got.ok) return
    const bg = manifestToSkin(got.value).light.bg!
    expect(bg.focusX).toBe(100) // 夹到上限，不是丢掉
    expect(bg.zoom).toBe(100) // 缩放下限就是「原样」：不允许缩到铺不满
    expect(bg.opacity).toBe(100) // 给不出数就用默认，不是夹成 0（那等于把图藏了）
  })
})

describe('强调色推导：`600` 是实底按钮那一档，白字必须压得住', () => {
  /** WCAG 相对亮度。**故意不复用生产代码里的那份**：测试要能独立地量出它算错了。 */
  function lum(hex: string): number {
    const n = parseInt(hex.slice(1), 16)
    const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
      const s = v / 255
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
    })
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
  }
  function channelsToHex(c: string): string {
    const [r, g, b] = c.split(' ').map(Number)
    return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')
  }
  const onWhite = (c: string) => 1.05 / (lum(channelsToHex(c)) + 0.05)

  it('一批**淡色**强调色也压得住白字——这是以前坏掉的那条路', () => {
    // #fde047 是淡黄：固定「压 14%」得到的是 #d9c03d，白字压上去只有 1.6:1。
    // 用户挑这类颜色当强调色，以前的实底按钮上的字是糊的。
    for (const pale of ['#fde047', '#fef08a', '#67e8f9', '#bef264', '#fbcfe8', '#f5d0fe', '#a7f3d0']) {
      expect(onWhite(accentPalette(pale)['600']), pale).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('深色强调色**不受影响**（那一路本来就是好的，不该被顺手改口味）', () => {
    // 亮色基底下压 14% 早就够白字了 → 那个循环一次都不进，出来的还是老值。
    // 这两个数改动前后一模一样，是「这次没顺手改别人的口味」的证据。
    expect(accentPalette('#7c3aed')['600']).toBe('107 50 204')
    expect(accentPalette('#b45309')['600']).toBe('155 71 8')
  })

  it('整条尾部单调变深，不会出现「700 比 600 还浅」', () => {
    for (const c of ['#fde047', '#7c3aed', '#0d9488', '#f5f5f5']) {
      const p = accentPalette(c)
      const l = ['600', '700', '800', '900', '950'].map((s) => lum(channelsToHex(p[s])))
      for (let i = 1; i < l.length; i++) {
        expect(l[i], `${c} 的第 ${i} 档`).toBeLessThan(l[i - 1])
      }
    }
  })

  it('500 仍然是用户填的那个色号本身', () => {
    expect(accentPalette('#fde047')['500']).toBe('253 224 71')
  })

  it('`effectiveBg` 是纯函数：同样的入参给同样的结果', () => {
    const v = skinById('ridge').light
    expect(effectiveBg(DEFAULT_THEME, v)).toEqual(effectiveBg(DEFAULT_THEME, v))
    expect(effectiveBg(DEFAULT_THEME, v).image).toBe('/skins/ridge-light.svg')
  })
})
