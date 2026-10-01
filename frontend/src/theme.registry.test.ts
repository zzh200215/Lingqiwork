// 皮肤的数据格式与注册表。这一层测的是**「一份皮肤从 JSON 走到界面」这条路**：
// 手写的那三个字段够不够、写错的会不会被挡、导入的皮肤会不会跟内置的打架、
// 以及导出来再导回去是不是同一份。
//
// 与 `theme.test.ts` 的分工：那边管内置那六个的色值与解析，这边管**数据与来源**。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { DEFAULT_THEME, SKINS_KEY, installUserSkins, isBuiltinSkin, listSkins, loadUserSkins, removeUserSkin, renameUserSkin, skinById, userSkinManifests } from './theme'
import { BUILTIN_SKINS } from './theme/skins'
import { parseSkin, skinToManifest, manifestToSkin, SKIN_FORMAT } from './theme/manifest'
import { MAX_EXPORT_BYTES, buildExport, planImport, serializeExport } from './theme/transfer'
const BUILTIN_COUNT = BUILTIN_SKINS.length

beforeEach(() => {
  localStorage.clear()
  loadUserSkins()
})
afterEach(() => {
  localStorage.clear()
  loadUserSkins()
})

/** 最短的一份合法皮肤：一个 id、一个名字、一个色号。 */
const MINIMAL = { id: 'sakura', label: '樱', accent: '#d9558a' }

