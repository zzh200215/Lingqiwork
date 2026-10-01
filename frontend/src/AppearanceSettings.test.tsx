// 设置 → 外观：换肤面板。
//
// 这一屏的规矩是「**点一下就生效、不用保存**」，所以测的不是「表单填对了」，
// 而是「点完之后 DOM 上的主题真的变了」——面板与全站外观共用 `ThemeProvider`
// 这一份状态，测到 DOM 就等于测到了全站。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

vi.mock('./api', () => ({
  api: {
    listImages: vi.fn(),
    uploadImage: vi.fn(),
    getTheme: vi.fn(),
    putTheme: vi.fn(),
  },
}))

// 取色那一半在 jsdom 里跑不了（没有 canvas，图片也不会 load），所以只把
// `skinFromImage` 换掉，**纯函数那部分留着真的**——`medianCut` 那些由
// `theme.extract.test.ts` 管，这里管的是「点了上传之后界面做了什么」。
vi.mock('./theme/extract', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./theme/extract')>()
  return { ...actual, skinFromImage: vi.fn() }
})

import { api } from './api'
import AppearanceSettings from './AppearanceSettings'
import { ThemeProvider } from './ThemeProvider'
import { DEFAULT_THEME, installUserSkins, loadTheme, loadUserSkins, userSkinManifests } from './theme'
import { BUILTIN_SKINS } from './theme/skins'
import { parseSkin } from './theme/manifest'
import { skinFromImage } from './theme/extract'
import { buildExport, serializeExport } from './theme/transfer'

/** 一份「从图里做出来」的皮肤 + 取色报告。形状与 `skinFromImage` 的返回值一致。 */
const PHOTO_URL = '/api/images/img-20261001-120000-abcdef.png'
function mockPhoto(
  opts: {
    okLight?: boolean
    okDark?: boolean
    chromatic?: boolean
    ratioLight?: number
    ratioDark?: number
    glass?: number
    mode?: 'light' | 'dark'
  } = {}
) {
  const bg = { image: PHOTO_URL, fit: 'cover' as const, scrimDir: 'edge' as const, blur: 0 }
  vi.mocked(skinFromImage).mockResolvedValue({
    ok: true,
    value: {
      manifest: {
        format: 1,
        id: 'photo-abc',
        label: '海边',
        hint: '从「海边.jpg」取的色',
        accent: '#c2703a',
        light: { bg: { ...bg, scrim: 72, tint: { color: '#e8dccf', alpha: 18 } }, surfaces: { glass: 78, blur: 6 } },
        dark: { bg: { ...bg, scrim: 45, tint: { color: '#171310', alpha: 24 } }, surfaces: { glass: 78, blur: 6 } },
      },
      report: {
        accent: '#c2703a',
        swatches: ['#c2703a', '#2b3a4a', '#d8cbb8'],
        mean: '#8a7a6a',
        chromatic: opts.chromatic ?? true,
        scrimLight: 72,
        scrimDark: 45,
        okLight: opts.okLight ?? true,
        okDark: opts.okDark ?? true,
        // 默认给一个「差一点」的比值：够不到 AA 但看不出差别那一档
        ratioLight: opts.ratioLight ?? (opts.okLight === false ? 4.4 : 5.2),
        ratioDark: opts.ratioDark ?? 5.6,
        // 面板层与色调也是从图里算出来的——「一张图 → 一整套皮肤」的那一半
        glass: opts.glass ?? 78,
        blur: 6,
        tintLight: { color: '#e8dccf', alpha: 18 },
        tintDark: { color: '#171310', alpha: 24 },
        mode: opts.mode ?? 'light',
        spread: 0.42,
        detail: 0.041,
      },
    },
  })
}

/** 只对内置皮肤断言（导入的皮肤由注册表那一份测试管）。 */
const SKINS = Object.fromEntries(BUILTIN_SKINS.map((s) => [s.id, s]))

function renderPanel() {
  return render(
    <ThemeProvider>
      <AppearanceSettings />
    </ThemeProvider>
  )
}

const root = () => document.documentElement

beforeEach(() => {
  vi.mocked(api.listImages).mockResolvedValue({ config: {} as never, images: [] })
  vi.mocked(api.uploadImage).mockResolvedValue({
    name: 'img-20261001-120000-abcdef.png',
    url: '/api/images/img-20261001-120000-abcdef.png',
    bytes: 1024,
  })
  // 后端没有副本：每次从「本机从没设置过」开始，测试之间互不影响
  vi.mocked(api.getTheme).mockResolvedValue({ theme: null })
  vi.mocked(api.putTheme).mockResolvedValue({ theme: null as never })
})

