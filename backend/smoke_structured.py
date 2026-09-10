"""结构化输出层的真实冒烟：回答「你的 provider 走 native 还是 cleaned？」。

和 smoke_tutor_accept.py 同一纪律：**从不碰真实数据**——启动前把 workbench.db
与 config.json 复制进临时目录，WB_DB_PATH / WB_CONFIG_PATH 指过去。只读不写：
不落记忆、不建会话，extract_json 本身不碰库。

场景（默认真实调用 3 次，每次几百 token，成本可忽略）：
  1. TutorExtract   —— 教学提取的真实 prompt（_EXTRACT_PROMPT 原样）。
  2. AutoMemories   —— 记忆抽取的真实 prompt，覆盖数组根适配路径。
  3. ScheduleParse  —— cron 解析的真实 prompt。
  4. health.report  —— 进程内验证体检报告的 structured 字段形状。

判据：3 个场景都拿到结构化结果（strategy ∈ native/cleaned/retried）即 PASS；
failed 才 FAIL。strategy 落点打印出来供观察——native 占比低说明你的 provider
不支持 JSON mode，cleaned 兜底仍然比旧的裸正则稳。

    uv run python smoke_structured.py              # 离线自检 + 真实 3 场景
    uv run python smoke_structured.py --offline    # 只跑离线清洗自检，不调模型
"""
import asyncio
import os
import shutil
import sys
import tempfile
from pathlib import Path

REAL_DB = Path(__file__).resolve().parent.parent / "data" / "workbench.db"
REAL_CFG = Path(__file__).resolve().parent.parent / "data" / "config.json"


def offline_checks() -> bool:
    """零成本自检：清洗链与统计形状。与 test_structured 部分重叠，这里
    提供 pytest 之外的单文件 sanity。"""
    from app.core.structured import clean_json, stats

    cases = [
        ('{"concept": "a"}', '{"concept": "a"}'),
        ('```json\n{"concept": "a"}\n```', '{"concept": "a"}'),
        ('好的：{"concept": "a"} 完毕', '{"concept": "a"}'),
        ('{"a": 1} 然后 {"b": 2}', '{"a": 1}'),
        ('{"a": 1,}', '{"a": 1}'),
    ]
    for raw, want in cases:
        got = clean_json(raw)
        if got != want:
            print(f"  FAIL clean_json({raw!r}) = {got!r}, want {want!r}")
            return False
    if clean_json("没有 JSON") is not None:
        print("  FAIL clean_json 应返回 None")
        return False
    s = stats()
    need = {"native", "cleaned", "retried", "failed", "total", "success_rate"}
    if not need <= set(s) or not 0.0 <= s["success_rate"] <= 1.0:
        print(f"  FAIL stats 形状不对: {s}")
        return False
    print("  ok 离线清洗链与统计形状")
    return True


async def scene_tutor(info, model) -> bool:
    from app.core.structured import extract_json
    from app.core.tutor import TutorExtract, _EXTRACT_PROMPT

    script = (
        "我：await 到底把控制权交给了谁？\n"
        "老师：事件循环在 await 处挂起当前协程，把控制权交还给循环本身，由它调度下一个就绪任务。\n"
        "我：懂了。那如果协程里没有 await 呢？\n"
        "老师：那它就是一个普通函数，不会让出控制权。\n"
        "我：呃，那 CPU 密集任务放协程里岂不是卡死整个循环？这个我还没想通。\n"
        "（自评：half）"
    )
    obj, meta = await extract_json(
        info,
        model,
        [
            {"role": "system", "content": _EXTRACT_PROMPT},
            {"role": "user", "content": f"话题：asyncio 的 await\n\n{script}"},
        ],
        TutorExtract,
    )
    if obj is None:
        print(f"  FAIL tutor 提取失败: {meta.error}")
        return False
    print(f"  ok strategy={meta.strategy} attempts={meta.attempts}")
    print(f"    concept={obj.concept!r}")
    print(f"    stuck={obj.stuck[:80]!r}")
    return True


