# 个人工作台 · 计划（2026-09-13 · 更正版）

## 0. 先把上次的错认下来

上一版我把这个产品搞错了三处：

| 错在哪 | 实际是 |
|---|---|
| 当成「A 学习台 / B 每日工作台 / C 作品」**三选一** | **一体**：学习 × 工作 × 成长，同一个人的三面，不是选一个 |
| 整份计划**没有「成长陪伴」这一线** | **零柒是成长陪伴型** —— 它不是配件，是独立一条线 |
| 调研撒到 HF / 魔搭 / 知乎 | **这次只参考 GitHub** |

这一版按更正后的定位重写，调研只用 GitHub。

---

## 1. 定位（更正后）：三线一体

**不是一个功能清单，是一个人的三面。**

| 线 | 是什么 | 代码里的落点 |
|---|---|---|
| **学习** | 把东西搞懂、记住 | `/tutor` · 卡片 `cards.py` · 笔记 · 检索 |
| **工作** | 把东西做出来、交出去 | `/work` · 交付 `deliver.py` · 工作流 `tasks.py` · 事 `threads.py` |
| **成长陪伴** | **陪着你走这条路的那个人** | **零柒 `pet.py`** · 习惯 `habits.py` · 今日 `today.py` |

**关键**：第三线不是装饰，是把前两线**串成人**的那一环。学习与工作产出「事」，成长陪伴产出「**你和这件事的关系**」——做了多少、坚持了多久、变强在哪。

---

## 2. GitHub 调研全景（只参考 GitHub，star 为 2026-09-13 现场抓取）

### 2.1 成长陪伴 —— 你这条线最该看的
| 项目 | ★ | 一句话 | 可借鉴 |
|---|---|---|---|
| **moeru-ai/airi** | 49.1k | 「soul container」，自托管的 AI 陪伴体（灵感是 Neuro-sama） | **人格容器** + RAG + 记忆 + Live2D，一个「有连续性的魂」 |
| **OpenPetsHQ/openpets** | 1.2k | 桌面陪伴平台，宠物 + 插件 + 本地 agent 接入 | **插件 SDK**（权限/配额/存储/计划/命令/面板/事件）+ **隐私边界**（不让 prompt/路径/密钥进台词） |
| MemTensor/memmy-agent | 1.9k | 跨 agent 的「任务连续性」+ 本地记忆中枢 | 陪伴体记得的是**你**，跨工具连续 |
| memodb-io/memobase | 2.9k | 面向 AI 应用的**用户画像**长期记忆 | 画像 ≠ 系统状态 |
| ayangweb/BongoCat | 23.2k | 跨平台互动桌宠 | 桌宠的交互手感 |
| LorisYounger/VPet | 6.8k | 虚拟桌宠模拟器 | 宠物状态机 |

### 2.2 学习
| 项目 | ★ | 一句话 |
|---|---|---|
| **HKUDS/DeepTutor** | 39.4k | **终身个性化辅导**（Lifelong Personalized Tutoring） |
| 24kchengYe/human-skill-tree | 551 | 「人类学习的操作系统」——**技能树**，33 技能 / 800+ 学科，基于 Agent Skills |
| open-spaced-repetition/fsrs4anki | 4.1k | FSRS（现代间隔重复） |
| st3v3nmw/obsidian-spaced-repetition | 2.6k | 笔记内间隔复习 |
| olmps/memo · andymatuschak/orbit | 1.9k / 1.8k | 编程向 / 实验性间隔重复 |

### 2.3 工作台 / 第二大脑（学习与工作的共同地基）
| 项目 | ★ | 一句话 |
|---|---|---|
| tinyhumansai/openhuman | 39.7k | 本地优先的 agent harness |
| siyuan-note/siyuan | 46.3k | 中文 PKM 最佳范本（块级引用 / 双链） |
| logseq/logseq · TriliumNext/Trilium | 44.9k / 37.8k | 大纲 / 树状知识库 |
| codexu/note-gen | 12.8k | 「先捕获，后整理」本地 Markdown |
| reorproject/reor | 8.6k | 本地私有 AI PKM |