describe('皮肤格式：手写一份皮肤最少要写多少', () => {
  it('**三个字段**就能凑出一套完整皮肤——亮暗两套、色阶、页面底色全都推得出来', () => {
    const got = parseSkin(MINIMAL)
    expect(got.ok).toBe(true)
    if (!got.ok) return
    const skin = manifestToSkin(got.value)

    expect(skin.id).toBe('sakura')
    expect(skin.label).toBe('樱')
    // 亮色那一边用的就是写的那个色号
    expect(skin.light.accent).toBe('#d9558a')
    // 暗色那一边**自动提亮**，不是照抄——同一个色号在暗底上会发闷
    expect(skin.dark.accent).not.toBe(skin.light.accent)
    // 十一条色阶两套都有，且 500 就是那个色号本身
    expect(Object.keys(skin.light.accentScale)).toHaveLength(11)
    expect(skin.light.accentScale['500']).toBe('217 85 138')
    // 页面底色推出来了：亮色几乎白、暗色几乎黑，且都带一点那个色的偏向
    expect(skin.light.pageBg).toMatch(/^#[0-9a-f]{6}$/)
    expect(skin.light.pageBg).not.toBe(skin.dark.pageBg)
    expect(skin.light.pageBg > '#e00000').toBe(true) // 亮色的分量更靠白那头
  })

  it('写了的那一项就用写的，没写的才推——两种来源不互相打架', () => {
    const got = parseSkin({
      ...MINIMAL,
      light: { pageBg: '#fdf0f5' },
      dark: { accent: '#f0a0bc' },
    })
    expect(got.ok).toBe(true)
    if (!got.ok) return
    const skin = manifestToSkin(got.value)
    expect(skin.light.pageBg).toBe('#fdf0f5') // 写了就用
    expect(skin.dark.pageBg).not.toBe('#fdf0f5') // 没写就推
    expect(skin.dark.accent).toBe('#f0a0bc') // 变体里的 accent 胜过顶层那个
    expect(skin.light.accent).toBe('#d9558a') // 另一边不受影响
  })

  it('「没写」与「写错」是两件事：写错认不出的值整条拒绝，不偷偷用推导的值顶替', () => {
    // 顶层没写 accent 是合法的（会推一个兜底色）
    expect(parseSkin({ id: 'x', label: 'X' }).ok).toBe(true)
    // 写了一个不是颜色的东西就是错——**不能**当成「没写」去推，
    // 否则用户把 #d9558a 敲成 #d9558g 之后会看到一套「看起来合理但不是自己要的」皮肤
    const bad = parseSkin({ ...MINIMAL, accent: '#d9558g' })
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.reason).toContain('accent')
    expect(parseSkin({ ...MINIMAL, light: { pageBg: 'red' } }).ok).toBe(false)
    expect(parseSkin({ ...MINIMAL, light: { chart: ['#fff'] } }).ok).toBe(false)
    expect(parseSkin({ ...MINIMAL, light: { accentScale: { '500': '1 2 3' } } }).ok).toBe(false)
  })

  it('id、名字、格式版本都卡住；`__proto__` 这类名字在解析阶段就没了', () => {
    expect(parseSkin({ ...MINIMAL, id: 'Sakura' }).ok).toBe(false) // 大写开头
    expect(parseSkin({ ...MINIMAL, id: '9x'.repeat(20) }).ok).toBe(false) // 太长
    expect(parseSkin({ ...MINIMAL, label: '' }).ok).toBe(false)
    expect(parseSkin({ ...MINIMAL, format: 99 }).ok).toBe(false)
    // **原型污染的第一道闸**：`__proto__`、`constructor`、`prototype` 全被拒。
    // 后两个过得了正则（纯小写字母），靠的是 `RESERVED_IDS` 那份名单——
    // 它们在任何对象字面量上都能命中 `Object.prototype` 的成员。
    for (const id of ['__proto__', 'constructor', 'prototype']) {
      expect(parseSkin({ ...MINIMAL, id }).ok, id).toBe(false)
    }
    // 不是对象的一律拒
    for (const bad of [null, 42, 'x', []]) expect(parseSkin(bad).ok).toBe(false)
  })

  it('色阶写就得写全十一档——少一档会出现「某个类名落在兜底值上」', () => {
    const half = { '500': '1 2 3', '600': '4 5 6' }
    const got = parseSkin({ ...MINIMAL, light: { accentScale: half } })
    expect(got.ok).toBe(false)
    if (!got.ok) expect(got.reason).toContain('50')
  })

  it('导出再导入是同一份（只写一个色号的皮肤不会因此变成一屏数字）', () => {
    const got = parseSkin(MINIMAL)
    expect(got.ok).toBe(true)
    if (!got.ok) return
    const skin = manifestToSkin(got.value)
    const back = skinToManifest(skin)
    expect(back.format).toBe(SKIN_FORMAT)
    // 推导出来的色阶**不写进文件**：写了就等于把推导结果冻住，
    // 而这份文件本来只有三行、是可以手改的
    expect(back.light?.accentScale).toBeUndefined()
    expect(back.light?.neutral).toBeUndefined()
    // 再走一遍得到同一个皮肤
    const again = parseSkin(JSON.parse(JSON.stringify(back)))
    expect(again.ok).toBe(true)
    if (again.ok) expect(manifestToSkin(again.value)).toEqual(skin)
  })

  it('内置皮肤的色阶**会**写进文件里——那两条是手调的，推不出来', () => {
    const m = skinToManifest(skinById('default'))
    expect(m.light?.accentScale?.['600']).toBe('124 58 237')
    // 中性阶反而**不写**：默认皮肤用的就是格式自带的那一份，导出时省掉它既短又无损。
    // 关键是「省掉之后还读得回来同一份」——那 107 那个为了 AA 调过的值正是这样保住的。
    expect(m.light?.neutral).toBeUndefined()
    const back = parseSkin(JSON.parse(JSON.stringify(m)))
    expect(back.ok).toBe(true)
    if (back.ok) expect(manifestToSkin(back.value).light.neutral['500']).toBe('107 107 107')
  })
})

