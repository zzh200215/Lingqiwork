"""Offline tests for the V1.5 notes AI prompt composer (no LLM, no db).

Covers the new selection-rewrite and note-side-chat actions plus the
legacy whole-note actions and their input caps.
"""
import sys

import pytest

sys.path.insert(0, ".")

from app.routers.notes import (  # noqa: E402
    _CHAT_NOTE_CAP,
    _SELECTION_CONTEXT_CAP,
    AiAction,
    ChatTurn,
    _compose_prompt,
)


def _act(**kw) -> AiAction:
    base = {"action": "polish", "content": "笔记内容"}
    base.update(kw)
    return AiAction(**base)


def test_continue_keeps_writer_persona_and_directive():
    system, user = _compose_prompt(_act(action="continue", content="开头一段。"))
    assert "写作助手" in system
    assert "接着往下写" in user and "开头一段。" in user


def test_polish_and_summarize_embed_instruction_in_user():
    system, user = _compose_prompt(_act(action="summarize", content="正文"))
    assert "写作助手" in system and "摘要" in user and "正文" in user


def test_rewrite_requires_selection():
    with pytest.raises(ValueError):
        _compose_prompt(_act(action="rewrite", content="全文", selection="  "))


def test_rewrite_composes_selection_instruction_and_context():
    system, user = _compose_prompt(
        _act(action="rewrite", content="A" * 100, selection="选中的句子。")
    )
    assert "只改写" in system or "改写" in system
    assert "选中的句子。" in user
    assert "AAA" in user  # context present
    assert "润色这一段" in user  # default instruction applied


def test_rewrite_custom_instruction_overrides_default():
    _, user = _compose_prompt(
        _act(action="rewrite", content="ctx", selection="x", instruction="翻译成英文")
    )
    assert "翻译成英文" in user and "润色这一段" not in user


def test_rewrite_caps_note_context():
    _, user = _compose_prompt(
        _act(action="rewrite", content="A" * (_SELECTION_CONTEXT_CAP + 5000), selection="x")
    )
    assert user.count("A") == _SELECTION_CONTEXT_CAP


def test_chat_requires_question():
    with pytest.raises(ValueError):
        _compose_prompt(_act(action="chat", content="正文", question=" "))


def test_chat_composes_question_note_and_history():
    history = [ChatTurn(role="user", content=f"问题{i}") for i in range(8)]
    system, user = _compose_prompt(
        _act(action="chat", content="笔记正文", question="这篇的核心观点？", history=history)
    )
    assert "笔记编辑器" in system
    assert "这篇的核心观点？" in user
    assert "笔记正文" in user
    assert "问题7" in user  # last turn kept
    assert "问题0" not in user  # only the last _CHAT_HISTORY_TURNS kept


def test_chat_caps_note_content():
    _, user = _compose_prompt(
        _act(action="chat", content="N" * (_CHAT_NOTE_CAP + 9999), question="q")
    )
    assert user.count("N") == _CHAT_NOTE_CAP


def test_unknown_action_rejected():
    with pytest.raises(ValueError):
        _compose_prompt(_act(action="dream"))
