// 陪伴页：五标签 + 整页聊天协议 + 教它（费曼法）+ 小屋 + 有声清单。
// 成长整页是 GrowthPage 自己的测试钉的。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

import CompanionPage from './CompanionPage'
import type { PetGrowth, PodcastEntry, TutorStuckRow } from './api'

vi.mock('./api', () => ({
  api: {
    listPodcasts: vi.fn().mockResolvedValue({ podcasts: [] }),
    podcastFromStuck: vi.fn(),
    deletePodcast: vi.fn(),
    tutorStuck: vi.fn().mockResolvedValue({ stuck: [] }),
    tutorStart: vi.fn(),
    tutorEnd: vi.fn(),
    petGrowth: vi.fn(),
    petRoom: vi.fn().mockResolvedValue({
      things: [],
      carried: null,
      shelf: [],
      today: { meals: [], date: '2026-09-14' },
      skills: [],
      form: [],
      empty: true,
    }),
  },
}))
// 成长整页搬进来就够——它自己的行为在 GrowthPage.test
vi.mock('./GrowthPage', () => ({
  default: ({ chromeless }: { chromeless?: boolean }) => (
    <div data-testid="growth-stub" data-chromeless={chromeless ? '1' : '0'}>
      成长
    </div>
  ),
}))
import { api } from './api'

const POD: PodcastEntry = {
  id: 'p1',
  title: '卡点圆桌：事件循环',
  sources: ['tutor/s1.md'],
  turns: 12,
  duration_sec: 214,
  file: 'podcasts/p1.mp3',
  script: [],
  created_at: '2026-09-13T10:00:00',
  ok: true,
}

function growth(exp: number, level: number, title = '初识'): PetGrowth {
  return { exp, level, title, next_title: '', progress: 0, parts: [], counts: {} }
}

function stuckRow(id: number, concept: string): TutorStuckRow {
  return {
    id,
    concept,
    stuck: '以为 await 把控制权交给了操作系统',
    verdict: 'half',
    created_at: '2026-09-13T10:00:00',
    resolved_at: '',
  }
}

function sseResponse(frames: string[]): Response {
  const enc = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(ctrl) {
      for (const f of frames) ctrl.enqueue(enc.encode(f))
      ctrl.close()
    },
  })
  return new Response(stream, { status: 200 })
}

/** 点一个按钮，但**先等它不再是 disabled**。

    流还在跑的时候自评那一排是禁用的，而 `findByText` 只等它出现、不等它可用——
    直接点会静默什么都不发生，测试于是以一个看不懂的方式失败。 */
async function clickEnabled(label: string) {
  const el = await screen.findByText(label)
  await waitFor(() => expect((el as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(el)
}

function renderPage(tab?: string) {
  return render(
    <MemoryRouter initialEntries={[tab ? `/companion?tab=${tab}` : '/companion']}>
      <CompanionPage />
    </MemoryRouter>
  )
}

beforeEach(() => {
  // jsdom 没有 scrollIntoView；聊天区每次消息后都会调它
  Element.prototype.scrollIntoView = () => {}
  // mock 值会跨用例泄漏，每例前回到「全空」
  vi.mocked(api.listPodcasts).mockResolvedValue({ podcasts: [] })
  vi.mocked(api.tutorStuck).mockResolvedValue({ stuck: [] })
  vi.mocked(api.tutorStart).mockResolvedValue({
    id: 1,
    topic: '',
    repo: '',
    mode: 'feynman',
    model_id: 'm',
    model_ok: true,
  })
  vi.mocked(api.tutorEnd).mockResolvedValue({
    id: 1,
    verdict: 'got',
    concept: 'asyncio 事件循环',
    domain: 'asyncio',
    aliases: '',
    stuck: '',
    transfer: '',
    material_nearby: [],
    merged: null,
  })
  vi.mocked(api.petGrowth).mockResolvedValue(growth(100, 1))
  vi.mocked(api.petRoom).mockResolvedValue({
    things: [],
    carried: null,
    shelf: [],
    today: { meals: [], date: '2026-09-14' },
    skills: [],
    form: [],
    empty: true,
  })
  // 一轮完整的 SSE：delta 然后 done。少了 done 帧，`streamTutorSay` 会判定
  // 「流提前结束」并把那句话当错误显示出来——真实的后端不会那样收尾。
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      sseResponse(['event: delta\ndata: {"text": "嗯，我在。"}\n\n', 'event: done\ndata: {}\n\n'])
    )
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('CompanionPage', () => {
  it('默认在聊天：起头条一句话送出去，SSE 正文流回来', async () => {
    renderPage()
    fireEvent.click(await screen.findByText('陪我聊两句'))
    await waitFor(() => expect(screen.getByText('陪我聊两句，随便什么都行。')).toBeTruthy())
    await waitFor(() => expect(screen.getByText('嗯，我在。')).toBeTruthy())
  })

  it('它真的做了事 → 回执画在话**前面**（同一个零柒，两处一个面孔）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        sseResponse([
          'event: tool_result\ndata: {"name":"pet_focus_start","meta":{"pet":{"tool":"pet_focus_start","plugin":"focus","command":"start","panel":{"kind":"timer","running":true,"remaining":1500,"minutes":25},"said":null}}}\n\n',
          'event: delta\ndata: {"text": "开始计时了。"}\n\n',
          'event: done\ndata: {}\n\n',
        ])
      )
    )
    renderPage()
    fireEvent.click(await screen.findByText('陪我聊两句'))
    await waitFor(() => expect(screen.getByText('⏱ 专注 25 分')).toBeTruthy())
    expect(screen.getByText('开始计时了。')).toBeTruthy()
  })

  it('成长标签整页搬进来，且是无头的——页头只有「陪伴」', async () => {
    renderPage('growth')
    const stub = await screen.findByTestId('growth-stub')
    expect(stub.getAttribute('data-chromeless')).toBe('1')
  })

  it('小屋标签：它攒下的东西是第五张脸（空屋子也给一句实话）', async () => {
    renderPage('room')
    expect(await screen.findByText('小屋还是空的。')).toBeTruthy()
    // 五张脸都在标签条上
    for (const label of ['聊天', '教它', '成长', '小屋', '有声']) {
      expect(screen.getByText(label)).toBeTruthy()
    }
  })

  it('有声：播客一期一行，能听能删', async () => {
    vi.mocked(api.listPodcasts).mockResolvedValue({ podcasts: [POD] })
    const { container } = renderPage('audio')
    expect(await screen.findByText('卡点圆桌：事件循环')).toBeTruthy()
    expect(screen.getByText('3:34')).toBeTruthy()
    const player = container.querySelector('audio')
    expect(player?.getAttribute('src')).toBe('/api/podcast/audio/podcasts/p1.mp3')
    fireEvent.click(screen.getByText('删'))
    await waitFor(() => expect(api.deletePodcast).toHaveBeenCalledWith('p1'))
  })

  it('有声空态：指路「拿卡点录一期」，不是空白', async () => {
    renderPage('audio')
    expect(await screen.findByText('还没有一期播客。')).toBeTruthy()
    expect(screen.getByText('🎙 拿没解的卡点录一期')).toBeTruthy()
  })
})