describe('注册表：内置的与导入的', () => {
  it('装上之后 `listSkins` 排在**内置之后**，`skinById` 找得到', () => {
    const got = parseSkin(MINIMAL)
    if (!got.ok) throw new Error('fixture')
    installUserSkins([got.value])

    const all = listSkins()
    expect(all).toHaveLength(BUILTIN_COUNT + 1)
    expect(all[all.length - 1].id).toBe('sakura')
    expect(skinById('sakura').label).toBe('樱')
    expect(isBuiltinSkin('sakura')).toBe(false)
    expect(isBuiltinSkin('default')).toBe(true)
  })

  it('**内置的 id 顶不掉**：导入一份叫 default 的皮肤会被拒，而不是悄悄换掉默认皮肤', () => {
    const got = parseSkin({ ...MINIMAL, id: 'default', label: '假的默认' })
    if (!got.ok) throw new Error('fixture')
    const report = installUserSkins([got.value])
    expect(report.refused).toEqual([{ id: 'default', reason: '与内置皮肤重名' }])
    expect(skinById('default').label).toBe('默认') // 还是原来那个
    expect(listSkins()).toHaveLength(BUILTIN_COUNT)
  })

  it('同 id 再装一次是**覆盖**，不是多出一张卡', () => {
    const a = parseSkin(MINIMAL)
    const b = parseSkin({ ...MINIMAL, label: '樱（改）' })
    if (!a.ok || !b.ok) throw new Error('fixture')
    installUserSkins([a.value])
    const report = installUserSkins([b.value])
    expect(report).toEqual({ added: [], replaced: ['sakura'], refused: [] })
    expect(skinById('sakura').label).toBe('樱（改）')
    expect(listSkins()).toHaveLength(BUILTIN_COUNT + 1)
  })

  it('存下来的能被下一次加载读回来；坏条目丢掉，好的照收', () => {
    const a = parseSkin(MINIMAL)
    if (!a.ok) throw new Error('fixture')
    installUserSkins([a.value])

    // 手改坏存储：混进一条坏的、一条与内置重名的、一条重复的
    const raw = JSON.parse(localStorage.getItem(SKINS_KEY)!)
    raw.skins.push({ id: 'bad', label: 'x', accent: 'not-a-color' })
    raw.skins.push({ id: 'default', label: '假的', accent: '#000000' })
    raw.skins.push({ id: 'sakura', label: '重复的', accent: '#000000' })
    localStorage.setItem(SKINS_KEY, JSON.stringify(raw))

    loadUserSkins()
    const ids = userSkinManifests().map((m) => m.id)
    expect(ids).toEqual(['sakura']) // 坏的、重名的、重复的都没进来
    expect(listSkins()).toHaveLength(BUILTIN_COUNT + 1)
  })

  it('存储里是垃圾时当没装过，**不抛异常**', () => {
    for (const junk of ['{oops', 'null', '[]', '{"skins":"nope"}']) {
      localStorage.setItem(SKINS_KEY, junk)
      expect(() => loadUserSkins()).not.toThrow()
      expect(userSkinManifests()).toEqual([])
      expect(listSkins()).toHaveLength(BUILTIN_COUNT)
    }
  })

  it('删掉之后 `skinById` 退回默认——删掉的正好是当前皮肤也不会变成一个坏皮肤', () => {
    const a = parseSkin(MINIMAL)
    if (!a.ok) throw new Error('fixture')
    installUserSkins([a.value])
    expect(removeUserSkin('sakura')).toBe(true)
    expect(removeUserSkin('sakura')).toBe(false) // 再删一次是空操作
    expect(skinById('sakura').id).toBe('default')
    expect(listSkins()).toHaveLength(BUILTIN_COUNT)
  })

  it('删掉内置的是空操作：它的定义在产品代码里，删了下次构建也会回来', () => {
    expect(removeUserSkin('default')).toBe(false)
    expect(listSkins()).toHaveLength(BUILTIN_COUNT)
  })
})

