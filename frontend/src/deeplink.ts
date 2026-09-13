/** 深链落点：从「一件事」点一条引用过来，落到**它自己**身上，而不只是那个页面。

    用法就一句：目标页面给条目一个 `id`（`card-7` / `decision-7` / `task-7`），
    然后 `useDeepLink('card', ready)` —— 它读 `?card=7`，滚过去、亮一下，2.5 秒后摘掉。
    **一次性提示，不是选中态**：之后你滚走、筛选、刷新都不受影响。

    `ready` 是数据到没到：列表是异步拉的，第一次渲染时元素还不存在。元素没找到就什么
    都不做（比如那张卡正好不在列表里）——宁可静默，也不要滚动到别的东西上去。
*/
import { useEffect } from 'react'
import { useSearchParams } from 'react-router-dom'

const HOT_MS = 2500

export function useDeepLink(param: string, ready: boolean): void {
  const [params] = useSearchParams()
  const target = params.get(param) || ''

  useEffect(() => {
    if (!ready || !target) return
    const el = document.getElementById(`${param}-${target}`)
    if (!el) return
    el.scrollIntoView({ block: 'center' })
    el.classList.add('wb-hot')
    const t = setTimeout(() => el.classList.remove('wb-hot'), HOT_MS)
    return () => {
      clearTimeout(t)
      el.classList.remove('wb-hot')
    }
  }, [ready, target, param])
}