// P2 · 教它：费曼法，而那个「什么都不懂的学生」就是零柒。
// 会话是 feynman 模式——后端据此把零柒摆成「我在听」，并在说通时发 mastered 事件。
describe('CompanionPage · 教它', () => {
  it('讲一个东西：开一场费曼会话，它的追问流回来', async () => {
    renderPage('teach')
    expect(screen.getByText(/我什么都不懂/)).toBeTruthy()
    fireEvent.change(screen.getByPlaceholderText(/你要教它什么/), {
      target: { value: 'asyncio 事件循环' },
    })
    fireEvent.click(screen.getByText('开始讲'))
    await waitFor(() =>
      expect(api.tutorStart).toHaveBeenCalledWith('asyncio 事件循环', '', 'feynman')
    )
    expect(await screen.findByText('嗯，我在。')).toBeTruthy()
  })

  it('你卡着的东西是选题建议，点一下就直接开讲', async () => {
    vi.mocked(api.tutorStuck).mockResolvedValue({ stuck: [stuckRow(1, '协程挂起后去哪')] })
    renderPage('teach')
    fireEvent.click(await screen.findByText('协程挂起后去哪'))
    await waitFor(() =>
      expect(api.tutorStart).toHaveBeenCalledWith('协程挂起后去哪', '', 'feynman')
    )
  })

  it('听懂了 → 当场报出真实的 EXP 增量与现在的等级', async () => {
    vi.mocked(api.petGrowth)
      .mockResolvedValueOnce(growth(100, 1)) // 开讲前的快照
      .mockResolvedValueOnce(growth(145, 2, '同行')) // 讲完之后
    renderPage('teach')
    fireEvent.change(screen.getByPlaceholderText(/你要教它什么/), {
      target: { value: 'asyncio 事件循环' },
    })
    fireEvent.click(screen.getByText('开始讲'))
    await clickEnabled('听懂了')
    await waitFor(() => expect(api.tutorEnd).toHaveBeenCalledWith(1, 'got'))
    expect(await screen.findByText(/零柒把「asyncio 事件循环」记住了/)).toBeTruthy()
    // 45 是后端算出来的差值，不是前端抄的一份 EXP 常数
    expect(screen.getByText(/\+45 EXP/)).toBeTruthy()
    expect(screen.getByText(/Lv\.2「同行」/)).toBeTruthy()
    expect(screen.getByText(/升级了/)).toBeTruthy()
  })

  it('讲了一半 → 不吹成学会，也不提经验', async () => {
    renderPage('teach')
    fireEvent.change(screen.getByPlaceholderText(/你要教它什么/), { target: { value: 'x' } })
    fireEvent.click(screen.getByText('开始讲'))
    await clickEnabled('一半')
    await waitFor(() => expect(api.tutorEnd).toHaveBeenCalledWith(1, 'half'))
    expect(await screen.findByText(/听懂了一半/)).toBeTruthy()
    expect(screen.queryByText(/记住了/)).toBeNull()
  })

  it('没讲通 → 不记账（没有「欠一次」的说法）', async () => {
    renderPage('teach')
    fireEvent.change(screen.getByPlaceholderText(/你要教它什么/), { target: { value: 'x' } })
    fireEvent.click(screen.getByText('开始讲'))
    await clickEnabled('没讲通')
    await waitFor(() => expect(api.tutorEnd).toHaveBeenCalledWith(1, 'useless'))
    expect(await screen.findByText(/不记账/)).toBeTruthy()
  })

  it('「再教一个」回到选题，不留上一场的痕迹', async () => {
    renderPage('teach')
    fireEvent.change(screen.getByPlaceholderText(/你要教它什么/), {
      target: { value: 'asyncio 事件循环' },
    })
    fireEvent.click(screen.getByText('开始讲'))
    await clickEnabled('听懂了')
    fireEvent.click(await screen.findByText('再教一个'))
    expect(await screen.findByText(/我什么都不懂/)).toBeTruthy()
    expect(screen.queryByText(/记住了/)).toBeNull()
  })
})
