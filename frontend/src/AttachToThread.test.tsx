// 「挂到…」——就地在清单上把一条挂到某件事上（§4-14）。
// 关键点只有一个：**候选是派生的，你不用打字**；连候选都没有时，用这一条自己的名字建。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import AttachToThread from './AttachToThread'
import type { ThreadRow } from './api'

vi.mock('./api', () => ({
  api: { suggestThreads: vi.fn(), attachThreadItem: vi.fn(), createThread: vi.fn() },
}))
import { api } from './api'

const THREAD: ThreadRow = {
  id: 1,
  name: 'RAG 评测',
  note: '',
  archived: false,
  status: 'open',
  stalled: false,
  idle_days: 0,
  deadline: null,
  created_at: null,
  updated_at: null,
  counts: {},
  total: 0,
}

afterEach(cleanup)

describe('AttachToThread', () => {
  it('点开给的是派生候选，选一个就挂上', async () => {
    vi.mocked(api.suggestThreads).mockResolvedValue({ label: 'RAG 评测', threads: [THREAD] })
    vi.mocked(api.attachThreadItem).mockResolvedValue({ ok: true, attached: true })
    render(<AttachToThread kind="card" ref="9" />)

    fireEvent.click(screen.getByText('挂到…'))
    fireEvent.click(await screen.findByText('RAG 评测'))
    await waitFor(() => expect(api.attachThreadItem).toHaveBeenCalledWith(1, 'card', '9'))
    expect(await screen.findByText('已挂到 RAG 评测')).toBeTruthy()
  })

  it('一个候选都没撞上时，用这一条自己的名字建一个再挂——一个字都不用打', async () => {
    vi.mocked(api.suggestThreads).mockResolvedValue({ label: 'RAG 评测', threads: [] })
    vi.mocked(api.createThread).mockResolvedValue(THREAD)
    vi.mocked(api.attachThreadItem).mockResolvedValue({ ok: true, attached: true })
    render(<AttachToThread kind="card" ref="9" />)

    fireEvent.click(screen.getByText('挂到…'))
    fireEvent.click(await screen.findByText(/新建「RAG 评测」/))
    await waitFor(() => expect(api.createThread).toHaveBeenCalledWith('RAG 评测'))
    await waitFor(() => expect(api.attachThreadItem).toHaveBeenCalledWith(1, 'card', '9'))
  })

  it('挂不上时叫一声，**不静默**（这是换 ThreadsPage 复用它的前置）', async () => {
    // ThreadsPage 自己那套实现失败时会显示页级红条；直接换成这个组件、而它又是空 catch，
    // 等于把已有的错误可见性**倒退**回去——而「失败不再静默」正是 P0 的目标。
    vi.mocked(api.suggestThreads).mockResolvedValue({ label: 'RAG 评测', threads: [THREAD] })
    vi.mocked(api.attachThreadItem).mockRejectedValue(new Error('500: {"detail":"库锁着"}'))
    const onError = vi.fn()
    render(<AttachToThread kind="card" ref="9" onError={onError} />)

    fireEvent.click(screen.getByText('挂到…'))
    fireEvent.click(await screen.findByText('RAG 评测'))

    await waitFor(() => expect(onError).toHaveBeenCalled())
    expect(String(onError.mock.calls[0][0])).toContain('库锁着')
    // 也不能把界面改成假的「已挂上」
    expect(screen.queryByText(/已挂到/)).toBeNull()
  })

  it('派生建议拉不到也说一声——否则看起来像「本来就没有可挂的事」', async () => {
    vi.mocked(api.suggestThreads).mockRejectedValue(new Error('500: boom'))
    const onError = vi.fn()
    render(<AttachToThread kind="card" ref="9" onError={onError} />)

    fireEvent.click(screen.getByText('挂到…'))
    await waitFor(() => expect(onError).toHaveBeenCalled())
    expect(String(onError.mock.calls[0][0])).toContain('可挂的事拉不出来')
  })

  it('新建并挂上时，把**那件事整个**交出去（调用方要拿 id 去打开它）', async () => {
    vi.mocked(api.suggestThreads).mockResolvedValue({ label: 'RAG 评测', threads: [] })
    vi.mocked(api.createThread).mockResolvedValue(THREAD)
    vi.mocked(api.attachThreadItem).mockResolvedValue({ ok: true, attached: true })
    const onCreated = vi.fn()
    render(<AttachToThread kind="card" ref="9" onCreated={onCreated} />)

    fireEvent.click(screen.getByText('挂到…'))
    fireEvent.click(await screen.findByText(/新建「RAG 评测」/))

    // `onAttached` 只给名字，够「划掉单子」不够「打开那件事」
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith({ id: 1, name: 'RAG 评测' }))
  })
})
