// 弹出置顶（P5 · Document Picture-in-Picture）的窗口准备（方向 6 第四刀，2026-09-29 自 PetWidget 拆出）。
//
// Chrome / Edge 116+ 能开一个**总在最前**的系统小窗：你切去写代码、看视频，零柒
// 都浮在屏幕上。浏览器给不了真透明与点击穿透（那是桌面壳的活），但「它一直在」
// 这件事先到手，且零桌面开发——同一份状态、同一条 SSE，只是换了个窗子摆。
export type PipWindow = Window & { document: Document }

export function copyStyles(target: Document) {
  // PiP 是另一份 document，样式得自己搬。内联 <style> 抄规则文本；跨域的 <link>
  // 读不了 cssRules，原样复制标签让浏览器自己去取。
  Array.from(document.styleSheets).forEach((sheet) => {
    try {
      const el = target.createElement('style')
      el.textContent = Array.from(sheet.cssRules)
        .map((r) => r.cssText)
        .join('\n')
      target.head.appendChild(el)
    } catch {
      const src = sheet.ownerNode
      if (src instanceof HTMLLinkElement) {
        const link = target.createElement('link')
        link.rel = 'stylesheet'
        link.href = src.href
        target.head.appendChild(link)
      }
    }
  })
}
