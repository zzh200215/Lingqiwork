/** 颜色小工具：主题系统里唯一做颜色运算的地方。
 *
 *  单独一个文件是因为 `skins.ts`（静态色板）与 `theme.ts`（由用户强调色生成色阶）
 *  都要用它，而两者之间不该互相引用。 */

/** `R G B` 三个 0-255 的通道，空格分隔。**不是十六进制**——Tailwind 的
 *  `rgb(var(--x) / <alpha-value>)` 要靠它拆 alpha 通道（`bg-violet-500/40` 那种写法）。 */
export type Channels = string

export type Rgb = [number, number, number]

export function hexToRgb(hex: string): Rgb | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec((hex || '').trim())
  if (!m) return null
  let h = m[1]
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2]
  const n = parseInt(h, 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

export function rgbToHex(c: Rgb): string {
  return '#' + c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')
}

export function channels(c: Rgb): Channels {
  return `${Math.round(c[0])} ${Math.round(c[1])} ${Math.round(c[2])}`
}

export function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
}

export const WHITE: Rgb = [255, 255, 255]
export const BLACK: Rgb = [0, 0, 0]

/** 校验并规范化一个用户填的强调色。认不出来返回 null（调用方退回皮肤自带色）。 */
export function normalizeHex(hex: string): string | null {
  const rgb = hexToRgb(hex)
  return rgb ? rgbToHex(rgb) : null
}

/** 相对亮度（WCAG 的算法）。**生产代码里唯一需要它的地方是下面那个 600 的下限**——
 *  对比度测试自己有独立的一份实现，不复用这个（测试要能独立地量出生产代码算错了）。 */
export function relativeLuminance(c: Rgb): number {
  const [r, g, b] = c.map((v) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** 与白的对比度（1…21）。 */
export function contrastWithWhite(c: Rgb): number {
  return 1.05 / (relativeLuminance(c) + 0.05)
}

/** 任意两色的对比度（1…21）。`contrastWithWhite` 是它白的那一端取死的特例，
 *  留着是因为它的读者（`accentPalette`）确实只关心白字。 */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

/** RGB → HSL。`h` 0–360，`s` / `l` 0–1。
 *
 *  「这个颜色够不够彩、够不够亮」这两件事在 RGB 里没有直接读数——`#808080` 与
 *  `#ff0000` 的 R 通道差着 127，但「有多彩」在 HSL 里就是一个数。从一张图里挑
 *  强调色要反复判这两件事，所以在颜色工具这一层把它做出来，而不是在取色那一步
 *  就地手写一遍。 */
export function rgbToHsl(c: Rgb): [number, number, number] {
  const [r, g, b] = c.map((v) => v / 255)
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  const d = max - min
  if (d === 0) return [0, 0, l]
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h: number
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60
  else if (max === g) h = ((b - r) / d + 2) * 60
  else h = ((r - g) / d + 4) * 60
  return [h, s, l]
}

/** HSL → RGB。**与 `rgbToHsl` 往返要稳**：`withSaturation()` 靠这一对做
 *  「只把饱和度提一点」，往返掉色的话同一张图取两次会得到两个颜色。 */
export function hslToRgb(h: number, s: number, l: number): Rgb {
  if (s <= 0) return [l * 255, l * 255, l * 255]
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  const f = (t: number): number => {
    let x = t
    if (x < 0) x += 1
    if (x > 1) x -= 1
    if (x < 1 / 6) return p + (q - p) * 6 * x
    if (x < 1 / 2) return q
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6
    return p
  }
  const hh = (((h % 360) + 360) % 360) / 360
  return [f(hh + 1 / 3) * 255, f(hh) * 255, f(hh - 1 / 3) * 255]
}

/** 只改饱和度，色相与明度不动。 */
export function withSaturation(c: Rgb, s: number): Rgb {
  const [h, , l] = rgbToHsl(c)
  return hslToRgb(h, s, l)
}

/** 白字压在实底上要到的下限（WCAG AA 正文）。 */
const MIN_ON_WHITE = 4.5

/** 由**一个**强调色推出整条色阶（50…950）。
 *
 *  为什么是混白混黑而不是 HSL 提亮：色相与饱和度的感知在混合里保持得更稳，
 *  浅色端不会出现「提亮到发灰」的脏色，而且实现只有一行 `mix`。
 *  400 / 500 两档贴着用户填的原色——它们承担 hover 与浅底 chip，
 *  必须最接近用户心里那个颜色。
 *
 *  ## `600` 有一个硬下限，不是固定「压 14%」
 *
 *  `600` 是**实底按钮**那一档（全仓几十处 `bg-violet-600 … text-white`），
 *  所以白字必须压在它上面。固定压 14% 只在基色本身够深时成立：用户挑一个淡黄
 *  （`#fde047`）当强调色时，压 14% 得到的是 `#d9c03d`，白字压上去是 **1.6:1** ——
 *  按钮上的字直接糊掉。所以这里往后多压一点，**压到白字够了为止**（上限 0.72：
 *  再压就到黑，色相会丢）。
 *
 *  这条对「内置皮肤」和「自己填的强调色」是同一条——淡色强调色这条路上，
 *  以前是坏的。`theme.contrast.test.ts` 拿一批淡色钉着它。 */
export function accentPalette(hex: string): Record<string, Channels> {
  const base = hexToRgb(hex) ?? [124, 58, 237]

  let t = 0.14
  while (t < 0.72 && contrastWithWhite(mix(base, BLACK, t)) < MIN_ON_WHITE) t += 0.02
  // 700 及以下从**调好之后的 600** 接着往下压，保证整条尾部是单调变深的：
  // 两条各自从 base 压的话，淡色基底下会出现「700 比 600 还浅」。
  const deep = mix(base, BLACK, t)
  const tail = (extra: number): Channels => channels(mix(deep, BLACK, extra))

  return {
    '50': channels(mix(base, WHITE, 0.94)),
    '100': channels(mix(base, WHITE, 0.87)),
    '200': channels(mix(base, WHITE, 0.72)),
    '300': channels(mix(base, WHITE, 0.5)),
    '400': channels(mix(base, WHITE, 0.16)),
    '500': channels(base),
    '600': channels(deep),
    '700': tail(0.18),
    '800': tail(0.36),
    '900': tail(0.52),
    '950': tail(0.7),
  }
}