### 2.4 习惯 / 成长量化
| 项目 | ★ | 一句话 |
|---|---|---|
| super-productivity/super-productivity | 22.0k | 待办 + 习惯 + 时间追踪一体 |
| iSoron/uhabits | 10.2k | Loop（Android 习惯追踪） |
| **daya0576/beaverhabits** | 1.8k | 自托管习惯追踪，**没有「目标」** ← 与你的「不要债务感」同调 |
| FriesI23/mhabit | 1.6k | 带 smart scoring 的习惯追踪 |

---

## 3. 你三条线现在各到哪（核实过）

| 线 | 厚度 | 证据 |
|---|---|---|
| 学习 | **厚** | `tutor.py` 1494 行、`cards.py` 1293 行、检索 + 评测齐 |
| 工作 | **厚** | `tasks.py` 1038 行、`threads.py` 550 行、交付/决策/对质/复盘 |
| **成长陪伴** | **最薄** ← 结论 | 见下 |

**零柒 现状**（`pet.py`，核实）：
- 设计原则三条写得很清楚：**主动**（不等你问）· **诚实心情**（status 从真实数据算，从不假装）· **克制**（没料就闭嘴）。人格是「极简、克制、靠谱，偶尔冷幽默，不卖萌」。
- **但 `status()` 读的是「系统今天」**：`tasks_done / tasks_failed / notes_today / tokens_today / time_of_day`。**不是「你」**。它知道系统今天跑了几个任务，不知道你这个人最近在往哪走。
- `compose()` 里确实有成长的影子（`cards_due`「连着 N 天」、`habits_due`「还剩 N 个习惯没打勾」）——但用的是**催促口吻**。

**习惯现状**（`habits.py`，核实）：定义 / 每日 log / weekday-aware **streak** / 30 天热力图 / `auto_source="cards"` 自动打勾，已经是一套完整的成长量化。**但** `today.py` 明确把「习惯 / 卡 / 连续天数」三条**封存**了，理由写在注释里：一旦产生「欠着没做」的感觉，就滑回上一版。

> **这就是核心矛盾**：你要零柒是「**成长陪伴型**」，但成长的原始数据（习惯 / 连续 / 复习）**被刻意藏起来了**。宠物没有可看的成长，就只能是状态播报器。

---

## 4. GitHub 给的启发（四条，都能落到你的代码上）

1. **陪伴 = 人格容器 + 连续性**（airi 49k）：零柒已经有「人设 + 记忆」，缺的是**时间上的连续性**——它记得你说过的话，不记得**你变了多少**。
2. **陪伴体可以是「平台」**（openpets 1.2k）：插件 SDK 把「能力」外置（专注计时 / 提醒 / **心情打卡** / 喝水中断 / **虚拟宠物属性**），核心不动就能长出能力。另有一条**隐私边界**：agent 驱动宠物时，**不让 prompt / 代码 / 路径 / 日志 / 密钥进台词** —— 你的零柒现在会把任务名、文件路径说出来，这条值得照抄。
3. **画像 ≠ 系统状态**（memmy 1.9k / memobase 2.9k）：陪伴体该记的是**你**（偏好、节奏、在学什么、在哪卡住），不是「今天跑了几个任务」。你有 `memories` 表（现在 **1 条**）——这是成长陪伴的原料。
4. **成长可视化有现成范式**：humans-skill-tree 的**技能树**、super-productivity 的**一体面板**、beaverhabits 的**无目标习惯**。「无目标」这条与你既有的「不要债务感」完全同调——**成长可以只呈现事实，不呈现欠债**。

---

## 5. 你已拍板的四条（本版据此定）

| # | 问题 | 你的选择 | 含义 |
|---|---|---|---|
| Q1 | 零柒的成长 | **它自己成长（游戏化）** | 零柒有等级 / 属性 / 形态，随你的产出解锁 |
| Q2 | 成长可见性 | **只正面呈现** | EXP **只增不减**；展示「累计 / 达成」，**永不显示「还欠 N 个」** |
| Q3 | 能力扩展面 | **要插件面** | 给零柒一个 openpets 式的插件 SDK |
| Q4 | 先深哪条 | **学习** | 先做学习线，再做零柒游戏化（它是学习成果的接收方） |

**你这四条自己拼出了一个闭环**：学习线产出「掌握度」→ 变成零柒的成长燃料 → 零柒只正面呈现给你。**Q4 先做学习，正好是 Q1 的原料**。

