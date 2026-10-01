import { useEffect, useRef } from 'react'

import type { ParticleKind } from './theme'

const PETAL_COLORS = ['244, 114, 182', '167, 139, 250', '249, 168, 212']
/** 萤火虫的光：核心亮黄绿，外圈靠径向渐变晕出那一捧「萤」。 */
const FLY_GLOW = ['190, 242, 130', '163, 230, 100', '190, 242, 160']

/** 氛围粒子层（对话页个性化）：canvas 画的一层**纯装饰**。
 *
 *  名字叫 SakuraLayer 是历史留下的——它现在管**全部**氛围粒子。画哪种由当前
 *  皮肤的 `particles` 字段决定（装饰是数据，见 `manifest.ts`；流萤皮肤自带
 *  `'firefly'`），🌸 开关只管画不画——款式与开关是两件事，分属两个真相。
 *
 *  按本仓的规矩收敛过：
 *  - **纯装饰**：pointer-events-none、不读接口、不存数据——它只是氛围；
 *  - **respect reduced-motion**（§I）：用户要求减少动态时整层不画；
 *  - **可关**：对话工具栏的 🌸 开关（localStorage `wb:ambience`，默认开）；
 *  - 页签切到后台就停（visibilitychange），回到前台接着动；
 *  - jsdom / 老浏览器拿不到 2d 上下文时安静退化，绝不报错。
 */
export default function SakuraLayer({ on, kind = 'sakura' }: { on: boolean; kind?: ParticleKind }) {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    if (!on || kind === 'none') return
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
    /** 萤火虫：上浮 + 漫游 + 呼吸明灭，每一只自己的大小 / 亮度 / 节奏。 */
    interface Fly {
      x: number
      y: number
      s: number
      vy: number
      amp: number
      ph: number
      breath: number
      ph2: number
      c: string
      a: number
    }
    let raf = 0
    let w = 0
    let h = 0
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    let petals: Petal[] = []
    let flies: Fly[] = []

    const spawnPetal = (fromTop: boolean): Petal => ({
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

    const spawnFly = (fromBottom: boolean): Fly => ({
      x: Math.random() * w,
      y: fromBottom ? h + 8 : Math.random() * h,
      s: 1.2 + Math.random() * 1.6,
      vy: -(0.12 + Math.random() * 0.28),
      amp: 14 + Math.random() * 26,
      ph: Math.random() * Math.PI * 2,
      breath: 0.5 + Math.random() * 0.9,
      ph2: Math.random() * Math.PI * 2,
      c: FLY_GLOW[Math.floor(Math.random() * FLY_GLOW.length)],
      a: 0.45 + Math.random() * 0.4,
    })

    const resize = () => {
      w = window.innerWidth
      h = window.innerHeight
      canvas.width = w * dpr
      canvas.height = h * dpr
      canvas.style.width = `${w}px`
      canvas.style.height = `${h}px`
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      if (kind === 'firefly') {
        // 萤火虫比花瓣稀：它们是**点光源**，密了就成了萤火虫养殖场
        const n = Math.max(6, Math.min(14, Math.floor(w / 110)))
        flies = Array.from({ length: n }, () => spawnFly(false))
        return
      }
      const n = Math.max(8, Math.min(18, Math.floor(w / 90)))
      petals = Array.from({ length: n }, () => spawnPetal(false))
    }

    const drawPetal = (t: number) => {
      for (const p of petals) {
        p.y += p.vy
        p.rot += p.vr
        const x = p.x + Math.sin(t * 0.8 + p.ph) * p.amp
        if (p.y > h + 14) Object.assign(p, spawnPetal(true))
        ctx.save()
        ctx.translate(x, p.y)
        ctx.rotate(p.rot)
        ctx.fillStyle = `rgba(${p.c}, ${p.a})`
        ctx.beginPath()
        ctx.ellipse(0, 0, p.s, p.s * 0.55, 0, 0, Math.PI * 2)
        ctx.fill()
        ctx.restore()
      }
    }

    const drawFly = (t: number) => {
      for (const f of flies) {
        f.y += f.vy
        if (f.y < -10) Object.assign(f, spawnFly(true))
        const x = f.x + Math.sin(t * 0.5 + f.ph) * f.amp
        // 呼吸：亮度绕自己的基准值正弦明灭，每只节奏不同——同起同落就成了灯串
        const alpha = f.a * (0.3 + 0.7 * (0.5 + 0.5 * Math.sin(t * f.breath + f.ph2)))
        const r = f.s * 4
        const g = ctx.createRadialGradient(x, f.y, 0, x, f.y, r)
        g.addColorStop(0, `rgba(${f.c}, ${alpha})`)
        g.addColorStop(1, `rgba(${f.c}, 0)`)
        ctx.fillStyle = g
        ctx.beginPath()
        ctx.arc(x, f.y, r, 0, Math.PI * 2)
        ctx.fill()
        ctx.fillStyle = `rgba(255, 255, 235, ${alpha})`
        ctx.beginPath()
        ctx.arc(x, f.y, f.s * 0.8, 0, Math.PI * 2)
        ctx.fill()
      }
    }

    const draw = () => {
      ctx.clearRect(0, 0, w, h)
      const t = performance.now() / 1000
      if (kind === 'firefly') drawFly(t)
      else drawPetal(t)
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
  }, [on, kind])

  if (!on || kind === 'none') return null
  return (
    <canvas
      ref={ref}
      aria-hidden="true"
      data-ambience={kind}
      className="pointer-events-none fixed inset-0 z-[15]"
    />
  )
}
