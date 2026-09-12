// 浏览器剪藏的纯逻辑：深链参数解析 + 书签小工具字符串构造。
//
// 单独放一个模块是为了可测——两件事都是纯函数，而 KBPage 一 import 就会把
// React / Layout 整条依赖拖进来。

export interface ClipRequest {
  url: string
  title: string
}

const HTTP_RE = /^https?:\/\//i

/**
 * `?clip=<url>&title=<t>` → 剪藏请求；没有（或不是 http(s)）返回 null。
 *
 * 小工具送来的永远是带 scheme 的 `location.href`；这条判断是防手搓的深链把
 * 别的 scheme 塞给后端去「抓取」。
 */
export function parseClipParams(search: string): ClipRequest | null {
  const p = new URLSearchParams(search)
  const url = (p.get('clip') || '').trim()
  if (!HTTP_RE.test(url)) return null
  return { url, title: (p.get('title') || '').trim() }
}

/**
 * 整段选中文字就是**一个裸 URL** 时返回它，否则 null。
 *
 * 划词助手的剪藏对这两种输入是两条路：URL 该去抓正文（并留下来源），其余才是
 * 「把这段话存下来」。判据要严——带空格的多行选中一律不算，免得把正文里恰好
 * 含链接的段落当成网址去抓。
 */
export function asSingleUrl(text: string): string | null {
  const t = (text || '').trim()
  if (!t || /\s/.test(t)) return null
  return HTTP_RE.test(t) ? t : null
}

/**
 * 书签小工具源码。拖到书签栏后，在任意网页点一下就把当前页交给工作台剪藏。
 *
 * 走 `window.open` 顶层导航而不是 `fetch`：CORS 只放行 vite dev server，且 https
 * 页面里跨源 fetch 会被浏览器拦——顶层导航不受这两条限制。
 * origin 由调用方给（`window.location.origin`），dev(5173) 与打包(8000) 都对。
 *
 * 目标是路由 `/kb`（不是 `/kb.html`）。已经拖到别人书签栏里的旧小工具仍写着
 * `/kb.html`——路由层把 `.html` 当别名，那条路继续有效，别去动它。
 */
export function buildBookmarklet(origin: string): string {
  const target = `${origin.replace(/\/+$/, '')}/kb`
  return (
    'javascript:(()=>{' +
    'const u=encodeURIComponent(location.href),t=encodeURIComponent(document.title);' +
    `window.open('${target}?clip='+u+'&title='+t,'_blank','width=520,height=240');` +
    '})()'
  )
}

/**
 * 剪藏深链跑完之后，这个窗口该不该自己关掉。
 *
 * 判据是 `window.opener`：只有脚本开的窗口 close() 才有效。书签小工具正是那个形态；
 * 而把深链粘进普通标签页时 opener 为空——那就把结果留在页面上给人看，别让它关掉一片
 * 用户自己开的标签。
 *
 * 抽成纯函数纯粹是为了能测：jsdom 不实现 `window.opener`，也不允许 close。
 */
export function shouldAutoClose(hasOpener: boolean, ok: boolean): boolean {
  return ok && hasOpener
}
