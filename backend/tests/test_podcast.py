"""V12 notes→podcast tests: script parsing, PyAV decode/assemble, and the
full generation flow over fake LLM/TTS seams. No network, no real voices.
"""
import atexit
import json
import os
import shutil
import struct
import sys
import tempfile
import wave
from pathlib import Path

import pytest

sys.path.insert(0, ".")

# 必须在 import app 之前绑到临时库：本模块以前从不设 env，靠套件里别的测试
# 先导入 app 才碰巧没事——单独跑就会把引擎绑到默认库上去。
_POD_TMP = Path(tempfile.mkdtemp(prefix="wb-podcast-", dir=Path(__file__).parent))
atexit.register(lambda: shutil.rmtree(_POD_TMP, ignore_errors=True))
os.environ["WB_DB_PATH"] = str(_POD_TMP / "test.db")
os.environ["WB_CONFIG_PATH"] = str(_POD_TMP / "config.json")
os.environ["WB_CHROMA_PATH"] = str(_POD_TMP / "chroma")

from app.core import podcast

_SCRATCHES: list[Path] = []


def _scratch() -> Path:
    d = Path(tempfile.mkdtemp(prefix="wb-pod-", dir=Path(__file__).parent))
    _SCRATCHES.append(d)
    return d


def _cleanup() -> None:
    for d in _SCRATCHES:
        shutil.rmtree(d, ignore_errors=True)


atexit.register(_cleanup)


def _tiny_wav(path: Path, seconds: float = 0.2, rate: int = 8000) -> None:
    """A real 16-bit mono wav (sine) small enough to decode instantly."""
    import math

    path.parent.mkdir(parents=True, exist_ok=True)
    frames = b"".join(
        struct.pack("<h", int(12000 * math.sin(2 * math.pi * 440 * i / rate)))
        for i in range(int(seconds * rate))
    )
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(frames)


@pytest.fixture()
def pod_env(monkeypatch):
    root = _scratch()
    monkeypatch.setattr(podcast, "PODCAST_DIR", root / "podcasts")
    monkeypatch.setattr(podcast, "VAULT_DIR", root / "vault")
    (root / "vault").mkdir(parents=True, exist_ok=True)
    return root


# ---------- _parse_script ----------


def test_parse_bare_array():
    turns = podcast._parse_script('[{"speaker":"host","text":"你好"},{"speaker":"guest","text":"大家好"}]')
    assert [t["speaker"] for t in turns] == ["host", "guest"]
    assert turns[1]["text"] == "大家好"


def test_parse_turns_object_and_fences():
    raw = '```json\n{"turns": [{"speaker": "host", "text": "开场"}, {"speaker": "guest", "text": "正文"}]}\n```'
    turns = podcast._parse_script(raw)
    assert len(turns) == 2 and turns[0]["text"] == "开场"


def test_parse_speaker_aliases():
    raw = [{"speaker": s, "text": "x"} for s in ("主持人", "嘉宾", "A", "B", "甲", "乙", "路人")]
    turns = podcast._parse_script(json.dumps(raw))
    assert [t["speaker"] for t in turns] == ["host", "guest", "host", "guest", "host", "guest", "guest"]


@pytest.mark.parametrize(
    "raw",
    ["", "   ", "模型很抱歉无法完成", '{"foo": 1}', '{"turns": []}', "[[1,2],[3,4]]"],
)
def test_parse_rejects_garbage(raw):
    with pytest.raises(ValueError):
        podcast._parse_script(raw)


def test_parse_drops_empty_and_caps_length():
    raw = [
        {"speaker": "host", "text": "  "},
        {"speaker": "guest", "text": "字" * 1000},
        {"speaker": "host"},  # no text
    ]
    turns = podcast._parse_script(json.dumps(raw))
    assert len(turns) == 1
    assert turns[0]["text"] == "字" * podcast.MAX_TURN_CHARS


def test_parse_caps_turn_count():
    raw = [{"speaker": "host", "text": f"第{i}句"} for i in range(podcast.MAX_TURNS + 15)]
    assert len(podcast._parse_script(json.dumps(raw))) == podcast.MAX_TURNS


# ---------- decode + assemble ----------


