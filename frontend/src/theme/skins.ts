/** 内置皮肤表——**这里只有数据**。
 *
 *  每条皮肤是一份 `SkinManifest`（格式与校验在 `manifest.ts` 里），运行时对象由
 *  `manifestToSkin()` 推出来。于是「加一个内置皮肤」与「用户导入一个皮肤」走的是
 *  同一条路：**加内置的 = 往 `BUILTIN_MANIFESTS` 里加一条对象**。
 *
 *  每套值里有三样东西：
 *    1. `accent` / `accentScale` —— 强调色。给一个色号就够（色阶由它推），
 *       但内置这几个都是**手抄的整条色阶**：抄来的手感比推出来的好，
 *       而且默认皮肤那两条必须与改动前的 Tailwind 逐档一致。
 *    2. `pageBg` —— 页面底色（卡片之下的那一层）。
 *    3. `chart` —— 图表后 5 色（第 0 色跟着强调色）。
 *
 *  中性阶（底色与文字）**不在每条皮肤里写**：它是可读性的地板，也就是所有人共用的
 *  那一套默认值（见 `manifest.ts` 的 `DEFAULT_NEUTRAL_*`）。皮肤之间拉开差别靠的是
 *  强调色与页面底色。
 *
 *  色阶的数值是 **`R G B` 三个 0-255 的通道**，不是十六进制：Tailwind 的透明度修饰符
 *  （`bg-neutral-200/70`、`border-violet-500/40`）要求颜色能拆出 alpha 通道，
 *  `rgb(var(--x) / <alpha-value>)` 是唯一能同时满足「跟变量走」和「带斜杠透明度」的写法。
 *  通道之间用空格——Tailwind 的 `rgb()` 模板就是这么拼的。
 *
 *  **默认皮肤的数值 = 改动前 Tailwind 的 neutral / violet 原值**：换肤功能上线后，
 *  没动过设置的人看到的应该还是原来那一版，一个色号都不差。 */
import { manifestToSkin, type SkinBg, type SkinManifest } from './manifest'
import type { SkinSurfaces } from './surfaces'
import type { Channels } from './color'

type Scale = Record<string, Channels>

export interface SkinVariant {
  /** 底色与文字（`--wb-neutral-*`） */
  neutral: Record<string, Channels>
  /** 强调色阶（`--wb-violet-*` 与 `--wb-fuchsia-*`） */
  accentScale: Scale
  /** 这一个变体的代表色，用于预览色块与自定义强调色的起点 */
  accent: string
  /** 页面底色（卡片之下的那一层，`--wb-page-bg`）。**有底图时它仍然要在**：
   *  图没加载出来的那一瞬、以及图本身透明的地方，看到的就是它。 */
  pageBg: string
  /** **面板底色**（卡片 / 输入框 / 浮层，`--wb-surface`）。
   *  不写 `surfaces.surface` 时由 `pageBg` 推，见 `surfaces.ts`。 */
  surface: string
  /** **壳底色**（侧栏 / 顶栏，`--wb-chrome`）。不写就跟 `surface`。 */
  chrome: string
  /** 面板层的其余参数（通透度 / 模糊 / 边框 / 阴影）。 */
  surfaces: SkinSurfaces
  /** 图表后 5 色（第 0 色跟随强调色） */
  chart: [string, string, string, string, string]
  /** 皮肤自带的底图。没有就是一套纯色值的皮肤。 */
  bg?: SkinBg
}

export interface Skin {
  id: string
  label: string
  /** 一句话说明这个皮肤「是什么」，写在选择卡上 */
  hint: string
  /** 谁做的。内置的没有；导入的会带着原作者一起走 */
  author?: string
  light: SkinVariant
  dark: SkinVariant
}

/** 由一条亮色阶 + 一条暗色阶拼出完整的两套强调色。
 *
 *  暗色那一套的 50–500 沿用亮色的（浅色 chip 在暗底上也这么用），600–950 用暗色专属值。
 *
 *  **`600` 是实底按钮那一档**（全仓几十处 `bg-violet-600 … text-white`），所以它在
 *  两套里都必须是**深色**——白字压在它上面。曾经把暗色的 600 写成「亮一点才压得住暗底」，
 *  结果是白字对比度掉到 1.5–3.0（`theme.contrast.test.ts` 抓到的）。
 *  暗色下「强调色看起来更亮」这件事由 `400`（文字 / 图标 / 边框）承担，不是 600。
 *  两者分工写在这里，是因为下一次有人觉得「暗色下 600 太暗了」时，需要先看到这句话。 */
