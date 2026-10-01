// 设计纪律的**守卫**：扫描源码，钉住几条已经踩过坑、又最容易悄悄溜回来的规矩。
//
// 为什么是扫源码而不是渲染组件：这几条是**全仓约定**（谁都能违反），
// 而按组件写的话每加一个新页面就要记得补一条——漏掉的那个正好是违规的那个。
// 扫源码的代价是「它读的是文本」，所以只钉**能被文本判定**的规矩；
// 需要判断渲染结果的（比如「锚点有落点」）留在各自的组件测试里。
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { CHROME_VEIL, DEFAULT_CHROME_GLASS } from './theme/surfaces'

const SRC = join(process.cwd(), 'src')

/** 所有产品源码（`.tsx` / `.ts`），排除测试自身。 */function sources(): { name: string; text: string }[] {
  return readdirSync(SRC)
    .filter((f) => (f.endsWith('.tsx') || f.endsWith('.ts')) && !f.includes('.test.'))
    .map((f) => ({ name: f, text: readFileSync(join(SRC, f), 'utf8') }))
}

/** 递归版：子目录（`theme/`、`api/`…）也算数。
 *
 *  上一版 `readdirSync(SRC)` **只扫顶层**——「新文件不在清单里 = 默认放行」的洞
 *  开在子目录这一侧：`theme/registry.ts` 的镜像 catch 就是第一个从洞里进来的
 *  （2026-10-01 补上）。凡有静默 catch 的文件，无论在哪一层，都必须在账本上
 *  显式占一行；没有静默的文件不必登记。 */
function sourcesDeep(dir: string = SRC, rel: string = ''): { name: string; text: string }[] {
  const out: { name: string; text: string }[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const name = rel ? `${rel}/${e.name}` : e.name
    if (e.isDirectory()) out.push(...sourcesDeep(join(dir, e.name), name))
    else if (
      (e.name.endsWith('.tsx') || e.name.endsWith('.ts')) &&
      !e.name.includes('.test.')
    )
      out.push({ name, text: readFileSync(join(dir, e.name), 'utf8') })
  }
  return out
}

/** 《工作模块优化方案》管的那些文件。
 *
 *  **这是一份清单，不是全仓扫描。** 方案里的判据（文件规模、线框布局）管的是这个模块；
 *  拿它们去扫全仓会当场红一片，而那些是**别的模块**的账——一条从第一天就是红的守卫，
 *  只会被人删掉。清单里少写一个文件，那个文件就不受管，所以先确认每一个都还在。
 */
const WORK_MODULE = [
  // 壳
  'WorkPage.tsx',
  'EnginePulse.tsx',
  'EvalNightlyCard.tsx',
  // 报告域
  'ReportPage.tsx',
  'ReportReader.tsx',
  'ReportFlow.tsx',
  'DeliverOutlineBox.tsx',
  'DeliverTemplateEditor.tsx',
  // 提示词域
  'PromptLibrary.tsx',
  'PromptAiPanel.tsx',
  'PromptEditor.tsx',
  'PromptNav.tsx',
  'PromptVarFill.tsx',
  'PromptHistoryPanel.tsx',
  'PromptCategoryManager.tsx',
  'PromptViews.tsx',
  'PromptDuel.tsx',
  'PromptLab.tsx',
  'CapabilityCandidate.tsx',
  'FormPane.tsx',
  // 工作流域
  'WorkflowRow.tsx',
  'RunSteps.tsx',
  'DispatchPanel.tsx',
  // 事项域
  'ThreadsPage.tsx',
  'AttachToThread.tsx',
  // 三域共用的取数与小工具
  'workData.ts',
  'workShared.ts',
]

function workSources(): { name: string; text: string }[] {
  return sources().filter((s) => WORK_MODULE.includes(s.name))
}

/** 找 `className="…"` 里同时含这几个词的属性值（顺序不限）。 */
function classAttrs(text: string, ...needles: string[]): string[] {
  const out: string[] = []
  for (const m of text.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)) {
    const v = m[1] ?? m[2] ?? ''
    if (needles.every((n) => v.includes(n))) out.push(v)
  }
  return out
}

