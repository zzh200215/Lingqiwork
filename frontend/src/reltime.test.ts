// 「多久以前」是全站一份（NotesPage 的文件列表与小屋的每件东西共用它）。
// 边界值单独钉一遍：这种函数坏起来不报错，只是悄悄说错话。
import { describe, expect, it } from 'vitest'

import { ago, isFresh } from './reltime'

const NOW = Date.UTC(2026, 8, 14, 12, 0, 0) // 2026-09-14T12:00:00Z

/** 距 NOW 多少**秒**之前的 epoch 秒 */
function at(secondsAgo: number): number {
  return NOW / 1000 - secondsAgo
}

describe('ago', () => {
  it('一分钟以内是「刚刚」', () => {
    expect(ago(at(0), NOW)).toBe('刚刚')
    expect(ago(at(59), NOW)).toBe('刚刚')
  })

  it('分钟 / 小时 / 天', () => {
    expect(ago(at(60), NOW)).toBe('1 分钟前')
    expect(ago(at(59 * 60), NOW)).toBe('59 分钟前')
    expect(ago(at(3600), NOW)).toBe('1 小时前')
    expect(ago(at(23 * 3600), NOW)).toBe('23 小时前')
    expect(ago(at(86400), NOW)).toBe('昨天')
    expect(ago(at(3 * 86400), NOW)).toBe('3 天前')
    expect(ago(at(29 * 86400), NOW)).toBe('29 天前')
  })

  it('更久之前给月与年，不给一串天数', () => {
    expect(ago(at(30 * 86400), NOW)).toBe('1 个月前')
    expect(ago(at(200 * 86400), NOW)).toBe('6 个月前')
    expect(ago(at(400 * 86400), NOW)).toBe('1 年前')
  })

  it('时钟偏一点点也不写成负数', () => {
    expect(ago(at(-120), NOW)).toBe('刚刚')
  })
})

describe('isFresh', () => {
  it('24 小时内算刚到手的', () => {
    expect(isFresh(at(0), NOW)).toBe(true)
    expect(isFresh(at(23 * 3600), NOW)).toBe(true)
    expect(isFresh(at(25 * 3600), NOW)).toBe(false)
  })
})
