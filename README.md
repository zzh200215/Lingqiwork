# AI Workbench

本地优先的 AI 个人工作台。

- 阶段 1：多模型流式对话（FastAPI + SQLite，OpenAI 兼容 + Anthropic）
- 阶段 2：知识库 + 语义检索（watchfiles 监听 vault → bge embedding → ChromaDB）
- 阶段 3：工具调用（内置 vault 工具 + MCP server 接入，模型可执行操作）

## 架构

- 后端：FastAPI + SQLAlchemy(async) + SQLite + ChromaDB
- 前端：React + Vite + Tailwind，SSE 流式渲染
- 检索：本地 sentence-transformers（bge-small-zh-v1.5，离线加载）

## 开发启动

双击 `dev.bat`，或手动：

```bash
# 终端 1 - 后端 (http://127.0.0.1:8000)
cd backend && uv run uvicorn app.main:app --reload --port 8000

# 终端 2 - 前端 (http://localhost:5173)
cd frontend && npm run dev
```

## 使用

1. **设置页**（`/settings.html`）添加 provider：
   - 名称：显示前缀，如 `deepseek`
   - 协议：OpenAI 兼容（deepseek/qwen/moonshot/ollama/openrouter）或 Anthropic
   - Base URL：如 `https://api.deepseek.com/v1`；Anthropic 留空
   - API Key + 模型列表（逗号分隔）
2. **对话**：选模型后聊天，Enter 发送，Shift+Enter 换行，Ctrl 停止
3. **知识库**（`/kb.html`）：把 `.md/.txt/.pdf/.docx` 放进 `vault/`，自动索引；调试页可搜索验证命中
4. **工具调用（MCP）**：设置页「MCP 工具服务器」区添加 server（stdio 子进程或 SSE 远程），点「测试」验证连接。对话时模型可自动调用：
   - 内置工具：`vault_read_file` / `vault_list_files` / `vault_write_file` / `fetch_url`（始终可用）
   - MCP 工具：任意符合 MCP 协议的 server，工具名显示为 `server名:tool名`
   - 消息下方会展示本次调用了哪些工具及参数；最多连续 6 轮工具调用
5. **定时任务 / 自主智能体 / 任务链**（设置页「定时任务」区）：
   - **简单执行**：cron 到点跑一条指令；**自主智能体**：给目标让模型多轮调用工具干到完成（轮数与工具白名单按任务配置）
   - **任务链**：任务的产出经 `vault/tasks/handoff/` 自动交给下游任务继续处理（抓取 → 总结 → 写笔记）
   - **触发**：cron 或 vault 文件变化（如 `feeds/` 有新内容自动总结）；失败自动重试并可邮件通知
   - 每次运行的工具调用日志可在「运行记录」中回放
6. **长期记忆**：模型可在对话中记住你的偏好（memory_save），也可在设置页开启「自动记忆」让模型每轮对话后自主判断是否值得记住；
   记忆多时按相关性注入、保存时语义去重，设置页可编辑，🤖 徽标标记自动提取的记忆
7. **笔记工作台**（`/notes.html`）：Markdown 编辑 + 自动保存 + AI 续写/润色/摘要/配图；选中一段文字可让 AI 只改写这一段（润色/扩展/精简/译英/自定义）；
   「💬 对话」侧栏基于当前笔记内容问答，回答可一键插入笔记
