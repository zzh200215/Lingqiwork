// 设置中心共享件（2026-10-02 设置中心改版）：SettingsPage 与十一个分区共用的
// 页面骨架与表单语言。此前每个分区自己发挥——卡片标题只有图标没有字、说明文字
// 混在控件旁边、原生 checkbox、编辑器永远摊在列表下面；这套件把「产品感」的
// 那几件事（信息层级 / 分组 / 行结构 / 编辑流程）定在一处：
//
//   SettingPage    分区页头：标题 + 一句说明 + 右上动作（不再只有图标）
//   SettingGroup   设置分组卡：组标题 + 组说明 + 分隔线行区
//   SettingRow     一行设置：左「标题 + 说明」，右「开关 / 下拉 / 小输入」
//   SettingField   纵排字段（抽屉表单里用）：label + 控件 + 提示
//   SettingSwitch  统一开关（替代原生 checkbox，role="switch"）
//   SettingActions 行尾按钮区
//   ResCard        资源卡（provider / MCP / 智能体 / 提示词 / 任务…的统一外壳）
//   Drawer         右侧抽屉：资源编辑器住在这里，页面负责浏览、抽屉负责编辑
//
// 视觉纪律沿用全站契约：分层靠边框不靠阴影（阴影只给浮层）、品牌色走 violet
// 工具类（它跟着皮肤变量走）、状态色 rose/amber/emerald/sky 各守语义。
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { X } from 'lucide-react'

/** 分区页头。**标题不画大**（text-lg）：顶栏面包屑已经念过「设置 · 通用」，
 *  这里要的是「这页管什么」的一句话，不是又一遍页名。 */
export function SettingPage({
  title,
  description,
  actions,
  children,
}: {
  title: string
  description?: ReactNode
  actions?: ReactNode
  children: ReactNode
}) {
  return (
    <div data-settings-section={title} className="flex animate-fade-in flex-col gap-5">
      <header className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
          {description ? (
            <p className="mt-0.5 text-sm leading-relaxed text-neutral-500 dark:text-neutral-400">
              {description}
            </p>
          ) : null}
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
      </header>
      {children}
    </div>
  )
}

/** 组卡头：标题 + 说明在左，动作在右，一条底边把头与内容分开。
 *  SettingGroup 用它；外观分区那些**自带卡壳**的块（皮肤库 / 当前皮肤）以及
 *  折叠卡**内部的小节**（`bare`：不带底边与内边距）也用它——
 *  「组头长什么样」只有这一处定义，卡壳怎么包由各页自便。 */