async def scene_memory(info, model) -> bool:
    from app.core.memory import AutoMemories, _AUTO_SYSTEM
    from app.core.structured import extract_json

    obj, meta = await extract_json(
        info,
        model,
        [
            {"role": "system", "content": _AUTO_SYSTEM},
            {
                "role": "user",
                "content": (
                    "已有记忆：\n（暂无）\n\n刚结束的对话：\n"
                    "【用户】我主用 Python，最近在学 asyncio，偏好 uv 管理依赖。\n"
                    "【助手】好的，asyncio 的重点在事件循环与协程调度……\n\n"
                    "请判断有没有值得新增的长期记忆。"
                ),
            },
        ],
        AutoMemories,
    )
    if obj is None:
        print(f"  FAIL memory 抽取失败: {meta.error}")
        return False
    print(f"  ok strategy={meta.strategy} attempts={meta.attempts} items={len(obj.items)}")
    for it in obj.items:
        print(f"    [{it.kind}] {it.text[:70]}")
    return True


async def scene_schedule(info, model) -> bool:
    from app.core.structured import extract_json
    from app.core.tasks import ScheduleParse, _PARSE_SYSTEM

    obj, meta = await extract_json(
        info,
        model,
        [
            {"role": "system", "content": _PARSE_SYSTEM},
            {"role": "user", "content": "每周三晚上八点复盘本周的学习记录"},
        ],
        ScheduleParse,
    )
    if obj is None:
        print(f"  FAIL cron 解析失败: {meta.error}")
        return False
    print(f"  ok strategy={meta.strategy} attempts={meta.attempts}")
    print(f"    cron={obj.cron!r} name={obj.name!r}")
    return True


async def scene_health() -> bool:
    from app.routers.health import report

    r = await report()
    s = r.get("structured")
    need = {"native", "cleaned", "retried", "failed", "total", "success_rate"}
    if not isinstance(s, dict) or not need <= set(s):
        print(f"  FAIL health.report.structured 形状不对: {s}")
        return False
    print(f"  ok health.report.structured = {s}")
    return True


async def main() -> int:
    offline_only = "--offline" in sys.argv

    tmp = Path(tempfile.mkdtemp(prefix="wb-structured-"))
    db = tmp / "workbench.db"
    if not REAL_DB.exists():
        print(f"SKIP 找不到真实库 {REAL_DB}（离线自检仍会跑）")
    else:
        shutil.copy2(REAL_DB, db)
        os.environ["WB_DB_PATH"] = str(db)
        if REAL_CFG.exists():
            shutil.copy2(REAL_CFG, tmp / "config.json")
            os.environ["WB_CONFIG_PATH"] = str(tmp / "config.json")

    print("== 离线自检 ==")
    ok = offline_checks()
    if not ok:
        print("SMOKE FAIL")
        return 1
    if offline_only:
        print("SMOKE PASS (offline)")
        return 0

    if not REAL_DB.exists():
        print("SMOKE PASS (offline only; 真实场景需要 data/workbench.db)")
        return 0

    # —— 环境变量就位后才能 import app ——
    from app.core.digest import _resolve_model_id
    from app.core.llm import ProviderInfo
    from app.routers.chat import resolve_model

    model_id = _resolve_model_id()
    if not model_id:
        print("SKIP 没有已启用的 provider——真实场景跳过（离线已 PASS）")
        ok = await scene_health() and ok
        print("SMOKE PASS (offline)" if ok else "SMOKE FAIL")
        return 0 if ok else 1
    resolved = await resolve_model(model_id)
    p = resolved.provider
    info = ProviderInfo(kind=p.kind, base_url=p.base_url, api_key=p.api_key)
    print(f"\n== 真实场景 == provider={model_id} kind={p.kind}")

    ok = await scene_tutor(info, resolved.model) and ok
    ok = await scene_memory(info, resolved.model) and ok
    ok = await scene_schedule(info, resolved.model) and ok

    from app.core.structured import stats

    print(f"\nstats: {stats()}")
    ok = await scene_health() and ok
    print("SMOKE PASS" if ok else "SMOKE FAIL")
    print(f"（scratch 副本保留在 {tmp}，确认后可手动删除）")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