def test_decode_resamples_to_24k(pod_env):
    src = pod_env / "seg.wav"
    _tiny_wav(src, seconds=0.2, rate=8000)
    pcm = podcast._decode_24k(src)
    samples = len(pcm) / 2  # s16 → 2 bytes per sample
    # resampling keeps duration (0.2s @ 24k), minus a hair of filter edge
    assert abs(samples - 0.2 * podcast.RATE) < 0.02 * podcast.RATE * 0.2


def test_assemble_wav_duration_and_gaps(pod_env):
    out = pod_env / "podcasts" / "x.wav"
    seg_path = pod_env / "seg.wav"
    _tiny_wav(seg_path, seconds=0.2, rate=8000)
    seg = podcast._decode_24k(seg_path)
    duration = podcast._assemble_wav([seg, seg], out)
    expected = 2 * 0.2 + podcast.GAP_SEC  # resampling preserves duration + one gap
    assert abs(duration - expected) < 0.05
    with wave.open(str(out), "rb") as w:
        assert w.getframerate() == podcast.RATE and w.getnchannels() == 1
        assert abs(w.getnframes() / w.getframerate() - duration) < 0.01


# ---------- generate flow ----------


def _seed_notes(root: Path, *names: str) -> list[str]:
    rels = []
    for i, name in enumerate(names):
        p = root / "vault" / name
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(f"# {name}\n\n星尘计划由张三在 2025 年发起，目标是本地优先的个人知识库。\n", encoding="utf-8")
        rels.append(name)
    return rels


_SCRIPT = json.dumps(
    {
        "turns": [
            {"speaker": "host", "text": "开场问题"},
            {"speaker": "guest", "text": "基于笔记的回答"},
            {"speaker": "host", "text": "追问"},
            {"speaker": "guest", "text": "补充收尾"},
        ]
    },
    ensure_ascii=False,
)


def test_generate_full_flow(pod_env, monkeypatch):
    rels = _seed_notes(pod_env, "notes/a.md")

    async def fake_writer():
        return ("fake", "fake-model")

    async def fake_llm(prompt, info, model):
        assert "星尘计划" in prompt
        return _SCRIPT

    calls: list[tuple[str, str]] = []

    async def fake_synth(text, voice):
        calls.append((text, voice))
        p = pod_env / f"tts-{len(calls)}.wav"
        _tiny_wav(p, seconds=0.1, rate=24000)
        return p

    monkeypatch.setattr(podcast, "_resolve_writer", fake_writer)
    monkeypatch.setattr(podcast, "_llm_script", fake_llm)
    monkeypatch.setattr(podcast, "_synth_turn", fake_synth)

    result = _run(podcast.generate(rels, "zh-CN-YunxiNeural", "zh-CN-XiaoxiaoNeural"))

    assert result["ok"] is True
    assert result["turns"] == 4
    assert result["duration_sec"] > 0
    assert result["sources"] == rels
    assert result["file"].endswith(".wav")
    wav = podcast.PODCAST_DIR / result["file"]
    assert wav.exists() and wav.read_bytes()[:4] == b"RIFF"
    # host turns got the host voice, guest turns the guest voice
    assert calls[0] == ("开场问题", "zh-CN-YunxiNeural")
    assert calls[1] == ("基于笔记的回答", "zh-CN-XiaoxiaoNeural")
    # index persisted with the entry on top
    index = json.loads((podcast.PODCAST_DIR / "index.json").read_text(encoding="utf-8"))
    assert index["podcasts"][0]["id"] == result["id"]
    assert podcast.list_podcasts()[0]["id"] == result["id"]


def _run(coro):
    import asyncio

    return asyncio.run(coro)


def _run_stream(gen):
    """Collect an async generator into a list of (event, data) pairs."""
    import asyncio

    async def collect():
        return [item async for item in gen]

    return asyncio.run(collect())


def test_generate_no_provider(pod_env, monkeypatch):
    rels = _seed_notes(pod_env, "notes/b.md")

    async def no_writer():
        return None

    monkeypatch.setattr(podcast, "_resolve_writer", no_writer)
    r = _run(podcast.generate(rels))
    assert r["ok"] is False and "provider" in r["error"]


# ---------- digest deepening (V15) ----------


def test_generate_still_rejects_generated_dirs(pod_env):
    (pod_env / "vault" / "digests").mkdir(parents=True, exist_ok=True)
    (pod_env / "vault" / "digests" / "2026-08-30.md").write_text("# 摘要\n\n内容", encoding="utf-8")
    with pytest.raises(ValueError, match="笔记文件"):
        podcast._collect_notes(["digests/2026-08-30.md"])


