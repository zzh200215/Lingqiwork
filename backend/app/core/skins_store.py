"""导入皮肤的后端副本（`data/skins.json`）。

用户皮肤的正本在**前端 localStorage**（`wb:skins`，见 `theme/registry.ts`）——
首屏要同步读到，不能等一次网络往返。这份副本治的是另一个病：清缓存、换浏览器、
换机器，正本说没就没。于是前端每次改动都 PUT 一份过来；本地为空（新浏览器）
时 GET 回来恢复。

与 `prefs.theme` 同一条纪律：**原样保管**——皮肤清单的形状真相在前端
`theme/manifest.ts`，这里不解释、不裁剪、不补字段，只做两件事：
版本闸（不认识的 version 拒收）与原子落盘（写坏副本的症状是「恢复出来的皮肤
是空的」，用户根本想不到要去查一个 JSON 文件）。
"""
import json
import logging
import threading
from typing import Any

from app.config import DATA_DIR

log = logging.getLogger(__name__)

_lock = threading.Lock()

# 版本闸：只认这几代（与前端 registry.ts 的 SKINS_VERSION 对应）。
# 前端升版本的那天，这里必须同步加——「后端不认识就不存」是故意的。
KNOWN_VERSIONS = {1}


def path():
    return DATA_DIR / "skins.json"


def load() -> dict[str, Any] | None:
    """存着的副本；没有 / 坏了返回 None（None = 「从没同步过」，区别于空清单）。"""
    with _lock:
        if not path().exists():
            return None
        try:
            data = json.loads(path().read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            log.warning("skins.json 读不出来——副本视为不存在，不覆盖正本的判断")
            return None
    return data if isinstance(data, dict) else None


def save(payload: dict[str, Any]) -> dict[str, Any]:
    """原样存一份皮肤清单。版本不认识就 ValueError（路由转 400）。"""
    if payload.get("version") not in KNOWN_VERSIONS:
        raise ValueError(f"不认识的 skins.version: {payload.get('version')}")
    if not isinstance(payload.get("skins"), list):
        raise ValueError("skins 需要是一个数组")
    with _lock:
        # 原子替换（与 prefs.save_config 同款：临时文件 + rename）
        tmp = path().with_name(path().name + ".tmp")
        tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(path())
    log.info("skins.json 已更新（%d 个皮肤）", len(payload["skins"]))
    return payload
