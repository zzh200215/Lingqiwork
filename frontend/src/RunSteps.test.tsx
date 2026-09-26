// 步骤条（方案 §8.3）：点一次运行 → 每步的状态、耗时、输入输出。
//
// 真值在 `run.log` 里那两种形状上（`tool` / `step` 同一个数组，顺序即发生顺序），
// 所以这里先钉**取步骤**这条纯函数，再钉它渲染出来长什么样。
import { describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach } from 'vitest'

import RunSteps, { fmtMs, stepsOf } from './RunSteps'
import type { TaskRunItem } from './api'

function run(log: TaskRunItem['log'], patch: Partial<TaskRunItem> = {}): TaskRunItem {
  return {
    id: 1,
    task_id: 1,
    trigger: 'cron',
    upstream_task_id: null,
    started_at: '2026-09-25T10:00:00+08:00',
    finished_at: '2026-09-25T10:00:09+08:00',
    status: 'ok',
    mode: 'simple',
    model_id: 'm',
    rounds: 0,
    tool_calls: 0,
    error: '',
    answer: '',
    grounded: null,
    judge_reason: '',
    run_dir: '',
    thread_id: null,
    log,
    ...patch,
  }
}

function renderSteps(r: TaskRunItem) {
  return render(
    <MemoryRouter>
      <RunSteps run={r} />
    </MemoryRouter>
  )
}

afterEach(cleanup)

describe('stepsOf · 从运行日志取步骤', () => {
  it('按原序取，两种形状都在——顺序本身就是真值', () => {
    const steps = stepsOf(
      run([
        { step: '取材', ok: true, ms: 12, note: '3 条材料' },
        { tool: 'vault_search', args: { q: 'a' }, ok: true, result: 'ok', ms: 40 },
        { step: '成文', ok: true, ms: 900 },
        { step: '落盘', ok: true, ms: 5, ref: 'research/x.md' },
      ])
    )
    expect(steps.map((s) => s.name)).toEqual(['取材', 'vault_search', '成文', '落盘'])
    expect(steps.map((s) => s.isTool)).toEqual([false, true, false, false])
    expect(steps[0].note).toBe('3 条材料')
    expect(steps[3].ref).toBe('research/x.md')
  })

  it('`skill_inject` 不算一步——它是注入痕迹，不是工序', () => {
    // 运行行的小结里已经写着「注入 X」；再在步骤条上摆一个，会让人以为那是一次调用。
    const steps = stepsOf(
      run([
        { tool: 'skill_inject', args: { skills: ['给领导写汇报要结论先行'] }, ok: true, result: '' },
        { step: '取材', ok: true, ms: 1 },
      ])
    )
    expect(steps.map((s) => s.name)).toEqual(['取材'])
  })

  it('老日志项没有 ok / ms：不当成失败，也不编一个 0 秒', () => {
    // `ms` 缺失是「没量过」，不是「花了 0 毫秒」——摆 0 秒是一句假话。
    // `ok` 缺失当成功：老日志项是**跑完了才会被记下来**的那些。
    const steps = stepsOf(run([{ tool: 'vault_list_files', args: {}, result: 'a.md' }]))
    expect(steps).toHaveLength(1)
    expect(steps[0].ok).toBe(true)
    expect(steps[0].ms).toBeNull()
  })
})

describe('RunSteps · 渲染', () => {
  it('每一步一个点：失败的那一步**留着**，而且是红的', () => {
    renderSteps(
      run([
        { step: '取材', ok: false, ms: 30, note: '没找到材料' },
        { step: '成文', ok: false, ms: 2, note: '你自己的材料里没找到相关内容' },
      ])
    )
    expect(screen.getByText('取材')).toBeTruthy()
    expect(screen.getByText('成文')).toBeTruthy()
    // 省掉失败那一步的话，这趟看上去会像「没跑过」——而它明明跑到了取材
    expect(screen.getByText('没找到材料')).toBeTruthy()
    const dots = document.querySelectorAll('[data-run-steps] span.rounded-full')
    expect([...dots].map((d) => d.className.includes('bg-rose-500'))).toEqual([true, true])
  })

  it('耗时按量出来的摆：不足一秒给毫秒，过了一秒给秒', () => {
    renderSteps(
      run([
        { step: '取材', ok: true, ms: 30 },
        { step: '成文', ok: true, ms: 2400 },
      ])
    )
    expect(screen.getByText('30 毫秒')).toBeTruthy()
    expect(screen.getByText('2.4 秒')).toBeTruthy()
    expect(fmtMs(999)).toBe('999 毫秒')
    expect(fmtMs(1000)).toBe('1.0 秒')
  })

  it('没有 ms 的那一步不摆耗时——不写「0 毫秒」', () => {
    renderSteps(run([{ step: '取材', ok: true }]))
    expect(screen.queryByText(/毫秒/)).toBeNull()
    expect(screen.queryByText(/秒/)).toBeNull()
  })

  it('工具那一步可以展开看输入与输出', () => {
    renderSteps(
      run([{ tool: 'vault_search', args: { q: 'RAG' }, ok: true, result: '找到 3 条', ms: 40 }])
    )
    expect(screen.queryByText('输入')).toBeNull() // 默认收着
    fireEvent.click(screen.getByText('输入/输出'))
    expect(screen.getByText('输入')).toBeTruthy()
    expect(screen.getByText(/"q": "RAG"/)).toBeTruthy()
    expect(screen.getByText('找到 3 条')).toBeTruthy()
    fireEvent.click(screen.getByText('收起'))
    expect(screen.queryByText('输入')).toBeNull()
  })

  it('落盘那一步指得到产物（vault 相对路径 → 笔记页）', () => {
    renderSteps(run([{ step: '落盘', ok: true, ms: 5, ref: 'research/2026-09-25-x.md' }]))
    const link = screen.getByText('research/2026-09-25-x.md') as HTMLAnchorElement
    expect(link.getAttribute('href')).toBe('/notes?path=research%2F2026-09-25-x.md')
  })

  it('一次没留下步骤的运行：**如实说**，不摆一条假的步骤条', () => {
    renderSteps(run([]))
    expect(screen.getByText(/这次没留下步骤/)).toBeTruthy()
    expect(screen.getByText(/纯提示词那一趟/)).toBeTruthy()
    expect(screen.queryByRole('listitem')).toBeNull()
  })
})