afterEach(() => {
  cleanup()
  localStorage.clear()
  // 皮肤注册表是**模块级的活状态**：它不在 React 里，`localStorage.clear()` 也清不掉
  // 已经装进内存的那几个。不清它的话，上一个用例导入的皮肤会活到下一个用例里，
  // 表现为「单独跑这个文件能过、一起跑就挂」。
  loadUserSkins()
  root().removeAttribute('style')
  root().removeAttribute('data-wb-bg')
  root().removeAttribute('data-wb-skin')
  root().removeAttribute('data-wb-mode')
  root().classList.remove('dark')
})

describe('外观 · 皮肤', () => {
  it('六个皮肤都摆得出来，默认那个是选中的', () => {
    renderPanel()
    for (const id of Object.keys(SKINS)) {
      expect(screen.getByTitle(SKINS[id].hint), `没有 ${id} 那张卡`).toBeTruthy()
    }
    expect(screen.getByTitle(SKINS.default.hint).getAttribute('aria-pressed')).toBe('true')
  })

  it('点一张皮肤卡：选中态、localStorage、DOM 变量**三处同时变**', () => {
    renderPanel()
    fireEvent.click(screen.getByTitle(SKINS.forest.hint))

    expect(screen.getByTitle(SKINS.forest.hint).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByTitle(SKINS.default.hint).getAttribute('aria-pressed')).toBe('false')
    expect(loadTheme().skin).toBe('forest')
    expect(root().dataset.wbSkin).toBe('forest')
    expect(root().style.getPropertyValue('--wb-violet-600')).toBe(
      SKINS.forest.light.accentScale['600']
    )
  })

  it('亮暗是**独立的一维**：切暗色不换皮肤，且用的是同一皮肤的另一套值', () => {
    renderPanel()
    fireEvent.click(screen.getByTitle(SKINS.forest.hint))
    fireEvent.click(document.querySelector('[data-appearance-mode="dark"]')!)

    expect(loadTheme()).toMatchObject({ skin: 'forest', mode: 'dark' })
    expect(root().classList.contains('dark')).toBe(true)
    expect(root().style.getPropertyValue('--wb-violet-600')).toBe(
      SKINS.forest.dark.accentScale['600']
    )
    expect(screen.getByTitle(SKINS.forest.hint).getAttribute('aria-pressed')).toBe('true')
  })
})

describe('外观 · 强调色', () => {
  it('填一个自定义色 → 整条色阶由它推导，中性阶不动', () => {
    renderPanel()
    const input = document.querySelector('input[data-appearance-accent]') as HTMLInputElement
    fireEvent.change(input, { target: { value: '#b45309' } })

    expect(loadTheme().accent).toBe('#b45309')
    expect(root().style.getPropertyValue('--wb-violet-500')).toBe('180 83 9')
    expect(root().style.getPropertyValue('--wb-neutral-900')).toBe(
      SKINS.default.light.neutral['900']
    )
    // 推导出的色阶要在面板上看得见（11 档）
    expect(document.querySelectorAll('[title^="50 ·"], [title^="950 ·"]').length).toBe(2)
  })

  it('「跟随皮肤」把覆盖清掉', () => {
    renderPanel()
    const input = document.querySelector('input[data-appearance-accent]') as HTMLInputElement
    fireEvent.change(input, { target: { value: '#b45309' } })
    fireEvent.click(document.querySelector('[data-appearance-accent-clear]')!)
    expect(loadTheme().accent).toBe('')
    expect(root().style.getPropertyValue('--wb-violet-500')).toBe(
      SKINS.default.light.accentScale['500']
    )
  })
})

