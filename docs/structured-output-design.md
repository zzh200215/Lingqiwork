# 结构化输出层设计方案

> 目标：把散落在 9 处的「模型输出 JSON → 正则裸提取」统一为
> 「原生结构化优先 → 清洗降级 → 自纠正重试 → Pydantic 校验 → 可观测」的一条链路。
>
> 状态：设计稿，未实现。实现前需确认迁移范围与顺序。

---

## 1. 问题定位

### 1.1 现有调用点清单（活跃 9 处，已排除读文件的）

| # | 位置 | 用途 | 现有提取方式 | 失败后果 |
|---|---|---|---|---|
| 1 | `tutor.py:906` | 概念 / 别名 / 卡点 / 迁移问题 | `re.search(r"\{.*\}")` | 静默返回空，教学记录无卡点 |
| 2 | `memory.py:325` | automemory 三分类抽取 | `re.search(r"\[.*\]")` | 静默跳过，该记的没记 |
| 3 | `memory_tidy.py:70` | 合并判定（merge/keep） | `re.search(r"\{.*\}")` | 跳过该簇，重复记忆不清理 |
| 4 | `memory_tidy.py:247` | 睡眠期反思洞察 | `re.search(r"\[.*\]")` | 整轮反思标记 failed |
| 5 | `tasks.py:780` | 自然语言 → cron | `re.search(r"\{.*\}")` | 抛 ValueError，前端显示人话错误 |
| 6 | `kg.py:121` | 知识图谱实体关系抽取 | `re.search(r"\{.*\}")` | 该文档不进图谱 |
| 7 | `podcast.py:100` | 播客脚本生成 | 正则 | 整期生成失败 |
| 8 | `chat.py:539` | 后续追问问题 | `re.search(r"\[.*\]")` | 静默跳过（已有兜底） |
| 9 | `evals.py:98` | 评审判定 | `re.search(r"\{.*\}")` | 评测结果缺失 |

（另有 `cards.py:415` 属已封存功能，可不管；`llm.py:126` 是 SDK 返回的工具参数，性质不同。）

### 1.2 现有模式的四个具体缺陷

现有统一套路是：

```python
raw = "".join([c async for c in stream_chat(...)])
m = re.search(r"\{.*\}", raw, re.S)   # ①
if not m: return ...                   # 静默
data = json.loads(m.group(0))          # ②
concept = str(data.get("concept") or "").strip()[:120]  # ③
```

1. **① 贪婪正则**：`\{.*\}` 配 `re.S` 会一路吃到**最后一个** `}`。若模型先说两句再给 JSON、或给了两段 JSON，提取到的 blob 会包含多余内容，`json.loads` 直接失败。
2. **② 没有代码块清洗**：模型最常见的"听话但包装"行为是输出 ```` ```json {...} ``` ````。现有代码**没有任何去围栏逻辑**，这类输出 100% 解析失败。
3. **③ 无 schema 校验**：手工 `.get()` + 裁剪，字段缺失/类型错（`"aliases"` 给成字符串而非数组）不报错也不纠正，直接进入下游。
4. **无自纠正**：解析失败就放弃，不会把错误反馈给模型重试一次。

### 1.3 已经付出的代价（现成证据）

- `cards.py:419` 有一行 `json.loads(re.sub(r",\s*([\]}])", r"\1", blob))` —— 去掉尾逗号。说明**已经踩过**模型输出尾逗号导致失败的坑，且只在卡片这一处打了补丁，其余 8 处仍裸奔。
- `memory_tidy.reflect` 里专门写了"流水里不存在的编号（模型幻觉）直接丢弃"——说明**已经踩过** `based_on` 编号幻觉。
- `memory_tidy.py` 上一轮刚补的 `isinstance(item, str)` 兼容，也是同一个根因的补丁。

这些补丁散落各处、各修各的，正是需要统一层的信号。

---

## 2. 目标与非目标

