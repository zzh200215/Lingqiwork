"""Simple JSON file config (data/config.json) for user preferences.

Kept separate from SQLite so settings survive db rebuilds and stay
human-editable.
"""
import json
import threading
from typing import Any

from app.config import settings as app_settings
from app.core.secrets import SECRET_KEYS, seal, unseal

_lock = threading.Lock()

_DEFAULTS: dict[str, Any] = {
    "system_prompt": "",  # prepended to every chat as a system message
    "rag_top_k": 5,
    "temperature": None,  # None = provider default
    "mcp_servers": [],  # {"name","type","command","args","url","enabled"}
    "hybrid_search": True,  # BM25 + vector RRF fusion (False = vector only)
    # 重排默认**关**——这是量出来的决策，不是口味（RAG升级.md §3「P1b 重排去留」）：
    # 34 条金标上同查询配对 on 赢 5 / 平 23 / off 赢 6，且 on 档把 paraphrase hit@3
    # 从 0.64 打回 0.50，CPU 实测 563s vs 1.1s（~16.6s/题 vs ~0.03s/题）。
    # 出厂默认按数据写死，不做运行时自适应（红线 #10）。读取一律走 `rerank_enabled()`。
    "rerank_enabled": False,  # cross-encoder rerank after fusion (bge-reranker-base)
    "full_context": True,  # short retrieved docs injected whole instead of chunked
    "full_context_max_chars": 4000,  # per-doc budget for full-context mode
    "digest_time": "09:00",  # daily vault digest schedule (HH:MM)
    "digest_enabled": False,
    # 夜间评测回归（eval_regression，2026-09-26）：**默认关**——它每天烧一次真金白银的
    # 模型调用。这两键必须在 `_DEFAULTS` 里，否则 `save_config` 的白名单过滤会把设置页
    # 存进来的开关**静默丢弃**（PrefsIn 声明了它们、校验也过，但存不进 → 永不生效）。
    # cron 空串时由 `eval_regression.py` 兜底为 "0 5 * * *"。
    "eval_regression_enabled": False,
    "eval_regression_cron": "",
    "memory_enabled": True,  # inject persistent memories into chat
    # A4：把「最近在做的那件事」的名字/进度/引用清单追加进 system——**只在消息指涉它时**
    # （`core/thread_context`）。默认开：空数据本来就不注入，没这事的人一个字都看不到。
    "thread_context_enabled": True,
    "automemory_enabled": False,  # model decides post-turn what's worth remembering
    "memory_tidy_enabled": False,  # nightly sleep-time consolidation of near-duplicate memories
    "memory_tidy_time": "03:30",
    "asr_model": "small",  # faster-whisper size: tiny | base | small | medium
    "asr_language": "auto",  # auto | zh | en | ja
    "tts_voice": "zh-CN-XiaoxiaoNeural",  # edge-tts neural voice
    "tts_engine": "edge",  # edge (network, neural) | sapi (local Windows voice)
    "tts_auto": False,  # auto-read assistant answers when they finish
    "podcast_host_voice": "zh-CN-YunxiNeural",  # 笔记→播客：主持人音色
    "podcast_guest_voice": "zh-CN-XiaoxiaoNeural",  # 笔记→播客：嘉宾音色
    "podcast_daily_enabled": False,  # 每日笔记摘要生成后自动转为一期播客
    "kg_uri": "bolt://localhost:7687",  # user's local Neo4j
    "kg_user": "neo4j",
    "kg_password": "",
    "kg_enabled": False,  # inject knowledge-graph context into RAG answers
    "artifacts_enabled": False,  # opt-in: run AI code blocks (python/js) locally
    "artifacts_timeout": 30,  # per-run subprocess timeout, seconds (cap 120)
    "desktop_notify": True,  # Windows toast on task finish/failure
    "backup_enabled": False,  # daily automatic backup zip
    "backup_time": "03:00",
    "backup_keep": 7,  # rolling retention count
    "backup_dir": "",  # "" = <project>/backups
    # T8：开着则忽略 backup_dir，自动落「第一块 USB 外接盘的 workbench-backup/」；
    # 没插盘的那次计划备份安静跳过。正本与备份不同盘，盘坏不两失。
    "backup_removable": False,
    "image_enabled": True,  # expose the image_gen tool to the model
    "image_api": "dashscope",  # dashscope (multimodal-generation) | openai (/images/generations)
    "image_provider": "",  # provider name whose key/base_url to use; "" = first enabled
    "image_model": "qwen-image-3.0",
    "image_size": "1024*1024",
    # --- 联网搜索（web_search 工具的引擎选择）---
    "websearch_api": "",  # "" = 免费爬取 Bing/DDG（无需 key）；"keenable" = Keenable 搜索 API
    "websearch_api_key": "",  # Keenable 的 X-API-Key，随 data/config.json 落盘（不入 git）
    "repos": [],  # cloned git repos: {"name","url","files","chunks","last_synced"}
    "watch_dirs": [],  # external indexed folders: {"name","path","enabled","files","chunks",...}
    "feeds": [],  # rss subs: {"name","url","title","enabled","new","last_synced"}
    "feeds_enabled": False,  # daily RSS fetch into vault/feeds/
    "feeds_time": "08:00",
    "smtp_host": "",
    "smtp_port": 587,
    "smtp_user": "",
    "smtp_password": "",
    "smtp_from": "",  # "" = same as smtp_user
    "smtp_to": "",  # comma-separated recipients
    "smtp_tls": True,  # STARTTLS on 587; port 465 uses implicit TLS automatically
    "email_on_digest": False,  # mail the daily note digest
    "email_on_feeds": False,  # mail a summary line per feed after each sync
    "pet_enabled": True,  # 零柒: resident companion (events + window)
    "pet_notify": True,  # 零柒: toast on failures & greetings
    "pet_greet_enabled": True,  # 零柒: daily morning/evening greeting (生物钟)
    "pet_morning_time": "08:30",  # 零柒: morning greeting schedule (HH:MM)
    "pet_evening_time": "21:00",  # 零柒: evening recap schedule (HH:MM)
    # 零柒: 语气微调（P2）——按读出来的喂养分布调整它的**用词**（不夸、不评）。
    # 默认开：默认关掉的功能在这个仓库里死过一次（见 `models.Habit` 的 docstring）。
    "pet_tone": True,
    # 零柒: 称号旁那一行风味小注（Z4 · PLAN4）——同一份喂养分布，摆成一句事实。
    # 与 `pet_tone` 分开：一个改它怎么说话，一个只是成长页上多一行字。
    "pet_flavor": True,
    # --- 复习卡片（SM-2 间隔复习）---
    "cards_new_per_day": 20,  # new cards introduced per day
    "cards_review_per_day": 200,  # reviews per day (keeps a backlog from snowballing)
    "cards_remind_enabled": True,  # daily "N cards due" nudge via 零柒
    "cards_remind_time": "20:00",
    "cards_remedy_enabled": True,  # weekly follow-up explainer for weak sources
    # 后台可信：逐模型探测结果 {"provider/model": {ok, code, message, at, ms}}。
    # 不是开关，是缓存——default_model_id() 用它跳过已知打不通的模型。
    "provider_health": {},
    # --- 成本与配额（opt-in，默认关）---
    # model_id → {"input": 每百万 token 价, "output": 每百万 token 价}。
    # 单位由用户自定（USD/CNY 均可），成本输出的币种与所填价格一致。空 = 只显示 token。
    "model_prices": {},
    # 月度预算（与 model_prices 同币种），0 = 不设限。超了在体检报告标出，不硬性拦停。
    "monthly_budget_usd": 0,
    # --- 外观 / 换肤（2026-10-01）---
    # 皮肤 id / 亮暗 / 强调色 / 自定义背景（纯色·渐变·图片及其模糊压暗参数）。
    # **形状的真相在前端 `src/theme.ts`**：后端只负责原样保管（`/api/settings/theme`
    # 整体存取，不拆字段），所以这里给 None 而不是一个空 dict——「从没设置过」与
    # 「设置成了空」是两件事，前端靠这个区分「要不要回读后端」。
    # 必须在这张表里：`save_config` 的白名单过滤会把表外的键**静默丢弃**。
    "theme": None,
}


