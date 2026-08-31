# AI 个人工作台 — 调研与实施方案 v1

> 长期迭代路线图见 ROADMAP.md（2026-08-26 基于五家竞品系统调研制定 V1-V5 规划）。

> 2026-08-23 基于 GitHub 头部竞品调研制定。定位：纯自用、Windows 桌面场景、开发者主技术栈为 Python。
> 2026-08-24 v0.1.1 体验优化：统一 Layout/侧栏、暗色模式、markdown 样式(typography+代码高亮+复制按钮)、RAG 引用持久化、重新生成、消息按需重渲染、favicon。
> 2026-08-24 v0.2 视觉升级：紫罗兰渐变品牌色、渐变 logo/按钮、欢迎页建议卡片(RAG感知)、消息操作栏(复制/重新生成)、AI头像、动画细节、输入框聚焦光环、自定义滚动条。
> 2026-08-24 v0.2.1 交互深化：会话搜索(Ctrl+K)、Ctrl+N 新对话、SSE delta 按 rAF 批量渲染、系统提示词全局配置(data/config.json)、RAG top_k 可配置。
> 2026-08-25 v0.3 工具调用：内置 vault 读/列/写 + fetch_url 四个工具、MCP server 接入(stdio/sse，mcp 官方 SDK 2.x)、agentic 工具循环(最多6轮，模型不支持工具自动降级纯聊天)、设置页 MCP 管理(增删改/连接测试/状态/工具清单)、对话流式展示工具调用轨迹。
> 2026-08-25 v0.3.1 真实 key 实测修复：tool_specs 补 OpenAI 协议必需的 {"type":"function","function":{...}} 包装（裸格式被 DashScope 静默忽略导致模型把工具调用当文本输出）；anthropic 轮次自动拍平工具 spec。qwen3.7-plus 全链路验证：流式对话/RAG 引用/多轮工具调用(vault+fetch_url)/前端工具轨迹展示 全部通过。
> 2026-08-25 v0.4 外部 MCP 实测 + 混合检索 + 定时摘要：uvx mcp-server-time 接入并对话中真实调用（get_current_time，时区正确）；MCP 工具名分隔符 ":"→"__"（OpenAI function 名只允许 [a-zA-Z0-9_-]）；混合检索 jieba+rank_bm25 与向量 RRF(k=60) 融合、索引变更自动失效重建、hybrid_search 开关；APScheduler 每日笔记摘要（digest_enabled/digest_time 可配，写入 vault/digests/ 自动入索引），POST /api/kb/digest/run 手动触发；设置页补混合检索开关与定时摘要控件（时间选择/即时生效），KB 调试页命中项展示 向量/BM25 通道徽标；修复 kb.tsx import 大小写导致 tsc 构建失败。
> 2026-08-25 v0.5 持久记忆 + 智能体预设 + 联网搜索（对标 Open WebUI Persistent Memory / Khoj Custom Agents / Web Search for RAG）：SQLite memories 表 + memory_save/list/delete 内置工具 + 每次对话自动注入记忆上下文（memory_enabled 开关、上限100条 FIFO）+ 设置页记忆管理；agents 表(name/avatar/system_prompt/model_id/use_rag/tools_enabled) CRUD API + 对话页顶部预设切换下拉（人设叠加全局提示词、可固定模型/RAG/工具）；web_search 内置工具（Bing 主引擎 + DuckDuckGo 备用自动切换，免 key，解析器离线 fixture 验证），与 fetch_url 组成搜-读-答链路。真实 key 实测：模型自主 4 轮工具调用答出 FastAPI 最新版本；新会话记忆注入生效；agent 人设生效。
> 2026-08-26 v0.6 对话体验四件套（扩大调研范围：LobeHub/Cherry Studio 官方文档、Open WebUI 官方 docs 站、RAGFlow 评测、16 种 RAG 方案长文后选定）：① 追问建议——回答完成后同模型生成 3 条追问，SSE followups 事件 + 可点击 chips 点击即发送；② 会话分叉——POST /fork?message_id= 复制历史到任意回答处为新会话（Open WebUI Fork a Chat）；③ Markdown 导出——GET /export 生成带角色标注的 md 文档下载（Cherry Studio 对话导出）；④ 用户消息编辑重发——PUT messages/{id} 编辑并截断后续消息自动重新生成。修复 export 中文 filename latin-1 编码错误、edit_message select(Message.id) 返回 int 的 AttributeError。
> 2026-08-26 v0.7 Agentic RAG + 一问多答：kb_search 内置工具（indexer.search_auto 暴露给模型，自主决定何时检索知识库并标注来源——Agentic RAG 形态）；对比模式 compare_model 参数双流并行（asyncio.gather + uid a/b 定向 delta），前端对比下拉 + A/B 徽标，两答案各自按 model_id 持久化；修 update_provider 掩码 api_key 回写覆盖真 key 的坑（GET 返回掩码值被 PUT 原样存库 → 加掩码检测保留旧 key）。
> 2026-08-26 v0.8 产品化四件套（对标 Open WebUI 官方 features 页功能树：Dashboard/Prompts/Folders-tags-pins/全局搜索）：① 仪表盘 /dashboard.html——GET /api/dashboard 统计（会话/消息/知识库文件/记忆数、近7天消息柱状图、常用模型占比条、最近会话），侧栏新增导航；② 提示词库 prompts 表 CRUD + 对话输入框敲 / 唤起浮层选择（标题/内容过滤、Enter 用第一条），支持 {变量} 占位符逐个填入，设置页管理区；③ 会话置顶+文件夹——conversations 加 pinned/folder 列（启动时 PRAGMA 幂等迁移），列表置顶分组优先、📁 下拉归组，PUT 已扩展；④ 全局搜索 Ctrl+P 弹窗——GET /api/search 跨会话 LIKE 全文搜消息返回命中摘录，点击跳转会话。
> 2026-08-26 v0.9 Notes 写作区 + 网页剪藏（对标 Open WebUI Notes workspace + Cherry Studio 剪藏）：① notes 路由——vault/notes/ 下 .md CRUD（路径越界校验），PUT 后 indexer.index_file 即时进 RAG，POST /ai SSE 流式写作动作（continue 续写/polish 润色替换全文/summarize 生成摘要追加），默认取第一个启用 provider 的首个模型；② NotesPage——左侧文件列表+新建/删除，右侧 Markdown 编辑器 1.2s 防抖自动保存，AI 三按钮流式渲染（rAF 批量 flush）可中途停止；③ 网页剪藏 POST /api/kb/clip——复用 fetch_url 正文抽取，存 vault/clippings/ 带来源头注释并索引，KB 页新增剪藏输入框。实测：AI 摘要流式生成后自动保存；剪 FastAPI features 页得 19 块且 kb_search 可检索。
> 2026-08-26 v0.10 Rerank 精排：app/core/reranker.py 用 sentence-transformers CrossEncoder 加载本地 HF 缓存 BAAI/bge-reranker-base（用户已下载，local_files_only 免联网校验——此前每次冷启动被 HF SSL 重试卡 2 分钟）；hybrid_search 开启精排时候选池扩到 top_k*4，RRF 融合后交叉编码器重排取 top_k，score 变为 sigmoid 概率、channels 增 rerank 标记；rerank_enabled 默认开、设置页开关；KB 调试页琥珀色「精排」徽标。实测对比：「什么是RAG」开精排后测试笔记 0.73 分稳居第一、无关内容压到 0.5 以下；关掉恢复 RRF 排序。冷启动含模型加载 6s，热查询亚秒级。
> 2026-08-26 v0.11 消息反馈 + 引用跳转：① messages 加 feedback 列（PRAGMA 幂等迁移），PUT messages/{id}/feedback（'up'/'down'/null 清除，乐观更新），assistant 消息操作栏 👍/👎 持久高亮；② 引用一键打开——RAG 参考片段与 KB 调试页命中项的 .md 来源加「打开」链接 → /notes.html?path=…深链自动打开对应笔记；Notes 页改为管理 vault 全部 .md（排除 clippings/digests 生成物），新建默认入 notes/ 子目录。实测：👍 入库刷新仍在；对话页点「打开」直接落到「项目笔记.md」正文。
> 2026-08-26 v1.1 上下文压缩 + 会话管理增强（ROADMAP V1.1，对标 OWU Context Compaction / Message Queue）：① 超长会话自动压缩——app/core/compaction.py，history 累计字符超 HISTORY_CHAR_BUDGET(24000) 时把最旧一半用当前模型摘成 ≤400 字要点（保留主题/结论/偏好/未决问题），保底保留最近 4 条原文，摘要按 transcript hash 缓存（编辑自动失效），注入为 system 块，30s 超时且任何失败原样透传不阻塞对话，chat.py 发 compacted 事件报 kept/total；② 流式响应中排队下一条——前端 queuedMsgs 队列，busy 时 send() 入队并即时清空输入框，runStream finally 顺序 drain，队列气泡悬于输入框上方可见待发消息，busy 态显示停止 + ⏭ 队列计数；③ 会话重命名——列表项 renameConversation 经 window.prompt 改标题后 PUT，替代此前只能自动标题。实测：连发两条消息顺序处理、会话手动重命名生效、压缩切分逻辑离线校验（60 条→src31/tail29，3 条→不压缩）。
> 2026-08-26 v1.2 RAG 易用性三件套（ROADMAP V1.2）：① 输入框 `#` 命令——敲 `#关键字` 唤起 vault 文件浮层（Enter 用第一条），选中后转为输入框上方绿色 chip，发送时经 chat 新增 `context_files` 参数把文件全文注入 system（每文件 12000 字符上限、路径越界与不存在自动过滤、发 context_files 事件），用户消息下方保留 chip 记录本轮引用了哪些文件；② 全上下文模式——app/core/fullctx.py，RAG 检索后把每个命中来源的整篇正文（≤full_context_max_chars，默认 4000）替换掉切块片段并合并同源多个 chunk，channels 加 `full` 标记、chunk 置 None，超长文件/读取失败原样透传，settings 新增 full_context + full_context_max_chars 开关，引用列表显示绿色「全文」徽标；③ vault 全文搜索——GET /api/notes/search 大小写无关子串扫描全部 .md（含文件名匹配），按命中次数排序返回带上下文摘录，Notes 页左栏搜索框 300ms 防抖，命中列表点击直达笔记。实测：`#测试` → notes/测试笔记.md 全文注入后关闭 RAG 也能答出标题与检索四步；full_context 开/关对比同一问题，短笔记 chunk=0→None 且 channels 多 full，长剪藏(fastapi)保持 chunk=18 不变；同源两 chunk 合并为一条（offline）；「混合检索」搜出 1 个命中×2 次并跳转成功。
> 2026-08-26 v1.3 备份与数据安全（ROADMAP V1.3，对标 Cherry Studio 定时备份）：① app/core/backup.py——zip 打包 vault/ 全部文件 + data/workbench.db（走 sqlite3 online backup API 取一致性快照，不裸拷文件）+ data/config.json + backup-manifest.json（时间/来源/文件数/恢复步骤），命名 workbench-backup-YYYYMMDD-HHMMSS.zip，同秒重复运行自动加 -2 后缀，向量索引不入包（可由 vault 重建）；② 滚动保留——backup_keep（默认 7）之外的旧包按 mtime 自动删除，backup_dir 可指向任意目录（留空=项目 backups/，且遍历 vault 时跳过备份目录自身防自包含）；③ app/core/scheduler.py——把原 DigestScheduler 拆成全局单例 AsyncIOScheduler + set_daily(job_id,...)，digest 与 backup 各自 reschedule()，PUT prefs 后 reschedule_all() 即时生效（为 V2.1 自定义定时任务铺基建）；④ routers/backup.py——GET /api/backup（列表+目录+下次运行时间+恢复提示）、POST /api/backup/run、GET /api/backup/download/{name}（FileResponse）、DELETE /api/backup/{name}，名字校验只认自己产出的 workbench-backup-*.zip 并拒绝 ../ 越界；⑤ 设置页「备份与恢复」区——每日自动备份开关+时间+保留份数+自定义目录、立即备份按钮、备份列表（大小/时间/下载/删除）、「如何恢复？」折叠说明（恢复保持手动，API 永不写回 vault/data）。实测：立即备份得 19KB/8 条目 zip，包内 db PRAGMA integrity_check=ok 且会话 10/消息 59 条齐全；保留数 2 时连续 3 次备份只剩最新 2 份；../ 与非法名下载被 400/404 拒绝；开启定时后 next_run=2026-08-27T03:30+08:00，digest 任务仍在。
> 2026-08-27 v2.1 自定义定时任务（ROADMAP V2.1，对标 Khoj Automations）：① app/core/tasks.py——validate_cron 五段校验（CronTrigger.from_crontab，中文报错）、reschedule() 从 tasks 表把 enabled 行注册成 task_{id} 作业并 prune 已删除的、run_task() 全流程不抛异常（快照→执行→落会话→写 vault→回写 last_run/last_status/last_result）；执行时注入「当前时间」system 块，按任务开关决定走 run_agentic_chat（带 MCP 工具）还是 stream_chat，use_rag 时先 indexer.search_auto 拼检索上下文；② 结果去处——每个任务复用一条会话（标题 `⏰ 任务名`、归入 📁定时任务 文件夹），user/assistant 双消息带 sources_json；save_to_vault 时写 `vault/tasks/任务名-YYYY-MM-DD-HHMM.md`，watcher 自动入索引即可被后续 RAG 检索到；③ 自然语言建任务 POST /api/tasks/parse——模型把「每周一早上9点半汇总笔记」译成 {cron,name,prompt} JSON，正则抽取后 cron 二次校验；④ routers/tasks.py 五个端点（GET/POST/PUT/DELETE + /run）写操作后都 reschedule()，非法 cron 返 422；⑤ 设置页「定时任务」区——自然语言输入框一键解析填表、任务名/cron/prompt/模型/四个开关（RAG、工具、写入 vault、启用）、任务列表带下次·上次时间与状态徽标、立即运行/查看上次结果折叠/跳转会话/停用启用/编辑/删除；⑥ 仪表盘新增定时任务卡片（按 next_run 排序取前 5，含上次失败徽标）。实测：非法 cron 被 422 拒；手动运行 qwen/qwen3.7-plus 生成答案并落会话 11 + vault 文件，该文件随即成为 /api/kb/search 首位命中（0.731，bm25/rerank/vec 三通道）；开 RAG+工具的任务返回 sources=5 且答案带 [来源 1] 标注；调度器到点自行触发（10:32:00 → ok/「收到」/会话 12，next_run 自动滚到次日）；停用后 next_run 变 null 停止触发。
> 2026-08-27 v2.2 RAG 效果评估集（ROADMAP V2.2，RAGAS 思路简化版不引重型框架）：① eval_items 表（question/expected_source/note）+ eval_runs 表（把 top_k/hybrid/rerank/full_context/judge_model 随每次评估留档，调参前后可横向对比）；② app/core/evals.py——每题走 indexer.search_auto 检索后按 expected_source 算 1-based 命中位次，聚合 Hit@1/Hit@3/Hit@k/MRR（source_matches 支持全路径或只给文件名两种写法），judge=True 时再用当前模型基于检索片段生成回答并自评忠实度 0-5（严格评审 system + JSON 正则抽取 + 0..5 裁剪），信号量限并发 3、单题任何异常落 error 字段不炸整轮；③ routers/evals.py 八个端点（题目 CRUD + /runs 列表/详情/删除 + POST /run），空问题与 top_k 越界 422；④ KB 页拆「索引与检索 / 评估」两 tab——评估 tab 含评估集管理（expected_source 用 vault 文件 datalist 补全）、运行卡（top_k + 判忠实度开关）、分数趋势表（时间/配置/四项指标/忠实度）、每题明细（命中位次徽标 + 判分理由 + 折叠查看回答）。顺带修两个真 bug：indexer.get_client() 的懒加载单例无锁，并发首次访问（评估批量检索、对比模式双流）各建一个 PersistentClient 导致 chroma 半初始化崩 ValueError → 补双检查锁；reindex_all 从不清理磁盘上已删文件的残留 chunk（test-upload-*.pdf 删掉后仍以 0.5 分参与检索）→ 加 _prune_missing 并在 UI 回显「清理已删除来源」。实测：4 题集 top_k=5 判分轮 Hit@1/@3/@k=1.0、MRR=1.0、忠实度 5.0/5、60.9s 无 error；rerank 开/关各存一行可对比；冷启动首轮并发检索 0 Traceback；reindex 返回 pruned=["test-upload-8be88e.pdf"]、25→24 块与磁盘 6 文件一致。注意：当前 4 题过简单，各配置都打满分无区分度，需补难题/无答案负例才能看出调参差异。

