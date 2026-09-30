import type { Dispatch, SetStateAction } from 'react'
import { Link } from 'react-router-dom'
import { RotateCw } from 'lucide-react'
import CardList from './CardList'
import EChart from './EChart'
import HabitStrip, { type HabitStripHandle } from './HabitStrip'
import RecentPulse from './RecentPulse'
import SelfCheckLine from './SelfCheckLine'
import type { CardStats, TodaySummaryRow } from './api'

// 概览屏（phase === 'overview'）——JSX 从 ReviewPage 原样搬来（方向 6）。
// 复习 hero、近 7 天柱状图、五档概览、习惯条与「最近」三件套；开考与建卡
// 仍是宿主的动作，经 props 进来。habits ref 住宿主（键盘 effect 要用）。
export default function ReviewOverview(props: {
  stats: CardStats | null
  total: number
  truncated: boolean
  dueTotal: number
  cap: number
  start: () => void
  setMakerOpen: Dispatch<SetStateAction<boolean>>
  summary: TodaySummaryRow[]
  habits: { current: HabitStripHandle | null }
  setHabitSummary: Dispatch<SetStateAction<{ done: number; total: number }>>
}) {
  const { stats, total, truncated, dueTotal, cap, start, setMakerOpen, summary, habits, setHabitSummary } = props
  return (
          <div className="space-y-4">
            {/* bento 第一行：复习 hero（7 列）+ 近 7 天柱状图（5 列）并排；
                daily 没数据时 hero 独占整行，不留一块空洞。 */}
            <div className="grid grid-cols-1 items-stretch gap-4 xl:grid-cols-12">
              <section
                className={`wb-card-hero rounded-lg p-4 ${
                  stats && stats.daily?.length > 0 ? 'xl:col-span-7' : 'xl:col-span-12'
                }`}
              >
                <div className="flex items-center gap-3">
                  <span className="wb-chip h-9 w-9 bg-white/70 text-violet-600 dark:bg-neutral-800/60 dark:text-violet-300">
                    <RotateCw className="h-4 w-4" />
                  </span>
                  <span className="text-sm font-medium">复习</span>
                  {total > 0 ? (
                    <>
                      <span className="text-sm text-neutral-500 dark:text-neutral-400">
                        {total} 张到期
                        {truncated && `（共 ${dueTotal} 张，今天先过 ${cap}）`}
                      </span>
                      <button
                        onClick={start}
                        className="ml-auto rounded-lg bg-gradient-to-r from-violet-600 to-fuchsia-600 px-4 py-1.5 text-sm font-medium text-white transition-all hover:brightness-110"
                      >
                        开始复习 <kbd className="ml-1 text-xs opacity-80">⏎</kbd>
                      </button>
                    </>
                  ) : (
                    <span className="text-sm text-neutral-500 dark:text-neutral-400">
                      {stats && stats.total > 0
                        ? stats.next_due
                          ? `今天清完了 · 下一张 ${new Date(stats.next_due).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} 到期`
                          : '今天清完了'
                        : '还没有卡片'}
                    </span>
                  )}
                </div>
                {stats && stats.total > 0 ? (
                  <p className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1 pl-12 text-xs text-neutral-400 dark:text-neutral-500">
                    <span>今天已过 {stats.today_reviewed}</span>
                    <span>还剩 {stats.remaining_today}</span>
                    {stats.streak > 0 ? <span>连续 {stats.streak} 天</span> : null}
                    {stats.accuracy_7d != null ? <span>7 天正确率 {stats.accuracy_7d}%</span> : null}
                  </p>
                ) : null}
                {(!stats || stats.total === 0) && (
                  <div className="mt-3 border-t border-neutral-200/80 pt-3 dark:border-neutral-800/80">
                    <p className="mb-2 text-xs text-neutral-500 dark:text-neutral-400">
                      最快的建卡方式：打开一篇笔记，选中一句话按「🎴 挖空」。不调模型，不花钱。
                    </p>
                    <div className="flex flex-wrap gap-2">
                      <button
                        onClick={() => setMakerOpen(true)}
                        className="rounded-lg bg-gradient-to-r from-violet-600 to-fuchsia-600 px-3 py-1.5 text-sm font-medium text-white transition-all hover:brightness-110"
                      >
                        建第一张卡 <kbd className="ml-1 text-xs opacity-80">N</kbd>
                      </button>
                      <Link
                        to="/notes"
                        className="rounded-lg border border-neutral-200 px-3 py-1.5 text-sm text-neutral-600 transition-colors hover:border-violet-400 hover:text-violet-600 dark:border-neutral-700 dark:text-neutral-300"
                      >
                        去笔记页划词
                      </Link>
                    </div>
                  </div>
                )}
              </section>

              {/* 近 7 天的复习量：`/api/cards/stats` 的 `daily` 后端一直在算、此前一直没画——
                  这里把它摆出来。空天画 0，节奏的空白也是信息。 */}
              {stats && stats.daily?.length > 0 ? (
                <section className="wb-card p-4 xl:col-span-5">
                  <h2 className="pb-1 text-sm font-semibold text-neutral-700 dark:text-neutral-200">
                    近 7 天复习
                  </h2>
                  <p className="pb-2 text-xs text-neutral-400">
                    每天过的卡数 · 7 天正确率 {stats.accuracy_7d != null ? `${stats.accuracy_7d}%` : '—'}
                  </p>
                  <EChart
                    height={160}
                    ariaLabel="近 7 天复习量"
                    option={{
                      tooltip: { trigger: 'axis' },
                      grid: { left: 30, right: 8, top: 10, bottom: 24 },
                      xAxis: {
                        type: 'category',
                        data: stats.daily.map((d) => d.date.slice(5)),
                        axisTick: { show: false },
                      },
                      yAxis: { type: 'value', minInterval: 1 },
                      series: [
                        {
                          type: 'bar',
                          data: stats.daily.map((d) => d.count),
                          barMaxWidth: 22,
                          itemStyle: { borderRadius: [5, 5, 0, 0] },
                        },
                      ],
                    }}
                  />
                </section>
              ) : null}
            </div>

            {/* bento 第二行：五档概览（7 列）+ 习惯条（5 列）；概览空档时习惯条独占整行 */}
            <div className="grid grid-cols-1 items-stretch gap-4 xl:grid-cols-12">
              {summary.length > 0 && (
                <section className="wb-card px-4 py-2.5 xl:col-span-7">
                  {/* 五档概览：失败任务 > 未消化 > 到期卡 > 卡点 > 进行中产出，每行带直达。
                      空档后端就不返回，所以这里没有 0 行。和 `next_suggestion` 那句建议不同：
                      那是「说一句」，这是「有几件、在哪」——计数是让你一眼看完全局。
                      2026-09-19：计数后面补一条同色的比例条——最大的那档撑满，其余按份量排。 */}
                  <ul className="divide-y divide-neutral-100 dark:divide-neutral-800/70">
                    {summary.map((r) => {
                      const max = Math.max(...summary.map((x) => x.count), 1)
                      return (
                        <li key={r.key} className="flex items-center gap-3 py-2">
                          <span
                            className={`w-20 shrink-0 text-xs font-medium ${
                              r.tone === 'bad'
                                ? 'text-rose-600 dark:text-rose-400'
                                : r.tone === 'warn'
                                  ? 'text-amber-600 dark:text-amber-400'
                                  : 'text-neutral-500 dark:text-neutral-400'
                            }`}
                          >
                            {r.label}
                          </span>
                          <span className="w-6 shrink-0 text-sm font-semibold tabular-nums text-neutral-700 dark:text-neutral-200">
                            {r.count}
                          </span>
                          <span className="hidden h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-neutral-100 sm:block dark:bg-neutral-800">
                            <span
                              className={`block h-full rounded-full ${
                                r.tone === 'bad'
                                  ? 'bg-rose-400'
                                  : r.tone === 'warn'
                                    ? 'bg-amber-400'
                                    : 'bg-violet-400'
                              }`}
                              style={{ width: `${Math.max((r.count / max) * 100, 4)}%` }}
                            />
                          </span>
                          <Link
                            to={r.href}
                            className="ml-auto shrink-0 rounded-lg border border-neutral-300 px-2.5 py-0.5 text-xs text-neutral-600 transition-colors hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800 sm:ml-3"
                          >
                            去处理 →
                          </Link>
                        </li>
                      )
                    })}
                  </ul>
                </section>
              )}

              <div className={summary.length > 0 ? 'xl:col-span-5' : 'xl:col-span-12'}>
                <HabitStrip
                  ref={habits}
                  onSummary={(done, total_) => setHabitSummary({ done, total: total_ })}
                />
              </div>
            </div>

            {/* 2026-09-18「内容太少」那一轮加的：这一页原来只有复习 + 习惯 + 自检三块，
                量下来整页 205 字（仪表盘是 2905 字）。补的都是**同一台机器上已经存在的
                事实**，只是以前没有一处把它们摆出来：
                  · 零柒最近说过什么（`pet_events`，与挂件那个气泡同一张表）
                  · 最近聊过什么（`/api/conversations`，与侧栏那份同一来源）
                  · 这周的足迹（打开过几天 / 消息数 / vault 新增，`/api/dashboard`）
                **每一块各自 catch**：读不到就不摆（§4-9），不摆一排 0（§4-8）。 */}
            <RecentPulse />

            <SelfCheckLine />

            {/* 卡片的清单界面（此前没有）——「事」上要能挂卡片，就得先能看见它们 */}
            <CardList />
          </div>
  )
}