**目标**
- 单一入口，9 处复用同一套降级与校验逻辑。
- 优先用 provider 原生能力（JSON mode / tool_use）从源头消除格式问题。
- 无法用原生能力时，清洗 + 校验 + 一次自纠正重试。
- **可观测**：每次抽取记录策略、成功与否、重试次数，让"静默降级"变成"可见降级"。
- 可测试：畸形输出（代码块、废话、缺字段、类型错、尾逗号）有单测覆盖。

**非目标**
- 不追求 100% 成功率（受模型能力约束，只能提高下限）。
- **不改现有 9 处 prompt 的内容**——只做调用侧增强，避免影响已校准的抽取质量（尤其 `tutor._EXTRACT_PROMPT` 的别名/领域词要求、`memory_tidy` 的阈值相关表述）。
- 不改变各处的 best-effort 契约（该静默的仍然静默，只是内部更稳）。
- 不引入新的重依赖（只用 Pydantic + 现有 SDK）。

---

## 3. 设计

### 3.1 新增模块

`app/core/structured.py`

### 3.2 对外接口

```python
@dataclass
class ExtractMeta:
    strategy: str      # "native" | "cleaned" | "retried" | "failed"
    attempts: int      # 实际调用模型次数
    schema_ok: bool    # 是否通过 Pydantic 校验
    error: str = ""    # 失败原因（供日志/体检）

async def extract_json(
    info: ProviderInfo,
    model: str,
    messages: list[dict],
    schema: type[BaseModel],
    *,
    max_retries: int = 1,      # 自纠正重试次数（0 = 不重试）
    timeout: float | None = None,
) -> tuple[BaseModel | None, ExtractMeta]:
    """调模型拿结构化结果。永不抛异常：失败返回 (None, meta)。"""
```

`messages` 沿用现有 `{role, content}` 结构，**调用方不需要改自己的 prompt**。

### 3.3 三级降级策略

**L1 原生结构化（优先）**

| provider | 手段 | 注意 |
|---|---|---|
| OpenAI 兼容 | `response_format={"type": "json_object"}` | ① 必须保证 prompt 里出现 `JSON` 字样，否则部分实现（含某些兼容层）报 400 → 自动检测并追加一句"只输出 JSON"；② 部分实现不支持该参数 → 捕获 400，降级 L2 |
| Anthropic | `tool_choice` 强制调用一个"输出工具" | Anthropic 无 JSON mode。工具名为 `emit_result`，`input_schema` 由目标 Pydantic 模型的 `model_json_schema()` 生成，强制调用后从 tool_use block 的 `input` 取值 |

`llm.py` 需要新增一个 `structured_chat()`，与 `stream_chat` 平级，内部按 `provider.kind` 分流。

**L2 清洗 + 正则 + 校验（降级）**

针对"模型没给原生能力"或"原生调用报 400"的情况。清洗链：

1. 去 markdown 围栏：`` ```json ... ``` `` / `` ``` ... ``` ``
2. **括号配对扫描**（替换现有的贪婪正则）：从第一个 `{`/`[` 起做配对计数，取第一个完整闭合的 JSON 片段。这修掉 1.2 的缺陷①。
3. 去尾逗号（复用 `cards.py` 已验证的 `re.sub(r",\s*([\]}])", r"\1", blob)`）
4. `json.loads`
5. `schema.model_validate(data)` —— Pydantic 校验，类型/缺字段在此暴露

**L3 自纠正重试（兜底）**

把校验错误 + 原始输出片段（截断 800 字）作为新一轮 user message 发回去：

```
上次输出无法解析：{error}
原始输出：{raw[:800]}
请重新输出，严格遵守：只输出 JSON，不要代码块、不要解释。
```

只重试 `max_retries`（默认 1）次，避免成本失控。

### 3.4 各调用点需要的 schema（示例）

```python
class TutorExtract(BaseModel):
    concept: str = ""
    aliases: list[str] = []
    stuck: str = ""
    transfer: str = ""

    # 保留现有窄化逻辑，但改为在校验层统一做
    @field_validator("concept", "stuck", "transfer", mode="after")
    @classmethod
    def _trim(cls, v): ...
```