def test_generate_from_blocks_flow(pod_env, monkeypatch):
    """generate_from_blocks skips note validation — used by the digest hook."""
    async def fake_writer():
        return ("fake", "fake-model")

    async def fake_llm(prompt, info, model):
        assert "简报材料" in prompt
        return _SCRIPT

    async def fake_synth(text, voice):
        p = pod_env / f"tts-{voice}.wav"
        _tiny_wav(p, seconds=0.1, rate=24000)
        return p

    monkeypatch.setattr(podcast, "_resolve_writer", fake_writer)
    monkeypatch.setattr(podcast, "_llm_script", fake_llm)
    monkeypatch.setattr(podcast, "_synth_turn", fake_synth)

    r = _run(podcast.generate_from_blocks([("digests/2026-08-30.md", "简报材料")], title="早报"))
    assert r["ok"] is True and r["title"] == "早报" and r["sources"] == ["digests/2026-08-30.md"]


def test_generate_iter_event_sequence(pod_env, monkeypatch):
    """V16: the streaming variant yields script → tts×N → assemble → done."""
    async def fake_writer():
        return ("fake", "fake-model")

    async def fake_llm(prompt, info, model):
        return _SCRIPT  # 4 turns

    async def fake_synth(text, voice):
        p = pod_env / f"tts-{len(text)}.wav"
        _tiny_wav(p, seconds=0.1, rate=24000)
        return p

    monkeypatch.setattr(podcast, "_resolve_writer", fake_writer)
    monkeypatch.setattr(podcast, "_llm_script", fake_llm)
    monkeypatch.setattr(podcast, "_synth_turn", fake_synth)

    events = _run_stream(podcast.generate_from_blocks_iter([("notes/a.md", "材料")]))

    kinds = [e for e, _ in events]
    assert kinds[0] == "stage" and events[0][1]["stage"] == "script"
    assert kinds.count("stage") == 4 + 2  # script + 4 tts + assemble
    tts_events = [d for e, d in events if e == "stage" and d["stage"] == "tts"]
    assert [(d["index"], d["total"]) for d in tts_events] == [(1, 4), (2, 4), (3, 4), (4, 4)]
    assert kinds[-1] == "done"
    done = events[-1][1]
    assert done["ok"] is True and done["turns"] == 4 and done["file"].endswith(".wav")
    # generate_from_blocks still returns the done payload (ids differ per run)
    r = _run(podcast.generate_from_blocks([("notes/a.md", "材料")]))
    assert {k: v for k, v in r.items() if k not in ("id", "file", "created_at")} == {
        k: v for k, v in done.items() if k not in ("id", "file", "created_at")
    }


def test_generate_iter_error_is_terminal_done(pod_env, monkeypatch):
    async def no_writer():
        return None

    monkeypatch.setattr(podcast, "_resolve_writer", no_writer)
    events = _run_stream(podcast.generate_from_blocks_iter([("notes/a.md", "材料")]))
    assert events == [("done", {"ok": False, "error": "没有已启用的 provider，无法生成播客脚本"})]


def test_from_digest_full_flow(pod_env, monkeypatch):
    digests = pod_env / "vault" / "digests"
    digests.mkdir(parents=True, exist_ok=True)
    (digests / "2026-08-30.md").write_text("# 笔记摘要 2026-08-30\n\n今天写了三篇笔记。", encoding="utf-8")

    async def fake_writer():
        return ("fake", "fake-model")

    async def fake_llm(prompt, info, model):
        assert "笔记摘要" in prompt
        return _SCRIPT

    async def fake_synth(text, voice):
        p = pod_env / "t.wav"
        _tiny_wav(p, seconds=0.1, rate=24000)
        return p

    monkeypatch.setattr(podcast, "_resolve_writer", fake_writer)
    monkeypatch.setattr(podcast, "_llm_script", fake_llm)
    monkeypatch.setattr(podcast, "_synth_turn", fake_synth)

    r = _run(podcast.from_digest(digests / "2026-08-30.md"))
    assert r["ok"] is True
    assert r["title"] == "笔记简报 2026-08-30"  # default title from the stem
    assert r["sources"] == ["digests/2026-08-30.md"]  # vault-relative, not rejected