export function GroupHead({
  title,
  description,
  actions,
  bare = false,
}: {
  title?: ReactNode
  description?: ReactNode
  actions?: ReactNode
  /** 折叠卡内的小节用：只出标题行，不带底边与内边距 */
  bare?: boolean
}) {
  return (
    <div
      className={`flex items-start justify-between gap-x-4 gap-y-2 ${
        bare ? '' : 'border-b border-neutral-100 px-5 py-3.5 dark:border-neutral-800/80'
      }`}
    >
      <div className="min-w-0">
        {title ? <h3 className="text-sm font-semibold">{title}</h3> : null}
        {description ? (
          <p className="mt-0.5 text-xs leading-relaxed text-neutral-500 dark:text-neutral-400">
            {description}
          </p>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  )
}

/** 设置分组卡。默认给孩子们加分隔线（每组就是一列 SettingRow）；
 *  装的不是行而是成块内容（表格 / 表单 / 图墙）时传 `divide={false}`，
 *  内容自己包一层 `<div className="px-5 py-4">`。 */
export function SettingGroup({
  title,
  description,
  actions,
  divide = true,
  className,
  children,
}: {
  title?: ReactNode
  description?: ReactNode
  /** 组头右侧的动作（如「添加」） */
  actions?: ReactNode
  divide?: boolean
  className?: string
  children: ReactNode
}) {
  return (
    <section className={`wb-card ${className ?? ''}`} data-settings-group={typeof title === 'string' ? title : undefined}>
      {title || description || actions ? (
        <GroupHead title={title} description={description} actions={actions} />
      ) : null}
      <div className={divide ? 'divide-y divide-neutral-100 dark:divide-neutral-800/80' : ''}>
        {children}
      </div>
    </section>
  )
}

/** 一行设置：左「标题 + 说明」，右控件。控件窄（开关 / 下拉 / 小数字框）走右列；
 *  控件本身很宽（textarea、整行输入）时传 `stacked`，控件落在说明下面占满行。
 *  `htmlFor` 给了的话标题渲染成 `<label>`——数字框 / 下拉保持可点标题聚焦。 */
export function SettingRow({
  title,
  description,
  htmlFor,
  stacked = false,
  className,
  children,
}: {
  title: ReactNode
  description?: ReactNode
  htmlFor?: string
  stacked?: boolean
  className?: string
  children: ReactNode
}) {
  const head = (
    <>
      {htmlFor ? (
        <label htmlFor={htmlFor} className="text-sm font-medium">
          {title}
        </label>
      ) : (
        <p className="text-sm font-medium">{title}</p>
      )}
      {description ? (
        <p className="mt-0.5 text-xs leading-relaxed text-neutral-500 dark:text-neutral-400">
          {description}
        </p>
      ) : null}
    </>
  )
  if (stacked) {
    return (
      <div className={`px-5 py-3.5 ${className ?? ''}`}>
        <div className="mb-1.5">{head}</div>
        {children}
      </div>
    )
  }
  return (
    <div className={`flex items-center justify-between gap-x-6 gap-y-2 px-5 py-3.5 ${className ?? ''}`}>
      <div className="min-w-0">{head}</div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

/** 纵排字段：抽屉表单里的 label + 控件 + 一行提示。 */
export function SettingField({
  label,
  hint,
  className,
  children,
}: {
  label: ReactNode
  hint?: ReactNode
  className?: string
  children: ReactNode
}) {
  return (
    <label className={`flex flex-col gap-1 ${className ?? ''}`}>
      <span className="text-sm font-medium">{label}</span>
      {children}
      {hint ? (
        <span className="text-xs leading-relaxed text-neutral-400 dark:text-neutral-500">{hint}</span>
      ) : null}
    </label>
  )
}

/** 统一开关：全仓的原生 checkbox（设置域）都换这个。开关色用 violet 工具类
 *  ——它跟着皮肤强调色走；disabled 语义留给「被另一项牵着走」的项。 */
export function SettingSwitch({
  checked,
  onChange,
  disabled = false,
  ariaLabel,
  title,
}: {
  checked: boolean
  onChange: (next: boolean) => void
  disabled?: boolean
  ariaLabel?: string
  title?: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      title={title}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 shrink-0 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
        checked ? 'bg-violet-600' : 'bg-neutral-300 dark:bg-neutral-700'
      }`}
    >
      <span
        className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all ${
          checked ? 'left-[18px]' : 'left-0.5'
        }`}
      />
    </button>
  )
}

/** 行尾按钮区：`left` 槽放次要信息（提示文字 / 测试按钮），主按钮靠右。 */
export function SettingActions({
  left,
  children,
  className,
}: {
  left?: ReactNode
  children?: ReactNode
  className?: string
}) {
  return (
    <div className={`flex flex-wrap items-center justify-between gap-x-4 gap-y-2 ${className ?? ''}`}>
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">{left}</div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  )
}

/** 资源卡：provider / MCP server / 智能体 / 提示词 / 定时任务……的统一外壳。
 *  `title` 行放名字与徽标，`meta` 放一行摘要，`actions` 是右侧文字按钮列，
 *  `children` 是探测结果 / 运行记录这类展开体。 */
export function ResCard({
  title,
  meta,
  actions,
  className,
  children,
}: {
  title: ReactNode
  meta?: ReactNode
  actions?: ReactNode
  className?: string
  children?: ReactNode
}) {
  return (
    <div className={`rounded-lg border border-neutral-200 px-4 py-3 dark:border-neutral-800 ${className ?? ''}`}>
      <div className="flex items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">{title}</div>
          {meta ? <div className="mt-1 min-w-0 text-xs leading-relaxed text-neutral-500 dark:text-neutral-400">{meta}</div> : null}
        </div>
        {actions ? (
          <div className="flex shrink-0 flex-wrap justify-end gap-x-3 gap-y-1 text-sm">{actions}</div>
        ) : null}
      </div>
      {children}
    </div>
  )
}

/** 右侧抽屉（z-40，弹层分级约定）：资源编辑器的家。「页面负责浏览和管理，
 *  抽屉负责编辑」——列表下面那坨常驻表单从此消失，页面不再越改越长。
 *
 *  开抽屉时做三件小事：**焦点进面板**（键盘用户不用 Tab 穿背景）、
 *  **锁住背景滚动**（滚轮落在遮罩上不再透传给页面）、关了**归还焦点**。 */
/** 从 el 向上找最近的**真滚动容器**（overflow-y 为 auto/scroll）。
 *  不能只 `closest('main')`——那拿到的是最近的 main，不一定是会滚的那层；
 *  谁真的会滚由计算样式说了算，到头兜底 document 滚动条。 */
function findScrollParent(el: HTMLElement | null): HTMLElement | null {
  let cur = el?.parentElement ?? null
  while (cur) {
    const oy = getComputedStyle(cur).overflowY
    if (oy === 'auto' || oy === 'scroll') return cur
    cur = cur.parentElement
  }
  return document.scrollingElement instanceof HTMLElement ? document.scrollingElement : null
}

export function Drawer({
  open,
  onClose,
  title,
  description,
  children,
  footer,
}: {
  open: boolean
  onClose: () => void
  title: string
  description?: ReactNode
  children: ReactNode
  footer?: ReactNode
}) {
  const panelRef = useRef<HTMLElement>(null)
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    const panel = panelRef.current
    const prevFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    // 背景滚动锁：找到真正会滚的那层祖先再锁，锁错了等于没锁
    const scroller = findScrollParent(panel)
    const prevOverflow = scroller instanceof HTMLElement ? scroller.style.overflow : ''
    panel?.focus()
    if (scroller instanceof HTMLElement) scroller.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      if (scroller instanceof HTMLElement) scroller.style.overflow = prevOverflow
      prevFocus?.focus()
    }
  }, [open, onClose])
  if (!open) return null
  return (
    <div
      className="fixed inset-0 z-40"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      data-settings-drawer={title}
    >
      <div className="absolute inset-0 bg-neutral-950/30 dark:bg-black/50" onClick={onClose} />
      <aside
        ref={panelRef}
        tabIndex={-1}
        className="wb-drawer absolute inset-y-0 right-0 flex w-full max-w-xl flex-col border-l border-neutral-200 bg-white shadow-2xl outline-none dark:border-neutral-800 dark:bg-neutral-900"
      >
        <header className="flex items-start justify-between gap-x-4 border-b border-neutral-100 px-5 py-4 dark:border-neutral-800/80">
          <div className="min-w-0">
            <h3 className="font-semibold">{title}</h3>
            {description ? (
              <p className="mt-0.5 text-xs leading-relaxed text-neutral-500 dark:text-neutral-400">
                {description}
              </p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="rounded-md p-1 text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-neutral-700 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
          >
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer ? (
          <footer className="border-t border-neutral-100 px-5 py-3 dark:border-neutral-800/80">{footer}</footer>
        ) : null}
      </aside>
    </div>
  )
}

// ---------- 确认弹窗（替代 window.confirm）----------
//
// 原生 confirm() 是浏览器的一张脸，不是这张工作台的：阻塞主线程、样式不跟主题、
// 自动化测试也没法点。设置域的九处删除动作统一走这里：askConfirm() 发问，
// <ConfirmHost />（页面根部挂一次）作答。宿主没挂时退回原生 confirm——发问方
// 永远不用关心是哪条路。

export interface ConfirmOptions {
  title: string
  description?: ReactNode
  /** 确认按钮的文字（删除类动作给「删除」） */
  confirmLabel?: string
  /** 危险动作 = 确认按钮用 rose 实底（契约：错误=rose）。默认 true。 */
  danger?: boolean
}

let askHandler: ((q: ConfirmOptions) => Promise<boolean>) | null = null

export function askConfirm(opts: ConfirmOptions): Promise<boolean> {
  if (askHandler) return askHandler(opts)
  const desc = typeof opts.description === 'string' ? `\n${opts.description}` : ''
  return Promise.resolve(window.confirm(`${opts.title}${desc}`))
}

export function ConfirmHost() {
  const [q, setQ] = useState<ConfirmOptions | null>(null)
  const resolverRef = useRef<((v: boolean) => void) | null>(null)

  useEffect(() => {
    askHandler = (opts) =>
      new Promise<boolean>((resolve) => {
        resolverRef.current = resolve
        setQ(opts)
      })
    return () => {
      askHandler = null
    }
  }, [])

  useEffect(() => {
    if (!q) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // close 在下面以 useCallback 稳定；此处只依赖「有没有在问」
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q !== null])

  const close = (v: boolean) => {
    setQ(null)
    resolverRef.current?.(v)
    resolverRef.current = null
  }

  if (!q) return null
  const danger = q.danger !== false
  return (
    <div
      className="fixed inset-0 z-50"
      role="alertdialog"
      aria-modal="true"
      aria-label={q.title}
      data-settings-confirm={q.title}
    >
      <div className="absolute inset-0 bg-neutral-950/40 dark:bg-black/60" onClick={() => close(false)} />
      <div className="wb-float absolute left-1/2 top-1/2 w-[min(92vw,420px)] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-neutral-200 bg-white p-5 shadow-2xl dark:border-neutral-800 dark:bg-neutral-900">
        <h3 className="font-semibold">{q.title}</h3>
        {q.description ? (
          <p className="mt-1.5 text-sm leading-relaxed text-neutral-500 dark:text-neutral-400">{q.description}</p>
        ) : null}
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={() => close(false)}
            className="rounded-md px-3 py-1.5 text-sm text-neutral-500 transition-colors hover:text-neutral-800 dark:hover:text-neutral-200"
          >
            取消
          </button>
          <button
            type="button"
            autoFocus
            data-confirm-ok=""
            onClick={() => close(true)}
            className={
              danger
                ? 'rounded-md bg-rose-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-rose-500'
                : 'wb-btn-primary px-3 py-1.5 text-sm'
            }
          >
            {q.confirmLabel ?? '确认'}
          </button>
        </div>
      </div>
    </div>
  )
}
