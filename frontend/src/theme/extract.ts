/** 从**一张图片**里取出一套皮肤：强调色、以及该压多暗。
 *
 *  ## 为什么要有这个文件
 *
 *  在这之前，「上传一张图」得到的是一件**背景**：它盖在页面上，而强调色还是上一个
 *  皮肤的那个。一张暖橙色的日落照压在紫色按钮下面，看起来不像一套配色，
 *  像一次事故。人挑图的时候心里想的是「整个工作台变成这个样子」，
 *  而只换背景只兑现了其中一半。
 *
 *  所以这里做的是：**图 → 一个色号**，然后交给已有的那套推导
 *  （`accentPalette` 出色阶、`resolvePageBg` 出页面底色、`resolveAccent` 出暗色那一套）。
 *  一套皮肤需要的十一条色阶、两个变体、页面底色，**这里一个都不算**——
 *  那些已经有主了，重复一份就是开第二个真相。
 *
 *  ## 三件事，按「纯不纯」分开
 *
 *  1. **量化与挑色**（`medianCut` / `pickAccent`）：纯函数，喂一组像素就能测。
 *  2. **算压暗**（`scrimForImage`）：纯函数，喂一个颜色就能测。
 *  3. **读像素**（`readImageStats`）：唯一碰 DOM 的一段。
 *     jsdom 里没有 canvas，所以这一段**测不了，只能在真浏览器里验**
 *     ——这也是整个背景功能一直以来的验收方式（见 `docs/ui-design-contract.md` §8.3）。
 *
 *  ## 取到的是什么，不是什么
 *
 *  取的是一个**能用**的颜色，不是一个**准确**的颜色。图里没有「正确的强调色」这回事，
 *  只有「哪一块更像这套配色该有的样子」。所以下面所有的判据都写成可解释的规则
 *  （占比、饱和度、明度），而不是一个说不清的分数——规则能被讨论、能被改，分数不能。
 *
 *  量化那一段是照着两套成熟实现来的（color-thief 与 node-vibrant 的 MMCQ）：
 *  5 位量化、两段式切分、按占比/饱和度/明度打分。**没有自己发明一套**，
 *  因为「从图里挑一个颜色」这件事已经被做过很多遍了，而那些常数是调出来的。 */
import {
  BLACK,
  WHITE,
  contrastRatio,
  hslToRgb,
  mix,
  relativeLuminance,
  rgbToHex,
  rgbToHsl,
  withSaturation,
  type Rgb,
} from './color'
import { DEFAULT_BG, DEFAULT_TINT, VEIL_FACTORS, isSafeImageUrl, type Tint } from './background'
import { CHROME_VEIL, type SkinSurfacesInput } from './surfaces'
import {
  DEFAULT_NEUTRAL_DARK,
  DEFAULT_NEUTRAL_LIGHT,
  MAX_LABEL,
  MIN_SKIN_SCRIM,
  SKIN_FORMAT,
  parseSkin,
  type Parsed,
  type SkinBg,
  type SkinManifest,
} from './manifest'

/** 采样边长（像素）。**128 是 Material 自己那份开发指南给的数**
 *  （matugen 用 112，node-vibrant 默认缩到 1/25 的像素）。16384 个样本估一个主色
 *  早就够了，而再多的样本只会让同一片渐变的碎块更多、切出来的盒子更杂。
 *
 *  要紧的是**读像素之前先画小**：一张 4000×3000 的图直接 `getImageData` 是
 *  4800 万个像素、约 45MB 的数组，而这件事只需要 16384 个样本。 */
const SAMPLE = 128

/** 中位切分切多少个盒子。16 个：够让「占比 × 色彩覆盖」这种判据有意义，
 *  又远低于 Material 那条路要的 128（它故意过分割，再让打分扔掉大部分——
 *  这里只挑一个颜色，不需要那种两段式设计）。 */
const BOXES = 16

/** MMCQ 的两段式切分：**先按数量切到 3/4，再按「数量 × 跨度」切到底。**
 *  这是 MMCQ 比朴素中位切分好的地方——第一段尊重频率（别让一片大色块一个盒子
 *  都没切到），第二段尊重色彩空间的覆盖（别让一片渐变把配额吃光）。
 *  常数取自 color-thief / node-vibrant 的实现（`fractByPopulations`）。 */
const FRACT_BY_POPULATION = 0.75

/** 占比低于这个数的盒子不参与挑色：那是一个像素级的噪点，不是「图里的一块颜色」。 */
const MIN_POP = 0.002

/** 比这个还白的像素不参与挑色。截图、白底商品图整张都是白的，它们会把
 *  「图里最显眼的颜色」变成白色——而白色当强调色等于没有强调色。
 *  **见 `accentPixels()` 的逐级放宽**：一张全白图不能因为这条一个候选都不剩。 */
const NEAR_WHITE = 250

/** 半透明像素的取舍线。取 125 而不是 Material 那条「必须完全不透明」：
 *  后者会把抗锯齿的边缘像素全丢掉，而那是一张图里相当可观的一部分。 */
const ALPHA_MIN = 125

/** 从图里取到的颜色往往比 UI 需要的更灰一点（照片天生比界面色低饱和）。
 *  **下限 0.22**：再低按钮就看不出是彩色的了，而按钮是这套皮肤里强调色最显眼的一处。
 *  只提饱和度、色相与明度不动——「这张图是暖的」这件事归色相管，不该被这一提改掉。 */
const MIN_ACCENT_SAT = 0.22

/** 整张图最彩的那一块都低于这个数 = **它基本没有颜色**（黑白照片、灰阶截图）。
 *  这时**不编一个色相出来**：编出来的那个颜色压在图上比灰更难看，而且用户没有任何
 *  线索知道它是从哪来的。诚实的做法是给一套灰的，并在界面上说一句。 */
