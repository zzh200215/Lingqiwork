"""信念演化时间线（全局唤起脑暴清单 · 记忆时间轴主题）。

automemory 里的事实按语义聚成「信念线」：同一条信念的不同时期的说法串起来，
看出立场怎么变（二月认为 X，六月开始怀疑 X）。纯派生，不落库——每次请求
重算，向量走 memory 的缓存。没有模型参与：聚线靠嵌入，命名取该线最近的
一条陈述（现状即名字），全离线可验。

它回答的是学习画像回答不了的问题：画像按「概念」聚合教学记录，这里按
「主张」聚合所有记忆——包括跟教学无关的。
"""
import logging

from sqlalchemy import select

from app.core import memory
from app.db import SessionLocal
from app.models import Memory, iso_utc

log = logging.getLogger(__name__)

BELIEF_SIM = 0.72  # 低于 memory_tidy 的 0.86：一条信念线要容得下改口与 related 说法
MIN_ITEMS = 2  # 只出现一次的说法没有「演化」可言
MAX_THREADS = 8  # 页面一屏看得完


def _cluster(items: list[Memory], vecs: list[list[float] | None]) -> list[list[int]]:
    """Union-find over pairwise cosine；返回 size >= MIN_ITEMS 的簇。"""
    parent = list(range(len(items)))

    def find(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for i in range(len(items)):
        for j in range(i + 1, len(items)):
            if vecs[i] is None or vecs[j] is None:
                continue
            if memory._cosine(vecs[i], vecs[j]) >= BELIEF_SIM:
                parent[find(i)] = find(j)

    groups: dict[int, list[int]] = {}
    for i in range(len(items)):
        groups.setdefault(find(i), []).append(i)
    multi = [g for g in groups.values() if len(g) >= MIN_ITEMS]
    multi.sort(key=len, reverse=True)
    return multi


async def threads() -> list[dict]:
    """信念线列表（每条 = 一串按时间排的说法 + 最近陈述当名字）。不抛异常。"""
    try:
        async with SessionLocal() as db:
            rows = list((await db.execute(select(Memory).order_by(Memory.id))).scalars().all())
        if len(rows) < MIN_ITEMS:
            return []
        vecs = await memory._vectors_for(rows)
        clusters = _cluster(rows, vecs)
        out = []
        for group in clusters[:MAX_THREADS]:
            members = [rows[i] for i in group]  # 同 id 序 ≈ 时间序
            out.append(
                {
                    "label": members[-1].content[:80],
                    "first_at": iso_utc(members[0].created_at),
                    "last_at": iso_utc(members[-1].created_at),
                    "items": [
                        {"id": m.id, "content": m.content, "kind": m.kind} for m in members
                    ],
                }
            )
        return out
    except Exception:  # noqa: BLE001 - 自我观察是甜点，不能是故障源
        log.warning("belief threads failed", exc_info=True)
        return []
