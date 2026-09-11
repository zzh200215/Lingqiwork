"""Agent collaboration: deterministic multi-agent runs (no autonomous
orchestration — the LobeHub CAO style remains in the observation pool until
the pattern matures). Two proven shapes:

- pipeline: agents run in sequence, each building on the previous output;
- review:   agents[0] drafts → agents[1] critiques → agents[0] revises.

The core here is a pure-ish orchestrator: it receives plain agent dicts plus
callables for model resolution and retrieval, and yields (event, data) pairs;
the router maps those to SSE and persistence. Tools are intentionally off in
v1 — collaboration multiplies token cost already.
"""
import logging

from app.core.llm import stream_chat
from app.core import usage_ledger

log = logging.getLogger(__name__)

PATTERNS = ("pipeline", "review")
PATTERN_LABELS = {"pipeline": "流水线", "review": "评审回路"}
MIN_AGENTS = 2
MAX_AGENTS = 4
MAX_GOAL_CHARS = 4000
MAX_STEP_OUT_CHARS = 8000  # per-step output fed to the next step
MAX_STEP_TOKEN_WORDS = 900  # nudge steps to stay focused
RAG_TOP_K = 5

_STEP_ICONS = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣"]

_DEFAULT_SYSTEM = "你是协作团队中的一名成员，专注完成分配给你的环节。"

_REVIEW_SYSTEM = (
    "你是严格的评审。审阅给出的文稿，指出事实错误、逻辑断层、结构问题和遗漏，"
    "给出编号的、可执行的修改清单；不要重写全文，不要客套。"
)

_REVISION_INSTRUCTION = (
    "请参考评审意见输出修订后的完整终稿，直接输出全文，"
    "不要输出修改说明或评审回应。未被评审意见涉及的部分保持原样。"
)


def build_steps(pattern: str, agents: list[dict]) -> list[dict]:
    """Plan the run. Pure; raises ValueError on invalid configuration.

    Each step: {agent, title, phase} — phase drives the prompt template.
    """
    if pattern not in PATTERNS:
        raise ValueError(f"未知协作模式: {pattern}")
    if not (MIN_AGENTS <= len(agents) <= MAX_AGENTS):
        raise ValueError(f"协作需要 {MIN_AGENTS}~{MAX_AGENTS} 个智能体")
    if pattern == "review":
        a, b = agents[0], agents[1]
        return [
            {"agent": a, "title": f"初稿 · {a['name']}", "phase": "draft"},
            {"agent": b, "title": f"评审 · {b['name']}", "phase": "review"},
            {"agent": a, "title": f"修订终稿 · {a['name']}", "phase": "revise"},
        ]
    return [{"agent": a, "title": a["name"], "phase": "work"} for a in agents]


def header_md(pattern: str, agents: list[dict]) -> str:
    if pattern == "review":
        chain = f"{agents[0]['avatar']} {agents[0]['name']} ⟳ {agents[1]['avatar']} {agents[1]['name']}"
    else:
        chain = " → ".join(f"{a['avatar']} {a['name']}" for a in agents)
    return f"> 👥 **协作 · {PATTERN_LABELS[pattern]}** — {chain}\n"


def _cap(text: str, limit: int = MAX_STEP_OUT_CHARS) -> str:
    text = text.strip()
    return text if len(text) <= limit else text[:limit] + "\n…（超长截断）"


def compose_messages(step: dict, goal: str, prev: str | None, prev_title: str, rag_block: str) -> list[dict]:
    """Build the chat messages for one step. Pure."""
    agent = step["agent"]
    phase = step["phase"]
    system = (agent.get("system_prompt") or "").strip() or _DEFAULT_SYSTEM
    messages: list[dict] = [{"role": "system", "content": system}]
    if rag_block and phase in ("work", "draft"):
        messages.append({"role": "system", "content": rag_block})

    if phase == "work":
        user = f"【目标】\n{goal}"
        if prev:
            user += f"\n\n【上一步产出（来自 {prev_title}）】\n{_cap(prev)}\n\n请在此基础上完成你负责的环节，不要重复上游内容。"
    elif phase == "draft":
        user = f"【任务】\n{goal}\n\n请写出完整的初稿。控制在 {MAX_STEP_TOKEN_WORDS} 词以内。"
    elif phase == "review":
        user = f"【原始任务】\n{goal}\n\n【待评审文稿（来自 {prev_title}）】\n{_cap(prev)}"
    else:  # revise
        user = (
            f"【原始任务】\n{goal}\n\n【你的初稿（来自 {prev_title}）】\n{_cap(prev)}\n\n"
            f"【评审意见】\n{_cap(step.get('review_notes') or '', 4000)}\n\n{_REVISION_INSTRUCTION}"
        )
    messages.append({"role": "user", "content": user})
    return messages