def _path():
    return app_settings.config_path


def load_config() -> dict[str, Any]:
    with _lock:
        if not _path().exists():
            return dict(_DEFAULTS)
        try:
            data = json.loads(_path().read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return dict(_DEFAULTS)
    cfg = {**_DEFAULTS, **data}
    # Secrets are ciphertext on disk (core/secrets.py); hand every reader the
    # plaintext, so mailer/kg/websearch need no knowledge of the sealing.
    for key in SECRET_KEYS:
        if isinstance(cfg.get(key), str):
            cfg[key] = unseal(cfg[key])
    return cfg


def rerank_enabled(cfg: dict[str, Any] | None = None) -> bool:
    """重排开关的**唯一读取口**。默认值只在 `_DEFAULTS` 里写一次。

    之前三个调用点各自抄了一份 `.get("rerank_enabled", True)`——默认值散在四处，
    抄反一处就是「默认开着、每次查询白付 ~16s」。默认值只有一个出处，这里读它。
    """
    src = load_config() if cfg is None else cfg
    return bool(src.get("rerank_enabled", _DEFAULTS["rerank_enabled"]))


def save_config(update: dict[str, Any]) -> dict[str, Any]:
    current = load_config()  # plaintext
    current.update({k: v for k, v in update.items() if k in _DEFAULTS})
    # Seal only what lands on disk; return the plaintext view to the caller.
    on_disk = {
        k: (seal(v) if k in SECRET_KEYS and isinstance(v, str) else v) for k, v in current.items()
    }
    with _lock:
        # 原子替换（与 auth.py 落 token 同款：临时文件 + rename）。直接 write_text 的
        # 崩法是「写到一半进程没了」——config.json 从此不是合法 JSON，load_config
        # 静默退回出厂值，症状是「外观/设置全回了默认」，很难联想到是偏好文件写坏了。
        tmp = _path().with_name(_path().name + ".tmp")
        tmp.write_text(json.dumps(on_disk, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(_path())
    return current