> 2026-08-27 v3.1 图片生成（ROADMAP V3.1）：① app/core/images.py 两条通道——DashScope 只有同步的 `/api/v1/services/aigc/multimodal-generation/generation` 能用（OpenAI 兼容的 `/compatible-mode/v1/images/generations` 直接 404，原生 `text2image/image-synthesis` 对 wan2.7-image 报 400 "url error"，这两条都已排除不留猜测代码），另一条 `_gen_openai` 走标准 `{base_url}/images/generations` 兼容任何 OpenAI 式服务（b64_json 与 url 两种返回都处理）；provider 从 provider_configs 按名取（留空=第一个已启用），base_url 只取 host 再拼 /api/v1；② 图片必须落盘——DashScope 返回的 URL 带 Expires 签名会过期，`_download` 跟随重定向、拒 >20MB、按 content-type/后缀猜扩展名，存成 `img-YYYYMMDD-HHMMSS-<6hex>.png` 到 data/images/，读写删只认这个白名单正则（`../`、config.json、.exe 全被 400 挡掉）；prompt 截 1200 字、size 必须形如 1024*1024 或 16:9、n 夹到 1..4、超时 300s；③ routers/images.py 四端点（GET 列表带配置、POST /generate、GET/DELETE /{name}），参数错 400、上游炸 502 并落日志；④ image_gen 内置工具——tool_specs() 按 prefs.image_enabled 动态增删（关掉后模型看不到这个工具），工具返回一段 markdown 让模型原样贴出，配合 index.css 新增 `.prose img`（圆角+420px 上限）在对话里内联渲染；⑤ Notes 页「🖼️ 配图」——用 cursorRef（onSelect/onChange 跟踪）在光标处插入 `![描述](/api/images/x.png)` 并自动补空行，生成期间禁用 textarea 防止 60 秒里手改导致串位，插完 setDirty 走原有 1200ms 自动保存、回焦并把光标停在图片后；⑥ 设置页「图片生成」区——工具开关、接口(dashscope/openai)、provider 下拉、模型、尺寸、「保存设置并测试生成」，下方 data/images/ 缩略图墙可点开原图或删除（image_api 只收 dashscope/openai，其它 422）。实测：empty prompt/size=big/不存在的图/非法名 依次 400/400/404/400，`%2e%2e%2fconfig.json` 404；真实生成三次全部 200——设置页 52.5s（1.7MB）、Notes 配图 ~55s（723KB，插到「# 测试笔记」后光标处并自动保存进 vault/notes/测试笔记.md）、对话里 qwen3.7-plus 自主调用 image_gen（把中文需求自行扩写成英文提示词 + size 1024*1024）后图片内联渲染、tool trace 可展开、刷新后会话 12 的 markdown 仍指向本地 /api/images 能正常取回（无过期问题）。注意：1024*1024 单张 ~52-60s 且按张计费，工具描述里已写明「一次调用即可、不要重复调用」；更小尺寸能不能省时省钱没实测，真要压成本得换 z-image-turbo 这类快模型。

