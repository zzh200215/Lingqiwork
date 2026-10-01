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
import hashlib
import logging
import re
import secrets
import time
from datetime import datetime
from pathlib import Path

import httpx
from sqlalchemy import select

from app.config import DATA_DIR, VAULT_DIR, settings
from app.core.prefs import load_config
from app.db import SessionLocal
from app.models import ProviderConfig

log = logging.getLogger(__name__)

IMAGE_DIR = DATA_DIR / "images"
# mp4/webm：视频壁纸走的也是这个库——与图片同一个引用扫描、同一个清理入口，
# 要是给它单开一个目录，「清理未引用」就永远扫不到它了。
NAME_RE = re.compile(r"^img-\d{8}-\d{6}-[0-9a-f]{6}\.(png|jpg|jpeg|webp|mp4|webm)$")
SIZE_RE = re.compile(r"^(\d{3,4}[*x]\d{3,4}|\d{1,2}:\d{1,2})$")
_PROMPT_CAP = 1200
_TIMEOUT = 300.0  # qwen-image-3.0 takes ~60s at 1024*1024; leave headroom
_MAX_BYTES = 20_000_000
_MAX_VIDEO_BYTES = 64_000_000


# ---------- local store ----------


def _new_name(ext: str, data: bytes | None = None) -> str:
    """`img-日期-时间-后缀.ext`。给了内容就把后缀取自内容 hash 前 6 位——
    文件名仍然满足 NAME_RE，但同内容上传会得到同样的后缀，一眼能认出双胞胎。"""
    suffix = hashlib.sha256(data).hexdigest()[:6] if data else secrets.token_hex(3)
    name = f"img-{datetime.now():%Y%m%d-%H%M%S}-{suffix}.{ext}"
    # 后缀只取 24 bit：同秒 + 同前缀 + 不同内容（2^-24）撞上就退回随机，宁可名字不像也不覆盖
    if (IMAGE_DIR / name).exists():
        name = f"img-{datetime.now():%Y%m%d-%H%M%S}-{secrets.token_hex(3)}.{ext}"
    return name


def resolve_name(name: str) -> Path:
    """Validate a stored file name and return its path. Raises ValueError."""
    if not NAME_RE.match(name or ""):
        raise ValueError("非法文件名")
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


# ---------- 引用扫描（清理入口的后半件事）----------


# 引用长什么样：聊天附件、笔记、背景图（含视频壁纸）里嵌的都是 /api/images/{name}
# 这个 URL，name 的形状由 NAME_RE 钉死，所以对字节流正则一遍就能把引用找全。
_IMG_REF_BYTES_RE = re.compile(rb"img-\d{8}-\d{6}-[0-9a-f]{6}\.(?:png|jpe?g|webp|mp4|webm)")
# 单文件扫描上限：兜的是被异常喂进来的巨物，正常 vault/数据库远够不着。
_REF_SCAN_CAP = 1 << 30


def referenced_names(extra: list[str] | None = None) -> set[str]:
    """所有「后端看得到的地方」引用着的图片名。

    扫三处：config.json（背景图存在 theme 里）、workbench.db（聊天 markdown 里的
    附件，连同 -wal——提交可能还躺在里面没合入）、vault/（笔记原文）。`extra` 是
    前端补进来的引用（**用户皮肤存在 localStorage，后端永远看不见**，皮肤底图
    只能由前端算好传上来）。

    方向性：宁可多算引用（那张图这次删不掉），不可漏算（把还被引用的图删了）。
    对原始字节正则而不是逐表逐列查，就是为了「新加一张会嵌图的表也不用记得来这里登记」。
    """
    refs = {n for n in (extra or []) if NAME_RE.match(n)}
    candidates = [
        settings.config_path,
        settings.db_path,
        settings.db_path.with_name(settings.db_path.name + "-wal"),
        *VAULT_DIR.rglob("*"),
    ]
    for f in candidates:
        try:
            if not f.is_file() or f.stat().st_size > _REF_SCAN_CAP:
                continue
            data = f.read_bytes()
        except OSError:
            continue
        refs.update(m.group(0).decode() for m in _IMG_REF_BYTES_RE.finditer(data))
    return refs


def unreferenced_images(extra: list[str] | None = None) -> list[dict]:
    refs = referenced_names(extra)
    return [row for row in list_images() if row["name"] not in refs]


def _find_same_content(data: bytes) -> Path | None:
    """库里已经有同一份字节的文件？返回它。

    只对**同大小**的文件做读回比对（同内容必同大小）——正常情况下候选是 0 个，
    全库都是验收截图双胞胎的最坏情形也只有几十次读，不值得为它养一份 hash 索引。
    """
    if not IMAGE_DIR.exists():
        return None
    for p in IMAGE_DIR.iterdir():
        if not p.is_file() or not NAME_RE.match(p.name):
            continue
        try:
            if p.stat().st_size != len(data):
                continue
            if p.read_bytes() == data:
                return p
        except OSError:
            continue
    return None


def _save(data: bytes, ext: str) -> dict:
    IMAGE_DIR.mkdir(parents=True, exist_ok=True)
    # 内容去重：同一份字节只存一个文件。起因是验收截图——同一张图被传了近 20 次，
    # 文件名各不相同、字节完全相同，本地优先应用的磁盘只涨不跌，这个欠账越滚越大。
    same = _find_same_content(data)
    if same is not None:
        log.info("image store: 同内容文件已存在，复用 %s（本次不落盘）", same.name)
        return {"name": same.name, "url": f"/api/images/{same.name}", "bytes": len(data)}
    name = _new_name(ext, data)
    (IMAGE_DIR / name).write_bytes(data)
    return {"name": name, "url": f"/api/images/{name}", "bytes": len(data)}


_EXT_BY_MIME = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "image/gif": "png",
    "video/mp4": "mp4",
    "video/webm": "webm",
}

_VIDEO_EXTS = {"mp4", "webm"}


def save_upload(data: bytes, mime: str) -> dict:
    """Store a user-pasted/uploaded image or wallpaper video. Raises ValueError on bad input."""
    ext = _EXT_BY_MIME.get((mime or "").split(";")[0].strip().lower())
    if not ext:
        raise ValueError(f"不支持的类型: {mime or '未知'}，仅支持 png/jpg/webp/mp4/webm")
    if not data:
        raise ValueError("内容为空")
    if ext in _VIDEO_EXTS:
        if len(data) > _MAX_VIDEO_BYTES:
            raise ValueError("视频超过 64MB 上限")
    elif len(data) > _MAX_BYTES:
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
