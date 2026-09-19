/**
 * 出一张**静态预览**：把仪表盘上那几张卡用真组件渲染成单文件 HTML，好让人一眼看见。
 *
 * 为什么要有它：这个仓库的界面验收一直是「跑测试 + 看产物」，而没有人**看**过页面。
 * 测试能证明「读不到时摆 —」，证明不了「摆出来好不好看」。这个脚本把后者变成
 * 一个能双击打开的文件。
 *
 * **放在 frontend/ 而不是 src/**：`npm run build` 会先跑 `tsc -b`，而 `tsc` 只收
 * `src/**` 下的 TS/TSX——预览脚本一旦放进 src，`node:fs` 这类 Node 类型就会让
 * **正式构建失败**（这个坑当场踩过一次）。所以它待在 src 外面，用 `.mjs` 写，
 * JSX 交给 vite 的 esbuild 现场转，不占 tsconfig 的名额。
 *
 * 用法：
 *   cd frontend
 *   npm run build          # 先有 dist/assets/index-*.css（预览要套真 CSS）
 *   node preview.mjs       # 产出 ../docs/preview-r1.html
 */
import { readFileSync, writeFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'vite'

const here = import.meta.dirname
const out = resolve(here, '../docs/preview-r1.html')

// ① 用 vite 的 dev server 当转译器：把这段 JSX（含它对真组件的 import）编成能跑的 ESM
//
// **三种状态都渲染**，因为「有数据」只是它的一种样子：真机上引擎可能一个都没跑过、
// 账本可能读不出来。只出有数据那一版，等于用最好看的状态骗自己。
const ENTRY = `
import { renderToStaticMarkup } from 'react-dom/server'
import { GroundedCard, TurnSummaryCard } from '${resolve(here, 'src/DashboardPage.tsx').replace(/\\/g, '/')}'

const engines = {
  research: { id: 3, engine: 'research', created_at: '', prompt_sha: 'aa', model_id: 'm', total: 8, structural: 0.88, grounded: 4.25, seconds: 60 },
  compose: { id: 2, engine: 'compose', created_at: '', prompt_sha: 'bb', model_id: 'm', total: 6, structural: 0.83, grounded: 3.5, seconds: 50 },
  decide: { id: 1, engine: 'decide', created_at: '', prompt_sha: 'cc', model_id: 'm', total: 5, structural: 1, grounded: null, seconds: 40 },
  recap: null,
}

const GROUNDED_WARNING =
  '接地分全在 4.5 以上，分档压在顶部、区分度低——要接得住回归，得补「材料互相冲突」「材料明显不足」「材料里没有答案」这类刁用例'

// —— 有数据 ——
const groundedFull = {
  by_engine: { ...engines, conflict: { id: 4, engine: 'conflict', created_at: '', prompt_sha: 'dd', model_id: 'm', total: 4, structural: 0.75, grounded: 4.75, seconds: 30 } },
  coverage: { research: 8, compose: 6, decide: 5, recap: 4, conflict: 4 },
  warnings: [GROUNDED_WARNING],
}

// —— 空：引擎一个都没跑过（**这是真机现在的样子**）——
const groundedEmpty = {
  by_engine: { research: null, compose: null, recap: null, decide: null, conflict: null },
  coverage: { research: 2, compose: 2, recap: 2, decide: 2, conflict: 4 },
  warnings: [],
}

// —— 读不出来 ——
// 接地分这张卡的「读不到」是 null：它的 readable 判据是 !!e，
// 因为端点要么给一份完整的 by_engine，要么整份读不到。
// （注意：给一个**空对象**不算读不到，那会渲染成「还没有引擎跑过分」——
//   语义上是对的：空对象确实等于一个都没跑过。这个区别在预览里要看得见。）
const groundedBroken = null

const summaryFull = {
  readable: true, error: '', days: 30, turns: 14, total: 14, truncated: false,
  counts: { lie: 2, no_save: 1, retried: 0, repaired: 0, invented_path: 1, dropped_receipt: 0, over: 0, rewrote: 0, multi: 0, slow: 5, expensive: 0, error: 0 },
  filters: [
    { key: 'lie', label: '声称存了没存', hint: '校验过的回合里，说了已存入但这一轮没落盘' },
    { key: 'no_save', label: '长正文没落盘', hint: '正文很长、却没有任何产出回执' },
    { key: 'invented_path', label: '报了个不存在的路径', hint: '回复里写的产出路径不在这一轮的回执里（点开即 404）' },
    { key: 'slow', label: '慢', hint: '这一轮超过 10 秒' },
  ],
  rules: {
    window: '窗口 = 最近 N 天（默认 30 天）里落过账的聊天回合',
    counts: '每一格是「窗口内命中这一类毛病的回合数」，判据与逐条清单、与筛选项同一份实现',
    no_rate: '这里没有成功率：这个模块是诊断工具，不是考核仪表（不设目标、不排名、不催）',
    truncated: '库很大时只数最近 2000 轮（内存在此打住）——超了会标出来，不静默截断',
  },
}

// —— 空：这 30 天没聊过天（**这也是真机现在的样子**）——
const summaryEmpty = { ...summaryFull, turns: 0, total: 0, counts: Object.fromEntries(Object.keys(summaryFull.counts).map((k) => [k, 0])) }

// —— 读不出来：**注意这里 readable:false 但对象照旧有形状**，
//    正是这一条让早期版本把「读不出来」渲染成一屏 0 ——
const summaryBroken = { ...summaryEmpty, readable: false, error: 'OperationalError: no such table: turn_traces' }

const block = (label, note, ...html) =>
  '<div class="grp"><div class="grp-h"><span class="grp-t">' + label + '</span><span class="grp-n">' + note + '</span></div>' + html.join('') + '</div>'

export const html =
  block('接地分 · 有数据', '4/5 个引擎量到了分，一根 4.75 的柱子顶到轨道尽头 —— 那正是下面那句体检结论说的「区分度低」',
    renderToStaticMarkup(GroundedCard({ e: groundedFull }))) +
  block('接地分 · 空（真机现状）', '5 个引擎全没跑过：整条轨道是空的，一个 0 分的柱子都不补',
    renderToStaticMarkup(GroundedCard({ e: groundedEmpty }))) +
  block('接地分 · 读不出来', '整份读数拿不到（e === null）：一个数都不摆，只说读不出来',
    renderToStaticMarkup(GroundedCard({ e: groundedBroken }))) +
  block('回合读数 · 有数据', '四类毛病按「占了多少轮」出柱，分母是窗口里的 14 轮',
    renderToStaticMarkup(TurnSummaryCard({ t: summaryFull }))) +
  block('回合读数 · 空（真机现状）', '这 30 天没聊过天 —— 只说这一句，不摆十二个 0',
    renderToStaticMarkup(TurnSummaryCard({ t: summaryEmpty }))) +
  block('回合读数 · 读不出来', 'readable:false 时摆 —，**不把它渲染成一屏 0**',
    renderToStaticMarkup(TurnSummaryCard({ t: summaryBroken })))
`

const tmp = mkdtempSync(join(tmpdir(), 'wb-preview-'))
const entryFile = join(tmp, 'entry.mjs')
writeFileSync(entryFile, ENTRY, 'utf-8')

let html
const server = await createServer({
  root: here,
  configFile: false,
  logLevel: 'error',
  server: { middlewareMode: true, hmr: false },
  plugins: [
    (await import('@vitejs/plugin-react')).default(),
    {
      // 入口是临时目录里的文件，dev server 的 fs 白名单默认不放行 —— 显式放行
      name: 'allow-tmp',
      enforce: 'pre',
      resolveId: (id) => (id === 'virtual:preview' ? entryFile : null),
      load: (id) => (id === entryFile ? ENTRY : null),
    },
  ],
  optimizeDeps: { noDiscovery: true, include: [] },
})
try {
  html = (await server.ssrLoadModule(entryFile)).html
} finally {
  await server.close()
  rmSync(tmp, { recursive: true, force: true })
}

// ② 套上**真的** CSS：直接用 `npm run build` 那份（它按 src/**/*.tsx 扫过类名）
const assets = resolve(here, 'dist/assets')
const cssName = readdirSync(assets).find((f) => f.startsWith('index-') && f.endsWith('.css'))
if (!cssName) throw new Error('找不到 dist 里的 CSS —— 先跑 npm run build')

writeFileSync(
  out,
  `<!doctype html>
<html lang="zh-CN"><head><meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>仪表盘读数卡 · 静态预览</title>
<style>${readFileSync(resolve(assets, cssName), 'utf-8')}</style>
<style>
  body { padding: 40px 24px 72px; max-width: 760px; margin: 0 auto; }
  .note { font: 12px/1.7 ui-sans-serif, system-ui, "Microsoft YaHei"; color: #737373; }
  code { background: #f5f5f5; padding: 1px 4px; border-radius: 3px; }
  /* 分组头：只在预览里有，用来把「同一条读数的三种状态」并排摆开 */
  .grp { margin-top: 34px; }
  .grp-h { border-top: 1px solid #e5e5e5; padding-top: 10px; }
  .grp-t { font: 600 13px/1.4 ui-sans-serif, system-ui, "Microsoft YaHei"; color: #171717; }
  .grp-n { display: block; font: 11px/1.6 ui-sans-serif, system-ui, "Microsoft YaHei"; color: #8a8a8a; margin-top: 2px; }
</style>
</head><body>
<p class="note">下面每一块都是 <b>真组件</b>（<code>GroundedCard</code> / <code>TurnSummaryCard</code>）渲染的静态快照，
套的是应用自己的 CSS（来自 <code>npm run build</code>）。数据是造的样例，不是真库。<br />
<b>为什么三种状态都摆</b>：真机上这两条读数现在都是空的（引擎没跑过、30 天没聊过天），
只出「有数据」那一版等于拿最好看的样子骗自己。</p>
${html}
</body></html>`,
  'utf-8'
)
console.log('写好了：', out)
