"""模型竞技场：同一个 prompt 并行打到所有已启用的 provider，并排对比。

平时每家 provider 只在降级链里隐身干活，你看不到它们单独长什么样——这里
看得见：同一句话、各家的回答、耗时、错误。也是降级链（tasks._candidates）
的天然测试台：竞技场列出来的就是降级时会用到的全部候选。

并行而不是逐家串行：一次点击的等待时长 = 最慢的那家，不是各家之和。

**两段输入**（§8.2 区2「同一输入并排比」）：`system` 是提示词（怎么答），
`prompt` 是这一问（答什么）。对打要量的正是「同一条提示词 + 同一段输入，几家谁答得好」，
所以这两个必须分开——合成一段就量不出「换了模型」这一件事。`system` 空 = 老行为
（整段当 user 消息），存量调用一个字节都不变。
"""
import asyncio
import logging
import time
from datetime import datetime

from app.config import VAULT_DIR
from app.core import usage_ledger
from app.core.llm import stream_chat

log = logging.getLogger(__name__)

MAX_PROMPT_CHARS = 4000
PER_CALL_TIMEOUT = 90  # 秒；本地大模型可能慢，但不该无限等

# 对打记录落在哪。**不落产出目录**（`deliver/` 那些）——它不是「交出去的东西」，
# 是一次对照的留痕；落那儿会让「你交出 N 份」那个数灌水（`pet._OUTPUT_DIRS` 的口径）。
DUEL_DIR = VAULT_DIR / "prompts" / "duels"


def _messages(prompt: str, system: str) -> list[dict]:
    """两段输入 → 给模型的消息。Pure.

    两条都**按有没有**决定加不加：`system` 空就不加（那正是「整段当 user 消息」的
    老行为），`prompt` 空也不加一条空的 user——空 content 有的 provider 会直接报错，
    而「提示词自己说全了、不需要额外输入」是正当用法。
    """
    msgs: list[dict] = []
    if system:
        msgs.append({"role": "system", "content": system})
    if prompt:
        msgs.append({"role": "user", "content": prompt})
    return msgs


@usage_ledger.traced("arena")
async def run(prompt: str, models: list[str] | None = None, system: str = "") -> list[dict]:
    """各答一次。**`models` 空 = 所有已启用的 provider**（原行为，一字不变）；
    给了就只打这几家——提示词页的「对打」要的是「选 2–4 个模型比一比」，
    而不是每次都把全家桶叫起来（那既慢又费钱）。

    永不抛异常——失败的算作该家 ok=False。
    """
    from app.core import providers
    from app.core.tasks import _candidates

    prompt = (prompt or "").strip()[:MAX_PROMPT_CHARS]
    system = (system or "").strip()[:MAX_PROMPT_CHARS]
    # 两段都空才叫没事可做。只有 system（提示词自己说全了）是**正当用法**。
    if not prompt and not system:
        return []
    try:
        candidates = await _candidates("")
    except Exception as e:  # noqa: BLE001 - 没有任何可用 provider 也要给一句人话
        return [{"label": "", "ok": False, "error": str(e), "seconds": 0.0}]

    if models:
        want = [m.strip() for m in models if m and m.strip()]
        if want:
            wanted = set(want)
            picked = [c for c in candidates if c[1] in wanted]
            # 点名的模型一个都没配上：**如实说**，而不是悄悄跑别的几家
            # （那样用户会以为自己在比 A 和 B，其实比的是别的）。
            missing = [m for m in want if all(c[1] != m for c in candidates)]
            if not picked:
                return [
                    {
                        "label": "",
                        "ok": False,
                        "error": f"这几个模型都没配上 provider：{'、'.join(missing) or '（空）'}",
                        "seconds": 0.0,
                    }
                ]
            candidates = picked

    async def _one(info, model: str, label: str) -> dict:
        t0 = time.monotonic()
        # 这一次调用的用量单独收着（方案 §8.2 区2 行2：每列要「耗时 / token 小字」）。
        # **自己拿着这个 dict**：账本那边只在调用方没有自己的账时才记（`usage_ledger.note`
        # 的注释），所以这里不会和 span 重复记账。
        usage: dict = {}

        def _tokens() -> dict:
            tin = usage.get("input")
            tout = usage.get("output")
            # 上游没回用量时是 `None`（有的 provider 不报）——**不编一个 0 出来**，
            # 那一格在界面上不摆。`0` 与「没报」是两件事。
            return {
                "tokens_in": int(tin) if tin else None,
                "tokens_out": int(tout) if tout else None,
            }

        try:
            chunks: list[str] = []

            async def _collect() -> None:
                async for delta in stream_chat(
                    info, model, _messages(prompt, system), usage=usage
                ):
                    chunks.append(delta)

            await asyncio.wait_for(_collect(), timeout=PER_CALL_TIMEOUT)
            text = "".join(chunks).strip()
            if not text:
                return {
                    "label": label,
                    "ok": False,
                    "error": "模型返回空内容",
                    "seconds": round(time.monotonic() - t0, 1),
                    **_tokens(),
                }
            return {
                "label": label,
                "ok": True,
                "text": text,
                "seconds": round(time.monotonic() - t0, 1),
                **_tokens(),
            }
        except asyncio.TimeoutError:
            log.warning("arena: %s timed out after %ss", label, PER_CALL_TIMEOUT)
            return {
                "label": label,
                "ok": False,
                "error": f"超时未响应（>{PER_CALL_TIMEOUT}s）",
                "seconds": round(time.monotonic() - t0, 1),
                **_tokens(),
            }
        except Exception as e:  # noqa: BLE001 - 一家挂了不影响其他家的成绩
            log.warning("arena: %s failed", label, exc_info=True)
            code = providers.error_code(e) if hasattr(providers, "error_code") else type(e).__name__
            return {
                "label": label,
                "ok": False,
                "error": f"{code}: {e}"[:300],
                "seconds": round(time.monotonic() - t0, 1),
                **_tokens(),
            }

    results = await asyncio.gather(*[_one(info, model, label) for info, model, label in candidates])
    return list(results)


