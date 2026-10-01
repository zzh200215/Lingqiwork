// 皮肤注册表的后端副本同步。
//
// 钉的是 `registry.ts` 那两条「方向性」：
// ① 推送是**发起后不管**——后端没起不该挡住本地用皮肤（本地优先的默认行为）；
// ② 恢复只发生在「本地连键都没有」的那一次——**用户删光的空清单是决定，不是丢失**，
//    拿副本盖回来等于把用户的删除动作撤销掉。
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  SKINS_CHANGED_EVENT,
  installUserSkins,
  loadUserSkins,
  restoreIfEmpty,
  userSkinManifests,
} from './registry'
import type { SkinManifest } from './manifest'
import { SKINS_KEY } from './registry'

const MANIFEST: SkinManifest = {
  format: 1,
  id: 'photo-abc',
  label: '海边',
  hint: '',
  accent: '#c2703a',
  light: {
    bg: { image: '/api/images/img-20261001-120000-abcdef.png', fit: 'cover', scrim: 72, scrimDir: 'edge', blur: 0 },
  },
  dark: {},
}

const fetchMock = vi.fn()

function okResponse(body: unknown) {
  return { ok: true, json: async () => body }
}

afterEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
  loadUserSkins() // 复位注册表那份模块级状态（与 AppearanceSettings.test 同一条纪律）
})

describe('皮肤副本 · 推送', () => {
  it('装皮肤会镜像到后端，形状与 localStorage 同一份', async () => {
    vi.stubGlobal('fetch', fetchMock.mockResolvedValue(okResponse({ skins: {} })))
    installUserSkins([MANIFEST])
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/settings/skins',
        expect.objectContaining({ method: 'PUT' }),
      )
    })
    const body = JSON.parse(vi.mocked(fetchMock).mock.calls[0][1].body)
    expect(body).toEqual({ version: 1, skins: [MANIFEST] })
  })

  it('后端够不着不抛错——发起后不管，本地照常装上', async () => {
    vi.stubGlobal('fetch', fetchMock.mockRejectedValue(new TypeError('Failed to fetch')))
    const report = installUserSkins([MANIFEST])
    expect(report.added).toEqual(['photo-abc']) // 本地优先：副本失败不影响正本
    await new Promise((r) => setTimeout(r, 0)) // 给被拒的 promise 一个机会证明它没炸出去
  })
})

describe('皮肤副本 · 恢复', () => {
  it('本地连键都没有（新浏览器）才从后端恢复，恢复完发事件', async () => {
    vi.stubGlobal(
      'fetch',
      fetchMock.mockResolvedValue(okResponse({ skins: { version: 1, skins: [MANIFEST] } })),
    )
    localStorage.clear()
    loadUserSkins() // 模拟「新浏览器第一次打开」：注册表是空的

    let changed = 0
    window.addEventListener(SKINS_CHANGED_EVENT, () => changed++)
    const restored = await restoreIfEmpty()

    expect(restored).toBe(true)
    expect(userSkinManifests().map((m) => m.id)).toEqual(['photo-abc'])
    expect(changed).toBe(1) // React 靠这一下重新解析皮肤
    expect(JSON.parse(localStorage.getItem(SKINS_KEY)!).skins).toHaveLength(1) // 恢复的也落回正本
  })

  it('本地有清单就 never 恢复——哪怕是个空清单（那是用户删光的）', async () => {
    vi.stubGlobal('fetch', fetchMock)
    localStorage.setItem(SKINS_KEY, JSON.stringify({ version: 1, skins: [] }))
    loadUserSkins()

    const restored = await restoreIfEmpty()

    expect(restored).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('后端没有副本（从没同步过）就安静地留在空状态', async () => {
    vi.stubGlobal('fetch', fetchMock.mockResolvedValue(okResponse({ skins: null })))
    localStorage.clear()
    loadUserSkins()

    expect(await restoreIfEmpty()).toBe(false)
    expect(userSkinManifests()).toHaveLength(0)
  })
})

// 守卫登记：本仓的静默 catch 账本在 `designRules.test.ts`——registry.ts 里
// mirrorToBackend 的 `.catch(() => {})` 与 restoreIfEmpty 的 `catch { return false }`
// 都已登记（理由：副本失败不该挡住本地优先的默认行为）。
