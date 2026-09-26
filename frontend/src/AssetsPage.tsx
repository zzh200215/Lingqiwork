/** 资产 — 你攒下的一切。
 *
 *  2026-09-18 导航改版：笔记 / 知识库 / 仪表盘 这三个库的入口卡**删掉了**——它们现在是
 *  侧栏「资产」那一组里的子项，留在页面上就是同一件事两个入口。
 *
 *  **同日「内容太少」那一轮**：删掉入口卡之后这一页只剩一张产出清单，量下来整页
 *  205 字（同一台机器的仪表盘是 2905 字）——「看着空」的根因是**这一页摆的事太少**，
 *  不是留白。所以补三块**真数据**（都不是新真值，全是别处已经在用的查询）：
 *    ① 家底：笔记 / 产出 / 技能 / 提示词 / 记忆 / 这周打开过几天（`/api/dashboard` +
 *       `/api/skills` + `/api/dashboard/prompt-eval`）；
 *    ② 最近动过：vault 里 mtime 最新的几篇（`/api/notes`，点开进笔记页）；
 *    ③ 技能：`skills/` 目录里那几份（名字 + 体量）。
 *
 *  **每块各自 try/except**：一块读不到不许拖垮整页，读不到就**不摆**（§4-9），
 *  而不是摆一排 0（§4-8）。
 *
 *  2026-09-19 Bento 改版：家底六块砖换成彩色图标 chip（色按板块固定，不随数值变）；
 *  新增两张**用产出清单自己算的图**——类型分布（按 `kind` 分桶）与近 14 天节奏
 *  （按 `date` 分桶，空天画 0）。数据还是 `/api/work/outputs` 那一份，一块不多要。
 */
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Brain, CalendarCheck, FlaskConical, NotebookPen, Package, Zap } from 'lucide-react'

import EChart from './EChart'
import { api, type PromptEvalBoard, type SkillItem, type WorkOutput } from './api'
import EmptyHint from './EmptyHint'
import OutputCard from './OutputCard'
import PageShell from './PageShell'
import StatTile from './StatTile'
import { ago } from './reltime'

interface NoteFile {
  path: string
  mtime: number
}

interface House {
  vault_files: number | null
  memories: number | null
  open_days_7d: number | null
}

/** 与工作页筛选条同一套叫法（`WorkPage.tsx` 的 `KINDS`）——同一件事两个名字是分叉。 */
const KIND_LABEL: Record<WorkOutput['kind'], string> = {
  research: '研究',
  compose: '成文',
  recap: '复盘',
  decide: '方案',
  conflict: '对质',
  deliver: '交付',
  task: '工作流',
}

/** 近 N 天的产出节奏：`date`（YYYY-MM-DD）分桶，没产出的天画 0——节奏图的意义
 *  就在于空白也是信息。 */
function dailyBuckets(outputs: WorkOutput[], days: number): { date: string; count: number }[] {
  const out: { date: string; count: number }[] = []
  const counts = new Map<string, number>()
  for (const o of outputs) counts.set(o.date, (counts.get(o.date) ?? 0) + 1)
  const today = new Date()
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today)
    d.setDate(d.getDate() - i)
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    out.push({ date: key, count: counts.get(key) ?? 0 })
  }
  return out
}

