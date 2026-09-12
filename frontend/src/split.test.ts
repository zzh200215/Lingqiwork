// 分栏协议里能离线钉住的那部分：hash 的编解码、以及宽度的钳制。
//
// 拖拽本身在 jsdom 里测不了（getBoundingClientRect 一律返回 0），所以把「算宽度」
// 这件事抽成纯函数，让它能被钉住——它是这套东西里唯一会算错还不报错的地方。
import { describe, expect, it } from 'vitest'

import {
  asideWidth,
  decodeAside,
  DEFAULT_ASIDE_RATIO,
  encodeAside,
  isInAppPath,
  MAIN_MIN,
  MAX_ASIDE_RATIO,
  MIN_ASIDE,
  ratioForDrag,
} from './split'

const NUL = String.fromCharCode(0)
const NL = String.fromCharCode(10)
const DEL = String.fromCharCode(127)

describe('encodeAside / decodeAside', () => {
  it('往返不变 —— 带 query 的 href 也照样', () => {
    for (const href of [
      '/kb',
      '/',
      '/notes?path=notes%2Fa.md',
      '/?new=1&repo=hello-agent',
      '/kb?clip=https%3A%2F%2Fx.com%2Fa&title=T',
      '/tutor?session=5',
    ]) {
      expect(decodeAside(encodeAside(href))).toBe(href)
    }
  })

  it('主区那些参数不会被路由看成自己的 —— 它们整个都在 aside 的值里', () => {
    // 侧栏带着 `?clip=` 时，`URLSearchParams` 该只在 aside 这一项上解析，
    // 不能把 clip 也解析出来给 KBPage 用
    const hash = encodeAside('/kb?clip=https%3A%2F%2Fx.com%2Fa')
    expect([...new URLSearchParams(hash.slice(1)).keys()]).toEqual(['aside'])
  })

  it('没有 aside 的 hash 一律 null', () => {
    expect(decodeAside('')).toBeNull()
    expect(decodeAside('#')).toBeNull()
    expect(decodeAside('#t=%E6%88%91%E9%80%89%E4%B8%AD%E7%9A%84%E5%AD%97')).toBeNull()
    expect(decodeAside('#aside=')).toBeNull()
  })

  it('只收站内路径 —— 别让一个能操纵地址栏的字符串喂进路由', () => {
    const bad = [
      'javascript:alert(1)',
      'https://evil.com',
      '//evil.com',
      'data:text/html,<script>1</script>',
      'kb', // 少了开头的斜杠
    ]
    for (const b of bad) {
      expect(decodeAside(`#aside=${encodeURIComponent(b)}`)).toBeNull()
    }
  })

  it('控制字符不收（换行会把 hash 后面的东西截断）', () => {
    expect(isInAppPath(`/k${NL}b`)).toBe(false)
    expect(isInAppPath(`/${NUL}kb`)).toBe(false)
    expect(isInAppPath(`/kb${DEL}`)).toBe(false)
    expect(isInAppPath('/kb')).toBe(true)
    // 前后空白是 URLSearchParams 的噪音，不是路径的一部分，去掉即可
    expect(decodeAside(`${encodeAside('/kb')}%20`)).toBe('/kb')
  })

  it('斜杠开头的查询也放行 —— 侧栏本来就允许指到查询串上', () => {
    expect(decodeAside(encodeAside('/?conv=3'))).toBe('/?conv=3')
  })
})

describe('asideWidth', () => {
  it('按比例走 —— 窗口（或浏览器缩放）变了，侧栏跟着变', () => {
    // 同一份比例，两个容器宽度 → 宽度按比例缩放，不是同一个像素值
    expect(asideWidth(0.3, 1200)).toBe(360)
    expect(asideWidth(0.3, 2000)).toBe(600)
  })

  it('主区先拿到它要的：侧栏的上限是「容器 − 主区下限」', () => {
    // 这条是这次返工的核心。旧实现只按「侧栏最多占 70%」，
    // 于是 1000px 的窗口里主区被挤到 224px，笔记页直接没法用。
    const container = 760 // 1000px 窗口减掉左侧导航栏
    const aside = asideWidth(DEFAULT_ASIDE_RATIO, container)
    expect(container - aside).toBeGreaterThanOrEqual(MAIN_MIN)
  })

  it('比例再大也压不过主区下限', () => {
    expect(asideWidth(1, 1200)).toBe(Math.round(1200 * MAX_ASIDE_RATIO))
    expect(asideWidth(1, 760)).toBe(760 - MAIN_MIN)
  })

  it('容器放不下两栏就别硬挤 —— 返回 0，主区自己用满', () => {
    // MIN_ASIDE + MAIN_MIN 就是分水岭
    expect(asideWidth(DEFAULT_ASIDE_RATIO, MIN_ASIDE + MAIN_MIN)).toBeGreaterThan(0)
    expect(asideWidth(DEFAULT_ASIDE_RATIO, MIN_ASIDE + MAIN_MIN - 20)).toBe(0)
    expect(asideWidth(DEFAULT_ASIDE_RATIO, 400)).toBe(0)
  })

  it('还没量出来（0）时不挤 —— 首帧闪一下两栏比不显示更糟', () => {
    expect(asideWidth(DEFAULT_ASIDE_RATIO, 0)).toBe(0)
    expect(asideWidth(DEFAULT_ASIDE_RATIO, NaN)).toBe(0)
  })

  it('比例缺失时退回默认，而不是塌成 0', () => {
    expect(asideWidth(NaN, 1200)).toBe(Math.round(1200 * DEFAULT_ASIDE_RATIO))
  })
})

describe('ratioForDrag', () => {
  it('鼠标离右边缘多远 → 多大比例', () => {
    expect(ratioForDrag(700, 1000, 1000)).toBeCloseTo(0.3, 5)
  })

  it('拖过头也不越过上限，拖到负数也不给负比例', () => {
    expect(ratioForDrag(-9999, 1000, 1000)).toBe(MAX_ASIDE_RATIO)
    expect(ratioForDrag(5000, 1000, 1000)).toBe(0.05)
  })

  it('容器宽度未知时退回默认', () => {
    expect(ratioForDrag(100, 1000, 0)).toBe(DEFAULT_ASIDE_RATIO)
    expect(ratioForDrag(100, 1000, NaN)).toBe(DEFAULT_ASIDE_RATIO)
  })
})