---

## 6. 实施计划

### Track A · 先做：学习线做深

**A1 · 学习地图（不在平铺列表上打转）**
- **你已有什么**【核实·码】：`tutor_sessions` 存了 `(concept, verdict, stuck, aliases, recalled)` 的**时序**；`tutor.concepts()` 已经按 concept 聚过一次（最近自评 + 卡点 + 解没解 + 场次）。
- **缺什么**：**结构与进程**。概念现在是**平铺**的，看不出「哪些真学会了、哪些还卡着、哪些是相邻却没碰过的」，概念之间也没有关系。
- **造什么**：一张**学习地图**——按掌握度分档（**纯派生，不新表**）：`已掌握 / 在学 / 卡住 / 未触及`；概念之间用**共现 + 别名 + 同场会话**连边（复用现有嵌入即可，**不必上图谱**）。
- **对标**：human-skill-tree（551★，「人类学习的操作系统」，技能树）。
- **验收**：一眼看出掌握分布；点一个概念能看到它的邻居和历次记录。

**A2 · 补 v1 的缺口：「按点出卡」** ✅ **已完成（2026-09-13）**
- v1 的 `digest()`（`POST /api/tutor/digest`）已经能把一份材料**拆成「值得单独开一场教学的点」**，但出卡还得回笔记页走老链。**补上「按点出卡」**：卡面只覆盖那一点。
- **验收**：消化一份材料 → 拆点 → 对某一点直接出卡，不离开学页。
- **做法**：出卡链路加 `focus`——`compose_gen_prompt(..., focus)` 在系统提示里明说「**只围绕这一点**出卡，材料里跟它无关的一律不要出」；材料照给（模型得有上下文）。`generate_iter` / `GenerateIn` / `streamCardsGenerate` 一路带下来。学页每个点旁多一个 🃏：可选的草稿面板（勾选 → 入库），**不离开学页**。
- **来源的处理**：有来源文件就从材料取；**粘贴文本拆出的点没有来源文件，就拿这个点本身当材料**（它本来就是一句话）。重复卡默认不勾但留着——和 CardMaker 同一条规矩。
- **测试**：后端 +2（`test_cards.py`：focus 进提示词 / 空 focus 不误伤）· 前端 +2（`stream.test.ts`：focus 进 body / 不带就不发）+3（`TutorPage.test.tsx`：`pointCardBody`）。**916 后端 / 118 前端通过**，`tsc -b` 与 `vite build` 干净。
- ✅ **浏览器实机验证过（2026-09-13）**，走通完整验收路径：消化材料 → 拆出 4 个点 → 对第一点 🃏 出卡（3 张**全部只覆盖那一点**，材料里的 WAL/GIL 内容一张没混进来）→ 入库 → 卡片数 **0 → 3**，提示「入库 3 张」。
- 🐞 **实机抓出并修掉两个单测看不见的 bug**：
  1. **粘贴模式出卡 400**：原设计「拿这个点本身当材料」，而点标题只有十几个字，被后端 `MIN_INPUT_CHARS = 80` 挡掉。**改成材料必须和当初拆点用的是同一份**（粘贴模式用 `dgText`）。连带抽出纯函数 `pointCardBody()` 并补 3 条单测——这条教训值得记：**前端的请求体拼装必须有单测，光测后端提示词不够**。
  2. **拆点后右栏不刷新**：新拆出的点进了建议日志，但「未触及」那一档还是旧的（截图显示 5，库里其实 9）。`runDigest` 补 `refreshRail()`。

**A3 · 掌握度信号（这是给零柒的接口）**
- 用 `verdict`（`got / half / missed`）的**时序**定义成长事件：`half → got → 连续 got` = 一个概念「学会了」。
- 输出成一个干净的派生接口，**Track B 直接消费**。

### Track B · 零柒游戏化 + 插件面

**B1 · 成长模型（诚实，沿用你已有的规矩）**
- **不破的规矩**：`pet.py` 现在写着「honest mood —— status 从真实数据算，从不假装」。成长数值**同样必须来自真实数据**。
- **来源**：学习（A3 的掌握事件）、工作（跑完工作流 / 交付一份）、习惯（打卡）。
- **只正面呈现**（你选的）：EXP **只增不减**；没有任何「扣分」「掉级」「还欠」的呈现。
- 现状对照：`status()` 读的是「系统今天」（`tasks_done / notes_today / tokens_today`）——**这是 Track B 要改掉的核心**：从「系统今天干了什么」变成「**你**走到哪了」。

