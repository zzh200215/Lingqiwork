/** 全局主题状态：**全站唯一的「当前外观」真相**。
 *
 *  分工（三件事分在三个地方，谁都不重复别人的活）：
 *    - `theme.ts`        纯函数：设置 → CSS 变量。不认识 React。
 *    - `ThemeProvider`   状态 + 持久化 + 把结果写到 `<html>`。不认识业务。
 *    - 业务组件          只读 `useTheme()` 或干脆什么都不读（类名自己就跟着变量走）。
 *
 *  换肤因此**不需要任何组件重渲染**：颜色是 CSS 变量，浏览器自己会重画。Provider
 *  的重渲染只发生在「设置面板需要看到新值」这一处。
 *
 *  持久化两层：
 *    1. localStorage —— 首屏同步可读，`bootTheme()` 在 React 挂载前就已经写好了 DOM。
 *    2. 后端 config.json —— 防「清了浏览器数据就回到出厂配色」。**只在 localStorage
 *       里没有记录时**才回读，避免两边打架时出现「刷新一次变一次」。 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'

import { api } from './api'
import {
  DEFAULT_THEME,
  SKINS_CHANGED_EVENT,
  STORE_KEY,
  applyTheme,
  hasOverrides,
  installUserSkins,
  loadTheme,
  parseTheme,
  prefersDark,
  removeUserSkin,
  renameUserSkin,
  resolveTheme,
  saveDefaultTheme,
  saveTheme,
  type ColorMode,
  type InstallReport,
  type Parsed,
  type ResolvedTheme,
  type SkinManifest,
  type SurfKey,
  type SurfOverrides,
  type ThemeBg,
  type ThemeConfig,
} from './theme'
import type { ImportPlan } from './theme/transfer'

interface ThemeContextValue {
  /** 当前设置（设置面板直接编辑它） */
  config: ThemeConfig
  /** 解析结果：生效的皮肤、**生效的亮暗**、强调色、背景图、压暗层、CSS 变量 */
  resolved: ResolvedTheme
  setSkin: (id: string) => void
  /** 明确改成亮色或暗色（顶栏那个按钮用）。要「跟随系统」请用 `setMode('system')` */
  setDark: (dark: boolean) => void
  /** 亮 / 暗 / 跟随系统 */
  setMode: (mode: ColorMode) => void
  /** 空串 = 跟随皮肤 */
  setAccent: (hex: string) => void
  /** 面板层的某一项。`null` = 这一项回到「跟随皮肤」（见 `ThemeConfig.surfaces`）。 */
  setSurface: (key: SurfKey, v: number | null) => void
  /** 整层回到「跟随皮肤」。 */
  clearSurfaces: () => void
  patchBg: (patch: Partial<ThemeBg>) => void
  /** 恢复默认（皮肤 / 强调色 / 背景全部）。**不动导入的皮肤**——删掉它们是不可逆的，
   *  而「恢复默认外观」这句话说的是外观，不是「清空我装过的东西」。 */
  reset: () => void
  /** 装上导入的皮肤并把设置改成文件里那份。传进来的是**已经算好的计划**
   *  （见 `theme/transfer.ts`），这里不做校验——那是上面那层的事。 */
  applyImport: (plan: ImportPlan) => void
  /** 装上一个**当场做出来**的皮肤（从图片生成的那种）。返回装上了没有。
   *
   *  与 `applyImport` 分开：那条路是「一份文件里的一切」（皮肤 + 设置），
   *  这条路只有一个皮肤，而且它**不负责选中**——选中是调用方紧接着做的事，
   *  因为「做一套皮肤」与「切过去」在这条路上是同一个动作（见 `AppearanceSettings`）。 */
  addSkin: (manifest: SkinManifest) => InstallReport
  /** 给一个用户皮肤改名。名字不合规时返回原因，**界面要说出来**——
   *  静默不改的话用户看到的是「打了字，回车，没反应」。 */
  renameSkin: (id: string, label: string) => Parsed<string>
  /** 删掉一个导入的皮肤。 */
  dropSkin: (id: string) => void
  /** 导入的皮肤那份清单变过几次。见下面 `skinsRev` 的说明。 */
  skinsRev: number
}

const ThemeContext = createContext<ThemeContextValue | null>(null)

/** 后端回读是否已完成。模块级的标记（不是 state）：它只影响「要不要回读」这一次判断，
 *  不参与渲染，放进 state 只会多一轮无意义的重渲染。 */
let backendChecked = false

