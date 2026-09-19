# 在本机跑测试（以及别踩那两个坑）

> 2026-09-16 立。起因：做一条很小的功能（「同一个概念又卡住」），光在「跑个测试看看」上
> 就绕了半小时——不是测试的问题，是**跑法**的问题。实测数据在下面第 1 节。

---

## 1. 用哪条命令（按目的选，别再每次跑 13 分钟）

| 目的 | 命令 | 实测耗时 |
|---|---|---|
| **改一处、想看结果** | `.\.venv\Scripts\python.exe -m pytest tests/test_<受影响的那个>.py -q --no-header -p no:cacheprovider` | **7–30 秒** |
| **收工前验一轮**（推荐） | `.\.venv\Scripts\python.exe run_tests_fast.py`（可 `WB_TEST_WORKERS=8` 调并发，默认 6） | **3.8 分钟** |
| 原版串行（CI 用） | `.\.venv\Scripts\python.exe run_tests_fast.py test_tutor` 或 `uv run python run_tests.py` | 13 分钟 |

`run_tests_fast.py` 就是 `run_tests.py` 的并行版：**同样的「一文件一进程」隔离**，
只是同时跑 6 个。本机 `uv` 的缓存目录写不进去（`Failed to initialize cache`），
所以一律用 `.venv\Scripts\python.exe`。

**别做的事**：不要为了快把全量塞进一个进程——实测那样会有 **9 个假失败**
（`test_research.py` 被前一个模块留下的状态带塌），看着像回归、其实是串味。
也不要在开发途中反复跑全量：改完再跑一次就够。

## 2. 坑一：`conftest` 的临时目录（沙箱专属）

`tests/conftest.py::_SANDBOX` 用 `tempfile.mkdtemp()` 建随机名目录。在文件沙箱下，
**子进程不能在那种随机名目录里再建子目录**（`os.mkdir` → `WinError 5`），于是
`app/config.py` 的 `DATA_DIR.mkdir` 当场挂在 import 阶段。

`run_tests_fast.py` 已经处理了（每个子进程一个固定基目录的 TEMP）。
手工跑单文件时如果撞上，把 `TEMP`/`TMP` 指到项目内一个已存在的目录即可。
**这一条只影响「怎么跑」，与测试本身无关** —— CI 与不带沙箱的本机用原版即可。

## 3. 坑二：内联脚本里的中文（这条最贵）

**不要**用 `pwsh -Command "... here-string ..."` 写带中文的 Python 探针。Windows 会把内联
脚本文本按本地代码页（cp936）解释，**中文进到 Python 里就已经是乱码**，于是：

- 探针查一条确实存在的中文行 → 报「查不到」；
- 你以为是产品 bug，换一种查法再试 → 还是查不到（因为参数本身就是错的）；
- 反复几轮，代码一个字没改，时间没了。

**规矩**：探针/临时脚本**一律用 `write` 工具写成 `.py` 文件（UTF-8）再执行**，绝不内联。
与 `pet-hub-plan` §13 那条事故同源（`Get-Content` 读改写毁文件）——差别只是这次毁的是
「我看到的东西」，不是「盘上的东西」，所以更隐蔽：**乱码看起来像一个 bug。**

## 4. 判读输出的两个注意点

- **测试模块之间共享状态**：`conftest` 只在**每个模块开始时**清沙箱，模块内跨用例的状态要
  各自收（`test_tutor._reset()` / `test_agent_orchestration._clear()` 都得管住自己新写的表）。
  新加一张会被写的表，就要同时想清楚谁负责收——这一轮为它栽过两次。
- **磁盘上的临时目录也跨用例可见**（2026-09-17 修）：`test_agent_orchestration` 里两条用例都往
  `meetings/<日期>-周会/` 写文件，而文件名带**分钟**（`_write_vault` 的 `%Y-%m-%d-%H%M`）——
  同分钟时后者覆盖前者、跨分钟时俩都在，于是「文件夹里正好三个文件」那条断言在全量里挂了一次
  （`assert 4 == 3`；单跑永远同分钟，所以查不出来）。**别对着磁盘数总数**：数「该在的那几个在不在」。
- **`test_tts.py` 在并发全量下偶发失败**（本机 4 次全量里挂过 2 次）：涉及音频设备/时序，
  单独跑 5 次全绿。**先单独复跑再当回归**，别浪费一轮排查。
