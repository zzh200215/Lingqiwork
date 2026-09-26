/** 前端路由的单一真相：路径 ↔ 模块，以及旧 `.html` 路径的别名。

    这个文件里除了两个组件，其余都是**纯函数**——协议的正确性靠直测这些函数来保证，
    不需要渲染整棵树（这个仓库目前没有任何渲染整页的测试设施）。
*/
import { useEffect } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import {
  Archive,
  BookOpen,
  Bot,
  Brain,
  Database,
  FileOutput,
  FolderKanban,
  Gauge,
  GitBranch,
  GraduationCap,
  Home,
  Library,
  type LucideIcon,
  Map,
  MessageCircle,
  NotebookPen,
  Package,
  PawPrint,
  Plug,
  Podcast,
  School,
  ScrollText,
  Settings,
  Settings2,
  Sprout,
  Sunrise,
  Target,
  Timer,
  Wand2,
  Workflow,
} from 'lucide-react'

// ---------- 侧栏导航（唯一真相）----------
//
// 2026-09-18：从「五个平铺的大区」改成**可展开的分组**。上一版的毛病是
// 「功能全藏在页面里的标签栏里」——工作页六个标签、零柒五个、设置七个，而侧栏只看得见五个字。
// 现在每个模块的子功能就摆在它下面，**页面里那套标签栏已经删掉**（侧栏是唯一入口），
// 但**地址一个都没改**：`?tab=` / `?section=` 照旧，旧书签、深链、`/threads` → `/work?tab=thread`
// 那条重定向都不破。
//
// 标签与图标也**只写在这里**：页面从下面这几个常量里取自己的 key 与文案，
// 于是「侧栏写着练、页面里叫测验」这种分叉不可能发生（§4-7 一事一处）。

export interface NavItem {
  /** 完整地址（带 query）。**它就是高亮的判据**——不是另算一份 */
  href: string
  label: string
  icon: LucideIcon
}

export interface NavGroup {
  key: string
  label: string
  icon: LucideIcon
  /** 点组名去哪（= 这一组的默认子页） */
  href: string
  /** 子项。空数组 = 这一组没有子功能，行上不摆 chevron */
  items: NavItem[]
}

export const TUTOR_TABS = [
  { key: 'learn', label: '学', icon: BookOpen },
  { key: 'practice', label: '练', icon: Target },
  { key: 'record', label: '记录', icon: Map },
] as const
export type TutorTab = (typeof TUTOR_TABS)[number]['key']

export const WORK_TABS = [
  // 四个**业务域**（2026-09-25 定稿方案 §一）：一个页面一个主题，名字一看就懂。
  // 上一版是五个（产出/提示词/自动化/评测/事项），这一版把「评测」并进了「提示词」——
  // 攒提示词、拿它对照、量它好不好，本来就是一件事的三步，分开摆反而要来回切。
  { key: 'report', label: '报告', icon: FileOutput },
  // 「提示词」= 你自己攒的提示词库（参照 AI Gist）。它**不是**「系统提示词登记表」
  // ——那一份驱动本项目的行为、有 sha、改它要过验收；这一份是你的资产，随你改。
  { key: 'prompt', label: '提示词', icon: ScrollText },
  // 工作流 = 原「引擎」+「调度台」：链的**定义**与它的**运行**同屏，不再分两处。
  { key: 'workflow', label: '工作流', icon: Workflow },
  { key: 'thread', label: '事项', icon: GitBranch },
] as const
export type WorkTab = (typeof WORK_TABS)[number]['key']