8. **多源知识接入**（`/kb.html`）：**浏览器书签小工具**（把按钮拖到书签栏，之后在任意网页点一下就剪藏当前页，自动带 URL 和标题）、拖拽上传（PDF / Word / Markdown / TXT，**截图走本地 OCR 提成文字**）、网页剪藏、GitHub 仓库克隆、**本地目录注册**（vault 之外的文件夹实时监听索引），全部进同一套 RAG 检索
9. **技能 Skills**：把常用方法论沉淀为 SKILL.md 指令包（`skills/` 目录或从 GitHub URL 安装），对话时模型按需自动加载执行
10. **任务可观测**：仪表盘显示 token 用量曲线与任务 30 天成功率；任务运行有状态徽章，失败/完成弹 Windows 桌面通知（可关）
11. **记忆开放**：工作台的长期记忆可通过内置 MCP server（`python -m app.mcp_server`）开放给 Claude Desktop / Cursor 等任何 MCP 客户端，全机共享同一份记忆（设置页记忆区有接入片段）
12. **睡眠期记忆整理**：跨会话积累的近似重复记忆可一键「整理重复记忆」，或在设置页开启每日凌晨自动整理 — embedding 聚类找出语义相近的条目，模型确认后合并为一条（只保留原句信息），整理报告与合并明细可在设置页查看
13. **语音输入**：聊天输入框旁点 🎤 说话，再点一次自动转写进输入框（faster-whisper 本地 CPU 推理，音频不出本机；模型在设置页可选 tiny/base/small/medium，首次使用自动下载，国内网络默认走 hf-mirror 镜像）
14. **截图问答**：输入框旁点 📷 截取屏幕/窗口，截图自动附加后随问题发给视觉模型；也可以悬停图片点 🔍 用本地 OCR（RapidOCR）把图中文字直接提进输入框 — 没有视觉模型也能问答截图内容
15. **语音播报**：悬停 AI 回答点 🔊 朗读（edge-tts 微软神经音色，失败自动回退 Windows 本地语音保证离线可用），也可开启「回答完成后自动朗读」；音色与引擎在设置页可选
16. **知识图谱 RAG**：把笔记中的实体与关系抽取进你本机的 Neo4j，问答时叠加「实体向量匹配 → 一跳扩展」的图谱上下文（知识库页「知识图谱」tab 配置连接、增量构建、检索测试；填好密码后在聊天里勾选知识库检索即生效）
17. **笔记 → 双人播客**：笔记页点 🎙 播客，勾选 1-5 篇笔记合并成一期主持人 × 嘉宾对谈音频（LLM 写脚本、edge-tts 双音色配音、自动拼接成单个 WAV 可直接播放），生成历史带文稿可回看，主持人/嘉宾音色在设置页可选；开启「每日摘要」后还可勾选「摘要生成后自动转为播客」，每天定时把笔记简报读成一期音频
18. **轻执行 Artifacts**：设置页开启后，聊天里的 Python / JavaScript 代码块可一键在本机运行（独立临时目录、超时保护、输出截断；Python 用工作台自带环境），HTML 代码块可直接沙箱预览 —— 默认关闭，请只运行你理解用途的代码
19. **智能体协作**：输入框旁点 👥，选 2-4 个智能体以「流水线」（依次接力）或「评审回路」（起草→评审→修订终稿）协作完成输入框里的目标，过程流式展示并完整存入会话（智能体在设置页「智能体预设」创建，各有独立人设与模型）
20. **零柒 · 常驻陪伴助手**：主界面右下角悬浮一只会动的宠物（游戏角色 sprite，9 个动画动作）。空闲时呼吸眨眼，系统有动静（任务/摘要/备份/订阅）会主动挥手开口，任务失败会沮丧，你问它问题时专注思考——动作都绑定真实状态、不是假装的。早 08:30、晚 21:00 定时主动问候（可关/可调），点击展开对话面板（接入长期记忆，记得你）。形象在 `frontend/public/pet/` 下，可换成任意 codex-pet 角色
21. **收件箱文件夹**：在设置页把某个固定目录（比如 `D:\Inbox`，或浏览器默认下载目录）注册为监听目录，之后往里面丢任何文件都会自动进索引——浏览器「另存为」、右键「发送到」、截图工具直接保存，全都不用打开工作台。这是摩擦最低的一条采集路径：把「存东西」变成你本来就在做的事

## 生产形态（可选）

```bash
cd frontend && npm run build   # 产物到 frontend/dist
cd backend && uv run uvicorn app.main:app --port 8000
```

后端自动托管 `frontend/dist`，直接访问 http://127.0.0.1:8000 即可。

## 数据位置

- 数据库：`data/workbench.db`
- 向量库：`data/chroma/`
- 配置（系统提示词/RAG top_k/MCP servers）：`data/config.json`
- 笔记目录：`vault/`（放入即自动索引）
- embedding 模型首次运行自动下载到 HF 缓存（约 100MB）