const ACHROMATIC_SAT = 0.06

/** 正文压在背景上要到的下限（WCAG AA）。**压暗是按它解出来的**，不是拍一个数。 */
const MIN_TEXT_CONTRAST = 4.5

/** 压暗的上限。到 95 还托不住，就不该继续加压——再加就不是「背景」而是「一块白板」了。 */
const MAX_SCRIM = 95

/** 采样得到的一个像素：RGB **已经合到白底上**，外加原始 alpha。
 *  两件事各要一半：挑色要 alpha（滤掉半透明与接近纯白的），算压暗要那个合出来的
 *  RGB——字压在图上看到的就是它。 */
export type Sample = [number, number, number, number]

/** 一张图采样之后的样子。取色与算压暗都只读它——两者因此都能拿一份手写的样本直接测。 */
export interface ImageStats {
  width: number
  height: number
  /** 行优先的全部像素。**位置必须保得住**：压暗是按「文字带」算的，而那是个位置概念。 */
  pixels: Sample[]
}

/** 一个色块：中位切分切出来的盒子。 */
export interface Box {
  pixels: Rgb[]
  /** 盒子里所有像素的均值——**盒子的代表色** */
  mean: Rgb
  /** 占全图的比例 0–1 */
  pop: number
  sat: number
  lum: number
}

export interface Derived {
  /** 强调色 `#rrggbb` */
  accent: string
  /** 切出来的前几色，按占比排。给界面显示「从图里取到了什么」 */
  swatches: string[]
  /** 全图平均色 */
  mean: string
  /** 图里有没有能当强调色的颜色。`false` = 给了套灰的，界面该说一句 */
  chromatic: boolean
  /** 亮色 / 暗色模式下各自该压多暗（百分比） */
  scrimLight: number
  scrimDark: number
  /** 那两个压暗**够不够**托住该模式的正文，以及压到那一档时**实际**能到多少。
   *  见 `scrimForImage`。 */
  okLight: boolean
  okDark: boolean
  ratioLight: number
  ratioDark: number
  /** **面板层**：通透度与模糊也是按图算出来的。见 `glassFor` / `blurFor`。
   *  这是「一张图 → 一整套皮肤」与「一张图 → 一张壁纸」的分界所在：
   *  只有前者会让卡片、侧栏、输入框跟着这张图一起变。 */
  surfaces: SkinSurfacesInput
  /** 两个模式各自的色调薄纱。**方向按模式定**，见 `tintFor`。 */
  tintLight: Tint
  tintDark: Tint
  /** 这张图**先用在哪个明暗模式**。见 `preferredMode`。 */
  mode: 'light' | 'dark'
  /** 量出来的两个统计量（0–1）。摆进报告里，好让「为什么是这一档」说得清。 */
  spread: number
  detail: number
}

// ---------- 2.5 量这张图「有多花」「有多密」 ----------

/** 亮度 5%–95% 分位之差（0–1）。**「这张图有多花」的那个数。**
 *
 *  取分位而不是极值，与压暗那边同一个道理：一个像素的黑点或高光不该代表整张图。
 *  它决定面板该多实——一张明暗拉得很开的图，卡片透出来就是字与图打架；
 *  一张本来就平的图（雾、纸、单色），透一点什么也不会发生。 */
export function tonalSpread(stats: ImageStats): number {
  const lums = stats.pixels.map((p) => relativeLuminance(rgbOf(p))).sort((a, b) => a - b)
  if (!lums.length) return 0
  const at = (q: number): number =>
    lums[Math.min(lums.length - 1, Math.floor(q * (lums.length - 1)))]
  return Math.max(0, at(0.95) - at(0.05))
}

/** 相邻采样点亮度差的均值（0–1）。**「这张图细节有多密」的那个数。**
 *
 *  它决定面板该多模糊：**糊一片高频细节才有意义**，糊一张本来就软的图
 *  （雾、渐变、纯色）只是白花合成成本——HeiGe 那份源码里「大模糊是卡顿主因」
 *  说的就是这件事。
 *
 *  **这条规则没有先例**：调研的三个成熟实现都按帧率而不是按图来定模糊，
 *  没有一处「从图像统计量推模糊半径」的做法。规则是这里定的，
 *  所以它写得尽量直白（相邻差均值），而且**只当默认值**——效果卡上那根滑块随时能改。
 *
 *  ## 它量的是**哪一档细节**，以及量不到哪一档
 *
 *  采样是 128 宽的缩略图，所以它量的是**尺度在图像宽度 1% 以上的结构**。
 *  比这更细的东西（比如 4×4 像素的噪声）在缩略图里已经被平均成一片灰，
 *  于是会被判成「不密」——**在读像素那一步就被抹掉了，这里看不到**。
 *
 *  这不算错到底：那种图在屏幕上确实会糊成一块均匀的灰底，模糊它没什么用。
 *  但如果是**看得见的细纹理**（布纹、砂粒），这个数会偏低、模糊会给少。
 *  上限那 14px 与效果卡上那根滑块就是为这一档留的出口。 */
export function detailLevel(stats: ImageStats): number {
  const { width: w, height: h, pixels } = stats
  if (w < 2 || h < 2) return 0
  let sum = 0
  let n = 0
  for (let y = 0; y < h; y++) {
    let prev = relativeLuminance(rgbOf(pixels[y * w]))
    for (let x = 1; x < w; x++) {
      const cur = relativeLuminance(rgbOf(pixels[y * w + x]))
      sum += Math.abs(cur - prev)
      n++
      prev = cur
    }
  }
  return n ? sum / n : 0
}

