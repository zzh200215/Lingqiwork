// 皮肤库策展数据（`skinGallery.ts`）的守卫。这张表是**手写**的，所以它最怕的
// 不是写错一个词，而是「加了一套新皮肤忘了摆上货架」——症状是那套皮肤在「全部」
// 视图里哪个栏目都不属于，看起来像丢了。这三条让这种事当场红。
import { describe, expect, it } from 'vitest'

import { BUILTIN_SKIN_IDS } from './theme/skins'
import { GALLERY_GROUPS, SKIN_TAGS, groupOf } from './skinGallery'

describe('皮肤库策展数据', () => {
  it('分组里的 id 都是真实存在的内置皮肤', () => {
    const known = new Set(BUILTIN_SKIN_IDS)
    const ghost = GALLERY_GROUPS.flatMap((g) => g.ids).filter((id) => !known.has(id))
    expect(ghost, '货架上有不存在的皮肤——改 skinGallery.ts').toEqual([])
  })

  it('四组合计**恰好盖住**全部内置皮肤，且一个 id 只摆在一个货架上', () => {
    const flat = GALLERY_GROUPS.flatMap((g) => g.ids)
    expect(new Set(flat).size, '有 id 被摆进了两个货架').toBe(flat.length)
    expect([...flat].sort(), '有内置皮肤没有进任何货架（界面上会像丢了）').toEqual([
      ...BUILTIN_SKIN_IDS,
    ].sort())
  })

  it('标签只发给内置皮肤，且每个都是非空的短词', () => {
    const known = new Set(BUILTIN_SKIN_IDS)
    const stray = Object.keys(SKIN_TAGS).filter((id) => !known.has(id))
    expect(stray, '用户皮肤不进策展表——它们归「我的皮肤」那一栏').toEqual([])
    for (const [id, tags] of Object.entries(SKIN_TAGS)) {
      expect(tags.length, `${id} 至少要有一个标签`).toBeGreaterThan(0)
      for (const t of tags) expect(t.trim().length, `${id} 的标签「${t}」`).toBeGreaterThan(0)
    }
  })

  it('groupOf 认内置的、不认用户的（找不到就落「我的皮肤」那栏）', () => {
    expect(groupOf('firefly')?.label).toBe('推荐')
    expect(groupOf('ridge')?.label).toBe('氛围')
    expect(groupOf('sakura')).toBeNull()
  })
})