- **`test_websearch_parser.py` 在并发全量下偶发失败**（2026-09-16 撞到 1 次：`FAIL … 1 error`，
  紧接着重跑又全绿）：它其实**不是一个 pytest 文件**——没有 test 函数，模块末尾一句
  `asyncio.run(main())` 直接跑，正常情况 pytest 收集到 0 条、报 SKIP。并发下那一次 import
  出错就成了「1 error」。单独跑它（`python tests/test_websearch_parser.py`）能看到它照常
  打印解析结果。同一条规矩：**先单独复跑再当回归**。
- **`test_report_stream.py` 2026-09-16 撞到过一次**（并行全量里 `FAILED 1/81`）：单跑 11 条全绿、
  6 路并发压测 3 轮（18 次）全绿、下一次全量也全绿——**未复现**。它离线且确定性（无网络、
  无库、无时间断言），所以先记在这里；**再出现就按真 bug 查**，别再当偶发。
- **`test_collab.py` 2026-09-16 也撞到过一次**（并行全量里 `FAILED 1/85`）：单跑 4 次全绿
  （19 passed，11.9–12.7s），下一次全量也全绿（那一轮它跑了 16.9s，是全库里最受并发拖累的
  那几个之一）。同样是离线的假 LLM 测试，**未复现**。
  **这一条的失败原文没留下来，而那是跑法的问题不是 runner 的**：当时用
  `Select-Object -Last 6` 截了输出，正好把 runner 特意带出来的「尾巴 20 行」截掉了。
  → **看全量结果时别再截断**（`| Tee-Object -FilePath full_run.txt`），不然下次还得再赌一次。
- **`test_pet_tools.py` 2026-09-17 撞到过一次**（并行全量里 `FAILED 1/87`，**收集阶段**就炸了，
  一条测试都没跑）：`ERROR collecting test session` —
  `FileNotFoundError: [WinError 2] … 'D:\TP\A\backend\wb-ocr-z6aha3yc'`，栈底是
  `pathlib/_abc.py in lstat`。那正是**另一个 worker（`test_ocr.py`）在 `backend/` 下开的
  临时目录**（`mkdtemp(prefix="wb-ocr-", dir=Path(".").resolve())`，`atexit` 收掉），
  形状是典型的「先列目录、再 stat，中间被删掉」的跨进程竞态。单独跑 22 条全绿、
  `test_ocr` + `test_pet_tools` 两路并发压 3 轮也全绿、下一轮全量 87 全绿——**未复现**。
  全仓没有 `chdir`、没有哪个测试 glob 别人的 `wb-*`，所以**作案的那几帧正好被截掉了**
  （见下一条）。**再出现就按真 bug 查**：那时要的是调用栈上层——谁 stat 的它。
- **同一形状 2026-09-17 又出现一次**（并行全量里 `FAILED 1/90`）：这次是 **`test_compose.py`**
  在收集阶段炸，报的是 **`D:\TP\A\backend\tests\wb-cards-d2eteura`** ——`test_cards.py` 的
  临时目录（`dir=Path(__file__).parent`，所以落在 `tests/` 里）。两轮的错误详情（这次把
  runner 的 40 行看全了）只有**两帧**：

  ```
  D:\AI\ACD\Lib\pathlib\_abc.py:437: in lstat
      return self.stat(follow_symlinks=False)
  D:\AI\ACD\Lib\pathlib\_local.py:515: in stat
      return os.stat(self, follow_symlinks=follow_symlinks)
  E   FileNotFoundError: [WinError 2] … 'D:\TP\A\backend\tests\wb-cards-d2eteura'
  ```

  **上面没有调用者帧**，所以它不是某段业务代码扫目录扫到的（那种栈会有一长串）——更像是在
  **终结器 / hook 那一类路径**里做的 stat。两条已知线索：① 两次都发生在**收集阶段**（进程刚
  起来 10–14 秒）；② 被 stat 的永远是**另一个测试模块在同级目录下开的 `wb-*` 临时目录**，
  而那个模块的进程正好在这个窗口里退出（`atexit` 把它删了）。
  **一条待验的猜测**：这些 scratch 目录开在**共享的仓库目录**里（`backend/` 或 `backend/tests/`），
  所以任何「列一下同级目录」的代码都会看见别人的临时目录——把 `dir=Path(".").resolve()` /
  `dir=Path(__file__).parent` 换成**各 worker 自己的 TEMP**（`run_tests_fast.py` 已经按文件隔离了
  `TEMP`/`TMP`）就从根上没有了这个共享面。那是 ~25 个测试模块的机械改动，还没做。
  **第三次（2026-09-17，`FAILED 1/90`）**换了个人：`test_turn_quality.py` ←
  `tests\wb-w2b-vault-i0yadyay`（`test_structured_turn.py` 的）。三次的受害者与被 stat 的目录都不同、
  形状完全一样，所以**它是一条真的跨进程竞态，不是某个文件的问题**。
  **对策（已落地）**：`run_tests_fast.py` 现在对**收集阶段的失败**自动重跑一次，并在那一行写明
  `[retried after a collection error]`——只重试「一条测试都没跑起来」的那种，而且**写在结果里不藏**。
  四次实测的代价是每轮白等 5 分钟，重试一次比再赌一轮便宜。