**B2 · 插件 / 能力面（openpets 范式）**
- `pet_plugin`（能力定义表）+ 一个运行时：**权限 / 配额 / 存储 / 计划 / 事件 / 命令 / 面板**。
- 内置几个先跑通：**专注计时 · 心情打卡 · 喝水提醒**（这三个是 openpets 官方插件的原样范例）。
- **对标**：OpenPetsHQ/openpets（1.2k★，Plugin SDK v3）。

**B3 · 隐私边界（openpets 那条，顺手补）**
- 插件 / agent 驱动零柒时，**不让 prompt / 文件路径 / 密钥进台词**。
- 你现在 `compose()` 会把任务名和 `detail` 直接说出来——**这条要加一层过滤**。

### Track C · 工作线
本轮**不动**。它已经最厚（`tasks.py` 1038 行 + `threads.py` 550 行），留档备将来。

---

## 7. 已定（第二轮，全部拍板）

| # | 问题 | 你的选择 |
|---|---|---|
| 1 | A1 学习地图形态 | **分档列表** |
| 2 | B1 成长数值形状 | **EXP + 等级** |
| 3 | B2 先做的内置插件 | **喝水提醒 · 专注计时** |
| 4 | 起手顺序 | **先 A1 学习地图** |

---

## 8. 第一步：A1 学习地图（可直接开工）

> ### ✅ 状态：已完成（2026-09-13）
> - 后端：`models.DigestPoint`（建议日志表，`create_all` 自动建）· `tutor.start(origin_point_id=…)` 回填已教 · `tutor.learning_map()` + `_untouched_points()` · `GET /api/tutor/map`
> - 前端：`api.tutorMap()` / `tutorStart(..., originPointId)` · `TutorPage` 右栏改成四档列表（已掌握 / 在学 / 卡住 / 未触及），空档不渲染；「未触及」点开即开教并带上 `origin_point_id`
> - 测试：后端 +4（`test_tutor.py`）· 前端 +2（`api.test.ts`）。**916 后端 / 118 前端通过，`tsc -b` 与 `vite build` 干净**
> - 端到端：`GET /api/tutor/map` 实测 200，分档正确（空库四档皆空；灌数据后 `已掌握 asyncio 事件循环 / 在学 SQLite WAL / 卡住 CORS 预检`）
> - ✅ **浏览器实机验证过（2026-09-13）**：四档列表按灌入数据正确渲染（已掌握 1 / 在学 2 / 卡住 1 / 未触及 2），概念可展开、卡点带 `待解 ↳ …`
> - ⚠️ 你现有的 `workbench.db` 还没有 `digest_points` 表——**起一次服务**才会补上（同样会补上 v1 遗留的 `threads` / `thread_items`）。验证时用的是临时库，**真实库一字未动**

### 8.1 素材已经有了【核实·码】
`tutor.concepts()` 已经把这些派生好了，**不新表**：每个概念一行 = **最近一次自评（`verdict`: got / half / missed）+ 卡点 + 解没解（`stuck_resolved_at`）+ 最后时间 + 场次 + 召回次数**。

### 8.2 分档规则（初版，可调）
| 档 | 判定 |
|---|---|
| **已掌握** | 最近 `verdict == got` **且场次 ≥ 2**（一次是运气，两次才算学会） |
| **在学** | 最近 `verdict == half`，或只有一次 `got` |
| **卡住** | 有**未解**的卡点，或最近一次是 `missed` |
| **未触及** | 相邻但没开过教学的概念（见 8.4，唯一待定项） |

### 8.3 动到哪
- **后端**：`core/tutor.py` 加一个纯派生 `learning_map()`（按上表分档，复用现成的 `concepts()` 查询）；`routers/tutor.py` 加 `GET /api/tutor/map`。
- **前端**：`TutorPage.tsx` 右栏现在已有「学到哪了」（概念平铺）——**改成四档列表**。卡点行已有的 `✓ / ↺` 操作保留。
- **原则**：**纯派生、不落库、不新增表**（与 `concepts()` 同一条规矩）。