def test_from_digest_missing_and_empty(pod_env):
    digests = pod_env / "vault" / "digests"
    digests.mkdir(parents=True, exist_ok=True)
    r = _run(podcast.from_digest(digests / "ghost.md"))
    assert r["ok"] is False and "不存在" in r["error"]
    (digests / "empty.md").write_text("   \n", encoding="utf-8")
    r = _run(podcast.from_digest(digests / "empty.md"))
    assert r["ok"] is False and "空" in r["error"]


def test_digest_podcast_hook(pod_env, monkeypatch):
    from app.core import digest

    digests = pod_env / "vault" / "digests"
    digests.mkdir(parents=True, exist_ok=True)
    (digests / "2026-08-30.md").write_text("内容", encoding="utf-8")
    monkeypatch.setattr(digest, "DIGEST_DIR", digests)
    monkeypatch.setattr(digest, "load_config", lambda: {"podcast_daily_enabled": True})
    calls: list = []

    async def fake_from_digest(path):
        calls.append(path)
        return {"ok": True, "id": "pod-x"}

    monkeypatch.setattr(podcast, "from_digest", fake_from_digest)
    _run(digest._maybe_podcast({"ok": True, "files": 3, "file": "2026-08-30.md"}))
    assert calls == [digests / "2026-08-30.md"]


def test_digest_podcast_hook_guards(pod_env, monkeypatch):
    """Off pref, failed digest, or raising from_digest must all be no-ops."""
    from app.core import digest

    monkeypatch.setattr(digest, "DIGEST_DIR", pod_env)
    calls: list = []

    async def fake_from_digest(path):
        calls.append(path)
        return {"ok": True}

    monkeypatch.setattr(podcast, "from_digest", fake_from_digest)

    monkeypatch.setattr(digest, "load_config", lambda: {"podcast_daily_enabled": False})
    _run(digest._maybe_podcast({"ok": True, "files": 1, "file": "a.md"}))
    assert not calls

    monkeypatch.setattr(digest, "load_config", lambda: {"podcast_daily_enabled": True})
    _run(digest._maybe_podcast({"ok": False, "error": "x", "files": 1, "file": "a.md"}))
    _run(digest._maybe_podcast({"ok": True, "files": 0, "file": "a.md"}))
    _run(digest._maybe_podcast({"ok": True, "files": 1}))  # no file key
    assert not calls

    async def raising(path):
        raise RuntimeError("tts down")

    monkeypatch.setattr(podcast, "from_digest", raising)
    _run(digest._maybe_podcast({"ok": True, "files": 1, "file": "a.md"}))  # must not raise


def test_generate_bad_script(pod_env, monkeypatch):
    rels = _seed_notes(pod_env, "notes/c.md")

    async def fake_writer():
        return ("fake", "fake-model")

    async def bad_llm(prompt, info, model):
        return "我觉得这篇笔记写得不错，就不改成对话了。"

    async def unused_synth(text, voice):  # pragma: no cover - must not be reached
        raise AssertionError("synth should not run on a bad script")

    monkeypatch.setattr(podcast, "_resolve_writer", fake_writer)
    monkeypatch.setattr(podcast, "_llm_script", bad_llm)
    monkeypatch.setattr(podcast, "_synth_turn", unused_synth)
    r = _run(podcast.generate(rels))
    assert r["ok"] is False and "JSON" in r["error"]


def test_generate_empty_notes_raises(pod_env):
    with pytest.raises(ValueError):
        _run(podcast.generate([]))


def test_collect_notes_validation(pod_env):
    (pod_env / "vault" / "empty.md").write_text("", encoding="utf-8")
    (pod_env / "vault" / "pic.png").write_bytes(b"\x89PNG")
    with pytest.raises(ValueError, match="不存在"):
        podcast._collect_notes(["notes/ghost.md"])
    with pytest.raises(ValueError, match="笔记文件"):
        podcast._collect_notes(["pic.png"])
    with pytest.raises(ValueError, match="为空"):
        podcast._collect_notes(["empty.md"])


def test_delete_roundtrip(pod_env):
    podcast._save_index(
        [
            {"id": "pod-1", "file": "pod-1.wav"},
            {"id": "pod-2", "file": "pod-2.wav"},
        ]
    )
    (podcast.PODCAST_DIR / "pod-1.wav").write_bytes(b"RIFF----")
    podcast.delete("pod-1")
    assert [e["id"] for e in podcast.list_podcasts()] == ["pod-2"]
    assert not (podcast.PODCAST_DIR / "pod-1.wav").exists()
    with pytest.raises(FileNotFoundError):
        podcast.delete("pod-1")


