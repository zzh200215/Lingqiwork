# R1 / R2 / R3 只读检查清单（PLAN5 §3 的执行拆解）

> 2026-09-18 立。立这份东西的规矩来自 PLAN5 §6：
> **「每条 R 开工时照老规矩另出只读检查清单，不直接动代码」**——所以本页只做三件事：
> ① 把每条 R 拆成可核的步骤；② 标出每一步会碰到哪些现成设施；③ 把**越界的诱惑**写下来。
>
> 开工前先读 `docs/testing.md`（跑法 + 两个坑）与本节 §0 的踩坑纪律。

---

## §0 讨论中已拍板的五件事（2026-09-18）

| # | 问题 | 决定 |
|---|---|---|
| 1 | R1 的形态 | **扩现有 `/dashboard`**：补进接地分 / 判分基线 / 回合读数，抽一个统一的「读数块」组件。**不新增导航入口**（守 2026-09-13 那次导航收缩） |

> **2026-09-18 补注（导航改版）**：上表第 1 条只管 R1 当时的做法，它做到了——仪表盘仍然
> 在「资产」下面。同一天稍后**用户提出**把侧栏从「五个平铺的大区」改成**可展开的分组**，
> 于是 `/notes`、`/kb`、`/dashboard`、`/companion` 都成了子项，**2026-09-13 那次导航收缩
> 的政策到此为止**。形状、理由与「页面里那排标签栏一并删掉」的决定都写在
> `frontend/src/routes.tsx` 的 `NAV` 上方；测试在 `routes.test.ts` / `Layout.test.tsx`。
| 2 | 接地分上墙要不要带 `engine_eval.health()` 的自检警告 | **带**。它是「这把尺子还信不信得过」的自检，与 §4-8「读不到 ≠ 零」同族 |
| 3 | R2 与已有「语音日记」的关系 | **分工，并写进文档**：journal = 桌面前马上记（已有，**一个字节不动**）；R2 = 手机/外部录音文件的落地与分诊 |
| 4 | 「转写完成」要不要弹桌面通知 | **不弹**，只走气泡。照 `pet.note_output` 那条先例（走 `emit()` 既有闸门，不新增通知白名单） |
| 5 | R3 的 kind | **改名 `session`**（PLAN5 字面）。真库 `thread_items` / `tutor_sessions` 都是 **0 行**（2026-09-18 探针数过），所以没有回填风险 |

---

## §1 开工前的踩坑纪律（`docs/testing.md`，逐条守）

1. **探针/临时脚本一律用 write 写成 `.py`（UTF-8）再执行，绝不 `pwsh -Command` 内联中文**
   —— 本地代码页会把中文变成乱码，而**乱码看起来像一个 bug**（这一条最贵）。
2. 改一处看结果：
   `.\.venv\Scripts\python.exe -m pytest tests/test_<那个>.py -q --no-header -p no:cacheprovider`（7–30 秒）。
3. 收工前验一轮：`.\.venv\Scripts\python.exe run_tests_fast.py`（约 4 分钟）。
   **不要**为快把全量塞进一个进程（实测 9 个假失败）。
4. 看全量结果**不要截断**（`| Tee-Object -FilePath full_run.txt`）。收集阶段的失败按
   `[retried after a collection error]` 读；`test_tts` / `test_websearch_parser` 并发下偶发，
   **先单独复跑再当回归**。
5. 新增一张会被写的表 → 同时想清楚**谁负责收**（`_clear()` 里补掉），否则跨用例串味。
6. **别对着磁盘数总数**（`vault/tasks/` 那类会跨用例可见），数「该在的那几个在不在」。
7. `smoke_cross.py` 退出码 1 是**正常**的（它守的是「没有可用阈值，这一层不上线」）；
   `smoke_skill_match.py` 退出码 0 才是绿。跑真模型的脚本先 `--dry`。

---

## §2 R1 · 计量局：扩现有 `/dashboard`

### 2.1 现状（已核，2026-09-18）

九条尺子里**八条已经在同一页上**了（`frontend/src/DashboardPage.tsx`）：

| 尺子 | 端点 | 现落点 |
|---|---|---|
| 北极星 | `/api/dashboard/north-star` | `NorthStarCard` |
| 半懂率 | `/api/dashboard/process` | `ProcessCard` |
| 校准（卡） | `/api/cards/calibration` | `CalibrationCard` |
| 会话校准 | `/api/tutor/calibration` | 同一张卡下半 |
| 矛盾率 | `/api/cards/contradiction-rate` | `GapRateCard` |
| 回指采纳 | `/api/cards/prereq-adoption` | 同一张卡下半 |
| 试用期漏斗 | `/api/dashboard/skill-loop` | `SkillLoopCard` |
| 注入命中率 | 同上 | 同一张卡下半 |
| **接地分（引擎）** | `/api/evals/engines/latest` | ❌ 设置在**设置页** |
| **判分器基线** | `judge_eval.baseline_note_for_curve()` | ⚠️ 只在校准卡页脚一行 |
| **回合读数** | `/api/turns` | ❌ 在**设置页**（`TurnLedger`，诊断工具） |

