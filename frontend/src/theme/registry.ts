/** 皮肤注册表：**内置的那几个 + 用户导入的那些**，合成一份「现在有哪些皮肤」。
 *
 *  ## 为什么需要一个「活的」注册表
 *
 *  内置皮肤是常量，用户导入的皮肤是运行时才有的——而 `resolveTheme()` 要按 id 找皮肤，
 *  它是个纯函数，拿不到 React 的 state。所以查找这件事必须由模块级的一份索引回答。
 *  这个文件就是那份索引，也是**唯一一处**「谁能被当成皮肤」的判断。
 *
 *  ## 三条不变量
 *
 *  1. **内置的 id 不可被顶掉。** 导入一份 id 叫 `default` 的皮肤会被拒，而不是
 *     悄悄替换掉默认皮肤——「我导入了个皮肤，结果默认皮肤变了」是最难查的一类问题。
 *  2. **索引是 `Map` 不是对象字面量。** 对象字面量上 `__proto__`、`constructor`
 *     这些名字会命中原型链（`SKINS['constructor']` 能取到 `Object` 构造函数——
 *     那是个真的能把页面搞崩的返回值）。`Map` 没有这个问题，
 *     而 `manifest.ts` 的 `SKIN_ID_RE` 是更前面的那道闸。
 *  3. **一个坏条目不影响别的条目。** 存储里逐条 `parseSkin`，认不出的丢掉，
 *     剩下的照常装——一条手改坏的皮肤不该让整页皮肤表消失。
 *
 *  ## 存的形状
 *
 *  `wb:skins` = `{ version, skins: SkinManifest[] }`，即**存数据、不存运行时对象**
 *  （运行时那份里有 11 档色阶，存下来既大又没必要——它本来就能从数据推出来）。
 *  这样「导出的 JSON」与「存在本机的 JSON」是同一个形状，两者之间不需要转译。 */
import { manifestToSkin, parseSkin, type Parsed, type SkinManifest } from './manifest'
import { BUILTIN_SKINS, type Skin } from './skins'

/** 用户导入的皮肤存在这里。与 `wb:theme` 分开：皮肤是「装了什么东西」，
 *  不是「一项设置」——把几 KB 的色阶表塞进每次 `PUT /api/settings/theme` 里没必要。 */
export const SKINS_KEY = 'wb:skins'
const SKINS_VERSION = 1

const builtinIds = new Set(BUILTIN_SKINS.map((s) => s.id))
const builtinById = new Map<string, Skin>(BUILTIN_SKINS.map((s) => [s.id, s]))

/** 当前装着的用户皮肤（数据形态）。**这是唯一真相**，下面的两个索引都从它推。 */
let manifests: SkinManifest[] = []
let byId = new Map<string, Skin>()
let ordered: Skin[] = [...BUILTIN_SKINS]

function rebuild(): void {
  byId = new Map(manifests.map((m) => [m.id, manifestToSkin(m)]))
  // 内置的在前、导入的在后：内置那几个是「产品给的样子」，
  // 自己导入的排在后面，符合「我的东西放在货架后段」的直觉。
  ordered = [...BUILTIN_SKINS, ...manifests.map((m) => byId.get(m.id)!)]
}

// ---------- 读 ----------

/** 全部皮肤，**按展示顺序**（内置在前，导入的按导入顺序在后）。 */
export function listSkins(): Skin[] {
  return ordered
}

/** 按 id 找皮肤。**永远返回一个能用的**——认不出就退回默认。
 *  主题是全站的底噪，不该为了一个错别字把页面变成无色。 */
export function skinById(id: string): Skin {
  return builtinById.get(id) ?? byId.get(id) ?? builtinById.get('default')!
}

export function hasSkin(id: string): boolean {
  return builtinById.has(id) || byId.has(id)
}

export function isBuiltinSkin(id: string): boolean {
  return builtinIds.has(id)
}

/** 当前装着的用户皮肤（数据形态，深拷一层给出去）。
 *  导出用这个，而不是 `listSkins()` —— 后者里混着内置的六个。 */
export function userSkinManifests(): SkinManifest[] {
  return manifests.map((m) => ({ ...m, light: { ...m.light }, dark: { ...m.dark } }))
}

// ---------- 写 ----------

