# AI 个人工作台 — 长期升级迭代路线图

> 2026-08-26 制定。基于五家头部竞品的系统性调研（Open WebUI 149k★、LobeHub、Cherry Studio 50k+★、AnythingLLM 65k★、Khoj 36k★），对照本项目 v0.1–v0.11 已有能力做差距分析后排出优先级。
> 原则：纯自用、Windows 本地优先、数据不出本机、每阶段结束保持可用。多用户/云同步/移动端继续明确不做。

## 一、调研结论：竞品功能全景 vs 我们现状

| 能力域 | 头部项目做法 | 我们（v0.11） | 差距 |
|---|---|---|---|
| 对话 | 多模型并行/对比、追问建议、分叉、消息编辑、上下文压缩(/compact)、消息队列(流式中可排队)、引用其他会话作上下文、临时会话 | ✅ 全有，除上下文压缩/队列/跨会话引用 | 小 |
| RAG | 双路召回+精排、agentic 检索工具、# 文件命令、全上下文模式、嵌套目录 KB、增量目录同步 | ✅ 大部分有；缺 # 命令与全上下文模式 | 小 |
| 记忆 | Open WebUI/LobeHub：结构化白盒记忆、模型自主读写、可编辑 | ✅ 同级 | — |
| 笔记 | OWU Notes：富文本编辑器、笔记内嵌完整对话、笔记作为对话上下文注入、模型自主读写笔记 | 部分：md 编辑+AI 动作+RAG 索引；缺笔记内对话/选区改写 | 中 |
| 提示词 | 库 + 变量 + 斜杠命令 | ✅ 同级 | — |
| 自动化 | Khoj Automations / OWU Automations：自然语言创建定时任务→跑 prompt→结果回传邮件或日历；OWU 日历+RRULE 循环 | 仅每日摘要固定任务 | **大** |
| 工具/MCP | MCP + OpenAPI 工具服务器 + 进程内 Python 插件（Filter/Action/Pipe） | MCP(stdio/sse) + 内置工具 | 中 |
| 多模态 | 图片生成(DALL·E/Gemini/ComfyUI)、图片编辑、语音输入输出、OCR | 无 | **大** |
| 数据接入 | oikb 45+源同步(GitHub/Notion/Confluence)、Web 剪藏、Obsidian 插件 | 手动上传+URL剪藏 | **大** |
| 评估 | OWU Arena/ELO 模型竞技场；业界 RAGAS 四维指标（忠实度/答案相关性/上下文精度/召回） | 👍👎 反馈原始数据 | 中 |
| 桌面化 | OWU desktop(Tauri+全局快捷键+截图)、AnythingLLM 单文件应用、Khoj Mini 快捷问 | 浏览器标签页 | 中 |
| 安全备份 | Cherry: WebDAV 备份+定时备份 | 无备份方案 | **大** |

关键洞察：
1. 头部项目 2026 年的重心已从"聊天"转向 **Agent 编排**（定时任务、日程管理、多智能体协作）——个人工作台的下一站是"7×24 替你干活"，不是更好的聊天框。
2. RAG 管道本身已卷完（我们已是标准形态），竞争点在**数据接入广度**和**效果可度量**。
3. Cherry Studio 的"选中助手"（任意应用划词呼出浮动工具栏）是桌面场景最高频刚需，浏览器形态做不了，是 pywebview 壳的核心卖点。
4. 所有头部项目都强调**备份**——本地单机 SQLite+vault 一旦损坏全丢，这是我们的真实风险。

## 二、路线图

### V1 稳固期（把已有功能做到日用可靠）

**V1.1 上下文压缩 + 会话管理增强** ✅ 2026-08-26
- [x] 超长会话自动压缩：超过阈值时用小模型把早期历史压缩为摘要注入（OWU Context Compaction 同款）
- [x] 流式响应中允许排队下一条消息（OWU Message Queue）
- [x] 会话重命名入口（现在只有自动标题）

**V1.2 RAG 易用性** ✅ 2026-08-26
- [x] 输入框 `#` 命令：临时指定某个文件进上下文（OWU 同款）
- [x] 全上下文模式：短文档直接整篇注入不切块
- [x] vault 全文关键词搜索页（复用全局搜索 LIKE 方案搜 md 文件内容）