describe('导入 / 导出', () => {
  const installed = () => new Set(listSkins().map((s) => s.id))
  // **用真的默认设置**，不手写一份：手写的那份会在每次给 `ThemeBg` 加字段时
  // 过期一次（这一轮就过期了一次，编译期报出来的）。夹具要跟着真值走。
  const config = { ...DEFAULT_THEME }

  it('导出的文件**键序固定**，且能被读回来', () => {
    const text = serializeExport(buildExport(config, [], '2026-01-02T03:04:05.000Z'))
    expect(text.endsWith('\n')).toBe(true)
    expect(Object.keys(JSON.parse(text))).toEqual(['schema', 'source', 'exportedAt', 'config', 'skins'])
    expect(planImport(text, [], installed()).ok).toBe(true)
  })

  it('导入是**合并**：文件里没提到的皮肤留在本机不动', () => {
    const local = parseSkin({ ...MINIMAL, id: 'keepme', label: '留着' })
    const incoming = parseSkin(MINIMAL)
    if (!local.ok || !incoming.ok) throw new Error('fixture')
    installUserSkins([local.value])

    const text = serializeExport(buildExport(config, [incoming.value]))
    const plan = planImport(text, userSkinManifests(), installed())
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.value.merged.map((m) => m.id).sort()).toEqual(['keepme', 'sakura'])
  })

  it('同 id 由文件里的胜；坏条目被**跳过并说明原因**，不中止整次导入', () => {
    const older = parseSkin({ ...MINIMAL, label: '旧的' })
    if (!older.ok) throw new Error('fixture')
    installUserSkins([older.value])

    const newer = parseSkin({ ...MINIMAL, label: '新的' })
    if (!newer.ok) throw new Error('fixture')
    const text = serializeExport(
      // 混进一条坏的（手改文件是最常见的用法，改错了要有话说）
      buildExport(config, [newer.value, { id: 'oops', label: '坏', accent: '#zzz' } as never])
    )
    const plan = planImport(text, userSkinManifests(), installed())
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.value.merged.find((m) => m.id === 'sakura')?.label).toBe('新的')
    expect(plan.value.refused).toHaveLength(1)
    expect(plan.value.refused[0].id).toBe('oops')
    expect(plan.value.refused[0].reason).toContain('accent')
  })

  it('设置指名了一个装不上的皮肤时**要说出来**，不能静默退回默认', () => {
    const text = serializeExport(buildExport({ ...config, skin: 'ghost' }, []))
    const plan = planImport(text, [], installed())
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.value.missingSkin).toBe('ghost')
    // 同名皮肤跟着文件一起来的时候就不算缺
    const withSkin = parseSkin({ ...MINIMAL, id: 'ghost', label: '鬼' })
    if (!withSkin.ok) throw new Error('fixture')
    const text2 = serializeExport(buildExport({ ...config, skin: 'ghost' }, [withSkin.value]))
    const plan2 = planImport(text2, [], new Set([...installed(), 'ghost']))
    expect(plan2.ok && plan2.value.missingSkin).toBe(null)
  })

  it('设置走的是**和读取本机存储完全一样**的那条路（逐字段兜底）', () => {
    const text = JSON.stringify({
      schema: 1,
      source: 'x',
      exportedAt: '',
      config: { skin: 'nope', mode: 'yes', accent: 'not-a-color', bg: { scrim: 999 } },
      skins: [],
    })
    const plan = planImport(text, [], installed())
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.value.config.skin).toBe('default')
    expect(plan.value.config.mode).toBe('light')
    expect(plan.value.config.accent).toBe('')
    expect(plan.value.config.bg.scrim).toBe(95)
  })

  it('顶层不是这份文件时明确拒绝（版本 / 空 / 非 JSON / 顶层类型）', () => {
    expect(planImport('', [], installed()).ok).toBe(false)
    expect(planImport('   ', [], installed()).ok).toBe(false)
    expect(planImport('{oops', [], installed()).ok).toBe(false)
    expect(planImport('[1,2,3]', [], installed()).ok).toBe(false)
    expect(planImport('{"schema":99}', [], installed()).ok).toBe(false)
    const tooBig = planImport('x'.repeat(MAX_EXPORT_BYTES + 1), [], installed())
    expect(tooBig.ok).toBe(false)
    if (!tooBig.ok) expect(tooBig.reason).toContain('太大')
  })

  it('**校验的是合并之后的结果**：装完会超过可导出上限时整次拒绝', () => {
    // 一份文件里最多 64 个皮肤（`MAX_EXPORT_SKINS`），所以「装完超过上限」不是
    // 一次导入能造成的，而是**攒出来的**：同一台机器反复导入、皮肤越积越多。
    // 那个状态一旦形成，用户再也导不出备份，而他不会知道——所以在这里挡住。
    //
    // 夹具直接喂 `currentSkins`（本机已装的），因为要造的就是「已经攒了很多」。
    const scale = Object.fromEntries(
      ['50', '100', '200', '300', '400', '500', '600', '700', '800', '900', '950'].map((s) => [
        s,
        '255 255 255',
      ])
    )
    const bulk = Array.from({ length: 260 }, (_, i) => ({
      format: 1,
      id: `bulk-${i}`,
      label: `批量${i}`,
      accent: '#123456',
      light: { accentScale: scale, neutral: scale },
      dark: { accentScale: scale, neutral: scale },
    }))
    const plan = planImport(serializeExport(buildExport(config, [])), bulk as never, installed())
    expect(plan.ok).toBe(false)
    if (!plan.ok) expect(plan.reason).toContain('备份不出来')
    // 同样的文件在没有攒下那些皮肤时是导得进去的——说明挡住的确实是「合并之后」
    expect(planImport(serializeExport(buildExport(config, [])), [], installed()).ok).toBe(true)
  })
})