# ---------- 卡点讨论播客端点（对话播客 2.0） ----------


async def test_stuck_podcast_endpoint(pod_env, monkeypatch):
    from fastapi import HTTPException

    from app.routers import podcast as pod_router

    async def fake_blocks(days=90, cap=8):
        assert days == 30
        return [("卡点：闭包（半懂）", "卡在变量捕获")]

    async def fake_gen(blocks, host_voice="", guest_voice="", title=""):
        assert blocks and "卡点讨论" in title
        return {"ok": True, "id": "p1", "file": "p1.wav", "title": title}

    monkeypatch.setattr("app.core.tutor.stuck_blocks", fake_blocks)
    monkeypatch.setattr(podcast, "generate_from_blocks", fake_gen)
    r = await pod_router.stuck_podcast(pod_router.StuckPodcastIn(days=30))
    assert r["ok"] is True and r["file"] == "p1.wav"

    # 没有卡点就明说，不是空转
    async def empty(days=90, cap=8):
        return []

    monkeypatch.setattr("app.core.tutor.stuck_blocks", empty)
    with pytest.raises(HTTPException, match="卡点"):
        await pod_router.stuck_podcast(pod_router.StuckPodcastIn())


# ---------- 单音色念稿（M4 · 周报的一键转播客） ----------
#
# 与上面那条路的区别只有一处、也是最要紧的一处：**不过模型**。稿子已经是成品文本
# （`weekly.text()` 出来的），这里要的不是编剧只是一张嘴——所以这几条用例里没有
# `_resolve_writer` / `_llm_script` 的替身，它们根本不该被碰到。


def test_split_sentences_breaks_on_chinese_punctuation_and_lines():
    got = podcast._split_sentences("第一句。第二句！第三句？\n第四句")
    assert got == ["第一句。", "第二句！", "第三句？", "第四句"]


def test_split_sentences_caps_count_and_length():
    assert len(podcast._split_sentences("句。" * 200)) == podcast.MAX_TURNS
    # 没有标点的长段：硬切，别让一句合成撑爆单句上限
    got = podcast._split_sentences("字" * (podcast.MAX_TURN_CHARS * 2 + 5))
    assert [len(s) for s in got] == [podcast.MAX_TURN_CHARS, podcast.MAX_TURN_CHARS, 5]


def test_speak_text_renders_one_voice(pod_env, monkeypatch):
    calls: list[tuple[str, str]] = []

    async def fake_synth(text, voice):
        calls.append((text, voice))
        p = pod_env / f"tts-{len(calls)}.wav"
        _tiny_wav(p, seconds=0.1, rate=24000)
        return p

    monkeypatch.setattr(podcast, "_synth_turn", fake_synth)
    r = _run(
        podcast.speak_text("这周你消化了 2 份材料。周三说通了 1 个概念！", title="周报 09-14–09-16")
    )

    assert r["ok"] is True and r["turns"] == 2
    assert [t["text"] for t in r["script"]] == ["这周你消化了 2 份材料。", "周三说通了 1 个概念！"]
    # 单音色：两句同一个声音——这就是「念稿」与「对话」的区别
    assert {v for _t, v in calls} == {podcast.HOST_VOICE}
    # 音频是真的，而且进了**同一个**索引（陪伴页那张列表里就能看到它）
    wav = podcast.PODCAST_DIR / r["file"]
    assert wav.exists() and wav.read_bytes()[:4] == b"RIFF"
    assert r["sources"] == [] and r["title"] == "周报 09-14–09-16"
    assert podcast.list_podcasts()[0]["id"] == r["id"]


def test_speak_text_defaults_the_title_and_refuses_an_empty_script(pod_env, monkeypatch):
    async def fake_synth(text, voice):
        p = pod_env / "t.wav"
        _tiny_wav(p, seconds=0.1, rate=24000)
        return p

    monkeypatch.setattr(podcast, "_synth_turn", fake_synth)
    # 没有材料文件名可借（`sources` 是空的）→ 标题就老老实实叫「播客」
    assert _run(podcast.speak_text("一句。"))["title"] == "播客"
    # 空稿子不叫 TTS，也不该留下一条空音频
    r = _run(podcast.speak_text("   \n\n"))
    assert r["ok"] is False and "没有可念" in r["error"]
    assert [e["title"] for e in podcast.list_podcasts()] == ["播客"]