> **更正（2026-09-18 复核时补）**：这张表当时漏了一条——PLAN5 §2-2 的九条里还有
> **`prompt_eval`（提示词评测）**，而它当时**一处都不在墙上**（只在提示词实验室里）。
> 上面那句「七条」也数错了：表里前八行当时都已经在页面上（八条，不是七条）。
> 复核时补上了这一格：`prompt_eval.board()` + `GET /api/dashboard/prompt-eval` +
> `PromptEvalCard`（与接地分同族；**只给计数**，不摆任何一条提示词的名字或分数）。

### 2.2 一个让 R1 变便宜的核对结果（2026-09-18）

**三条缺的读数里，两条的后端端点已经是现成的**：

- `GET /api/evals/engines/latest`（`routers/evals.py:260`）**已经返回了全部三样**：
  `by_engine`（含 `grounded`）、`coverage`（各引擎 golden set 条数）、
  `warnings`（`engine_eval.health()` 的自检原话）——**后端一个字节都不用改**，
  R1 的接地分那一格是纯前端（设置页现在读的就是它）。
- 判分基线同理：`judge_eval.baseline_note_for_curve()` 已经是三态，`cards.calibration` 正在吐它。

→ **R1 的后端新工作只剩「回合读数」一条**（`/api/turns` 是逐条列表，上墙要的是一个聚合计数，
   大概率是新加一个 `only=` 分组计数，或前端现算——**前端现算会造出第二份判据，倾向新增后端聚合**）。

### 2.3 步骤

1. **抽「读数块」组件**（`frontend/src/`，名字待定，如 `MetricCard.tsx`）：
   统一承载现有六张卡反复出现的四件事——`readable=false` 时摆 `—` 不摆 0 / 口径与已知偏差
   从后端 `rules` 原文照抄 / 空数据只陈述不催 / 未读到整块不渲染。
   **这不是重构现有六张卡**（它们各自有测试钉着）：先只给新三条用，等新三条稳了再议是否回迁。
2. **接地分上墙**：读 `engine_eval.latest_by_engine()` + `engine_eval.health()`。
   - 四个引擎各摆**接地分均值 + 条数**（`grounded=null` 时照 §4-8 说读不到，不补 0）；
   - `health()` 的 `warnings` **原文照抄**（尤其「接地分全在 4.5 以上……区分度低」那句）；
   - 红线复查：这是唯一一条**不是曲线而是分数**的读数——不许出现目标线、不许给百分比排名。
3. **判分基线**：现在只在校准卡页脚。决定是**提到独立一格**还是**保持页脚但补上"跑过/旧版/没跑过"三态**（`_baseline_note()` 已经是三态了，多半只需保证它看得见）。
4. **回合读数**：`/api/turns` 是**诊断工具不是考核仪表**（`turns.py` 开篇明文：没有「好回合」筛选项、没有百分比、没有排行）。上墙时**只能摆事实计数**（近 N 轮里各毛病几例），**不许**做成功率——否则它会立刻变成 KPI。
5. **每条新端点补「跑完宠物一个字没说」的测试**：后端照 `tests/test_metrics.py:180` /
   `test_calibration.py` 那两条的形状（真跑一遍 + 断言无 `pet_events` 行 + 源码里没有 `pet.*`）。
   **前端整页渲染目前一次都没测过**（`DashboardPage.test.tsx` 只渲染五张导出的卡，
   顶部 `vi.mock('./api', () => ({ api: {} }))`），所以「这页不说话」**不能只靠前端测试**。

### 2.4 越界的诱惑（写下来免得顺手做掉）

- ❌ 不把仪表盘挂回主导航（§7.3 导航收缩）。
- ❌ 不给任何一条加目标值 / 排名 / 同比环比颜色（§4-2）。
- ❌ 不做「接地分连续走低就提醒」——那是 PLAN5 §3 R1 的**可选二期，本份不批**。

### 2.5 R1 落地结果（2026-09-18 完成）

**做完了，全绿**：后端 `run_tests_fast.py` 91 文件全过；前端 `vitest` 35 文件 / 437 用例全过；
`tsc -b` 干净。