export function ThemeProvider({ children }: { children: ReactNode }) {
  // 初始值直接读 localStorage——与 `bootTheme()` 读的是同一份，
  // 所以首帧渲染出来的设置面板与页面上已经生效的外观必然一致
  const [config, setConfig] = useState<ThemeConfig>(loadTheme)

  /** 系统的亮暗。`mode === 'system'` 时它是唯一真相，其余时候它只是个被忽略的入参。
   *
   *  **一直订阅**，而不是「切到 system 时才订阅」：用户可能先待在亮色、期间系统主题
   *  变过，等切到「跟随系统」时再读一次读到的还是挂载那一刻的旧值。订阅本身很便宜
   *  （系统主题变化本身极罕见），而这个坑表现为「切过去之后颜色不对，刷新一下才对」。 */
  const [systemDark, setSystemDark] = useState(prefersDark)
  useEffect(() => {
    if (typeof matchMedia !== 'function') return
    const mq = matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => setSystemDark(mq.matches)
    onChange() // 挂载与订阅之间系统可能已经变过，先同步一次
    // `addEventListener` 在很老的 WebView 上没有：那就退化成「只在打开时读一次」，
    // 系统主题变化不再实时跟随，但外观仍然是对的。
    mq.addEventListener?.('change', onChange)
    return () => mq.removeEventListener?.('change', onChange)
  }, [])

  /** 导入的皮肤那份清单变过几次。
   *
   *  `listSkins()` 是个**普通函数**而不是 state——它读的是注册表里那份模块级的索引，
   *  React 看不见它什么时候变。所以装上或删掉皮肤之后得有个东西让界面重画，
   *  这就是那个东西。少了它，导入成功的那一刻界面还是旧的皮肤表，
   *  要等下一次无关的重渲染才会出现新皮肤。 */
  const [skinsRev, setSkinsRev] = useState(0)

  // 注册表的**异步**变化走事件：本地为空的那一次首装，`registry.restoreIfEmpty()`
  // 会从后端把副本找回来——那发生在模块加载后的某个网络往返之后，React 看不见。
  // （装上/删掉这类**同步**变化不走这里，各自的回调里已经抖过 rev 了。）
  useEffect(() => {
    const bump = () => setSkinsRev((n) => n + 1)
    window.addEventListener(SKINS_CHANGED_EVENT, bump)
    return () => window.removeEventListener(SKINS_CHANGED_EVENT, bump)
  }, [])


  // `skinsRev` **必须是 `resolved` 的依赖**，不只是用来触发重画的计数器：
  // 皮肤表变了，解析结果本身就可能变——删掉正在用的那个皮肤时，`skinById` 会退回
  // 默认皮肤，于是整套 CSS 变量都该跟着换。只在渲染里读 `skinsRev` 而漏掉这里的话，
  // 症状是「删掉皮肤之后界面还是那套颜色，点别处才突然变回来」。
  const resolved = useMemo(() => resolveTheme(config, systemDark), [config, systemDark, skinsRev])

  // 写到 DOM。**同步发生在 effect 里而不是渲染期间**：渲染期间改 DOM 在
  // StrictMode 双调用下会写两遍，而且顺序不可控。
  useEffect(() => {
    applyTheme(resolved)
  }, [resolved])

  // 后端回读：只在「本机从没设置过」时做一次。有本地记录就以本地为准——
  // 否则用户刚在这台机器上换的皮肤，会被上一次同步到后端的旧值顶掉。
  useEffect(() => {
    if (backendChecked) return
    backendChecked = true
    let hasLocal = false
    try {
      hasLocal = localStorage.getItem(STORE_KEY) != null
    } catch {
      /* 读不到就当没有 */
    }
    if (hasLocal) return
    api
      .getTheme()
      .then((r) => {
        // **过一遍 `parseTheme`**，不直接塞进 state：后端那份是「上一次某个版本的
        // 前端写进去的形状」，清过浏览器数据之后读回来的可能就是旧形状
        //（比如只有 `glass` / `blur` 两个标量的那版）。解析这一层认得旧值、
        // 也挡得住手改坏的字段，而直接塞进去的话，缺一个字段就是运行时崩在
        // `config.surfaces` 上——外观设置不该是能把页面弄白的那一环。
        if (r.theme) setConfig(parseTheme(r.theme))
      })
      .catch(() => {
        /* 后端没起来也要能用——主题是纯前端的事，不该被后端连累 */
      })
  }, [])

  // 后端写入：**去抖 800ms**。设置面板里拖一次压暗滑块会产生几十次变更，
  // 每次都发一个请求既吵又没必要；停下来之后落一次盘就够了。
  const putTimer = useRef<number | null>(null)
  const firstPut = useRef(true)
  useEffect(() => {
    if (firstPut.current) {
      // 挂载时的这一次不是「用户改了设置」，不落盘——否则每开一次页面就写一次文件
      firstPut.current = false
      return
    }
    saveTheme(config)
    if (putTimer.current !== null) window.clearTimeout(putTimer.current)
    putTimer.current = window.setTimeout(() => {
      api.putTheme(config).catch(() => {
        /* 后端写不进去，本地照样生效——不弹错、不挡路 */
      })
    }, 800)
    return () => {
      if (putTimer.current !== null) window.clearTimeout(putTimer.current)
    }
  }, [config])

  const setSkin = useCallback((id: string) => {
    setConfig((c) => ({ ...c, skin: id }))
  }, [])
  const setMode = useCallback((mode: ColorMode) => {
    setConfig((c) => ({ ...c, mode }))
  }, [])
  /** 顶栏那个按钮用的。传的是**「要变成什么」而不是「翻转」**：翻转在
   *  `mode === 'system'` 时含义模糊（翻的是系统的值，还是用户的意愿？），
   *  而调用方手上就有 `resolved.dark`，取反传进来只会有一种解释。 */
  const setDark = useCallback((dark: boolean) => setMode(dark ? 'dark' : 'light'), [setMode])
  const setAccent = useCallback((hex: string) => {
    setConfig((c) => ({ ...c, accent: hex }))
  }, [])
  /** 拨面板层的某一项。`null` = 把这一项清回「跟随皮肤」（见 `ThemeConfig.surfaces`）。
   *
   *  **一项一项地写**：`clear` 与写入是同一个入口，因为界面上的「↺」就是
   *  「这一项回到跟随」，而不是「把整层清空」——整层清空是另一个按钮。 */
  const setSurface = useCallback((key: SurfKey, v: number | null) => {
    setConfig((c) => {
      const next: SurfOverrides = { ...c.surfaces }
      if (v === null) delete next[key]
      else next[key] = v
      return { ...c, surfaces: next }
    })
  }, [])
  /** 「跟随皮肤」：把整层覆盖一次性清掉。 */
  const clearSurfaces = useCallback(() => {
    setConfig((c) => (hasOverrides(c.surfaces) ? { ...c, surfaces: {} } : c))
  }, [])
  const patchBg = useCallback((patch: Partial<ThemeBg>) => {
    setConfig((c) => ({ ...c, bg: { ...c.bg, ...patch } }))
  }, [])
  const reset = useCallback(() => {
    setConfig(saveDefaultTheme())
  }, [])

  const applyImport = useCallback((plan: ImportPlan) => {
    // 顺序要紧：先把皮肤装上，再改设置。反过来的话，中间那一瞬 `config.skin`
    // 指向一个还不存在的皮肤，会解析成默认皮肤——虽然只是一帧，但没有理由留着。
    installUserSkins(plan.merged)
    setConfig(plan.config)
    setSkinsRev((n) => n + 1)
  }, [])

  const dropSkin = useCallback((id: string) => {
    if (!removeUserSkin(id)) return
    // 删掉的正好是当前皮肤时**不在这里改 config**：`skinById` 会退回默认，
    // 下一次 `resolveTheme` 自然就对。在这里补一句 `setSkin('default')` 反而多一处
    // 「谁负责兜底」的分叉——兜底只该有一个地方。
    setSkinsRev((n) => n + 1)
  }, [])

  const addSkin = useCallback((manifest: SkinManifest) => {
    const report = installUserSkins([manifest])
    // 装上了才重画。被拒的那份不该让皮肤表动一下——那只会让人以为「多了一张卡」。
    if (report.added.length || report.replaced.length) setSkinsRev((n) => n + 1)
    return report
  }, [])

  const renameSkin = useCallback((id: string, label: string) => {
    const got = renameUserSkin(id, label)
    if (got.ok) setSkinsRev((n) => n + 1)
    return got
  }, [])

  const value = useMemo(
    () => ({
      config,
      resolved,
      setSkin,
      setDark,
      setMode,
      setAccent,
      setSurface,
      clearSurfaces,
      patchBg,
      reset,
      applyImport,
      addSkin,
      renameSkin,
      dropSkin,
      skinsRev,
    }),
    [
      config,
      resolved,
      setSkin,
      setDark,
      setMode,
      setAccent,
      setSurface,
      clearSurfaces,
      patchBg,
      reset,
      applyImport,
      addSkin,
      renameSkin,
      dropSkin,
      skinsRev,
    ]
  )

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

/** 读全局主题。
 *
 *  **Provider 缺席时不抛异常**，而是给一份「跟着皮肤走的空设置」：主题是全站的底噪，
 *  它不该成为任何组件（尤其是测试里单独渲染的那种）挂不上去的原因。
 *  那种情况下 DOM 上的变量仍然是 `bootTheme()` 写好的那一份，外观照旧正确。 */
export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext)
  if (ctx) return ctx
  return FALLBACK
}

/** Provider 缺席时的那一份。`DEFAULT_THEME` 已经是一份完整设置（`bg` 就是默认背景），
 *  这里只需要浅拷一层——直接引用同一个对象会让「谁改了这一份」变成说不清的事。 */
const FALLBACK_CONFIG: ThemeConfig = { ...DEFAULT_THEME, bg: { ...DEFAULT_THEME.bg } }
const FALLBACK: ThemeContextValue = {
  config: FALLBACK_CONFIG,
  resolved: resolveTheme(FALLBACK_CONFIG),
  setSkin: () => {},
  setDark: () => {},
  setMode: () => {},
  setAccent: () => {},
  setSurface: () => {},
  clearSurfaces: () => {},
  patchBg: () => {},
  reset: () => {},
  applyImport: () => {},
  // Provider 缺席时（测试里单独渲染某个组件）这两条是**无操作**，不是抛异常：
  // 主题是全站的底噪，不该成为任何组件挂不上去的原因（见 `useTheme` 的说明）。
  addSkin: () => ({ added: [], replaced: [], refused: [] }),
  renameSkin: () => ({ ok: false, reason: '没有主题上下文' }),
  dropSkin: () => {},
  skinsRev: 0,
}