### 8.4 第四档「未触及」的来源 —— **已定：digest 拆出的点 + 落一张建议日志表**
- 新增 **`digest_points`** 表：`source / point / created_at / taught_session_id`（可空）。
- `digest()` 拆完点就把它们写进去；某一点开成教学时回填 `taught_session_id`。
- **第四档 = `taught_session_id IS NULL` 的点**。
- **规矩不变**：学习状态的**真值仍然只有 `tutor_sessions`**；这张表只是**建议日志**，不参与掌握度判定。
- 三档（已掌握 / 在学 / 卡住）纯派生自 `tutor_sessions`，与这张表无关。

### 8.5 验收
- 学页一眼看出「已掌握 12 / 在学 5 / 卡住 3」的分布；
- 点任一概念展开历次记录与卡点状态；
- 卡住的概念能一键回写为已解（沿用现有 `POST /api/tutor/stuck/{id}/resolve`）。

### 8.6 与 Track B 的接口
A1 分档一旦成立，A3 就有了落点：**「一个概念从 `half` 走到连续 `got`」= 一条成长事件**，直接喂给 B1 的 EXP + 等级。**先做 A1，B1 的原料就准备好了。**

---

## 9. 界面修整：右侧空白 + 拆掉跨模块分栏（2026-09-13）

### 9.1 右侧空白 —— 已修
- **定位**（浏览器实测，不是猜）：右栏**内部**零空白——1024→2560 每一档，栏内内容右边缘都等于栏右边缘（`gapInRail=0`）。
- 真正空出来的是**主内容与右栏之间那条 ~193px 的带**：开场屏的网格写了
  `xl:grid-cols-[minmax(0,1fr)_18rem]`，而第二列那几条动作按钮（深入研究/帮我理清/对质/消化材料）
  只有约 **95px** 宽，却固定占着 **288px**。**1280 以上每一档都空出 193px**。
- **修法**（你选的「让主内容铺满」）：第二列 `18rem` → `auto`，列宽跟着内容走（实测 288px → 117px），
  空带消失（`blankInMain` 在 1280/1440/1920 全为 0）。
- 代价（你已确认）：宽屏下输入框会被拉长（1920 下约 1100px）。

### 9.2 跨模块分栏（SplitPane）—— 已按你的决定拆掉
- **为什么拆**：用得少；且它有个真问题——开侧栏时主区变窄，但页面仍按**窗口**宽度选断点（`xl:`/`lg:`），
  排版与容器宽度不匹配（其自身 docstring 里说 iframe 解决了侧栏那一侧，主区没有对应补偿）。
- **删除**：`SplitPane.tsx` · `split.ts` · `SplitPane.test.tsx` · `split.test.ts`
- **摘除**：`Layout` 直接渲染 `<Outlet/>`；四处只为并排存在的按钮一并去掉——
  笔记页「⧉ 侧栏打开这一篇」「⧉ 侧栏对话」· 工作页「⧉」· 教学页「📚 资料」
  （工作页行标题本来就能打开产出，故直接去按钮、不加替代）；
  `PetWidget` 不再需要 `--aside-w`。
- **验证**：`tsc -b` 干净 · 前端 **96** 例通过（删掉的两个测试文件带走 22 例）· `vite build` 通过 ·
  浏览器实机走完 **9 个路由全部正常、零控制台错误**，笔记页/工作页渲染正常。

---

## 附录 · GitHub 来源（2026-09-13 抓取）