| 步骤 | 落在哪 |
|---|---|
| 回合读数聚合 | `core/turn_trace.py`：新增 `_summary_rows(since, cap)`（**I/O 只在这一处**）+ `summary(days, max_rows)` |
| 端点 | `routers/dashboard.py`：`GET /api/dashboard/turns`（扩现有 `/dashboard`，**没动导航**） |
| 前端契约 | `api.ts`：`TurnSummary` + `api.turnSummary()` |
| 读数块组件 | 新建 `MetricCard.tsx`（只给新三条用，**没回迁**那六张有测试的卡） |
| 接地分卡 | `DashboardPage.tsx`：`GroundedCard`（+ `GROUNDED_RULES`） |
| 回合读数卡 | `DashboardPage.tsx`：`TurnSummaryCard` |
| 判分基线 | `CalibrationCard` 内单独提一行 `data-calibration-baseline`（**决定：提上来，不新建卡、不保持页脚**） |
| 后端测试 | `tests/test_turn_trace.py` 新增 9 条（窗口 / 截断 / 读不到 / 无 pet / 无 `pet.*` / HTTP） |
| 前端测试 | `DashboardPage.test.tsx` 新增 13 条 |

**两个真 bug，都是测试逮住的**（记在这里，因为它们是这一类卡最常见的错法）：

1. **`readable={!!t}` 是错的**。后端在「读不到」时**照样回一个对象**
   （`readable:false` + 一排 0 + 错误原话），所以 `!!t` 恒为 `true`——那张卡会把
   「读不出来」渲染成一屏 0，**正是它该防的那件事**。读可读性必须读 `t.readable`。
   *通用教训：凡是「读不到也要给形状」的端点，前端都不能用对象是否存在来判可读性。*
2. **`error` 没传下去**，壳只会说「原因没给出来」；读不到时那句错误原话就是唯一线索。

**一处契约要知道**：`cards.calibration` 的 `notes[0]` **就是**判分基线
（`[_baseline_note(), *CALIB_NOTES]` 的第一条），页脚那两条才是常年不变的口径；
混版警告由后端 `insert(0)` 插在基线**之后**，所以它会成为页脚第一条。
前端 `baseline = c.notes?.[0]`、`notes = c.notes?.slice(1)` 就是照这个顺序切的。

---

## §3 R2 · 语音进料

### 3.1 现状（已核，2026-09-18）

**已经有一条活的语音→知识链路**（R2 通篇没提它）：

```
仪表盘「语音日记」→ 浏览器录音（useVoiceInput / voice.ts）
  → POST /api/asr/transcribe → vault/journal/YYYY-MM-DD.md
  → VaultWatcher → indexer 索引 → 可检索
```

**会议闭环那套设施比想象中现成**（R2 可以直接照抄）：

| 设施 | 出处 | 对 R2 的意义 |
|---|---|---|
| `TriggerWatcher` 用 `ingest.is_triggerable` | `core/triggers.py:95` | **音频扩展名清单已经在里面**，注释写着「音频不解析、不进索引，但它得能让 watcher 看见」 |
| `ingest.AUDIO_EXT` | `core/ingest.py:16` | m4a/mp3/wav/webm/ogg/flac/aac/mp4/opus |
| `tasks._transcribe` | `core/tasks.py:902` | 现成的转写步骤，返回 `{answer, sources, model_id:"asr", …}` |
| `install_meeting_preset` | `routers/tasks.py:476` | 现成的 preset 样板：`watch_path="meetings/inbox"` + 链 + 幂等 |
| `watch_path` 校验 | `core/tasks.py:89` | **必须 vault 内相对路径**（越界直接抛） |

### 3.2 步骤

1. **定收件目录**：`vault/voice/inbox/`（与 `meetings/inbox` 同形）。**必须落 vault 内**——
   `normalize_watch_path` 只认 vault 相对路径。手机同步盘那条路 = 同步进 vault 的某个子目录。
2. **装一条 preset**（照 `install_meeting_preset` 再造一条，幂等、第一个名字即身份）：
   - 第 1 步走 **3.3(b) 定的新 action**（不是 `"transcribe"`，原因见 3.3）、
     `trigger_kind="watch"`、`watch_path="voice/inbox"`；
   - 转写正文落成 md（落哪见 3.3(a)），落成 md 后自然进 `VaultWatcher` → 索引。
3. **那一问**（材料 / 工作留痕）：**拉取式**——不进 nudge 五来源、不催、不计数。
   形态参考 `AttachToThread`（就地两个按钮，不新造交互）。
