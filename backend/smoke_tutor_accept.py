"""验收的可重复跑版本：4 次会话，验证「上次卡过」触发得对。

和 smoke_restore.py 同一纪律：**从不碰真实数据**。启动前把 `workbench.db`
复制进临时目录，用 WB_DB_PATH 指过去，跑完不清理提示路径以便查看。

剧本：
  会话 1  「asyncio 里 await 到底把控制权交给了谁」——第一轮故意答错，
          让 transcript 里留下一条真实的卡点，verdict=got。
  会话 2  无关话题（SQLite WAL），控制组。
  会话 3  「asyncio 里的任务调度」——同一概念的重逢、不同的问法，
          第一轮就应该看到 recall 事件命中会话 1 的概念。
  会话 4  「协程是在什么时机被切走的」——同义改写的重逢：一个 asyncio /
          await / 事件循环 都没出现的问法。这一次只能靠别名接住，所以
          命中必须至少有一条 via=alias。

跑真实会话前跑这个（它花几次 qwen 调用），过了再花你自己的 3 次。

已知边界（2026-09-06 实测，别当成 bug 修）：同义改写靠 `TutorSession.aliases`
接住 —— 别名行单独成向量，「Python 协程是在什么时机切换的」对
「asyncio 事件循环」从 0.480 升到 0.707（smoke_recall.py 第 1、3 节）。
真正接不住的只剩**没有别名的旧行**：那种行只能拿 topic+concept+stuck
去比，同义改写在 0.44-0.49，低于噪声天花板 0.601，任何阈值都分不开。
所以会话 1 结束时提取不出别名 = 这个模型不适合当提取器，是 FAIL 而不是
边界。
"""
import asyncio
import os
import shutil
import sys
import tempfile
from pathlib import Path

REAL_DB = Path(__file__).resolve().parent.parent / "data" / "workbench.db"
REAL_CFG = Path(__file__).resolve().parent.parent / "data" / "config.json"


async def drive(session_id: int, text: str) -> tuple[str, list[dict]]:
    """One exchange; returns (reply text, sources), asserting no error event."""
    from app.core import tutor

    reply: list[str] = []
    errors = []
    sources: list[dict] = []
    async for event, data in tutor.say(session_id, text):
        if event == "delta":
            reply.append(data["text"])
        elif event == "error":
            errors.append(data.get("message", ""))
        elif event == "recall":
            for h in data["hits"]:
                print(f"    ↳ recall {h['score']} [{h['via']}] {h['concept']}")
        elif event == "sources":
            sources = data["sources"]
            print(f"    ↳ 取材 {[s_['source'] for s_ in sources]}")
    if errors:
        print(f"  FAIL 会话 {session_id} 流内报错: {errors}")
        sys.exit(1)
    answer = "".join(reply).strip()
    print(f"    老师（{len(answer)} 字）: {answer[:120]}…")
    return answer, sources


