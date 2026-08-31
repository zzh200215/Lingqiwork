"""Live test for V15 digest→podcast (direct core call, no server).

Writes a throwaway digest file into the real vault/digests/, runs the real
chain (provider LLM script → edge-tts → WAV assembly) via podcast.from_digest,
verifies the episode, then deletes it and the temp file.

Requires at least one enabled provider; exits with a hint otherwise.
"""
import asyncio
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from app.config import VAULT_DIR  # noqa: E402
from app.core import podcast  # noqa: E402

DIGEST = VAULT_DIR / "digests" / "__livetest_digest__.md"


def main() -> None:
    import json

    db = Path("D:/TP/A/data/workbench.db")
    conn = sqlite3.connect(db)
    try:
        row = conn.execute("SELECT count(*) FROM provider_configs WHERE enabled = 1").fetchone()[0]
    finally:
        conn.close()
    if not row:
        raise SystemExit("没有已启用的 provider —— 先在设置页配置模型")

    DIGEST.parent.mkdir(parents=True, exist_ok=True)
    DIGEST.write_text(
        "# 笔记摘要 2026-08-30\n\n"
        "## 今日要点\n"
        "- 完成了播客功能的每日简报联动开发，摘要生成后可自动转成双人播客。\n"
        "- 星尘计划检索延迟问题定位到 embedding 缓存缺失，计划下迭代加缓存。\n"
        "## 值得跟进\n"
        "- 通勤场景的语音输入试用反馈收集。\n",
        encoding="utf-8",
    )
    print("digest seeded:", DIGEST)

    async def run():
        return await podcast.from_digest(DIGEST)

    r = asyncio.run(run())
    try:
        assert r.get("ok"), r
        assert r["title"] == "笔记简报 __livetest_digest__", r["title"]
        assert r["turns"] >= 6 and r["duration_sec"] >= 15, r
        wav = podcast.PODCAST_DIR / r["file"]
        assert wav.exists() and wav.stat().st_size > 200_000, wav
        print(f"from_digest ok: {r['turns']} turns, {r['duration_sec']}s, {wav.name} ({wav.stat().st_size // 1024} KB)")
        for t in r["script"][:3]:
            who = "主持人" if t["speaker"] == "host" else "嘉宾"
            print(f"  {who}: {t['text'][:60]}")
        print("LIVE PASS")
    finally:
        if r.get("ok"):
            try:
                podcast.delete(r["id"])
                print("episode cleaned up")
            except Exception as e:  # noqa: BLE001
                print("cleanup warning:", e)
        DIGEST.unlink(missing_ok=True)


if __name__ == "__main__":
    sys.exit(main())