4. **转写完成**：走 `pet.emit()` 的既有闸门 + 气泡；**不新增通知白名单**（拍板 #4）。
5. `pet.emit` 是**同步 sqlite3、不 await**（`core/pet.py:12-14` 开篇），从异步转写路径里调要走 `to_thread`。
6. ⚠️ **一条待验的猜测（先证伪再动手）**：`trigger` 交给转写步骤的 `watch_files`
   是 `triggers._to_rel()` 产出的 **vault 相对**路径（`core/triggers.py:116` → `triggers.py:143,149`
   → `run_task(..., watch_files=matched)`），而 `tasks._transcribe` 开头是
   `src = VAULT_DIR / rel`（`core/tasks.py:912`）——**那是当相对路径用**，两边看着对得上。
   但 `run_dir` / `watch_files` 这一族的路径**口径混用是真的**：`_land_audio` 把 `run_dir`
   当 vault 相对用（`VAULT_DIR / run_dir`，`tasks.py:892`），`thread_name_for_run_dir` 按 `/`
   切它（`tasks.py:717`），而 `_transcribe` 拿到的是 `VAULT_DIR / rel` 拼出来的**绝对** `Path`
   ——三个地方各信一种口径，所以：
   **抄会议 preset 之前，先真跑一遍会议闭环**——放一段音频进 `vault/meetings/inbox/`，
   看转写是成是败、`meetings/<日期>-<名>/` 里有没有 `audio.*` 与 md。
   若这一遍是通的，R2 照抄即可；若不通，那是**已有 bug，不属于 R2 范围**，
   先记账、单独定谁修，**不要顺手改**。

### 3.3 R2 的三个待定项（2026-09-18 已定）

| # | 决定 | 后果 / 为什么这么定 |
|---|---|---|
| a | **转写文本落 `vault/voice/`**（原料区与 `journal/` 分开） | 两个语音入口、两个不同寿命的账本——`journal/` 是「我说的话」按天追加，`voice/` 是外部录音的落地。**`journal` 一个字节不动**（拍板 #3 的分工） |
| b | **转写成功后删掉录音，只留文本** | 红线「录音不进 vault 正文区」因此**在字面上也成立**了。代价写在明处：**转写错了没得重听**（ASR 不是 100%） |
| c | **不自动挂「一件事」** | 要不要归到某件事，正是「那一问」里「工作留痕」那个分支要问的事。`_PER_INSTANCE_DIRS` 不动（现在只有 `meetings`） |

#### (b) 决定的连带影响：`_transcribe` **不能原样复用**

`tasks._transcribe` 的收尾是 `_land_audio(src, run_dir)`——它 `shutil.move` **把录音搬进落点目录**
（`core/tasks.py:885-899`）。这正是会议闭环要的，也是**已钉死的行为**：
`tests/test_agent_orchestration.py:879`（转写步骤读触发它的那段录音）与 `:933`
（`test_run_dir_is_inherited_down_the_chain`，断言四步全落同一个 `meetings/<日期>-<名>/`）
都依赖它。

所以 R2 要的是一个**新模式**，不是改 `_transcribe`：

- 新增一个 `action`（如 `transcribe_note`，或给 `_transcribe` 加一个显式开关），
  行为 = 「转写 → 正文写进 `vault/voice/<日期>-<名>.md` → **删掉录音** → 落成 md 后自然进索引」；
- `meetings` 那条路**一个字节都不动**（那两条测试不许红）；
- 新 action 要进 `tasks._execute` 的分派，并从 `routers/tasks.py` 的 `/tools` 清单里可见。

#### 一条随之而来的设计约束：文件名与标题**都要零模型**

md 落成之后要能被**搜得出来**，靠的是「文件名 + 第一个一级标题」（检索命中列表读的是这个，
`threads._vault_title()` 读的也是这个）。而 `?` 的诱惑是「让模型读一遍起个标题」——
**那会多加一次模型调用**，直接顶掉验收里的「≤1 分钟」，也与「确定性优先」（§4-10）相反。

所以：**文件名带时刻**（`voice/YYYY-MM-DD-HHMM.md`，与 `journal` 的按天追加不同——一天可能录好几条），
**H1 就是「语音备忘 YYYY-MM-DD HH:MM」**，正文照抄转写。要认得出是哪条，靠检索命中里附的
**转写原文片段**，不靠另起一个摘要标题。（`journal` 用的是「按天一个文件 + `## HH:MM` 分块」，
那是为 Obsidian 里翻看设计的；`voice/` 一条一个文件更合适，因为它的下一个归宿是**分诊**
（材料 / 工作留痕），一条一个文件才好被回答。）

### 3.4 验收时要写明的现实

- 「60 秒录音 ≤1 分钟」**冷启动不成立**：`asr` 模型首次要下载（tiny≈75MB / small≈480MB，走 hf-mirror），
  且首次加载在 scheduler 线程里发生。验收要区分「模型已热」与「冷启动」两种。
