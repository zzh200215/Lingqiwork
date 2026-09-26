"""人复核的**阅读助手**：把几份金标按「一行一条、要判什么」摊开（免费、只读、不调模型）。

     backend/.venv/Scripts/python.exe smoke_review_aid.py            # 全部
     backend/.venv/Scripts/python.exe smoke_review_aid.py channel    # 只看一份
     backend/.venv/Scripts/python.exe smoke_review_aid.py --counts   # 只报条数与状态

**它不是尺子，也不打分**——金标是「真值」，只有人能改。它只做三件事，为的是让那一次复核
**一屏能扫完**：

1. **摊平**：每条一行，印出「输入」与「期望」两栏（嵌套结构压成一行，长文本截断）；
2. **说清要判什么**：每份金标自己那句「复核时看什么」——判据不写出来，复核就退化成重读；
3. **报状态**：条数 + 文件指纹。**金标一改指纹就变**，而下游报告（A0 基线那种）会拿指纹
   比对，所以改之前要知道自己正在动哪一份。

跑完什么都不写（`--out` 也没有）：这份脚本的产物是**屏幕上的那几个问题**，不是文件。
"""
import glob
import hashlib
import json
import sys
from pathlib import Path

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)
    except Exception:  # noqa: BLE001
        pass

BACKEND = Path(__file__).parent
sys.path.insert(0, str(BACKEND))

EV = BACKEND / "evals"