export interface InstallReport {
  /** 新装上的 id */
  added: string[]
  /** 覆盖掉旧版本的同 id 用户皮肤 */
  replaced: string[]
  /** 被拒的 id → 原因（目前只有一种：想顶掉内置皮肤） */
  refused: { id: string; reason: string }[]
}

/** 装一批用户皮肤并落盘。**同 id 覆盖、内置 id 拒绝、其余照收。**
 *
 *  不在这里做「合并」判断：那是导入流程的事（见 `transfer.ts` 的
 *  「先校验合并后的结果再落盘」）。这里只管把一份已经想清楚的结果装上。 */
export function installUserSkins(incoming: SkinManifest[]): InstallReport {
  const report: InstallReport = { added: [], replaced: [], refused: [] }
  const next = [...manifests]

  for (const m of incoming) {
    if (builtinIds.has(m.id)) {
      report.refused.push({ id: m.id, reason: '与内置皮肤重名' })
      continue
    }
    const at = next.findIndex((x) => x.id === m.id)
    if (at >= 0) {
      next[at] = m
      report.replaced.push(m.id)
    } else {
      next.push(m)
      report.added.push(m.id)
    }
  }

  manifests = next
  rebuild()
  persist()
  return report
}

/** 删掉一个用户皮肤。删掉之后如果它正是当前皮肤，**不用在这里处理**——
 *  `skinById` 会退回默认，下一次 `resolveTheme` 自然就对了。 */
export function removeUserSkin(id: string): boolean {
  const at = manifests.findIndex((m) => m.id === id)
  if (at < 0) return false
  manifests = manifests.filter((_, i) => i !== at)
  rebuild()
  persist()
  return true
}

/** 改一个用户皮肤的名字。返回**校验过的那个名字**。
 *
 *  **必须走 `parseSkin`，不是直接改字段。** 这不是形式主义：`installUserSkins`
 *  信任调用方（它收的是「已经想清楚的结果」，见上面那段），所以从那里塞进去一个
 *  40 个字的名字会被原样存下来——而下次打开时 `loadUserSkins` 逐条 `parseSkin`
 *  会把它**丢掉**。症状是「改完名字，刷新之后这个皮肤没了」，
 *  而用户不会想到是名字太长害的。把校验放在唯一能改 label 的入口上，这条路就堵死了。 */
export function renameUserSkin(id: string, label: string): Parsed<string> {
  const at = manifests.findIndex((m) => m.id === id)
  if (at < 0) return { ok: false, reason: '本机没有这个皮肤' }
  const got = parseSkin({ ...manifests[at], label })
  if (!got.ok) return got
  manifests = manifests.map((m, i) => (i === at ? got.value : m))
  rebuild()
  persist()
  return { ok: true, value: got.value.label }
}

function persist(): void {
  try {
    localStorage.setItem(SKINS_KEY, JSON.stringify({ version: SKINS_VERSION, skins: manifests }))
  } catch {
    /* 存不下（隐私模式 / 配额满）就只在这一次会话里有效——
       为此挡住「导入一个皮肤」不值得 */
  }
}

/** 从 localStorage 装回来。**模块加载时自己跑一次**（见文件末尾），
 *  因为 `resolveTheme` 在 React 之前就要能按 id 找到皮肤。 */
export function loadUserSkins(): void {
  let raw: string | null = null
  try {
    raw = localStorage.getItem(SKINS_KEY)
  } catch {
    /* 读不到（隐私模式）就当没装过 */
  }
  if (!raw) {
    manifests = []
    rebuild()
    return
  }

  let parsed: unknown = null
  try {
    parsed = JSON.parse(raw)
  } catch {
    parsed = null
  }
  const list =
    parsed && typeof parsed === 'object' && Array.isArray((parsed as { skins?: unknown }).skins)
      ? ((parsed as { skins: unknown[] }).skins as unknown[])
      : []

  const kept: SkinManifest[] = []
  const seen = new Set<string>()
  for (const item of list) {
    const got = parseSkin(item)
    // 三条都要过：解析得了、不与内置重名、彼此不重名。
    // 最后一条防的是「存储被人手改出两个同 id 条目」——那会让「删掉它」只删掉一个。
    if (!got.ok || builtinIds.has(got.value.id) || seen.has(got.value.id)) continue
    seen.add(got.value.id)
    kept.push(got.value)
  }
  manifests = kept
  rebuild()
}

// 模块加载即读一次。放在文件末尾（函数都声明完了），是这一层唯一的副作用。
loadUserSkins()