/** 面板该多实（0–100）。**明暗拉得越开越实。**
 *
 *  区间是 `[70, 88]`：两端都不到 100——**一张图当背景的皮肤，面板实心了就白搭了
 *  那张图**；而 70 是「图还在、字也压得住」那一档，与内置那两套带图皮肤的
 *  76 / 86 同一个量级。 */
export function glassFor(spread: number): number {
  return clampTo(Math.round(88 - spread * 22), 70, 88)
}

/** 一张图当背景时，面板模糊的上限。**比手写皮肤的 24px 低**：这一档是**算出来的**，
 *  算出来的东西该保守——用户没要求，而多出来的模糊每一帧都要重新采样。 */
export const MAX_IMAGE_BLUR = 14

/** **一张普通照片**在这个采样尺度下的相邻差均值。**这是标尺，不是阈值。**
 *
 *  它是量出来的，而且第一版估计错了一个数量级：原以为照片落在 0.02–0.06，
 *  实测四张标定图是 **0.001–0.002**——128 宽的缩略图把相邻像素的差都平均掉了。
 *  拿错的数量级去乘（`detail * 140`），结果是**每一张图都算出 0px，整段推导成了死代码**。
 *  这件事是浏览器验收抓到的：四张图（雾 / 噪声 / 黄昏 / 夜景）的 blur 全是 0。 */
export const TYPICAL_DETAIL = 0.003

/** 面板该多模糊（px）。**细节越密越糊**，上限见 `MAX_IMAGE_BLUR`。
 *
 *  以 `TYPICAL_DETAIL`（一张普通照片）为标尺：**它给 5px**，比它平就少糊，
 *  比它密就多糊。用比值而不是固定系数，是因为「多密算密」这件事只能相对一个
 *  参照物说；把参照物写成一个有名有姓的常数，比在公式里塞一个魔数好改也好问。 */
export function blurFor(detail: number): number {
  if (detail <= 0) return 0
  return clampTo((detail / TYPICAL_DETAIL) * 5, 0, MAX_IMAGE_BLUR)
}

/** 色调薄纱的饱和度。薄纱是**氛围**不是滤镜——它的活儿是让整屏往这张图的色偏
 *  靠一点，而不是给照片重新上色。 */
const TINT_SAT = 0.22

/** 图上的色调薄纱。**按明暗模式分别给，而且方向永远是「往这一模式的压暗色靠」**——
 *  亮色下往白里推、暗色下往黑里推。
 *
 *  这条约束不是审美：色调层在压暗层**下面**，而压暗是按**原图**解出来的。
 *  色调要是反过来把图压暗（亮色模式下），那解出来的压暗就不够了，
 *  而「字读不清」正是这一整套里最不能出的问题。往压暗那一头推，
 *  色调只会让对比更好，于是它取什么色都安全。 */
export function tintFor(base: Rgb, chromatic: boolean, dark: boolean): Tint {
  if (!chromatic) return { ...DEFAULT_TINT }
  const wash = mix(withSaturation(base, TINT_SAT), dark ? BLACK : WHITE, dark ? 0.45 : 0.55)
  return { color: rgbToHex(wash), alpha: dark ? 24 : 18 }
}

/** 这套皮肤**先用在哪个明暗模式**。
 *
 *  规则只有一句：**亮色能用就用亮色**，只有亮色托不住而暗色托得住时才反过来。
 *  不去「猜图是亮是暗」——亮度与「能不能当某个模式的背景」不是一回事
 *  （一张亮但对比强烈的图，暗色下反而好看），而 `scrimForImage` 已经把
 *  那件事量出来了，用它的结论比自己再猜一遍准。 */
export function preferredMode(okLight: boolean, okDark: boolean): 'light' | 'dark' {
  return okLight || !okDark ? 'light' : 'dark'
}

const rgbOf = (s: Sample): Rgb => [s[0], s[1], s[2]]

// ---------- 1. 量化 ----------

function boxOf(pixels: Rgb[], total: number): Box {
  let r = 0
  let g = 0
  let b = 0
  for (const p of pixels) {
    r += p[0]
    g += p[1]
    b += p[2]
  }
  const n = pixels.length || 1
  const mean: Rgb = [r / n, g / n, b / n]
  const [, sat, lum] = rgbToHsl(mean)
  return { pixels, mean, pop: pixels.length / total, sat, lum }
}

/** 盒子在某条通道上的跨度。切哪一刀、切哪个盒子，都看它。 */
function spread(b: Box): { ch: number; range: number } {
  let ch = 0
  let range = -1
  for (let i = 0; i < 3; i++) {
    let lo = 255
    let hi = 0
    for (const p of b.pixels) {
      if (p[i] < lo) lo = p[i]
      if (p[i] > hi) hi = p[i]
    }
    if (hi - lo > range) {
      range = hi - lo
      ch = i
    }
  }
  return { ch, range }
}

/** 中位切分：反复把「最该切」的那个盒子按最长的那条通道对半分，直到有 `count` 个。
 *
 *  为什么是中位切分而不是 k-means：它**没有随机性**（同一张图跑两次结果一样，
 *  这件事对「保存下来的皮肤」很重要——否则导出再导入会得到另一个颜色），
 *  没有迭代次数要调，而且三十行就能读完。 */
