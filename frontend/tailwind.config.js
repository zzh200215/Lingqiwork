/** 调色板接到 CSS 变量上（**换肤的地基**，见 `src/theme.ts` 顶部那段说明）。
 *
 *  为什么不在这里多写几套色板：`dark:` 是**编译期**的，构建产物里就是两条固定规则，
 *  运行时改不了；而全仓 240+ 个组件把类名写死在业务代码里。把调色板本身换成
 *  `rgb(var(--wb-*))`，现有的一万多个 `bg-violet-*` / `border-neutral-*` / `text-neutral-*`
 *  就**一个都不用改**，换肤 = 换这几个变量的值（`theme.ts` 往 `<html>` 上写内联变量）。
 *
 *  两个名字是有讲究的：
 *  - `neutral` —— 底色与文字。六个皮肤共用一套值（可读性是产品的地板，不是风格选项），
 *    但亮 / 暗两套值都在变量里，将来要按皮肤微调时不必再改这里。
 *  - `violet` —— **语义上它就是「强调色阶」**，只是名字没改成 `accent`：类名已经写在
 *    一万处，改名等于把这次改动扩散到整个前端。`fuchsia` 跟着它走，于是
 *    `from-violet-500 to-fuchsia-500` 那种双色渐变自动变成单色渐变。
 *
 *  `<alpha-value>` 是透明度修饰符（`bg-neutral-200/70`、`border-violet-500/40`）的落点：
 *  颜色必须以 `R G B` 通道形式给出，Tailwind 才拆得出 alpha 通道。 */
const scale = (prefix) =>
  Object.fromEntries(
    ['50', '100', '200', '300', '400', '500', '600', '700', '800', '900', '950'].map((step) => [
      step,
      `rgb(var(--wb-${prefix}-${step}) / <alpha-value>)`,
    ])
  )

const VARIABLE_PALETTE = {
  neutral: scale('neutral'),
  violet: scale('violet'),
  fuchsia: scale('fuchsia'),
}

/** 变量缺席时的兜底值。这些不是「默认主题」——默认主题在 `src/theme/skins.ts` 里，
 *  由 `bootTheme()` 在首屏之前写进 `<html>`。这里只是让样式表在**没有任何 JS**
 *  的情况下也能渲染（例如单独打开一个 HTML 快照）。数值与 `default` 皮肤一致。
 *
 *  **两处必须同时改**：兜底值与皮肤值分叉的症状是「JS 没跑起来时颜色和跑起来后
 *  不一样」——而那正是最难被发现的场景。 */
const FALLBACK_VARS = {
  neutral: {
    50: '250 250 250',
    100: '245 245 245',
    200: '229 229 229',
    300: '212 212 212',
    400: '163 163 163',
    // 比 Tailwind 原值深一档（与 `skins.ts` 的 `NEUTRAL_LIGHT['500']` 同值）：
    // 次要文字要能压在几个皮肤那几种浅色页面底上（见 skins.ts 里那段说明）。
    500: '107 107 107',
    600: '82 82 82',
    700: '64 64 64',
    800: '38 38 38',
    900: '23 23 23',
    950: '10 10 10',
  },
  violet: {
    50: '245 243 255',
    100: '237 233 254',
    200: '221 214 254',
    300: '196 181 253',
    400: '167 139 250',
    500: '139 92 246',
    600: '124 58 237',
    700: '109 40 217',
    800: '91 33 182',
    900: '76 29 149',
    950: '46 16 101',
  },
}

/** 暗色下的中性阶兜底（与 `skins.ts` 的 `NEUTRAL_DARK` 同一份值）。
 *  强调色阶这里给不出「哪个皮肤的暗色」——没有 JS 时就沿用亮色强调色：
 *  可读，只是不如有 JS 时准。 */
const FALLBACK_VARS_DARK = {
  neutral: {
    400: '161 161 170',
    500: '113 113 122',
    600: '82 82 91',
    700: '63 63 70',
    800: '39 39 42',
    900: '24 24 27',
  },
}

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: VARIABLE_PALETTE,
      fontFamily: {
        sans: [
          'Inter',
          'ui-sans-serif',
          'system-ui',
          '-apple-system',
          'Segoe UI',
          'PingFang SC',
          'Microsoft YaHei',
          'sans-serif',
        ],
      },
      animation: {
        'fade-in': 'fadeIn 0.25s ease-out',
        'slide-up': 'slideUp 0.3s ease-out',
        'pulse-dot': 'pulseDot 1.2s ease-in-out infinite',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        slideUp: {
          '0%': { opacity: '0', transform: 'translateY(10px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        pulseDot: {
          '0%, 100%': { opacity: '0.3', transform: 'scale(0.85)' },
          '50%': { opacity: '1', transform: 'scale(1)' },
        },
      },
    },
  },
  plugins: [
    require('@tailwindcss/typography'),
    /** 把兜底通道值写进 `:root` / `.dark`。
     *
     *  写成插件而不是往 `index.css` 手抄一遍：**通道值只有一处真相**（上面那张表），
     *  而 `index.css` 是手写的、这张表是算出来的——两处各写一份迟早分叉，
     *  症状是「JS 没跑起来时颜色和跑起来后不一样」，极难发现。 */
    function ({ addBase }) {
      const vars = (palette) =>
        Object.fromEntries(
          Object.entries(palette).flatMap(([name, steps]) =>
            Object.entries(steps).map(([step, v]) => [`--wb-${name}-${step}`, v])
          )
        )
      addBase({
        ':root': vars(FALLBACK_VARS),
        '.dark': vars(FALLBACK_VARS_DARK),
      })
    },
  ],
}
