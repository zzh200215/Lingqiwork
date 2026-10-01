// 主题系统：**纯函数与 DOM 写入**。这一层不渲染任何东西，所以能钉死那些
// 「换肤看起来对了、其实某几个变量没写」的问题——那类 bug 在界面上表现为
// 「某个角落还是紫色」，肉眼极难发现，而这里一行断言就能钉住。
import { afterEach, describe, expect, it } from 'vitest'

import {
  DEFAULT_BG,
  DEFAULT_THEME,
  STORE_KEY,
  accentPalette,
  applyTheme,
  bootTheme,
  loadTheme,
  normalizeHex,
  parseTheme,
  prefersDark,
  resolveColorMode,
  resolveSkin,
  resolveTheme,
  saveDefaultTheme,
  saveTheme,
  scrimFor,
} from './theme'
import { BUILTIN_SKIN_IDS, BUILTIN_SKINS, type Skin } from './theme/skins'
import { PANEL_FLOOR } from './theme/surfaces'

/** 这个文件盯的是**内置那六个**皮肤（导入的皮肤归 `theme.registry.test.ts`）。
 *  取的是内置清单的快照，而不是 `listSkins()`——后者是活的，会带上本机装过的皮肤，
 *  那样「加了一个皮肤，某个断言就变了」会变成一件说不清的事。 */
const SKINS: Record<string, Skin> = Object.fromEntries(BUILTIN_SKINS.map((s) => [s.id, s]))
const SKIN_IDS = BUILTIN_SKIN_IDS

afterEach(() => {
  localStorage.clear()
  document.documentElement.removeAttribute('style')
  document.documentElement.removeAttribute('data-wb-bg')
  document.documentElement.removeAttribute('data-wb-skin')
  document.documentElement.classList.remove('dark')
})

describe('颜色推导', () => {
  it('hex 认得出三种写法，认不出的返回 null（不抛异常）', () => {
    expect(normalizeHex('#7c3aed')).toBe('#7c3aed')
    expect(normalizeHex('7C3AED')).toBe('#7c3aed')
    expect(normalizeHex('#abc')).toBe('#aabbcc')
    expect(normalizeHex('rgb(1,2,3)')).toBeNull()
    expect(normalizeHex('')).toBeNull()
    expect(normalizeHex('#12345')).toBeNull()
  })

  it('一个强调色推得出 11 档，且 500 就是它自己', () => {
    const p = accentPalette('#0d9488')
    expect(Object.keys(p)).toHaveLength(11)
    expect(p['500']).toBe('13 148 136')
    // 浅色端往白走、深色端往黑走——顺序反了就是「浅色 chip 比实底按钮还深」
    const lum = (s: string) => s.split(' ').reduce((a, b) => a + Number(b), 0)
    const steps = ['50', '100', '200', '300', '400', '500', '600', '700', '800', '900', '950']
    const lums = steps.map((s) => lum(p[s]))
    for (let i = 1; i < lums.length; i += 1) expect(lums[i]).toBeLessThan(lums[i - 1])
  })
})

