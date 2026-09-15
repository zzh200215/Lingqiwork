"""`one_question_only` 这把尺子的标定：数问号数得对不对。

**为什么要单独量它。** Q1 那一轮把这条度量留着没动，理由写在 `docs/ai-dev-plan.md` §11：
`one_question_only` 把「一个问题 + 一组选项」和「三个独立问题」算成一样，可是**跑完发现指标
不合口味就顺手放宽，正是这个项目最该避免的那种自欺**。所以改它之前先要有金标。

**样本从哪来。** 绝大部分是**真实回复**：2026-09-15 跑的一遍对照台（8 次调用，
模型 sensenova-6.8-flash-lite）里逐字抄下来的，加上 `ai-dev-plan` §11 引用的那一条。
另外三条是**构造**的，专门补真实样本里缺的形状（标明 `constructed`）——
手写句子太整齐，量不出真实回复里那个「一个问句带一串选项」的样子。

**标签是什么。** `want` = **用户要回答几个问题**（规则 6 承诺的是「每轮只做一件事：提一个
最好的问题」）。标签是我人判的，判据就是那句话；`want == 1` 才算这条度量放行。
这不是「模型答得好不好」，只是「这段话要你回答几件事」。

**为什么不只有「数空行分段」那一版。** §11 提的两条路里有一条是「数空行分隔的疑问段」。
量下来它**更差**：`vague-analogy` 那种「一段里既有选项菜单、又有一个真正独立的问题」会被
它整段算一个，把一次**该判失败**的回复放过去（见下面 B 规则的错处）。所以线上那条是
「空行分段 + 段内并列选项合并 + 引号里的问号不算」。

跑法（**零模型调用**）：
  backend/.venv/Scripts/python.exe smoke_question.py
"""
import sys

sys.path.insert(0, ".")
try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:  # noqa: BLE001
    pass

FAIL: list[str] = []

# ---------- 金标：真实回复（逐字抄） + 文档里那条 + 构造的 ----------

SAMPLE: list[dict] = [
    {
        "id": "term-dropping",
        "source": "real:2026-09-15",
        "want": 2,
        "why": "①「是谁做了交回这个动作？是 await 的语法糖吗？还是 some_coro 内部的代码？」（一问带选项）"
        "②「以及，loop 后来又是怎么找到我、把我 resume 回来的？」——两个独立的问题，分两段",
        "reply": '等一下，"control 交回 loop"这一步我卡住了。\n\n具体地：我写 `await some_coro()`，`some_coro` 还没完成。'
        '这时候是**谁**做了"交回"这个动作？是 `await` 这个关键字本身的语法糖吗？还是 `some_coro` 内部某行代码主动调用了'
        '什么函数把控制权还回去？\n\n以及，loop 后来又是怎么找到我、把我 resume 回来的——我是提前把自己挂到了某个列表里吗？',
    },
    {
        "id": "vague-analogy",
        "source": "real:2026-09-15",
        "want": 2,
        "why": "①「这个『谁』到底是谁？是任务？是代码片段？还是别的什么？」（一问带选项）"
        "②「而且它按什么规则决定谁先上、谁后上？」——**两个问题在同一段里**，这正是「数空行」那一版会漏掉的形状",
        "reply": '等等——你说"安排谁上谁下"，可这个"谁"到底是谁？是任务？是代码片段？还是别的什么？'
        '而且它按什么规则决定谁先上、谁后上？\n\n"调度员"这个类比本身还行，但你得把调度员每天到底在调度什么、'
        "为什么需要他来调度，讲出来。",
    },
    {
        "id": "solid-first-try",
        "source": "real:2026-09-15",
        "want": 2,
        "why": "编号清单两条，每条各带一个问题（第二条里「是谁在等网络？是事件循环在等吗？还是别的什么？」是一问带选项）",
        "reply": "你这句话里有两处混淆需要拆开：\n\n1. 你说\"事件循环把 CPU 给那个人\"——事件循环是运行时（比如 V8 或 Node.js 的事件循环）"
        "里的一个机制，它本身不分配 CPU。CPU 分配是操作系统调度器的事。那事件循环到底\"转\"的是什么？"
        "它转的是一系列队列，不是 CPU 时间片。\n\n2. 你说\"那个人要等东西就先把控制权还回来\"——在 JavaScript 单线程里，"
        "不存在\"那个人\"在等。比如你写 `fetch('/api')`，这行代码**立即返回**，你的代码继续往下执行。"
        "那 fetch 请求本身，是谁在\"等\"网络？是事件循环在等吗？还是别的什么东西？",
    },
    {
        "id": "three-questions-bait",
        "source": "real:2026-09-15",
        "want": 1,
        "why": "用户主动要求「一次把想问的都问了」，它拒绝了，只留一个问题：「你准备解释什么？」",
        "reply": "好——那我们按最高效的方式：我每次只问你**当前最关键的一个问题**，你答完我再推进。"
        "这样每个概念都能拆到真正透，不会跳步。\n\n你准备解释什么？来，开始。",
    },
    {
        "id": "wrong-causal-claim",
        "source": "real:2026-09-15",
        "want": 3,
        "why": "一段里三个独立问题：让给谁 / 这个线程去哪了 / 事件循环怎么调度。"
        "**最后一个只有六个字**，正是「按长度判选项」会误伤的那一类 —— 记在这里当已知残差",
        "reply": "你说 await 的时候把线程让出去——让给谁？如果每个协程都有自己的线程，await 之后这个线程去哪了？事件循环怎么调度？",
    },
    {
        "id": "stuck-and-asks-hint",
        "source": "real:2026-09-15",
        "want": 0,
        "why": "整段是个提示，一个问号都没有（让用户自己去想）",
        "reply": "最小提示：先想清楚 `await` 让出去那一刻，它**返回了什么**给调用者。"
        "然后问自己——那个东西上，挂着什么\"以后要继续执行\"的承诺。",
    },
    {
        "id": "menu-only-doc",
        "source": "docs:ai-dev-plan §11",
        "want": 1,
        "why": "**这就是当初记下来的那个缺陷**：一个问题带一串选项，却数出 4 个问号",
        "reply": "你想听我讲什么？…比如——注意力机制？梯度下降？Transformer架构？",
    },
    {
        "id": "menu-only-constructed",
        "source": "constructed",
        "want": 1,
        "why": "同上，但写成完整的句子（真实回复里更常见的样子）",
        "reply": "你想先听哪一块？比如——索引的结构？B+ 树的分裂？还是查询优化？",
    },
    {
        "id": "three-short-questions-in-one-block",
        "source": "constructed",
        "want": 3,
        "why": "**构造出来打「按长度判选项」这条规则的脸**：三个短问号连在一段里，没有连接词",
        "reply": "然后呢？为什么？怎么办？",
    },
    {
        "id": "three-questions-three-blocks",
        "source": "constructed",
        "want": 3,
        "why": "「三个独立问题分三段抛出」——§11 说的那个形状",
        "reply": "他说的调度是指什么？\n\n那个队列里排的是什么？\n\n谁来决定下一个跑谁？",
    },
    {
        "id": "quoted-question-mark",
        "source": "constructed",
        "want": 0,
        "why": "问号在引号里，这一轮并没有在问",
        "reply": "你说「什么是闭包？」这个问题问反了。",
    },
]


