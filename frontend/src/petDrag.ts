// 拖拽（P5 · 做活）的算术与持久化（方向 6 第四刀，2026-09-29 自 PetWidget 拆出）。
// React 侧的指针状态机在 usePetDrag.ts；让位测量在 usePetDodge.ts。

// 右下角留白的**唯一真值**（px）。容器定位（style 里的 bottom/right）与让位计算
// 读的是同一个常量——不再有「class 写 5、常数写 20」的手工同步。
export const PET_CORNER = 20

// 精灵的自然大小（xl 档 h-24 w-24；<768px 缩到 h-16 w-16 = 64px，不占 375px 屏的
// 四分之一）。夹紧按较大的 96 算：窄屏上只会让宠物离边更远一点，绝不会推出屏幕外。
export const PET_SIZE = 96

export function clampDrag(dx: number, dy: number, w = window.innerWidth, h = window.innerHeight) {
  return {
    dx: Math.min(PET_CORNER, Math.max(-(w - PET_CORNER - PET_SIZE), dx)),
    dy: Math.min(PET_CORNER, Math.max(-(h - PET_CORNER - PET_SIZE), dy)),
  }
}

export function loadDrag(): { dx: number; dy: number } {
  try {
    const v = JSON.parse(localStorage.getItem('pet:drag') || 'null')
    if (v && typeof v.dx === 'number' && typeof v.dy === 'number') return clampDrag(v.dx, v.dy)
  } catch {
    /* 记不了位置就待在右下角 */
  }
  return { dx: 0, dy: 0 }
}

export function saveDrag(v: { dx: number; dy: number }) {
  try {
    localStorage.setItem('pet:drag', JSON.stringify(v))
  } catch {
    /* 无痕模式记不了就算了 */
  }
}
