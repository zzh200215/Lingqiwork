"""评测用的两个小统计：**共用一处，别在两把尺子里各写一遍**。

它住在 `app/core/` 而不是某把尺子里，理由是那一族红线：**运行时代码不许 import 尺子**
（`tests/test_agent_eval.py` 里那条 AST 扫描）。而符号检验是**两把以上尺子都要用**的东西
（协作配对、引擎攒材料的配对……），谁 import 谁就成了「运行时读了金标」。

所以：**纯数学放这里，尺子各自 import 它**。这样「同一件事只有一份实现」与「运行时不碰金标」
两条同时成立——第一版把 `sign_test_p` 放在 `collab_eval` 里，`gather_eval` 一 import 就撞了红线
（那条测试当场变红，这正是它存在的意义）。
"""
from math import comb


def sign_test_p(win: int, loss: int) -> float:
    """配对符号检验的双侧 p（平局丢掉）。Pure。

    **它只用来拦一种读法**：「5 胜 2 负 → 这个更好」。同一个任务的多遍之间**并不独立**
    （同一套材料、同一个模型、甚至同一时刻），所以这个 p 是个描述，不是证明——
    它回答的是「这点差距在这个 n 下值不值得当结论」。
    """
    n = int(win) + int(loss)
    if n <= 0:
        return 1.0
    k = min(int(win), int(loss))
    tail = sum(comb(n, i) for i in range(k + 1)) / (2**n)
    return round(min(1.0, 2 * tail), 4)