> 2026-08-28 v3.2 视觉理解（ROADMAP V3.2）：① 聊天贴图——前端 ChatView 加 attachedImages 状态，textarea onPaste 捕获剪贴板图片（多张）+ 输入框右下 📎 按钮走隐藏 file input，选完立即 api.uploadImage（POST /api/images/upload，multipart，python-multipart 本来就在依赖里）传到 data/images/，预览条 56px 缩略图带上传中遮罩、hover × 移除；发送时把图片拼成 `\n\n![name](/api/images/x.png)` 附在文本后（队列路径同样拼），消息本身保留 markdown 所以刷新后仍在；后端 chat._attach_local_images 在发给 LLM 前把**最后一条用户消息**里的 `/api/images/` 图片 finditer 拆出，转成 OpenAI 式 `image_url`（data:image/png;base64），文本/图/文本交错保序——第一版用 split("![attached](…)") 永远匹配不上真实 alt，改成按整个 match 切才对。实测 qwen3.7-plus 原生支持 image_url，不用单配 qwen-vl；Playwright 模拟粘贴 RAG 白板图 → 模型完整读出「RAG / Retrieve → Augment → Generate」白板文字并正确解释含义，SSE 发出 images_attached 事件。坏路径：.exe mime 400、>20MB 400、非图文件前端拦截。② 扫描 PDF OCR——ingest.py 每页 pymupdf 抽文本，<8 字符视为扫描页 → 200dpi 渲染 PNG → RapidOCR（rapidocr-onnxruntime 1.4.4，uv add 装的，PP-OCRv4 中英混合识别）→ 并入页文本；OCR 模型进程级单例。**踩了一个真死锁**：模型懒加载放在 vault-watcher 线程里首次 import onnxruntime 永远不返回（uvicorn 下 watcher 线程 import 卡死、无异常无日志，index_file 走到 delete_file 就断——日志只出现 "removed index for x.pdf" 没有后续），独立进程同样非主线程 3.8s 跑完，排除代码问题；修法是 main.py lifespan 里 asyncio.to_thread(ingest.warm_ocr) 启动时主线程预热，watcher 只做推理。修后 touch PDF → watcher 自动 `indexed 说明文档-扫描版.pdf -> 1 chunks`，KB 检索「RAGOverview 混合检索」该 PDF 0.730 排第一，OCR 文本（中英混排、Retrieval-Augmented…、知识库问答的完整流程…）全部可检索。注意：OCR 每页 ~4-5s（200dpi CPU），大扫描件首次入库会慢；RapidOCR 对英文粘连偶尔丢空格（RAGOverview），语义检索不受影响但引用原文时注意。

> 2026-08-28 v4.1 桌面化（ROADMAP V4.1）：① backend/desktop.py 原生壳——单进程启动器：先 GET /api/health 探测 127.0.0.1:8000，已有服务则复用，否则线程内 uvicorn.Server 起 app.main:app（等 health 就绪再开窗）；主窗 1280×860 min(900,600) 指向本地服务，快速提问小窗 640×420 hidden+on_top 指向 /quick.html（pywebview 6.2.1 + pythonnet/Edge WebView2，uv add pywebview pystray keyboard）；② Ctrl+Alt+Q 全局热键——keyboard 库 add_hotkey 在独立线程循环里守着，toggle_quick 切换快速窗显隐并 evaluate_js 派发 workbench:quick-reset 事件让输入框重新聚焦清空；③ pystray 托盘——程序画 64×64 紫色圆点图标，菜单「打开工作台(default 双击项)/新对话/快速提问(Ctrl+Alt+Q)/退出」，新对话经 evaluate_js 派发 workbench:new-chat、App.tsx 监听后走原有 newChat()；关窗不退出——events.closing handler 返回 False 取消关闭改 hide（winforms 后端 on_closing 里 should_cancel→args.Cancel=True，源码级确认），退出只在托盘菜单；④ quick.html + QuickView.tsx——单输入框 + 流式回答区，复用 streamChat/api，首次提问自动建会话（模型取第一个启用 provider 首个模型），生成中 Esc 中止并关窗，工具条「打开会话 ↗」调 js_api.open_main() 唤起主窗，window.pywebview.api 在纯浏览器里 undefined 自动降级（hide/open 无操作）；⑤ 踩坑两个——pywebview Window 实例的 .focus 是 __init__ 的 focus 参数 bool 值不是方法（`window.focus()` 抛 TypeError: 'bool' object is not callable，且异常发生在 keyboard 线程只留一行 traceback 首帧，热键看起来"没反应"实际已触发到一半），删掉调用即可 show() 自带激活；热键回调/托盘回调都在非主线程，但 show/hide/evaluate_js 会 marshal 到 GUI 事件循环所以线程安全。实测：desktop.py 自起服务 health ok、主窗加载前端（conversations/prompts 请求可见）、0 Traceback；Playwright 走 /quick.html 完整链路——「用一句话解释什么是 BM25」→ 建会话 16 → 流式回答渲染完整；Ctrl+Alt+Q 真实桌面验证弹窗/再按隐藏/Esc 关闭/托盘菜单四项全过。启动方式：`cd backend && .venv/Scripts/python.exe desktop.py`（vite dev 也能用，页面走同一服务）。