# 每份金标：文件、一行一条怎么印、以及**复核时到底要判什么**。
# 「要判什么」这一栏是这份脚本存在的理由——没有它，人只能重读一遍全部用例。
SETS: dict[str, dict] = {
    "channel": {
        "file": EV / "routes" / "channel.json",
        "title": "通道预判（RAG P2）· 35 条",
        "judge": (
            "逐条问：这句话**该不该检索**？`skip` 是「闲聊/寒暄，不必检索」，`kg` 是「关系型提问，"
            "先走图谱」，`hybrid` 是「要材料」。**红线是误跳过**（该查的没查）；多检索一次只是浪费。"
            "所以只盯 `skip` 那几条：它们真的可以完全不查资料吗？"
        ),
        "row": lambda c: (c.get("id", ""), c.get("ask", ""), f"→ {c.get('channel','')}"),
    },
    "citations": {
        "file": EV / "citations" / "cases.json",
        "title": "引用验证（RAG P3）· 20 条",
        "judge": (
            "逐条问：正文里那个 `[来源 N]` **该不该被拿掉**？`injected` 是这一轮注入了几条，"
            "`fake` 是期望被剥掉的编号、`cited` 是剥完还留着的。**重点看那几种「像引用但不是」的"
            "写法**（`[来源 七]`、`[来源 1-2]`、`【来源 7】`、代码块里举例说明标记长什么样）——"
            "宽匹配吃掉的是真话，比漏一个假编号贵。"
        ),
        "row": lambda c: (
            c.get("id", ""),
            str(c.get("reply", ""))[:70],
            f"注入 {c.get('injected')} · 剥 {c.get('fake') or '无'} · 留 {c.get('cited') or '无'}",
        ),
    },
    "agent": {
        "file": EV / "agent" / "tasks.jsonl",
        "title": "A0 任务级金标 · 20 条",
        "judge": (
            "逐条问三件事：① **题面像不像真人说的一句**（不是描述一个测试）；② `expected` 里的"
            "期望**是不是这一题的正确答案**（`must_save` / `artifact_kinds` / `must_call` / "
            "`rounds_budget`）——这些直接决定报告上的完成率；③ `vault` 给的材料够不够答题"
            "（不够就是「故意让它答不出」还是「我们出题漏了」）。**`note` 里写着每一题的出处**，"
            "对不上就往回查。"
        ),
        "row": lambda t: (
            t.get("id", ""),
            str(t.get("instruction", ""))[:60],
            f"{t.get('tag','')} · {json.dumps(t.get('expected') or {}, ensure_ascii=False)[:70]}",
        ),
    },
    "collab": {
        "file": EV / "collab" / "tasks.jsonl",
        "title": "协作金标（A2）· 3 条",
        "judge": (
            "只有三条，但每条都要问：**这份材料里有没有一个「只能靠分工才答得出」的点**"
            "（`markers` 就是它）？材料量够不够撑起 fanout（份数 < 路数就分不匀）？"
            "以及 `agents` 的人设会不会把答案直接漏给某一步（那样量的是念题不是协作）。"
        ),
        "row": lambda t: (
            t.get("id", ""),
            str(t.get("goal", ""))[:60],
            f"{t.get('pattern','')} · {len(t.get('agents') or [])} 个 agent · markers "
            f"{len(t.get('markers') or [])} 个",
        ),
    },
    "turns": {
        "file": EV / "turns" / "deliver_report.json",
        "title": "聊天回合行为（W1）· 7 条",
        "judge": (
            "逐条问：这条用例**对着哪个实测过的缺陷**（`note` 里按 ①–⑧ 列着），而 `expect` 里的"
            "每一栏**是不是这条用例真正要守的那件事**？例如 `must_not_save` 是「别把闲聊变产出」、"
            "`claims_a_delete_without_one` 是「明说要忘掉时不许嘴上删了」。**新加的第 ⑧ 条是"
            "2026-09-23 补的**，重点看它：它只在「你明说要删」时才判，是不是太窄？"
        ),
        "row": lambda c: (
            c.get("id", ""),
            str(c.get("ask", ""))[:60],
            f"{json.dumps(c.get('expect') or {}, ensure_ascii=False)[:70]}"
            + ("（空 vault）" if not (c.get("vault") or {}) else f"（{len(c.get('vault') or {})} 份材料）"),
        ),
    },
    "retrieval": {
        "file": EV / "retrieval" / "golden.jsonl",
        "title": "文件级召回（RAG P0/P1c）· 63 条",
        "judge": (
            "逐条问：这个问句的**答案真的只在 `expected_source` 那一份里**吗？（若别的文件也答得了，"
            "那这一题会把「找了另一份对的」判成没找到。）另外看 `tag` 分档是否合理——"
            "尤其是 `no_answer` 那几条：它们期望的东西**库里确实没有**吗？"
            "**2026-09-23 从 44 条扩到 63 条**（补了 6 条失败正样本 + 9 条擦边命中），"
            "分数线与运行点都跟着变了——读数见 `retrieval_gate.py` 的 docstring。"
        ),
        "row": lambda c: (
            c.get("query", "")[:60],
            f"→ {str(c.get('expected_source','')).split('/')[-1]}",
            f"{c.get('tag','')} · {str(c.get('note',''))[:26]}",
        ),
    },
    "candidates": {
        "file": EV / "retrieval" / "candidates.jsonl",
        "title": "文件级召回 · **候选题工作台**（挖硬负样本，2026-09-24）",
        "judge": (
            "**这一份还没进金标**——它是候选，判完才决定入库。逐条只判一件事："
            "`expected_source` 真是这句问话的答案吗（依据原文写在 `note` 里）？"
            "`probe.verdict` 是免费跑一遍检索的读数：`miss` 的才是要补的**硬负样本**（`rank` 空），"
            "`hit` 的会进 `good`。**`probe.top1` 是被排在前面的那一份**——如果它其实也答得了，"
            "那这题出糊了（该改题或删），这正是复核要抓的第二种毛病。"
            "读数由 `smoke_mine_candidates.py` 写回（`probe.at` 是量的时候）。"
        ),
        "row": lambda c: (
            c.get("query", "")[:56],
            f"→ {str(c.get('expected_source','')).split('/')[-1]}",
            f"{c.get('tag','')} · {(c.get('probe') or {}).get('verdict','未跑')}"
            f" {(c.get('probe') or {}).get('rank') or ''}"
            f" · 撞上 {str((c.get('probe') or {}).get('top1','')).split('/')[-1] or '—'}",
        ),
    },
    "gather": {
        "file": EV / "retrieval" / "gather.jsonl",
        "title": "引擎侧攒材料（新，2026-09-23）· 10 条",
        "judge": (
            "逐条问两件事：① 那个 `topic` 像不像**引擎真会收到的一句取材题**；② `required` 里那几份"
            "**是不是一份完整材料真的缺一不可**——多写一份，覆盖率就永远到不了 1（冤枉检索）；"
            "少写一份，题就变简单了。`note` 里写着每一份「为什么必须在」。"
        ),
        "row": lambda c: (
            c.get("id", c.get("topic", "")[:12]),
            str(c.get("topic", ""))[:56],
            f"要 {len(c.get('required') or [])} 份：" + "、".join(
                str(s).split("/")[-2] + "/" + str(s).split("/")[-1]
                for s in (c.get("required") or [])[:3]
            ),
        ),
    },
}