describe('外观 · 自定义背景', () => {
  it('四种模式都能切，模式写进 `data-wb-bg`（背景层与 CSS 都读它）', () => {
    renderPanel()
    for (const mode of ['solid', 'gradient', 'image', 'skin'] as const) {
      fireEvent.click(document.querySelector(`[data-bg-mode="${mode}"]`)!)
      expect(loadTheme().bg.mode).toBe(mode)
      expect(root().dataset.wbBg).toBe(mode)
    }
  })

  it('纯色：改一次色，页面底色跟着走', () => {
    renderPanel()
    fireEvent.click(document.querySelector('[data-bg-mode="solid"]')!)
    fireEvent.change(document.querySelector('input[data-bg-color]')!, { target: { value: '#1b1c1e' } })
    expect(loadTheme().bg.color).toBe('#1b1c1e')
    expect(root().style.getPropertyValue('--wb-page-bg')).toBe('#1b1c1e')
  })

  it('渐变：起止色与角度都进设置，且页面底色换成那条渐变', () => {
    renderPanel()
    fireEvent.click(document.querySelector('[data-bg-mode="gradient"]')!)
    fireEvent.change(document.querySelector('input[data-bg-from]')!, { target: { value: '#faf7f0' } })
    fireEvent.change(document.querySelector('input[data-bg-to]')!, { target: { value: '#ece3d4' } })
    fireEvent.change(document.querySelector('input[data-bg-angle]')!, { target: { value: '45' } })
    expect(loadTheme().bg).toMatchObject({ from: '#faf7f0', to: '#ece3d4', angle: 45 })
    expect(root().style.getPropertyValue('--wb-page-bg')).toContain('linear-gradient')
  })

  it('图片：上传完直接成为背景，并且压暗层默认给足（图很美、字看不见是常见的翻车）', async () => {
    renderPanel()
    fireEvent.click(document.querySelector('[data-bg-mode="image"]')!)
    // 选的是**背景图那个** input（`data-bg-file`），不是靠 `input[type="file"]` 的顺序。
    // 这一页现在有三个文件选择框（背景图 / 导入 JSON / 从图片做皮肤），
    // 而「第一个 file input」是会随版式变的——上一版就是这么被新加的那个顶掉的。
    const input = document.querySelector('input[data-bg-file]') as HTMLInputElement
    const file = new File(['x'], 'bg.png', { type: 'image/png' })
    fireEvent.change(input, { target: { files: [file] } })

    await vi.waitFor(() => {
      expect(api.uploadImage).toHaveBeenCalled()
    })
    await vi.waitFor(() => {
      expect(loadTheme().bg.image).toBe('/api/images/img-20261001-120000-abcdef.png')
    })
    expect(loadTheme().bg.scrim).toBeGreaterThan(0)
    expect(root().style.getPropertyValue('--wb-scrim')).toMatch(/^rgba\(/)
  })

  it('非法图片地址不进 DOM——`url(...)` 里不能塞 javascript:', () => {
    renderPanel()
    fireEvent.click(document.querySelector('[data-bg-mode="image"]')!)
    fireEvent.change(document.querySelector('input[data-bg-url]')!, {
      target: { value: 'javascript:alert(1)' },
    })
    // 设置里如实存着用户填的东西（好让他看见自己填了什么），但**不生效**
    expect(loadTheme().bg.image).toBe('javascript:alert(1)')
    expect(screen.getByText(/这个地址不能用/)).toBeTruthy()
  })

  it('压暗与模糊两根滑块写进变量', () => {
    renderPanel()
    fireEvent.click(document.querySelector('[data-bg-mode="image"]')!)
    fireEvent.change(document.querySelector('input[data-bg-slider="scrim"]')!, { target: { value: '20' } })
    fireEvent.change(document.querySelector('input[data-bg-slider="blur"]')!, { target: { value: '12' } })
    expect(loadTheme().bg).toMatchObject({ scrim: 20, blur: 12 })
    expect(root().style.getPropertyValue('--wb-scrim')).toBe('rgba(255, 255, 255, 0.2)')
    expect(root().style.getPropertyValue('--wb-bg-blur')).toBe('12px')
  })
})

describe('外观 · 用一张图现做一套皮肤', () => {
  /** 走一遍「选文件 → 上传 → 取色 → 装上皮」。 */
  async function pickPhoto(name = '海边.jpg') {
    const input = document.querySelector('input[data-skin-photo-file]') as HTMLInputElement
    const file = new File(['x'], name, { type: 'image/jpeg' })
    fireEvent.change(input, { target: { files: [file] } })
    await waitFor(() => {
      expect(document.querySelector('[data-skin-photo-report]')).toBeTruthy()
    })
  }

  it('传一张图 → 现做一套皮肤、**当场切过去**，并成为皮肤表里的一张卡', async () => {
    mockPhoto()
    renderPanel()
    await pickPhoto()

    expect(api.uploadImage).toHaveBeenCalled()
    // 取色用的是**刚上传回来的那个地址**与**原始文件名**（名字与出处都从它来）
    expect(skinFromImage).toHaveBeenCalledWith(PHOTO_URL, '海边.jpg')
    expect(userSkinManifests().map((m) => m.id)).toEqual(['photo-abc'])
    // 落盘是 effect 里做的，而**报告的 DOM 与设置是同一次 commit**——effect 还在
    // 它后面跑。所以读存储要等一下：这不是「迟早会对」，是「提交之后 effect 才跑」。
    await waitFor(() => {
      expect(loadTheme().skin).toBe('photo-abc')
    })
    expect(root().dataset.wbSkin).toBe('photo-abc')
    // 卡就在皮肤表里，和内置那几张并排
    expect(document.querySelector('[data-skin="photo-abc"]')).toBeTruthy()
    expect(document.querySelector('[data-skin-remove="photo-abc"]')).toBeTruthy()
  })

  it('**背景切回「跟随皮肤」**——不切的话自己原来设的那张会盖住新皮肤', async () => {
    mockPhoto()
    renderPanel()
    fireEvent.click(document.querySelector('[data-bg-mode="solid"]')!)
    expect(loadTheme().bg.mode).toBe('solid')

    await pickPhoto()

    await waitFor(() => {
      expect(loadTheme().bg.mode).toBe('skin')
    })
    // 而且要说一句，免得用户以为自己的背景被悄悄吃掉了
    expect(document.querySelector('[data-skin-photo-report]')?.textContent).toContain('跟随皮肤')
  })

  it('**取到了什么要摆出来**：色块、色号、算出来的两个压暗', async () => {
    mockPhoto()
    renderPanel()
    await pickPhoto()

    const text = document.querySelector('[data-skin-photo-report]')!.textContent ?? ''
    expect(text).toContain('#c2703a')
    expect(text).toContain('72%')
    expect(text).toContain('45%')
    // 从图里切出来的那几色也画出来了（预览里那一条）
    const chips = document.querySelectorAll('[data-skin-photo-report] span[style*="background-color"]')
    expect(chips.length).toBeGreaterThanOrEqual(3)
  })

  it('**图里没有颜色时说清楚**，并指路「强调色」那一栏', async () => {
    mockPhoto({ chromatic: false })
    renderPanel()
    await pickPhoto()
    expect(document.querySelector('[data-skin-photo-report]')?.textContent).toContain('基本没有颜色')
  })

  it('**这张图在亮色下托不住 → 直接落到暗色**，并说清是顺手切的', async () => {
    // 用户点「用这张图做一款」要的是一个**能用的结果**，不是「一套读不清的皮肤 +
    // 一句警告」。而警告里那个按钮做的本来就是这同一个动作。
    mockPhoto({ okLight: false, ratioLight: 3.6, okDark: true })
    renderPanel()
    await pickPhoto()

    await waitFor(() => {
      expect(loadTheme().mode).toBe('dark')
    })
    // 切过去之后就不该再警告了：同一张图在暗色模式下正好合适
    expect(document.querySelector('[data-skin-photo-warn]')).toBeNull()
    expect(document.querySelector('[data-skin-photo-report]')?.textContent).toContain('顺手切到了暗色')
  })

  it('两边都托不住时**不替他选**，而是把差多少说出来', async () => {
    // 只在「一边坏、另一边好」时才动。两边都坏时切过去也没用，
    // 这时候该说的是「最不利的一处约 3.6:1」以及「为什么没有继续压」。
    mockPhoto({ okLight: false, ratioLight: 3.6, okDark: false, ratioDark: 3.9 })
    renderPanel()
    await pickPhoto()

    const warn = document.querySelector('[data-skin-photo-warn]')
    expect(warn?.textContent, '不够却不吭声——用户只会觉得侧栏的字怎么发灰').toContain('托不住')
    expect(warn?.textContent, '要说清差多少').toContain('3.6')
    // 「没有再往下压」这件事也要说，否则看起来像没做完
    expect(warn?.textContent).toContain('没有继续压')
    // 明暗没有被悄悄改掉
    expect(loadTheme().mode).toBe('light')
  })

  it('两边都行时**也不替他选**（他可能特意开着跟随系统）', async () => {
    mockPhoto({ okLight: true, okDark: true })
    renderPanel()
    fireEvent.click(document.querySelector('[data-appearance-mode="system"]')!)
    await pickPhoto()
    expect(loadTheme().mode).toBe('system')
  })

  it('**面板层也是从图里算出来的**——报告里摆出通透度与模糊', async () => {
    // 这是「一整套皮肤」与「一张壁纸」的差别，所以要摆出来——
    // 不摆的话用户不知道卡片为什么变透了。
    mockPhoto({ glass: 78 })
    renderPanel()
    await pickPhoto()
    const text = document.querySelector('[data-skin-photo-report]')?.textContent ?? ''
    expect(text).toContain('面板通透度给到 78%')
    expect(text).toContain('模糊 6px')
  })

  it('取色失败时说得出为什么，且**什么都没改**', async () => {
    vi.mocked(skinFromImage).mockResolvedValue({ ok: false, reason: '这张图不允许被读取像素' })
    renderPanel()
    const input = document.querySelector('input[data-skin-photo-file]') as HTMLInputElement
    fireEvent.change(input, {
      target: { files: [new File(['x'], 'x.png', { type: 'image/png' })] },
    })

    await waitFor(() => {
      expect(document.querySelector('[data-appearance-err]')?.textContent).toContain('不允许被读取')
    })
    expect(userSkinManifests()).toEqual([])
    expect(loadTheme()).toEqual(DEFAULT_THEME)
  })

  it('不是图片的文件当场挡住，连上传都不发', async () => {
    mockPhoto()
    renderPanel()
    const input = document.querySelector('input[data-skin-photo-file]') as HTMLInputElement
    fireEvent.change(input, {
      target: { files: [new File(['x'], 'a.txt', { type: 'text/plain' })] },
    })
    await waitFor(() => {
      expect(document.querySelector('[data-appearance-err]')?.textContent).toContain('只支持')
    })
    expect(api.uploadImage).not.toHaveBeenCalled()
  })
})

describe('外观 · 给皮肤改名', () => {
  function installSakura(): void {
    const got = parseSkin({ id: 'sakura', label: '樱', accent: '#d9558a' })
    if (!got.ok) throw new Error('fixture')
    installUserSkins([got.value])
  }

  it('卡片上改名：当场生效、落盘，**内置那几张没有这个按钮**', () => {
    installSakura()
    renderPanel()

    expect(document.querySelector('[data-skin-rename="default"]'), '内置皮肤不该能改名').toBeNull()
    fireEvent.click(document.querySelector('[data-skin-rename="sakura"]')!)

    const input = document.querySelector('[data-skin-label-input="sakura"]') as HTMLInputElement
    expect(input.value).toBe('樱')
    fireEvent.change(input, { target: { value: '春' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(userSkinManifests()[0].label).toBe('春')
    expect(document.querySelector('[data-skin="sakura"]')?.textContent).toContain('春')
    expect(document.querySelector('[data-skin-label-input="sakura"]'), '没退出编辑').toBeNull()
  })

  it('名字不合法时**留在编辑态并说一句**，而不是静默丢掉这个皮肤', () => {
    installSakura()
    renderPanel()
    fireEvent.click(document.querySelector('[data-skin-rename="sakura"]')!)
    const input = document.querySelector('[data-skin-label-input="sakura"]') as HTMLInputElement
    fireEvent.change(input, { target: { value: '名'.repeat(40) } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(document.querySelector('[data-appearance-err]')?.textContent).toContain('最多')
    expect(userSkinManifests()[0].label).toBe('樱')
    expect(document.querySelector('[data-skin-label-input="sakura"]'), '退出编辑了，用户没机会改').toBeTruthy()
  })

  it('Esc 取消改名：退出编辑，**不改名**', () => {
    installSakura()
    renderPanel()
    fireEvent.click(document.querySelector('[data-skin-rename="sakura"]')!)
    const input = document.querySelector('[data-skin-label-input="sakura"]') as HTMLInputElement
    fireEvent.change(input, { target: { value: '春' } })
    fireEvent.keyDown(input, { key: 'Escape' })

    expect(userSkinManifests()[0].label).toBe('樱')
    expect(document.querySelector('[data-skin-label-input="sakura"]')).toBeNull()
  })

  it('**失焦即提交**——点别处是「我改完了」最常见的意思', () => {
    installSakura()
    renderPanel()
    fireEvent.click(document.querySelector('[data-skin-rename="sakura"]')!)
    const input = document.querySelector('[data-skin-label-input="sakura"]') as HTMLInputElement
    fireEvent.change(input, { target: { value: '春' } })
    fireEvent.blur(input)

    expect(userSkinManifests()[0].label).toBe('春')
    expect(document.querySelector('[data-skin-label-input="sakura"]')).toBeNull()
  })
})

describe('外观 · 恢复默认', () => {
  it('一键回到出厂：皮肤 / 亮暗 / 强调色 / 背景全部回到默认', () => {
    renderPanel()
    fireEvent.click(screen.getByTitle(SKINS.warm.hint))
    fireEvent.click(document.querySelector('[data-bg-mode="solid"]')!)
    fireEvent.change(document.querySelector('input[data-bg-color]')!, { target: { value: '#20232a' } })
    expect(loadTheme().skin).toBe('warm')

    fireEvent.click(document.querySelector('[data-appearance-reset]')!)

    expect(loadTheme()).toEqual(DEFAULT_THEME) // 存储里落回默认，与真·首次打开同一份
    expect(loadTheme()).toMatchObject({ skin: 'default', mode: 'light', accent: '' })
    expect(loadTheme().bg.mode).toBe('skin')
    expect(root().dataset.wbSkin).toBe('default')
    expect(root().style.getPropertyValue('--wb-page-bg')).toBe(SKINS.default.light.pageBg)
  })

  it('恢复默认**不动导入的皮肤**——那句话说的是外观，不是「清空我装过的东西」', () => {
    const got = parseSkin({ id: 'sakura', label: '樱', accent: '#d9558a' })
    if (!got.ok) throw new Error('fixture')
    installUserSkins([got.value])

    renderPanel()
    fireEvent.click(document.querySelector('[data-appearance-reset]')!)

    expect(loadTheme()).toEqual(DEFAULT_THEME)
    expect(userSkinManifests().map((m) => m.id)).toEqual(['sakura'])
    expect(screen.getByTitle('樱'), '导入的皮肤被恢复默认顺手删了').toBeTruthy()
  })
})

describe('外观 · 导入导出', () => {
  /** 触发一次「从文件导入」。
   *
   *  两个坑，都踩过：
   *  1. 必须用 `fireEvent.change(el, { target: { files } })` 这种**带 target 的写法**。
   *     先 `Object.defineProperty` 再发一个裸的 `fireEvent.change(el)`，原生 change
   *     事件确实发了（能监听到），但 **React 的 `onChange` 不会跑**——症状是
   *     「点了文件什么都没发生」，从测试的失败信息里完全看不出原因。
   *  2. 之后要 `waitFor`。jsdom 的 `Blob.text()` 在**任务**里 resolve，不是微任务，
   *     干等几轮 `await Promise.resolve()` 等不到。
   *
   *  另外选的是**导入那个** input（`data-appearance-import-file`），不是背景图那个。 */
  async function importFile(text: string) {
    const input = document.querySelector('input[data-appearance-import-file]') as HTMLInputElement
    const file = new File([text], '外观设置.json', { type: 'application/json' })
    fireEvent.change(input, { target: { files: [file] } })
    await waitFor(() => {
      expect(document.querySelector('[data-appearance-err], [data-appearance-notice]')).toBeTruthy()
    })
  }

  it('导出给的是**这份设置**：当前皮肤、亮暗、强调色、背景都在里面', () => {
    // 拦下 `URL.createObjectURL` 而不是真的下载：这里要断言的是文件内容
    const blobs: Blob[] = []
    const origCreate = URL.createObjectURL
    const origRevoke = URL.revokeObjectURL
    URL.createObjectURL = (b: Blob) => {
      blobs.push(b)
      return 'blob:fake'
    }
    URL.revokeObjectURL = () => {}
    const origClick = HTMLAnchorElement.prototype.click
    HTMLAnchorElement.prototype.click = function () {}

    try {
      renderPanel()
      fireEvent.click(screen.getByTitle(SKINS.ocean.hint))
      fireEvent.click(document.querySelector('[data-appearance-mode="dark"]')!)
      fireEvent.click(document.querySelector('[data-appearance-export]')!)
    } finally {
      URL.createObjectURL = origCreate
      URL.revokeObjectURL = origRevoke
      HTMLAnchorElement.prototype.click = origClick
    }

    expect(blobs).toHaveLength(1)
    expect(blobs[0].type).toBe('application/json')
  })

  it('导入一份文件：皮肤装上了、设置套用了、并且**说清楚发生了什么**', async () => {
    renderPanel()
    const text = serializeExport(
      buildExport(
        { ...DEFAULT_THEME, skin: 'sakura', mode: 'dark' },
        [{ format: 1, id: 'sakura', label: '樱', accent: '#d9558a' }]
      )
    )
    await importFile(text)

    expect(userSkinManifests().map((m) => m.id)).toEqual(['sakura'])
    expect(loadTheme()).toMatchObject({ skin: 'sakura', mode: 'dark' })
    // 皮肤表**当场**就多了一张卡（靠 `skinsRev` 触发重画，不是等下一次无关渲染）
    expect(screen.getByTitle('樱')).toBeTruthy()
    expect(document.querySelector('[data-appearance-notice]')?.textContent).toContain('樱')
  })

  it('导入失败时说得出**为什么**，且什么都没改', async () => {
    renderPanel()
    await importFile('{"schema":99}')
    expect(document.querySelector('[data-appearance-err]')?.textContent).toContain('格式版本')
    expect(userSkinManifests()).toEqual([])
    expect(loadTheme()).toEqual(DEFAULT_THEME)
  })

  it('导入的皮肤能删；删掉正在用的那个之后外观退回默认，而不是变成一屏无色', async () => {
    renderPanel()
    const text = serializeExport(
      buildExport({ ...DEFAULT_THEME, skin: 'sakura' }, [
        { format: 1, id: 'sakura', label: '樱', accent: '#d9558a' },
      ])
    )
    await importFile(text)
    expect(root().dataset.wbSkin).toBe('sakura')

    fireEvent.click(document.querySelector('[data-skin-remove="sakura"]')!)

    expect(userSkinManifests()).toEqual([])
    expect(root().dataset.wbSkin).toBe('default')
    expect(root().style.getPropertyValue('--wb-violet-600')).toBe(
      SKINS.default.light.accentScale['600']
    )
  })
})

// 分区域：八个值各有一根滑块，而「没拨过的跟着主旋钮走」是一条规则。
// 这里测的是**界面与 DOM 一起动**——拖一根滑块，只有它管的那个变量该变。
describe('外观 · 分区域', () => {
  const slider = (key: string) =>
    document.querySelector(`input[data-surf-slider="${key}"]`) as HTMLInputElement
  const followBtn = (key: string) =>
    document.querySelector(`[data-surf-follow="${key}"]`) as HTMLButtonElement
  const alpha = (v: string) => root().style.getPropertyValue(v)
  const drag = (key: string, value: number) => {
    fireEvent.change(slider(key), { target: { value: String(value) } })
  }

  it('八个区域各有一根滑块，且**显示的是过下限之后的数**', () => {
    renderPanel()
    for (const key of [
      'glass',
      'sidebarGlass',
      'topbarGlass',
      'fieldGlass',
      'floatGlass',
      'blur',
      'borderAlpha',
      'shadow',
    ]) {
      expect(slider(key), `没有 ${key} 那根滑块`).toBeTruthy()
    }
    // 下限就是那一层的地板：拨不到「看不见」的地方去
    expect(slider('glass').min).toBe('55')
    expect(slider('fieldGlass').min).toBe('80')
    expect(slider('floatGlass').min).toBe('95')
    expect(slider('borderAlpha').min).toBe('55')
    expect(slider('blur').min).toBe('0')
    // 出厂皮肤：实心面板 + 产品今天那个壳（85%）
    expect(slider('glass').value).toBe('100')
    expect(slider('sidebarGlass').value).toBe('85')
  })

  it('单拨侧栏：**只有侧栏那个变量动**，顶栏一点也不动', () => {
    renderPanel()
    const topBefore = alpha('--wb-topbar-alpha')
    drag('sidebarGlass', 30)

    expect(alpha('--wb-sidebar-alpha')).toBe('0.3')
    expect(alpha('--wb-topbar-alpha')).toBe(topBefore)
    // 落盘的是**那一项**，不是整层
    expect(loadTheme().surfaces).toEqual({ sidebarGlass: 30 })
    // 只有那一行的 ↺ 亮起来
    expect(followBtn('sidebarGlass').className).not.toContain('invisible')
    expect(followBtn('topbarGlass').className).toContain('invisible')
  })

  it('点 ↺：那一项回到皮肤自己那档，覆盖表里也不再留着', () => {
    renderPanel()
    drag('sidebarGlass', 30)
    fireEvent.click(followBtn('sidebarGlass'))

    expect(alpha('--wb-sidebar-alpha')).toBe(
      String(SKINS.default.light.surfaces.sidebarGlass / 100)
    )
    expect(loadTheme().surfaces).toEqual({})
    expect(followBtn('sidebarGlass').className).toContain('invisible')
  })

  it('拖主旋钮：**没拨过的区域跟着走**（输入框与浮层再过各自的地板）', () => {
    renderPanel()
    // 拖到最左——注意滑块自己就停在 55：`min` 就是卡片的地板
    // （浏览器与 jsdom 都按 `min` 夹住 range 的值），所以「拨到 0」这件事
    // 在界面上不存在，能拨出来的最小一档是 55。
    drag('glass', 0)
    expect(slider('glass').value).toBe('55')

    expect(alpha('--wb-surface-alpha')).toBe('0.55')
    expect(alpha('--wb-sidebar-alpha')).toBe('0.55')
    expect(alpha('--wb-topbar-alpha')).toBe('0.55')
    expect(alpha('--wb-field-alpha')).toBe('0.8') // 输入框地板 80：跟着走，但停在地板上
    expect(alpha('--wb-float-alpha')).toBe('0.95') // 浮层地板 95
    // 覆盖表里只记了主旋钮那一项：其余四项是**跟着**它算出来的，不是被写下来的
    expect(loadTheme().surfaces).toEqual({ glass: 55 })
  })

  it('单独拨过的区域**不被主旋钮吃掉**', () => {
    renderPanel()
    drag('sidebarGlass', 96)
    drag('glass', 55)
    expect(alpha('--wb-sidebar-alpha')).toBe('0.96')
    expect(alpha('--wb-topbar-alpha')).toBe('0.55')
    expect(loadTheme().surfaces).toEqual({ sidebarGlass: 96, glass: 55 })
  })

  it('拨到越界也压不穿地板（手改 DOM、或将来某个上游给了坏数）', () => {
    renderPanel()
    drag('fieldGlass', 0)
    expect(slider('fieldGlass').value).toBe('80') // 控件自己就停在 80
    expect(alpha('--wb-field-alpha')).toBe('0.8')
    drag('floatGlass', 10)
    expect(slider('floatGlass').value).toBe('95')
    expect(alpha('--wb-float-alpha')).toBe('0.95')
  })

  it('「全部跟随皮肤」把整层清回去——**没拨过时它不出现**', () => {
    renderPanel()
    expect(document.querySelector('[data-skin-follow]'), '一项没拨时不该有出口').toBeNull()
    drag('blur', 12)
    drag('borderAlpha', 70)
    expect(document.querySelector('[data-skin-follow]')).toBeTruthy()

    fireEvent.click(document.querySelector('[data-skin-follow]')!)

    expect(loadTheme().surfaces).toEqual({})
    expect(alpha('--wb-surface-blur')).toBe('0px')
    expect(document.querySelector('[data-skin-follow]')).toBeNull()
  })

  it('**存成新皮肤存的是生效值**：没拨过的区域也一起被写进去', () => {
    renderPanel()
    drag('sidebarGlass', 30)
    fireEvent.click(document.querySelector('[data-skin-save]')!)
    fireEvent.change(document.querySelector('[data-skin-save-name]')!, { target: { value: '我的' } })
    fireEvent.click(document.querySelector('[data-skin-save-confirm]')!)

    const mine = userSkinManifests().find((m) => m.id.startsWith('mine-'))
    expect(mine, '没存上').toBeTruthy()
    // 拨过的那一项按拨的存；没拨过的按**当时生效的那一档**存——
    // 存一份「皮肤 + 覆盖」的话，换台机器打开时覆盖丢了就变成另一套外观。
    expect(mine!.light!.surfaces).toMatchObject({ sidebarGlass: 30, glass: 100, fieldGlass: 100 })
    // 存完就切过去，那一层覆盖让位（它已经被写进皮肤数据里了）
    expect(loadTheme().surfaces).toEqual({})
    expect(root().dataset.wbSkin).toBe(mine!.id)
  })
})