- 检索方式：GitHub **search API**（`sort=stars`）+ `topic:` 精确过滤；README 走 `raw.githubusercontent.com`。搜索配额 10 次/分，core API 60 次/时。
- 陪伴：https://github.com/moeru-ai/airi · https://github.com/OpenPetsHQ/openpets · https://github.com/MemTensor/memmy-agent · https://github.com/memodb-io/memobase · https://github.com/ayangweb/BongoCat · https://github.com/LorisYounger/VPet · https://github.com/Open-LLM-VTuber/Open-LLM-VTuber
- 学习：https://github.com/HKUDS/DeepTutor · https://github.com/24kchengYe/human-skill-tree · https://github.com/open-spaced-repetition/fsrs4anki · https://github.com/st3v3nmw/obsidian-spaced-repetition · https://github.com/olmps/memo · https://github.com/andymatuschak/orbit
- 工作台：https://github.com/tinyhumansai/openhuman · https://github.com/siyuan-note/siyuan · https://github.com/logseq/logseq · https://github.com/TriliumNext/Trilium · https://github.com/codexu/note-gen · https://github.com/reorproject/reor
- 习惯：https://github.com/super-productivity/super-productivity · https://github.com/iSoron/uhabits · https://github.com/daya0576/beaverhabits · https://github.com/FriesI23/mhabit
- 本地核实：`app/core/pet.py`（KINDS / status / compose / greeting）· `app/core/habits.py`（MAX_HABITS / SEEDS / streak）· `app/core/today.py`（封存注释）· `models.py` Habit/HabitLog · `data/workbench.db`（memories 1 条、habits 3 条、habit_logs 1 条）、

---

## 10. Track B 状态：零柒游戏化 + 插件面（2026-09-13 · 已完成）

> ### ✅ A3 · 掌握度信号 —— 已做（B1 的原料）
> - `tutor.mastery_events()`：概念「学会了」的时刻，**规则与学习地图「已掌握」同一条**
>   （`_mastered`：最近一次说通、且不止一场）。带 `from_half`（从半懂到懂）。
> - `GET /api/tutor/mastery`。纯派生、不落库。
> - `end()` 里第一次说通一个概念时，零柒记一句「你把「X」搞懂了」（`_note_first_mastery`，
>   同一概念只触发一次）。

> ### ✅ B1 · 成长模型（EXP + 等级）—— 已做
> - `pet.growth()`：**从「你走到哪了」算**，不是「系统今天干了什么」。来源四条线——
>   学习（已掌握概念 ×30 + 教学场次 ×5）· 工作（跑成的任务 ×12 + 交付成品 ×20）·
>   习惯（打卡日 ×4）· 复习（答题 ×1）。
> - `LEVEL_STEPS` + `LEVEL_TITLES`（初识 / 同行 / 顺手 / …）；**只增不减**（全是累计量），
>   **只正面呈现**（等级 / 称号 / 累计 EXP / 各来源明细，**没有「还欠 N」这种字段**）。
> - `GET /api/pet/growth`；`greeting()` 的提示词主语从「系统今天」改成「你走到哪了」。
> - 前端 `PetWidget` 头部由「今日任务 N✓…」换成「Lv.N 称号 · EXP N · 正在靠近「下一称号」」+ 细进度条 + 来源明细。

> ### ✅ B2 · 插件 / 能力面（openpets 范式）—— 已做
> - `models.PetPlugin`（`name / label / enabled / spec_json / storage_json / quota_json`）。
> - `core/pet_plugins.py` 运行时：**权限 / 配额 / 存储 / 计划 / 事件 / 命令 / 面板**七件套；
>   内置两个 —— **喝水提醒**（cron 到点提醒、面板计数、命令 `drink`）· **专注计时**
>   （命令 `start`/`stop`，到点一次性作业主动说一声）。
> - 计划走现成调度器：`scheduler.set_once()` 新增（一次性作业，迟到也跑）；每个插件一个
>   `pet_plugin_<name>` 作业，无分钟级空转。`reschedule_all` 已挂上。
> - `GET /api/pet/plugins` · `POST /api/pet/plugins/{name}/command` · `PUT /api/pet/plugins/{name}`。
>   前端面板底部多了插件条（💧 计数 +1 / ⏱ 开始·停）。

> ### ✅ B3 · 隐私边界 —— 已做
> - `pet.sanitize()`（纯函数）：剥掉 Windows 盘符 / UNC / 绝对路径 / `~` 路径，以及
>   `sk-` / `Bearer` / 长 hex / base64 / `api_key=` 一类密钥。**URL 与「和/或」不误伤**。
> - `emit()` 的每一句台词都过闸门（模板拼的与模型现写的都算），`detail` 同样过；
>   `/api/pet/say` 回给调用方的就是真正说出口的那句。

**测试**：后端 `test_pet.py` **32**（+15）· `test_tutor.py` **96**（+3）；**全套 56 个文件通过**。
前端 **99** 例通过；`tsc -b` 与 `vite build` 干净。

