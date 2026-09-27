// 夜间回归卡（评测自动挡收尾）：开关是**真配置写盘**、读不到不摆卡、最近一跑摆事实。
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

vi.mock('./api', () => ({
  api: {
    getPrefs: vi.fn(),
    updatePrefs: vi.fn().mockResolvedValue({}),
    listEvalRuns: vi.fn().mockResolvedValue([]),
  },
}))
import { api } from './api'
import EvalNightlyCard from './EvalNightlyCard'

beforeEach(() => {
  vi.mocked(api.getPrefs).mockResolvedValue({
    eval_regression_enabled: false,
    eval_regression_cron: '0 5 * * *',
  })
  vi.mocked(api.listEvalRuns).mockResolvedValue([])
})

afterEach(cleanup)

describe('EvalNightlyCard · 夜间回归', () => {
  it('配置读不到时整卡不摆——读不到 ≠ 关着', async () => {
    vi.mocked(api.getPrefs).mockRejectedValue(new Error('500'))
    const { container } = render(<EvalNightlyCard />)
    await waitFor(() => expect(api.getPrefs).toHaveBeenCalled())
    expect(container.querySelector('[data-nightly-card]')).toBeNull()
  })

  it('勾选即 PUT 两个配置键（开关 + cron），回执说清开了什么', async () => {
    render(<EvalNightlyCard />)
    fireEvent.click(await screen.findByRole('checkbox'))
    await waitFor(() =>
      expect(api.updatePrefs).toHaveBeenCalledWith({
        eval_regression_enabled: true,
        eval_regression_cron: '0 5 * * *',
      }),
    )
    expect(await screen.findByText(/已开：0 5 \* \* \* 每晚跑一遍/)).toBeTruthy()
  })

  it('最近一跑摆事实：号数、hit@1；没忠实度那一格不编', async () => {
    vi.mocked(api.listEvalRuns).mockResolvedValue([
      { id: 7, hit1: 0.8, faithfulness: null, created_at: '2026-09-26T05:00:00' },
    ] as never)
    render(<EvalNightlyCard />)
    expect(await screen.findByText(/第 7 号/)).toBeTruthy()
    expect(screen.getByText(/hit@1 80%/)).toBeTruthy()
    expect(screen.queryByText(/忠实度/)).toBeNull()
  })
})
