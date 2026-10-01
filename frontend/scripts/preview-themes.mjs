/** 生成一份**静态预览**：六个皮肤 × 亮暗两套，各画一张「工作台一角」。
 *
 *  为什么要有它：皮肤是运行时的（`theme.ts` 往 `<html>` 写内联变量），
 *  没有后端、没有浏览器就看不见。而「这个配色到底好不好看、文字读不读得清」
 *  恰恰是**必须看一眼**才能判断的事——写成一份能直接打开的 HTML，
 *  评审时不用先把整个应用跑起来。
 *
 *  用法（在 frontend/ 下）：
 *      node scripts/preview-themes.mjs            # 写到 ../theme-preview.html
 *
 *  **它不参与构建，也不是产品代码**：读的是 `src/theme/` 那几份真值，
 *  所以预览与真实配色不可能分叉（加一个皮肤，这里自动多一张）。
 *  画的是缩略示意图，不是真的渲染 React 组件——它的用途是看颜色关系，
 *  不是看排版。 */
import { writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = resolve(HERE, '..', 'src')
const OUT = resolve(HERE, '..', '..', 'theme-preview.html')

// 用 vite 的 esbuild 把 TS 转成 JS 再 import——直接 import .ts 在 node 里不行
const { build } = await import('esbuild')
const bundled = await build({
  entryPoints: [resolve(SRC, 'theme/previewData.ts')],
  bundle: true,
  format: 'esm',
  write: false,
  platform: 'neutral',
})
const mod = await import(
  'data:text/javascript;base64,' + Buffer.from(bundled.outputFiles[0].text).toString('base64')
)
const { BUILTIN_SKIN_IDS, BUILTIN_SKINS } = mod
const skins = BUILTIN_SKIN_IDS.map((id) => BUILTIN_SKINS.find((s) => s.id === id))

/** 把一套 token 摊成 CSS 变量（与 `theme.ts` 的 `themeCssVars` 同一套名字）。 */
function vars(skin, dark) {
  const v = dark ? skin.dark : skin.light
  const out = []
  for (const [step, ch] of Object.entries(v.neutral)) out.push(`--wb-neutral-${step}: ${ch}`)
  for (const [step, ch] of Object.entries(v.accentScale)) {
    out.push(`--wb-violet-${step}: ${ch}`)
    out.push(`--wb-fuchsia-${step}: ${ch}`)
  }
  out.push(`--wb-page-bg: ${v.pageBg}`)
  out.push(`--wb-chart-0: ${v.accent}`)
  v.chart.forEach((c, i) => out.push(`--wb-chart-${i + 1}: ${c}`))
  out.push(`--wb-chart-label: ${dark ? '#9ca3af' : '#6b7280'}`)
  out.push(`--wb-chart-grid: ${dark ? 'rgba(255,255,255,0.1)' : 'rgba(16,24,40,0.08)'}`)
  // 底图：站内路径 `/skins/...` 在这个**独立打开的 HTML** 里解析不到
  // （它躺在仓库根，而图在 frontend/public 下），所以改成相对路径。
  // 压暗层也照画——预览要能看出「字压不压得住」，那正是这类皮肤的关键。
  if (v.bg) {
    const fit = v.bg.fit === 'repeat' ? 'auto' : v.bg.fit
    const repeat = v.bg.fit === 'repeat' ? 'repeat' : 'no-repeat'
    const tint = dark ? '0,0,0' : '255,255,255'
    out.push(
      `--wb-preview-bg-img: url("${publicPath(v.bg.image)}")`,
      `--wb-preview-bg-size: ${fit}`,
      `--wb-preview-bg-repeat: ${repeat}`,
      `--wb-preview-bg-scrim: rgba(${tint},${v.bg.scrim / 100})`
    )
  } else {
    out.push('--wb-preview-bg-img: none')
  }
  return out.join(';')
}

/** `/skins/a.svg` → 相对仓库根的 `frontend/public/skins/a.svg`；http(s) 原样放过。 */
function publicPath(url) {
  return url.startsWith('/skins/') ? `frontend/public${url}` : url
}

/** 一小块「工作台一角」：侧栏、顶栏、一张卡、几个控件。
 *  刻意画上**按钮 / 选中态 / 输入框 / 图表**——皮肤好不好不取决于底色，
 *  取决于这几样东西摆在一起还认不认得出层级。 */
function panel(skin, dark) {
  const v = dark ? skin.dark : skin.light
  const rgb = (ch) => `rgb(${ch})`
  const body = dark ? rgb(v.neutral['950']) : rgb(v.neutral['50'])
  const text = dark ? rgb(v.neutral['100']) : rgb(v.neutral['900'])
  const sub = dark ? rgb(v.neutral['400']) : rgb(v.neutral['500'])
  const line = dark ? rgb(v.neutral['800']) : rgb(v.neutral['200'])
  const card = dark ? rgb(v.neutral['900']) : '#fff'
  const acc = v.accent
  // 实底按钮的两端与 `theme.ts` 的推法一致（色阶的 600 → 700），不是 `accent`
  // ——`accent` 只是预览色块的代表色，拿它当按钮底会画出一个产品里不存在的按钮。
  const btnFrom = rgb(v.accentScale['600'])
  const btnTo = rgb(v.accentScale['700'])
  // 选中态的底色与文字取的是**同一档位**（亮色 100/700、暗色 500 的透明叠加/300），
  // 与产品里的 `bg-violet-50 … text-violet-700 dark:bg-violet-500/10 … dark:text-violet-300`
  // 对齐。写错档位时症状是「选中项的文字与底色糊在一起」——预览里一眼看得见，
  // 真界面上只有那一个角落不对，反而难发现。
  const accSoft = dark ? `color-mix(in srgb, ${rgb(v.accentScale['500'])} 14%, transparent)` : rgb(v.accentScale['100'])
  const accSoftText = rgb(v.accentScale[dark ? '300' : '700'])

  return `
  <figure class="panel" style="${vars(skin, dark)}">
    <figcaption>
      <b>${skin.label}</b>
      <span>${dark ? '暗色' : '亮色'} · ${v.accent}</span>
    </figcaption>
    <div class="app" style="background:${body};color:${text}">
      <!-- 底图那两层与真界面里那三层背景同构：图一层、压暗一层，
           底下透出的是页面底色。 -->
      <div class="bg" style="background-image:var(--wb-preview-bg-img);background-size:var(--wb-preview-bg-size);background-repeat:var(--wb-preview-bg-repeat)"></div>
      <div class="bg" style="background:var(--wb-preview-bg-scrim)"></div>
      <div class="side" style="background:${dark ? 'rgba(255,255,255,.03)' : 'rgba(255,255,255,.6)'};border-color:${line}">
        <div class="logo"><i style="background:${btnFrom}"></i><span>AI 工作台</span></div>
        <div class="nav on" style="background:${accSoft};color:${accSoftText}">
          <i style="background:${btnFrom}"></i>对话
        </div>
        <div class="nav" style="color:${sub}"><i style="background:${sub}"></i>今日</div>
        <div class="nav" style="color:${sub}"><i style="background:${sub}"></i>工作</div>
        <div class="nav" style="color:${sub}"><i style="background:${sub}"></i>设置</div>
      </div>
      <div class="main">
        <div class="top" style="border-color:${line};color:${sub}">
          <span style="color:${text}">工作</span> / 报告
          <em style="border-color:${line}">Ctrl K</em>
        </div>
        <div class="body">
          <div class="card" style="background:${card};border-color:${line}">
            <div class="h" style="color:${text}">本周报告</div>
            <div class="p" style="color:${sub}">正文用中性阶，标题比正文深两档——层级靠字重与明度，不靠阴影。</div>
            <div class="row">
              <button style="background:linear-gradient(to bottom,${btnFrom},${btnTo});color:#fff">保存</button>              <button class="ghost" style="border-color:${btnFrom};color:${btnFrom}">取消</button>
            </div>
          </div>
          <div class="card" style="background:${card};border-color:${line}">
            <div class="p" style="color:${sub}">输入框与图表</div>
            <input value="deepseek-chat" style="border-color:${line};color:${text};background:transparent" readonly />
            <div class="bars">
              ${[38, 62, 30, 74, 52, 44]
                .map(
                  (h, i) =>
                    `<span style="height:${h}%;background:${[acc, ...v.chart][i % 6]}"></span>`
                )
                .join('')}
            </div>
          </div>
        </div>
      </div>
    </div>
  </figure>`
}

const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8" />
<title>皮肤预览 · AI 工作台</title>
<style>
  :root { --fg:#18181b; --sub:#71717a; --line:#e4e4e7; --bg:#fafafa; }
  @media (prefers-color-scheme: dark) { :root { --fg:#f4f4f5; --sub:#a1a1aa; --line:#27272a; --bg:#0b0b0c; } }
  * { box-sizing: border-box; }
  body { margin:0; padding:40px; background:var(--bg); color:var(--fg);
         font:14px/1.5 Inter, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; }
  h1 { font-size:20px; margin:0 0 6px; }
  .lead { color:var(--sub); max-width:70ch; margin:0 0 28px; font-size:13px; }
  .grid { display:grid; gap:22px; grid-template-columns:repeat(auto-fill, minmax(360px, 1fr)); }
  .panel { margin:0; }
  figcaption { display:flex; align-items:baseline; gap:8px; padding-bottom:8px; font-size:13px; }
  figcaption span { color:var(--sub); font-variant-numeric:tabular-nums; }
  .app { position:relative; display:flex; height:220px; border:1px solid var(--line); border-radius:10px; overflow:hidden; }
  /* 底图与压暗都压在内容下面；侧栏与主区各自抬起来（注意这整段在模板字符串里，
     注释里不能用反引号——那会直接把字符串截断） */
  .bg { position:absolute; inset:0; pointer-events:none; }
  .side, .main { position:relative; }
  .side { width:96px; flex:none; border-right:1px solid; padding:8px 6px; display:flex; flex-direction:column; gap:3px; }
  .logo { display:flex; align-items:center; gap:5px; font-size:11px; font-weight:600; padding:2px 2px 8px; }
  .logo i { width:14px; height:14px; border-radius:4px; display:block; }
  .nav { display:flex; align-items:center; gap:5px; font-size:11px; padding:4px 6px; border-radius:6px; }
  .nav i { width:7px; height:7px; border-radius:2px; display:block; opacity:.75; }
  .nav.on i { opacity:1; }
  .main { flex:1; min-width:0; display:flex; flex-direction:column; }
  .top { display:flex; align-items:center; gap:5px; font-size:11px; padding:7px 10px; border-bottom:1px solid; }
  .top em { margin-left:auto; font-style:normal; border:1px solid; border-radius:4px; padding:0 4px; font-size:10px; }
  .body { flex:1; min-height:0; display:grid; grid-template-columns:1fr 1fr; gap:8px; padding:10px; }
  .card { border:1px solid; border-radius:8px; padding:9px; display:flex; flex-direction:column; gap:6px; }
  .h { font-size:12px; font-weight:600; }
  .p { font-size:10.5px; line-height:1.45; }
  .row { display:flex; gap:6px; margin-top:auto; }
  button { font:inherit; font-size:11px; border:0; border-radius:6px; padding:4px 10px; }
  button.ghost { background:transparent; border:1px solid; }
  input { font:inherit; font-size:11px; border:1px solid; border-radius:6px; padding:4px 6px; width:100%; }
  .bars { display:flex; align-items:flex-end; gap:3px; height:52px; margin-top:auto; }
  .bars span { flex:1; border-radius:2px 2px 0 0; }
</style></head>
<body>
  <h1>皮肤预览 · AI 工作台</h1>
  <p class="lead">
    由 <code>frontend/scripts/preview-themes.mjs</code> 从 <code>src/theme/</code> 的真值生成——
    与运行时写进 <code>&lt;html&gt;</code> 的是同一套 CSS 变量。每个皮肤画亮暗两张，
    用来判断配色关系（层级、对比度、强调色的份量），不代表真实排版。
  </p>
  <div class="grid">
    ${skins.flatMap((s) => [panel(s, false), panel(s, true)]).join('\n')}
  </div>
</body></html>
`

writeFileSync(OUT, html, 'utf8')
console.log(`wrote ${OUT} (${skins.length} skins × 2 modes)`)