def _load(path: Path) -> list[dict]:
    if path.suffix == ".jsonl":
        # 空行与 `//` 注释行跳过（与 `agent_eval.load_tasks` 同一条规矩）
        rows = []
        for line in path.read_text(encoding="utf-8").splitlines():
            text = line.strip()
            if not text or text.startswith("//"):
                continue
            rows.append(json.loads(text))
        return rows
    blob = json.loads(path.read_text(encoding="utf-8"))
    return blob.get("cases") if isinstance(blob, dict) else blob


def _sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()[:12]


def main() -> int:
    want = [a for a in sys.argv[1:] if not a.startswith("-")]
    keys = want or list(SETS)
    if "--counts" in sys.argv:
        print(f"{'金标':<12}{'条数':>6}  指纹        文件")
        for k in keys:
            spec = SETS.get(k)
            if not spec or not spec["file"].exists():
                print(f"{k:<12}{'—':>6}  （文件不在）")
                continue
            print(f"{k:<12}{len(_load(spec['file'])):>6}  {_sha(spec['file'])}  {spec['file'].name}")
        return 0

    for k in keys:
        spec = SETS.get(k)
        if not spec:
            print(f"（不认识的金标：{k}——可选 {list(SETS)}）")
            continue
        path = spec["file"]
        if not path.exists():
            print(f"\n### {spec['title']}\n  （文件不在：{path}）")
            continue
        rows = _load(path)
        print("\n" + "=" * 96)
        print(f"### {spec['title']}　·　{path.relative_to(BACKEND.parent).as_posix()}　·　"
              f"指纹 {_sha(path)}　·　{len(rows)} 条")
        print("=" * 96)
        print("复核时判什么：")
        for line in _wrap(spec["judge"], 92):
            print("  " + line)
        print()
        for i, c in enumerate(rows, 1):
            try:
                ident, inp, exp = spec["row"](c)
            except Exception as e:  # noqa: BLE001 - 一行的形状不对不该让助手崩
                print(f"  {i:>3}. （这一行读不出来：{type(e).__name__}: {e}）")
                continue
            # 两行一条：中文与英文的显示宽度不一，硬对齐列反而更难读（试过，糊成一片）
            print(f"  {i:>3}. {ident}")
            print(f"       输入　{inp}")
            print(f"       期望　{exp}")
    print(
        "\n（**复核完请直接改金标文件**——改完指纹会变，下游报告会如实说「不可比」，"
        "那是设计好的行为，不是坏掉。）"
    )
    return 0


def _wrap(text: str, width: int) -> list[str]:
    out: list[str] = []
    line = ""
    for ch in text:
        line += ch
        if len(line) >= width and ch in "。；：？！，、 ":
            out.append(line)
            line = ""
    if line:
        out.append(line)
    return out


if __name__ == "__main__":
    raise SystemExit(main())