现有手工的 `[:120]` / `[:200]` 裁剪、`_clean_aliases` 去重，都可以下沉到 schema 的 validator，调用方代码反而更短。

---

## 4. 迁移路径（建议分 3 批，每批可独立验证）

**原则**：每处迁移后**保留原有 `except` 兜底与返回值语义**，只把"裸正则"替换为 `extract_json`。这样即使新层出问题，行为退化到和今天一致，不会更差。

| 批次 | 调用点 | 理由 | 验证方式 |
|---|---|---|---|
| 批 1 | `tutor.py:906`、`memory.py:325` | 最高频、最核心（教学卡点 + 长期记忆），收益最大 | 跑 `test_tutor.py`、`test_memory_upgrade.py`；`smoke_tutor_accept.py` 复跑验收 |
| 批 2 | `memory_tidy.py:70/247`、`tasks.py:780` | 无人值守路径，失败无感知，最需要可观测 | 跑 `test_memory_tidy.py`、`test_websearch_parser.py` |
| 批 3 | `kg.py`、`podcast.py`、`chat.py:539`、`evals.py` | 频次低或已有兜底 | 各自单测 + 手动冒烟 |

`cards.py` 已封存，不迁移（除非决定清理封存代码时一并处理）。

---

## 5. 可观测性

在 `structured.py` 内维护进程内计数器（无需新表）：

```
{strategy: {native: N, cleaned: N, retried: N, failed: N}}
```

通过 `/api/health/report`（已有体检报告端点）暴露一个 `structured` 字段：

```json
{"structured": {"total": 128, "native": 110, "cleaned": 12, "retried": 4, "failed": 2, "success_rate": 0.984}}
```

这样"记忆抽取是不是在静默失败"第一次变成**可回答的问题**，也和项目既有的"系统还能不能信"的体检定位一致。

---

## 6. 测试策略

新增 `tests/test_structured.py`，用 fake provider 覆盖畸形输入矩阵：

| 输入 | 期望 |
|---|---|
| 纯 JSON | L1/L2 通过 |
| ```` ```json {...} ``` ```` 包裹 | 清洗后通过（**现有代码会失败**） |
| 前后有解释文字 | 括号配对提取到正确片段 |
| 两段 JSON | 取第一段（**现有贪婪正则会出错**） |
| 尾逗号 | 修复后通过 |
| 字段缺失 | Pydantic 用默认值 / 或标记失败 |
| 类型错误（aliases 为字符串） | 校验失败 → 触发 L3 自纠正 |
| 完全无 JSON | 返回 (None, failed)，不抛异常 |

再加一条**契约测试**：「任何情况下 `extract_json` 都不抛异常」——保证 best-effort 语义。

---

## 7. 风险与权衡

| 风险 | 评估 | 应对 |
|---|---|---|
| 本地模型（Ollama 等）不支持 JSON mode | 高概率 | L1 捕获 400 自动降级 L2，行为不劣化 |
| Anthropic tool_use 改造影响现有流式调用 | 中 | 新增 `structured_chat` 与 `stream_chat` **平级并存**，不动现有流式路径 |
| 自纠正重试增加成本 | 低（默认 1 次，且只在失败时） | 可配 `max_retries=0` 关闭；成本纳入第 5 节统计 |
| Pydantic schema 与现有手工裁剪逻辑不完全等价 | 中 | 迁移时逐字段对齐，保留 validator 里的裁剪/去重；批 1 用 smoke drill 复跑验收 |
| 改动面变广引入回归 | 中 | 分批迁移，每批独立测试；保留原 `except` 兜底 |

---

## 8. 验收标准

1. 批 1 迁移后，`smoke_tutor_accept.py` 的 3 次会话验收仍 PASS，且第 3 次仍能召回第 1 次卡点（阈值 0.62 不动）。
2. ```` ```json ```` 包裹的输出从「100% 失败」变为「成功解析」（新增单测钉住）。
3. 体检报告出现 `structured` 字段，失败次数可见。
4. 全部现有测试保持通过（不允许为迁就新层修改既有断言，除非能证明原断言本身依赖了错误行为）。
