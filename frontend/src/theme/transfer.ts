/** 把「外观这套设置」变成一份可以带走、可以贴给别人的文件，以及从这样一份文件里
 *  把它读回来。
 *
 *  ## 导出的到底是什么
 *
 *  两样东西，因为「换个外观」在这套系统里是两件事：
 *    · **设置**——用哪套皮肤、亮还是暗、强调色、背景（纯色 / 渐变 / 图片地址）。
 *    · **皮肤本身**——本机导入过的那些。内置那六个不写进去：它们是产品自带的，
 *      导出一份「内置皮肤的副本」只会让导入方多出六个重名的、必然被拒的条目。
 *
 *  ## 三条来自参考实现的规矩
 *
 *  1. **只收认得的字段，逐项校验。** 一份从别处来的文件可能来自别的版本、可能被
 *     手改坏、可能根本不是这个产品的文件。判据是白名单而不是黑名单。
 *  2. **合并，不是整份替换。** 文件里没提到的皮肤留在本机不动——备份的意义是
 *     「把我原来那套带回来」，不是「把我现在这套清掉」。
 *  3. **先算出「合并之后会是什么样」并校验，再落盘。** Codex-QQ-Skin 与
 *     dsh-deep-whale 都栽过同一类事：导入成功、但导出的结果再也导不回来，
 *     于是用户以为备份好了，其实那份备份是废的。校验的结果对象而不是输入，
 *     才能保证「存下来的东西一定还能读回来」。
 *
 *  ## 为什么这个文件不碰 DOM
 *
 *  读文件、写文件、触发下载都是浏览器的事，留在组件里；这里只处理字符串。
 *  于是整套导入导出**不需要渲染任何东西就能测**——包括那些「半坏的文件」的用例。 */
import { parseSkin, type SkinManifest } from './manifest'
import { parseTheme, type Parsed, type ThemeConfig } from '../theme'

/** 文件的格式版本。读到别的数字就整份拒绝——见 `manifest.ts` 里同一句话的理由。 */
export const EXPORT_SCHEMA = 1

/** 写在文件里的来源标记。导入时**不**据此拒绝（判据是结构，不是出身），
 *  但它让「这是谁导出的」在文件里留个痕，出问题时能看出来。
 *  参考实现（dsh-deep-whale 的 transfer）也是这么用 `source` 的。 */
export const EXPORT_SOURCE = 'ai-workbench/appearance'

/** 体积上限。**这份文件是给人看、给人手改的**，超过这个量级说明它已经不是一份
 *  「设置」了（多半是被塞进了图片数据之类）。卡住它比事后解释便宜。
 *  图片背景存的是地址不是内容，所以正常文件只有几 KB。 */
export const MAX_EXPORT_BYTES = 256 * 1024

/** 文件里最多带多少份皮肤。同样是防「这不该是一份设置文件」。 */
export const MAX_EXPORT_SKINS = 64

export interface AppearanceExport {
  schema: number
  source: string
  /** ISO 时间戳。只用于「这份是什么时候导的」，不参与任何判断。 */
  exportedAt: string
  config: ThemeConfig
  skins: SkinManifest[]
}

/** **皮肤分享文件**：只有皮肤、没有设置的那一种。导出一个皮肤给别人的时候，
 *  收的人要的是「装上这张卡」，不是「连你的亮暗、强调色、壁纸一起搬过来」——
 *  所以这份文件**不带 config**，导入时保留对方当前的外观。
 *  结构上是 `AppearanceExport` 去掉 config，`planImport` 认得它。 */
export interface SkinShare {
  schema: number
  source: string
  exportedAt: string
  skins: SkinManifest[]
}

/** 组装一份**单皮肤分享**。与 `buildExport` 分开：两者「带不带外观」是两种意图，
 *  在文件里就应该是两种形状，而不是靠接收方去猜。 */
export function buildSkinShare(skins: SkinManifest[], now?: string): SkinShare {
  return {
    schema: EXPORT_SCHEMA,
    source: EXPORT_SOURCE,
    exportedAt: now ?? new Date().toISOString(),
    skins,
  }
}

/** 组装一份导出。**键的顺序是固定的**（schema → source → exportedAt → config → skins）：
 *  固定顺序的 JSON 才可能进版本管理、才可能被人用 diff 看出一处改动。 */
