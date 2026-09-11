import { useEffect, useRef } from 'react'

import { buildBookmarklet } from './capture'

/**
 * 可拖到书签栏的剪藏按钮。
 *
 * **为什么用 ref 设 href，而不是 href prop**：React 19 会把 `javascript:` 的 href
 * 换成一句 `throw`（安全策略），那样拖到书签栏得到的就是个废书签——点了没反应，而且在
 * 页面上看不出来。`setAttribute` 设的属性 React 不管，就不会被改写。
 * （`capture.test.ts` 只钉得住字符串本身，钉不住 React 这一层，所以这个组件单独有测试。）
 */
export default function BookmarkletLink({
  origin,
  className,
}: {
  origin: string
  className?: string
}) {
  const ref = useRef<HTMLAnchorElement | null>(null)

  useEffect(() => {
    ref.current?.setAttribute('href', buildBookmarklet(origin))
  }, [origin])

  return (
    <a
      ref={ref}
      draggable
      onClick={(e) => e.preventDefault()}
      title="拖我到书签栏"
      className={className}
    >
      📥 剪藏到工作台
    </a>
  )
}