async def main() -> None:
    tmp = Path(tempfile.mkdtemp(prefix="wb-tutor-accept-"))
    db = tmp / "workbench.db"
    shutil.copy2(REAL_DB, db)
    cfg = tmp / "config.json"
    shutil.copy2(REAL_CFG, cfg)
    os.environ["WB_DB_PATH"] = str(db)
    os.environ["WB_CONFIG_PATH"] = str(cfg)
    # 临时副本上打开轻执行，只为 drill 里的 run-code 一跳；真实 config 不动
    import json as _json
    _cfg = _json.loads(cfg.read_text(encoding="utf-8"))
    _cfg["artifacts_enabled"] = True
    cfg.write_text(_json.dumps(_cfg, ensure_ascii=False), encoding="utf-8")
    print(f"临时库: {db}（真实库未动）\n")

    from app.core import providers, tutor

    # 复制来的库没有 tutor 表 —— 正常路径里是 main.py 启动时补齐的
    from app.db import engine
    from app.models import Base

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    model = providers.default_model_id()
    if not model:
        print("FAIL 没有可用 provider")
        sys.exit(1)
    print(f"模型: {model}\n")

    # --- 会话 1：埋卡点 ---------------------------------------------------
    # 真实 chroma 在这里只是被查询（search 不写）；索引是空的就跳过取材判定
    from app.core import indexer

    kb_count = indexer.get_collection().count()
    s1 = await tutor.start("asyncio 里 await 到底把控制权交给了谁")
    print(f"会话 1 #{s1['id']}: {s1['topic']}  model_ok={s1['model_ok']}  KB={kb_count} chunks")
    _reply, src1 = await drive(s1["id"], "await 的时候控制权应该交给操作系统，让内核调度别的任务？")
    await drive(s1["id"], "哦，是交给事件循环，由它决定跑哪个就绪的协程，所以根本不进内核？")
    r1 = await tutor.end(s1["id"], "got")
    print("  材料里还有:", [n["source"] for n in r1["material_nearby"]])
    print(f"  end → concept={r1['concept']!r} aliases={r1['aliases']!r} stuck={r1['stuck']!r}\n")
    if not r1["concept"] or not r1["stuck"]:
        print("FAIL 会话 1 没提取出 概念/卡点，会话 3 的 recall 无从触发")
        sys.exit(1)
    if not r1["aliases"]:
        # 别名行是会话 4 那种问法唯一能命中的文本。提取不出来不是能力边界，
        # 是这个模型当提取器不合格 —— 换模型或改 `_EXTRACT_PROMPT`，别调阈值。
        print("FAIL 会话 1 没提取出别名 —— 会话 4 的同义改写无从命中")
        sys.exit(1)

    # --- 会话 2：无关话题，控制组 -----------------------------------------
    s2 = await tutor.start("SQLite 的 WAL 模式怎么提升并发")
    print(f"会话 2 #{s2['id']}: {s2['topic']}")
    await drive(s2["id"], "写的时候不阻塞读，是因为写进 -wal 文件而不是主库？")
    r2 = await tutor.end(s2["id"], "got")
    print(f"  end → concept={r2['concept']!r} stuck={r2['stuck']!r}\n")

    # --- 会话 3：相关话题，recall 必须命中会话 1 而不是会话 2 -------------
    s3 = await tutor.start("asyncio 里的任务调度")
    print(f"会话 3 #{s3['id']}: {s3['topic']}")
    hits = []

    async for event, data in tutor.say(s3["id"], "switch 一次大概花多少时间？"):
        if event == "recall":
            hits = data["hits"]
        elif event == "delta":
            pass
    print(f"  recall 命中: {[(h['score'], h['via'], h['concept']) for h in hits]}")
    r3 = await tutor.end(s3["id"], "got")
    print(f"  end → concept={r3['concept']!r} aliases={r3['aliases']!r}")
    print()

    # --- 会话 4：同义改写的重逢，只有别名接得住 ---------------------------
    # 这一问里 asyncio / await / 事件循环 一个都没有，所以 primary 文本
    # （topic + concept + stuck）本来就到不了阈值。接上会话 1 还是会话 3 都算
    # （同一概念的两条记录），要的是「靠别名接上的」。
    s4 = await tutor.start("协程是在什么时机被切走的")
    print(f"会话 4 #{s4['id']}: {s4['topic']}")
    hits4 = []
    async for event, data in tutor.say(s4["id"], "是不是只要函数里写了 IO，跑到那儿就会被切走？"):
        if event == "recall":
            hits4 = data["hits"]
    print(f"  recall 命中: {[(h['score'], h['via'], h['concept']) for h in hits4]}")
    await tutor.end(s4["id"], "got")

    # --- 判定 -------------------------------------------------------------
    detail3 = await tutor.detail(s3["id"])
    ok = True
    if not hits:
        print("FAIL 会话 3 没有任何 recall 命中")
        ok = False
    else:
        top = hits[0]
        if "await" not in top["concept"] and "事件循环" not in top["concept"] and "协程" not in top["concept"]:
            print(f"FAIL 排第一的是 {top['concept']}，不是会话 1 的概念 —— 触发得不对")
            ok = False
        if top["score"] < tutor.RECALL_MIN_SIM:
            print(f"FAIL 最高分 {top['score']} 低于阈值 {tutor.RECALL_MIN_SIM}")
            ok = False
    if not detail3["recalled"]:
        # 标志记在发起召回的会话上（谁真的被接上了历史，谁就是要数的那个）
        print("FAIL 会话 3 的 recalled 标志没有落库")
        ok = False

    if not hits4:
        print("FAIL 会话 4（同义改写）一条都没命中 —— 别名没接住它存在的唯一那件事")
        ok = False
    elif not any(h["via"] == "alias" for h in hits4):
        print(f"FAIL 会话 4 命中了，但没有一条走别名：{[(h['score'], h['via']) for h in hits4]}")
        print("     这一问里没有 asyncio/await/事件循环，primary 本不该够 —— 先看提取出的 concept 是什么")
        ok = False
    elif not any(k in hits4[0]["concept"] for k in ("await", "asyncio", "事件循环", "协程", "调度")):
        print(f"FAIL 会话 4 排第一的是 {hits4[0]['concept']}，不是 asyncio 那一族 —— 触发得不对")
        ok = False

    # --- 判定：讲的是你自己的材料（取材第 1 条） ----------------------
    if kb_count == 0:
        print("  跳过取材判定 —— 知识库索引是空的，先去 KB 页重建索引")
    elif not src1:
        print("FAIL 知识库有内容但会话 1 一轮都没取到材 —— _retrieve 或 say() 的接线断了")
        ok = False
    else:
        print(f"  取材 ok — 会话 1 第一轮引用了 {[x['source'] for x in src1]}")

    # --- 判定：材料里还有（取材第 2 条的护栏版） ----------------------
    if kb_count == 0:
        print("  跳过「材料里还有」判定 —— 知识库索引是空的")
    elif not r1["material_nearby"]:
        print("FAIL 知识库有内容但 end() 没给出 material_nearby —— _nearby_material 断了")
        ok = False
    elif len(r1["material_nearby"]) > tutor.NEARBY_MAX:
        print(f"FAIL material_nearby 超过 {tutor.NEARBY_MAX} 条 —— 护栏松了，它会开始像队列")
        ok = False

    # --- 判定：当场跑一下（取材第 3 条） ------------------------------
    from app.core import artifacts

    run = artifacts.run("print('wb-accept-ok')", "python", timeout=15)
    if not run["ok"] or "wb-accept-ok" not in run["stdout"]:
        print(f"FAIL artifacts.run 不工作: {run}")
        ok = False
    else:
        print(f"  当场跑 ok — print 往返 {run['elapsed_ms']}ms")

    stats = await tutor.stats()
    print(f"\nstats: {stats}")
    print(f"临时库保留在 {tmp}，看完可删")
    print("ACCEPT PASS" if ok else "ACCEPT FAIL")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    asyncio.run(main())
