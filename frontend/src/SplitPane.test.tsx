// 分栏的接线：什么时候该出现两栏、主区换页之后侧栏还在不在、以及嵌进去的是什么。
//
// 拖拽测不了（jsdom 的 getBoundingClientRect 一律是 0，也没有 ResizeObserver），
// 所以宽度的算法在 split.test.ts 里直测纯函数。这里测的是**结构**和**hash 的归属**。
//
// 侧栏那一侧是 iframe，jsdom 不会去加载它的 src——所以本文件根本不需要把页面打桩，
// 也不会发出任何请求。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom'

import SplitPane from './SplitPane'
import { encodeAside, useAside } from './split'

function Hash() {
  const loc = useLocation()
  return <span data-testid="loc">{loc.pathname + loc.hash}</span>
}

/** 主区里一个「手动换页」的按钮，用来模拟点导航/最近对话。 */
function GoTo({ to }: { to: string }) {
  const navigate = useNavigate()
  return <button onClick={() => navigate(to)}>go</button>
}

function split(pathname: string, aside: string, children: React.ReactNode) {
  return (
    <MemoryRouter initialEntries={[{ pathname, hash: encodeAside(aside) }]}>
      <SplitPane>{children}</SplitPane>
      <Hash />
    </MemoryRouter>
  )
}

const asideSrc = () => document.querySelector('aside iframe')?.getAttribute('src') ?? null
const AT_KB = '/tutor' + encodeAside('/kb')

// jsdom 没有排版：`getBoundingClientRect` 一律返回 0，于是容器量出来是 0、
// 按设计「不挤」→ 永远单栏。这里给它一个假宽度，好让分栏那几条能测。
let restoreLayout: (() => void) | null = null

function stubLayout(width: number) {
  const rect = {
    width,
    height: 800,
    top: 0,
    left: 0,
    right: width,
    bottom: 800,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect
  const proto = Element.prototype as unknown as { getBoundingClientRect: () => DOMRect }
  const orig = proto.getBoundingClientRect
  proto.getBoundingClientRect = () => rect
  restoreLayout = () => {
    proto.getBoundingClientRect = orig
  }
}

beforeEach(() => stubLayout(1200))

// RTL 的自动清理挂在全局 afterEach 上，而本仓库的 vitest 没开 globals。
// 顺手复位地址栏和布局桩：有用例会真的去改 window.location.hash。
afterEach(() => {
  cleanup()
  restoreLayout?.()
  restoreLayout = null
  window.history.replaceState({}, '', '/')
})

describe('SplitPane', () => {
  it('没有侧栏时布局零改动：不套盒子、没有分隔条、没有 iframe', () => {
    const { container } = render(
      <MemoryRouter initialEntries={['/tutor']}>
        <SplitPane>
          <div>MAIN</div>
        </SplitPane>
      </MemoryRouter>
    )
    expect(screen.getByText('MAIN')).toBeTruthy()
    expect(container.querySelector('[role="separator"]')).toBeNull()
    expect(container.querySelector('aside')).toBeNull()
    // 外层是 display:contents —— 盒子不参与布局，页面仍是布局的直接孩子
    expect(container.firstElementChild?.className).toContain('contents')
  })

  it('hash 里带了 aside 就两栏并排，嵌的是那个地址', async () => {
    const { container } = render(split('/tutor', '/kb', <div>MAIN</div>))
    expect(screen.getByText('MAIN')).toBeTruthy()
    expect(container.querySelector('[role="separator"]')).toBeTruthy()
    await waitFor(() => expect(asideSrc()).toBe('/kb'))
    // 顶栏那行字来自 titleFor，不是硬编码的
    expect(screen.getByText('知识库')).toBeTruthy()
  })

  it('侧栏目标带参数时原样交给 iframe —— 剪藏/深链要落在对的那一页', async () => {
    render(split('/tutor', '/kb?clip=https%3A%2F%2Fx.com%2Fa&title=T', <div>MAIN</div>))
    await waitFor(() => expect(asideSrc()).toBe('/kb?clip=https%3A%2F%2Fx.com%2Fa&title=T'))
  })

  it('容器太窄就不开分栏 —— 主区用满，两栏都残不如只留主角', () => {
    stubLayout(500) // 500 < MIN_ASIDE + MAIN_MIN
    const { container } = render(split('/tutor', '/kb', <div>MAIN</div>))
    expect(screen.getByText('MAIN')).toBeTruthy()
    expect(container.querySelector('aside')).toBeNull()
    expect(container.querySelector('[role="separator"]')).toBeNull()
  })

  it('主区换页丢掉 hash 之后，侧栏还在，hash 也补回来了', async () => {
    // 这是整条协议里最容易漏的一处：`navigate('/notes')` 给的是 search='' hash=''，
    // 地址栏里的 aside 会被顺手清掉。state 才是真值，hash 只是它的投影。
    render(split('/tutor', '/kb', <GoTo to="/notes" />))
    await waitFor(() => expect(asideSrc()).toBe('/kb'))
    expect(screen.getByTestId('loc').textContent).toBe(AT_KB)

    fireEvent.click(screen.getByText('go'))

    await waitFor(() => expect(screen.getByTestId('loc').textContent).toBe('/notes' + encodeAside('/kb')))
    // 关键：侧栏没被主区带走
    expect(asideSrc()).toBe('/kb')
  })

  it('入口按钮能把侧栏打开；✕ 关掉后 hash 里也不留 aside', async () => {
    function Opener() {
      const aside = useAside()
      return <button onClick={() => aside.open('/kb')}>open</button>
    }
    render(
      <MemoryRouter initialEntries={['/tutor']}>
        <SplitPane>
          <Opener />
        </SplitPane>
        <Hash />
      </MemoryRouter>
    )
    expect(asideSrc()).toBeNull()

    fireEvent.click(screen.getByText('open'))
    await waitFor(() => expect(asideSrc()).toBe('/kb'))
    await waitFor(() => expect(screen.getByTestId('loc').textContent).toBe(AT_KB))

    fireEvent.click(screen.getByTitle('关掉侧栏'))
    await waitFor(() => expect(asideSrc()).toBeNull())
    expect(screen.getByTestId('loc').textContent).toBe('/tutor')
  })

  it('地址栏里粘进来的 #aside= 会被采纳（同路径的 fragment 导航）', async () => {
    // 把 `/tutor#aside=%2Fkb` 粘到已经打开的 `/tutor` 上，浏览器只改片段、不重载文档，
    // 路由自己察觉不到——只能听 hashchange。
    render(
      <MemoryRouter initialEntries={['/tutor']}>
        <SplitPane>
          <div>MAIN</div>
        </SplitPane>
        <Hash />
      </MemoryRouter>
    )
    expect(asideSrc()).toBeNull()

    window.location.hash = encodeAside('/kb')
    await waitFor(() => expect(asideSrc()).toBe('/kb'))
    await waitFor(() => expect(screen.getByTestId('loc').textContent).toBe('/tutor' + encodeAside('/kb')))

    // 反过来不成立：手清掉地址栏的 hash 关不掉侧栏。
    // 这是有意的——「地址里没有 aside」有两种来源（用户清的 / 主区换页顺手抹的）分不开，
    // 而后者必须保住侧栏，所以关只认 ✕。
    window.location.hash = ''
    await waitFor(() => expect(screen.getByTestId('loc').textContent).toBe('/tutor' + encodeAside('/kb')))
    expect(asideSrc()).toBe('/kb')
  })
})
