"""聊天回合的行为标尺（W1）：把「这一轮应该发生什么」变成可回归的用例。

**为什么需要它（缺口一）。** `engine_eval` 盖的是「一次生成一份成文」，`evals` 盖的是
「检索准不准」。而**用户每天真正在用的那条路——聊天的工具循环——一层都没盖**：
「模型有没有真的把东西存下来、有没有说谎、一轮存了几份、正文有没有被回填进对话」——
零覆盖。而且当轮所有结论都是临时脚本量出来的，量完就散（见 `upgrade-plan.md` §2.2）。

**它跑的是产品自己那条路**：`routers.chat._generate`（那条 SSE 生成器），不是另写一套
拼装——同 `engine_eval._synthesize_collect` 的理由：测一条已经不在生产路径上的代码，
等于量错了对象。工具循环的原始账（轮数、每个工具的大小与耗时）直接读 W5 的 `turn_traces`。

**两层判分，分工与 `engine_eval` 一致：**

1. **确定性判分**（`CHECKS`，纯函数、零模型成本）：断言的是**产品承诺过的**行为，
   每一条都对着一个实测到的缺陷（`evals/turns/*.json` 的 `note` 里逐条写着）。
2. **LLM 判分**（`judge_receipt`，0-5）：回执是不是「一行话」。这一条没法确定性地判——
   「把成品复述一遍」和「一句话回执」的差别在语义上，不在长度上。

**统计出口是硬要求**：报告给 `k/n` + **Wilson 区间**，不是裸比例。这一轮的项目已经吃过
一次：2/24 与 1/24 拿裸比例是分不出真假的（§7 的过程指标）。

**成本**：一条用例 = 一次完整的聊天回合（工具循环 1..N 次调用），再加一次判分调用。
整轮套 `usage_ledger.traced("turn_eval")`，所以账本里看得见这一次评测花了多少。
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import time
from contextlib import contextmanager
from pathlib import Path

from pydantic import BaseModel, field_validator

from app.config import BASE_DIR
from app.core.llm import ProviderInfo
from app.core.prompt_eval import wilson
from app.core.structured import extract_json
from app.db import SessionLocal
from app.models import TurnEvalRun

log = logging.getLogger(__name__)

FIXTURE_DIR = BASE_DIR / "backend" / "evals" / "turns"
ANSWER_CAP = 2000  # detail_json 里保留的回复长度（足够人审，不至于撑爆）
BODY_OVERLAP_CHARS = 120  # 回复里出现这么长一段正文 = 正文被回填进对话了
# 临时向量库的目录名前缀。清索引前先认这个标记 —— 认不出来就绝不下手（见 `_reset_index`）。
SCRATCH_CHROMA_MARK = "wb-turn-eval-chroma-"


# ---------- golden set ----------


def scenarios() -> list[str]:
    if not FIXTURE_DIR.is_dir():
        return []
    return sorted(p.stem for p in FIXTURE_DIR.glob("*.json"))


def load_scenario(key: str) -> dict:
    """读一套回合用例。坏文件 → 空（标尺可选，不该让 CLI 打不开）。"""
    path = FIXTURE_DIR / f"{key}.json"
    try:
        blob = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        log.warning("turn eval fixture unreadable: %s", path, exc_info=True)
        return {"key": key, "note": "", "cases": [], "sha": ""}
    raw = path.read_text(encoding="utf-8")
    cases: list[dict] = []
    for c in blob.get("cases") or []:
        if not isinstance(c, dict) or not str(c.get("id") or "").strip():
            continue
        cases.append(
            {
                "id": str(c["id"]),
                "ask": str(c.get("ask") or ""),
                "expect": dict(c.get("expect") or {}),
                # **每条用例都要声明 vault 条件**（缺口五）：同一句自然说法在空 vault 下
                # 0/4、有素材时 15/16 —— 不带上下文条件的「遵守率 X%」是误导。
                "vault": {
                    str(k): str(v) for k, v in (c.get("vault") or {}).items() if isinstance(k, str)
                },
            }
        )
    return {
        "key": str(blob.get("key") or key),
        "note": str(blob.get("note") or ""),
        "cases": cases,
        # 用例文件的指纹：用例改了要看得出来（与提示词指纹同一个算法）
        "sha": hashlib.sha256(raw.encode("utf-8")).hexdigest()[:12],
    }


# ---------- 确定性判分（纯函数） ----------
#
# 加断言的门槛：它必须对着**一个实测到的缺陷**与**产品承诺过的一句话**。指不出来就不该
# 在这里——那是「我觉得」，不是「它承诺过」。


def check_turn(record: dict, expect: dict) -> list[dict]:
    """一个回合 → findings 列表；空列表 = 全过。Pure.

    `record` 的形状（由 `_run_case` 组装）：`reply` / `artifacts`（回执，带 path/kind）/
    `tools`（W5 记的名称与大小）/ `rounds` / `error` / `paths_on_disk`（回执路径是否存在）。
    """
    findings: list[dict] = []
    reply = record.get("reply") or ""
    arts = record.get("artifacts") or []
    kinds = [str(a.get("kind") or "") for a in arts]
    paths = [str(a.get("path") or "") for a in arts]

    if record.get("error"):
        findings.append({"code": "turn_error", "detail": str(record["error"])[:200]})
        return findings

    # 1) 该落盘的回合必须真的落盘（缺陷一：声称存了却一次没调）
    if expect.get("must_save") and not arts:
        findings.append(
            {
                "code": "not_saved",
                "detail": "这个回合要求落盘，但一份产出都没有（正文只活在对话里）",
            }
        )
    # 2) 普通提问不许被塞成产出（负例：把闲聊变成产出比漏判更烦人）
    if expect.get("must_not_save") and arts:
        findings.append(
            {"code": "saved_when_asked_nothing", "detail": f"只是问了个问题，却落了 {len(arts)} 份产出"}
        )

    # 3) 声称存了就必须有回执 —— 判定只有 `chat.claims_a_save_without_one` 那一份实现
    from app.routers.chat import claims_a_save_without_one

    if claims_a_save_without_one(reply, arts):
        findings.append(
            {"code": "claims_a_save_without_one", "detail": "回复里说存了，但这一轮没有任何回执"}
        )

    # 4) 一轮同体裁 ≤1 份（缺陷三：带字数要求时 20 轮里 5 轮存 ≥2 次）
    cap = int(expect.get("max_per_kind") or 0)
    if cap:
        for kind in sorted(set(kinds)):
            n = kinds.count(kind)
            if n > cap:
                findings.append(
                    {
                        "code": "too_many_per_kind",
                        "detail": f"一轮里「{kind}」存了 {n} 份（上限 {cap}）——正文在被反复重写落盘",
                    }
                )

    # 5) 回执路径不重复（同一份东西的第二个链接是谎话：点开内容一样）
    dup = sorted({p for p in paths if p and paths.count(p) > 1})
    if dup:
        findings.append({"code": "duplicate_paths", "detail": "回执里有重复路径：" + "、".join(dup)})

    # 6) 回执路径必须真的在盘上（缺陷二：编造 recap/…-精简版.md，点开即 404）
    if expect.get("paths_exist"):
        missing = [a for a in record.get("artifacts") or [] if a.get("exists") is False]
        if missing:
            findings.append(
                {
                    "code": "receipt_path_missing",
                    "detail": "回执指向盘上不存在的东西：" + "、".join(str(a.get("path")) for a in missing),
                }
            )

    # 7) 落盘那轮的正文不许同时摊在对话里（缺陷四：同一篇正文的第二份拷贝）
    if expect.get("body_not_in_reply") and arts:
        blobs = [b for b in (record.get("bodies") or []) if len(b) >= BODY_OVERLAP_CHARS]
        for body in blobs:
            if _shares_a_run(body, reply):
                findings.append(
                    {
                        "code": "body_in_reply",
                        "detail": f"落盘那轮的正文有 {BODY_OVERLAP_CHARS} 字以上同时出现在回复里",
                    }
                )
                break

    # 8) 占位串：有些 provider 会吐一句「（模型未返回内容）」当正文
    from app.routers.chat import _without_placeholder

    if reply.strip() and not _without_placeholder(reply):
        findings.append({"code": "placeholder_reply", "detail": "回复整条是一个空占位串"})
    return findings


def _shares_a_run(body: str, reply: str, width: int = BODY_OVERLAP_CHARS) -> bool:
    """正文里有没有一段连续 width 字原样出现在回复里。Pure.

    用「连续片段」而不是相似度：相似度需要一把自己的尺子，而「原样搬过去」是这一条要抓的
    那个动作（P1 的缺口）。宽度取 120 字：够长到不可能是巧合，又短到能在一段里抓到。
    """
    body = " ".join((body or "").split())
    reply = " ".join((reply or "").split())
    if len(body) < width or len(reply) < width:
        return False
    step = max(1, width // 2)  # 半步滑窗：跨段拼接的搬法也不至于漏掉
    for i in range(0, len(body) - width + 1, step):
        if body[i : i + width] in reply:
            return True
    return False


# ---------- LLM 判分：回执是不是一行话 ----------

_JUDGE_SYSTEM = (
    "你在看一段「用户要一份成品」的对话。助手应该：把成品**存进产出**，然后在对话里给一句"
    "**回执**（存到哪了、叫什么），而不是把成品正文再复述一遍。\n"
    "评分标准：\n"
    "5=只给一两句回执（说清存到哪、叫什么），正文不在对话里；\n"
    "4=回执带一小段摘要（两三句），成品仍主要靠链接；\n"
    "3=回执和正文混在一起，正文出现了小半；\n"
    "2=大半正文都摊在对话里；\n"
    "1=整篇正文都在对话里（存没存都成疑问）；\n"
    "0=答非所问，或压根没提存到哪。\n"
    "只看这一点，不看内容质量。**用户压根没要成品的那一轮不适用**，这种情况给 5。\n"
    '只输出 JSON，不要解释、不要代码块：{"score": 0-5 整数, "reason": "20 字以内理由"}'
)


class _Verdict(BaseModel):
    """LLM 判分的返回。越界由调用方钳到 0-5；非数字按 0 记。"""

    score: float = 0.0
    reason: str = ""

    @field_validator("score", mode="before")
    @classmethod
    def _score(cls, v):
        try:
            return float(v)
        except (TypeError, ValueError):
            return 0.0

    @field_validator("reason", mode="before")
    @classmethod
    def _reason(cls, v):
        if v is None or isinstance(v, (list, dict)):
            return ""
        return str(v).strip()


async def judge_receipt(
    info: ProviderInfo, model: str, ask: str, reply: str, artifacts: list[dict], *, stream_fn=None, native_fn=None
) -> tuple[int | None, str]:
    """回执是不是一行话。0-5；None = 判分没跑成。"""
    receipts = "\n".join(f"- {a.get('kind') or '?'}：{a.get('path') or '(没路径)'}" for a in artifacts) or "（这一轮没有产出回执）"
    obj, meta = await extract_json(
        info,
        model,
        [
            {"role": "system", "content": _JUDGE_SYSTEM},
            {
                "role": "user",
                "content": (
                    f"用户说：{ask}\n\n这一轮的回执：\n{receipts}\n\n"
                    f"助手在对话里说的：\n{reply[:ANSWER_CAP]}"
                ),
            },
        ],
        _Verdict,
        stream_fn=stream_fn,
        native_fn=native_fn,
    )
    if obj is None:
        return None, f"判分未返回 JSON：{meta.error[:60]}"
    return max(0, min(5, int(round(obj.score)))), obj.reason.strip()[:100]


# ---------- 跑一个回合 ----------


async def _default_run_turn(ask: str, model_id: str) -> dict:
    """**产品自己那条路**：建会话 → 跑 `chat._generate` → 从库里读回这一轮。

    刻意不直接拼 `run_agentic_chat`：那条路绕过了回执落库、`claims_a_save_without_one`
    的校验、以及同体裁覆盖 —— 而这一套用例要测的恰恰是那些。Test seam: monkeypatch me.
    """
    from app.models import Conversation, Message
    from app.routers.chat import ChatRequest, _generate

    async with SessionLocal() as db:
        conv = Conversation(title="turn_eval", model_id=model_id)
        db.add(conv)
        await db.commit()
        await db.refresh(conv)
        cid = conv.id

    try:
        events: list[str] = []
        async for chunk in _generate(ChatRequest(conversation_id=cid, content=ask, model_id=model_id)):
            events.append(chunk)
        # SSE 里的 error 事件就是这一轮的结果（`_generate` 在流里报错，不抛）
        error = ""
        for chunk in events:
            if chunk.startswith("event: error"):
                payload = chunk.split("data: ", 1)[-1].strip()
                try:
                    error = str(json.loads(payload).get("message") or "")
                except (ValueError, AttributeError):
                    error = payload[:200]
                break

        async with SessionLocal() as db:
            msg = (
                await db.execute(
                    Message.__table__.select()
                    .where(Message.conversation_id == cid, Message.role == "assistant")
                    .order_by(Message.id.desc())
                    .limit(1)
                )
            ).mappings().first()
            reply = str((msg or {}).get("content") or "")
            artifacts = json.loads((msg or {}).get("artifacts_json") or "[]") or []
            turn = await _turn_trace(cid)
    finally:
        await _delete_conversation(cid)

    return {"reply": reply, "artifacts": artifacts, "error": error, "trace": turn}


async def _turn_trace(conversation_id: int):
    from app.core import turn_trace

    try:
        rows = await turn_trace.recent(limit=5)
        for t in rows["traces"]:
            if t["conversation_id"] == conversation_id:
                return t
    except Exception:  # noqa: BLE001 - 账本读不到不影响判分（只是少几个数）
        log.debug("turn trace lookup failed", exc_info=True)
    return None


async def _delete_conversation(conversation_id: int) -> None:
    """把这一轮留下的会话删掉 —— 评测不该在库里堆垃圾（消息靠外键级联）。"""
    from sqlalchemy import delete, select

    from app.models import Conversation, Message

    try:
        async with SessionLocal() as db:
            ids = (
                await db.execute(select(Message.id).where(Message.conversation_id == conversation_id))
            ).scalars().all()
            if ids:
                await db.execute(delete(Message).where(Message.id.in_(ids)))
            await db.execute(delete(Conversation).where(Conversation.id == conversation_id))
            await db.commit()
    except Exception:  # noqa: BLE001 - 清理失败不该毁掉这次评测
        log.warning("turn eval cleanup failed for conv %s", conversation_id, exc_info=True)


def _read_bodies(artifacts: list[dict], vault_dir) -> tuple[list[str], list[dict]]:
    """回执路径 → （盘上的正文，带 exists 标记的回执副本）。只读盘。

    `vault_dir` 由调用方给：评测跑在**临时 vault** 里（见 `_scratch_vault`），
    所以这里读的必须是那一个，而不是 `app.config.VAULT_DIR`。
    """
    bodies: list[str] = []
    marked: list[dict] = []
    for a in artifacts or []:
        rel = str(a.get("path") or "")
        item = dict(a)
        p = (vault_dir / rel) if rel else None
        try:
            if p is not None and p.is_file():
                bodies.append(p.read_text(encoding="utf-8", errors="replace"))
                item["exists"] = True
            else:
                item["exists"] = False
        except OSError:
            item["exists"] = False
        marked.append(item)
    return bodies, marked


def _real_vault():
    from app.config import VAULT_DIR

    return VAULT_DIR


def _seed_vault(case: dict, vault_dir) -> int:
    """把用例声明的那几份材料写进（临时）vault，返回写了几份。

    空 vault 也是**声明**（`vault: {}`）：那一条测的是「没有素材时不许凭空编」，
    而这正是 upgrade-plan 缺口五量到的那个上下文条件。
    """
    n = 0
    for rel, text in (case.get("vault") or {}).items():
        p = Path(vault_dir) / rel
        try:
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(text, encoding="utf-8")
            n += 1
        except OSError:
            log.warning("turn eval: 铺材料失败 %s", rel, exc_info=True)
    return n


def _reset_vault(vault_dir) -> None:
    """把临时 vault 清空到「只有体裁目录」的样子 —— **每条用例从同一个起点开始**。

    不重置的话，上一条用例铺的材料会漏进下一条，而「空 vault 不许编」那一条就会
    在一个其实有素材的环境里跑，测出来的东西没有任何意义。
    """
    import shutil

    from app.core import mcp

    for entry in Path(vault_dir).iterdir():
        if entry.is_dir():
            shutil.rmtree(entry, ignore_errors=True)
        else:
            entry.unlink(missing_ok=True)
    for dir_name, _label in mcp._ARTIFACT_KINDS.values():
        (Path(vault_dir) / dir_name).mkdir(parents=True, exist_ok=True)


def _index_vault(vault_dir) -> int:
    """把临时 vault 里的材料**建进索引**，返回索引了几份。**会用到本地 embedder（不花钱）。**

    这一步不是可有可无的：模型找材料走的是产品自己的检索与工具，只在盘上放个文件、
    不进索引，一个「有素材」的回合在它眼里仍然是空的 —— 实测就是这么栽的
    （它回「vault 里 notes / recap / … 都是空的」然后正确地拒绝编造）。
    """
    from app.core import indexer, retriever

    n = 0
    root = Path(vault_dir)
    for p in sorted(root.rglob("*.md")):
        try:
            indexer.index_file(p, root=root)
            n += 1
        except Exception:  # noqa: BLE001 - 索引失败不该毁掉评测（只是这一条少点材料）
            log.warning("turn eval: 索引失败 %s", p, exc_info=True)
    try:
        retriever.invalidate()
    except Exception:  # noqa: BLE001
        log.debug("turn eval: retriever invalidate failed", exc_info=True)
    return n


def _reset_index() -> None:
    """把临时索引清空 —— **光清 vault 不够**。

    实测栽过一次：`notes/本周进展.md` 被删掉了，但它的 chunk 还在向量库里，于是
    模型检索得到、「空 vault 不许编」那一条其实是在一个有材料的环境里跑的 ——
    它照实存了一份周报，而用例声明的上下文是「什么都没有」。

    **带一道闸**：只有在用评测的临时库时才清。否则一次误调就会清掉用户自己的索引，
    而那是不可恢复的（只能重建，几十分钟）。
    """
    from app.config import settings

    if SCRATCH_CHROMA_MARK not in str(settings.chroma_path):
        log.warning(
            "拒绝清索引：当前 chroma 路径不是评测用的临时库（%s）", settings.chroma_path
        )
        return
    from app.core import indexer, retriever

    try:
        indexer.get_client().delete_collection(indexer.COLLECTION)
    except Exception:  # noqa: BLE001 - 还没建过这个 collection 就是这样
        log.debug("turn eval: nothing to reset in the scratch index")
    try:
        retriever.invalidate()
    except Exception:  # noqa: BLE001
        log.debug("turn eval: retriever invalidate failed", exc_info=True)


def _drop_index_client() -> None:
    """把临时向量库的 client 与 chroma 的**共享 system 缓存**一起丢掉。

    只把 `indexer._client` 置空是不够的：chromadb 自己有一个按 path 索引的共享 system
    单例，它继续握着文件句柄，于是临时目录在 Windows 上删不掉（实测一次测试跑下来积了
    18 个）。`clear_system_cache()` 是 chromadb 1.5 提供的官方出口。
    """
    import gc

    from app.core import indexer

    try:
        from chromadb.api.shared_system_client import SharedSystemClient

        SharedSystemClient.clear_system_cache()
    except Exception:  # noqa: BLE001 - 换版本时这个方法可能没了，不该让评测挂掉
        log.debug("turn eval: chroma shared system cache not cleared", exc_info=True)
    indexer._client = None  # noqa: SLF001 - 这就是那条缝
    gc.collect()


def _sweep_stale_chroma() -> int:
    """顺手清掉**以前**留下的临时向量库（进程被打断时留下的那些）。

    靠 `_drop_index_client` 当场删是主路；这一条是兜底：上一轮崩了、Ctrl-C 了，
    残留就永远躺在那儿。只删这个进程之外的旧目录，且认前缀 —— 认不出来就绝不下手。
    """
    import shutil
    import tempfile
    import time

    root = Path(tempfile.gettempdir())
    now = time.time()
    n = 0
    for d in root.glob(f"{SCRATCH_CHROMA_MARK}*"):
        try:
            if not d.is_dir() or now - d.stat().st_mtime < 3600:
                continue  # 一小时以内的可能正被别的进程用着
            shutil.rmtree(d)
            n += 1
        except OSError:
            continue
    return n


@contextmanager
def _scratch_index():
    """跑评测时换一个**临时向量库** —— 铺进去的材料要能被产品自己的检索找到。

    缝是 `indexer.get_client()` 的懒单例：把它置空、把 chroma 路径指到临时目录，
    下一次取就是一个全新的库；跑完还原、临时目录删掉。
    **不碰用户自己的索引**：那些 chunk 一旦进去就再也分不出是评测的还是真的了。
    """
    import tempfile

    from app.config import settings
    from app.core import indexer

    tmp = Path(tempfile.mkdtemp(prefix=SCRATCH_CHROMA_MARK))
    old = (indexer._client, settings.chroma_path)  # noqa: SLF001 - 这就是那条缝
    indexer._client = None  # noqa: SLF001
    settings.chroma_path = tmp
    try:
        yield tmp
    finally:
        settings.chroma_path = old[1]
        _drop_index_client()
        indexer._client = old[0]  # noqa: SLF001
        _rmtree_retry(tmp)


def _rmtree_retry(path: Path, tries: int = 3) -> None:
    """删临时目录，带重试。**Windows 上 chroma 会多握一会儿文件句柄**。

    不重试的话每跑一次评测就在系统 temp 里留一个几十 MB 的库（实测一次测试跑下来 18 个）。
    删不掉也不报错 —— 一个留在 temp 里的目录不值得让评测失败，但会记一条 debug，
    并且下次跑的时候 `_sweep_stale_chroma` 会把它扫掉。
    """
    import gc
    import shutil

    for i in range(max(1, tries)):
        try:
            shutil.rmtree(path)
            return
        except OSError:
            gc.collect()
            if i == tries - 1:
                log.debug("turn eval: 临时向量库没删掉（留在 %s，下次会扫）", path)


@contextmanager
def _scratch_vault():
    """跑评测时把产出落进一个临时 vault —— **评测不该往用户的 vault 里写东西**。

    缝是实测出来的：`core/mcp.py` 在**调用时**读模块级的 `VAULT_DIR` 与 `_VAULT_ROOT`
    （保存落盘、路径越界校验走的就是这两个），所以临时换掉有效；跑完还原、临时目录删掉。
    不这么做的话，一次评测会在你的 vault 里留下一堆名为「周报」的文件。
    """
    import shutil
    import tempfile

    from app.core import mcp

    tmp = Path(tempfile.mkdtemp(prefix="wb-turn-eval-"))
    for dir_name, _label in mcp._ARTIFACT_KINDS.values():
        (tmp / dir_name).mkdir(parents=True, exist_ok=True)
    old = (mcp.VAULT_DIR, mcp._VAULT_ROOT)
    mcp.VAULT_DIR, mcp._VAULT_ROOT = tmp, tmp.resolve()
    try:
        yield tmp
    finally:
        mcp.VAULT_DIR, mcp._VAULT_ROOT = old
        shutil.rmtree(tmp, ignore_errors=True)


async def _one_case(
    case: dict,
    model_id: str,
    info: ProviderInfo | None,
    model: str,
    run_turn=None,
    *,
    judge: bool,
    stream_fn=None,
    native_fn=None,
    repeat: int = 1,
    run_index: int = 1,
    vault_dir=None,
) -> list[dict]:
    """一条用例跑一次（或重复 `repeat` 次）→ 每个回合一条结果。"""
    runner = run_turn or _default_run_turn
    out: list[dict] = []
    for k in range(repeat):
        rec: dict = {
            "id": case["id"] if repeat == 1 else f"{case['id']}#{run_index + k}",
            "ask": case["ask"],
            "findings": [],
            "judge": None,
            "judge_reason": "",
            "reply": "",
            "artifacts": [],
            "rounds": 0,
            "tools": 0,
            "seconds": 0.0,
            "error": "",
            "vault_files": 0,
        }
        t0 = time.time()
        vdir = vault_dir or _real_vault()
        try:
            _reset_vault(vdir)
            _reset_index()
            rec["vault_files"] = _seed_vault(case, vdir)
            # 铺进去的材料要进索引，否则「有素材」只是盘上有文件（模型靠检索找材料）
            if rec["vault_files"] and not case.get("no_index"):
                rec["indexed"] = await asyncio.to_thread(_index_vault, vdir)
            got = await runner(case["ask"], model_id)
        except Exception as e:  # noqa: BLE001 - 一条用例挂了不该毁掉整次评测
            log.warning("turn eval case failed: %s", case["id"], exc_info=True)
            got = {"reply": "", "artifacts": [], "error": f"{type(e).__name__}: {e}", "trace": None}
        bodies, marked = _read_bodies(got.get("artifacts") or [], vdir)
        trace = got.get("trace") or {}
        rec.update(
            {
                "reply": (got.get("reply") or "")[:ANSWER_CAP],
                "artifacts": marked,
                "bodies": bodies,
                "error": got.get("error") or "",
                "rounds": int(trace.get("rounds") or 0),
                "tools": len(trace.get("tool_calls") or []),
                "seconds": round(time.time() - t0, 1),
            }
        )
        rec["findings"] = check_turn(rec, case["expect"])
        # 判分：只在「要成品」的用例上跑（问句那一轮不适用，提示词里也说了给 5）
        if judge and info is not None and case["expect"].get("receipt_is_one_line"):
            try:
                rec["judge"], rec["judge_reason"] = await judge_receipt(
                    info, model, case["ask"], rec["reply"], marked,
                    stream_fn=stream_fn, native_fn=native_fn,
                )
            except Exception as e:  # noqa: BLE001
                log.warning("turn eval judging failed: %s", case["id"], exc_info=True)
                rec["judge_reason"] = f"判分失败: {type(e).__name__}: {e}"
        rec.pop("bodies", None)  # 正文不进 detail_json（同一篇东西存两处）
        out.append(rec)
    return out


# ---------- run ----------


async def _resolve(model_id: str = ""):
    from app.core.report import resolve

    return await resolve(model_id)


async def run(
    scenario: str,
    *,
    model_id: str = "",
    judge: bool = True,
    repeat: int = 1,
    run_turn=None,
    stream_fn=None,
    native_fn=None,
) -> dict:
    """跑一套回合用例，存一行 run，并给出 `k/n` + Wilson 区间。

    `run_turn` 是模型调用的注入口（测试塞假的进去，零调用）。`repeat` > 1 时整套重跑
    若干遍 —— 行为是随机的，一条用例一遍只是 n=1 的样本。
    """
    fx = load_scenario(scenario)
    if not fx["cases"]:
        raise ValueError(f"没有这套回合用例：{scenario}（backend/evals/turns/）")

    from app.core import providers, usage_ledger

    model_id = model_id or (providers.default_model_id() or "")
    info: ProviderInfo | None = None
    model = ""
    if judge and model_id:
        resolved = await _resolve(model_id)
        if resolved is not None:
            info, model = resolved
    if info is None:
        judge = False

    reps = max(1, int(repeat or 1))
    t0 = time.time()
    swept = _sweep_stale_chroma()
    if swept:
        log.info("turn eval: 扫掉了 %s 个以前留下的临时向量库", swept)
    with _scratch_vault() as vault, _scratch_index():
        async with usage_ledger.span("turn_eval", scenario):
            results: list[dict] = []
            for i in range(reps):
                for case in fx["cases"]:
                    results.extend(
                        await _one_case(
                            case, model_id, info, model, run_turn,
                            judge=judge, stream_fn=stream_fn, native_fn=native_fn,
                            repeat=1, run_index=i * len(fx["cases"]) + 1,
                            vault_dir=vault,
                        )
                    )
    seconds = round(time.time() - t0, 1)

    total = len(results)
    passed = sum(1 for r in results if not r["findings"] and not r["error"])
    judged = [r["judge"] for r in results if r["judge"] is not None]
    lo, hi = wilson(passed, total)
    agg = {
        "scenario": fx["key"],
        "scenario_sha": fx["sha"],
        "prompt_sha": _output_sha(),
        "model_id": model_id,
        "total": total,
        "passed": passed,
        "deterministic": round(passed / total, 4) if total else 0.0,
        "ci_low": round(lo, 3),
        "ci_high": round(hi, 3),
        "can_tell": (hi - lo) <= 0.34,
        "judged": round(sum(judged) / len(judged), 2) if judged else None,
        "judged_n": len(judged),
        "seconds": seconds,
    }

    async with SessionLocal() as db:
        row = TurnEvalRun(
            scenario=agg["scenario"],
            scenario_sha=agg["scenario_sha"],
            prompt_sha=agg["prompt_sha"],
            model_id=agg["model_id"],
            total=total,
            deterministic=agg["deterministic"],
            judged=agg["judged"],
            seconds=seconds,
            detail_json=json.dumps(results, ensure_ascii=False),
        )
        db.add(row)
        await db.commit()
        await db.refresh(row)
        agg["id"] = row.id
    log.info(
        "turn eval %s: %s/%s (%.0f%%) score=%s (%ss)",
        scenario, passed, total, 100 * agg["deterministic"], agg["judged"], seconds,
    )
    return {**agg, "note": fx["note"], "detail": results}


def _output_sha() -> str:
    """`_OUTPUT_RULE` 的指纹（与 `ArtifactFeedback` 同一把 key）。"""
    try:
        from app.core import prompts

        for p in prompts.inventory():
            if p.module == "app.routers.chat" and p.name == "_OUTPUT_RULE":
                return p.sha
    except Exception:  # noqa: BLE001
        log.debug("turn eval prompt sha unavailable", exc_info=True)
    return ""


async def history(scenario: str = "", limit: int = 20) -> dict:
    """最近若干次跑分，连同「比上次好还是坏」。只读，不跑模型。"""
    from sqlalchemy import select

    n = max(1, min(int(limit or 20), 200))
    async with SessionLocal() as db:
        stmt = select(TurnEvalRun).order_by(TurnEvalRun.id.desc()).limit(n)
        if scenario:
            stmt = (
                select(TurnEvalRun)
                .where(TurnEvalRun.scenario == scenario)
                .order_by(TurnEvalRun.id.desc())
                .limit(n)
            )
        rows = (await db.execute(stmt)).scalars().all()

    runs = [
        {
            "id": r.id,
            "at": r.created_at.isoformat(timespec="seconds") if r.created_at else None,
            "scenario": r.scenario,
            "scenario_sha": r.scenario_sha,
            "prompt_sha": r.prompt_sha,
            "model_id": r.model_id,
            "total": r.total,
            "deterministic": r.deterministic,
            "judged": r.judged,
            "seconds": r.seconds,
        }
        for r in rows
    ]
    conclusion = "只跑过一次，还没有可比对象。"
    if len(runs) >= 2:
        a, b = runs[0], runs[1]
        bits = []
        if a["scenario_sha"] != b["scenario_sha"]:
            bits.append(f"用例从 {b['scenario_sha']} 变成了 {a['scenario_sha']}")
        if a["prompt_sha"] != b["prompt_sha"]:
            bits.append(f"提示词从 {b['prompt_sha'] or '—'} 变成了 {a['prompt_sha'] or '—'}")
        d = round(a["deterministic"] - b["deterministic"], 4)
        if d > 0:
            bits.append(f"确定性判分变好 {d:+.0%}")
        elif d < 0:
            bits.append(f"确定性判分变差 {d:+.0%}")
        else:
            bits.append("确定性判分没变")
        if a["judged"] is not None and b["judged"] is not None:
            bits.append(f"判分 {b['judged']} → {a['judged']}")
        conclusion = "；".join(bits) + "。"
    return {"runs": runs, "conclusion": conclusion, "scenarios": scenarios()}