def build_rag_block(sources: list[dict]) -> str:
    """Same spirit as chat's RAG context, trimmed for a collaboration step."""
    if not sources:
        return ""
    lines = ["以下是从用户知识库检索到的资料片段，供参考引用："]
    for s in sources[:RAG_TOP_K]:
        text = (s.get("text") or "").strip()
        if text:
            lines.append(f"---\n[{s.get('source', '未知来源')}]\n{text[:1200]}")
    return "\n".join(lines) if len(lines) > 1 else ""


@usage_ledger.traced("collab")
async def run(
    goal: str,
    agents: list[dict],
    pattern: str,
    resolve,  # async (model_id: str) -> (ProviderInfo, model)
    retrieve=None,  # async (query: str, top_k: int) -> list[dict] | None
):
    """Execute the collaboration. Async generator of (event, data) tuples.

    Events: meta, sources, delta, error, done. Deltas carry the full
    markdown transcript incrementally (header + step sections), so the
    client just appends them to one message.
    """
    goal = (goal or "").strip()
    if not goal:
        raise ValueError("目标为空")
    if len(goal) > MAX_GOAL_CHARS:
        raise ValueError(f"目标超过 {MAX_GOAL_CHARS} 字上限")
    steps = build_steps(pattern, agents)

    yield "meta", {
        "pattern": pattern,
        "agents": [{"name": a["name"], "avatar": a["avatar"], "model_id": a.get("model_id", "")} for a in agents],
        "steps": [s["title"] for s in steps],
    }

    transcript = [header_md(pattern, agents)]
    yield "delta", {"text": transcript[0]}

    rag_block = ""
    if retrieve is not None:
        try:
            sources = await retrieve(goal, RAG_TOP_K)
        except Exception as e:  # noqa: BLE001 - RAG failure must not break the run
            log.warning("collab retrieval failed: %s", e)
            sources = []
        if sources:
            rag_block = build_rag_block(sources)
            yield "sources", {"sources": sources}

    prev: str | None = None
    prev_title = ""
    review_notes = ""
    draft, draft_title = "", ""  # revise needs the original draft, not the review
    ok = True
    for i, step in enumerate(steps):
        if step["phase"] == "revise":
            step = {**step, "review_notes": review_notes}
            use_prev, use_title = draft, draft_title
        else:
            use_prev, use_title = prev, prev_title
        section = f"\n\n## {_STEP_ICONS[i]} {step['title']}\n\n"
        transcript.append(section)
        yield "delta", {"text": section}
        buf: list[str] = []
        try:
            resolved = await resolve(step["agent"].get("model_id", ""))
            info, model = (resolved.provider, resolved.model) if hasattr(resolved, "provider") else resolved
            messages = compose_messages(step, goal, use_prev, use_title, rag_block)
            async for chunk in stream_chat(info, model, messages):
                buf.append(chunk)
                yield "delta", {"text": chunk}
        except Exception as e:  # noqa: BLE001 - report and stop the run
            yield "error", {"message": f"第 {i + 1} 步「{step['title']}」失败：{type(e).__name__}: {e}"}
            ok = False
            break
        out = "".join(buf).strip()
        if not out:
            yield "error", {"message": f"第 {i + 1} 步「{step['title']}」返回空内容"}
            ok = False
            break
        transcript.append(out)
        if step["phase"] == "review":
            review_notes = out
        elif step["phase"] == "draft":
            draft, draft_title = out, step["title"]
        prev, prev_title = out, step["title"]

    yield "done", {"ok": ok, "steps": len(steps), "transcript": "".join(transcript)}