describe('皮肤表', () => {
  it('每个皮肤两套值都齐（亮 / 暗各 11 档中性阶 + 11 档强调色 + 底色 + 图表色）', () => {
    for (const id of SKIN_IDS) {
      const s = SKINS[id]
      expect(s, `SKINS 里没有 ${id}`).toBeTruthy()
      expect(s.id).toBe(id)
      for (const v of [s.light, s.dark]) {
        expect(Object.keys(v.neutral)).toHaveLength(11)
        expect(Object.keys(v.accentScale)).toHaveLength(11)
        expect(v.pageBg).toMatch(/^#[0-9a-f]{6}$/)
        expect(v.accent).toMatch(/^#[0-9a-f]{6}$/)
        expect(v.chart).toHaveLength(5)
      }
    }
  })

  it('SKIN_IDS 与 SKINS 一一对应——少一个就是「选择界面里少了一张卡」', () => {
    expect([...SKIN_IDS].sort()).toEqual(Object.keys(SKINS).sort())
    expect(new Set(SKIN_IDS).size).toBe(SKIN_IDS.length)
  })

  it('认不出的皮肤名退回默认，**不抛异常也不返回空**', () => {
    expect(resolveSkin('nope').id).toBe('default')
    expect(resolveSkin('').id).toBe('default')
  })

  it('默认皮肤的两套中性阶就是改动前 Tailwind 的值——没动过设置的人看到的应该还是原来那一版', () => {
    expect(SKINS.default.light.neutral['900']).toBe('23 23 23')
    expect(SKINS.default.light.accentScale['600']).toBe('124 58 237')
    expect(SKINS.default.dark.neutral['900']).toBe('24 24 27')
    expect(SKINS.default.dark.accentScale['400']).toBe('167 139 250')
    expect(SKINS.default.light.pageBg).toBe('#ffffff')
    expect(SKINS.default.dark.pageBg).toBe('#0a0a0a')
  })
})

describe('parseTheme / 持久化', () => {
  it('空对象 → 全默认', () => {
    // 期望值显式摊开 `bg`：`parseTheme` 每次都新建一个对象，直接比 `DEFAULT_THEME`
    // 会因为「同一个 bg 引用」而在将来某次改动后变成一条假的失败
    const want = { ...DEFAULT_THEME, bg: { ...DEFAULT_BG } }
    expect(parseTheme({})).toEqual(want)
    expect(parseTheme(null)).toEqual(want)
    expect(parseTheme('nonsense')).toEqual(want)
  })

  it('**逐字段兜底**：坏的那个字段用默认，好的照旧（整份丢掉会连背景图一起清掉）', () => {
    const t = parseTheme({
      skin: 'nope',
      mode: 'yes',
      dark: 'yes',
      accent: 'not-a-color',
      bg: { mode: 'image', image: '/api/images/img-1.png', scrim: 999, blur: -5, angle: 'x' },
    })
    expect(t.skin).toBe('default') // 认不出的皮肤
    expect(t.mode).toBe('light') // `mode` 与旧字段 `dark` 都不是合法值 → 默认
    expect(t.accent).toBe('') // 认不出的颜色 → 跟随皮肤
    expect(t.bg.mode).toBe('image')
    expect(t.bg.image).toBe('/api/images/img-1.png') // **背景图保住了**
    expect(t.bg.scrim).toBe(95) // 越界夹回
    expect(t.bg.blur).toBe(0)
    expect(t.bg.angle).toBe(DEFAULT_BG.angle)
  })

  it('存 → 读回到同一份', () => {
    const cfg = {
      ...DEFAULT_THEME,
      skin: 'forest',
      mode: 'dark' as const,
      accent: '#0d9488',
      bg: { ...DEFAULT_BG, mode: 'gradient' as const, from: '#fff', to: '#000', angle: 45 },
    }
    saveTheme(cfg)
    expect(loadTheme()).toEqual(cfg)
  })

  it('localStorage 里是垃圾时退回默认（隐私模式 / 手改坏 / 别的版本）', () => {
    localStorage.setItem(STORE_KEY, '{oops')
    expect(loadTheme()).toEqual(DEFAULT_THEME)
  })

  it('迁移旧键 `theme`：换肤上线前那个亮暗按钮存的值还算数', () => {
    localStorage.setItem('theme', 'dark')
    expect(loadTheme().mode).toBe('dark')
    // 一旦有了新键，旧键就不再参与
    saveTheme({ ...DEFAULT_THEME, mode: 'light' })
    expect(loadTheme().mode).toBe('light')
  })

  it('恢复默认：写回默认值（不是删记录——持久化 effect 会立刻把它写回来）', () => {
    saveTheme({ ...DEFAULT_THEME, skin: 'warm' })
    const back = saveDefaultTheme()
    expect(back).toEqual(DEFAULT_THEME)
    expect(loadTheme()).toEqual(DEFAULT_THEME)
  })

  it('面板层的覆盖是一张表：拨过哪几项就记哪几项', () => {
    const t = parseTheme({ surfaces: { glass: 62, blur: 9 } })
    expect(t.surfaces).toEqual({ glass: 62, blur: 9 })
    // 没拨过的项**不在表里**——「没拨过」与「拨成了某个数」是两件事，
    // 界面靠这个区别决定每一项的 ↺ 显不显示。
    expect('sidebarGlass' in t.surfaces).toBe(false)
  })

  it('**旧版本的两个标量认得出**：`glass` / `blur` 折叠进这张表', () => {
    // 这一条是升级路径，不是兼容洁癖：读不出来就等于用户升级那天
    // 他拨过的通透度被悄悄改回皮肤那一档。
    const t = parseTheme({ skin: 'forest', glass: 44, blur: 6 })
    expect(t.surfaces).toEqual({ glass: 44, blur: 6 })
    expect(t.skin).toBe('forest') // 同一份记录里的其余设置照旧

    // `null` 是旧版「跟随皮肤」的写法 = 这一项没拨过
    expect(parseTheme({ glass: null, blur: null }).surfaces).toEqual({})
    // 表里已经有了就以表为准，旧字段不再参与
    expect(parseTheme({ surfaces: { glass: 20 }, glass: 90 }).surfaces.glass).toBe(20)
  })

  it('覆盖表里的坏值只丢那一项，且超范围夹回（不是整份设置退回默认）', () => {
    const t = parseTheme({
      skin: 'ink',
      surfaces: { glass: 'x', blur: 400, shadow: -3, sidebarGlass: 71, nope: 1 },
    })
    expect(t.skin).toBe('ink')
    expect(t.surfaces).toEqual({ blur: 24, shadow: 0, sidebarGlass: 71 })
  })

  it('`glass: 0` 是一次明确的表态，不该被当成「没拨过」', () => {
    // 「要全透」与「没设过」在这件事上是两回事：前者是 55%（下限），
    // 后者是皮肤那一档。`0` 被真值判断吃掉的话，这条就反了。
    expect(parseTheme({ glass: 0 }).surfaces).toEqual({ glass: 0 })
  })
})

describe('明暗档位（亮 / 暗 / 跟随系统）与 v1→v2 迁移', () => {
  it('`system` 跟着传进来的系统偏好走，且**不写死**在配置里', () => {
    expect(resolveColorMode('light', true)).toBe(false) // 系统暗，用户要亮 → 亮
    expect(resolveColorMode('dark', false)).toBe(true) // 系统亮，用户要暗 → 暗
    expect(resolveColorMode('system', true)).toBe(true)
    expect(resolveColorMode('system', false)).toBe(false)
  })

  it('同一份 mode=system 的设置，系统暗就是暗、系统亮就是亮（换的是整套值，不只是 dark 类）', () => {
    const cfg = { ...DEFAULT_THEME, skin: 'ocean', mode: 'system' as const }
    const onDark = resolveTheme(cfg, true)
    const onLight = resolveTheme(cfg, false)
    expect(onDark.dark).toBe(true)
    expect(onLight.dark).toBe(false)
    expect(onDark.vars['--wb-page-bg']).toBe(SKINS.ocean.dark.pageBg)
    expect(onLight.vars['--wb-page-bg']).toBe(SKINS.ocean.light.pageBg)
    // 压暗层也跟着翻：同一张背景图在暗色下压黑、亮色下压白
    expect(onDark.vars['--wb-scrim']).toBe('rgba(0, 0, 0, 0.62)')
    expect(onLight.vars['--wb-scrim']).toBe('rgba(255, 255, 255, 0.62)')
  })

  it('v1 的 `dark: boolean` 认得出来——这是 `STORE_VERSION` 存在的理由', () => {
    // v1 那份存下来的形状（`version: 1` + `dark`）
    expect(parseTheme({ version: 1, skin: 'forest', dark: true, accent: '', bg: {} }).mode).toBe('dark')
    expect(parseTheme({ version: 1, skin: 'forest', dark: false, accent: '', bg: {} }).mode).toBe('light')
    // v2 的 `mode` 优先于同在一份里的旧字段（迁移中途写入的半新半旧对象）
    expect(parseTheme({ mode: 'system', dark: true }).mode).toBe('system')
    // 两个都没有 → 默认
    expect(parseTheme({ skin: 'forest' }).mode).toBe(DEFAULT_THEME.mode)
  })

  it('出厂明暗是**亮色**而不是跟随系统：升级不该悄悄改掉用户的屏幕', () => {
    expect(DEFAULT_THEME.mode).toBe('light')
  })

  it('`prefersDark()` 读不到媒体查询就返回 false，**不抛异常**（jsdom / 老 WebView）', () => {
    expect(() => prefersDark()).not.toThrow()
    expect(typeof prefersDark()).toBe('boolean')
  })
})

describe('resolveTheme → CSS 变量', () => {
  it('中性阶与强调色阶都写进 `--wb-*`，且 fuchsia 跟强调色同值', () => {
    const r = resolveTheme({ ...DEFAULT_THEME, skin: 'forest' })
    expect(r.vars['--wb-neutral-900']).toBe(SKINS.forest.light.neutral['900'])
    expect(r.vars['--wb-violet-600']).toBe(SKINS.forest.light.accentScale['600'])
    // 双色渐变（logo / 新对话按钮）因此变成单色——森林皮肤上不该留一个紫 logo
    expect(r.vars['--wb-fuchsia-600']).toBe(r.vars['--wb-violet-600'])
    expect(r.vars['--wb-page-bg']).toBe(SKINS.forest.light.pageBg)
  })

  it('亮暗切换换的是另一套值，不是把亮色反相', () => {
    const light = resolveTheme({ ...DEFAULT_THEME, skin: 'ocean' })
    const dark = resolveTheme({ ...DEFAULT_THEME, skin: 'ocean', mode: 'dark' })
    expect(dark.vars['--wb-page-bg']).toBe(SKINS.ocean.dark.pageBg)
    expect(dark.vars['--wb-neutral-900']).not.toBe(light.vars['--wb-neutral-900'])
    expect(dark.dark).toBe(true)
  })

  it('自定义强调色覆盖皮肤的色阶，但**不碰**中性阶', () => {
    const r = resolveTheme({ ...DEFAULT_THEME, accent: '#b45309' })
    expect(r.customAccent).toBe(true)
    expect(r.accent).toBe('#b45309')
    expect(r.vars['--wb-violet-500']).toBe('180 83 9')
    expect(r.vars['--wb-violet-600']).not.toBe(SKINS.default.light.accentScale['600'])
    expect(r.vars['--wb-neutral-900']).toBe(SKINS.default.light.neutral['900'])
    // 图表首色跟着强调色——不然换了色，图还是紫的
    expect(r.vars['--wb-chart-0']).toBe('#b45309')
  })

  it('空强调色 = 跟随皮肤（不是「黑色」）', () => {
    const r = resolveTheme({ ...DEFAULT_THEME, accent: '' })
    expect(r.customAccent).toBe(false)
    expect(r.accent).toBe(SKINS.default.light.accent)
  })

  it('背景图只在 mode=image 时生效，且只放行站内与 http(s)', () => {
    const base = { ...DEFAULT_THEME }
    expect(resolveTheme({ ...base, bg: { ...DEFAULT_BG, image: '/api/images/a.png' } }).image).toBe('')
    const img = { ...DEFAULT_BG, mode: 'image' as const }
    expect(resolveTheme({ ...base, bg: { ...img, image: '/api/images/a.png' } }).image).toBe(
      '/api/images/a.png'
    )
    expect(resolveTheme({ ...base, bg: { ...img, image: 'https://x.test/a.jpg' } }).image).toBe(
      'https://x.test/a.jpg'
    )
    expect(resolveTheme({ ...base, bg: { ...img, image: 'javascript:alert(1)' } }).image).toBe('')
    expect(resolveTheme({ ...base, bg: { ...img, image: 'data:image/png;base64,AAA' } }).image).toBe('')
  })

  it('压暗层亮色压白、暗色压黑，且随比例走', () => {
    expect(scrimFor(0, false)).toBe('rgba(255, 255, 255, 0)')
    expect(scrimFor(60, false)).toBe('rgba(255, 255, 255, 0.6)')
    expect(scrimFor(60, true)).toBe('rgba(0, 0, 0, 0.6)')
    expect(scrimFor(999, true)).toBe('rgba(0, 0, 0, 0.95)') // 夹回上限
  })

  it('**分区域：五个区域各自出一个变量**，没写的那几项跟着面板走', () => {
    const r = resolveTheme({
      ...DEFAULT_THEME,
      skin: 'ridge', // 内置皮肤里唯一带 surfaces 的（面板 86 / 壳 76 / 模糊 8）
    })
    // 这几个变量是**不透明度**（0–1 的无单位数），下游写进 `rgb(R G B / α)`
    expect(r.vars['--wb-surface-alpha']).toBe('0.86')
    expect(r.vars['--wb-sidebar-alpha']).toBe('0.76')
    expect(r.vars['--wb-topbar-alpha']).toBe('0.76')
    // 输入框与浮层没写 → 跟着面板那一档，各自再过自己的地板。
    // 浮层那一档**地板比皮肤给的还高**（95 > 86），所以它是 95——这条不是巧合：
    // 浮层必须压得住底下的字，一份「面板 86」的皮肤不会让浮层也变成 86。
    expect(r.vars['--wb-field-alpha']).toBe('0.86')
    expect(r.vars['--wb-float-alpha']).toBe('0.95')
    expect(r.vars['--wb-surface-blur']).toBe('8px')
  })

  it('单拨一个区域**只动那一个变量**——这就是「分区域」在 DOM 上的样子', () => {
    const base = { ...DEFAULT_THEME, skin: 'ridge' }
    const before = resolveTheme(base)
    const r = resolveTheme({ ...base, surfaces: { sidebarGlass: 30 } })
    expect(r.vars['--wb-sidebar-alpha']).toBe('0.3')
    // 顶栏、卡片、输入框、浮层一个都没动——只改一个区域是这件事的全部意义
    expect(r.vars['--wb-topbar-alpha']).toBe(before.vars['--wb-topbar-alpha'])
    expect(r.vars['--wb-surface-alpha']).toBe(before.vars['--wb-surface-alpha'])
    expect(r.vars['--wb-field-alpha']).toBe(before.vars['--wb-field-alpha'])
  })

  it('拖动主旋钮时，**没单独拨过的区域跟着走**（旧版那根滑块的手感留着）', () => {
    const r = resolveTheme({ ...DEFAULT_THEME, skin: 'ridge', surfaces: { glass: 40 } })
    expect(r.vars['--wb-surface-alpha']).toBe('0.55') // 卡片地板 55
    expect(r.vars['--wb-sidebar-alpha']).toBe('0.4')
    expect(r.vars['--wb-field-alpha']).toBe('0.8') // 输入框地板 80
    expect(r.vars['--wb-float-alpha']).toBe('0.95') // 浮层地板 95
  })

  it('皮肤把输入框单独定死时，**主旋钮不吃掉它**', () => {
    const skin = SKINS.ridge.light
    const r = resolveTheme({
      ...DEFAULT_THEME,
      skin: 'ridge',
      surfaces: { glass: skin.surfaces.glass, fieldGlass: 100 },
    })
    expect(r.vars['--wb-field-alpha']).toBe('1')
    expect(r.vars['--wb-float-alpha']).toBe(String(Math.max(PANEL_FLOOR.float, skin.surfaces.floatGlass) / 100))
  })
})

describe('applyTheme / bootTheme', () => {
  it('写 `dark` 类、`data-wb-*` 与内联变量', () => {
    const r = resolveTheme({ ...DEFAULT_THEME, skin: 'night', mode: 'dark' })
    const vars = applyTheme(r)
    const root = document.documentElement
    expect(root.classList.contains('dark')).toBe(true)
    expect(root.dataset.wbSkin).toBe('night')
    expect(root.dataset.wbBg).toBe('skin')
    expect(root.style.colorScheme).toBe('dark')
    expect(root.style.getPropertyValue('--wb-violet-600')).toBe(vars['--wb-violet-600'])
    expect(root.style.getPropertyValue('--wb-page-bg')).toBe(SKINS.night.dark.pageBg)
  })

  it('切回亮色会把 dark 类摘掉（不是再叠一层）', () => {
    applyTheme(resolveTheme({ ...DEFAULT_THEME, mode: 'dark' }))
    applyTheme(resolveTheme({ ...DEFAULT_THEME, mode: 'light' }))
    expect(document.documentElement.classList.contains('dark')).toBe(false)
    expect(document.documentElement.style.colorScheme).toBe('light')
  })

  it('bootTheme 在没有任何存储时也写一份完整变量——首帧不该是「没上色」的', () => {
    const cfg = bootTheme()
    expect(cfg).toEqual(DEFAULT_THEME)
    const root = document.documentElement
    for (const step of ['50', '100', '500', '900', '950']) {
      expect(root.style.getPropertyValue(`--wb-neutral-${step}`)).not.toBe('')
      expect(root.style.getPropertyValue(`--wb-violet-${step}`)).not.toBe('')
    }
    expect(root.style.getPropertyValue('--wb-chart-5')).not.toBe('')
  })
})
