/** 会话流的一行回执：指到产出详情，正文不在这儿。
 *
 *  钉住两点：链接真的指向 `href`（点开就是那份产出），以及体裁标签/标题都露出来
 *  （没有标题用户认不出这是哪一份）。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

import ArtifactReceipt from './ArtifactReceipt'

afterEach(cleanup)

function wrap(node: React.ReactNode) {
  return render(<MemoryRouter>{node}</MemoryRouter>)
}

describe('ArtifactReceipt', () => {
  it('整行是指向产出的链接，带体裁标签、标题和去向', () => {
    wrap(
      <ArtifactReceipt
        art={{
          kind: 'deliver',
          label: '交付',
          title: '第 36 周周报',
          path: 'deliver/2026-09-14-周报.md',
          href: '/notes?path=deliver%2F2026-09-14-%E5%91%A8%E6%8A%A5.md',
          chunks: 3,
        }}
      />
    )
    const link = screen.getByText('第 36 周周报').closest('a')
    expect(link?.getAttribute('href')).toBe(
      '/notes?path=deliver%2F2026-09-14-%E5%91%A8%E6%8A%A5.md'
    )
    expect(screen.getByText('交付')).toBeTruthy()
    expect(screen.getByText('已存入产出 →')).toBeTruthy()
  })

  it('老回执没有 action 时按「存为」显示，不会变成空白', () => {
    wrap(
      <ArtifactReceipt
        art={{
          kind: 'recap',
          label: '复盘',
          title: '第 36 周',
          path: 'recap/x.md',
          href: '/notes?path=recap%2Fx.md',
          chunks: 1,
        }}
      />
    )
    expect(screen.getByText('已存入产出 →')).toBeTruthy()
  })

  it('覆盖了本轮版本时说出来——「已存入产出」在那一轮上是不够的', () => {
    wrap(
      <ArtifactReceipt
        art={{
          kind: 'recap',
          label: '复盘',
          title: '第 36 周周报',
          path: 'recap/x.md',
          href: '/notes?path=recap%2Fx.md',
          chunks: 1,
          action: '更新',
        }}
      />
    )
    expect(screen.getByText('已更新本轮版本 →')).toBeTruthy()
  })

  it('同名另存时说出来——之前那份没被盖掉', () => {
    wrap(
      <ArtifactReceipt
        art={{
          kind: 'deliver',
          label: '交付',
          title: '第 36 周周报',
          path: 'deliver/x-2.md',
          href: '/notes?path=deliver%2Fx-2.md',
          chunks: 1,
          action: '另存',
        }}
      />
    )
    expect(screen.getByText('同名已有，已另存 →')).toBeTruthy()
  })
})
