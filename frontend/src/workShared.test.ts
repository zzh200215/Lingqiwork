// `workShared.fmtWhen` —— 把后端的 ISO 变成人看的时间。
//
// 这条钉的是一个**在真界面上发现过的 bug**：它原来是 `iso.slice(5, 16)`（切字符串），
// 而那只有在后端存本地墙上时间时才对。后端的约定是存 UTC + 序列化补 `+00:00`
// （`models.utcnow` / `models.iso_utc`），所以切字符串整整差一个时区——
// 同一屏上任务行说「上次 13:58」、它自己的运行记录说「05:58」。
import { describe, expect, it } from 'vitest'

import { cronLabel, fmtWhen, liveElapsed } from './workShared'

describe('fmtWhen', () => {
  it('带偏移的 ISO 按**本地**时间摆出来', () => {
    // 05:58 UTC 在东八区就是 13:58 —— 这个转换正是切字符串丢掉的那一步
    expect(fmtWhen('2026-09-17T05:58:54+00:00')).toBe('09-17 13:58')
  })

  it('偏移不是零的时候也算得对（不是「减八小时」写死）', () => {
    // 同一个瞬间的三种写法必须给出同一个本地时刻——写死减八小时的话这条会红
    const a = fmtWhen('2026-09-17T05:58:54+00:00')
    const b = fmtWhen('2026-09-17T13:58:54+08:00') // = 05:58 UTC
    const c = fmtWhen('2026-09-16T22:58:54-07:00') // = 09-17 05:58 UTC
    expect(new Set([a, b, c]).size).toBe(1)
  })

  it('空值给空串——不摆一个「--」出来假装有东西', () => {
    expect(fmtWhen(null)).toBe('')
    expect(fmtWhen('')).toBe('')
  })

  it('取不到偏移的老字符串**照旧切片兜底**：原样摆出来，不猜一个时区', () => {
    // 那种值本来就没有时区信息，猜一个比原样摆更糟
    expect(fmtWhen('2026-09-17T05:58:54')).toBe('09-17 05:58')
  })
})

describe('cronLabel —— 触发器说人话（学 GitHub Actions 的触发句式）', () => {
  it('常见形状各给一句人话', () => {
    expect(cronLabel('0 8 * * *')).toBe('每天 08:00')
    expect(cronLabel('30 9 * * 1-5')).toBe('工作日 09:30')
    expect(cronLabel('*/5 * * * *')).toBe('每 5 分钟')
    expect(cronLabel('20 * * * *')).toBe('每小时第 20 分')
    expect(cronLabel('0 */3 * * *')).toBe('每 3 小时（00:00 起）')
  })

  it('认不出的形状**原样摆 cron**——认不出还硬翻译才是编', () => {
    expect(cronLabel('15 8,20 * * 1,3,5')).toBe('15 8,20 * * 1,3,5')
    expect(cronLabel('0 8 1 * *')).toBe('0 8 1 * *')
    expect(cronLabel('不是 cron')).toBe('不是 cron')
  })
})

describe('liveElapsed —— 在跑的东西「此刻为止」跑了多久', () => {
  it('从 started_at 到 now，与跑完的耗时同一套格式', () => {
    const start = new Date(Date.now() - 65_000).toISOString()
    expect(liveElapsed(start, Date.now())).toBe('1 分 5 秒')
  })

  it('没有起点（老运行行）给空串——不摆「0 秒」出来', () => {
    expect(liveElapsed(null, Date.now())).toBe('')
    expect(liveElapsed('乱串', Date.now())).toBe('')
  })
})
