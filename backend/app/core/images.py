"""Text-to-image generation + a local image store.

Two API shapes, selected by the `image_api` pref:

  * ``dashscope`` — POST {host}/api/v1/services/aigc/multimodal-generation/generation,
    synchronous; the image URL comes back in
    ``output.choices[0].message.content[*].image``.
  * ``openai`` — POST {base_url}/images/generations, response either
    ``data[].b64_json`` or ``data[].url``.

Provider URLs are signed and expire, so every generated image is downloaded
into ``data/images/`` and served back from ``/api/images/{name}`` — markdown
written into a chat message or a note keeps working forever.
"""
import base64
import binascii
import logging
import re
import secrets
import time
from datetime import datetime
from pathlib import Path

import httpx
from sqlalchemy import select

from app.config import DATA_DIR
from app.core.prefs import load_config
from app.db import SessionLocal
from app.models import ProviderConfig

log = logging.getLogger(__name__)

IMAGE_DIR = DATA_DIR / "images"
NAME_RE = re.compile(r"^img-\d{8}-\d{6}-[0-9a-f]{6}\.(png|jpg|jpeg|webp)$")
SIZE_RE = re.compile(r"^(\d{3,4}[*x]\d{3,4}|\d{1,2}:\d{1,2})$")
_PROMPT_CAP = 1200
_TIMEOUT = 300.0  # qwen-image-3.0 takes ~60s at 1024*1024; leave headroom
_MAX_BYTES = 20_000_000


# ---------- local store ----------


def _new_name(ext: str = "png") -> str:
    return f"img-{datetime.now():%Y%m%d-%H%M%S}-{secrets.token_hex(3)}.{ext}"


def resolve_name(name: str) -> Path:
    """Validate a stored image name and return its path. Raises ValueError."""
    if not NAME_RE.match(name or ""):
        raise ValueError("非法图片名")
    return IMAGE_DIR / name


def list_images() -> list[dict]:
    if not IMAGE_DIR.exists():
        return []
    rows = []
    for p in IMAGE_DIR.iterdir():
        if not p.is_file() or not NAME_RE.match(p.name):
            continue
        st = p.stat()
        rows.append(
            {
                "name": p.name,
                "url": f"/api/images/{p.name}",
                "bytes": st.st_size,
                "created": datetime.fromtimestamp(st.st_mtime).isoformat(timespec="seconds"),
            }
        )
    return sorted(rows, key=lambda r: r["created"], reverse=True)


def delete_image(name: str) -> bool:
    p = resolve_name(name)
    if not p.exists():
        return False
    p.unlink()
    return True


def _save(data: bytes, ext: str) -> dict:
    IMAGE_DIR.mkdir(parents=True, exist_ok=True)
    name = _new_name(ext)
    (IMAGE_DIR / name).write_bytes(data)
    return {"name": name, "url": f"/api/images/{name}", "bytes": len(data)}


_EXT_BY_MIME = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "image/gif": "png",
}


def save_upload(data: bytes, mime: str) -> dict:
    """Store a user-pasted/uploaded image. Raises ValueError on bad input."""
    ext = _EXT_BY_MIME.get((mime or "").split(";")[0].strip().lower())
    if not ext:
        raise ValueError(f"不支持的图片类型: {mime or '未知'}，仅支持 png/jpg/webp")
    if not data:
        raise ValueError("图片内容为空")
    if len(data) > _MAX_BYTES:
        raise ValueError("图片超过 20MB 上限")
    return _save(data, ext)


# ---------- provider resolution ----------


async def _provider(name: str) -> ProviderConfig:
    """Provider whose key/base_url the image API borrows. '' = first enabled."""
    async with SessionLocal() as db:
        if name:
            p = (
                await db.execute(select(ProviderConfig).where(ProviderConfig.name == name))
            ).scalar_one_or_none()
            if p and p.enabled:
                return p
        p = (
            await db.execute(select(ProviderConfig).where(ProviderConfig.enabled.is_(True)))
        ).scalars().first()
    if not p:
        raise ValueError("没有已启用的 provider，请先在设置页配置 API key")
    return p


def _native_base(base_url: str) -> str:
    """OpenAI-compatible base_url -> DashScope native /api/v1 root."""
    m = re.match(r"^(https?://[^/]+)", (base_url or "").strip())
    return (m.group(1) if m else "https://dashscope.aliyuncs.com") + "/api/v1"


async def _download(client: httpx.AsyncClient, url: str) -> dict:
    r = await client.get(url, follow_redirects=True, timeout=120.0)
    r.raise_for_status()
    if len(r.content) > _MAX_BYTES:
        raise ValueError("生成的图片过大")
    ext = "png"
    for cand in ("webp", "jpeg", "jpg", "png"):
        if cand in (r.headers.get("content-type", "") or "") or f".{cand}" in url.lower():
            ext = "jpg" if cand == "jpeg" else cand
            break
    return _save(r.content, ext)