describe('设计纪律 · 全仓守卫', () => {
  it('**没有 hover-only 的按钮**——`display:none` 的元素不在 Tab 序列里，键盘够不着', () => {
    // WCAG 2.1.1 Keyboard（Level A）。2026-09-24 全仓清掉 8 处（会话列表的重命名/置顶/
    // 文件夹/删除、图片的 OCR/移除、笔记删除、设置页图片删除），统一改成常显淡色
    // `opacity-60` + `hover:opacity-100`。
    //
    // 这条守卫防的是**回归**：`hidden` + `group-hover:block` 是很好用的写法，
    // 而它「看起来没问题」——鼠标用户永远发现不了。
    const bad = sources().filter((s) => /group-hover:(block|flex|inline)/.test(s.text))
    expect(bad.map((s) => s.name)).toEqual([])
  })

  it('设置页的取数失败不许再退回静默——「读不到」不是「没有」', () => {
    // 2026-09-25：这一页挂载时并发拉十几样东西，原来**全是** `.catch(() => {})`，
    // 于是拉不到就摆一个空区，看起来像「你还没配」。改成每条报自己的名字、
    // 页级失败条汇总（`data-settings-err`）。
    //
    // **只点名这一个文件**，不是全仓一刀切：别处确实有「读不到就不摆这一块」的
    // 正当场景（比如 `workData.useDeliverCatalogue`——体裁拉不到，面板不显示、清单照常用）。
    // 一刀切会逼着人给那些地方编一个错误出口，那比静默更糟。
    const s = readFileSync(join(SRC, 'SettingsPage.tsx'), 'utf8')
    // 逐行看，**跳过注释行**——注释里正当地提到这个写法（说明为什么改掉了它）
    const silent = s
      .split('\n')
      .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
      .flatMap((l) => [...l.matchAll(/\.catch\(\(\) => \{\}\)/g)])
    expect(silent.length, '设置页又有静默 catch 了').toBe(0)
  })

  it('主题必须在 React 挂载**之前**写进 DOM——晚一步就是「先按出厂配色画一帧」', () => {
    // 2026-10-01 换肤：皮肤是一串写在 `<html>` 上的内联 CSS 变量，由 `bootTheme()`
    // 同步执行。放进 `useEffect` 或 `onMounted` 都会先画一帧错的配色再跳回来
    // ——那一下闪烁在任何截图里都看不出来，只有真的打开才看得见，所以用文本钉住。
    const s = readFileSync(join(SRC, 'main.tsx'), 'utf8')
    const boot = s.indexOf('bootTheme()')
    const render = s.indexOf('.render(')
    expect(boot, 'main.tsx 里没有 bootTheme()').toBeGreaterThan(-1)
    expect(render, 'main.tsx 里没有 render()').toBeGreaterThan(-1)
    expect(boot, 'bootTheme() 必须在 render() 之前调用').toBeLessThan(render)
  })

  it('强调色实底只有两条路——`wb-btn-primary` / `wb-accent-fill*`，不许再手抄渐变', () => {
    // 2026-10-01 收口：全仓 37 处手抄的 `bg-gradient-to-* from-violet-600 to-fuchsia-600`
    // 已经改成 `.wb-btn-primary`（按钮）或 `.wb-accent-fill*`（logo/头像/气泡/占比条）。
    // 手抄那套的毛病不是「丑」而是**少一档**：它拿不到暗色专属的深色档，
    // 白字压在 violet-500 上只有 4.35:1（低于 AA 的 4.5），而这一点肉眼看不出来。
    //
    // 判据：一个类名串里同时出现 `bg-gradient` 与 `from-violet-`/`to-fuchsia-`、
    // **且没有 `bg-clip-text`** 就算违规（`bg-clip-text` = 那是渐变**文字**，不是色块）。
    // **三处例外是刻意的**，理由写在 `docs/ui-design-contract.md` §8.1：
    //   · `Welcome.tsx` 首页标题：三停渐变文字（violet→fuchsia→violet），
    //     它要的是「彩色字」不是「色块」——`.wb-accent-fill` 给不了 `bg-clip-text`
    //   · `dashboardCards.tsx` 的 `toneClasses` 是数据语义的五色标度（同样配 bg-clip-text）
    //   · `DashboardPage.tsx` 柱状图当天那根要 `to-t`（向上），两个 .wb-accent-fill
    //     是「向右 / 右下」，方向不同、不该硬套
    const ALLOW = new Set(['dashboardCards.tsx', 'DashboardPage.tsx'])
    const bad: string[] = []
    for (const s of sources()) {
      if (ALLOW.has(s.name)) continue
      // className 可能是 `"…"` 也可能是模板串 `` `…` ``；跨行的取不到就算漏，
      // 这条守卫宁可漏也不误报（误报会被人直接删掉）
      for (const m of s.text.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)) {
        const cls = m[1] ?? m[2] ?? ''
        if (!cls.includes('bg-gradient')) continue
        if (cls.includes('bg-clip-text')) continue
        if (/from-violet-|to-fuchsia-/.test(cls)) bad.push(`${s.name}: ${cls.slice(0, 90)}`)
      }
    }
    expect(bad, '又手抄强调色渐变了——按钮用 `wb-btn-primary`，其余实底用 `wb-accent-fill`').toEqual([])
  })

  it('字号不小于 12px——10px/11px 的中文在 1x 屏上认不出来', () => {
    // 设计契约（`docs/ui-design-contract.md` §2）定的下限是 `text-xs`（12px）。
    // 2026-09-24 全仓清过一次（`WorkPage` 一处 34 个）。角色分档：辅助/次要 12px、
    // 标签 13px、主体 14px——**下限是 12**。
    const bad: string[] = []
    for (const s of sources()) {
      for (const m of s.text.matchAll(/text-\[(9|10|11)px\]/g)) {
        bad.push(`${s.name}: ${m[0]}`)
      }
    }
    expect(bad).toEqual([])
  })

  it('圆角只有三档（6/8/10）——`rounded-xl` 及以上不再出现', () => {
    // 契约 §3：`rounded-md`(6) / `rounded-lg`(8) / `rounded-[10px]`(10)；
    // `rounded-full` 只给胶囊（标签、计数徽章、头像）。
    const bad: string[] = []
    for (const s of sources()) {
      for (const m of s.text.matchAll(/rounded-(xl|2xl|3xl)\b/g)) {
        bad.push(`${s.name}: ${m[0]}`)
      }
    }
    expect(bad).toEqual([])
  })

  it('卡片类不带常驻阴影——分层靠边框，阴影只留给浮在上面的东西', () => {
    // 契约 §1："no persistent shadows"；阴影只允许模态/抽屉/下拉/气泡/tooltip/拖动反馈。
    // `.wb-card` / `.wb-card-hover` / `.wb-card-hero` 三个类在 `index.css` 一处定义，
    // 所以这条查的是**这三个类的定义里有没有 box-shadow**（页面里各写各的才是病根）。
    const css = readFileSync(join(SRC, 'index.css'), 'utf8')
    for (const cls of ['.wb-card {', '.wb-card-hover', '.wb-card-hero']) {
      const at = css.indexOf(cls)
      expect(at, `${cls} 不见了？`).toBeGreaterThan(-1)
      const block = css.slice(at, css.indexOf('}', at))
      expect(block, `${cls} 不该有 box-shadow`).not.toContain('box-shadow')
    }
  })

  it('**每一个 `role="dialog"` 都能用 Esc 关掉**——这是键盘用户唯一的出口', () => {
    // 仓里早就有这条约定（`QuickView` / `SelectionView` / `CommandPalette` / `PetWidget` /
    // `FeedbackButtons` … 11 处都守着），但它是**口口相传**的：谁也没写下来，于是新写的
    // 浮层漏掉它，而且漏了没人看得出来——鼠标用户点遮罩就出去了，永远发现不了。
    //
    // 2026-09-25 在真界面上按了一下 Esc、填值弹窗**纹丝不动**，才发现工作模块那两个
    // （填值使用、分类管理）都只能点遮罩或点 ✕。补上之后写下这条。
    //
    // 判据取「文件里有 `role="dialog"` → 文件里得出现 `Escape`」：宽，但**挡得住回归**，
    // 而且不会因为写法不同（`useEscapeClose()` 还是手写 `e.key === 'Escape'`）误报。
    const bad = sources()
      .filter((s) => s.text.includes('role="dialog"'))
      .filter((s) => !s.text.includes('Escape'))
      .map((s) => s.name)
    expect(bad, '这个浮层没有 Esc 出口——加 `useEscapeClose(onClose)`（见 workShared.ts）').toEqual([])
  })

  it('工作模块里**点得动的长任务必须走 RunPanel**（方案 §六）', () => {
    // 这条是照着**我漏过两次的那类规则**写的：全局/行为类的话（「所有 AI 长任务走 RunPanel 六态」）
    // 读起来像已经做到了，而实际上可能只有按钮上一句文案（`打着…` / `量着…`）。
    // §七 那批 token 规则有守卫盯着，§六 一直没有——所以它能悄悄漏两轮。
    //
    // 判据：调了下面这些「点一下要跑几秒到几分钟」的接口的文件，必须出现 `RunPanel`。
    // 接口名写死在这里**是有意的**：新加一个长任务接口时，这条不会自动知道——
    // 所以下面还有一条「这几个名字都还在 api 里吗」，改名会红。
    const LONG_CALLS = [
      'checkPrompt', // 评测：跑一次对照（分钟级）
      'runSkillEval', // 技能：量一遍（分钟级）
      'arenaRun', // 对打：并行打几家
      'makeCandidate', // 技能草稿：读一份材料
      'promptAiGenerate', // 提示词 AI 三条
      'promptAiRefine',
      'promptAiVars',
      'deliverIntoThread', // 事项：就这件事写一份（分钟级）
    ]
    // **调用点与面板不在同一个文件的，只有这一处**，而且是有意的：AI 三条的状态在
    // `PromptLibrary` 里（编辑器也在用同一个 phase），面板在两个子视图里。白名单不是免检：
    // 右边那个组件名必须真的出现在文件里——改名或删掉，这条会红。
    const PANEL_ELSEWHERE: Record<string, string> = {
      'PromptLibrary.tsx': 'PromptAiPanel',
    }

    const bad: string[] = []
    for (const s of workSources()) {
      const calls = LONG_CALLS.filter((n) => s.text.includes(`api.${n}(`))
      if (!calls.length) continue
      if (s.text.includes('RunPanel')) continue
      const via = PANEL_ELSEWHERE[s.name]
      if (via && s.text.includes(via)) continue
      bad.push(`${s.name} 调了 ${calls.join('/')} 却没有 RunPanel`)
    }
    expect(bad, '长任务没走 RunPanel——六态、停止、重试就都没了').toEqual([])

    // 上面那份接口名清单不能悄悄失效（改名/删掉之后，这条守卫会变成永远绿的摆设）
    // 方向 6 分片后方法名住在 `src/api/*.ts` 域文件里——api.ts 只剩转发与组合处，类型在 api/types/
    const apiNames = readdirSync(join(SRC, 'api'), { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.ts'))
      .map((e) => readFileSync(join(SRC, 'api', e.name), 'utf8'))
      .join('\n')
    const gone = LONG_CALLS.filter((n) => !new RegExp(`\\b${n}:`).test(apiNames))
    expect(gone, 'api 里没有这些名字了——清单过期，改它').toEqual([])
  })

  it('工作模块的空态一律 `EmptyHint`——**禁裸文本**（方案 §七）', () => {
    // 空态最容易「顺手写个 `<p>`」：它看起来没问题，而这一页的规矩是虚线框 + 标题 +
    // 一句引导（`EmptyHint`）——裸文本在整页布局里读起来像「这里坏了」，而不是「这里还空着」。
    // 2026-09-26 抓到三处（历史版本 / 使用记录 / 能力包列表），其中两处是自己写的。
    //
    // 判据取「工作模块里，含空态措辞的 `<p>`」——宽，但挡得住回归。
    // 误报就把那句话挪进 `EmptyHint`（本来也该在那儿）。
    const EMPTY_WORDS = /还没有|还没用过|一份都没有|还没有任何一个领域/
    const bad: string[] = []
    for (const s of workSources()) {
      for (const line of s.text.split('\n')) {
        const t = line.trim()
        // 跳过注释行——注释里正当地提到这些措辞（说明为什么改掉了它）
        if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) continue
        if (/<p[ >]/.test(t) && EMPTY_WORDS.test(t)) bad.push(`${s.name}: ${t.slice(0, 70)}`)
      }
    }
    expect(bad, '空态写成了裸 <p>——换成 <EmptyHint>（虚线框 + 标题 + 一句引导）').toEqual([])
  })

  it('工作模块的卡片列表**分隔线通栏**——`ul` 上不许再挂横向内边距（方案 §七）', () => {
    // 通栏怎么写，方案 §七 原来的说法是**自相矛盾**的（「行容器 `wb-card divide-y`」+
    // 「行内 `-mx-4 px-4`」——容器没有内边距时，行上的负边距没有意义）。照它引的例子
    // （`RoomPane.tsx:484`）实际是：`ul` 带 `-mx-4` 拉回卡片边 + `li` 带 `px-4` 缩回来。
    //
    // 两种情形都合法，**唯一不允许的是「卡片列表自己带 px-」**——那会让每条分隔线
    // 两头各短一截（收件箱原来是短 16px），而这一眼很难发现、写的时候更不会注意到。
    //
    // 2026-09-25 改过四处：收件箱（`ul.-mx-4` + `li.px-4`）、运行视图、后台作业、
    // 工作流清单（`px-*` 从 `ul` 挪到 `li`）。
    const bad: string[] = []
    for (const s of workSources()) {
      for (const cls of classAttrs(s.text, 'wb-card', 'divide-y')) {
        if (/\spx-\d/.test(cls)) bad.push(`${s.name}: ${cls}`)
      }
    }
    expect(bad, '卡片列表又自己带横向内边距了——分隔线会两头短一截，把 px 挪到行上').toEqual([])
  })

  it('工作模块的 hero 一律 `wb-card-hero … p-5`（方案 §七 / §8.3）', () => {
    // §七：「页面主入口/hero `wb-card-hero p-5`」；§8.3 线框里那块「起一个题目」也写明 p-5。
    // 2026-09-25 修过两处 p-4（工作流页的起题目、事项页的新建面板）——它们与报告页那块
    // 生成面板本该是同一个档，差 4px 没人看得出来，但**同一档的东西不该有两个规格**。
    const bad: string[] = []
    for (const s of workSources()) {
      for (const cls of classAttrs(s.text, 'wb-card-hero')) {
        if (!/\sp-5\b/.test(cls)) bad.push(`${s.name}: ${cls}`)
      }
    }
    expect(bad, '工作模块的 hero 内边距不是 p-5').toEqual([])
  })

  it('工作模块不许**手抄一份 `wb-card`**——那正是「一处改，全站一起变」要避免的', () => {
    // `index.css` 里 `.wb-card` 那行注释写着：「一处改，全站 wb-card 一起变——这正是把它
    // 放在这里而不是逐页改的理由」。手抄一份 `rounded-lg border border-neutral-200 bg-white`
    // 就是它警告的病根：两份今天一样，改了一处之后就不一样了。
    // 2026-09-25 清过三处（提纲确认区、体裁模板编辑器、提示词编辑器）。
    //
    // **`PromptViews.tsx` 是例外，而且是刻意的**：那一屏四处卡片的底色要随「选中」变，
    // 而 `.wb-card` 定义在 `@tailwind utilities` 之后、同权重的工具类压不过它——套上去
    // 选中态就没底色了。方案 §8.2 区1 对这块的原话是「原样保留，**标杆不动**」。
    const ALLOW = new Set(['PromptViews.tsx'])
    const bad: string[] = []
    for (const s of workSources()) {
      if (ALLOW.has(s.name)) continue
      // 逐行看，**跳过注释行**——注释里会正当地提到这个写法（说明为什么改掉了它）
      for (const line of s.text.split('\n')) {
        if (line.trim().startsWith('//') || line.trim().startsWith('*')) continue
        if (/rounded-lg border border-neutral-200 bg-white/.test(line)) bad.push(`${s.name}: ${line.trim()}`)
      }
    }
    expect(bad, '手抄了一份 wb-card——换成 `wb-card` 那个类').toEqual([])
  })

  it('工作模块的单文件 ≤ 1000 行（方案 §十二）', () => {
    // 判据原话：「不拆页面文件追求完美结构；**单文件 ≤1000 行、单一域职责即停手**」。
    // 2026-09-25 清过一次：`PromptLibrary.tsx` 1573 → 952（编辑器/左导航/版本面板/变量填写/
    // 分类管理各自一份文件）、`WorkPage.tsx` 1231 → 889（工作流行与它的运行记录一份文件）。
    //
    // **这是一份清单，不是全仓扫描。** 那条判据属于《工作模块优化方案》，管的是这个模块的
    // 文件。拿它去扫全仓会当场红 9 个（`App.tsx` 1970 / `SettingsPage.tsx` 3623 /
    // `TutorPage.tsx` 3154 …），而那些是**别的模块**的账——一条从第一天就是红的守卫，
    // 只会被人删掉。那些账记在下面那条用例里，不藏着。
    //
    // 清单在文件顶部（`WORK_MODULE`）——上面那三条布局守卫也按同一份清单扫。
    // 清单里少写一个文件，那个文件就不受管——所以下面先确认每一个都还在。
    const all = sources()
    const names = new Set(all.map((s) => s.name))
    const gone = WORK_MODULE.filter((f) => !names.has(f))
    expect(gone, '清单里有文件已经不在了——删掉那一行，别让它继续指着空气').toEqual([])

    const bad = all
      .filter((s) => WORK_MODULE.includes(s.name))
      // 尾随换行不算一行——`split` 会多数出一个空串
      .map((s) => ({ name: s.name, n: s.text.replace(/\n$/, '').split('\n').length }))
      .filter((s) => s.n > 1000)
    expect(bad, '工作模块有文件越过 1000 行了——拆一个域出去，别把新东西往里堆').toEqual([])
  })

  it('壳（侧栏 / 顶栏）只有**一个**透明度来源，且算压暗时用的就是它', () => {
    // 在这之前侧栏 `bg-white/70`、顶栏 `bg-white/85` 两个数各写在自己的类名里，
    // 而 `theme/extract.ts` 算背景压暗时还要**再抄一遍**（「文字压在壳上之后
    // 实际看到什么」）。三处各写一份，改一处忘两处，症状只是「算出来的压暗淡了」
    // ——肉眼只会读成「这张图有点亮」。
    //
    // 现在只有一个来源：`surfaces.chromeGlass`（默认 `DEFAULT_CHROME_GLASS`），
    // 写成 `--wb-chrome-alpha`，`CHROME_VEIL` 从同一个常数推。
    const s = readFileSync(join(SRC, 'Layout.tsx'), 'utf8')
    /** **只要开标签那一段**：整个子树里到处是 `bg-neutral-100` 这类子元素的底色，
     *  而这条守的是「壳自己有没有另写一层底」。 */
    const openTag = (text: string, open: string): string => {
      const a = text.indexOf(open)
      expect(a, `找不到 ${open}`).toBeGreaterThan(-1)
      return text.slice(a, text.indexOf('>', a))
    }
    const rows: [string, string, string][] = [
      ['侧栏', openTag(s, '<aside'), 'wb-sidebar'],
      ['顶栏', openTag(s, '<header'), 'wb-topbar'],
      // **会话页那个顶栏也是壳**：它与模块页的 TopBar 是同一个位置上的两个实现，
      // 少了这一处，皮肤在「待得最久的那一页」上只改到一半。
      ['会话页顶栏', openTag(readFileSync(join(SRC, 'ChatHeader.tsx'), 'utf8'), '<header'), 'wb-topbar'],
    ]
    for (const [name, tag, part] of rows) {
      expect(tag, `${name}没有用 wb-chrome——壳的底色该由皮肤给`).toContain('wb-chrome')
      // 各自的出口也要在：参考实现（Codex Dream Skin）把 `sidebar` 与 `header`
      // 当两个可以分别设的部件，少了这个类那份能力就没了
      // （默认两者仍然是一档，见 `fillSurfaces`）。
      expect(tag, `${name}少了 ${part}——那一档就没法单独调了`).toContain(part)
      // 自己再写一层底的话，`.wb-chrome` 与它谁赢取决于源序，而那是没人看得出来的
      expect(tag, `${name}自己又写了一遍底色`).not.toMatch(/bg-white\/\d|dark:bg-neutral-9\d0\/\d/)
    }
    // 那份「投影」必须等于真值，不是另抄的一个数
    const want = DEFAULT_CHROME_GLASS / 100
    expect(CHROME_VEIL.light.side).toBe(want)
    expect(CHROME_VEIL.light.top).toBe(want)
    expect(CHROME_VEIL.dark.side).toBe(want)
    expect(CHROME_VEIL.dark.top).toBe(want)
  })

  it('面板层**只有一个来源**：卡片/壳/浮层都从皮肤变量里取底色', () => {
    // 「完整皮肤」与「换一张壁纸」的差别就在这一段。守卫钉的是**别再有人手写**：
    // 手写一层 `bg-white` 到卡片上不算错，但它会让那一个面板不跟皮肤走，
    // 而症状是「大部分地方变了、某一处还是白的」——极难发现。
    const css = readFileSync(join(SRC, 'index.css'), 'utf8')
    for (const cls of ['.wb-card', '.wb-chrome']) {
      const at = css.indexOf(`\n${cls} {`)
      expect(at, `${cls} 不见了？`).toBeGreaterThan(-1)
      const block = css.slice(at, css.indexOf('}', at))
      expect(block, `${cls} 的底色该来自 --wb-surface / --wb-chrome`).toMatch(/var\(--wb-(surface|chrome)\)/)
    }
    // 浮层那条带 `[data-wb-skin]` 前缀（要压过 `bg-white` 覆盖），所以单独找
    expect(css, '浮层那条规则不见了').toContain('[data-wb-skin] .wb-float')
  })

  it('静默 catch 的欠账——**记下来**，别让它悄悄变多', () => {
    // 上面那条（`SettingsPage`）管的是「**不许再有**」，只点名一个文件——因为**不是每一处
    // 静默都该改**：确实有「读不到就不摆这一块」的正当场景。工作模块自己那 5 处就是：
    // `WorkPage` 两个（后台作业/仪表盘拉不到 → 页头那块砖摆 `—`）、`workData`/`ThreadsPage`/
    // `ReportPage` 各一个（体裁拉不到 → 面板不显示，清单照常用）。
    //
    // 所以这一条**不判对错，只记账**：每个文件几处，写死。它不是验收线，是一份欠账清单——
    // 与上面那份「超 1000 行的文件」同一个道理：
    //   · 变多了 = 有人又用静默糊了一处（该看看是不是拿失败冒充「没有」）；
    //   · 变少了 = 有人清了，**这是好事，改这一行就行**；
    //   · 两种都让这条红一次，好过那个数字没人看着。
    //
    // 2026-09-25 实测（2026-09-28 复核对齐下面这份清单）：**48 处 / 18 个文件**。压在前几名的
    // 是 `TutorPage` 9（症状最像「你还没学过」）、`CompanionPage` 5、`App`/`AssetsPage`/`DashboardPage`/`ReviewPage` 各 4。
    // 清哪一处都要单独判是哪种静默，所以这条清单是**按文件计数**，不是一句「全仓禁止」。
    const counts: Record<string, number> = {}
    for (const s of sourcesDeep()) {
      const n = s.text
        .split('\n')
        // 跳过注释行——注释里正当地提到这个写法（说明为什么改掉了它 / 为什么留着它）
        .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
        .reduce((acc, l) => acc + (l.match(/\.catch\(\(\) => \{\}\)/g)?.length ?? 0), 0)
      if (n) counts[s.name] = n
    }
    expect(counts).toEqual({
      // 2026-09-30：listPrompts/listNotes 那两笔随附件/联想子系统搬到 useAttachments.ts，
      // 移动不是消灭，照实记到新文件名下
      // 2026-09-30：tts_auto 偏好那笔随语音播报子系统搬到 useVoicePlayback.ts
      'App.tsx': 1,
      // 2026-10-01：AssetsPage 五笔清偿出账——五块取数失败合并成一句「没读出来」
      // 的小字（data-assets-load-err），失败不再冒充「你什么都没产出」。
      'CardList.tsx': 1,
      // 2026-10-01：CommandPalette 三笔清偿出账——目录三样没读出来时报名字
      // （data-cmd-err，「搜索结果会缺这几样」），全文搜索失败也不再摆成「没有匹配」。
      // 2026-09-30：petState/tutorStuck 两笔随教学面板搬到 TeachPane.tsx
      'CompanionPage.tsx': 3,
      'TeachPane.tsx': 2,
      // 2026-09-29：决策日志节从 DashboardPage 拆出（DashboardDecisions），那条「读不到就不摆」跟着走
      'DashboardDecisions.tsx': 1,
      // 2026-10-01：DashboardPage 三笔清偿出账——journal/tutor/beliefs 转成本页
      // 其余块的同款约定（失败置 null、块不摆），主数据的失败本来就走 setError。
      'Layout.tsx': 2,
      // 2026-09-30：notesBriefing 那笔静默 catch 随文件列表侧栏搬到 NoteSidebar.tsx
      'NoteSidebar.tsx': 1,
      'PetWidget.tsx': 3,
      'ReportPage.tsx': 1,
      // 2026-09-30：petEvents/listConversations/dashboard 三笔「读不到就不摆」随 RecentPulse
      // 搬到 RecentPulse.tsx；crosscheck 那笔仍在本体
      'ReviewPage.tsx': 1,
      'RecentPulse.tsx': 3,
      'SelfCheckLine.tsx': 1,
      'ThreadsPage.tsx': 1,
      // 2026-09-29：概念轨/概览/历史三面板从 TutorPage 拆出（TutorRecordsPanels），
      // openConceptRow 那条「邻居拉不到就不摆」的 catch 跟着走
      'TutorRecordsPanels.tsx': 1,
      // 2026-10-01：TutorPage 的 8 笔全数清偿出账——侧栏六条、面试题库、开场建议
      // 都改成报自己的名字（railErr/bankErr/startersErr，SettingsPage 那条纪律的轻量版）。
      // 「症状最像你还没学过」的那一页，现在拉不到会说话了。
      // 2026-09-26：EnginePulse 从 WorkPage 搬出（那两条「读不到就不摆」的 catch 跟着走）
      'WorkPage.tsx': 1,
      'EnginePulse.tsx': 2,
      'EvalNightlyCard.tsx': 1,
      'workData.ts': 1,
      // 2026-09-30：App.tsx 的提示词/笔记清单两笔静默 catch 随 useAttachments 搬来
      'useAttachments.ts': 2,
      // 2026-09-30：App.tsx 的 tts_auto 那笔静默 catch 随 useVoicePlayback 搬来
      'useVoicePlayback.ts': 1,
      // 2026-10-01：扫描升级为递归后第一笔从子目录进账——registry 镜像皮肤的
      // 那条「副本失败不挡正本」（理由与行为见 theme/registry.sync.test.ts）
      'theme/registry.ts': 1,
    })
  })

  it('全仓超 1000 行的文件——**记下来**，别让它悄悄变多', () => {
    // 这不是验收线，是一份欠账清单：上面那条只管工作模块，这里是**其余模块**的实情。
    // `api.ts`（3778 行）已于方向 6 拆干净：方法进 `api/*.ts`，类型进 `api/types/*.ts`，
    // 本体只剩 163 行转发 + 组合——2026-09-29 移出本清单。
    // `KBPage.tsx`（1766 行）同日按页签拆成 Kb*Tab.tsx + kbShared.ts，本体只剩 96 行——同批移出。
    // `PetWidget.tsx`（1546 行）同日拆成 petNudges/petDrag/petPip/petShared +
    // usePetDrag/usePetDodge + PetPanel/PetPluginRow，本体只剩 806 行编排——同批移出。
    // `DashboardPage.tsx`（2249 行）同日拆成 dashboardCards / dashboardEvalCards /
    // DashboardDecisions，本体只剩 774 行——同批移出（测试引用的卡名经原路径 re-export）。
    // `TutorPage.tsx`（3205 行）同日分四刀拆成 tutorShared / TutorReportCards /
    // TutorRecordsPanels / TutorOpening / TutorSessionView / useTutorToolRuns，
    // 本体只剩 847 行状态机与编排——同批移出。
    // `SettingsPage.tsx`（3657 行）分五刀拆成 SettingsTasks / SettingsAgents /
    // SettingsPrompts / SettingsSkills / SettingsEval / SettingsMcp / SettingsContent /
    // SettingsData / SettingsAutomationPrefs / SettingsWebsearch（共享件进 settingsShared.ts），
    // 本体只剩 872 行编排——2026-09-30 移出本清单。
    // `App.tsx`（2080 行）同日分六刀拆成 ChatMessageRow / Welcome / ChatSearchOverlay /
    // ConversationList / useCollabChat + CollabPanel / useAttachments /
    // useVoicePlayback + ChatHeader，本体只剩 988 行（ChatView 状态机与编排）——同批移出。
    //
    // 它变多了 = 有人往大文件里继续堆；变少了 = 有人拆了，**这是好事，改这一行就行**。
    // 两种都应该让这条用例红一次，好过让那个数字没人看着。
    // `CompanionPage.tsx`（1045 行）同日拆出 TeachPane.tsx（394 行，教学面板）+
    // companionShared.ts，本体只剩 658 行（五个 pane 组合）——2026-09-30 移出本清单。
    // `NotesPage.tsx`（1512 行）分两刀拆出 useNoteChat/NoteChatPanel、
    // usePodcast/NotePodcastPanel、NoteCardsPanel（右栏三面板）与 NoteSidebar
    // （文件列表侧栏，随栏走的简报/搜索/语音分诊），本体只剩 973 行编排——移出本清单。
    //
    // 它变多了 = 有人往大文件里继续堆；变少了 = 有人拆了，**这是好事，改这一行就行**。
    // 两种都应该让这条用例红一次，好过让那个数字没人看着。
    // `ReviewPage.tsx`（1084 行）同日拆出 RecentPulse.tsx（最近三件套）+
    // ReviewOverview.tsx（概览屏）+ ReviewSummary.tsx（总结屏），本体只剩 768 行
    // （复习状态机 + 卡片视图 + 键盘 effect）——2026-09-30 移出本清单。
    // 方向 6 至此收官：台账清零。
    const over = sources()
      .map((s) => ({ name: s.name, n: s.text.replace(/\n$/, '').split('\n').length }))
      .filter((s) => s.n > 1000)
      .map((s) => s.name)
      .sort()
    expect(over).toEqual([])
  })
})