# ---------- 对打记录（§8.2 区2 行3） ----------


def _fmt_ms(seconds: float) -> str:
    return f"{seconds:g}s"


async def save_record(
    *,
    title: str = "",
    system: str = "",
    prompt: str = "",
    results: list[dict] | None = None,
    model_id: str = "",
) -> dict:
    """一次对打 → `vault/prompts/duels/` 里一篇 md，并进索引。

    **它是一份「对照记录」，不是一条断言。** 方案 §8.2 区2 行3 原话是「存为用例 →
    进评测区 golden set」，但那个金标集挂的是**登记表**里的系统提示词
    （`backend/evals/prompts/*.json`，用例写的是「一句真实输入 + 该满足哪些断言」），
    而库里这些提示词**不在那张表里**。硬塞进去要先回答「这条库提示词对应登记表的哪一条」,
    那是个编出来的对应关系。所以这里存的是**它本来的东西**：这次比了什么、各家答了什么。
    可回看、可 diff、进索引之后能被下一次取材捞回来——但不假装它是 pass/fail。

    落 `prompts/duels/` 而**不是产出目录**：它不是「交出去的东西」，落 `deliver/`
    会让「你交出 N 份」这个数灌水。
    """
    from app.core.report import prompt_sha, slug

    rows = results or []
    if not rows:
        raise ValueError("没有可存的结果")

    head = (title or prompt or system).strip().replace("\n", " ")[:60] or "对打"
    dest_dir = DUEL_DIR
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / f"{datetime.now():%Y-%m-%d}-{slug(head, 'duel')}.md"

    lines = [f"# 对打：{head}", ""]
    if system:
        lines += ["## 提示词", "", "```", system, "```", ""]
    if prompt:
        lines += ["## 输入", "", "```", prompt, "```", ""]
    lines += [f"## 结果 · {len(rows)} 家", ""]
    for r in rows:
        label = str(r.get("label") or "（没有配上的模型）")
        if r.get("ok"):
            tok = f" · {r.get('tokens_in') or 0}+{r.get('tokens_out')} tok" if r.get("tokens_out") else ""
            lines += [f"### {label} · {_fmt_ms(float(r.get('seconds') or 0))}{tok}", "", str(r.get("text") or ""), ""]
        else:
            lines += [f"### {label} · 失败", "", f"> {r.get('error') or '这一家没答上来'}", ""]
    lines += [
        "---",
        "",
        # 指纹：与质量闭环同一个算法。它让「这次比的是哪一版提示词」以后还答得出来。
        f"系统提示词指纹：{prompt_sha(system) if system else '（这次没有提示词，只有输入）'}",
        f"模型：{model_id or '（默认）'}",
        "",
    ]
    dest.write_text("\n".join(lines), encoding="utf-8")
    rel = dest.relative_to(VAULT_DIR).as_posix()

    from app.core import indexer

    chunks = await asyncio.to_thread(indexer.index_file, dest)
    return {"filename": rel, "chunks": chunks}
