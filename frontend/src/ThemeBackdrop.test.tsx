// 视频壁纸：会动的壁纸与静态图在数据里是**同一个字段**（bg.image），
// 分派只发生在渲染层。这里钉的是分派本身：
//   · .mp4 / .webm 画 <video>（自动播、静音、循环），静态图仍然画 div 层；
//   · prefers-reduced-motion 下视频在但不自动播——画面在、动不在；
//   · isVideoUrl 按扩展名认（合法性另有 isSafeImageUrl 把关，这里不重复量）。
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ThemeProvider } from './ThemeProvider'
import ThemeBackdrop from './ThemeBackdrop'
import { DEFAULT_BG, DEFAULT_THEME, isVideoUrl } from './theme'

/** jsdom 没有 matchMedia。给一个 matches 可控的假货——组件与 Provider 都只读
 *  `.matches`（addEventListener 那一侧是可选链），够用。 */
function stubReducedMotion(matches: boolean) {
  vi.stubGlobal('matchMedia', () => ({ matches }))
}

function mountWithBg(image: string) {
  localStorage.setItem(
    'wb:theme',
    JSON.stringify({ ...DEFAULT_THEME, bg: { ...DEFAULT_BG, mode: 'image', image } }),
  )
  return render(
    <ThemeProvider>
      <ThemeBackdrop />
    </ThemeProvider>,
  )
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  localStorage.clear()
})

describe('视频壁纸', () => {
  it('isVideoUrl 按扩展名认 mp4 / webm（带查询串也认）；图片与空串不是', () => {
    expect(isVideoUrl('https://example.com/firefly.mp4')).toBe(true)
    expect(isVideoUrl('/api/images/img-20261001-120000-abcdef.webm?v=2')).toBe(true)
    expect(isVideoUrl('/api/images/img-20261001-120000-abcdef.png')).toBe(false)
    expect(isVideoUrl('')).toBe(false)
  })

  it('背景是 .mp4：画 <video>，自动播、静音、循环，铺法写在属性上', () => {
    const { container } = mountWithBg('https://example.com/firefly.mp4')
    const v = container.querySelector('video') as HTMLVideoElement | null
    expect(v).toBeTruthy()
    expect(v?.getAttribute('data-wb-backdrop-img')).toBe('https://example.com/firefly.mp4')
    // muted 这类 React 走 property 而不是 attribute——断言读属性，别读标记
    expect(v?.autoplay).toBe(true)
    expect(v?.muted).toBe(true)
    expect(v?.loop).toBe(true)
    expect(v?.getAttribute('data-wb-fit')).toBe('cover')
  })

  it('reduced-motion：视频在，但不自动播', () => {
    stubReducedMotion(true)
    const { container } = mountWithBg('https://example.com/firefly.mp4')
    const v = container.querySelector('video') as HTMLVideoElement | null
    expect(v).toBeTruthy()
    expect(v?.autoplay).toBe(false)
  })

  it('静态图：仍然画 div 层，不画 video', () => {
    const { container } = mountWithBg('https://example.com/moon.png')
    expect(container.querySelector('video')).toBeNull()
    expect(container.querySelector('.wb-backdrop-img')).toBeTruthy()
  })
})
