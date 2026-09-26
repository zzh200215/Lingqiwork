# 界面设计契约（可执行的那一份）

> 2026-09-24 立。起因：这份契约**一直只存在于对话里**——2026-09-24 做「工作模块前端优化」
> 时，全站按它扫了一遍（字号、卡片阴影、圆角、图标），但仓库里**没有一份能引用的真值**，
> 于是「按契约收口」这件事没有判据、也没法验证。这一页把它落盘，并写清**代码里的落点**。

契约的原文是参考项目（Robot Admin）那份设计说明。下面是它的条款与**本仓库对应的落点**。

---

## 1. 分层：边框，不是阴影

> "The desktop design language is tinted surfaces with restrained boundary borders
> and **no persistent shadows**."
>
> "Shadows are allowed only for modals, drawers, dropdowns, popovers, tooltips,
> or active drag feedback."
>
> 禁止项：**"Persistent shadows on cards, settings panels, tables, toolbars, or navigation."**

**落点**（`frontend/src/index.css`）：

| 类 | 规矩 |
|---|---|
| `.wb-card` | `rounded-lg` + 一圈边框，**没有 `box-shadow`** |
| `.wb-card-hover` | hover 只**强化边框**；不抬升（无 `translateY`）、不加阴影 |
| `.wb-card-hero` | 淡品牌渐变 + 边框，**没有 `box-shadow`** |
| `.wb-chip` | `rounded-md` |

**一处改，全站一起变**——所以分层规矩只写在这四个类里，不要在页面里各写各的。

**允许有阴影的地方**：模态、抽屉、下拉、气泡、tooltip、拖动反馈。判据是「它是不是浮在
别的东西上面」。页面里一个普通卡片**不是**。

---

## 2. 字号：有下限，角色固定

| 角色 | 字号 |
|---|---|
| 元信息 / 小字 | **12px（`text-xs`）——下限定在这里，不许更小** |
| 标签 | 13px（`text-[13px]`，仓库既有一档） |
| 正文 | 14px（`text-sm`） |
| 小标题 | 16–18px |
| 页面标题 | 22px |

**禁止** `text-[10px]` / `text-[11px]` / `text-[9px]`：10px 的中文在 1x 屏上认不出来。

---

## 3. 圆角：三档

`6 / 8 / 10`——即 `rounded-md` / `rounded-lg` / `rounded-[10px]`。

**禁止** `rounded-xl` / `rounded-2xl` / `rounded-3xl`。`rounded-full` 只给**胶囊**（标签、
计数徽章、头像）。

---

## 4. 语义色：一色一义

| 色 | 含义 |
|---|---|
| `sky` | **运行中** |
| `amber` | **等人**（人工卡点 / 待审） |
| `emerald` | **完成** |
| `rose` | **错误** |
| `violet` | **品牌 / 主操作** |
| `teal` | **产出** |

同一屏里同一个意思只用一种色。**改语义色要连 keyframes 一起改**——
`.wb-node-running` 本身不含颜色，颜色在 `@keyframes wb-node-pulse` 里；
只把 `bg-violet-500` 换成 `bg-sky-500` 会得到「蓝点配紫光晕」。

---

## 5. 选中态：中性面，不是品牌色

选中 = **中性面**（`bg-neutral-100` / `dark:bg-neutral-800`）。品牌色留给**主操作、焦点、
链接、真实状态**——用它标「你正停在这一项」会让一屏里出现两个主操作。

---

## 6. 图标：控件里 16px

按钮 / 输入框里的图标 `h-4 w-4`（16px）。纯装饰的大图标不受这条管。

---

## 7. 测试锚点：钉状态，不钉文案

会变的**文案**不许当断言判据；给它一个 `data-*` 锚点。已有的例子：
`data-phase`（`RunPanel` 的六态）、`data-run-panel`、`data-work-err`。

理由：「阶段」是状态、「措辞」是表达。钉文案的结果是改一句中文红一片测试，
而红的理由看起来像功能坏了。

---

## 附：这一页为什么存在

2026-09-24 那次全站扫描**没有可引用的真值**，于是：

1. 扫描本身没法验证（改对了没有，只能靠肉眼看）；
2. 我（AI）在做这次扫描时用**脚本批量替换样式类**，脚本有个 bug
   （映射表只有一项时 PowerShell 把数组压平成字符，`$pair[0]` 退化成单字符 `t`），
   **把三个文件里的 `t` 全换成了 `e`**（`useCallback`→`ustCallback`）——
   详见 `docs/r-checklist.md` 里那条「不许用脚本批量改源码」。

契约落盘之后，这类改动至少有了**可引用的判据**：哪一条、改到哪、怎么验。