- `pet.emit` 的冷却/轮换是**按 kind 数历史行**（`Z3`），新 kind 第一句永远是原话。
- (b) 的「删掉录音」让 `dashboard.vault_files` 不会因为音频而长大——
  但**会议录音仍然在数里**（`_land_audio` 搬进 `meetings/<…>/audio.m4a`）。
  顺手修「只数文档」属于**越界**：那是另一个决定（或者照 §4-9 增强不挡路，直接不改）。

### 3.5 R2 落地结果（2026-09-18 完成）

**做完了**，全绿（后端 91 文件；前端 35 文件 / 439 用例；`tsc` 干净）。

> *2026-09-18 复核订正*：这里当时写的是「后端 92 文件」——**数错了**，一直是 91
> （`backend/tests/test_*.py`）。前端 439 是那天的数；补完「提示词评测」那一格后是 447。

| 步骤 | 落在哪 |
|---|---|
| 新模块 | **新建 `core/voice_note.py`**：`VOICE_DIR = VAULT_DIR/"voice"`、`_title()`、`_pick_path()`、`write_note()` |
| 新 action | `core/tasks.py` 的 `_transcribe_note()` + `_execute` 分派；`routers/tasks.py` 的 `_VALID_ACTIONS` |
| preset | `routers/tasks.py` 的 `POST /api/tasks/preset/voice`（**一步** watch，不是链）+ `api.ts` 的 `installVoicePreset` |
| UI 入口 | `WorkPage.tsx` 工作流空态的第二个按钮（「装一条语音备忘」，`data-install-voice`） |
| 测试 | `test_agent_orchestration.py` 新增 5 条语音测试（含**反向钉子**：会议那条路仍留原声）+ 1 条 preset 幂等测试 |

**几个落地时才知道的细节（写给下一个人）：**

1. **`voice_note` 读 `app.config.VAULT_DIR` 算出模块级 `VOICE_DIR`**，而 `tasks` 用的是它自己的
   `VAULT_DIR`——两个名字。测试必须**两个一起 patch**（`_fake_vault()` 就是干这个的），
   否则会出现「按假 vault 找录音、往真 vault 写文本」：断言在假 vault 里永远找不到文件。
   同一个坑这个仓库在 `turn_quality` 那里已经踩过一次（注释就写着「读 `mcp.VAULT_DIR`，
   不是 `app.config.VAULT_DIR`」）。**这是这个仓库里最贵的一类坑，凡涉及 vault 的测试先对它。**
2. **vault 目录要每条用例一份**：本文件共用模块级 `_TMP`，几条语音测试若都往
   `_TMP/vault/voice` 写，上一条落下的 md 会被下一条看见——「失败时不该有文件」这种断言
   会因为别人留下的文件而挂，且**顺序一变就换个姿势挂**。所以 `_fake_vault()` 用 uuid 后缀。
3. **删除失败不算这一步失败**：转写已经落盘了，这时抛错只会让人以为没转成功而去重试，
   结果是同一段录音转第二遍、留下第二份一模一样的 md。所以 `unlink()` 失败只记日志 +
   在回执里说一句「原录音还在，没能删掉」。
4. **空转写不算成功**：不写一份「搜得到、点开什么都没有」的产出，也不删录音。
5. **`voice/` 故意不进 `pet._OUTPUT_DIRS`**：它不是引擎成品。所以 `run_task` 那句
   「跑完了」（`task_done`）照常发——一件事一句话，不额外加通知白名单（拍板 #4）。
6. **plan 里那句「从 `/tools` 清单里可见」记错了**：`GET /api/tasks/tools` 是**给模型看的
   工具清单**（`mcp_manager.tool_specs`），不是任务动作清单。新 action 可见的地方是
   **`_VALID_ACTIONS`**（决定建任务时能不能选它）。两条都核过，没动 `/tools`。

### 3.6 「那一问」（材料 / 工作留痕）——~~本份不做~~ **同日补做**（2026-09-18）

**当时的判断**（留在这里，因为它决定了补做时的形状）：§3.2 第 3 条那个「拉取式的一问」
本份**没有实现**，是**明确推迟**，不是漏掉：

- R2 的进料链路本身已经完整可用（录音进 `voice/inbox` → 文本落 `voice/` → 自动进索引），
  preset 按钮也已经在「工作 · 引擎」的空态里；
- 「归到哪件事」需要一个**语音备忘列表 + 每条两个按钮**的界面，还要新的后端接口
  （列表 + 分类落点）——工作量与 R2 主体相当，混在一起做会把 R2 的验收拖长；
