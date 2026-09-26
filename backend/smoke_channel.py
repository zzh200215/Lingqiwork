"""P2 通道预判的尺子：闲聊到底有没有被跳过、该检索的有没有被误跳过。

方案 §3 的 P2 验收把这一笔写成一条硬要求：**闲聊零检索**（现状每轮都检索，白付一次嵌入
+ 一次混合检索）。但**真正的红线不是「跳过率」而是「误跳过率」**——该检索却跳过了 =
材料缺失、答案变差，而且用户看不见；反过来该跳过却去检索，只是白付几十毫秒。
所以本尺子：

- **误跳过**（金标要 hybrid/kg，判成 skip）→ **红线，必须 0**，否则退出码 1；
- **漏跳过**（金标要 skip，却去检索）→ 只记账，不算失败；
- 顺带报**省下多少次检索**与**每一级各判掉多少**（规则/向量/默认）。

免费（只借本地 embedder）、确定（同一句永远同一个决策）。跑法：
  backend/.venv/Scripts/python.exe smoke_channel.py
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
try:  # gbk 控制台：见 docs/testing.md §5 末
    sys.stdout.reconfigure(encoding="utf-8", line_buffering=True)
except Exception:  # noqa: BLE001
    pass

from app.core import channel  # noqa: E402

GOLDEN = Path(__file__).parent / "evals" / "routes" / "channel.json"


def load_cases() -> list[dict]:
    doc = json.loads(GOLDEN.read_text(encoding="utf-8"))
    cases = doc.get("cases") or []
    for i, c in enumerate(cases, 1):
        if not str(c.get("ask") or "").strip():
            raise ValueError(f"channel.json 第 {i} 条缺 ask")
        if c.get("channel") not in channel.CHANNELS:
            raise ValueError(f"channel.json 第 {i} 条 channel 非法: {c.get('channel')}")
    ids = [c.get("id") for c in cases]
    if len(ids) != len(set(ids)):
        raise ValueError("channel.json 的 id 有重复")
    return cases


def main() -> int:
    cases = load_cases()
    n = len(cases)
    print("=" * 74)
    print(f"P2 通道预判 · 金标 {n} 条（跳过 {sum(1 for c in cases if c['channel'] == 'skip')}"
          f" / 图谱 {sum(1 for c in cases if c['channel'] == 'kg')}"
          f" / 混合 {sum(1 for c in cases if c['channel'] == 'hybrid')}）")
    print("=" * 74)

    hits = 0
    false_skip: list[tuple[dict, channel.Decision]] = []
    missed_skip: list[dict] = []
    other: list[tuple[dict, channel.Decision]] = []
    levels = {"rule": 0, "vector": 0, "model": 0, "default": 0}

    for c in cases:
        d = channel.pick(c["ask"])
        levels[d.level] = levels.get(d.level, 0) + 1
        want = c["channel"]
        if d.channel == want:
            hits += 1
        elif want != "skip" and d.channel == "skip":
            false_skip.append((c, d))
        elif want == "skip" and d.channel != "skip":
            missed_skip.append(c)
        else:
            other.append((c, d))

    print(f"\n准确率 {hits}/{n} = {hits / n:.0%}")
    print(f"分级：规则 {levels['rule']}、向量 {levels['vector']}、"
          f"小模型 {levels['model']}、默认（去检索）{levels['default']}")

    saved = sum(1 for c in cases if channel.pick(c["ask"]).channel == "skip")
    print(f"省下检索：{saved}/{n} 轮（跳过检索的就是这些）")

    print(f"\n·· **误跳过**（该去检索却跳过了）—— 红线，必须 0：{len(false_skip)} 条")
    for c, d in false_skip:
        print(f"   ✗ {c['id']} 期望 {c['channel']}，判成 skip（{d.level} {d.confidence:.2f}）：{c['ask'][:34]}")

    print(f"\n·· 漏跳过（该跳过却去检索）—— 只白付一次检索，不算失败：{len(missed_skip)} 条")
    for c in missed_skip:
        print(f"   · {c['id']}：{c['ask'][:34]}")

    print(f"\n·· 其余错判（hybrid ↔ kg）：{len(other)} 条")
    for c, d in other:
        print(f"   · {c['id']} 期望 {c['channel']}，判成 {d.channel}：{c['ask'][:30]}")

    if false_skip:
        print("\n!! 有误跳过：这条红线破了，别上线（要么收紧规则，要么把默认改得更保守）")
        return 1
    print("\nSMOKE PASS ✅（零误跳过；退出码 0 = 这条红线守住了）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