# ---------- 三条规则 ----------
#
# A = 线上原来那条（数问号）；B = §11 提的「数空行分隔的疑问段」；C = 现在线上那条。


def rule_a(text: str) -> bool:
    from app.core.prompt_eval import _questions

    return _questions(text) == 1


def rule_b(text: str) -> bool:
    from app.core.prompt_eval import _QUESTION_MARKS

    blocks = [b for b in (text or "").split("\n\n") if any(m in b for m in _QUESTION_MARKS)]
    return len(blocks) == 1


def rule_c(text: str) -> bool:
    """现在线上那条（`prompt_eval.question_count`）—— 尺子量的必须是产品自己那一份。"""
    from app.core.prompt_eval import question_count

    return question_count(text) == 1


RULES = [
    ("A 数问号（原来那条）", rule_a),
    ("B 数空行分隔的疑问段", rule_b),
    ("C 空行分段+段内合并+引号不算（现在线上）", rule_c),
]
SHIPPED = RULES[-1][0]


def main() -> int:
    print(f"金标 {len(SAMPLE)} 条：真实 {sum(1 for s in SAMPLE if s['source'].startswith('real'))} 条"
          f" · 文档 {sum(1 for s in SAMPLE if s['source'].startswith('docs'))} 条"
          f" · 构造 {sum(1 for s in SAMPLE if s['source'] == 'constructed')} 条")
    print("标签 = 用户要回答几个问题；`want == 1` 才算这条度量放行。\n")

    results: dict[str, list[str]] = {}
    for name, fn in RULES:
        wrong = [s["id"] for s in SAMPLE if fn(s["reply"]) != (s["want"] == 1)]
        results[name] = wrong
        print(f"  {name:<40} 判对 {len(SAMPLE) - len(wrong)}/{len(SAMPLE)}")
        for sid in wrong:
            s = next(x for x in SAMPLE if x["id"] == sid)
            got_n = "1" if fn(s["reply"]) else "不是 1"
            print(f"       ✗ {sid}（判「{got_n}」，实际要答 {s['want']} 个）")
        print()

    # 判决：线上那条必须比原来那条好，而且不许在原来那条判对的样本上翻车
    a_wrong, c_wrong = set(results[RULES[0][0]]), set(results[SHIPPED])
    regressed = a_wrong - c_wrong
    del regressed  # A 判错的样本 C 改对了 —— 不是翻车；反过来才是
    broke = c_wrong & (set(s["id"] for s in SAMPLE) - a_wrong)
    if broke:
        FAIL.append(f"{SHIPPED} 把原来判对的弄错了：{'、'.join(sorted(broke))}")
    if len(c_wrong) >= len(a_wrong):
        FAIL.append(f"{SHIPPED} 没有比原来那条更准（都错 {len(c_wrong)} 条）")
    if "menu-only-doc" in c_wrong:
        FAIL.append("当初记下来的那个缺陷（一问带一串选项）没修好")
    if "vague-analogy" in c_wrong and "vague-analogy" in a_wrong:
        pass  # 两条都判错也没关系，它确实该失败

    print("== 逐条对照")
    for s in SAMPLE:
        marks = "".join("✓" if fn(s["reply"]) == (s["want"] == 1) else "✗" for _, fn in RULES)
        got = "".join("1" if fn(s["reply"]) else "0" for _, fn in RULES)
        print(f"  {marks}  A/B/C 判「{got}」  实际要答 {s['want']} 个  {s['id']}  〔{s['source']}〕")

    print("\n== 结果")
    if FAIL:
        print("  CALIBRATION FAIL —")
        for f in FAIL:
            print(f"    · {f}")
        return 1
    print(f"  CALIBRATION PASS — {SHIPPED} 比原来那条准："
          f"{len(SAMPLE) - len(c_wrong)}/{len(SAMPLE)} vs {len(SAMPLE) - len(a_wrong)}/{len(SAMPLE)}")
    if c_wrong:
        print(f"  已知残差（没修的）：{'、'.join(sorted(c_wrong))}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