export function medianCut(pixels: Rgb[], count = BOXES): Box[] {
  if (!pixels.length) return []
  const total = pixels.length
  let boxes: Box[] = [boxOf(pixels, total)]
  const byPopulation = Math.round(count * FRACT_BY_POPULATION)

  while (boxes.length < count) {
    // 两段式：前半按数量挑，后半按「数量 × 跨度」挑（见 `FRACT_BY_POPULATION`）
    const firstPhase = boxes.length < byPopulation
    let at = -1
    let best = 0
    for (let i = 0; i < boxes.length; i++) {
      const { range } = spread(boxes[i])
      // 一个盒子里所有像素都一样（range 0）就没法再切了
      if (range <= 0) continue
      const score = firstPhase ? boxes[i].pixels.length : range * boxes[i].pixels.length
      if (score > best) {
        best = score
        at = i
      }
    }
    // 全部盒子都切不动了（图里只有一种颜色）。**这里必须 break**，
    // 否则 `while` 会转成一个不结束的循环——一张纯色图就能把页面卡死。
    if (at < 0) break

    const box = boxes[at]
    const { ch } = spread(box)
    const sorted = [...box.pixels].sort((x, y) => x[ch] - y[ch])
    const mid = Math.floor(sorted.length / 2)
    boxes = [
      ...boxes.slice(0, at),
      boxOf(sorted.slice(0, mid), total),
      boxOf(sorted.slice(mid), total),
      ...boxes.slice(at + 1),
    ].filter((b) => b.pixels.length > 0)
  }
  return boxes
}

// ---------- 2. 挑色 ----------

/** 一个盒子的得分。三个因子各自管一件事，都能单独说清楚：
 *
 *  · `sqrt(占比)` —— **一个小而鲜艳的东西能赢过一大片灰的，但赢不了太多**。
 *    用线性占比的话，「一面墙」永远赢（color-thief 的 `getColor()` 就是这个毛病：
 *    它返回最大的那一簇，于是在任何截图或白底商品图上取到的都是背景色）；
 *    完全不管占比的话，一个像素的噪点会赢。node-vibrant 把占比的权重压到
 *    总分十份里的一份，也是同一个取向。
 *  · `饱和度` —— 灰的当强调色等于没有强调色。
 *  · `明度`的高斯 —— 中间那一档最好用：太暗的在暗色模式下认不出，
 *    太亮的压不住白字。用高斯而不是硬阈值，是因为硬阈值会让一张
 *    「只有深色」的图一个候选都剩不下，而那张图仍然需要一个强调色。 */
function score(b: Box): number {
  const lum = Math.exp(-((b.lum - 0.55) ** 2) / (2 * 0.3 ** 2))
  return Math.sqrt(b.pop) * b.sat * lum
}

/** 挑一个当强调色。一个候选都没有时返回 null。 */
export function pickAccent(boxes: Box[]): Box | null {
  let best: Box | null = null
  let bestScore = 0
  for (const b of boxes) {
    if (b.pop < MIN_POP) continue
    const s = score(b)
    if (s > bestScore) {
      bestScore = s
      best = b
    }
  }
  return best
}

/** 深黄绿是**最不受欢迎的一类颜色**（Material 为它单独写了一条 `DislikeAnalyzer`，
 *  理由是 Palmer & Schloss 2010 那个「最讨嫌的颜色」研究）。一张有草地或树叶的
 *  照片很容易取到它，而它当强调色时，人说不出哪里不对、只觉得难看。
 *
 *  办法是把明度提上去：色相留着（那还是「这张图的颜色」），只是不再发闷。
 *  四个比较，比事后收到一句「这个皮肤好丑」便宜得多。 */
function undislike(c: Rgb): Rgb {
  const [h, s, l] = rgbToHsl(c)
  if (h >= 90 && h <= 111 && s > 0.35 && l < 0.65) return hslToRgb(h, s, 0.7)
  return c
}

// ---------- 3. 压暗 ----------

/** 一处文字压在什么上：**位置、压暗层、壳的底色，三样都要**。
 *
 *  「文字带里最不利的那一块」这句话要成立，就得把「那一处叠了几层压暗、
 *  上面还盖着什么、屏幕上是哪一块」一起算进去。少算哪一样，解出来的压暗就会偏：
 *  偏轻则字压不住，偏重则图被压没了——而后者正是「上传一张图」最不想看到的结果。
 *
 *  | 位置 | 屏幕上的哪一块 | 压暗层 | 壳自己的底色 | 那一处的字 |
 *  |---|---|---|---|---|
 *  | 侧栏 | 左 20% × 全高 | `sideMid + base` | 70% 白 | `neutral-500` |
 *  | 顶栏 | 全宽 × 上 8% | `top + base` | 85% 白 | `neutral-500` |
 *  | 主栏顶部 | 左 20%–35% × 上 8%–20% | `sideMid + top + base` | — | `neutral-500` |
 *
 *  前两格的关键是**壳自己的底色**：侧栏与顶栏是半透明的（`Layout.tsx`），
 *  字压在它们上面时，底下那层图已经被它们自己又洗白了一遍。不算这一层，
 *  一张中间调的图会被解出 80% 的压暗，而算上之后是 45% 上下——差别正好是
 *  「图还在」与「图没了」。
 *
 *  第三格是**没有壳底色的那一处**：主栏顶部直接压在图上（页面标题、小节标题
 *  都在那儿）。它比前两处难，所以三处都要过。
 *
 *  页面右下那片空白（远离左右边缘、远离顶部）只有底子那一层压暗，**不参与求解**。
 *  这是有意的取舍：那里的正文都在卡片里（卡片不透明），露在背景上的只有空状态与
 *  列表行；按 `neutral-500` 去要求那一块的话，任何一张中间调的图都得压成一片白，
 *  而那等于把「换一张图」这件事取消掉。 */
interface Surface {
  /** 这一处压在屏幕的哪一块（0–1 的分数） */
  rect: Rect
  factors: number[]
  /** 壳在那上面盖的底色浓度（0 = 直接压在图上） */
  chrome: number
}

interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/** 侧栏是 `w-60`（240px）。按 20% 算，比 1440 视口下的 16.7% 略宽一点点——
 *  宽出来的那一条属于「偏保守」，而保守的方向是压得更重、字更清楚。 */
function surfaces(dark: boolean): Surface[] {
  const c = dark ? CHROME_VEIL.dark : CHROME_VEIL.light
  return [
    {
      rect: { x: 0, y: 0, w: 0.2, h: 1 },
      factors: [VEIL_FACTORS.sideMid, VEIL_FACTORS.base],
      chrome: c.side,
    },
    {
      rect: { x: 0, y: 0, w: 1, h: 0.08 },
      factors: [VEIL_FACTORS.top, VEIL_FACTORS.base],
      chrome: c.top,
    },
    {
      rect: { x: 0.2, y: 0.08, w: 0.15, h: 0.12 },
      factors: [VEIL_FACTORS.sideMid, VEIL_FACTORS.top, VEIL_FACTORS.base],
      chrome: 0,
    },
  ]
}

/** 半透明层叠出来的实际浓度。**不是相加**：两层 50% 叠起来是 75%，不是 100%。 */
function layered(alphas: number[]): number {
  return 1 - alphas.reduce((keep, a) => keep * (1 - a), 1)
}

/** 压暗 `p`（滑块上那个数，0–1）之后，某一处文字实际压在什么颜色上。 */
function surfaceColor(worst: Rgb, dark: boolean, s: Surface, p: number): Rgb {
  const scrimmed = mix(worst, dark ? BLACK : WHITE, layered(s.factors.map((f) => f * p)))
  if (s.chrome <= 0) return scrimmed
  return mix(scrimmed, dark ? CHROME_DARK : WHITE, s.chrome)
}

/** 暗色模式下侧栏 / 顶栏那层底用的是 `neutral-900`。生成出来的皮肤用默认中性阶，
 *  所以这里取默认的那一档——不是「随便挑了个深色」。 */
const CHROME_DARK = channelsOf(DEFAULT_NEUTRAL_DARK['900'])

/** `R G B` 通道串 → 颜色。中性阶存的是通道串，算对比度要的是 `Rgb`。 */
function channelsOf(c: string): Rgb {
  const n = c.split(/\s+/).map(Number)
  return [n[0] || 0, n[1] || 0, n[2] || 0]
}

/** 某一处那一块里**最不利**的那个像素。
 *
 *  **每一处各取各的**，不是全图取一个再套到所有地方——那是这一段的第一个版本，
 *  而它是错的：一张「上面亮、左下角暗」的风景照，左下那块暗只压在侧栏上
 *  （侧栏自己有 70% 白底兜着），拿它去要求**没有壳底色**的主栏顶部，
 *  等于凭空多要一大截压暗，而多要的代价是图被压没。
 *
 *  取 5% / 95% 分位而不是极值：一个像素的黑点（或一块过曝的高光）就能把极值拉到底，
 *  而压暗是按整片算的——为了一个点把全图压死没有道理。 */
function worstIn(stats: ImageStats, rect: Rect, dark: boolean): Rgb | null {
  const x0 = Math.floor(rect.x * stats.width)
  const x1 = Math.max(x0 + 1, Math.ceil((rect.x + rect.w) * stats.width))
  const y0 = Math.floor(rect.y * stats.height)
  const y1 = Math.max(y0 + 1, Math.ceil((rect.y + rect.h) * stats.height))
  const zone: Rgb[] = []
  for (let y = y0; y < Math.min(y1, stats.height); y++) {
    for (let x = x0; x < Math.min(x1, stats.width); x++) zone.push(rgbOf(stats.pixels[y * stats.width + x]))
  }
  if (!zone.length) return null
  zone.sort((a, b) => relativeLuminance(a) - relativeLuminance(b))
  // 亮色模式要最暗的那一块（暗图托不住深色字），暗色模式要最亮的那一块
  const q = dark ? 0.95 : 0.05
  return zone[Math.min(zone.length - 1, Math.floor(q * (zone.length - 1)))]
}

/** 目标够不到时停在哪一档。**不是 95。**
 *
 *  这是量出来的：一张「上亮下暗」的风景照，从 62% 压到 95% 只把侧栏那一处
 *  从约 3.95 抬到 4.43——差 0.5，而代价是那张图彻底看不见了（截图上就是一片白）。
 *  目标够不到的时候，继续加压几乎买不到对比度，却把图整片吃掉，而这跟
 *  「上传一张图」这件事的用意正相反：人要的是那张图。
 *
 *  所以停在**内置图片皮肤用的那一档**（`DEFAULT_BG.scrim`）——不是一个新拍的数，
 *  是这个功能本来就在用的默认值。剩下的交给界面：说清「这个模式不适合这张图、
 *  所以没有继续压」，并给一个一键切到另一个模式的出口。 */
const FALLBACK_SCRIM = DEFAULT_BG.scrim

export interface ScrimPlan {
  /** 滑块上那个百分比（已经兜到 `MIN_SKIN_SCRIM`；够不到目标时是 `FALLBACK_SCRIM`） */
  scrim: number
  /** 压到这个数之后，三处里最不利的那一处**实际**能到多少对比度。
   *  界面把这个数摆出来——「差多少」比「不合格」有用得多。 */
  ratio: number
  /** 达到了 AA 的 4.5。没达到时界面要说一句，并给一个切到另一个明暗模式的出口。 */
  ok: boolean
}