### 失败详情现在留在输出里（2026-09-16 起）

`run_tests_fast.py` 原来只打印每个文件失败后的**最后一行**（`1 failed, 10 passed`），
于是「哪条断言炸的」永远丢了——上面那条 `test_report_stream` 就是这么变成一笔糊涂账的：
知道文件名，不知道断言。现在失败的那一份会把**尾巴 40 行**一起带出来（复现命令、断言行、
异常类型都在里面），并且父进程与子进程**统一按 UTF-8 输出**——不然 GBK 控制台会把
中文断言消息编成乱码，甚至用 `UnicodeEncodeError` 把 runner 自己干掉（真撞过）。

**为什么是 40 行而不是 20 行**（2026-09-17，见上面那条 `test_pet_tools`）：**收集阶段**的错误，
关键帧在栈的**上层**（谁 stat 的它），而最后 20 行只留得下栈底那一帧（`pathlib … in lstat`）
——那条线索就这么废了。断言错误的关键帧在最下面、收集错误的关键帧在最上面，所以两头都得留宽。

## 5. 要真跑起来的那几种：先跑 `--dry`

有三类东西**跑一次要真调模型**（第四类只借本地 embedder），它们的开关与纪律各不一样
（都不在 `pytest` 里）：

| 要测什么 | 命令 | 成本 |
|---|---|---|
| 四个引擎的 golden set | `.\.venv\Scripts\python.exe smoke_engine_eval.py [引擎] [--no-judge]` | 每引擎十几条调用 |
| 一份技能包有没有用 | 界面上的「量一遍」（`core/skill_eval.py`） | 每条用例问两次 |
| **重讲判分准不准**（PLAN2 P2-1） | `.\.venv\Scripts\python.exe smoke_judge_eval.py [--dry] [--model X] [--no-save]` | 36 条 = 36 次调用 |
| **话题↔概念的语义阈值**（PLAN2 P2-2） | `.\.venv\Scripts\python.exe smoke_cross.py` | 免费，但要本地 embedder（首次加载 6-7 秒） |
| **话题↔技能的匹配阈值**（PLAN3 S1） | `.\.venv\Scripts\python.exe smoke_skill_match.py` | 免费，但要本地 embedder（首次加载 6-7 秒） |

最后那两个**不花钱，但第二个该绿、第一个不该绿**：

- `smoke_cross.py` 的结论就是「没有可用阈值，这一层不上线」，所以退出码 1 是它正常的样子
  （脚本末尾会把这句话打出来）。它守的是 `cross.match_topic` 那条纯函数——谁要往里面加
  余弦兜底，先跑它看一眼那两条分布。
- `smoke_skill_match.py` 是 PLAN3 S1 的尺子，退出码 0 = 有一条阈值在两个池子上都成立。
  它守的是 `core/skill_match.py` 的 `SKILL_FLOOR`：**改阈值先跑它**。两个方法一起量
  （确定性 2-gram 与 embedding 余弦）、**两个池子一起量**（10 份 → 15 份技能）——因为
  S2 会一直往 `skills/` 里落草稿。这一页量过两轮，第二轮推翻了自己的样本（把「近重复」
  塞进压力池会让**负样本的标签自己漂**），所以压力测试现在只加**别领域**技能，近重复
  单独一栏量「第一名有没有被抢走」。

**先 `--dry`**：它只体检金标集（条数、字段、档位合法、id 唯一），一个字节都不发给模型。
真跑之前先花两秒确认「这套用例本身是合格的」——跑完才发现第 7 条少了个字段，那 36 次调用
就白花了。

脚本自己把 stdout 重设成 UTF-8（`sys.stdout.reconfigure`）：这台机器控制台默认是 gbk，
不设的话一个 `✅` 就能让脚本死在**最后一行**——钱花了、报告却没打出来（`smoke_judge_eval.py`
第一版就撞过）。