export function buildExport(config: ThemeConfig, skins: SkinManifest[], now?: string): AppearanceExport {
  return {
    schema: EXPORT_SCHEMA,
    source: EXPORT_SOURCE,
    exportedAt: now ?? new Date().toISOString(),
    config,
    skins,
  }
}

export function serializeExport(e: AppearanceExport | SkinShare): string {
  // 末尾一个换行：这是文本文件，不是数据流。
  return `${JSON.stringify(e, null, 2)}\n`
}

/** 导入之后会发生什么。**先在内存里算清楚，再决定要不要落盘**——
 *  界面上要能说出「会装上 2 个皮肤、跳过 1 个、当前皮肤会退回默认」，
 *  而不是「导入成功」四个字。 */
export interface ImportPlan {
  /** 文件里那份设置（已经过 `parseTheme` 收拾）。 */
  config: ThemeConfig
  /** 合并之后本机应有的用户皮肤（现有 + 文件里的，同 id 由文件里的胜）。 */
  merged: SkinManifest[]
  /** 文件里带了但会被丢掉的条目及原因。 */
  refused: { id: string; reason: string }[]
  /** 设置里指名的皮肤，既不在这份文件里、也没装在本机——装完之后它会退回默认。
   *  **这是要说出来的一件事**，不是可以静默处理掉的：用户导入完会看到「我的皮肤
   *  不对」，而他不会知道原因在文件里少了一份皮肤。读的是**文件里写的那个名字**，
   *  不是收拾过之后的（见 `planImport` 里那段说明）。 */
  missingSkin: string | null
  /** 这份文件**带不带外观设置**。皮肤分享文件（`buildSkinShare` 的产物）不带——
   *  导入它只装皮肤，外观保持对方自己那套；界面的说明文字按它分叉。 */
  appliesConfig: boolean
}

/** 读一份文件，算出「装上去会是什么样」。**纯函数**：不改任何东西。
 *
 *  `currentSkins` 是本机现在装着的那些（`userSkinManifests()`），
 *  `installedIds` 是「装完之后本机会有哪些皮肤 id」（内置 + 现有 + 文件里的）——
 *  由调用方给，因为「装没装」这件事的真相在注册表里，不在这里。
 *
 *  `currentConfig` 只在**皮肤分享文件**（不带 config 的那种）进口时用：那种文件
 *  不该动对方的外观，计划里的 config 就是他现在这份。带 config 的文件照旧
 *  全盘应用——两种文件、两种意图，判据是**结构**（有没有 config 字段），
 *  不是文件名或来源标记。 */
