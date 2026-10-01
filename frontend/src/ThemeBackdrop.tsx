import { useEffect, useState } from 'react'

import { useTheme } from './ThemeProvider'

/** 这张图还在不在。
 *
 *  **背景图是 CSS 画的，加载失败没有任何回调。** 一个指向别处 `/api/images/x.png`
 *  的皮肤（导出给别人、或者图被删了）会留下一层压暗盖在空底上——比「没有背景」
 *  难看，而且完全看不出是为什么。探一次（同一张图浏览器已经缓存了，等于不花钱），
 *  失败就整层不画。
 *
 *  这是 Tabliss 处理同一件事的做法：**保留那个条目、退到一个能看的默认样子，
 *  绝不悄悄删掉用户起过名字的东西**。皮肤退回它自己的页面底色之后仍然是一套
 *  能用的皮肤——强调色、色阶、亮暗都还在，只是没有那张图。
 *
 *  初值给 `true`：jsdom 里 `onload` / `onerror` 永远不会触发，而初值给 `false`
 *  会让所有既有测试里的背景层凭空消失。**「还没探到」与「探到是坏的」是两件事**，
 *  默认信它一次，探到坏了再撤。 */
function useImageAlive(url: string): boolean {
  const [alive, setAlive] = useState(true)
  useEffect(() => {
    if (!url) return
    let live = true
    setAlive(true)
    const probe = new Image()
    probe.onload = () => {
      if (live) setAlive(true)
    }
    probe.onerror = () => {
      if (live) setAlive(false)
    }
    probe.src = url
    return () => {
      live = false
    }
  }, [url])
  return alive
}

/** 自定义背景层：铺在应用内容**下面**的一张固定画布。
 *
 *  为什么不把图直接挂到根容器的 `background-image` 上：侧栏与顶栏是半透明的
 *  （`bg-white/70` + `backdrop-blur`），图必须真的在它们下面才能透出来；
 *  挂在同一个元素上只会被它们盖住。
 *
 *  **只有 `mode === 'image'` 才渲染**：纯色与渐变走 `--wb-page-bg`（皮肤那一层
 *  本来就在画底色，再叠一层是白费合成）。渲染条件与 `applyTheme()` 写的
 *  `data-wb-bg` 是同一个判据——两处不一致时症状是「背景层存在但被 CSS 藏了」，
 *  所以这里干脆按同一个条件来。
 *
 *  这里读的 `resolved.bg` 是**生效的**那一份：用户自己设了背景就是用户那张，
 *  没设就是皮肤自带的那张（见 `theme.ts` 的 `effectiveBg`）。
 *  于是「图片式背景皮肤」不需要这个组件知道有「皮肤」这回事。
 *
 *  三个子层的分工写在 `index.css` 那一段注释里（定位 / 图+模糊 / 压暗）。 */
export default function ThemeBackdrop() {
  const { resolved } = useTheme()
  const url = resolved.bg.mode === 'image' ? resolved.image : ''
  const alive = useImageAlive(url)
  if (resolved.bg.mode !== 'image' || !resolved.image || !alive) return null

  const repeat = resolved.bg.fit === 'repeat'
  return (
    <div className="wb-backdrop" data-wb-backdrop="" aria-hidden="true">
      <div
        className="wb-backdrop-img"
        data-wb-backdrop-img={resolved.image}
        data-wb-fit={resolved.bg.fit}
        style={{
          backgroundImage: `url("${resolved.image}")`,
          // 平铺时 `cover` 会把一个格子拉伸成整屏，那不是平铺。格子自己多大就是多大
          // （图本身带尺寸），所以这一项交给 CSS 的 `auto`。
          backgroundSize: repeat ? undefined : resolved.bg.fit,
        }}
      />
      {/* 色调薄纱：图与压暗层之间的那一层。**顺序在 DOM 里就是顺序**——
          不做成压暗层上的第二个 `background-image`，因为那要靠层叠顺序的记忆，
          而这里读一眼就知道谁在谁上面。 */}
      <div className="wb-backdrop-tint" data-wb-backdrop-tint="" />
      <div className="wb-backdrop-scrim" data-wb-backdrop-scrim="" />
    </div>
  )
}
