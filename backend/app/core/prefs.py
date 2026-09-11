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
    "rerank_enabled": True,  # cross-encoder rerank after fusion (bge-reranker-base)
    "full_context": True,  # short retrieved docs injected whole instead of chunked
    "full_context_max_chars": 4000,  # per-doc budget for full-context mode
    "digest_time": "09:00",  # daily vault digest schedule (HH:MM)
    "digest_enabled": False,
    "memory_enabled": True,  # inject persistent memories into chat
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


def save_config(update: dict[str, Any]) -> dict[str, Any]:
    current = load_config()  # plaintext
    current.update({k: v for k, v in update.items() if k in _DEFAULTS})
    # Seal only what lands on disk; return the plaintext view to the caller.
    on_disk = {
        k: (seal(v) if k in SECRET_KEYS and isinstance(v, str) else v) for k, v in current.items()
    }
    with _lock:
        _path().write_text(json.dumps(on_disk, ensure_ascii=False, indent=2), encoding="utf-8")
    return current
