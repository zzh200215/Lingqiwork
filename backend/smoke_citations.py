"""P3 引用验证的尺子：编造的 `[来源 N]` 有没有被抓到、真文本有没有被误伤。

方案 §3 的 P3 验收把这一笔写成一条硬要求：**伪引用被剥离且记账（不重生成）**。但
「剥掉几个」本身不是成果——真正的红线是**两组数**：

- **漏剥**（该认出来的假编号没认出来）→ **红线，必须 0**，否则退出码 1。
  留着的是一个看起来可信、点开什么都没有的指针（与 W2a 那条「编造回执路径」同族）。
- **误剥**（真引用、或者根本不是引用的那段文本被吃掉）→ **红线，必须 0**。
  删掉的是**真话**，而且用户看不出来少了什么 —— 比漏一个假编号贵。

免费（不需要模型、不需要 embedder）、确定（同一段文本永远同一个结论）。跑法：
  backend/.venv/Scripts/python.exe smoke_citations.py
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
try:  # gbk 控制台：见 docs/testing.md §5 末
    sys.stdout.reconfigure(encoding="utf-8", line_buffering=True)
except Exception:  # noqa: BLE001
    pass

from app.core import citations  # noqa: E402

GOLDEN = Path(__file__).parent / "evals" / "citations" / "cases.json"


def load_cases() -> list[dict]:
    doc = json.loads(GOLDEN.read_text(encoding="utf-8"))
    cases = doc.get("cases") or []
    for i, c in enumerate(cases, 1):
        cid = str(c.get("id") or "").strip()
        if not cid:
            raise ValueError(f"cases.json 第 {i} 条缺 id")
        if not isinstance(c.get("injected"), int):
            raise ValueError(f"{cid} 缺 injected（这一次注入了几条材料）")
        if not isinstance(c.get("fake"), list) or not isinstance(c.get("cited"), list):
            raise ValueError(f"{cid} 的 fake / cited 必须是列表（可以为空，但不能缺）")
    ids = [c["id"] for c in cases]
    if len(ids) != len(set(ids)):
        raise ValueError("cases.json 的 id 有重复")
    return cases


def main() -> int:
    cases = load_cases()
    n = len(cases)
    fakes = sum(len(c["fake"]) for c in cases)
    print("=" * 78)
    print(f"P3 引用验证 · 金标 {n} 条（其中 {fakes} 个编号是编造的，必须被认出来）")
    print("=" * 78)

    missed: list[tuple[dict, list[int]]] = []  # 漏剥
    over: list[tuple[dict, list[int]]] = []  # 误剥（认多了）
    kept_lost: list[tuple[dict, str]] = []  # 不该动的文本被吃掉了
    left: list[tuple[dict, list[int]]] = []  # 剥完之后正文里还有假的
    bad_clean: list[tuple[dict, str, str]] = []  # 结果与用例声明的 clean 对不上

    for c in cases:
        rep = citations.verify(c["reply"], c["injected"])
        want_fake = list(c["fake"])
        want_cited = list(c["cited"])
        if sorted(rep.fake) != sorted(want_fake):
            missed.append((c, [x for x in want_fake if x not in rep.fake]))
            over.append((c, [x for x in rep.fake if x not in want_fake]))
        if sorted(rep.cited) != sorted(want_cited):
            missed.append((c, [x for x in want_cited if x not in rep.cited]))

        clean, removed = citations.strip_fake(c["reply"], c["injected"])
        after = citations.verify(clean, c["injected"])
        if after.fake:
            left.append((c, list(after.fake)))
        if sorted(after.cited) != sorted(want_cited):
            over.append((c, [x for x in want_cited if x not in after.cited]))
        if sorted(removed) != sorted(want_fake):
            missed.append((c, [x for x in want_fake if x not in removed]))
        for lit in c.get("must_keep") or []:
            if lit not in clean:
                kept_lost.append((c, lit))
        if "clean" in c and clean != c["clean"]:
            bad_clean.append((c, c["clean"], clean))

    print(
        f"\n用例分布：含编造编号 {sum(1 for c in cases if c['fake'])} 条（共 {fakes} 个）"
        f" · 含真引用 {sum(1 for c in cases if c['cited'])} 条"
        f"（共 {sum(len(c['cited']) for c in cases)} 个）"
        f" · 两者都不是 {sum(1 for c in cases if not c['fake'] and not c['cited'])} 条"
    )

    print(f"\n·· **漏剥**（假编号没被认出来）—— 红线，必须 0：{len(missed)} 处")
    for c, nums in missed:
        print(f"   ✗ {c['id']}（注入 {c['injected']}）漏了 {nums}：{c['reply'][:34]}")

    print(f"\n·· **误剥**（认成了引用 / 把真引用吃掉了）—— 红线，必须 0：{len(over)} 处")
    for c, nums in over:
        print(f"   ✗ {c['id']}（注入 {c['injected']}）多认了 {nums}：{c['reply'][:34]}")

    print(f"\n·· 不该动的文本被吃掉（must_keep 丢了）：{len(kept_lost)} 处")
    for c, lit in kept_lost:
        print(f"   ✗ {c['id']} 少了 {lit!r}")

    print(f"\n·· 剥完之后正文里还剩假编号（剥离没生效）：{len(left)} 处")
    for c, nums in left:
        print(f"   ✗ {c['id']} 还剩 {nums}")

    print(f"\n·· 剥出来的正文与用例声明的逐字不一致：{len(bad_clean)} 处")
    for c, want, got in bad_clean:
        print(f"   ✗ {c['id']}\n      期望 {want!r}\n      实际 {got!r}")

    if missed or over or kept_lost or left or bad_clean:
        print("\n!! 有红线被破：要么收紧判据（漏剥），要么把匹配写窄（误剥）—— 别上线")
        return 1
    print("\nSMOKE PASS ✅（零漏剥、零误剥；退出码 0 = 两条红线都守住了）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