describe('皮肤注册表：改名', () => {
  function install(id: string, label: string): void {
    const got = parseSkin({ id, label, accent: '#d9558a' })
    if (!got.ok) throw new Error(got.reason)
    installUserSkins([got.value])
  }

  it('改完当场生效，并且**落盘**（下次打开还是新名字）', () => {
    install('sakura', '樱')
    const got = renameUserSkin('sakura', '春')
    expect(got).toEqual({ ok: true, value: '春' })
    expect(skinById('sakura').label).toBe('春')
    expect(userSkinManifests()[0].label).toBe('春')

    // 真的写进存储了：重新装回来还是新名字
    loadUserSkins()
    expect(skinById('sakura').label).toBe('春')
  })

  it('名字去首尾空白，且**返回的是校验过的那个**', () => {
    install('sakura', '樱')
    const got = renameUserSkin('sakura', '  春  ')
    expect(got).toEqual({ ok: true, value: '春' })
  })

  it('**名字不合规时整次拒绝**，而不是把一条坏数据存下来', () => {
    // 这条防的是一个很难查的 bug：`installUserSkins` 信任调用方（收的是「已经想清楚的
    // 结果」），从那里塞一个 40 个字的名字会被原样存下来——而下次打开时
    // `loadUserSkins` 逐条 `parseSkin` 会把它**丢掉**，症状是
    // 「改完名字，刷新之后这个皮肤没了」。所以校验必须在改名的入口上。
    install('sakura', '樱')
    const tooLong = renameUserSkin('sakura', '名'.repeat(40))
    expect(tooLong.ok).toBe(false)
    if (!tooLong.ok) expect(tooLong.reason).toContain('最多')
    // 没改成，但**皮肤还在**，名字也还是原来那个
    expect(skinById('sakura').label).toBe('樱')
    expect(userSkinManifests()).toHaveLength(1)

    const empty = renameUserSkin('sakura', '   ')
    expect(empty.ok).toBe(false)
    expect(skinById('sakura').label).toBe('樱')
  })

  it('改不存在的皮肤：明确说没有，不静默成功', () => {
    expect(renameUserSkin('nope', 'x').ok).toBe(false)
  })

  it('改名**不动别的皮肤**，也不动内置的那几张', () => {
    install('a', '甲')
    install('b', '乙')
    renameUserSkin('a', '甲甲')
    expect(userSkinManifests().map((m) => `${m.id}:${m.label}`)).toEqual(['a:甲甲', 'b:乙'])
    expect(skinById('default').label).not.toBe('甲甲')
  })
})
