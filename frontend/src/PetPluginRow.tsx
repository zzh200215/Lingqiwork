// 面板底部的一格插件。三种面板（计数 / 计时 / 心情）各是一行动作。
// （方向 6 第四刀，2026-09-29 自 PetWidget 拆出——心情那排表情也只有这里用。）
import type { PetPlugin } from './api'

// 心情 1–5 的表情。index 0 = 1 分。面板里点一下就记下今天的心情。
const MOOD_FACES = ['😞', '😕', '😐', '🙂', '😄']

export default function PetPluginRow({
  p,
  onCommand,
}: {
  p: PetPlugin
  onCommand: (name: string, command: string, args?: Record<string, unknown>) => void
}) {
  const row = 'flex items-center gap-2 text-xs text-neutral-600 dark:text-neutral-300'
  const btn =
    'rounded-md border border-neutral-300 px-2 py-0.5 text-xs transition-colors hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800'

  if (p.panel.kind === 'counter') {
    return (
      <div className={row}>
        <span>💧 {p.label}</span>
        <span className="text-neutral-400 dark:text-neutral-500">
          {p.panel.value ?? 0}/{p.panel.target ?? 0} {p.panel.unit ?? ''}
        </span>
        <div className="flex-1" />
        <button className={btn} onClick={() => onCommand(p.name, 'drink')}>
          +1 杯
        </button>
      </div>
    )
  }

  if (p.panel.kind === 'mood') {
    const v = p.panel.value ?? 0
    return (
      <div className={row}>
        <span>🙂 {p.label}</span>
        <span className="text-neutral-400 dark:text-neutral-500">
          {v ? `今天 ${v}/${p.panel.scale ?? 5}` : '今天还没记'}
        </span>
        <div className="flex-1" />
        <div className="flex gap-0.5">
          {MOOD_FACES.map((face, i) => (
            <button
              key={face}
              title={`${i + 1} 分`}
              onClick={() => onCommand(p.name, 'set', { value: i + 1 })}
              className={
                'rounded px-0.5 text-base leading-none transition-opacity ' +
                (v === i + 1 ? '' : 'opacity-35 hover:opacity-100')
              }
            >
              {face}
            </button>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className={row}>
      <span>⏱ {p.label}</span>
      <span className="text-neutral-400 dark:text-neutral-500">
        {p.panel.running
          ? `剩余 ${Math.ceil((p.panel.remaining ?? 0) / 60)} 分`
          : `${p.panel.minutes ?? p.panel.default_minutes ?? 25} 分`}
      </span>
      <div className="flex-1" />
      <button
        className={btn}
        onClick={() => onCommand(p.name, p.panel.running ? 'stop' : 'start')}
      >
        {p.panel.running ? '停' : '开始'}
      </button>
    </div>
  )
}