/** 该压多暗。**这是「上传一张图」这条路上最要紧的一个数**：
 *  用户不该为了「字看不看得清」去拖一个滑块。
 *
 *  解的是：**多重的压暗能让三处里最不利的那一处也托得住该模式的正文**。
 *  正文取 `neutral-500`（亮色）/ `neutral-400`（暗色）——那是全站次要文字的颜色，
 *  也是压在背景上的那一档里最难达到 4.5:1 的（更深的 900 更容易）。
 *
 *  `p` 从 0 往上扫，第一个让三处全过的就是答案。**够不到时不再往上加压**
 *  （见 `FALLBACK_SCRIM`），而是把「这个模式托不住这张图」如实报出来：
 *  `ok: false` 加上压到那一档时**实际**能到的对比度。
 *
 *  于是这里有一条硬边：`ok` 为真时压到够为止（可能到 95%），为假时停在 62%。
 *  边界两侧看起来会有点跳（130 的灰停在 62%、140 的灰压到 95%），但那正是
 *  「压暗买不到对比度」这件事的实情——不是连续的，规则本身是清楚的。 */
export function scrimForImage(stats: ImageStats, dark: boolean): ScrimPlan {
  const text = channelsOf(dark ? DEFAULT_NEUTRAL_DARK['400'] : DEFAULT_NEUTRAL_LIGHT['500'])
  const list: { s: Surface; worst: Rgb }[] = []
  for (const s of surfaces(dark)) {
    const worst = worstIn(stats, s.rect, dark)
    if (worst) list.push({ s, worst })
  }
  // 样本为空（理论上到不了这里）时算「够」：没有证据说明它不够，不该凭空报一个警告
  if (!list.length) return { scrim: MIN_SKIN_SCRIM, ratio: MIN_TEXT_CONTRAST, ok: true }

  /** 压到 `p` 之后，三处里最不利的那一处是多少。 */
  const worstAt = (p: number): number =>
    Math.min(
      ...list.map(({ s, worst }) => contrastRatio(surfaceColor(worst, dark, s, p / 100), text))
    )

  for (let p = 0; p <= MAX_SCRIM; p++) {
    const got = worstAt(p)
    // 压暗只会让每一处都往「对比更高」的方向走（亮色压白、暗色压黑），
    // 所以这里把解出来的数抬到下限不会让它变得不合格。
    if (got >= MIN_TEXT_CONTRAST) {
      const scrim = Math.max(MIN_SKIN_SCRIM, p)
      // 比值按**存下来的那个压暗**算，不是按解出来的那个：解出来的可能低于下限，
      // 而抬到下限之后实际对比更高。报错那一个的话，界面上摆的数字与画面对不上。
      return { scrim, ratio: round2(worstAt(scrim)), ok: true }
    }
  }
  return { scrim: FALLBACK_SCRIM, ratio: round2(worstAt(FALLBACK_SCRIM)), ok: false }
}

const round2 = (v: number): number => Math.round(v * 100) / 100

// ---------- 4. 汇总 ----------

/** 挑色用的像素：**与算压暗用的不是同一批**。
 *
 *  · 半透明与接近纯白的不要（见上面两个常数）；
 *  · 全被滤掉时**逐级放宽**，最后退回「全部像素」——这条阶梯是从 color-thief 学的：
 *    一张白底商品图不该因为「把白色滤掉了」而一个候选都不剩。
 *
 *  算压暗那一侧**必须用完整的网格**（`textZone` 靠下标算位置），所以两件事
 *  从同一份 `ImageStats` 出发、走两条路。 */
function accentPixels(stats: ImageStats): Rgb[] {
  const opaque = stats.pixels.filter((p) => p[3] >= ALPHA_MIN).map(rgbOf)
  const notWhite = opaque.filter(
    (p) => !(p[0] > NEAR_WHITE && p[1] > NEAR_WHITE && p[2] > NEAR_WHITE)
  )
  if (notWhite.length >= 64) return notWhite
  if (opaque.length >= 64) return opaque
  return stats.pixels.map(rgbOf)
}

/** 采样结果 → 一套皮肤需要的颜色。**纯函数**，不碰 DOM，测试直接喂样本。 */
export function deriveSkinColors(stats: ImageStats): Derived {
  const boxes = medianCut(accentPixels(stats))
  const best = pickAccent(boxes)

  let r = 0
  let g = 0
  let b = 0
  for (const p of stats.pixels) {
    r += p[0]
    g += p[1]
    b += p[2]
  }
  const n = stats.pixels.length || 1
  const mean: Rgb = [r / n, g / n, b / n]

  const chromatic = Boolean(best && best.sat >= ACHROMATIC_SAT)
  // 没有颜色可取时退回**全图平均色**（一张黑白照片的平均色就是它的灰），
  // 而不是编一个色相：编出来的东西没有出处，用户没法理解也没法复现。
  const base = chromatic && best ? best.mean : mean
  const lifted = chromatic ? withSaturation(base, Math.max(MIN_ACCENT_SAT, rgbToHsl(base)[1])) : base

  const light = scrimForImage(stats, false)
  const dark = scrimForImage(stats, true)

  // 面板层也按图算：**这两个数就是「一张图 → 一整套皮肤」与「一张图 → 一张壁纸」
  // 的分界**。明暗拉得越开、细节越密，面板就越实、越糊——因为那样的图透出来
  // 只会与字打架，而糊一片高频细节才买得到可读性。
  const spread = tonalSpread(stats)
  const detail = detailLevel(stats)
  const glass = glassFor(spread)
  const surfaces: SkinSurfacesInput = {
    glass,
    // 壳比面板再透一点：**层级靠通透度的差别读出来**，而不是靠加阴影。
    // 这与内置那两套带图皮肤（极光 82/72、远山 86/76）是同一条做法。
    chromeGlass: clampTo(glass - 6, 55, 85),
    blur: blurFor(detail),
  }

  return {
    accent: rgbToHex(undislike(lifted)),
    swatches: [...boxes]
      .sort((x, y) => y.pop - x.pop)
      .slice(0, 5)
      .map((x) => rgbToHex(x.mean)),
    mean: rgbToHex(mean),
    chromatic,
    scrimLight: light.scrim,
    scrimDark: dark.scrim,
    okLight: light.ok,
    okDark: dark.ok,
    ratioLight: light.ratio,
    ratioDark: dark.ratio,
    surfaces,
    tintLight: tintFor(base, chromatic, false),
    tintDark: tintFor(base, chromatic, true),
    mode: preferredMode(light.ok, dark.ok),
    spread: Math.round(spread * 1000) / 1000,
    detail: Math.round(detail * 1000) / 1000,
  }
}