- 它也不挡路：现在归类的办法是现成的（`AttachToThread` 在卡片行与判断行都在用，
  语音备忘作为 `note`/`material` 一样能在「一件事」页面上挂）。

**补做结果（2026-09-18 稍后，两个方向都问过用户才动手）**：

| 步骤 | 落在哪 |
|---|---|
| 单子与判据 | `core/voice_note.pending()`：`_on_disk()`（只读磁盘）+ `_answered()`（**两条既有路上的痕**：`digest_points.source` / `thread_items.ref`） |
| 端点 | `routers/notes.py` 的 `GET /api/notes/voice`（`readable=false` = 读不到，**不是**「都归类完了」） |
| 界面 | 新组件 `frontend/src/VoiceTriage.tsx`，摆在**笔记页**文件列表顶部；搜索时让位 |
| 「当材料」 | 既有的 `POST /api/tutor/digest`（`source_path` = 那份 md）——**只拆点，不自动建卡**（出卡仍在学页手动点） |
| 「工作留痕」 | 既有的 `AttachToThread kind="note"`，给它加了 `label`（按钮叫「工作留痕」）与 `onAttached`（挂完把这一份从单子上划掉） |
| 测试 | 后端 6 条（`test_agent_orchestration.py`，含「读不到 ≠ 都归类完了」「看一眼不让零柒说话」）；前端 8 条（`VoiceTriage.test.tsx`，含「不摆计数」） |

**两个被拍板的方向**（用户选的，不是我定的）：列表摆**笔记页**（语音备忘本来就是 vault 里的
一份 md，`/notes` 已经在列它）；「当材料」**只拆点、不自动建卡**。

**没做的一件事**：真机上没验过（8000 那个进程是改动之前起的，新端点 404 → 界面照规矩
整块不渲染）。要验的话：重启后端，往 `vault/voice/inbox/` 丢一段录音。

### 3.7 真机验收结果（2026-09-18，**真音频 + 真 ASR，不是 mock**）

R2 的测试全都是把 `asr.transcribe` 换掉的（快、不依赖模型），所以另跑了一遍真机。
做法：用项目**自己的** `tts.synthesize()` 造一段中文语音（edge 成功、无需 SAPI 兜底），
`VOICE_DIR`/`VAULT_DIR` 一起指到临时目录，然后跑**真的** `core.run_task`。

| 验的是什么 | 结果 |
|---|---|
| 端到端 | `status=ok`，录音 → md → 删录音，全通 |
| **速度** | 冷 **13.3s**（含 `small` 模型加载）/ 温热 **4.1s**，另一次温热 **5.9s** —— 验收线是 ≤1 分钟 |
| 中文准确度 | 原话「记一下，周五之前把报价发给客户，另外下周三要开产品评审会」**一字不差**（标点被规整成半角逗号） |
| 落盘形状 | `voice/2026-09-17-1945.md`，H1 = `语音备忘 2026-09-17 19:45`，正文带 `> 来源：…（转写完成后原录音已删除）` |
| 删录音 | **是**（走完整 task 那一次：`录音还在吗 = False`） |
| 回执 | `vault_file = voice/2026-09-17-1945.md` |
| **进索引、搜得到** | 隔离索引（Chroma 指向临时目录、只放这一份）后真检索：`'报价 客户'` 0.576 命中、`'语音备忘'` 0.728 命中、`'评审会'` 0.626 命中；**不相干的** `'量子力学 薛定谔'` 只有 0.500 —— 有区分度，不是无差别乱命中 |

**⚠️ 这一条的数字要连着前提读**：`small`（464MB）**当时已经在本地缓存里**，
所以那个 13.3s 是「模型已在盘上、只需加载」的冷启动。
**真正的一次性首跑还要加上下载**（tiny≈75MB / small≈480MB，走 hf-mirror），
那一段不在 13.3s 里——§3.4 已经写明「验收要区分模型已热与冷启动」，这里给的是**前者**。

跑完探针与临时目录都删了，真 vault 一个字节没动（跑之前之后都核过顶层目录）。

---

## §4 R3 · 学习挂事

### 4.1 现状（已核，2026-09-18）—— PLAN5 §2-3 的措辞要更正

PLAN5 写「七种挂接全在工作侧……学习侧只有『卡』挂了半个」，**代码里不是这样**：

- `core/threads.py:29` → `KINDS` 里**已经有 `"tutor"`**（引用 `TutorSession`）；
- `_catalog()` / `_resolve()` / `_href()` 三处都已支持它（`threads.py:185,216,224-228,243,272`）；
- `core/tutor.py:642 _neighbors_via_thread()` **已经在校它**；
- `frontend/src/api.ts:1247` 的 `ThreadKind` 里也有 `'tutor'`。