# ---------- API shapes ----------


async def _gen_dashscope(
    client: httpx.AsyncClient, p: ProviderConfig, model: str, prompt: str, size: str, n: int
) -> list[dict]:
    url = _native_base(p.base_url) + "/services/aigc/multimodal-generation/generation"
    body = {
        "model": model,
        "input": {"messages": [{"role": "user", "content": [{"text": prompt}]}]},
        "parameters": {"size": size, "n": n, "watermark": False},
    }
    r = await client.post(
        url,
        json=body,
        headers={"Authorization": f"Bearer {p.api_key}", "Content-Type": "application/json"},
        timeout=_TIMEOUT,
    )
    if r.status_code >= 400:
        raise ValueError(f"图片接口报错 {r.status_code}: {r.text[:300]}")
    data = r.json()
    urls = [
        block["image"]
        for choice in data.get("output", {}).get("choices", [])
        for block in choice.get("message", {}).get("content", [])
        if isinstance(block, dict) and block.get("image")
    ]
    if not urls:
        raise ValueError(f"接口未返回图片：{str(data)[:300]}")
    return [await _download(client, u) for u in urls]


async def _gen_openai(
    client: httpx.AsyncClient, p: ProviderConfig, model: str, prompt: str, size: str, n: int
) -> list[dict]:
    url = (p.base_url or "https://api.openai.com/v1").rstrip("/") + "/images/generations"
    r = await client.post(
        url,
        json={"model": model, "prompt": prompt, "size": size.replace("*", "x"), "n": n},
        headers={"Authorization": f"Bearer {p.api_key}", "Content-Type": "application/json"},
        timeout=_TIMEOUT,
    )
    if r.status_code >= 400:
        raise ValueError(f"图片接口报错 {r.status_code}: {r.text[:300]}")
    items = r.json().get("data") or []
    out: list[dict] = []
    for item in items:
        if item.get("b64_json"):
            try:
                out.append(_save(base64.b64decode(item["b64_json"]), "png"))
            except (binascii.Error, ValueError) as e:
                raise ValueError(f"图片 base64 解码失败: {e}") from e
        elif item.get("url"):
            out.append(await _download(client, item["url"]))
    if not out:
        raise ValueError("接口未返回图片")
    return out


# ---------- public entry ----------


def config() -> dict:
    """Effective image settings (what the UI shows and generate() defaults to)."""
    c = load_config()
    return {
        "enabled": bool(c.get("image_enabled", True)),
        "api": c.get("image_api") or "dashscope",
        "provider": c.get("image_provider") or "",
        "model": c.get("image_model") or "qwen-image-3.0",
        "size": c.get("image_size") or "1024*1024",
    }


async def generate(prompt: str, size: str = "", model: str = "", n: int = 1) -> dict:
    """Generate n images and store them locally. Raises ValueError on bad input
    or an upstream error (callers turn that into a 400/502 or a tool message)."""
    prompt = (prompt or "").strip()
    if not prompt:
        raise ValueError("prompt 不能为空")
    if len(prompt) > _PROMPT_CAP:
        prompt = prompt[:_PROMPT_CAP]

    cfg = config()
    size = (size or cfg["size"]).strip().replace("×", "*")
    if not SIZE_RE.match(size):
        raise ValueError("size 需形如 1024*1024 或比例 16:9")
    model = (model or cfg["model"]).strip()
    n = max(1, min(int(n or 1), 4))

    p = await _provider(cfg["provider"])
    t0 = time.time()
    async with httpx.AsyncClient() as client:
        fn = _gen_openai if cfg["api"] == "openai" else _gen_dashscope
        images = await fn(client, p, model, prompt, size, n)
    out = {
        "prompt": prompt,
        "model": model,
        "size": size,
        "api": cfg["api"],
        "provider": p.name,
        "seconds": round(time.time() - t0, 1),
        "images": images,
    }
    log.info("generated %d image(s) with %s in %.1fs", len(images), model, out["seconds"])
    return out


async def generate_markdown(prompt: str, size: str = "") -> str:
    """Tool-facing wrapper: returns markdown the model can drop into its answer."""
    result = await generate(prompt, size=size)
    alt = prompt.replace("[", "(").replace("]", ")")[:60]
    lines = [f"![{alt}]({img['url']})" for img in result["images"]]
    return (
        f"已生成 {len(lines)} 张图片（{result['model']} · {result['size']} · "
        f"{result['seconds']}s）。请把下面的 markdown 原样放进回答里展示：\n" + "\n".join(lines)
    )