> 2026-08-29 v4.2 划词助手（ROADMAP V4.2，对标 Cherry Studio 选中助手）：① POST /api/ask——routers/ask.py 新增一次性流式端点，四种动作（translate 目标语言按文本是否含中文自动反向、explain、summarize、custom 带用户 prompt），system 提示说明"文本来自用户在任意应用中选中的内容"，20000 字上限、空文本/未知 action 400，走 stream_chat 发 SSE delta/done，**不落会话**（划词是即用即走，不该污染对话列表）；② desktop.py 加 Ctrl+Alt+W——on_selection_hotkey 起 worker 线程：先轮询等 ctrl/alt 松开（Alt 还按着时发 Ctrl+C 会变成 Alt+C 给目标应用），快照剪贴板 → `keyboard.send("ctrl+c")` → 等 0.3s → 剪贴板比对，变了就是选中文本；捕获成功后**还原原剪贴板**（仅当原内容是文本，图片类无法还原就保留），要复制结果得主动点「复制」；三级兜底 selection→clipboard→empty 保证热键永不哑火，日志打 `source=... chars=N` 便于排查；③ selection.html + SelectionView.tsx——460×520 置顶浮窗，顶栏四个动作 chip + 复制按钮 + 选中文本预览（title 悬停看全文），文本经 URL hash 传入（`#t=<urlencoded>`，load_url 即可换文本无需重建窗口），无文本时显示粘贴框「使用这段文本」，Esc 关窗（生成中先中止），自定义动作弹输入框 Enter 执行；④ **修了三个 bug**——(a) `keyboard.pressed` 上下文管理器在 keyboard 0.13.5 里不存在（我按新版 API 写的），模拟 Ctrl+C 第一步就抛 AttributeError、异常在 worker 线程只打一行，表象是"按热键完全没反应"，改 `keyboard.send("ctrl+c")`；(b) pywebview 对 `hidden=True` 创建的窗口**也会触发 shown 事件**，我拿它维护可见标志导致程序一启动就以为窗口已显示、首次按热键走 hide 分支（V4.1 的 Ctrl+Alt+Q 要按两下才出来同源），改为标志只由自己的 show/hide 维护、show() 无条件调用；(c) `_health_ok` 原来只看 HTTP 通不通，Docker Desktop 占着 `0.0.0.0:8000` 时会把它误判成自己的服务而复用 → 改成校验响应体 `{"ok":true}`，并加 8010-8029 端口回退（实测我们绑 `127.0.0.1:8000` 能与 Docker 的 wildcard 共存且更具体的绑定优先，回退只是兜底）。实测：curl /api/ask translate 得"敏捷的棕色狐狸跳过了那只懒狗。"、custom 提取术语列表、空文本与非法 action 各 400；Playwright 走 selection.html 点翻译得"知识库检索结合 BM25 与向量搜索实现混合排序"、点解释得带术语拆解的长回答、剪贴板写入权限确认可用；真实发送 Ctrl+Alt+W 后日志 `ctrl+alt+w fired → GET /selection.html 200 → source=clipboard chars=84`、EnumWindows 确认「划词助手」窗口可见，0 Traceback。注意：真实应用里的 Ctrl+C 响应（source=selection）需在非沙箱进程下按热键验证，模拟注入在沙箱进程里发不出去；启动 desktop.py 后 TaskStop 只杀外层 shell 不杀 python，重启前先确认 8000 已释放否则会有多实例抢热键。

> 2026-08-29 v5.1 数据接入：Obsidian + GitHub 仓库索引（ROADMAP V5.1）：① 仓库入库——app/core/repos.py 浅克隆（`git clone --depth 1`）到 `data/repos/<name>/`，**故意放在 vault 外**：放 vault 里会让 Notes 列表被仓库 md 淹没、备份 zip 被代码撑爆；索引时 `indexer.index_file(p, root, source_prefix="repos/<name>")` 把来源写成 `repos/名字/相对路径`，与 vault 文件天然区分；② 防误删的关键改动——`_prune_missing` 原本会把"不在 vault 里"的来源全当残留清掉，即 vault 全量重建会顺手删光仓库索引，改成跳过 `repos/` 前缀（实测 reindex 后 pruned=[] 且仓库文件仍可检索），仓库文件的增删改由自己的「同步」处理（walk 后对比 `list_sources(prefix)` 删掉消失的）；③ 索引范围——ingest 新增 TEXT_EXT（40+ 种源码/配置扩展名，py/ts/go/rs/java/json/yaml/toml/sql…）与 `is_repo_indexable()`，vault watcher 仍只认 SUPPORTED_EXT 不受影响；单文件 ≤200KB、最多 1500 个文件（truncated 标记回显）、跳过 node_modules/dist/build/target/vendor/__pycache__/.venv/.next/coverage 等目录与隐藏文件；④ routers/repos.py 四个端点——GET /api/repos（列表+目录+上限）、POST（克隆并索引，`asyncio.to_thread` 不堵事件循环）、POST /{name}/sync（pull --ff-only + 重索引）、DELETE /{name}?keep_files=（删索引+配置项+克隆目录）；仓库清单存 data/config.json 的 `repos` 键；⑤ KB 页新增「代码仓库」tab——URL+本地名输入、克隆按钮、仓库卡片（文件/块数、上次同步、目录缺失/已截断徽标、失败文件提示）、同步/删除按钮；⑥ Obsidian——写 `vault/notes/用 Obsidian 打开 vault.md`（打开步骤、四个目录约定表、与同步插件冲突/`.obsidian/` 不被索引/双链当纯文本等注意事项、反向用 `#` 命令指定笔记进上下文），文件落 vault 后 watcher 自动索引，检索「Obsidian vault」即命中该笔记。实测：克隆 pypa/sampleproject → 8 文件/23 块/2.1s，`repos/sampleproject/README.md` 以 0.726 三通道（bm25+vec+rerank）命中；vault 全量重建 pruned=[] 仓库索引未受影响；sync 幂等（0.9s）；坏路径依次拒绝——重复克隆 400、`name=../evil` 400「非法仓库名」、不存在的仓库 502 带 git stderr。**踩坑**：Windows 下 `shutil.rmtree` 删不掉 git 克隆（.git/objects 是只读的，配 `ignore_errors=True` 后静默失败，DELETE 返回 dir_removed=false 但目录还在），改成先 `os.chmod(p, stat.S_IWRITE)` 遍历清只读位再 rmtree。