function scale(light: Scale, dark600: Scale): { light: Scale; dark: Scale } {
  const merged: Scale = { ...light }
  for (const step of ['600', '700', '800', '900', '950']) {
    if (dark600[step]) merged[step] = dark600[step]
  }
  return { light, dark: merged }
}

// ---------- 各皮肤的强调色阶 ----------

const VIOLET = scale(
  {
    '50': '245 243 255',
    '100': '237 233 254',
    '200': '221 214 254',
    '300': '196 181 253',
    '400': '167 139 250',
    '500': '139 92 246',
    '600': '124 58 237',
    '700': '109 40 217',
    '800': '91 33 182',
    '900': '76 29 149',
    '950': '46 16 101',
  },
  {
    '600': '124 92 255',
    '700': '109 40 217',
    '800': '91 33 182',
    '900': '76 29 149',
    '950': '46 16 101',
  }
)

const INDIGO = scale(
  {
    '50': '238 242 255',
    '100': '224 231 255',
    '200': '199 210 254',
    '300': '165 180 252',
    '400': '129 140 248',
    '500': '99 102 241',
    '600': '79 70 229',
    '700': '67 56 202',
    '800': '55 48 163',
    '900': '49 46 129',
    '950': '30 27 75',
  },
  {
    '600': '79 70 229',
    '700': '67 56 202',
    '800': '55 48 163',
    '900': '49 46 129',
    '950': '30 27 75',
  }
)

const TEAL = scale(
  {
    '50': '240 253 250',
    '100': '204 251 241',
    '200': '153 246 228',
    '300': '94 234 212',
    '400': '45 212 191',
    '500': '20 184 166',
    '600': '15 118 110',
    '700': '17 94 89',
    '800': '19 78 74',
    '900': '19 78 74',
    '950': '4 47 46',
  },
  {
    '600': '15 118 110',
    '700': '17 94 89',
    '800': '19 78 74',
    '900': '19 78 74',
    '950': '8 60 58',
  }
)

const AMBER = scale(
  {
    '50': '255 251 235',
    '100': '254 243 199',
    '200': '253 230 138',
    '300': '252 211 77',
    '400': '251 191 36',
    '500': '245 158 11',
    '600': '180 83 9',
    '700': '146 64 14',
    '800': '120 53 15',
    '900': '120 53 15',
    '950': '69 26 3',
  },
  {
    '600': '180 83 9',
    '700': '146 64 14',
    '800': '120 53 15',
    '900': '120 53 15',
    '950': '90 45 8',
  }
)

/** 极简：一整套去饱和的墨色。**它不是「没有强调色」**——按钮、选中态、
 *  焦点环都还在，只是全部退成黑/白/灰，像一支钢笔在纸上。 */
const INK = scale(
  {
    '50': '246 246 247',
    '100': '240 240 242',
    '200': '226 226 229',
    '300': '206 206 211',
    '400': '158 158 166',
    '500': '112 112 120',
    '600': '82 82 90',
    '700': '63 63 70',
    '800': '44 44 50',
    '900': '28 28 32',
    '950': '14 14 17',
  },
  {
    // 暗色下的 600 仍然是**深色**：它是实底按钮（白字压在上面），
    // 「暗色下要更亮」由 400 / 500 承担（见 `scale()` 上面那段说明）。
    '600': '63 63 70',
    '700': '44 44 50',
    '800': '28 28 32',
    '900': '20 20 23',
    '950': '14 14 17',
  }
)

// ---------- 皮肤表（数据） ----------

/** 内置皮肤，**按展示顺序**。顺序写在这里而不是靠对象键序：对象字面量的顺序是
 *  「定义顺序」，而这里要的是「展示顺序」，两件事不该被迫一致
 *  （将来插一条新皮肤时尤其明显）。 */
