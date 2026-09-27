import { useEffect, useRef } from 'react'

const PETAL_COLORS = ['244, 114, 182', '167, 139, 250', '249, 168, 212']

/** 樱花氛围层（对话页个性化试点）：canvas 花瓣缓慢下落 + 左右摇曳。
 *
 *  参考经典的博客樱花特效（sakura.js 一脉），但按本仓的规矩收敛过：
 *  - **纯装饰**：pointer-events-none、不读接口、不存数据——它只是氛围；
 *  - **respect reduced-motion**（§I）：用户要求减少动态时整层不画；
 *  - **可关**：对话工具栏的 🌸 开关（localStorage `wb:ambience`，默认开）；
 *  - 页签切到后台就停（visibilitychange），回到前台接着落；
 *  - jsdom / 老浏览器拿不到 2d 上下文时安静退化，绝不报错。
 */
export default function SakuraLayer({ on }: { on: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    if (!on) return
    const reduced =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (reduced) return
    const canvas = ref.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return

    interface Petal {
      x: number
      y: number
      s: number
      vy: number
      amp: number
      ph: number
      rot: number
      vr: number
      c: string
      a: number
    }
    let raf = 0
    let w = 0
    let h = 0
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    let petals: Petal[] = []

    const spawn = (fromTop: boolean): Petal => ({
      x: Math.random() * w,
      y: fromTop ? -14 : Math.random() * h,
      s: 5 + Math.random() * 6,
      vy: 0.4 + Math.random() * 0.7,
      amp: 20 + Math.random() * 30,
      ph: Math.random() * Math.PI * 2,
      rot: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 0.02,
      c: PETAL_COLORS[Math.floor(Math.random() * PETAL_COLORS.length)],
      a: 0.3 + Math.random() * 0.25,
    })

    const resize = () => {
      w = window.innerWidth
      h = window.innerHeight
      canvas.width = w * dpr
      canvas.height = h * dpr
      canvas.style.width = `${w}px`
      canvas.style.height = `${h}px`
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      const n = Math.max(8, Math.min(18, Math.floor(w / 90)))
      petals = Array.from({ length: n }, () => spawn(false))
    }

    const draw = () => {
      ctx.clearRect(0, 0, w, h)
      const t = performance.now() / 1000
      for (const p of petals) {
        p.y += p.vy
        p.rot += p.vr
        const x = p.x + Math.sin(t * 0.8 + p.ph) * p.amp
        if (p.y > h + 14) Object.assign(p, spawn(true))
        ctx.save()
        ctx.translate(x, p.y)
        ctx.rotate(p.rot)
        ctx.fillStyle = `rgba(${p.c}, ${p.a})`
        ctx.beginPath()
        ctx.ellipse(0, 0, p.s, p.s * 0.55, 0, 0, Math.PI * 2)
        ctx.fill()
        ctx.restore()
      }
      raf = requestAnimationFrame(draw)
    }

    const onVis = () => {
      cancelAnimationFrame(raf)
      if (!document.hidden) raf = requestAnimationFrame(draw)
    }

    resize()
    window.addEventListener('resize', resize)
    document.addEventListener('visibilitychange', onVis)
    raf = requestAnimationFrame(draw)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', resize)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [on])

  if (!on) return null
  return (
    <canvas
      ref={ref}
      aria-hidden="true"
      data-sakura=""
      className="pointer-events-none fixed inset-0 z-[15]"
    />
  )
}