**真正的缺口只有一处**：`AttachToThread` 只挂在两个地方（`CardList.tsx:173` 卡片行、
`DashboardPage.tsx:662` 判断行）——**TutorPage 上一处都没有**。所以 R3 不是「新建第八种 kind」，
是「已存在的 kind 缺一个入口」。

### 4.2 步骤（按拍板 #5：改名 `session`）

1. **后端改名**：`core/threads.py` 的 9 处（`KINDS` / `STEPS` / `_catalog` / `_resolve` ×3 / `_href`）
   + `core/tutor.py:655,664` 两处查询。
2. **数据迁移**：加一条 `Migration(14, …)`，`UPDATE thread_items SET kind='session' WHERE kind='tutor'`。
   真库 `thread_items` = **0 行**，所以它在真库上是 no-op；但**迁移仍要写**——别人的库、备份恢复的库
   可能有行。`run(dry_run=True)` 一个字节都不写，先 dry 再真跑（`migrations.run` 会先自动备份）。
3. **前端**：`api.ts:1247` 的 `ThreadKind`、`TutorPage.tsx:1908` 的 `kind="tutor"`。
4. **测试**：`tests/test_threads.py:132`（`_href`）、`tests/test_tutor.py:2048-2049`（造 kind 行）、
   `frontend/src/ThreadsPage.test.tsx:28`（五步 kinds 清单）。
5. **补入口**：会话完结那一格（自评 / 让它判之后，`TutorPage.tsx` 约 2884–3030 区间）
   放 `AttachToThread kind="session" ref={String(sid)}`。**默认不自动挂**（PLAN5 红线：
   每场都自动挂会淹没工作侧挂接）。

### 4.3 越界的诱惑

- ❌ 不生成「该学什么」（挂事是记录不是待办，§5）。
- ❌ 不在会话**开始**时就摆挂接按钮——那会变成每次开课都要处理的待办。
- ❌ 不接受 `tutor` 与 `session` 两个名字并存（同一个东西两个名字 = §4-7「一事一处」要防的分叉）。

### 4.4 R3 落地结果（2026-09-18 完成）

**做完了**，全绿（后端 91 文件；前端 35 文件 / 439 用例；`tsc` 干净）。

> *2026-09-18 复核订正*：「后端 92 文件」数错了，一直是 91（理由见 §3.5 那条注）。

| 步骤 | 落在哪 |
|---|---|
| 后端改名 | `core/threads.py`：`KINDS` / `STEPS` / `_catalog` / `_resolve` ×3 / `_href`；`core/tutor.py`：`_neighbors_via_thread` 两处查询 |
| 数据迁移 | `Migration(14, …)` = `UPDATE thread_items SET kind='session' WHERE kind='tutor'`（只改值、不动表） |
| 前端 | `api.ts` 的 `ThreadKind`、`TutorPage.tsx` 那个 `kind="tutor"` → `kind="session"` |
| 新入口 | `TutorPage.tsx` 会话结束那一行（自评 / 让它判之后）加 `AttachToThread kind="session"` |
| 测试 | `test_migrations.py` 新增 v14 一条（**造行 → 撤账本 → 重跑 → 断言值改了且只改那一个**）；`TutorPage.test.tsx` 新增一条（评完才出现 + kind/ref 两个参数都钉住） |

**两处要记下来的更正：**

1. **§4.1 关于 R3 缺口的判断偏了**：我当时写「`AttachToThread` 在 TutorPage 上一处都没有」，
   实际 `TutorPage.tsx:1908` **早就有一个**（在概念卡展开区里，`ref={c.last_session_id}`）。
   所以 R3 的缺口比我记的更小：**不是「没有入口」，是「入口藏在一个要先展开才看得见的地方」**，
   而且它的 `kind` 也是旧的。真正的改动因此只有两件：改名、把入口摆到「刚聊完这一场」那一刻。
   *教训与 `docs/testing.md` 那两条同类：看着像「一处都没有」的结论，要先 grep 一遍再写进文档。*
2. **`_href` 只改 kind 一侧，不动路由**：`session` 是「挂的是哪一类东西」，
   而 `/tutor?session=` 是**前端路由**——页面路径仍然叫 `/tutor`。
   改名去动路由会连书签一起动，那是另一件事（R3 不做）。`test_threads.py` 那条断言现在
   左右两边故意不一样，并把原因写在旁边。
