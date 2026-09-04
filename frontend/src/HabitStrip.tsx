import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type Ref,
} from 'react'

import { api, type Habit, type HabitKind, type HabitToday } from './api'

// The habit half of the 今日 page. Own component rather than more lines inside
// ReviewPage (already 560) — same split as CardMaker.
//
// Management is inline here, not in SettingsPage: the thing you edit should sit
// where you see it, and that file is 2798 lines already. No prefs switch either —
// an empty grid costs nothing, so there is nothing to turn off.

const DOW = ['一', '二', '三', '四', '五', '六', '日']
const ALL_DAYS = '1111111'

export interface HabitStripHandle {
  /** Toggle the Nth (1-based) scheduled habit — the 今日 page's number keys. */
  toggleNth: (n: number) => void
  openAdd: () => void
}

function Heatmap({ history, days }: { history: string[]; days: number }) {
  const done = new Set(history)
  const cells: { key: string; on: boolean }[] = []
  const today = new Date()
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today)
    d.setDate(d.getDate() - i)
    // local date string, matching the server's date(col,'localtime')
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
      d.getDate()
    ).padStart(2, '0')}`
    cells.push({ key, on: done.has(key) })
  }
  return (
    <div className="flex gap-[2px]">
      {cells.map((c) => (
        <span
          key={c.key}
          title={c.key}
          className={`h-2.5 w-2.5 rounded-[2px] ${
            c.on
              ? 'bg-emerald-500 dark:bg-emerald-500'
              : 'bg-neutral-200 dark:bg-neutral-800'
          }`}
        />
      ))}
    </div>
  )
}

const BLANK = {
  name: '',
  icon: '',
  kind: 'check' as HabitKind,
  target: 1,
  unit: '',
  weekdays: ALL_DAYS,
}

export default function HabitStrip({
  ref,
  onSummary,
}: {
  ref?: Ref<HabitStripHandle>
  onSummary?: (done: number, total: number) => void
}) {
  const [data, setData] = useState<HabitToday | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState<number | 'new' | null>(null)
  const [form, setForm] = useState(BLANK)

  // kept in a ref so `load` has no unstable deps — an inline parent lambda
  // would otherwise re-create load every render and re-fire the effect forever
  const cb = useRef(onSummary)
  cb.current = onSummary

  const load = useCallback(async () => {
    try {
      const d = await api.habitsToday()
      setData(d)
      cb.current?.(d.done, d.total)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const toggle = useCallback(
    async (h: Habit) => {
      if (h.auto) {
        setError('「' + h.name + '」由复习记录自动判定，不用手动打勾')
        return
      }
      setBusy(true)
      setError('')
      try {
        // count habits accumulate until the target is met; pressing again once
        // done clears the day, so a mis-tap is always one keystroke from undone
        if (h.done) await api.untickHabit(h.id)
        else await api.tickHabit(h.id, h.kind === 'count' ? { value: 1 } : {})
        await load()
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        setBusy(false)
      }
    },
    [load]
  )

  const live = (data?.habits ?? []).filter((h) => h.scheduled)

  useImperativeHandle(
    ref,
    () => ({
      toggleNth: (n: number) => {
        const h = live[n - 1]
        if (h) void toggle(h)
      },
      openAdd: () => {
        setForm(BLANK)
        setEditing('new')
      },
    }),
    [live, toggle]
  )

  async function seed() {
    setBusy(true)
    try {
      await api.seedHabits()
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function submit() {
    if (!form.name.trim()) {
      setError('先起个名字')
      return
    }
    setBusy(true)
    setError('')
    try {
      const shared = {
        name: form.name.trim(),
        icon: form.icon,
        target: form.kind === 'count' ? form.target : 1,
        unit: form.unit,
        weekdays: form.weekdays,
      }
      if (editing === 'new') await api.createHabit({ ...shared, kind: form.kind })
      else if (editing != null) await api.updateHabit(editing, shared)
      setEditing(null)
      setForm(BLANK)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function archive(h: Habit) {
    if (!window.confirm(`归档「${h.name}」？历史记录保留，只是不再出现在今日。`)) return
    setBusy(true)
    try {
      await api.updateHabit(h.id, { archived: true })
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  function startEdit(h: Habit) {
    setForm({
      name: h.name,
      icon: h.icon,
      kind: h.kind,
      target: h.target,
      unit: h.unit,
      weekdays: h.weekdays,
    })
    setEditing(h.id)
  }

  const inputCls =
    'rounded-md border border-neutral-300 bg-white px-2 py-1 text-sm outline-none focus:border-violet-500 dark:border-neutral-700 dark:bg-neutral-900'

  return (
    <section className="rounded-2xl border border-neutral-200/80 bg-white p-4 dark:border-neutral-800/80 dark:bg-neutral-900/40">
      <div className="mb-3 flex items-center gap-2">
        <span className="text-sm font-medium">✅ 习惯</span>
        {data && data.total > 0 && (
          <span className="text-sm text-neutral-500 dark:text-neutral-400">
            {data.done}/{data.total}
          </span>
        )}
        <button
          onClick={() => {
            setForm(BLANK)
            setEditing('new')
          }}
          className="ml-auto text-xs text-neutral-400 transition-colors hover:text-violet-600 dark:hover:text-violet-300"
        >
          ＋ 添加 <kbd className="text-[10px]">A</kbd>
        </button>
      </div>

      {error && (
        <p className="mb-2 rounded-md bg-rose-50 px-2.5 py-1.5 text-xs text-rose-600 dark:bg-rose-500/10 dark:text-rose-300">
          {error}
        </p>
      )}

      {data && data.habits.length === 0 && editing === null && (
        <div className="flex flex-col items-start gap-2 py-2">
          <p className="text-sm text-neutral-500 dark:text-neutral-400">
            还没有习惯。第一条是「今日复习」，它会跟着复习记录自己打勾。
          </p>
          <button
            onClick={() => void seed()}
            disabled={busy}
            className="rounded-lg bg-gradient-to-r from-violet-600 to-fuchsia-600 px-3 py-1.5 text-sm font-medium text-white transition-all hover:brightness-110 disabled:opacity-50"
          >
            一键添加 3 个建议习惯
          </button>
        </div>
      )}

      <div className="space-y-1">
        {(data?.habits ?? []).map((h) => {
          const n = live.indexOf(h) + 1
          return (
            <div
              key={h.id}
              className={`group flex items-center gap-2 rounded-lg px-2 py-1.5 transition-colors ${
                h.scheduled ? 'hover:bg-neutral-50 dark:hover:bg-neutral-800/50' : 'opacity-40'
              }`}
            >
              <span className="w-4 shrink-0 text-center text-[10px] text-neutral-400">
                {h.scheduled && n >= 1 && n <= 9 ? n : ''}
              </span>
              <button
                onClick={() => void toggle(h)}
                disabled={busy || !h.scheduled}
                title={
                  h.auto
                    ? '跟着复习记录自动打勾'
                    : h.kind === 'count'
                      ? `每按一次 +1${h.unit}，满了再按清零`
                      : '打勾 / 取消'
                }
                className={`flex h-5 w-5 shrink-0 items-center justify-center rounded border text-[11px] transition-colors ${
                  h.done
                    ? 'border-emerald-500 bg-emerald-500 text-white'
                    : 'border-neutral-300 text-transparent hover:border-emerald-400 dark:border-neutral-600'
                } ${h.auto ? 'cursor-default opacity-80' : ''}`}
              >
                ✓
              </button>
              <span className="shrink-0">{h.icon}</span>
              <span className="min-w-0 flex-1 truncate text-sm">{h.name}</span>
              {h.kind === 'count' && (
                <span className="shrink-0 text-xs text-neutral-500 dark:text-neutral-400">
                  {Math.round(h.value)}/{Math.round(h.target)}
                  {h.unit}
                </span>
              )}
              {h.auto && <span className="shrink-0 text-[10px] text-neutral-400">⟳ 自动</span>}
              {h.streak > 0 && (
                <span className="shrink-0 text-xs text-amber-600 dark:text-amber-400">
                  🔥{h.streak}
                </span>
              )}
              <span className="hidden shrink-0 sm:block">
                <Heatmap history={h.history} days={data?.heatmap_days ?? 30} />
              </span>
              <button
                onClick={() => startEdit(h)}
                className="shrink-0 text-[10px] text-neutral-300 opacity-0 transition-opacity hover:text-violet-600 group-hover:opacity-100 dark:text-neutral-600 dark:hover:text-violet-300"
              >
                编辑
              </button>
            </div>
          )
        })}
      </div>

      {editing !== null && (
        <div className="mt-3 space-y-2 rounded-xl border border-violet-200 p-3 dark:border-violet-500/40">
          <div className="flex gap-2">
            <input
              value={form.icon}
              onChange={(e) => setForm((f) => ({ ...f, icon: e.target.value.slice(0, 2) }))}
              placeholder="🏃"
              className={`${inputCls} w-12 text-center`}
            />
            <input
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submit()
                if (e.key === 'Escape') setEditing(null)
              }}
              placeholder="习惯名称"
              autoFocus
              className={`${inputCls} min-w-0 flex-1`}
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {editing === 'new' && (
              <select
                value={form.kind}
                onChange={(e) => setForm((f) => ({ ...f, kind: e.target.value as HabitKind }))}
                className={`${inputCls} w-24`}
              >
                <option value="check">打勾</option>
                <option value="count">计量</option>
              </select>
            )}
            {form.kind === 'count' && (
              <>
                <input
                  type="number"
                  min={1}
                  value={form.target}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, target: Math.max(1, Number(e.target.value) || 1) }))
                  }
                  className={`${inputCls} w-20`}
                />
                <input
                  value={form.unit}
                  onChange={(e) => setForm((f) => ({ ...f, unit: e.target.value.slice(0, 8) }))}
                  placeholder="分钟"
                  className={`${inputCls} w-16`}
                />
              </>
            )}
          </div>

          <div className="flex items-center gap-1">
            <span className="mr-1 text-xs text-neutral-500 dark:text-neutral-400">周</span>
            {DOW.map((d, i) => (
              <button
                key={d}
                onClick={() =>
                  setForm((f) => ({
                    ...f,
                    weekdays: f.weekdays
                      .split('')
                      .map((c, n) => (n === i ? (c === '1' ? '0' : '1') : c))
                      .join(''),
                  }))
                }
                className={`h-6 w-6 rounded text-[11px] transition-colors ${
                  form.weekdays[i] === '1'
                    ? 'bg-violet-100 text-violet-700 dark:bg-violet-500/20 dark:text-violet-300'
                    : 'text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800'
                }`}
              >
                {d}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => void submit()}
              disabled={busy}
              className="rounded-lg bg-gradient-to-r from-violet-600 to-fuchsia-600 px-3 py-1 text-xs font-medium text-white transition-all hover:brightness-110 disabled:opacity-50"
            >
              {editing === 'new' ? '添加' : '保存'}
            </button>
            <button
              onClick={() => {
                setEditing(null)
                setError('')
              }}
              className="text-xs text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-200"
            >
              取消
            </button>
            {editing !== 'new' && (
              <button
                onClick={() => {
                  const h = data?.habits.find((x) => x.id === editing)
                  if (h) void archive(h)
                  setEditing(null)
                }}
                className="ml-auto text-xs text-neutral-400 hover:text-rose-600 dark:hover:text-rose-400"
              >
                归档
              </button>
            )}
          </div>
        </div>
      )}
    </section>
  )
}
