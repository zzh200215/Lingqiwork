/** 皮肤库的**策展数据**：分组与轻量标签。
 *
 *  ## 为什么它不在皮肤数据格式里
 *
 *  §8.2 的纪律是「皮肤是数据」——但那说的是**皮肤自己**的属性（色阶、底图、通透度）。
 *  「推荐哪几套」「它该摆在哪个货架」是**产品对货架的整理**，不是皮肤的属性：
 *  用户导入的皮肤不会有分组（它们只进「我的皮肤」），内置皮肤改一个标签也不该
 *  动到 `SkinManifest` 的格式与校验。所以这张表住在 UI 层，与 `BUILTIN_MANIFESTS`
 *  的展示顺序（那也是产品定的）是同一类东西。
 *
 *  ## 写法上的两条纪律
 *
 *  1. **`ids` 里只许写内置皮肤的 id**。写了个不存在的 id，`groupOf()` 会把它当
 *     「未分组」处理——而下面那条守卫测试会让这种事当场红，不用等到界面上发现
 *     「推荐那一栏少了一套」。
 *  2. **每个 id 最多出现在一个分组里**，且四组合计必须**盖住全部内置皮肤**——
 *     否则「全部」视图里会有一套皮肤哪个栏目都不属于，看起来像丢了。
 *
 *  标签（`SKIN_TAGS`）同理：一两个词的「气质」描述，给扫视用的，不是第二份 hint
 *  ——hint 是一句话，标签是一个词。 */

export interface GalleryGroup {
  key: string
  label: string
  ids: string[]
}

/** 货架顺序即展示顺序：推荐在最前，往下越来越「有氛围」。 */
export const GALLERY_GROUPS: GalleryGroup[] = [
  { key: 'featured', label: '推荐', ids: ['default', 'night', 'firefly'] },
  { key: 'ambient', label: '氛围', ids: ['aurora', 'ridge'] },
  { key: 'minimal', label: '极简', ids: ['ink', 'paper', 'grid'] },
  { key: 'mood', label: '色彩', ids: ['forest', 'ocean', 'warm'] },
]

/** 「我的皮肤」在筛选条上的 key。它不是一个真分组——内容是**注册表里活的清单**，
 *  不在这张表里。 */
export const MINE_KEY = 'mine'

/** 内置皮肤的轻量标签。**一两个词**，写在卡片名下当扫视用的锚点。 */
export const SKIN_TAGS: Record<string, string[]> = {
  default: ['经典'],
  night: ['深底'],
  ink: ['黑白'],
  forest: ['护眼'],
  ocean: ['清爽'],
  warm: ['暖调'],
  firefly: ['夜色', '萤火虫'],
  paper: ['纸纹'],
  aurora: ['底图', '半透明'],
  ridge: ['底图', '半透明'],
  grid: ['格纹'],
}

/** 一个皮肤 id 归哪个分组。找不到（用户皮肤、或 ids 写漏了）返回 null——
 *  调用方据此把它落进「我的皮肤」或「未分组」。 */
export function groupOf(skinId: string): GalleryGroup | null {
  return GALLERY_GROUPS.find((g) => g.ids.includes(skinId)) ?? null
}