> 2026-08-29 v5.2 订阅与推送（ROADMAP V5.2，路线图最后一项）：① RSS——app/core/feeds.py 用 feedparser 抓取，新条目按月追加到 `vault/feeds/<名字>-YYYY-MM.md`（watcher 自动索引 → 立刻可被 RAG 检索，再配一个定时任务「总结 feeds 目录里今天的新内容」就是每日情报简报，这就是 V2.1 任务系统的联动点）；去重用 `data/feeds_seen.json` 存 entry id 环形缓冲（每源 400 条上限，重启不丢，避免每次同步重复追加），每次同步只取最新 20 条、单条正文截 1200 字，`_strip_html` 去标签+反转义实体；订阅清单存 config 的 `feeds` 键（name/url/title/enabled/new/last_synced），`feeds_enabled` + `feeds_time` 走已有 `set_daily` 注册 `feeds_sync` 作业（默认 08:00）；② 邮件——app/core/mailer.py 纯 stdlib smtplib（不引 Resend SDK），465 走 SMTP_SSL 隐式 TLS、其它端口 STARTTLS，`email_on_digest`/`email_on_feeds` 两个开关分别让每日笔记摘要与订阅抓取完成后发信；③ routers/feeds.py——GET /api/feeds（含 next_run）、POST（添加即抓一次）、POST /sync（全部）、POST /{name}/sync、PUT /{name}（启停）、DELETE /{name}；GET /api/mail 返回打码配置、POST /api/mail/test 发测试信；④ 设置页两个新区块——RSS 订阅（每日开关+时间+下次运行、添加/立即同步全部、订阅卡片带上次同步与新增条数、同步/停用/删除）与邮件推送（SMTP 六项+STARTTLS+两个推送开关+发送测试邮件）；⑤ **密码不能明文回浏览器**——GET /api/settings/prefs 把 `smtp_password` 换成 `••••••••`，PUT 时若收到的值全部由掩码字符（•*?●）组成就丢弃该字段保留库里的真密码。这里踩了个坑：最初只比较是否等于那串 bullet，而 GBK 控制台/客户端会把 `••••••••` 变成 `????????`，比较失败后把问号存成了新密码；改成"全是掩码字符即视为未修改"后三种情形（真密码写入、bullet 回显、被 mangle 成问号）都正确保留原值。实测：添加 hnrss.org/frontpage → 20 条新条目写入 `HackerNews-2026-08.md`（186 行，含标题/时间/链接/正文）；二次同步 new=0 不重复追加；停用后 sync-all 跳过（feeds=0）、启用后恢复；坏路径——非 feed 的 URL 400 带解析错误、未配置 SMTP 时测试邮件 400「未配置 SMTP 服务器」、不存在的订阅 400；`feeds_enabled=true, 08:15` 保存后 next_run=2026-08-30T08:15+08:00。注意：**add() 最初漏了 `_save_feed`**（sync 在"尚未保存"分支里不落盘），表现为添加成功但列表为空、随后同步报"订阅不存在"，已补。测试用的 SMTP 假配置已清空，HackerNews 订阅保留（真实可用）。

## 一、竞品调研结论

