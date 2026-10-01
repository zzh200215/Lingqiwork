"""图片仓库本身：内容去重 + 引用扫描。

去重这条钉的是「**同一份字节只落一个文件**」——起因是验收截图把 data/images 灌到
64 张里只有 7 种内容（文件名不同、字节相同），本地优先应用的磁盘只涨不跌。
引用扫描钉的是「清理入口**宁可不删、不可误删**」：多算一个引用只是那张图这次不走，
漏算一个就是聊天里的附件或皮肤底图当场裂图。
"""
import hashlib
import sys
from pathlib import Path

sys.path.insert(0, ".")

from app.core import images  # noqa: E402
from app.core.prefs import save_config  # noqa: E402


def _png(n: int) -> bytes:
    return b"\x89PNG\r\n\x1a\n" + bytes([n]) * 32


def test_same_content_reuses_one_file():
    a = images.save_upload(_png(1), "image/png")
    b = images.save_upload(_png(1), "image/png")
    assert b["name"] == a["name"]  # 第二次拿到的就是第一次那个文件
    assert len(list(images.IMAGE_DIR.glob("*.png"))) == 1  # 磁盘上没有双胞胎


def test_different_content_gets_own_file():
    a = images.save_upload(_png(1), "image/png")
    b = images.save_upload(_png(2), "image/png")
    assert b["name"] != a["name"]
    assert len(list(images.IMAGE_DIR.glob("*.png"))) == 2


def test_name_suffix_is_content_hash():
    """后缀取内容 hash 前 6 位：仍是 NAME_RE 的形状，但同内容一眼能认出。"""
    r = images.save_upload(_png(7), "image/png")
    suffix = r["name"].split("-")[-1].split(".")[0]
    assert suffix == hashlib.sha256(_png(7)).hexdigest()[:6]


def test_vault_note_reference_protects_the_image():
    held = images.save_upload(_png(3), "image/png")
    keep_out = images.save_upload(_png(4), "image/png")
    note = Path(images.VAULT_DIR) / "notes" / "with-image.md"
    note.parent.mkdir(parents=True, exist_ok=True)
    note.write_text(f"看图 ![x]({keep_out['url']})\n", encoding="utf-8")

    unreferenced = {r["name"] for r in images.unreferenced_images()}
    assert keep_out["name"] not in unreferenced  # 笔记引用着，不能进清理名单
    assert held["name"] in unreferenced


def test_theme_background_reference_protects_the_image():
    """背景图存在 config.json 的 theme 里（原样保管），扫描要能从盘上找回来。"""
    held = images.save_upload(_png(6), "image/png")
    save_config({"theme": {"bg": {"mode": "image", "image": held["url"]}}})

    assert held["name"] not in {r["name"] for r in images.unreferenced_images()}


def test_extra_keep_from_frontend_skins():
    """localStorage 里的皮肤引用后端看不见，只能经 `extra` 传进来。"""
    held = images.save_upload(_png(5), "image/png")
    without_keep = {r["name"] for r in images.unreferenced_images()}
    with_keep = {r["name"] for r in images.unreferenced_images([held["name"]])}

    assert held["name"] in without_keep  # 后端自己看，它就是「未引用」
    assert held["name"] not in with_keep  # 前端说皮肤用着，就保下来
