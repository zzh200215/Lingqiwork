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
})