**实机验证（隔离配方，真实库未动）**：`/api/pet/growth`（Lv.1 初识 · EXP 118，四条来源数与
灌入数据一致）· `/api/tutor/mastery`（2 事件，`from_half` 正确）· `/api/pet/plugins`（两个内置已装）。
浏览器：头部成长行 + 进度条 + 来源明细正确渲染；💧 2→8 杯（第 8 杯弹出「今天第 8 杯，够了。」）；
⏱ 开始 / 停往返正常；**隐私闸门实测**——发一句带 `D:\…\secret.md` 与 `sk-…` 的话，
入库台词为「已处理 [路径]，key=[已隐藏] 记录好了」。**零控制台错误**。

---

## 11. 成长页（2026-09-13 · 已完成）

Track B 之后的一个增量：把「成长」从宠物小面板里独立出来，成为一条能一眼看全的页面
（计划 §4 第 4 条启发「成长可视化」）。**不碰工作线**，纯新增。

- **路由**：`/growth`（`routes.tsx` 的 Module/ROUTES/TITLES + `modules.tsx` + `Layout.tsx` 导航「🌱 成长」）。
- **页面** `GrowthPage.tsx`：等级卡（Lv / 称号 / 累计 EXP / 进度条 / 「正在靠近」）·
  四个来源格子（把东西搞懂 / 把东西做出来 / 坚持 / 复习，各带背后的真实计数）·
  最近搞懂（掌握事件，半懂过来的带「从半懂到懂」）· 坚持（连续 + 累计，**不写「连续 0 天」**）·
  最近交出去（产出）。数据全部来自现成接口，**没有新后端**。
- **宠物面板**：头部那行成长数变成 `/growth` 的链接（点开即跳，面板收起）。
- **顺手修掉两个实机才看得见的 bug**：
  1. `/api/usage/visit` 的白名单没有 `growth` → 每次打开成长页都 400（`core/usage.PAGES` 补上；测试改为遍历 PAGES 本身，免得下次加页又漏）。
  2. `pet.growth()["counts"]` 漏了 `outputs` → 工作格子写「交出 0 份」而 exp 却是对的（补齐，并加断言钉住 counts 的 key 集合）。

**测试**：前端 +6（`GrowthPage.test.tsx` 5 例 · `routes.test.ts` 加断言）→ **105** 例 ·
后端 `test_pet` / `test_usage` 各加断言 → **全套 56 文件通过**。`tsc -b` 与 `vite build` 干净。
**实机验证**（隔离配方，真实库未动）：等级卡 / 四来源 / 最近搞懂（含「从半懂到懂」）/ 坚持（连续 4 天、无「连续 0 天」）/ 最近交出去 全部正确；宠物面板链接可达；**零控制台错误**。

---

## 12. 内置插件补齐第三个：心情打卡（2026-09-13 · 已完成）

计划 §B2 里 openpets 官方范例的第三个（当时先跑通了喝水 + 专注）。挂在现有插件面上，未动核心。

- **后端** `core/pet_plugins.py`：`BUILTINS["mood"]`（面板 kind=`mood`，量表 1–5，计划 21:00 问一句）；
  纯函数 `mood_today / mood_set / mood_clear / mood_recent`（只留最近 90 天）；命令 `set` / `clear`；
  `_mood_job`（到点且今天还没记才开口）。`reschedule()` 里 hours 型插件改成 `_HOURLY_JOBS` 表驱动，
  加同类插件只补一行。
- **面板**：宠物面板多一行「🙂 心情打卡 今天 N/5 + 五个表情按钮」，点一下就记下今天。
- **成长页**：多一段「心情」——把最近 14 天记过的日子画成一排（没记过就整段不出现）。
- **立场不变**：心情不做「连续几天没记」这类判定，也不进 EXP——它是自己的记录，不是要维持的指标。

**测试**：后端 `test_pet.py` **35**（+3：set/recent/clear/越界、只留最近 N 天、命令落库）·
前端 **107**（+2：心情那一排 / 没记录时不出现）。**全套 56 文件通过**，`tsc -b` 与 `vite build` 干净。
**实机验证**（隔离配方，真实库未动）：面板三行插件齐全、今天的高亮正确；点第 5 个表情 → 落库为
`today 5`、`recent` 末项更新；成长页「心情 · 最近 6 天」一排六格；**零控制台错误**。