export default function AssetsPage() {
  const [outputs, setOutputs] = useState<WorkOutput[] | null>(null)
  const [house, setHouse] = useState<House>({ vault_files: null, memories: null, open_days_7d: null })
  const [notes, setNotes] = useState<NoteFile[] | null>(null)
  const [skills, setSkills] = useState<SkillItem[] | null>(null)
  const [prompts, setPrompts] = useState<PromptEvalBoard | null>(null)

  useEffect(() => {
    // 每一块**各自** catch：一块坏了只让那一块不出现，页面其余照常（§4-9 增强不挡路）
    api
      .workOutputs()
      .then((r) => setOutputs(r.outputs))
      .catch(() => setOutputs([]))
    api
      .dashboard()
      .then((d) =>
        setHouse({
          vault_files: d.vault_files ?? null,
          memories: d.memories ?? null,
          open_days_7d: d.open_days_7d ?? null,
        })
      )
      .catch(() => {})
    api
      .listNotes()
      .then((r) => setNotes(r.files))
      .catch(() => {})
    api
      .listSkills()
      .then((r) => setSkills(r.skills))
      .catch(() => {})
    api
      .promptEvalBoard()
      .then(setPrompts)
      .catch(() => {})
  }, [])

  const recent = (outputs ?? []).slice(0, 10)
  const recentNotes = (notes ?? []).slice(0, 6)
  const hasHouse = Object.values(house).some((v) => v !== null) || outputs !== null || skills !== null

  // 两张图的数据都从产出清单这一份里算（useMemo：清单没变就算过了）
  const kindData = useMemo(() => {
    if (!outputs || outputs.length === 0) return []
    const counts = new Map<WorkOutput['kind'], number>()
    for (const o of outputs) counts.set(o.kind, (counts.get(o.kind) ?? 0) + 1)
    return [...counts.entries()].map(([kind, value]) => ({ name: KIND_LABEL[kind], value }))
  }, [outputs])

  const dailyData = useMemo(() => (outputs ? dailyBuckets(outputs, 14) : []), [outputs])

  return (
    <PageShell
      title="资产"
      description="你攒下的东西：跑出来的成品、写下的笔记、练成的技能——各有多少，一眼看完。"
    >
      {hasHouse ? (
        <section className="mb-8" data-assets-house>
          <h2 className="pb-2 text-sm font-semibold text-neutral-700 dark:text-neutral-200">家底</h2>
          <div className="grid gap-3 sm:grid-cols-3 xl:grid-cols-6">
            <StatTile
              icon={<NotebookPen className="h-4 w-4" />}
              accent="bg-sky-100 text-sky-600 dark:bg-sky-400/15 dark:text-sky-300"
              label="vault 笔记"
              value={house.vault_files}
              href="/notes"
              sub="全部 .md，都在索引里"
            />
            <StatTile
              icon={<Package className="h-4 w-4" />}
              accent="bg-violet-100 text-violet-600 dark:bg-violet-400/15 dark:text-violet-300"
              label="产出物"
              value={outputs?.length ?? null}
              href="/work?tab=report"
              sub="研究 / 报告 / 复盘…"
            />
            <StatTile
              icon={<Zap className="h-4 w-4" />}
              accent="bg-emerald-100 text-emerald-600 dark:bg-emerald-400/15 dark:text-emerald-300"
              label="技能"
              value={skills?.length ?? null}
              sub={skills?.length ? '跑过对照的才算数' : '还没有'}
            />
            <StatTile
              icon={<FlaskConical className="h-4 w-4" />}
              accent="bg-amber-100 text-amber-600 dark:bg-amber-400/15 dark:text-amber-300"
              label="登记的提示词"
              value={prompts?.registered ?? null}
              sub={prompts ? `${prompts.measured} 条量过` : undefined}
            />
            <StatTile
              icon={<Brain className="h-4 w-4" />}
              accent="bg-pink-100 text-pink-600 dark:bg-pink-400/15 dark:text-pink-300"
              label="长期记忆"
              value={house.memories}
              sub="零柒记下的事"
            />
            <StatTile
              icon={<CalendarCheck className="h-4 w-4" />}
              accent="bg-neutral-200/70 text-neutral-500 dark:bg-neutral-700/50 dark:text-neutral-300"
              label="这周打开过"
              value={house.open_days_7d === null ? null : `${house.open_days_7d} 天`}
              sub="本地使用记录"
            />
          </div>
        </section>
      ) : null}

      {kindData.length > 0 ? (
        <div className="mb-8 grid items-start gap-4 xl:grid-cols-2">
          <section className="wb-card p-4">
            <h2 className="pb-1 text-sm font-semibold text-neutral-700 dark:text-neutral-200">
              产出物类型
            </h2>
            <p className="pb-2 text-xs text-neutral-400">共 {outputs!.length} 件 · 按体裁分</p>
            <EChart
              height={200}
              ariaLabel="产出物类型分布"
              option={{
                tooltip: { trigger: 'item' },
                legend: { bottom: 0, itemWidth: 10, itemHeight: 10, icon: 'circle' },
                series: [
                  {
                    type: 'pie',
                    radius: ['52%', '78%'],
                    center: ['50%', '44%'],
                    itemStyle: { borderRadius: 6, borderWidth: 2 },
                    label: { show: false },
                    data: kindData,
                  },
                ],
              }}
            />
          </section>
          <section className="wb-card p-4">
            <h2 className="pb-1 text-sm font-semibold text-neutral-700 dark:text-neutral-200">
              近 14 天的产出节奏
            </h2>
            <p className="pb-2 text-xs text-neutral-400">每天落进 vault 的成品数（按产出里的日期）</p>
            <EChart
              height={200}
              ariaLabel="近 14 天产出节奏"
              option={{
                tooltip: { trigger: 'axis' },
                grid: { left: 32, right: 8, top: 10, bottom: 24 },
                xAxis: {
                  type: 'category',
                  data: dailyData.map((d) => d.date.slice(5)),
                  axisTick: { show: false },
                },
                yAxis: { type: 'value', minInterval: 1 },
                series: [
                  {
                    type: 'bar',
                    data: dailyData.map((d) => d.count),
                    barMaxWidth: 18,
                    itemStyle: { borderRadius: [4, 4, 0, 0] },
                  },
                ],
              }}
            />
          </section>
        </div>
      ) : null}

      <div className="grid items-start gap-6 xl:grid-cols-[1.6fr_1fr]">
        <section>
          <div className="flex items-baseline justify-between pb-2">
            <h2 className="text-sm font-semibold text-neutral-700 dark:text-neutral-200">产出物</h2>
            {(outputs?.length ?? 0) > 0 ? (
              <Link to="/work?tab=report" className="text-xs text-violet-500 hover:underline">
                全部 {outputs!.length} 件 → 工作页
              </Link>
            ) : null}
          </div>

          {outputs === null ? null : recent.length === 0 ? (
            <EmptyHint
              title="还没有产出。"
              hint={
                <>
                  去
                  <Link to="/work" className="text-violet-500 hover:underline">
                    工作
                  </Link>
                  写一份交付，或在
                  <Link to="/tutor" className="text-violet-500 hover:underline">
                    学
                  </Link>
                  里跑一轮研究——成品会自动落到这里。
                </>
              }
            />
          ) : (
            <ul className="wb-card divide-y divide-neutral-100 px-4 dark:divide-neutral-800/70">
              {recent.map((o) => (
                <li key={o.path}>
                  <OutputCard
                    kind={o.kind}
                    label={o.label}
                    title={o.title}
                    href={`/notes?path=${encodeURIComponent(o.path)}`}
                    actions={<span className="text-xs text-neutral-400">{o.date.slice(5)}</span>}
                  />
                </li>
              ))}
            </ul>
          )}
        </section>

        <div className="flex flex-col gap-6">
          {recentNotes.length > 0 ? (
            <section data-assets-recent>
              <div className="flex items-baseline justify-between pb-2">
                <h2 className="text-sm font-semibold text-neutral-700 dark:text-neutral-200">
                  最近动过
                </h2>
                <Link to="/notes" className="text-xs text-violet-500 hover:underline">
                  全部 →
                </Link>
              </div>
              <ul className="wb-card divide-y divide-neutral-100 px-3 dark:divide-neutral-800/70">
                {recentNotes.map((n) => (
                  <li key={n.path}>
                    <Link
                      to={`/notes?path=${encodeURIComponent(n.path)}`}
                      className="flex items-baseline gap-2 py-2 text-xs text-neutral-600 transition-colors hover:text-violet-600 dark:text-neutral-300 dark:hover:text-violet-300"
                    >
                      <span className="min-w-0 flex-1 truncate" title={n.path}>
                        {n.path}
                      </span>
                      <span className="shrink-0 text-xs text-neutral-400">{ago(n.mtime)}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {skills && skills.length > 0 ? (
            <section data-assets-skills>
              <h2 className="pb-2 text-sm font-semibold text-neutral-700 dark:text-neutral-200">
                技能
              </h2>
              <ul className="wb-card divide-y divide-neutral-100 px-3 dark:divide-neutral-800/70">
                {skills.slice(0, 6).map((s) => (
                  <li key={s.name} className="py-2">
                    <p className="truncate text-xs font-medium text-neutral-700 dark:text-neutral-200">
                      {s.name}
                    </p>
                    <p className="pt-0.5 line-clamp-2 text-xs leading-relaxed text-neutral-400">
                      {s.description || `${s.chars} 字`}
                    </p>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      </div>
    </PageShell>
  )
}