/** 旧 `?tab=` key → 新域名。
 *
 *  **这是「地址兼容」那一层**，不是可有可无的别名表：`?tab=` 是老书签、深链、
 *  跨模块外链的**唯一入口**，改了 key 而不管旧地址，等于把攒下的链接全废掉。
 *
 *  它与 `REDIRECTS` **不是一回事**：那个是**路径级**的（键是 `/threads` 这种路径），
 *  而 `?tab=` 是**查询参数**——前端从来没有过查询级别的别名层，这一层是新建的。
 *
 *  **表里同时留着「上上版」和「上一版」两代旧名**：`output/engine/lab/form/dispatch/follow`
 *  是最早的六个技术构件名，`deliver/automation/eval` 是 2026-09-24 那版五个业务域的名字。
 *  两代都得认，否则 9-24 那天存下的书签会在 9-25 失效。 */
export const WORK_TAB_ALIAS: Record<string, WorkTab> = {
  // 最早那六个
  output: 'report',
  engine: 'workflow',
  dispatch: 'workflow',
  lab: 'prompt',
  form: 'prompt',
  follow: 'thread',
  // 2026-09-24 那五个（deliver/automation/eval 本轮改名；prompt/thread 没动）
  deliver: 'report',
  automation: 'workflow',
  eval: 'prompt',
}

/** 把 URL 上那个 tab 值认成新 key：认识就直接用，不认识查别名，都不认识就是 null。
 *
 *  **侧栏高亮与页面必须走同一个函数。** 各算一份的那天就会出现「侧栏亮着 A、
 *  页面停在 B」——`routes.test.ts` 开头那段话点名的就是这个，而且没人会收到报错。 */
export function resolveWorkTab(raw: string | null): WorkTab | null {
  if (!raw) return null
  return (
    (WORK_TABS.find((t) => t.key === raw)?.key as WorkTab | undefined) ??
    WORK_TAB_ALIAS[raw] ??
    null
  )
}

export const COMPANION_TABS = [
  { key: 'chat', label: '聊天', icon: MessageCircle },
  { key: 'teach', label: '教它', icon: School },
  { key: 'growth', label: '成长', icon: Sprout },
  { key: 'room', label: '小屋', icon: Home },
  { key: 'audio', label: '有声', icon: Podcast },
] as const
export type CompanionTab = (typeof COMPANION_TABS)[number]['key']

/** 设置页的分区。**从 `SettingsPage.tsx` 搬到这里**：侧栏要摆它，页面要按它切，
 *  两处各写一份的那天就会出现「侧栏有七项、页面里是六项」。 */
export const SETTING_SECTIONS = [
  { key: 'general', icon: Settings, label: '通用' },
  { key: 'models', icon: Brain, label: '模型' },
  { key: 'agents', icon: Bot, label: '智能体' },
  { key: 'automation', icon: Timer, label: '自动化' },
  { key: 'content', icon: Wand2, label: '内容生成' },
  { key: 'data', icon: Database, label: '数据' },
  { key: 'mcp', icon: Plug, label: 'MCP' },
] as const
export type SettingSection = (typeof SETTING_SECTIONS)[number]['key']

function withTab(
  path: string,
  tabs: readonly { key: string; label: string; icon: LucideIcon }[]
): NavItem[] {
  return tabs.map((t) => ({ href: `${path}?tab=${t.key}`, label: t.label, icon: t.icon }))
}

/** 资产那一组：子项是**各自独立的页面**（不是同一页的标签），所以按路径匹配。 */
export const ASSET_ITEMS: NavItem[] = [
  { href: '/assets', label: '产出物', icon: Package },
  { href: '/notes', label: '笔记', icon: NotebookPen },
  { href: '/kb', label: '知识库', icon: Library },
  { href: '/dashboard', label: '仪表盘', icon: Gauge },
]

export const NAV: NavGroup[] = [
  { key: 'review', label: '今日', icon: Sunrise, href: '/review', items: [] },
  { key: 'tutor', label: '学', icon: GraduationCap, href: '/tutor?tab=learn', items: withTab('/tutor', TUTOR_TABS) },
  { key: 'work', label: '工作', icon: FolderKanban, href: '/work?tab=report', items: withTab('/work', WORK_TABS) },
  { key: 'assets', label: '资产', icon: Archive, href: '/assets', items: ASSET_ITEMS },
  {
    key: 'companion',
    label: '零柒',
    icon: PawPrint,
    href: '/companion?tab=chat',
    items: withTab('/companion', COMPANION_TABS),
  },
  {
    key: 'settings',
    label: '设置',
    icon: Settings2,
    href: '/settings?section=general',
    items: SETTING_SECTIONS.map((s) => ({
      href: `/settings?section=${s.key}`,
      label: s.label,
      icon: s.icon,
    })),
  },
]