/** 夹到区间里。这里的输入**一定是算出来的数**，不存在「值坏了」这种情况，
 *  所以没有 `fallback` 那一位——那一位是给「解析一份别人写的设置」用的
 *  （见 `theme.ts` 的 `clamp`），与这里不是同一件事。 */
function clampTo(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, Math.round(v)))
}

// ---------- 5. 读像素（唯一碰 DOM 的一段） ----------

/** `cover` 会显示源图的哪一块。
 *
 *  采样按**屏幕上真正看得到的那一块**取，而不是整张缩下来：一张上面 80% 是天空的
 *  竖图，整张缩下来的平均色几乎全是天空，而铺满之后屏幕上看到的是下半部分。
 *  取错那一块的表现是「取到的颜色与图对不上」，用户只会觉得这个功能不准。
 *
 *  （Material 的开发指南与 wallust 的 `thumb` 后端都是直接压成正方形、不管比例。
 *  这里多算一步是因为**竖图很常见**——手机拍的照片放到宽屏上，`cover` 只留中间
 *  四成的高度，压成正方形会把六成看不到的内容算进去。） */
export function coverRect(
  iw: number,
  ih: number,
  aspect: number
): { sx: number; sy: number; sw: number; sh: number } {
  if (iw / ih > aspect) {
    const sw = ih * aspect
    return { sx: (iw - sw) / 2, sy: 0, sw, sh: ih }
  }
  const sh = iw / aspect
  return { sx: 0, sy: (ih - sh) / 2, sw: iw, sh }
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    // 跨域图不带这个的话能画上去、读像素时抛 SecurityError；带上它则在**加载**这一步
    // 就失败。两种都是「读不出来」，但后者能拿到一个干净的错误，不用去猜异常类型。
    img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('图片加载失败'))
    img.src = url
  })
}

/** 把图按 `cover` 裁进一张小画布，读回像素。
 *
 *  **画小再读**，不是读原图再缩：一张 4000×3000 的图 `getImageData` 是 4800 万个
 *  像素（约 45MB 的数组），而这件事只需要一万多个样本。 */
export async function readImageStats(url: string, size = SAMPLE): Promise<Parsed<ImageStats>> {
  let img: HTMLImageElement
  try {
    img = await loadImage(url)
  } catch {
    return {
      ok: false,
      reason: '这张图加载不出来——可能已经不在服务器上，或者是不允许跨域读取的地址',
    }
  }
  // `naturalWidth/Height` 是**浏览器按 EXIF 摆正之后**的尺寸，所以下面那个裁切框
  // 与 `drawImage` 画出来的东西是同一套坐标。自己解析 EXIF 只会引入一个新的错法。
  const iw = img.naturalWidth
  const ih = img.naturalHeight
  if (!iw || !ih) return { ok: false, reason: '这张图读不出尺寸（文件可能坏了）' }

  const aspect =
    typeof window === 'undefined' ? 16 / 9 : window.innerWidth / Math.max(1, window.innerHeight)
  const w = aspect >= 1 ? size : Math.max(8, Math.round(size * aspect))
  const h = aspect >= 1 ? Math.max(8, Math.round(size / aspect)) : size
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  // **不传 `willReadFrequently`**：那是给「反复读」用的提示，代价是把画布降级成
  // 软件渲染；这里只读一次，传它纯亏。
  const ctx = canvas.getContext('2d')
  if (!ctx) return { ok: false, reason: '这个浏览器不给读图片像素（拿不到 2d 画布）' }

  const { sx, sy, sw, sh } = coverRect(iw, ih, aspect)
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, w, h)

  let data: Uint8ClampedArray
  try {
    data = ctx.getImageData(0, 0, w, h).data
  } catch {
    // 跨域图污染画布。**不把图送去做代理**：那要在后端存一份别人的图，
    // 而这件事的收益只是「省一次手动填色号」。
    return {
      ok: false,
      reason: '这张图不允许被读取像素（跨域图片）——可以先把图下载到本机再上传',
    }
  }

  const pixels: Sample[] = []
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3]
    const k = a / 255
    // RGB 合到白底上：算压暗那一侧要的是「字压在图上看到什么」，而全透明的区域
    // 在屏幕上露的是页面底色（亮色模式下就是接近白）。原始 alpha 留着给挑色那一侧。
    pixels.push([
      data[i] * k + 255 * (1 - k),
      data[i + 1] * k + 255 * (1 - k),
      data[i + 2] * k + 255 * (1 - k),
      a,
    ])
  }
  return { ok: true, value: { width: w, height: h, pixels } }
}

// ---------- 6. 变成一套皮肤 ----------

/** 文件名 → 皮肤名。去扩展名、去路径、限长。
 *
 *  用文件名而不是「我的背景 1」：用户认得的是自己那个文件叫什么，
 *  而「背景 3」这种名字在一排卡片里等于没名字。 */
export function labelFromFilename(name: string): string {
  const stem = (name || '')
    .split(/[\\/]/)
    .pop()!
    .replace(/\.[^.]+$/, '')
    .trim()
  return stem.slice(0, MAX_LABEL) || '图片皮肤'
}

