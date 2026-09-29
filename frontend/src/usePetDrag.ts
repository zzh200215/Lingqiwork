// 拖拽（P5 · 做活）的指针状态机（方向 6 第四刀，2026-09-29 自 PetWidget 拆出）。
// 拽着走，松手带一点惯性，撞墙就停。算术与持久化在 petDrag.ts。
//
// 指针事件挂在精灵上（touch-none 免得拖动变成滚动）；位移与「给输入行让位」
// 共用同一套 translate 轴。6px 死区把「点」和「拖」分开；惯性只做衰减不做反弹
// ——弹来弹去像球，不像猫。
import { useRef, useState } from 'react'
import { clampDrag, loadDrag, saveDrag } from './petDrag'

export function usePetDrag() {
  const [drag, setDrag] = useState(loadDrag)
  const [dragging, setDragging] = useState(false)
  const draggedRef = useRef(false) // 拖完那一下 click 是拖拽的尾巴，不是点击
  const rafRef = useRef(0)
  // 惯性滑行要从**最新的**位置接着算：move/up 挂在 window 上，闭包里那个 drag
  // 是按下那一刻的旧值——每次渲染同步一份到 ref，glide 只读这份。
  const dragPosRef = useRef(drag)
  dragPosRef.current = drag
  const dragRef = useRef<{
    sx: number
    sy: number
    bx: number
    by: number
    moved: boolean
    lx: number
    ly: number
    lt: number
    vx: number
    vy: number
  } | null>(null)

  function glide(vx: number, vy: number) {
    const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : null
    if (!raf || Math.abs(vx) + Math.abs(vy) < 0.05) {
      saveDrag(dragPosRef.current)
      return
    }
    cancelAnimationFrame(rafRef.current)
    let { dx, dy } = dragPosRef.current
    const step = () => {
      vx *= 0.9
      vy *= 0.9
      if (Math.abs(vx) + Math.abs(vy) < 0.02) {
        saveDrag({ dx, dy })
        return
      }
      const next = clampDrag(dx + vx * 16, dy + vy * 16)
      dx = next.dx
      dy = next.dy
      setDrag({ dx, dy })
      rafRef.current = raf(step)
    }
    rafRef.current = raf(step)
  }

  function onSpritePointerDown(e: React.PointerEvent) {
    if (e.button !== 0) return
    const d = {
      sx: e.clientX,
      sy: e.clientY,
      bx: drag.dx,
      by: drag.dy,
      moved: false,
      lx: e.clientX,
      ly: e.clientY,
      lt: performance.now(),
      vx: 0,
      vy: 0,
    }
    dragRef.current = d
    // move / up 挂在 **window** 上而不是精灵上：宠物一挪就跑到了指针下面之外，
    // 靠元素收事件的话，抓住一半就断（真机验收撞过：只走到路径第二个点）。
    // 收尾在 pointerup 与 pointercancel 两处（触屏拖出屏幕是 cancel）。
    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - d.sx
      const dy = ev.clientY - d.sy
      if (!d.moved && Math.hypot(dx, dy) < 6) return // 过了死区才算拖，点一下还是点
      if (!d.moved) setDragging(true)
      d.moved = true
      const now = performance.now()
      const dt = Math.max(1, now - d.lt)
      d.vx = 0.7 * d.vx + 0.3 * ((ev.clientX - d.lx) / dt)
      d.vy = 0.7 * d.vy + 0.3 * ((ev.clientY - d.ly) / dt)
      d.lx = ev.clientX
      d.ly = ev.clientY
      d.lt = now
      setDrag(clampDrag(d.bx + dx, d.by + dy))
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      dragRef.current = null
      setDragging(false)
      if (!d.moved) return
      draggedRef.current = true // 松手那下的 click 是拖拽的尾巴，不是点击
      glide(d.vx, d.vy)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }

  return { drag, dragging, draggedRef, onSpritePointerDown }
}