| 项目 | Stars | 架构模式 | 可借鉴点 |
|---|---|---|---|
| [Open WebUI](https://github.com/open-webui/open-webui) | 149.6k | FastAPI + 浏览器访问 | 整体架构模板：SQLAlchemy async + SQLite + ChromaDB + sentence-transformers + rank_bm25 |
| [Khoj](https://github.com/khoj-ai/khoj) | 36.7k | FastAPI(+Django admin) + 浏览器访问 | 第二大脑功能集；内嵌 pgserver Postgres（过重，不采纳）；APScheduler 定时任务；OCR/语音 |
| [Reor](https://github.com/reorproject/reor) | 8.6k | Electron + LanceDB | Markdown vault 为唯一真相源的思想 |
| [Cherry Studio](https://github.com/CherryHQ/cherry-studio) | 50.9k | Electron | 多模型对话交互设计 |
| [AnythingLLM](https://github.com/Mintplex-Labs/anything-llm) | 65.1k | Electron/Docker | RAG 工作区产品形态 |

关键事实（读源码依赖清单得出）：
- 头部项目无一是"真原生桌面"，均为本地服务+浏览器 或 Electron 壳。自用工具选前者，复杂度最低。
- Open WebUI 默认栈 = SQLite(aiosqlite) + ChromaDB(本地持久化) + sentence-transformers(本地embedding) + langchain-text-splitters(仅分块) + rank_bm25(混合检索) + mcp 官方 SDK。
- 多模型接入 = openai / anthropic / google-genai 官方 SDK 直连，非 litellm 重封装。

## 二、技术架构定案

```
浏览器 (React + Vite + Tailwind + shadcn/ui，瘦客户端只管渲染)
   │ HTTP + SSE 流式
FastAPI (uvicorn 单进程，绑定 127.0.0.1)
 ├─ routers/
 │   ├─ chat.py      # 对话：SSE 流式、会话 CRUD、模型切换
 │   ├─ notes.py     # vault 笔记 CRUD（读写 .md 文件）
 │   ├─ kb.py        # 索引状态、重建、检索调试
 │   └─ settings.py  # provider/key/模型/embedding 配置
 ├─ core/
 │   ├─ llm.py       # openai SDK (base_url 可配) + anthropic SDK
 │   ├─ indexer.py   # watchfiles 监听 vault → 分块 → embedding → 向量库
 │   ├─ retriever.py # 向量检索 (+FTS5/BM25 混合，P1)
 │   └─ ingest.py    # pdf/pymupdf、docx/docx2txt、md 解析
 └─ storage/
     ├─ SQLite (SQLAlchemy 2 async + aiosqlite)：会话、消息、chunk 元数据、配置
     ├─ ChromaDB PersistentClient：向量（或 sqlite-vec，二选一）
     └─ vault/*.md ：笔记正文（唯一真相源，Obsidian 兼容）

后续加壳：pywebview (Windows 下走 Edge WebView2) 提供独立窗口；托盘/全局快捷键为可选项
```

### 选型依据
- **后端全 Python**：匹配开发者技能；赛道头部项目全是 Python 后端，问题都有现成答案可抄。
- **不做 Tauri/Electron**：省掉跨语言进程通信和第二套生态的学习成本；浏览器标签页即入口。
- **SQLite + ChromaDB**：个人规模（<10 万 chunk）绰绰有余，Open WebUI 同款默认组合，零运维。
- **Embedding 本地优先**：sentence-transformers + 中文友好模型（bge-small-zh-v1.5 或 bge-m3）；接口留出切换 API embedding 的余地。
- **多模型接入**：OpenAI 兼容协议覆盖 DeepSeek/Qwen/Moonshot/Ollama/OpenRouter（一个 openai 客户端改 base_url 即可），Claude 用官方 anthropic SDK。
- **笔记存 .md 文件而非入库**：数据可迁移、Obsidian 直接打开、grep 可搜；SQLite 只存索引。

## 三、功能范围

### v0.1 MVP（每阶段结束都保持可用）
1. ✅ **阶段 1 — 能用的多模型聊天器**（已完成）
   - FastAPI 骨架 + SQLite 会话/消息持久化
   - SSE 流式对话、停止生成、markdown 渲染
   - 设置页：provider 配置、当前模型切换
2. ✅ **阶段 2 — 知识库索引管道**（已完成）
   - vault 目录监听（watchfiles，防抖 2s）；md/txt/pdf/docx 自动索引
   - 分块(RecursiveCharacterTextSplitter) → 本地 embedding(bge-small-zh-v1.5) → ChromaDB
   - 检索 API + 前端调试页（命中 chunk + score）
3. ✅ **阶段 3 — RAG 对话**（已完成）
   - 对话时自动检索 top-k（向量搜索）注入系统上下文；助手回复可标注 [来源 N]
   - 前端「知识库(RAG)」开关；助手消息下方可展开「参考了 N 个知识库片段」及命中块
4. ✅ **阶段 4 — 文件投喂**（已完成）
   - 拖拽/点选上传 pdf/docx/md/txt → 存 vault → 立即索引，返回分块数
   - `/api/kb/upload` 端点 + 前端拖拽 drop zone
5. ✅ **阶段 5 — 工具调用 + 混合检索 + 定时摘要**（已完成，2026-08-25）
   - 内置工具(vault 读/列/写、fetch_url) + 外部 MCP server(stdio/sse)
   - 混合检索：BM25(jieba) + 向量 RRF 融合
   - APScheduler 定时笔记摘要 → vault/digests/
6. ✅ **阶段 6 — 持久记忆 + 智能体 + 联网搜索**（已完成，2026-08-25）
   - 长期记忆：模型自主存取(memory_save/list/delete) + 自动注入 + 设置页管理
   - 智能体预设：人设/模型/RAG/工具开关命名打包，对话页切换
   - web_search 内置工具：Bing/DDG 免 key 搜索 + fetch_url 阅读
7. ✅ **阶段 7 — 对话体验四件套**（已完成，2026-08-26）
   - 追问建议 chips、会话分叉、Markdown 导出、用户消息编辑重发
8. ✅ **阶段 8 — Agentic RAG + 一问多答**（已完成，2026-08-26）
   - kb_search 工具：模型自主检索知识库并标注来源
   - 对比模式：双模型并行回答 A/B 徽标对照
9. ✅ **阶段 9 — 产品化四件套**（已完成，2026-08-26）
   - 仪表盘：用量统计 + 近7天柱状图 + 常用模型 + 最近会话
   - 提示词库：/ 斜杠命令唤起、{变量} 占位符填入
   - 会话置顶 + 文件夹分组；全局搜索 Ctrl+P 跨会话全文
10. ✅ **阶段 10 — Notes 写作区 + 网页剪藏**（已完成，2026-08-26）
   - 笔记页：vault/notes/ CRUD + 自动保存 + 自动进 RAG 索引
   - AI 写作三动作：续写 / 润色 / 摘要，SSE 流式
   - 网页剪藏：URL → 正文抽取 → clippings/*.md → 可检索
11. ✅ **阶段 11 — Rerank 精排**（已完成，2026-08-26）
   - bge-reranker-base（本地缓存）交叉编码器重排，候选池扩容后精排
   - rerank_enabled 开关 + KB 调试页「精排」徽标；实测排序质量明显提升
12. ✅ **阶段 12 — 消息反馈 + 引用跳转**（已完成，2026-08-26）
   - assistant 消息 👍/👎 反馈持久化（乐观更新、可清除）
   - RAG 引用/检索命中 .md 来源一键打开对应笔记（vault 全域 Notes 页）
13. ✅ **阶段 13 — 上下文压缩 + 会话管理增强**（ROADMAP V1.1，已完成，2026-08-26）
   - 超长会话自动压缩：最旧一半摘要注入、失败透传、compacted 事件
   - 流式中消息排队：busy 入队、顺序 drain、队列气泡可见
   - 会话重命名入口
14. ✅ **阶段 14 — RAG 易用性三件套**（ROADMAP V1.2，已完成，2026-08-26）
   - 输入框 `#` 命令：指定 vault 文件全文进上下文（chip 可见、context_files 参数）
   - 全上下文模式：命中的短文档整篇注入替代切块，同源 chunk 合并
   - vault 全文关键词搜索：/api/notes/search + Notes 页搜索框直达
15. ✅ **阶段 15 — 备份与数据安全**（ROADMAP V1.3，已完成，2026-08-26）
   - 一键备份 zip：vault + db 一致性快照 + config.json + manifest
   - 每日定时备份 + 保留最近 N 份滚动清理（共享 APScheduler 单例）
   - 设置页备份列表（下载/删除）+ 手动恢复说明；恢复不自动写回
16. ✅ **阶段 16 — 自定义定时任务**（ROADMAP V2.1，已完成，2026-08-27）
   - tasks 表 + /api/tasks CRUD/立即运行/自然语言解析 cron
   - 到点用指定模型跑 prompt → 会话（📁定时任务）+ 可选写入 vault 并自动入索引
   - 任务可开 RAG / 工具；设置页任务管理 UI + 仪表盘下次运行时间
17. ✅ **阶段 17 — RAG 效果评估集**（ROADMAP V2.2，已完成，2026-08-27）
   - eval_items/eval_runs 表 + /api/evals CRUD 与批量评估
   - 检索指标 Hit@1/@3/@k + MRR（对期望文件客观打分）、LLM 判忠实度 0-5
   - KB 页「评估」tab：评估集管理 + 分数趋势表 + 每题明细（配置随每次评估留档可对比）

18. ✅ **阶段 18 — 图片生成**（ROADMAP V3.1，已完成，2026-08-27）
   - app/core/images.py：DashScope 原生多模态生成 + OpenAI 兼容 /images/generations 两条通道，provider/模型/尺寸可配
   - 图片下载落 data/images/，经 /api/images/{name} 提供（原始签名链接会过期）
   - image_gen 内置工具（可在设置页关掉）→ 对话内联展示；Notes 页「🖼️ 配图」按光标插入

19. ✅ **阶段 19 — 视觉理解**（ROADMAP V3.2，已完成，2026-08-28）
   - 聊天贴图：粘贴/📎 选图 → /api/images/upload 落 data/images/ → 后端把最后一条用户消息里的本地图 markdown 拆成 image_url 内容块
   - 实测 qwen3.7-plus 直接吃 OpenAI 式 image_url，无需单独配 qwen-vl
   - 扫描 PDF OCR：pymupdf 抽不出文本的页渲染 200dpi PNG 走 RapidOCR；启动时主线程预热模型

20. ✅ **阶段 20 — 桌面化原生窗口**（ROADMAP V4.1，已完成，2026-08-28）
   - backend/desktop.py：pywebview 主窗 + 快速提问小窗，8000 有服务则复用否则自起 uvicorn
   - Ctrl+Alt+Q 全局热键呼出快速提问窗（keyboard 库）；pystray 托盘常驻（打开/新对话/退出）
   - 关窗隐藏到托盘、托盘退出；quick.html 流式快问快答，会话照常落库

21. ✅ **阶段 21 — 划词助手**（ROADMAP V4.2，已完成，2026-08-29）
   - Ctrl+Alt+W 捕获任意应用选中文本 → 置顶浮动小窗（翻译/解释/总结/自定义 prompt）
   - POST /api/ask 一次性流式端点（不落会话），结果一键复制
   - 抓不到选中文本时退回剪贴板文本、再退回手动粘贴框；捕获后还原原剪贴板

22. ✅ **阶段 22 — 数据接入：Obsidian + GitHub 仓库**（ROADMAP V5.1，已完成，2026-08-29）
   - git 仓库浅克隆到 data/repos/ 并索引文档与源码，来源前缀 `repos/名字/` 与 vault 区分
   - /api/repos 增删同步；KB 页「代码仓库」tab 管理；vault 全量重建不会误删仓库索引
   - vault/notes/《用 Obsidian 打开 vault》指南（目录约定 + 冲突注意事项）

23. ✅ **阶段 23 — 订阅与推送**（ROADMAP V5.2，已完成，2026-08-29）
   - RSS 订阅：feedparser 抓取 → vault/feeds/ 按月追加 → 自动进 RAG，entry id 去重不重复写
   - 每日定时抓取（feeds_time）+ 可配定时任务总结 → 每日情报简报
   - SMTP 邮件推送（stdlib smtplib）：笔记摘要 / 订阅更新可选发信，密码接口打码

24. ✅ **阶段 24 — Agent 编排：自主任务 + 任务链 + 文件触发**（ROADMAP V2.3，已完成，2026-08-30）
   - 任务双模式：simple（单轮指令）| agent（多步自主工具循环，轮数预算 1-30，每任务独立工具白名单，fnmatch 通配）
   - task_runs 运行记录表：每轮工具调用/参数/结果/成败落库，设置页可展开回放；每任务滚动保留 20 条
   - 任务链（管道式）：chain_next_id 声明下游，上游产出经 vault/tasks/handoff/ 交接文件传递（可人工修改后再跑）；环由深度上限兜底
   - 文件变化触发：watchfiles 独立线程监听 vault 指定路径（目录或单文件）自动跑任务；90 秒冷却 + 运行中去重 + 自写不自触
   - 无人值守加固：失败自动重试（0-3 次，仅自动触发）+ 失败邮件通知；手动运行不计重试、后台继续跑完整条链
   - 迁移：tasks 表新增 8 列（旧任务默认 simple/cron 不受影响）；tests/test_agent_orchestration.py 10 个离线用例

25. ✅ **阶段 25 — 记忆系统升级**（ROADMAP V1.4，已完成，2026-08-30）
   - 自动记忆：chat 流 done 后由模型自主判断本轮是否有值得记住的持久事实（automemory_enabled，默认关），新记忆经 SSE「memorized」事件以提示条展示
   - 相关性召回：记忆 >8 条时按当前问题向量排序只注入 top-5（embedding 模块级缓存，未变更不重算；失败静默回退全量注入）
   - 语义去重：add_memory 前与既有记忆做余弦比对（≥0.92 拒绝），手动与自动保存同路径生效
   - 记忆可编辑：PUT /api/settings/memories/{id} + 设置页原地编辑；source 列区分 🤖 自动 / 手动
   - 离线用例 tests/test_memory_upgrade.py（假向量 seam：去重/召回/编辑/automemory JSON 解析共 10 个）

26. ✅ **阶段 26 — Notes 深化：选区改写 + 笔记内对话**（ROADMAP V1.5，已完成，2026-08-30）
   - 选区改写：编辑器选中文本 → 浮动操作条（润色/扩展/精简/译英/自定义 prompt）→ 流式预览（原/新字数）→「应用到笔记」替换选区或放弃；改写期间锁定编辑防位置漂移
   - 笔记对话：右侧可开合侧栏，基于当前笔记全文问答，携带最近 6 轮历史，回答可「⤵ 插入到笔记」（光标处）或复制；与编辑器 AI 动作互不阻塞
   - 后端 /api/notes/ai 扩展 rewrite/chat；_compose_prompt 纯函数统一各动作 prompt 组装（选区上下文 8000 字、笔记 12000 字、历史 6 轮封顶）
   - 插入光标逻辑抽取 insertAtCaret 供配图/对话复用；flushSave 支持显式内容参数修复应用后保存的闭包过期问题
   - 离线用例 tests/test_notes_ai.py（prompt 组装/校验/封顶共 10 个）

27. ✅ **阶段 27 — 数据接入：本地目录进 RAG**（ROADMAP V5.3，已完成，2026-08-30）
   - core/dirs.py：注册 vault 外的本地文件夹（绝对路径），is_repo_indexable 全量扫描（≤500KB/文件、≤3000 个、SKIP_DIRS 过滤），`dirs/名称/` 命名空间入库
   - indexer 增加 DIR_SOURCE_PREFIX / EXTERNAL_PREFIXES，_prune_missing 泛化为跳过一切 vault 外来源（repos/ + dirs/）
   - DirWatcher 线程：一个 watchfiles 生成器看护全部启用目录，配置指纹变化自动重建监听集；增改重索引、删除清块，2 秒防抖
   - 防呆：绝对路径/目录存在/名称合法/不与 vault 重叠/不重复注册；停用=清索引可恢复，移除=清索引+删配置，永不触碰用户文件
   - /api/dirs CRUD + KB 页「本地目录」tab（镜像仓库 tab 交互）；tests/test_dirs.py 10 个离线用例 + 真实 embedding 端到端冒烟（含实时监听验证）

28. ✅ **阶段 28 — Skills 技能系统 + 任务可感知闭环**（ROADMAP V6，已完成，2026-08-30，基于 13+ 项目二轮调研）
   - Skills：skills/ 目录按文件夹发现 SKILL.md（极简 frontmatter 解析，无 YAML 依赖），对话注入索引 + skill_load 工具自主加载；GitHub blob/raw URL 安装带 description 校验；设置页管理区；刻意放 vault 外不进 RAG
   - token 可观测：llm.py 双协议 usage 采集（OpenAI stream_options include_usage 带 400 降级重试；Anthropic final_message），run_agentic_chat/stream_chat 可选 usage 出参；messages/task_runs 增 tokens_in/out 列
   - 任务闭环：任务列表/卡片「运行中」徽章（TaskRun status=running 反查）；winotify 桌面通知（失败必通知/智能体完成通知/desktop_notify 开关，通知失败仅降级日志）
   - 仪表盘：Token 总量卡片、近 7 天 token 曲线、任务 30 天成功率（runs_ok/runs_total）
   - 修复：dashboard 聚合查询 await 括号层级错误（冒烟抓出）；tests/test_skills.py 8 个用例

29. ✅ **阶段 29 — 基本实测 + 记忆开放为本地 MCP server**（ROADMAP V6.3，已完成，2026-08-30）
   - 真实 provider 基本实测（库副本 + 最小用例）：智能体任务 skill_load 循环 + token 捕获 + 桌面通知、聊天消息 token 落库，LIVE TEST PASS
   - 实测抓出并修复 2 个真 bug：skill_load 无法用 frontmatter 名加载（补文件夹名/元数据名双路解析）；任务/消息 token 未暴露到 API（run_task 返回 + conversations 序列化补齐）
   - app/mcp_server.py：mcp SDK 2.x MCPServer stdio 服务，memory_list/add/update/delete 四工具直通 app.core.memory（语义去重生效），与工作台共享 workbench.db
   - GET /api/settings/mcp/expose 返回接入片段；设置页记忆区展开即见 + 复制；stdio 子进程冒烟全链路通过（含去重）
   - 测试规模：49 个离线用例；livetest_v6.py / smoke_v63.py 保留供回归

30. ✅ **阶段 30 — 睡眠期记忆整理**（ROADMAP V7，已完成，2026-08-30）
   - app/core/memory_tidy.py：embedding 余弦 ≥0.86 聚类近似重复（低于保存时 0.92 阈值，抓跨会话表述漂移），union-find 分簇
   - 每簇交模型裁决 merge/keep（只许用原句信息），异常/解析失败一律跳过；合并落地为簇内最老 id 原地更新 + 其余删除 + 向量缓存失效；单轮 ≤20 簇
   - 共享 APScheduler 每日凌晨任务（prefs: memory_tidy_enabled / memory_tidy_time 默认 03:30），GET/POST /api/settings/memories/tidy，报告持久化 data/memory_tidy.json
   - 设置页记忆区：整理按钮 + 结果与合并明细展示；prefs 区新增睡眠期整理开关与时间
   - 测试规模：61 个离线用例（新增 12）；smoke_v7.py 验证 API 全链路与调度真实注册（next_run 非空）

31. ✅ **阶段 31 — 本地语音输入**（ROADMAP V8，已完成，2026-08-30）
   - app/core/asr.py + app/routers/asr.py：faster-whisper CPU int8 本地转写，模型懒加载常驻；POST /api/asr/transcribe（webm/opus，25MB 上限）+ GET /api/asr/status
   - 国内网络固化：未设 HF_ENDPOINT 自动走 hf-mirror.com + HF_HUB_DISABLE_XET=1（实测直连超时、镜像 Xet 401）
   - 前端：聊天输入框旁 🎤 录音/停止/转写三态按钮（MediaRecorder webm/opus），转写文本自动进输入框；设置页模型与语言选择（prefs: asr_model/asr_language）
   - 测试规模：71 个离线用例（新增 10）；smoke_v8.py HTTP 守卫；livetest_v8.py 真模型实测（SAPI 合成中文 → tiny 完整转写，LIVE PASS）
   - 语音播报 TTS（Kokoro）留在观察池

32. ✅ **阶段 32 — 截图问答**（ROADMAP V9，已完成，2026-08-30）
   - 📷 截屏按钮：getDisplayMedia 选屏/选窗抓帧 → 既有图片附件链路（视觉模型）；本地 OCR 兜底 POST /api/images/ocr（RapidOCR 复用，零下载），chip 悬停 🔍 提字进输入框
   - 测试规模：77 个离线用例（新增 6，真实 OCR 引擎跑 PIL 文字图）；smoke_v9.py HTTP 全链路；livetest_v9.py 真实 provider 双路径实测（OCR 全文 + qwen-vl-plus 读图答编号，LIVE PASS）

33. ✅ **阶段 33 — 语音播报 TTS**（ROADMAP V10，已完成，2026-08-30）
   - 选型调整：弃 Kokoro（310MB 模型、中文一般、依赖重）→ edge-tts 主（神经音色）+ Windows SAPI 本地兜底（零依赖离线可用）；实测 edge 偶发失败时回退生效
   - app/core/tts.py + /api/tts：哈希缓存 data/tts/、5000 字上限、GET /api/tts/audio（文件名白名单）；prefs: tts_voice / tts_engine / tts_auto
   - 前端：AI 回答悬停 🔊 播报/停止、回答完成自动朗读（可关）、设置页音色/引擎/自动朗读
   - 测试规模：86 个离线用例（新增 9，含 SAPI 真实合成）；smoke_v10.py SAPI 全链路免网络；livetest_v10.py 真实 edge 合成 + 回退路径

34. ✅ **阶段 34 — 知识图谱 RAG（Neo4j）**（ROADMAP V11，已完成，2026-08-30）
   - 选型：存用户本机已有 Neo4j（KgEntity/KgFile 标签隔离），弃 LightRAG 框架自研轻量双层检索（客户端向量匹配实体 → Cypher 一跳扩展），兼容 4.x/5.x
   - app/core/kg.py：每文件一次 LLM 抽取（严格 JSON 解析、关系仅指向已知实体、类型白名单防 Cypher 注入）、内容哈希增量构建、实体描述向量化存节点
   - /api/kg（status/config/build/query/clear）+ 聊天集成（知识库检索开启时叠加图谱上下文，off/断连静默跳过）+ KB 页「知识图谱」tab
   - 测试规模：100 个离线用例（新增 14，假图接缝免 Neo4j）；smoke_v11.py 用真实 Neo4j 验证错误路径（AuthError 上报/快速失败）；livetest_v11.py 快乐路径待用户在界面填密码后运行

35. ✅ **阶段 35 — 笔记 → 双人播客**（ROADMAP V12，已完成，2026-08-30）
   - 选型：LLM 写 host/guest JSON 脚本（禁编造）→ 逐句 edge-tts 双音色合成（V10 缓存复用）→ PyAV 解码重采样拼成单个 24kHz WAV（零 ffmpeg 依赖）
   - app/core/podcast.py + /api/podcast（list/generate/audio/delete）：data/podcasts/ + index.json（元数据+文稿，不进 vault 不污染 RAG）；40 轮/单句 400 字/输入 15000 字上限
   - 前端：笔记页 🎙 播客侧栏（一键生成、双音色选择、历史播放、文稿、删除）+ 设置页双音色偏好
   - 测试规模：119 个离线用例（新增 19，含 PyAV 真实解码/拼接）；smoke_v12.py 守卫全链路；livetest_v12.py 真实链路 76s 产 13 轮/109s WAV 且内容忠于笔记（期间修复：系统提示词漏发导致模型输出散文）

36. ✅ **阶段 36 — Artifacts 轻执行环境**（ROADMAP V13，已完成，2026-08-30）
   - opt-in：默认关，设置页开启后聊天代码块出「▶ 运行」（python/js 子进程，独立临时目录/硬超时/输出截断）与「▶ 预览」（html 前端 sandbox iframe，不进后端）
   - Python 用工作台 venv（可直接 import 项目依赖）、JS 用本机 node；失败保留运行目录供排查
   - 前端 CodeBlock 语言识别（language-* class）+ 结果面板（退出码/耗时/输出）+ 设置页开关与超时（1-120s）
   - 测试规模：132 个离线用例（新增 13，真实子进程）；smoke_v13.py HTTP 全链路（真实执行含 node/超时击杀/截断），无需单独 livetest

37. ✅ **阶段 37 — 智能体协作（确定性模式）**（ROADMAP V14，已完成，2026-08-30）
   - 弃自主编排（成本/稳定性），落地「流水线」与「评审回路」两种确定性模式；工具调用 v1 关闭
   - app/core/collab.py 编排核心 + POST /api/agents/collab（目标与文稿分别落库为 user/assistant 消息）+ 前端 👥 协作弹层与流式渲染
   - 修复：修订步初稿被评审输出覆盖（单独跟踪 draft）、resolve 异常导致 SSE 无 done 事件、ResolvedModel 未解包
   - 测试规模：151 个离线用例（新增 19）；smoke_collab.py 守卫与 SSE 错误路径；livetest_collab.py 真实评审回路 35s 通过

38. ✅ **阶段 38 — 播客深化：多笔记合并 + 每日简报自动转播客**（ROADMAP V15，已完成，2026-08-30）
   - 播客面板来源升级为多选 chips（≤5 篇合并）；digest 定时任务成功后 opt-in 自动 from_digest 转播客（best-effort，不影响摘要/邮件）
   - podcast.generate 重构出 generate_from_blocks 预收集入口，digests/ 等生成目录仅对新入口开放
   - 测试规模：157 个离线用例（新增 6）；smoke_podcast_daily.py prefs 往返；livetest_digest_podcast.py 真实链路 15 轮/120s 通过并清理

39. ✅ **阶段 39 — 播客生成进度流式反馈**（ROADMAP V16，已完成，2026-08-30）
   - generate_from_blocks 重构为 (stage, data) 进度迭代器，generate/from_digest 包装不变；新增 POST /api/podcast/generate/stream SSE 端点
   - 前端生成按钮实时显示阶段进度（写脚本/配音 n/N/拼接）+ 双音色相同提醒
   - 测试规模：159 个离线用例（新增 2）；smoke_podcast_stream.py；livetest_podcast_stream.py 真实链路完整 stage 序列 107s 通过

### v0.2（按真实痛点排序，用到再加）
- MCP 工具接入（mcp 官方 Python SDK）：文件系统操作、浏览器等现成 server
- 混合检索：FTS5/rank_bm25 + 向量 RRF 融合（Open WebUI 同款）
- APScheduler 定时任务：每日/每周笔记摘要推送
- 网页剪藏：浏览器扩展或粘贴 URL 抓取入库（beautifulsoup4）

### 明确不做
账号体系、云同步、移动端、多人协作、扫描版 PDF OCR（后期看 Khoj 的 rapidocr 方案）、语音。

## 四、目录结构（阶段 1 落地时创建）

```
D:\TP\A\
├─ backend/
│  ├─ pyproject.toml        # uv 管理
│  ├─ app/
│  │  ├─ main.py            # FastAPI 入口 + 静态托管前端产物
│  │  ├─ config.py          # pydantic-settings，配置读写
│  │  ├─ db.py              # SQLAlchemy async engine/session
│  │  ├─ models.py          # ORM: Conversation, Message, ChunkMeta, Provider
│  │  ├─ routers/           # chat / notes / kb / settings
│  │  └─ core/              # llm / indexer / retriever / ingest
│  └─ tests/
├─ frontend/                # Vite + React + TS + Tailwind + shadcn/ui
│  └─ src/pages: Chat / Notes / KB / Settings
├─ vault/                   # 用户笔记（.md，gitignore 视情况）
├─ data/                    # workbench.db + chroma/ + images/ （gitignore）
├─ backups/                 # 备份 zip（滚动保留 N 份，可改目录，gitignore）
└─ PLAN.md                  # 本文档
```

## 五、验证方式
- 阶段 1：`uv run uvicorn app.main:app --reload` + 前端 dev server，真实 API key 流式对话、重启后会话仍在。
- 阶段 2：放几个 md 进 vault，观察索引日志；调试页检索验证相关性。
- 阶段 3：问"我记过的 XX 是什么"，回答带引用并可跳转原文件。
- 阶段 4：拖入 pdf/docx 提问，内容可被引用。

## 六、风险与对策
- Windows 下 watchfiles/路径编码：统一 pathlib + UTF-8，早期用真实中文文件名测试。
- 本地 embedding 模型首次下载慢：设置页提供"embedding 来源=本地/API"切换兜底。
- ChromaDB 与 SQLite 元数据一致性：以 vault 文件为准，索引可随时全量重建（幂等管道）。