export const BUILTIN_MANIFESTS: SkinManifest[] = [
  {
    format: 1,
    id: 'default',
    label: '默认',
    hint: '紫调强调色，白 / 近黑两层底色。改动前的样子。',
    light: {
      accent: '#7c3aed',
      accentScale: VIOLET.light,
      pageBg: '#ffffff',
      chart: ['#e879f9', '#38bdf8', '#34d399', '#fbbf24', '#fb7185'],
    },
    dark: {
      accent: '#a78bfa',
      accentScale: VIOLET.dark,
      pageBg: '#0a0a0a',
      chart: ['#f0abfc', '#7dd3fc', '#6ee7b7', '#fcd34d', '#fda4af'],
    },
  },
  {
    format: 1,
    id: 'night',
    label: '夜航',
    hint: '靛蓝强调色，深蓝黑底。整块屏幕退到后面去。',
    light: {
      accent: '#4f46e5',
      accentScale: INDIGO.light,
      pageBg: '#f5f6fa',
      chart: ['#818cf8', '#38bdf8', '#34d399', '#fbbf24', '#fb7185'],
    },
    dark: {
      accent: '#818cf8',
      accentScale: INDIGO.dark,
      pageBg: '#0b0e16',
      chart: ['#a5b4fc', '#7dd3fc', '#6ee7b7', '#fcd34d', '#fda4af'],
    },
  },
  {
    format: 1,
    id: 'ink',
    label: '极简',
    hint: '无色相。黑白灰，像一张纸和一支钢笔。',
    light: {
      accent: '#52525a',
      accentScale: INK.light,
      pageBg: '#f7f7f8',
      chart: ['#9e9ea6', '#c4c4cb', '#6f6f78', '#d4d4d9', '#8a8a93'],
    },
    dark: {
      accent: '#d4d4d9',
      accentScale: INK.dark,
      pageBg: '#101013',
      chart: ['#c4c4cb', '#8a8a93', '#e4e4e7', '#6f6f78', '#a1a1aa'],
    },
  },
  {
    format: 1,
    id: 'forest',
    label: '林间',
    hint: '青绿强调色，微暖的纸底。长时间看东西最不累的一档。',
    light: {
      accent: '#0d9488',
      accentScale: TEAL.light,
      pageBg: '#f6f8f6',
      chart: ['#2dd4bf', '#60a5fa', '#4ade80', '#fbbf24', '#fb923c'],
    },
    dark: {
      accent: '#2dd4bf',
      accentScale: TEAL.dark,
      pageBg: '#0b1211',
      chart: ['#5eead4', '#7dd3fc', '#86efac', '#fcd34d', '#fdba74'],
    },
  },
  {
    format: 1,
    id: 'ocean',
    label: '深海',
    hint: '青蓝强调色，冷灰底。图表多、数据密的时候最清爽。',
    // 这一条与「暖调」的色阶是**手写的一整条**（没有用 `scale()` 拼）：
    // 它们的中段要压住白字，而 400/500 又要当暗底上的强调色，两头的取值
    // 都比 `scale()` 的默认拼法更靠中间。
    light: {
      accent: '#0891b2',
      accentScale: {
        '50': '236 254 255',
        '100': '207 250 254',
        '200': '165 243 252',
        '300': '103 232 249',
        '400': '34 211 238',
        '500': '6 182 212',
        '600': '14 116 144',
        '700': '21 94 117',
        '800': '22 78 99',
        '900': '22 78 99',
        '950': '8 51 68',
      },
      pageBg: '#f4f7f9',
      chart: ['#22d3ee', '#60a5fa', '#34d399', '#818cf8', '#fbbf24'],
    },
    dark: {
      accent: '#22d3ee',
      accentScale: {
        '50': '236 254 255',
        '100': '207 250 254',
        '200': '165 243 252',
        '300': '103 232 249',
        '400': '34 211 238',
        '500': '6 182 212',
        '600': '14 116 144',
        '700': '21 94 117',
        '800': '22 78 99',
        '900': '22 78 99',
        '950': '12 74 92',
      },
      pageBg: '#0a1014',
      chart: ['#67e8f9', '#93c5fd', '#6ee7b7', '#a5b4fc', '#fcd34d'],
    },
  },
  {
    format: 1,
    id: 'warm',
    label: '暖调',
    hint: '琥珀强调色，米色底。像旧纸与台灯。',
    light: {
      accent: '#b45309',
      accentScale: AMBER.light,
      pageBg: '#faf7f2',
      chart: ['#f59e0b', '#fb7185', '#38bdf8', '#34d399', '#a78bfa'],
    },
    dark: {
      accent: '#fbbf24',
      accentScale: AMBER.dark,
      pageBg: '#12100c',
      chart: ['#fcd34d', '#fda4af', '#7dd3fc', '#6ee7b7', '#c4b5fd'],
    },
  },

  // ---------- 带底图的三套（「图片式背景皮肤」） ----------
  //
  // 这三条与上面六条的**唯一**差别就是多了一个 `bg`：色阶不给、由那个强调色推，
  // 中性阶不给、用共享的那份。所以「加一套带图的皮肤」也就是加一条对象 + 一个 SVG——
  // 这是加皮肤这件事最短的一条路，写在这里当样例。

  {
    format: 1,
    id: 'paper',
    label: '素纸',
    hint: '一层纸纹铺满整屏。暖灰强调色，最安静的一档。',
    light: {
      accent: '#7c6a58',
      pageBg: '#faf8f5',
      bg: { image: '/skins/paper-light.svg', fit: 'repeat', scrim: 52, scrimDir: 'flat', blur: 0 },
    },
    dark: {
      accent: '#c9b49c',
      pageBg: '#14120f',
      bg: { image: '/skins/paper-dark.svg', fit: 'repeat', scrim: 52, scrimDir: 'flat', blur: 0 },
    },
  },
  {
    format: 1,
    id: 'aurora',
    label: '极光',
    hint: '同一片天的两种时辰。面板半透明，字从极光上浮起来。',
    light: {
      accent: '#0f766e',
      pageBg: '#eef4f4',
      // **这一条是「完整皮肤」的样例**：底图、色调、面板通透度、壳通透度、
      // 模糊一起给，而不是只给一个色号。它演示了 `surfaces` 那五个旋钮各自管什么。
      //
      // 面板 82% / 壳 72%：壳比面板更透一点，于是图从侧栏与顶栏底下透出来的
      // 比从卡片底下更多——**层级靠这个差别读出来**，而不是靠加阴影。
      surfaces: { glass: 82, chromeGlass: 72, blur: 10 },
      bg: {
        image: '/skins/aurora-light.svg',
        fit: 'cover',
        scrim: 55,
        scrimDir: 'edge',
        blur: 0,
        // 焦点往上挪一点：极光带在天上，而 `cover` 在宽屏上会从中间裁。
        focusX: 50,
        focusY: 38,
        tint: { color: '#dff5f0', alpha: 20 },
      },
    },
    dark: {
      accent: '#5eead4',
      pageBg: '#070c14',
      // 暗色下面板更透（72% / 62%）：夜里那张图本身就很暗，多透一点不会伤可读性，
      // 而**该看见的东西**（极光带）正好在中段，让面板微微透出来才像那个场景。
      surfaces: { glass: 72, chromeGlass: 62, blur: 14 },
      bg: {
        image: '/skins/aurora-dark.svg',
        fit: 'cover',
        scrim: 45,
        scrimDir: 'edge',
        blur: 0,
        focusX: 50,
        focusY: 38,
        tint: { color: '#0b1f2a', alpha: 26 },
      },
    },
  },
  {
    format: 1,
    id: 'ridge',
    label: '远山',
    hint: '雾里四道山脊，越往下越平。画面有远近，但没有任何"内容"抢注意力。',
    light: {
      accent: '#4a6b8a',
      pageBg: '#edf2f7',
      // 远山是**风景**：面板半透明，让雾从卡片底下透一点上来。壳比面板更透，
      // 于是侧栏看起来像一块立在雾里的玻璃——层级由通透度的差别读出来。
      surfaces: { glass: 86, chromeGlass: 76, blur: 8 },
      // 风景类的图靠 `cover` 铺满，压暗**往边缘加重**：文字在左边和上边，
      // 中间那片山该留着。这一条与 orca-link 那套皮肤的做法同源。
      bg: { image: '/skins/ridge-light.svg', fit: 'cover', scrim: 58, scrimDir: 'edge', blur: 0 },
    },
    dark: {
      accent: '#8fb0cf',
      pageBg: '#0a0e13',
      surfaces: { glass: 76, chromeGlass: 64, blur: 10 },
      bg: { image: '/skins/ridge-dark.svg', fit: 'cover', scrim: 58, scrimDir: 'edge', blur: 0 },
    },
  },
  {
    format: 1,
    id: 'grid',
    label: '格纸',
    hint: '工程方格纸。大格 200、小格 40，写东西时像摊开一张草稿纸。',
    light: {
      accent: '#46586b',
      pageBg: '#f7f8f9',
      bg: { image: '/skins/grid-light.svg', fit: 'repeat', scrim: 48, scrimDir: 'flat', blur: 0 },
    },
    dark: {
      accent: '#9fb0c2',
      pageBg: '#0e1012',
      bg: { image: '/skins/grid-dark.svg', fit: 'repeat', scrim: 48, scrimDir: 'flat', blur: 0 },
    },
  },
]

/** 内置皮肤，id → 运行时对象。**「加一个皮肤 = 加一份配置」那句话的字面实现**：
 *  上面那份数组是唯一需要动的地方。 */
export const BUILTIN_SKINS: Skin[] = BUILTIN_MANIFESTS.map(manifestToSkin)

/** 内置皮肤的 id，按展示顺序。用户导入的皮肤排在它们后面（见 `registry.ts`）。 */
export const BUILTIN_SKIN_IDS: string[] = BUILTIN_SKINS.map((s) => s.id)
