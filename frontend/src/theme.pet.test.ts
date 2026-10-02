// 皮肤数据里的「挂件风格」：`pet.sprite`——一套皮肤可以换一只「零柒」。
//
// 这是皮肤三条腿（背景氛围 / 挂件风格 / 工作区视觉）的最后一条，与 `bg.image`
// 走**同一条闸**：地址必须过 `isSafeImageUrl`（它会进 `<img src>`，而皮肤可能
// 来自别人的一份 JSON）。这里钉住的是数据这一层：收不收、拒什么、往返稳不稳。
import { describe, expect, it } from 'vitest'

import { manifestToSkin, parseSkin, skinToManifest } from './theme'

const base = { id: 'cat', label: '猫', accent: '#8a6a4a' }

describe('皮肤数据 · pet（挂件风格）', () => {
  it('pet.sprite 给了就收下，运行时对象带出去', () => {
    const got = parseSkin({ ...base, pet: { sprite: '/api/images/cat.png' } })
    expect(got.ok).toBe(true)
    if (!got.ok) return
    expect(got.value.pet).toEqual({ sprite: '/api/images/cat.png' })
    expect(manifestToSkin(got.value).pet).toEqual({ sprite: '/api/images/cat.png' })
  })

  it('不写 pet = 内置的那只零柒（undefined，不是空对象）', () => {
    const got = parseSkin(base)
    if (!got.ok) throw new Error('fixture')
    expect(got.value.pet).toBeUndefined()
    expect(manifestToSkin(got.value).pet).toBeUndefined()
    // `pet: {}` 一个字段都没写，同样是「没写」——否则会推出 `{ sprite: undefined }`
    const empty = parseSkin({ ...base, pet: {} })
    if (!empty.ok) throw new Error('fixture')
    expect(empty.value.pet).toBeUndefined()
    expect(manifestToSkin(empty.value).pet).toBeUndefined()
  })

  it('与底图同一条安全线：data: / 相对路径 / javascript: / 空串一律拒', () => {
    for (const no of [
      'data:image/png;base64,AAAA',
      '/etc/passwd',
      'javascript:alert(1)',
      'pet/cat.webp',
      '//evil.test/cat.png',
      '',
    ]) {
      const got = parseSkin({ ...base, pet: { sprite: no } })
      expect(got.ok, no).toBe(false)
      // 报错要说得出是 pet.sprite 的事，而不是一句「皮肤不合法」
      if (!got.ok) expect(got.reason, no).toContain('pet.sprite')
    }
    // 站内的零柒资产放行——皮肤想把形象换回系统自带的那几张是合法的
    for (const ok of ['/pet/idle.webp', '/pet-avatar.png', '/api/images/cat.png', '/skins/a.svg']) {
      expect(parseSkin({ ...base, pet: { sprite: ok } }).ok, ok).toBe(true)
    }
  })

  it('pet 写成别的形状也拒——「写错」与「没写」是两件事', () => {
    expect(parseSkin({ ...base, pet: 'cat.png' }).ok).toBe(false)
    expect(parseSkin({ ...base, pet: { sprite: 3 } }).ok).toBe(false)
  })

  it('导出再导入原样带过去（换形象是皮肤的一部分，不该在导出时丢掉）', () => {
    const got = parseSkin({ ...base, pet: { sprite: '/pet-avatar.png' } })
    if (!got.ok) throw new Error('fixture')
    const back = parseSkin(JSON.parse(JSON.stringify(skinToManifest(manifestToSkin(got.value)))))
    expect(back.ok).toBe(true)
    if (!back.ok) return
    expect(back.value.pet).toEqual({ sprite: '/pet-avatar.png' })
  })
})