/** 路径 → 它属于哪一组。**`/notes` 这些没有自己分组、但归在「资产」下的页面也在这**。 */
const GROUP_OF_PATH: Record<string, string> = {
  '/review': 'review',
  '/tutor': 'tutor',
  '/work': 'work',
  '/assets': 'assets',
  '/notes': 'assets',
  '/kb': 'assets',
  '/dashboard': 'assets',
  '/companion': 'companion',
  '/settings': 'settings',
}

/** 每一组「没写参数时落在哪」——**与页面里那几处默认值是同一个**（页面现在也从这里取）。 */
const GROUP_PARAM: Record<string, { key: string; value: string } | null> = {
  review: null,
  tutor: { key: 'tab', value: 'learn' },
  work: { key: 'tab', value: 'report' },
  assets: null, // 子项是不同路径，不看参数
  companion: { key: 'tab', value: 'chat' },
  settings: { key: 'section', value: 'general' },
}

/** 当前地址落在哪一组、哪一个子项上。侧栏的高亮与展开都读它，**不另算一份**。
 *
 *  三条与页面默认值对齐的规矩：
 *  ① 没写参数 → 这一组的第一个子项（`/work` 就是「产出」）；
 *  ② `?task=7` 这种工作流深链没写 tab → 「引擎」（工作页自己也是这么落的）；
 *  ③ 参数是个不认识的词 → 退回第一个子项（页面也会退回默认，两边一致）。
 */
export function navState(pathname: string, search: string): { group: string; href: string } {
  const key = GROUP_OF_PATH[pathname]
  const group = NAV.find((g) => g.key === key)
  if (!group) return { group: '', href: '' }
  if (group.items.length === 0) return { group: group.key, href: group.href }

  const spec = GROUP_PARAM[group.key]
  if (!spec) {
    const hit = group.items.find((i) => i.href === pathname)
    return { group: group.key, href: hit ? hit.href : group.items[0].href }
  }

  const q = new URLSearchParams(search)
  let value = q.get(spec.key) ?? ''
  if (!value && group.key === 'work' && q.get('task')) value = 'workflow'
  // `?tab=` 认旧 key：不认的话，一条 `/work?tab=automation` 的旧链接会让侧栏**退回第一项**，
  // 而页面已经解析成「工作流」了——正是本文件开头那段话说的「侧栏亮着 A、页面停在 B」。
  if (group.key === 'work') value = resolveWorkTab(value) ?? value
  const hit = value
    ? group.items.find((i) => new URLSearchParams(i.href.split('?')[1] ?? '').get(spec.key) === value)
    : undefined
  return { group: group.key, href: hit ? hit.href : group.items[0].href }
}

/** 顶栏面包屑用的：当前在哪一组、哪一档，**取的是同一份 `navState`**。
 *
 *  返回的是给人看的字（不是 key）：`{ module, item, href }`。
 *  `item` 为空 = 就在模块主页上（那就不摆第二段，别写成「工作 / 工作」）。 */
export function navCrumbs(
  pathname: string,
  search: string
): { module: string; item: string; href: string } {
  const { group, href } = navState(pathname, search)
  const g = NAV.find((n) => n.key === group)
  if (!g) return { module: '对话', item: '', href: '' }
  const hit = g.items.find((i) => i.href === href)
  // 组名与子项同名（「学 / 学」）时只留一段——同一件事念两遍不叫面包屑
  const item = hit && hit.label !== g.label ? hit.label : ''
  return { module: g.label, item, href: g.href }
}

