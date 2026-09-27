/** 骨架条（2026-09-27 美化轮）：可预测布局的加载态——替代「加载中…」纯文字。
 *
 *  外部结论（LogRocket / NN/g）：骨架只在**布局可预测**的地方用（仪表盘/清单），
 *  形状要贴近真实内容；shimmer 是动画，`prefers-reduced-motion` 下静止（index.css §I）。
 *  `aria-hidden`：它只是视觉占位，读屏用户不需要知道一根灰条的存在。
 */
export default function Skeleton({ className = '' }: { className?: string }) {
  return <div aria-hidden="true" className={`wb-skeleton ${className}`} />
}

/** 一组骨架行：清单/列表加载时的整块占位（几行灰条，第一行略宽）。 */
export function SkeletonRows({ rows = 3, className = '' }: { rows?: number; className?: string }) {
  return (
    <div className={`space-y-2.5 ${className}`}>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className={`h-4 ${i === 0 ? 'w-3/4' : 'w-full'}`} />
      ))}
    </div>
  )
}