3. **补了一条「接通性」测试**（`test_a_session_attached_to_a_thread_reads_back_with_its_topic`）：
   单点断言（`KINDS` 里有、`_href` 对）**挡不住「整条链漏改一处」**，而漏改的表现是
   「挂接静默失败」或「挂上了但标题空、图标灰」——两种都不报错。这条一次走完
   写（`attach` 的 kind 守卫）→ 读（`_resolve`）→ 反向消费（`tutor._neighbors_via_thread`）。
   *写这条时我先用 `concept_neighbors` 当断言，挂了两次*——第二次才想明白：它外面还套着
   `concepts()` 那层派生视图（按 verdict 过滤、按 `CONCEPTS_CAP` 截断），
   拿它当断言等于在测「派生视图的容量」。**要验哪条缝就考哪个函数**，改名要验的缝是
   `_neighbors_via_thread`，考它就一句话。

---

## §5 排期与文档改动（PLAN5 §3 原样 + 两条补充）

R1 → R2 → R3，理由照 PLAN5：先让上一程的效果在墙上看；R2 解锁转速但要新交互、纪律上要慢；
R3 最轻、收尾。

**补充一**：R2 的三个待定项已在 §3.3 定完（设计决定，不是实现细节）。

**补充二**：开工时**要顺带改的几处文档**（都属于「同一个词在两处必须是一个意思」）——
**2026-09-18 三条全部改完**：

1. ✅ PLAN5 §2-3「学习侧只有卡挂了半个」→ 已加「落地更正」框：`kind="tutor"` 早已存在，
   `AttachToThread` 在 TutorPage 也早已有一个（藏在概念卡展开区），缺口只是「入口太深 + 名字旧」。
2. ✅ PLAN5 §3 R2 的红线 → 已按 §3.3(b) 改口径：录音**转写成功即删**，所以「录音文件不进 vault」
   现在字面成立；转写文本落 `vault/voice/`（原料目录），**不落任何产出目录**。
   同段还补了「新 action、不复用 `_transcribe`」「文件名与 H1 零模型」「那一问本份不做」三条。
3. ✅ PLAN5 §1 表格里「Z3/Z4 待核」→ 已改成 ✅（见 §6）。
4. ✅ PLAN5 §3 三个小节标题各加了落地状态；§3 开头加了一段总状态。

---

## §6 附：这次核出来的 PLAN5 与实际不符之处（**已改完**）

1. §2-3「学习侧只有卡挂了半个」→ 实际 `kind="tutor"` 早已存在且可读，缺的只是 UI 入口
   （而且连入口都有一个，只是在展开区里）。→ **PLAN5 已加更正框。**
2. §3 R2「录音文件不进 vault 正文区」+「转写文本照旧进索引」→ 字面矛盾（`indexer` 只索引 vault 内文件）。
   应改成「录音转写成功即删；文本落 vault 的**原料目录** `voice/`，不落任何产出目录」。→ **PLAN5 已改。**
3. §3 R2 写「复用 `_transcribe`」→ 实际不能复用（它收尾把录音搬进会议文件夹，且被测试钉死）。→ **PLAN5 已改。**

**另外**：§1 表格里「Z3/Z4 待核」这句已划掉——`pet_tone.flavor()`（Z4）完整存在
（独立开关 `pet_flavor`、7 条测试、`routers/pet.py:43,85` 两处都吐给界面）；Z3 的台词池轮换
在 `pet.POOLS` / `_pick` 里，同样已有测试。

---

## §7 一句话总结（给下一个接手的人）

三条接缝都落地了，**行为改动集中在三处**，其余全是接线：

| 行为改动 | 在哪 | 为什么值得记住 |
|---|---|---|
| 多了一条**只留文本、删掉录音**的语音路 | `tasks._transcribe_note` + `core/voice_note.py` | 与会议那条**故意**分成两个 action——合并会让两种语义互相污染 |
| 挂接的 kind 从 `tutor` **改名** `session` | `threads.KINDS` + `Migration(14)` | 数据迁移要一起发，否则历史挂接集体变「引用不存在」 |
| 仪表盘多了三条读数（接地分 / 判分基线 / 回合读数） | `frontend/src/MetricCard.tsx` + `DashboardPage.tsx` | 红线：**只给计数，不给成功率**；读不到摆 `—` 不摆 0 |
| 仪表盘又多了**提示词评测**那一格（复核时补） | `prompt_eval.board()` + `PromptEvalCard` | 它量的是「尺子有没有被量过」——所以**不摆任何一条提示词的名字或分数**，一摆就成了排行榜 |

**最容易再踩的一次**：凡涉及 `VAULT_DIR` 的测试，先问「代码读的是哪一个」
（`tasks.VAULT_DIR` / `voice_note.VOICE_DIR` / `mcp.VAULT_DIR` / `app.config.VAULT_DIR` 是**四个名字**）。
这个坑在本份里踩了一次、在 `turn_quality` 那里踩过一次，两次症状都是「断言找不到文件」。