export type Module =
  | 'chat'
  | 'tutor'
  | 'work'
  | 'threads'
  | 'growth'
  | 'dashboard'
  | 'notes'
  | 'kb'
  | 'settings'
  | 'review'
  | 'assets'
  | 'companion'

/** 路径 → 模块。`/review` 现在是**进了导航的「今日」**（复习队列 + 习惯打卡）——
    够不着是客观缺陷，已修；主动提醒本身仍然封存（复习是你想起来才做的事）。
    `/assets` 是「资产」：产出物速览（各个库的入口 2026-09-18 起归侧栏那一组）。
    `/companion` 是「陪伴」：零柒的整页聊天 / 成长 / 有声——2026-09-18 起进了导航
    （侧栏「🐾 零柒」那一组），宠物那个入口照旧。 */
export const ROUTES: Record<string, Module> = {
  '/': 'chat',
  '/tutor': 'tutor',
  '/work': 'work',
  '/threads': 'threads',
  '/growth': 'growth',
  '/dashboard': 'dashboard',
  '/notes': 'notes',
  '/kb': 'kb',
  '/settings': 'settings',
  '/review': 'review',
  '/assets': 'assets',
  '/companion': 'companion',
}

/** 导航收缩后「整页搬家」的旧地址 → 新地址（带 search）。
 *
 *  只收**真的不再有自己的页面**的路径；页面还活着的（/notes、/kb、/dashboard）
 *  不进这里——它们的入口挪到了资产页，但地址没变，书签照用。
 *  `/threads` 搬进工作页的「跟进」标签；`/growth` 搬进陪伴页的「成长」标签
 *  （成长本来就是宠物那条线的账）。
 */
export const REDIRECTS: Record<string, string> = {
  '/threads': '/work?tab=thread',
  '/growth': '/companion?tab=growth',
}

const TITLES: Record<Module, string> = {
  chat: '对话',
  tutor: '学',
  work: '工作',
  threads: '事',
  growth: '成长',
  dashboard: '仪表盘',
  notes: '笔记',
  kb: '知识库',
  settings: '设置',
  review: '今日',
  assets: '资产',
  companion: '陪伴',
}

/** 把路径规范化成路由表里的形状；不是已知路由就返回 null。
 *
 *  `.html` 后缀当**别名**而不是 404：`capture.ts` 把 `/kb.html` 编进了用户浏览器里
 *  已经保存的书签小工具，那些字符串我们改不了。丢掉这条别名 = 静默废掉一条集成。
 */
export function normalizePath(pathname: string): string | null {
  let p = (pathname || '/').trim() || '/'
  while (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1) // 去尾斜杠
  if (p in ROUTES) return p
  if (p === '/index.html') return '/'
  if (p.endsWith('.html')) {
    const stem = p.slice(0, -'.html'.length)
    if (stem in ROUTES) return stem
  }
  return null
}

/** 不是已知路由 → null；否则 → 模块名。 */
export function parseRoute(pathname: string): Module | null {
  const p = normalizePath(pathname)
  return p === null ? null : ROUTES[p]
}