export function planImport(
  text: string,
  currentSkins: SkinManifest[],
  installedIds: Set<string>,
  currentConfig?: ThemeConfig
): Parsed<ImportPlan> {
  if (!text.trim()) return { ok: false, reason: '文件是空的' }
  // 先卡体积再 parse：一份 200MB 的文本不该先被 JSON.parse 走一遍。
  if (text.length > MAX_EXPORT_BYTES) {
    return { ok: false, reason: `文件太大了（上限 ${Math.round(MAX_EXPORT_BYTES / 1024)} KB）` }
  }

  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { ok: false, reason: '这不是一份合法的 JSON 文件' }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: '文件顶层应该是一个对象' }
  }
  const o = raw as Record<string, unknown>

  if (o.schema !== EXPORT_SCHEMA) {
    return { ok: false, reason: `格式版本对不上（这份是 ${String(o.schema)}，当前是 ${EXPORT_SCHEMA}）` }
  }

  // 设置：走 `parseTheme` 那条**和读取本机存储完全一样**的路。
  // 一份从别处来的设置与本机存的那份是同一种东西，就不该有两套读法——
  // 两套读法的下场是「本机存的能读、导入的读不了」，或者反过来的静默差异。
  //
  // **皮肤分享文件没有 config**：计划里的设置就是调用方现在这份（导入它 = 只装
  // 皮肤，外观不动）。没传 currentConfig 的话退回默认——那是「裸调这个函数」的
  // 老行为，不至于崩，但 UI 永远该传。
  const sharesOnly = o.config === undefined && Array.isArray(o.skins)
  const base = parseTheme(sharesOnly ? (currentConfig ?? {}) : o.config)

  // ---- 先读文件里的皮肤，再定设置里的皮肤 ----
  //
  // **顺序是有原因的**：设置里那一项 `skin` 要按「装完之后本机有什么」判，
  // 而「装完之后」得先知道这份文件带了哪些皮肤。反过来先定皮肤的话，
  // 「设置和皮肤一起导出、一起导入」这种**最常见的用法**会把皮肤选择悄悄丢掉——
  // 用户看到的是「导入成功了，但皮肤还是原来那个」。
  //
  // 另外 `parseTheme` 本身会把认不出的皮肤名收拾成默认皮肤（对本机存的那份来说
  // 这是对的：一个错别字不该让页面变成无色）。所以「文件里本来要哪套皮肤」必须在
  // 收拾之前读出来，再按装完之后的清单重判一次。
  const cfgRaw = o.config && typeof o.config === 'object' ? (o.config as Record<string, unknown>) : {}
  const askedSkin = typeof cfgRaw.skin === 'string' && cfgRaw.skin ? cfgRaw.skin : ''

  const refused: { id: string; reason: string }[] = []
  const fromFile: SkinManifest[] = []
  const list = Array.isArray(o.skins) ? o.skins : []
  if (list.length > MAX_EXPORT_SKINS) {
    return { ok: false, reason: `一份文件里最多 ${MAX_EXPORT_SKINS} 个皮肤` }
  }
  for (const item of list) {
    const got = parseSkin(item)
    if (got.ok) fromFile.push(got.value)
    else {
      // 一个坏条目**不影响别的条目**，也不中止整次导入：它是这份文件里的一条，
      // 用户要看到的是「跳过了哪一个、为什么」，而不是「导入失败」。
      const id =
        item && typeof item === 'object' && typeof (item as { id?: unknown }).id === 'string'
          ? String((item as { id: string }).id)
          : '(没有 id)'
      refused.push({ id, reason: got.reason })
    }
  }

  // 装完之后会有哪些皮肤 = 本机现在有的 + 这份文件带来的
  const afterInstall = new Set([...installedIds, ...fromFile.map((m) => m.id)])
  const config: ThemeConfig =
    askedSkin && afterInstall.has(askedSkin) ? { ...base, skin: askedSkin } : base

  // 合并：现有的一律留下，同 id 的由文件里的覆盖。
  const merged = [...currentSkins]
  for (const m of fromFile) {
    const at = merged.findIndex((x) => x.id === m.id)
    if (at >= 0) merged[at] = m
    else merged.push(m)
  }

  // ---- 合并之后的自检：校验的是**结果**，不是输入 ----
  //
  // 这一段的判据不是「文件合法吗」（上面已经查过了），而是「装上去之后，这台机器
  // 还处在能正常工作的状态吗」。参考实现（dsh-deep-whale 的 transfer）有一条
  // 一模一样的规矩：**导入的结果必须仍然导得出去**。理由很实在——用户做备份的
  // 那一天才发现备份做不出来，比一开始就装不上糟得多。

  // 1. 装完之后仍然导得出去。装了太多皮肤的话，序列化结果会越过导出的体积上限，
  //    那之后用户再也做不出备份，而他不会知道。
  const size = serializeExport(buildExport(config, merged)).length
  if (size > MAX_EXPORT_BYTES) {
    return {
      ok: false,
      reason: `装上去之后会超过可导出的上限（${Math.round(MAX_EXPORT_BYTES / 1024)} KB），那之后就备份不出来了`,
    }
  }
  // 2. 同 id 只该有一份。合并是按 id 去重的，这里把这条不变量钉住——
  //    真出现两份同 id 的话，「删掉它」只会删掉一个，剩下那个永远删不掉。
  if (new Set(merged.map((m) => m.id)).size !== merged.length) {
    return { ok: false, reason: '合并之后出现了重名的皮肤，已中止' }
  }

  return {
    ok: true,
    value: {
      config,
      merged,
      refused,
      // 判据是 `afterInstall`（本机现在有的 + 这份文件带来的），不是「本机现在有的」：
      // 文件里自带的那套皮肤装完之后就在了，不该报成缺失。
      missingSkin: afterInstall.has(askedSkin) ? null : askedSkin,
      appliesConfig: !sharesOnly,
    },
  }
}
