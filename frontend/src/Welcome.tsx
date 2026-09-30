// 对话页迎宾位（方向 6 第十六刀，2026-09-30 自 App.tsx 拆出）：
// 零柒本尊 + 打字机问候（读 petState，拿不到退化纯标题）+ 建议卡（按 RAG 开关分组）。
// 自含组件：两个本地状态 + 两个 effect，无外部依赖注入。
import { useEffect, useState } from 'react'
import { api } from './api'
import { petSprite } from './petFace'

// Landing state: gradient headline + suggestion cards
export default function Welcome({ useRag, onPick }: { useRag: boolean; onPick: (prompt: string) => void }) {
  // 二次元迎宾位：零柒本尊（动画 webp，与挂件同一套资产）+ 它此刻的一句话打字机。
  // 问候读的是 `petState`（挂件/小屋同一份真值），拿不到就退化为纯标题——不硬凑一句。
  const [line, setLine] = useState('')
  const [typed, setTyped] = useState('')
  const reduced =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches

  useEffect(() => {
    api.petState(0, '/').then((s) => setLine(s.line || '')).catch(() => setLine(''))
  }, [])
  useEffect(() => {
    if (!line) return
    if (reduced) {
      setTyped(line)
      return
    }
    setTyped('')
    let i = 0
    const t = setInterval(() => {
      i += 1
      setTyped(line.slice(0, i))
      if (i >= line.length) clearInterval(t)
    }, 55)
    return () => clearInterval(t)
  }, [line, reduced])

  const suggestions = useRag
    ? [
        { icon: '📚', title: '总结我的笔记', prompt: '帮我总结知识库里关于项目架构的要点' },
        { icon: '🔍', title: '找一段记不清的内容', prompt: '我之前记过向量检索的原理，帮我找出来并解释' },
        { icon: '💡', title: '基于笔记出主意', prompt: '根据我的读书摘录，给我列一个可执行的写作计划' },
        { icon: '🧭', title: '知识库里有什么', prompt: '我的知识库里都存了哪些主题的内容？' },
      ]
    : [
        { icon: '✍️', title: '写作助手', prompt: '帮我写一封简短的项目进度同步邮件' },
        { icon: '🧠', title: '头脑风暴', prompt: '给我 5 个提升个人知识管理效率的思路' },
        { icon: '🔧', title: '解释代码', prompt: '用通俗的语言解释什么是 RAG（检索增强生成）' },
        { icon: '📋', title: '做计划', prompt: '帮我制定一个两周的 Python 进阶学习计划' },
      ]

  return (
    <div className="flex flex-1 flex-col items-center justify-center px-4 pb-16">
      <img
        src={petSprite('idle')}
        alt=""
        className="pet-idle mb-1.5 h-24 w-24 animate-slide-up object-contain drop-shadow-md"
        onError={(e) => {
          e.currentTarget.src = '/pet-avatar.png'
        }}
      />
      <h1 className="mt-4 animate-slide-up bg-gradient-to-r from-violet-600 via-fuchsia-500 to-violet-600 bg-clip-text text-2xl font-bold text-transparent dark:from-violet-400 dark:via-fuchsia-400 dark:to-violet-400">
        今天想做点什么？
      </h1>
      <p className="mt-1.5 animate-fade-in text-sm text-neutral-400">
        {useRag ? 'RAG 已开启 — 回答将引用你的知识库' : '直接提问，或打开知识库(RAG)让我引用你的笔记'}
      </p>
      {line ? (
        <p aria-label={line} className="mt-2 animate-fade-in text-sm text-violet-500 dark:text-violet-300">
          零柒：{typed}
          {typed.length < line.length ? <span className="animate-pulse">▌</span> : null}
        </p>
      ) : null}
      <div className="mt-8 grid w-full max-w-2xl grid-cols-2 gap-3">
        {suggestions.map((s) => (
          <button
            key={s.title}
            onClick={() => onPick(s.prompt)}
            className="group rounded-md border border-neutral-200 bg-white p-4 text-left transition-all hover:-translate-y-0.5 hover:border-violet-300 hover:shadow-md hover:shadow-violet-100 dark:border-neutral-800 dark:bg-neutral-900/60 dark:hover:border-violet-500/40 dark:hover:shadow-none"
          >
            <div className="flex items-center gap-2 text-sm font-medium">
              <span className="text-base">{s.icon}</span>
              {s.title}
            </div>
            <p className="mt-1 line-clamp-1 text-xs text-neutral-400 transition-colors group-hover:text-neutral-500 dark:group-hover:text-neutral-400">
              {s.prompt}
            </p>
          </button>
        ))}
      </div>
    </div>
  )
}
