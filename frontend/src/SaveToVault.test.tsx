/** 「存进产出」：模型没自己调 save_artifact 的那一轮，内容已经在手上——
 *  点一个体裁就归档，回执交给调用方挂回那条消息。
 *
 *  钉住三点：体裁表是**点开才拉**的（不当首屏负担）、请求带对了
 *  conversation/message/体裁、失败了就说失败（绝不假装存上了——那会让用户
 *  以为产出进了 vault，而其实什么都没发生）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import SaveToVault from './SaveToVault'

vi.mock('./api', () => ({
  api: {
    outputKinds: vi.fn().mockResolvedValue({
      kinds: [
        { kind: 'deliver', label: '交付', dir: 'deliver' },
        { kind: 'recap', label: '复盘', dir: 'recap' },
      ],
    }),
    saveOutputFromMessage: vi.fn(),
  },
}))
import { api } from './api'

const ART = {
  kind: 'deliver',
  label: '交付',
  title: '第 36 周周报',
  path: 'deliver/2026-09-14-周报.md',
  href: '/notes?path=deliver%2Fx.md',
  chunks: 2,
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('SaveToVault', () => {
  it('点开才拉体裁表，点了才落盘，回执交给调用方', async () => {
    vi.mocked(api.saveOutputFromMessage).mockResolvedValue(ART)
    const onSaved = vi.fn()
    render(<SaveToVault conversationId={7} messageId={42} onSaved={onSaved} />)

    expect(api.outputKinds).not.toHaveBeenCalled() // 首屏不请求
    fireEvent.click(screen.getByText('📄 存进产出'))
    await screen.findByText('交付')
    expect(api.outputKinds).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByText('交付'))
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(ART))
    expect(api.saveOutputFromMessage).toHaveBeenCalledWith(7, 42, 'deliver')
  })

  it('体裁表拉不到就说拉不到，不编一份假的出来', async () => {
    vi.mocked(api.outputKinds).mockRejectedValueOnce(new Error('offline'))
    render(<SaveToVault conversationId={7} messageId={42} onSaved={vi.fn()} />)
    fireEvent.click(screen.getByText('📄 存进产出'))
    await screen.findByText('体裁表拉不到')
    expect(screen.queryByText('交付')).toBeNull()
  })

  it('存失败就把话说清楚，绝不假装存上了', async () => {
    vi.mocked(api.saveOutputFromMessage).mockRejectedValue(new Error('boom'))
    const onSaved = vi.fn()
    render(<SaveToVault conversationId={7} messageId={42} onSaved={onSaved} />)
    fireEvent.click(screen.getByText('📄 存进产出'))
    await screen.findByText('交付')
    fireEvent.click(screen.getByText('交付'))
    await screen.findByText('boom')
    expect(onSaved).not.toHaveBeenCalled()
  })
})