/** 新皮肤的 id。`photo-` 前缀让人一眼看出它是从哪来的（导出成 JSON 之后也看得出）。 */
export function newPhotoId(): string {
  return `photo-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
}

export interface ImageSkinReport {
  accent: string
  swatches: string[]
  mean: string
  chromatic: boolean
  scrimLight: number
  scrimDark: number
  okLight: boolean
  okDark: boolean
  /** 压到最重时实际能到的对比度。界面用它决定「说一句」还是「认真提醒一下」。 */
  ratioLight: number
  ratioDark: number
  /** 按图算出来的面板通透度与模糊（皮肤数据里真的写了这两个数）。 */
  glass: number
  blur: number
  /** 两个模式各自的色调薄纱 */
  tintLight: Tint
  tintDark: Tint
  /** 这张图先用在哪个明暗模式。见 `preferredMode`。 */
  mode: 'light' | 'dark'
  /** 量出来的两个统计量，用来解释上面那两个数是怎么来的。 */
  spread: number
  detail: number
}

/** 取到的颜色 + 图 → 一份皮肤数据。
 *
 *  ## 写下去的比「一个色号 + 一张图」多
 *
 *  除了 `accent` 与两个变体各自的 `bg`（同一张图、**不同的压暗与不同的色调**），
 *  还写 `surfaces`——面板通透度与模糊。**这是这一层的重点**：只写背景的话，
 *  得到的是一张壁纸；写上面板层，卡片、侧栏、输入框才会跟着这张图一起变，
 *  也就是「一整套皮肤」。
 *
 *  ## 色阶与页面底色仍然交给推导
 *
 *  `accentScale` / `neutral` / `pageBg` **一个都不写**：`manifestToSkin` 会从
 *  那一个色号推出十一条色阶与两个页面底色，而面板底色又由页面底色推
 *  （`resolveSurface`）。所以**面板是带这张图的色偏的**，不需要单独算。
 *  这是这套格式本来就会做的事，这里不该重做一遍。 */
export function manifestFromImage(input: {
  id: string
  label: string
  image: string
  hint?: string
  derived: Derived
}): SkinManifest {
  const d = input.derived
  const bg = (side: 'light' | 'dark'): SkinBg => {
    const tint = side === 'dark' ? d.tintDark : d.tintLight
    return {
      image: input.image,
      fit: 'cover',
      scrim: side === 'dark' ? d.scrimDark : d.scrimLight,
      // 照片一律边缘加重：文字在左边和上边，中间那片留给图自己
      scrimDir: 'edge',
      blur: 0,
      // 色调方向按模式定（往压暗那一头推），所以它只会让字更好读，见 `tintFor`。
      // **没有色调时整项不写**：写一个 `{ color: '', alpha: 0 }` 进去，
      // 解析器就得为「空串 = 没有」专门开一条口子，而那种口子迟早会长成
      // 「运行时默认值 vs 数据格式」两套说法。不写就是没有，这条最短。
      ...(tint.color ? { tint } : {}),
    }
  }
  return {
    format: SKIN_FORMAT,
    id: input.id,
    label: input.label,
    hint: input.hint,
    accent: d.accent,
    light: { bg: bg('light'), surfaces: { ...d.surfaces } },
    dark: { bg: bg('dark'), surfaces: { ...d.surfaces } },
  }
}

/** 一张图 → 一份**已经过校验**的皮肤数据 + 一份「取到了什么」的报告。
 *
 *  出口过 `parseSkin` 是刻意的：生成器写错一个字段时，症状会是「这套皮肤在界面上
 *  出现过、刷新之后不见了」（`loadUserSkins` 逐条 `parseSkin`，认不出的丢掉）。
 *  那种 bug 极难查。过一遍同一个闸，错了当场变成一句能读的话。 */
export async function skinFromImage(
  url: string,
  filename: string,
  id = newPhotoId()
): Promise<Parsed<{ manifest: SkinManifest; report: ImageSkinReport }>> {
  // 地址先过闸再去加载：不合法的地址不该被送进 `Image()`，也不该等到
  // `parseSkin` 那一步才被拒——那时图已经读过一遍了。
  if (!isSafeImageUrl(url)) {
    return { ok: false, reason: '这个图片地址不能用（只收站内图片或 http(s) 地址）' }
  }
  const got = await readImageStats(url)
  if (!got.ok) return got
  if (got.value.pixels.length < 64) return { ok: false, reason: '这张图太小了，取不出颜色' }

  const derived = deriveSkinColors(got.value)
  const manifest = parseSkin(
    manifestFromImage({
      id,
      label: labelFromFilename(filename),
      image: url,
      hint: `从「${filename}」取的色`,
      derived,
    })
  )
  if (!manifest.ok) return { ok: false, reason: `生成的皮肤不合法：${manifest.reason}` }

  return {
    ok: true,
    value: {
      manifest: manifest.value,
      report: {
        accent: derived.accent,
        swatches: derived.swatches,
        mean: derived.mean,
        chromatic: derived.chromatic,
        scrimLight: derived.scrimLight,
        scrimDark: derived.scrimDark,
        okLight: derived.okLight,
        okDark: derived.okDark,
        ratioLight: derived.ratioLight,
        ratioDark: derived.ratioDark,
        // 面板层与色调：报告里摆出来，用户才知道「这套皮肤为什么长这样」
        glass: derived.surfaces.glass ?? 100,
        blur: derived.surfaces.blur ?? 0,
        tintLight: derived.tintLight,
        tintDark: derived.tintDark,
        mode: derived.mode,
        spread: derived.spread,
        detail: derived.detail,
      },
    },
  }
}