**V1.3 备份与数据安全** ✅ 2026-08-26
- [x] 一键导出：vault + data/*.db + config.json 打包 zip
- [x] 定时自动备份到本地目录（APScheduler 已有基建），保留最近 N 份滚动
- [x] 设置页显示备份列表 + 手动恢复提示

**V1.4 记忆系统升级（automemory + 相关性召回）** ✅ 2026-08-30
- [x] 自动记忆（Khoj automemory 同款）：每轮对话结束后模型自主判断是否有值得记住的持久事实并保存（设置页开关，默认关）；对话内提示条展示新记忆
- [x] 相关性召回：记忆超过阈值（8 条）时按当前问题做向量排序，只注入最相关的 top-5，不全部灌入
- [x] 语义去重：保存时与已有记忆做 embedding 相似度比对（≥0.92 拒绝），杜绝同义反复
- [x] 记忆可编辑：设置页每条记忆可原地修改；新增 source 标记（🤖 自动 / 手动）

**V1.5 Notes 深化（选区改写 + 笔记内对话）** ✅ 2026-08-30
- [x] 选区改写：编辑器选中一段文字 → 浮动操作条（润色/扩展/精简/译英/自定义指令）→ 流式改写预览 → 确认后替换选区（Cherry/OWU 同款体验）
- [x] 笔记对话面板：编辑器右侧可开合侧栏，基于当前笔记全文问答（带最近 6 轮上下文），回答可一键插入光标处或复制
- [x] /api/notes/ai 扩展 rewrite/chat 动作；prompt 组装抽取为可测纯函数（上下文/历史轮数/字数封顶）

### V2 自动化期（对标 Khoj Automations / OWU Automations，最大差距项）

**V2.1 自定义定时任务** ✅ 2026-08-27
- [x] tasks 表：name/prompt/schedule(cron)/model_id/last_run/enabled
- [x] 到点用指定模型跑 prompt → 结果存为会话消息 + 可选写入 vault/tasks/（自动入索引）
- [x] 自然语言建任务："每天早上8点帮我总结知识库新增内容" → 解析成 cron（模型输出 JSON + cron 二次校验）
- [x] 设置页任务管理 UI（增删改/立即运行/查看上次结果）
- [x] 仪表盘显示任务下次运行时间

**V2.2 RAG 效果评估集**（RAGAS 思路简化版，不用重型框架）✅ 2026-08-27
- [x] eval_sets 表：question / expected_source（期望命中的文件）/ note
- [x] 批量跑评估：对每个问题执行检索，报告命中率(MRR/Hit@k) + 用 LLM 判答案忠实度(0-5)
- [x] KB 页「评估」tab 展示分数趋势，调参(rerank开关/top_k)前后可对比

**V2.3 Agent 编排：自主任务 + 任务链 + 文件触发** ✅ 2026-08-30
- [x] 任务双模式：simple（单轮指令）| agent（多步自主工具循环，轮数预算 1-30，每任务独立工具白名单）
- [x] task_runs 执行日志：每次运行的工具调用/参数/结果落库，设置页展开回放（每任务保留 20 条）
- [x] 任务链（管道式）：chain_next_id 声明下游，产出经 vault/tasks/handoff/ 交接（可人工干预），深度上限防环
- [x] 文件变化触发：监听 vault 内指定目录/文件，新增或修改自动跑任务；90 秒冷却 + 自写不自触
- [x] 无人值守加固：失败自动重试（0-3 次）+ 失败邮件通知（复用 SMTP）

### V3 多模态期

**V3.1 图片生成**
- [x] 内置 image_gen 工具：接 DashScope wanx 或 OpenAI 兼容 images API（provider 可配）
- [x] 对话中生成图片内联展示，存 data/images/
- [x] Notes 页配图插入

**V3.2 视觉理解**
- [x] 聊天输入支持贴图（qwen-vl / gpt-4o 类视觉模型）
- [x] OCR 入库：paddleocr 或 pymupdf 直接抽扫描 PDF（Khoj rapidocr 方案兜底）

### V4 桌面化期（pywebview 壳，解锁浏览器做不到的能力）

**V4.1 原生窗口** ✅ 2026-08-28
- [x] pywebview 启动独立窗口（Edge WebView2），替代浏览器标签页
- [x] 全局快捷键呼出快速提问窗（对标 Khoj Mini / OWU Spotlight bar）
- [x] 系统托盘：常驻后台 + 快捷菜单（新对话/打开笔记/退出）

**V4.2 划词助手**（Cherry Studio 选中助手同款，桌面化后的招牌功能）✅ 2026-08-29
- [x] 全局热键捕获剪贴板选中文本 → 浮动小窗 → 翻译/解释/总结/自定义 prompt
- [x] 结果一键复制回原处

### V5 数据接入期（长期演进）

**V5.1 Obsidian + GitHub 仓库** ✅ 2026-08-29
- [x] Obsidian vault 直连：vault 目录本来就是 md，写一篇《用 Obsidian 打开 vault》指南即可零成本兼容
- [x] GitHub 仓库索引：clone 后按文件入库（对标 oikb 的 GitHub 源）

**V5.2 订阅与推送** ✅ 2026-08-29
- [x] RSS 订阅 → 每日摘要任务联动（V2.1 任务系统的第一个杀手级用法）
- [x] E-mail 摘要推送（Resend 或 SMTP）

**V5.3 本地目录接入** ✅ 2026-08-30
- [x] 注册 vault 之外的本地文件夹（绝对路径）进 RAG：文档/源码/文本，`dirs/名称/` 命名空间与 vault 区分，vault 全量重建不误删
- [x] 实时监听：watchfiles 单线程看护全部已启用目录，文件增改自动重索引、删除自动清块；目录配置变更自动重建监听集
- [x] KB 页「本地目录」tab：添加/同步/启停/移除（停用与移除只清索引、绝不动用户文件）；防呆校验（绝对路径、目录存在、不与 vault 重叠、不重复）

### 明确不做（维持原判）
账号体系、云同步、多人协作、移动端、语音实时通话、IM 网关集成。

### V6 能力沉淀期（Skills + 可观测，基于 2026-08 竞品二轮调研）

**V6.1 Skills 技能系统** ✅ 2026-08-30
- [x] SKILL.md 指令包规范：`skills/` 目录按文件夹发现（frontmatter：name/description/model/tools），不进 RAG 不污染检索
- [x] 对话注入技能索引（何时使用一句话），模型判断相关后经 `skill_load` 工具自主加载全文执行（对标 Open WebUI Skills / Cherry）
- [x] 从 GitHub SKILL.md URL 一键安装（blob/raw 均可），支持覆盖、校验 description 必填
- [x] 设置页「技能」管理区：列表/查看全文/删除

**V6.2 任务可感知闭环（对标 Cherry 任务胶囊 / Langfuse 用量）** ✅ 2026-08-30
- [x] token 用量捕获：llm 层 OpenAI stream_options/Anthropic usage 双协议采集（provider 不支持时自动降级），消息与任务运行双双落库
- [x] 任务运行状态可见：任务列表/卡片显示「运行中…」徽章
- [x] Windows 桌面通知（winotify）：自动任务失败必通知、智能体任务完成通知，prefs 可关
- [x] 仪表盘可观测升级：Token 总用量卡片、近 7 天 token 用量曲线、任务 30 天成功率（复用 task_runs，不引 Langfuse 重栈）

**V6.3 记忆开放为本地 MCP server** ✅ 2026-08-30
- [x] `app.mcp_server`：stdio MCP 服务（mcp SDK 2.x MCPServer），暴露 memory_list/add/update/delete 四个工具，复用 app.core.memory（语义去重同步生效），与工作台共享同一份 workbench.db
- [x] 设置页记忆区提供一键复制接入片段（Claude Desktop / Cursor 等客户端），mem0 转托管后的本地优先空档补位
- [x] 真实 stdio 冒烟：子进程拉起 → list_tools → 增/查/改/删 + 语义去重全链路验证

**V7 睡眠期记忆整理** ✅ 2026-08-30
- [x] `app.core.memory_tidy`：按 embedding 余弦 ≥0.86 聚类近似重复记忆（低于保存时 0.92 去重阈值，专抓跨会话表述漂移），union-find 分簇
- [x] 每簇交模型裁决：`{"action":"merge","content":…}`（仅允许用原句信息合并）/ `{"action":"keep"}`；解析失败或调用异常一律跳过不动数据
- [x] 合并落地：簇内最老 id 原地更新（引用稳定），其余删除并向量缓存失效；单轮最多 20 簇控制开销
- [x] 调度：共享 APScheduler 每日凌晨（默认 03:30，prefs 可配），设置页开关；GET/POST `/api/settings/memories/tidy` 状态查询 + 立即整理
- [x] 报告持久化 `data/memory_tidy.json`，设置页显示上次整理结果与合并明细
- [x] 12 个离线测试（聚类/合并/保留/异常跳过/无 provider/嵌入失败降级/报告持久化/调度接线）+ 冒烟验证调度真实注册

**V8 本地语音输入** ✅ 2026-08-30
- [x] `app.core.asr` + `app.routers.asr`：faster-whisper（CPU int8）本地转写，音频不出本机；模型懒加载常驻，tiny/base/small/medium 可选（默认 small）
- [x] `POST /api/asr/transcribe` 接收 MediaRecorder webm/opus（PyAV 解码），25MB 上限、空文件 400、坏包 502、未装依赖 503；临时文件用完即删
- [x] 国内网络开箱即用：未设 HF_ENDPOINT 时自动走 hf-mirror.com 并禁用 Xet（实测直连超时、镜像 Xet 401 后固化）
- [x] 聊天输入框旁 🎤 按钮：点按录音/停止 → 自动转写进输入框，录音红点脉冲 + 转写等待态；说话语言偏好（自动/中/英/日）
- [x] 实测 LIVE PASS：Windows SAPI 合成中文语音 → tiny 模型完整转写（模型缓存后 4.8s）；10 个离线测试 + HTTP 冒烟

**V9 截图问答** ✅ 2026-08-30
- [x] 📷 截屏按钮：getDisplayMedia 选屏/选窗 → 抓一帧 PNG → 走既有图片附件链路（视觉模型 image_url 块），取消选择不报错
- [x] 本地 OCR 兜底：`POST /api/images/ocr`（复用 RapidOCR 引擎，0 下载），图片 chip 悬停 🔍 一键把图中文字提进输入框 — 无视觉模型的纯文本模型也能问答截图
- [x] 实测 LIVE PASS：真实截图图（PIL 生成）本地 OCR 完整读出三行文字；qwen-vl-plus 经 image_url 块答出图中编号
- [x] 6 个离线测试（真实引擎跑 PIL 文字图）+ HTTP 冒烟（上传→OCR→守卫）

**V10 语音播报 TTS** ✅ 2026-08-30
- [x] 选型调整（弃 Kokoro）：edge-tts 微软神经音色为主（中文自然度高、零模型下载；文本本就要出网给 LLM，信任边界不变）+ Windows SAPI 本地兜底（零依赖、断网可用）— 实测 edge 偶发抖动时回退真实生效
- [x] `app.core.tts` + `POST /api/tts`：内容哈希缓存（data/tts/）、5000 字上限、edge 失败自动切 SAPI；`GET /api/tts/audio/{name}` 带文件名白名单
- [x] 前端：悬停 AI 回答点 🔊 播报/停止；prefs `tts_auto` 开启后回答完成自动朗读（对比模式除外）；设置页音色/引擎/自动朗读
- [x] 9 个离线测试（SAPI 真实合成、回退、缓存键、校验）+ HTTP 冒烟（SAPI 全链路免网络）+ edge 网络 livetest

**V11 知识图谱 RAG（Neo4j）** ✅ 2026-08-30
- [x] 选型落地：图谱存用户本机已有的 Neo4j（Bolt 接入，标签 KgEntity/KgFile 隔离），不引 LightRAG 框架；检索用「客户端向量匹配实体 → Cypher 一跳扩展」双层结构，兼容 Neo4j 4.x/5.x（个人规模无需服务端向量索引）
- [x] 抽取：每文件一次 LLM 调用产出实体/关系 JSON（严格解析 + 关系仅指向已知实体 + 类型白名单防注入），按内容哈希增量构建、单轮上限可续
- [x] `app.core.kg` + `/api/kg`（status/config/build/query/clear），实体描述向量化存节点；连接测试真实暴露 Neo4j 错误（含密码错误 502）
- [x] 聊天集成：勾选知识库检索时叠加图谱上下文块（实体+关系），off/断连时静默跳过，绝不阻塞对话
- [x] KB 页「知识图谱」tab：连接配置 + 状态计数 + 增量构建 + 检索测试 + 清空
- [x] 14 个离线测试（假图接缝）+ 冒烟用真实 Neo4j 验证错误路径 + livetest_v11.py 快乐路径（需在界面填密码后运行）

**V12 笔记 → 双人播客** ✅ 2026-08-30
- [x] 选型落地：LLM 按笔记写 host/guest 对话脚本（JSON turns，禁编造材料外事实），逐句用 V10 edge-tts 合成（两种音色=两个角色，逐句哈希缓存复用），PyAV（faster-whisper 附带）解码重采样 → 加呼吸间隙拼成单个 24kHz WAV——零 ffmpeg 依赖
- [x] `app.core.podcast` + `/api/podcast`（list/generate/audio/delete）：data/podcasts/ + index.json 存元数据与文稿（不进 vault、不污染 RAG），文件名白名单、40 轮/单句 400 字/输入 15000 字上限
- [x] 笔记页 🎙 播客侧栏：当前笔记一键生成（约 1-3 分钟）、主持人/嘉宾音色可选（默认跟随设置页）、历史列表 + 内嵌播放器 + 文稿查看 + 删除；设置页双音色偏好
- [x] 19 个离线测试（脚本解析健壮性、PyAV 解码/拼接时长、全流程假接缝）+ HTTP 冒烟 + livetest 真实链路（qwen 写 13 轮脚本 76s，产出 109s/5MB WAV，内容忠于笔记）

**V13 Artifacts 轻执行环境** ✅ 2026-08-30
- [x] opt-in 边界：默认关闭，设置页勾选「允许运行 AI 代码」后生效；单用户桌面场景下（Windows 无真沙箱）以开关为同意边界，代码在本机直接执行——与 Open Interpreter 同类取舍，已在设置页明示风险
- [x] `app.core.artifacts` + `/api/artifacts`（status/run）：每次运行独立临时目录（失败保留供排查）、子进程硬超时（1-120s 可配）、单流输出 200KB 截断、代码 30000 字上限；Python 用工作台自带 venv（模型代码可直接用其依赖），JS 用本机 node（无则报错），HTML 不进后端——前端 sandbox iframe 预览
- [x] 前端 CodeBlock：按代码块语言出「▶ 运行」（python/js）或「▶ 预览」（html，allow-scripts 沙箱），结果面板显示退出码/耗时/输出；设置页开关 + 超时配置
- [x] 13 个离线测试（真实子进程：成功/异常/超时击杀/输出截断/目录隔离与清理/js 别名/无 node/校验）+ smoke_v13 全链路 HTTP 冒烟（真实执行，无需单独 livetest）

**V14 智能体协作（确定性模式）** ✅ 2026-08-30
- [x] 选型结论：LobeHub CAO 式自主编排（智能体自行拆任务/互相调用）继续观察——业界形态未稳定且token成本不可控；落地其中成熟的部分：确定性编排，两种模式——「流水线」（2-4 个智能体依次接力，各自人设与模型独立）与「评审回路」（A 起草 → B 评审 → A 修订终稿）
- [x] `app.core.collab` 纯编排核心：步骤规划、分步提示词组装、RAG 上下文注入（检索一次全步共享）、逐步 SSE 事件流（meta/delta/sources/error/done，错误标注失败步骤且流正常收尾）；工具调用刻意关闭（协作已放大 token 成本）
- [x] `POST /api/agents/collab`：目标存为用户消息、完整协作文稿（头部+各步标题+产出）存为助手消息，会话内可继续追问；复用智能体预设的模型/persona
- [x] 前端：输入框旁 👥 弹层（模式切换、智能体多选、以输入框内容为目标），流式渲染为一条带步骤标题的消息
- [x] 19 个离线测试 + smoke_collab（守卫+SSE 错误路径）+ livetest_collab 真实两智能体评审回路（qwen3.7-plus，35s 三步，文稿落库）；期间修复三个真 bug：修订步误用评审输出当初稿、resolve 失败无 done 收尾、ResolvedModel 解包

**V15 播客深化：多笔记合并 + 每日简报自动转播客** ✅ 2026-08-30
- [x] 多笔记合并：播客面板来源从单篇升级为可增删的笔记 chips（上限 5 篇，后端本就支持，纯 UI 补齐）；生成按钮按所选篇数确认
- [x] 每日简报播客：`podcast.generate_from_blocks` 重构出预收集文本入口（绕开笔记路径校验），`from_digest` 包装（默认标题「笔记简报 · 日期」），digest 定时任务成功后按 opt-in 偏好自动转播客——失败仅记日志绝不影响摘要/邮件
- [x] 设置页：每日摘要行下新增「摘要生成后自动转为一期双人播客」勾选（需先开摘要）；成片出现在笔记页播客列表
- [x] 25 个播客离线用例（新增 6：from_blocks/from_digest/钩子守卫）；smoke_podcast_daily（prefs 往返，防 _DEFAULTS 过滤丢键）+ livetest_digest_podcast 真实链路（简报→15 轮/120s WAV，自动清理）

**V16 播客生成进度流式反馈** ✅ 2026-08-30
- [x] 动机：1-3 分钟生成期只有一个静态「生成中」，是最差等待体验；重构 generate_from_blocks 为进度迭代器（stage: script → tts×N → assemble → done 终态），generate/from_digest 包装消费、行为不变（摘要转播客走后台无需进度）
- [x] `POST /api/podcast/generate/stream` SSE 端点：路径校验在流开前 400 快速失败，运行中失败以 done{ok:false} 终态收尾
- [x] 前端：生成按钮实时显示「写脚本中 → 配音 3/17 句 → 拼接音频」；顺带加了主持人/嘉宾音色相同时的对话感提醒
- [x] 27 个播客离线用例（新增 2：事件序列/终态）+ smoke_podcast_stream（校验快失败+SSE 错误路径）+ livetest_podcast_stream 真实链路（107s 收到 script→tts×17→assemble 完整序列，117s 音频，自动清理）

### V17+ 换轴：从「对标补能力」到「围绕真实场景做闭环」

V1–V16 的对标项全部完成，观察池也清空了——按竞品清单补能力这条路走到头了。但 agent 工作日志记录了一个更要紧的问题：**完成度与启用度的断崖**。13 个新阶段全部测试通过，可 `config.json` 里 kg / tts / podcast / artifacts / dirs 全部未配置，`skills/` 空，`data/podcasts/` 一次都没生成过。

所以北极星回到原文：「不做功能最全的 AI 聊天器，做会自己长大的、只属于一个人的系统」。V17 起的衡量标准不是功能数，是**两周后还在不在每天打开它**。

**V17 复习闭环（SM-2 间隔复习）** ✅ 2026-09-03
- [x] `cards` / `card_reviews` 两张表（Anki 的 cards/revlog 拆分）：调度状态就地更新，历史完整留存以便日后换 FSRS
- [x] `core/cards.py`：`schedule()` 是纯函数且返回**秒偏移**而非时间点，所以每条排期规则都能用整数断言测；答错的新卡不扣 ease（实测发现的真 bug）
- [x] AI 出卡：SSE 流式（reading→drafting→dedup→done），四种卡型偏重 scenario/debug（「做得出来」而非「背得出来」），候选**必须**经预览勾选才入库
- [x] 复习页全键盘：空格翻面、1-4 评分、H 提示、E 编辑、O 跳原文、S 搁置、U 撤销；答错的卡本节内客户端重排（零定时器）
- [x] 零柒每日到期提醒 + 每周薄弱来源补讲写回 vault（错 → 补 → 再考闭合）
- [x] 48 个离线用例 + `smoke_cards.py` 全链路 HTTP 冒烟

**V18 卡片供给 + 「今日」页与习惯打卡** ✅ 2026-09-04
- [x] 动机：V17 落地后库里只有 6 张验证用卡，而唯一的建卡入口挂在一个已耗尽的模型配额上——要养成每日习惯的功能不能有这种单点依赖
- [x] **零 LLM 建卡三条路**：CardMaker 加 `AI / 手写 / 取材` 三模式（复用原有的候选列表→勾选→入库机器）；笔记页选区浮动条加「🎴 挖空」；取材面板可从任意已索引文件取正文再挖空
- [x] 挖空算法 `make_cloze()` 放后端并出成 `POST /api/cards/cloze`——后端有 265 个用例、前端零测试框架，逻辑放 Python 才是被测到的逻辑；块→行→自适应窗口三级退化，线索不足时返 None 而不是造一张答不了的卡
- [x] 第三个出卡入口 `repo:` / `dir:`（`:` 在 Windows 文件名里非法，所以永远不会遮蔽真实 vault 路径）；`GET /api/cards/sources`、`GET /api/cards/material`
- [x] `habits` / `habit_logs` 两张表：`day` 存**本地日期字符串**（唯一索引 (habit_id, day) 使重复打勾天然幂等），`streak()` 按周几感知、昨天仍算活着、`today` 作为参数传入所以测试不依赖时钟
- [x] **第一个习惯「今日复习」从 `card_reviews` 自动打勾**——格子第一天就不是空的，绕开杀死了本项目每个 opt-in 功能的空列表冷启动
- [x] `review.html` 升级为「今日」页：概览阶段 = 复习行 + 习惯格子 + 30 天热力格，⏎ 开始复习、1-9 打勾、A 添加；`Phase` 删掉 `'empty'` 而不是加成员，让 `tsc -b` 报出每处漏改
- [x] 零柒把两件事合成一句话说完（不新增 job）；仪表盘复用第五张卡的副标题（不加第六张）
- [x] **不新增任何 prefs 开关**，`SettingsPage.tsx`（2798 行）一行未改——本项目的病是开关多而启用少
- [x] 23 个习惯用例 + 18 个新卡片用例（共 265 个）+ `smoke_habits.py` / `smoke_cards.py` 冒烟 + Playwright 端到端（划词建卡 → 复习 → 自动打勾闭环）

**V19 素材供给：让牌组能持续长**

动机是算得出来的。V18 结束时牌组 33 张，`cards_new_per_day` 是 20，所以新卡**两天就出完**，第 3 天起变成纯复习 33 张、每天 2 分钟——习惯不是死于负担，是死于没有新东西。`PLAN.md` 的 changelog 已经挖过一遍，剩下的是竞品调研，出卡价值低。所以下一步的问题只有一个：**第 4 天之后的材料从哪来。**

核心复用：V18 的「取材」正文面板已经是一个通用的卡片工厂（把文字放进面板 → 选中 → 挖空）。这一期不新增第二套 UI，只新增**把材料送进那个面板的方式**。

- [ ] **a. `🔍 检索` 模式**（CardMaker 第四个 pill）
  输入一个你真想弄清楚的问题 → `POST /api/kb/search`（现成，`kb.py:60`）→ 命中列表（`title` / `source` / `score` / 片段前 120 字）。每条命中两个动作：「载入片段」把 chunk 文本送进面板，「载入整篇」走 `GET /api/cards/material`。之后 🎴 挖空 或 🤖 就这段出卡，全是现成路径。这把 RAG 从「只有生产没有消费」变成靶向式的卡片工厂
- [ ] **b. 可筛选的文件选择器**
  现在是扁平 `<select>`，一个仓库几百个文件根本选不下去。`GET /api/cards/sources` 加 `q` / `limit`（默认 200）——**筛选必须在服务端做**，否则 monorepo 一个响应几 MB；前端换成「输入框筛选 + 列表」
- [ ] **c. 「已出卡」徽标**
  一条 `SELECT source, COUNT(*) FROM cards GROUP BY source` 挂到选择器和检索命中上。索引 200 个文件之后，没有这个你会反复读同一篇——这是工作流可用与不可用的分界
- [ ] **d. `repos/` ↔ `repo:` 前缀互转收进一处**
  indexer 的 source id 用 `repos/` / `dirs/`，出卡入口用 `repo:` / `dir:`（理由见 V18）。a、b 都要转，现在只在 router 里内联了一次
- [ ] **e. 端到端跑通仓库克隆链路（这条最可能藏坑）**
  `data/repos/` 从来是空的——clone / index / prune 全链路没跑过一个真仓库，这正是「完成度与启用度断崖」的典型位置。计划：克隆一个小仓库 → 索引 → `sources` 里看到 `repo:` 条目 → 取材出卡 → 复习一轮。预期要处理 `MAX_FILES=1500` / `MAX_FILE_BYTES=200_000` 的截断提示、Windows `.git/objects` 只读删除、`is_repo_indexable` 的扩展名白名单

**不做**：从对话出卡（硬边界不变——对话答案是未核验的模型输出，从那里出卡等于把幻觉写进长期记忆）、全库批量自动出卡。

**风险**：检索走 `indexer.search_auto`，会拉起 embedder + reranker，冷启动首次约 6s（`PLAN.md` v0.10 实测），检索按钮必须有等待态。`CardMaker.tsx` 会从 ~420 行涨到约 550——超过 600 就该把 mode 面板拆出去，但这一期先不拆。

**V20 让后台可信（起因：2026-09-04 的一次静默失效）**

动机不是设想出来的。这天发现 `qwen3.7-plus` 的免费额度早已耗尽，而 `_default_model_id()`（`pet.py:60`）取的是 `models[0]`——于是**每一个自动化功能都在往一个死模型上打**：每日到期提醒、每周薄弱来源补讲、每日摘要、零柒早晚问候、自动记忆、图谱抽取。它们全都是 best-effort：`except` 里记一行 stderr 然后咽下去。没有任何地方会告诉你「昨晚那个补讲没写成」。

对一个主张「会自己长大」的系统，自增长机器静默坏掉是致命失败模式。而且这正是「完成度与启用度断崖」的一部分——有些功能不是没做，是做完之后从来没成功跑过一次，而没人知道。

- [ ] **a. 模型健康探测**（约 1 小时，单独就能防住这天的问题）
  `POST /api/settings/providers/{id}/probe`：对该 provider 的每个模型各打一次 1-token 请求，返回逐模型状态（可用 / 403 额度耗尽 / 404 不存在 / 连不上）。设置页每个 provider 一个「测一下」按钮 + 逐模型徽标。结果带时间戳缓存进 `config.json` 的 `provider_health`
- [ ] **b. `job_runs` 表 + 调度器自动记录**（约半天，防住这一类问题）
  `job_runs(job_id, started_at, seconds, ok, message)`。关键设计：在 `core/scheduler.py` 的 `set_daily` / `set_cron` 里包一层 wrapper，**现有 8 个 job 一行不改**就全部被记录（照 V18 的纯追加纪律）。每个 job_id 滚动保留 20 条（照 `tasks.py` 的 per-task 保留）。`GET /api/health/jobs` 返回每个 job 的 next_run、上次结果、连续失败次数
- [ ] **c. 统一 `_default_model_id()`，并让它跳过已知坏模型**
  这条债必须在这里还：「取第一个**健康**的模型」这个逻辑重复 7 遍（`chat.py:55`、`tasks.py:143`、`ask.py:43`、`notes.py:230`、`images.py:113`、`digest.py:23`、`pet.py:49`，后两个还绕过 ORM 用裸 sqlite3）必然漂移。收进 `core/models.py::default_model_id()` 一处，读 `provider_health` 跳过上次探测失败的模型。**这是唯一有真回归风险的一步**——它动的是 chat 主路径，没有健康数据时行为必须与现在完全一致
- [ ] **d. 今日页一行自检**
  复习行下面一行：`⚙️ 后台 7 正常 · 1 失败（每周补讲 · 模型 403）`，点开看详情。不新增开关、不需要配置——延续 V18 的口径

**V21 生活域其余两块（待办 / 日记）—— 先看一周数据再决定**

待办与日记跟习惯同构（到期项 + 完成动作 + 连续天数），能直接复用 `habits.streak()`、`/today` 的一次性聚合形状、今日页的键盘交互和零柒那条合并提醒。但先不排期：V18 埋了一个可测量的中间指标——

```sql
SELECT origin, COUNT(*) FROM cards GROUP BY origin;   -- origin='manual' 才是成绩
```

2026-09-11 复核。如果自己手工/划词建的卡还是只有播种时那几张，说明复习不是这台机器要的每日钩子，那时正确的动作是换方向而不是继续加模块。

### 观察池（二轮调研新增，暂不排期）
- 截图问答（框选标注 → OCR/视觉模型，桌面专属差异化）→ ✅ 已做（V9）
- Artifacts 轻执行环境（opt-in）→ ✅ 已做（V13）
- 多智能体协作（LobeHub CAO，业界实测尚不成熟，等形态稳定）→ 确定性两模式已做（V14），自主编排继续观察
- **Artifacts 代码判题**（代码卡真跑测试判对错——Anki 永远做不到的事）→ 2026-09-04 决定继续搁置，两周后按实际使用情况再议。前置条件是先还 Artifacts 的安全债：Windows 下无真沙箱，AI 生成的代码能访问 `vault/` 和 `data/`，设置页那个开关只是「同意边界」不是「隔离边界」，所以要先加运行日志审计 + 工作目录隔离。**但 80% 已经白拿**——答案里的围栏代码块本来就带 ▶ 运行按钮（`CodeBlock.tsx:52`），走已有的同意边界、不参与评分、不污染 SM-2 的 ease

### 明确不做（维持原判）
账号体系、云同步、多人协作、移动端、语音实时通话、IM 网关集成。

## 三、排期依据

- V1 全部是小改动（每项 ≤ 半天），先还体验债再扩新域
- V2 是与头部项目差距最大的功能域，且 APScheduler/function-calling 基建都在，性价比最高
- V3/V4 依赖外部条件（图像 API key、pywebview 打包验证），放后但提前占位
- 每个 V* 完成后更新 PLAN.md 版本记录，ROADMAP.md 勾掉已完成项并视实际情况重排后续

## 四、竞品参考索引

- Open WebUI features 树：https://docs.openwebui.com/features/ （Chat/Knowledge/Models&Agents/Notes/Calendar/Channels/Automations/Extensibility）
- LobeHub v2 定位：Agent Operator（Agent Groups / Pages / Schedule / Project / Personal Memory 白盒记忆）
- Cherry Studio docs：https://docs.cherryai.com.cn/ （选中助手/绘画面板/翻译面板/WebDAV 备份/定时任务/技能系统）
- AnythingLLM：会议转录总结、桌面听写、划词问答，全部 on-device
- Khoj：Automations 定时任务邮件推送、多客户端(Emacs/Obsidian/WhatsApp)、automemory
- RAG 评估：RAGAS 四维指标 https://docs.ragas.io/ （faithfulness / answer relevancy / context precision / context recall）