/** 侧栏顶栏那行字用的：给一个 href（可能带 query）→ 该叫什么。 */
export function titleFor(href: string): string {
  const module = parseRoute((href || '').split(/[?#]/)[0])
  return module ? TITLES[module] : '侧栏'
}

/** 旧路径 → 该跳去的新地址；已经是新路径、或不是已知路由 → null。
 *
 *  **`search` 和 `hash` 必须原样带上。** 存量书签打过来的是
 *  `/kb.html?clip=<url>&title=<t>`——剪藏的参数就在 search 里，只把路径改掉而丢掉
 *  query，等于把这条集成从「能用」变成「点了没反应」。
 *
 *  两层：`.html` 别名先摆正成路由路径；再查 `REDIRECTS`（整页搬家的路径）。
 *  搬家目标自带 search 时两边合并——旧参数保留、新参数说了算
 *  （`/threads?thread=3` → `/work?tab=thread&thread=3`）。目标不带 search 时
 *  旧 search **一个字节都不动**（上面书签小工具那条测试钉死了这一点）。
 */
/** 查询级别的别名：路径没搬、但 `?tab=` 是旧 key 时把参数摆正。
 *  返回新的 search（含 `?`），不需要改就返回 null。 */
function workTabAliased(pathname: string, search: string): string | null {
  if (pathname !== '/work') return null
  const q = new URLSearchParams(search)
  const raw = q.get('tab')
  if (!raw) return null
  const resolved = resolveWorkTab(raw)
  if (!resolved || resolved === raw) return null
  q.set('tab', resolved)
  const s = q.toString()
  return s ? `?${s}` : ''
}

export function legacyTarget(
  pathname: string,
  search: string,
  hash: string
): { pathname: string; search: string; hash: string } | null {
  const normalized = normalizePath(pathname)
  if (normalized === null) return null

  const moved = REDIRECTS[normalized]
  let toPath = normalized
  let toSearch = search
  if (moved !== undefined) {
    const q = moved.indexOf('?')
    toPath = q === -1 ? moved : moved.slice(0, q)
    if (q !== -1) {
      const merged = new URLSearchParams(search)
      for (const [k, v] of new URLSearchParams(moved.slice(q + 1))) merged.set(k, v)
      const s = merged.toString()
      toSearch = s ? `?${s}` : ''
    }
  }

  // **第二层：查询参数**。`?tab=engine` 这种老 key 在这里摆正成新域名——
  // `REDIRECTS` 只认路径，管不到参数，所以这一层是新建的。
  // 地址栏因此**自愈**：旧书签点开一次就变成新地址，侧栏也就跟着对了。
  const aliased = workTabAliased(toPath, toSearch)
  if (aliased !== null) toSearch = aliased

  if (toPath === pathname && toSearch === search) return null
  return { pathname: toPath, search: toSearch, hash }
}

/** 当前路径对应的模块。Layout 用它决定高亮和埋点。 */
export function useModule(): Module {
  return parseRoute(useLocation().pathname) ?? 'chat'
}

/** 承接旧 `.html` 地址：在路由表之外先把它换成新地址（保留 query 和 hash）。
 *
 *  必须放在 `<BrowserRouter>` 里面（要用 useLocation）但在 `<Routes>` 外面——
 *  它是「把地址摆正」，不是一条路由。 */
export function LegacyRedirect({ children }: { children: React.ReactNode }) {
  const { pathname, search, hash } = useLocation()
  const navigate = useNavigate()
  const target = legacyTarget(pathname, search, hash)

  useEffect(() => {
    if (target) navigate(target, { replace: true })
  }, [target, navigate])

  // 还没跳完就先不渲染——否则页面会先按旧地址挂载一次再重挂
  if (target) return null
  return <>{children}</>
}

/** 页面内容容器。原先是 `Layout` 负责的（`Layout.tsx:149-153`），上提到路由层之后
    由它接管——**裸渲染的页面没有这层会塌成 0px**。
 *
 *  chat 和 学 例外：它们自己管滚动（输入框钉在底部，外面再套一层滚动容器会把它
 *  连同内容一起滚走），这与改动前的行为一致。 */
export function RouteShell({ page, children }: { page: Module; children: React.ReactNode }) {
  useEffect(() => {
    // 单页外壳之后 <title> 没有地方按页给了（以前每个 .html 各带一个）
    document.title = `${TITLES[page]} · AI 工作台`
  }, [page])

  if (page === 'chat' || page === 'tutor') return <>{children}</>
  // `wb-page` = 页面底色（浅灰 / 深蓝黑）。**卡片才是白的**——两层底色分开，
  // 内容窄的时候才不会糊成一片白（2026-09-18 版面改版）。
  return <main className="wb-page min-h-0 flex-1 overflow-y-auto">{children}</main>
}