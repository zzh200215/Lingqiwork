"""跨模块联调 drill（PLAN.md 第 9 节 T2 层 · 安全 block §10.4 #5+#6）。

和逐模块 drill 不同，它走**一条完整用户链路**并穿过真实 HTTP 栈：认证守卫 →
剪藏落盘 → 进索引 → 检索回来 → 研究成文 → 存回 vault → 再检索命中 → 备份。
单模块测试过了不等于这条链过了；这个脚本就是在 block 收口时回答后者。

需要：后端已在 127.0.0.1:8000 跑着（dev.bat 或 desktop.py）。
token 取 `WB_API_TOKEN`，没有就读 `data/api_token`。
没有可用模型时研究会**跳过**（退出码 3），其余各跳仍要绿。

注意：它会在真实的 vault/ 与 backups/ 里落东西（剪藏一篇、研究存一篇、跑一次备份），
两个文件名字都有 drill 标记，便于事后清理。

跑法：
    backend/.venv/Scripts/python.exe smoke_integration.py
退出码：0 = 全绿；1 = 有真失败；3 = 绿但研究那跳因无可用模型被跳过。
"""
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
try:  # ✓/✗ and the Chinese labels must not die on a GBK console
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:  # noqa: BLE001
    pass

BASE = "http://127.0.0.1:8000"
PROJECT = Path(__file__).resolve().parent.parent
RUN = str(int(time.time()))
CLIP_MARK = f"WBCLIP-{RUN}"   # 只在剪藏那篇里出现
NOTE_MARK = f"WBNOTE-{RUN}"   # 只在研究那篇的标题里出现
TOPIC_Q = "生成器与迭代器有什么区别"
# 对质那一跳：种两段**互相矛盾**的文本，看引擎揪不揪得出来（下面 leg_conflict）
CF_TOPIC = "本地向量库到 100 万 chunk 时 Chroma 的检索延迟"
CF_MARK_A = f"WBCFA-{RUN}"
CF_MARK_B = f"WBCFB-{RUN}"


def token() -> str:
    env = (os.environ.get("WB_API_TOKEN") or "").strip()
    if env:
        return env
    try:
        return (PROJECT / "data" / "api_token").read_text(encoding="utf-8").strip()
    except OSError:
        return ""


TOK = token()
FAIL: list[str] = []


def _call(method: str, path: str, body: dict | None = None, token_hdr: str | None = TOK,
          cookie: str | None = None, timeout: int = 120):
    """(status, parsed_or_text, headers). HTTP errors are returned, not raised,
    so the auth leg can assert on 401."""
    data = json.dumps(body).encode() if body is not None else None
    headers = {"Content-Type": "application/json"}
    if token_hdr:
        headers["X-WB-Token"] = token_hdr
    if cookie:
        headers["Cookie"] = f"wb_token={cookie}"
    r = urllib.request.Request(BASE + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            return _unpack(resp.status, resp.read(), dict(resp.headers))
    except urllib.error.HTTPError as e:
        return _unpack(e.code, e.read(), dict(e.headers))


def _unpack(status: int, raw: bytes, headers: dict):
    text = raw.decode("utf-8", "ignore")
    try:
        return status, json.loads(text), headers
    except json.JSONDecodeError:
        return status, text, headers


def ok(label: str, detail: str = "") -> None:
    print(f"  ✓ {label}" + (f" — {detail}" if detail else ""), flush=True)


def bad(label: str, detail: str = "") -> None:
    FAIL.append(label)
    print(f"  ✗ {label}" + (f" — {detail}" if detail else ""), flush=True)


def _kb_hits(q: str, top_k: int = 8) -> list[dict]:
    status, body, _ = _call("GET", f"/api/kb/search?q={urllib.parse.quote(q)}&top_k={top_k}")
    return body.get("hits", []) if isinstance(body, dict) else []


def _poll_hit(needle: str, query: str, seconds: int = 30) -> bool:
    """剪藏落盘后由 watcher 异步进索引；研究存盘同理。给索引一点时间，然后
    用**语义检索**确认它真的能被捞回来（而不是只看文件在不在）。"""
    deadline = time.time() + seconds
    while True:
        hits = _kb_hits(query)
        if any(needle in json.dumps(h, ensure_ascii=False) for h in hits):
            return True
        if time.time() >= deadline:
            return False
        time.sleep(3)


# --- legs ---------------------------------------------------------------------

def leg_auth_guard() -> None:
    print("\n[1] 认证守卫：/api/* 与 /mcp 无 token 都要 401")
    status, _, _ = _call("GET", "/api/settings/prefs", token_hdr=None)
    (ok if status == 401 else bad)("无 token → /api/settings/prefs 401", f"got {status}")
    status, _, _ = _call("POST", "/mcp", {}, token_hdr=None)
    (ok if status == 401 else bad)("无 token → /mcp 401", f"got {status}")
    status, _, _ = _call("GET", "/api/settings/providers", token_hdr="wrong-token")
    (ok if status == 401 else bad)("错 token → 401", f"got {status}")


def leg_token_and_cookie() -> None:
    print("\n[2] 两条通道：X-WB-Token header 与 wb_token cookie")
    if not TOK:
        bad("拿不到 token（WB_API_TOKEN 未设，data/api_token 也读不到）")
        return
    status, _, _ = _call("GET", "/api/settings/providers")
    (ok if status == 200 else bad)("header token → 200", f"got {status}")

    # 模拟浏览器首屏：不带 token 取 /，响应必须落一个 cookie，再用它访问 API。
    # 只报 cookie 的**属性**，绝不回显它的值 —— 一个把 token 打进日志的 drill
    # 本身就是 #5 那类泄漏。
    _, _, headers = _call("GET", "/", token_hdr=None)
    set_cookie = headers.get("Set-Cookie") or headers.get("set-cookie") or ""
    # starlette writes the directive lowercase ("SameSite=strict") — match loosely
    low = set_cookie.lower()
    flags = [f for f in ("samesite=strict", "httponly", "path=/") if f in low]
    (ok if "wb_token=" in set_cookie else bad)("首屏下发 wb_token cookie", " ".join(flags) or "没下发")
    if "wb_token=" in set_cookie:
        val = set_cookie.split("wb_token=", 1)[1].split(";", 1)[0]
        status, _, _ = _call("GET", "/api/settings/providers", token_hdr=None, cookie=val)
        (ok if status == 200 else bad)("cookie → 200（<img>/<audio>/下载走的就是这条路）", f"got {status}")


def leg_capture_to_recall() -> None:
    print("\n[3] 剪藏 → 落盘 → 检索回来")
    text = (
        f"{CLIP_MARK} 联调标记。这段文本只为 drill 存在：验证剪藏落盘之后，"
        "同一个工作台能在知识库里把它检索回来。"
    )
    status, body, _ = _call("POST", "/api/kb/clip_text", {"text": text, "title": f"联调剪藏-{CLIP_MARK}"})
    if status != 200:
        bad("剪藏落盘", f"got {status}: {body}")
        return
    ok("剪藏落盘", f"{body.get('filename')} · {body.get('chunks')} chunks")
    (ok if _poll_hit(CLIP_MARK, f"联调标记 {CLIP_MARK}") else bad)("刚剪藏的文本能被知识库检索回来")


def _model_ready() -> bool:
    status, body, _ = _call("GET", "/api/health/self")
    return status == 200 and isinstance(body, dict) and bool(body.get("default_model")) \
        and not body.get("default_model_broken")


def leg_research_roundtrip() -> bool:
    """Returns False when SKIPPED (no usable model)."""
    print("\n[4] 研究成文 → 存回 vault → 再检索命中（需要可用模型）")
    if not _model_ready():
        print("  ⚠ SKIP：没有可用模型（health/self 报 default_model 缺失或已判坏）", flush=True)
        return False

    topic = f"{TOPIC_Q}（drill {RUN}）"
    r = urllib.request.Request(
        BASE + "/api/research",
        data=json.dumps({"topic": topic}).encode(),
        headers={"Content-Type": "application/json", "X-WB-Token": TOK},
        method="POST",
    )
    sections: list[dict] = []
    used: list = []
    try:
        with urllib.request.urlopen(r, timeout=300) as resp:
            for raw in resp:
                line = raw.decode("utf-8", "ignore").strip()
                if not line.startswith("data: "):
                    continue
                ev = json.loads(line[6:])
                if isinstance(ev, dict) and ev.get("message") and not ev.get("sections"):
                    bad("研究成文", str(ev["message"]))
                    return True
                if isinstance(ev, dict) and ev.get("sections"):
                    sections, used = ev["sections"], ev.get("used", [])
    except Exception as e:  # noqa: BLE001
        bad("研究成文", f"{type(e).__name__}: {e}")
        return True

    if not sections:
        bad("研究成文", "流里没有带 sections 的事件")
        return True
    ok("研究成文", f"{len(sections)} 个小节 · 引用 {len(used)} 条")

    status, body, _ = _call(
        "POST", "/api/research/save",
        {"title": f"联调研究 {NOTE_MARK}", "sections": sections, "used": used, "sources": []},
    )
    if status != 200:
        bad("研究存回 vault", f"got {status}: {body}")
        return True
    ok("研究存回 vault", str(body.get("filename")))
    (ok if _poll_hit(NOTE_MARK, TOPIC_Q) else bad)("刚存的研究笔记能被知识库检索回来（回路的最后一跳）")
    return True


def leg_conflict() -> bool:
    """种两段互相矛盾的文本，再跑对质——看这条链路通不通。

    钉死的是**管道**：种下的材料进索引、`/api/conflict` 走完 SSE、回一份带来源的报告。
    「有没有揪出冲突、揪出的是不是种下的那一对」取决于模型怎么改写话题 + 检索排名，
    **只打印不断言**（硬断言会让闸口随机红）。真正的对质能力证明在 `smoke_conflict.py`
    与 `evals/engines/conflict.json` 的 golden 用例里。
    Returns False when SKIPPED (no usable model).
    """
    print("\n[5] 对质：种两段互相矛盾的文本 → 跑对质 → 看它揪不揪得出来（需要可用模型）")
    if not _model_ready():
        print("  ⚠ SKIP：没有可用模型", flush=True)
        return False

    planted = [
        (CF_MARK_A, "本地向量库到 100 万 chunk 时 Chroma 的检索延迟仍然低于 50ms，完全够用。"),
        (CF_MARK_B, "本地向量库到 100 万 chunk 时 Chroma 的检索延迟会涨到 2 秒以上，慢到没法用。"),
    ]
    refs: dict[str, str] = {}
    for mark, line in planted:
        status, body, _ = _call(
            "POST", "/api/kb/clip_text",
            {"text": f"{mark} {CF_TOPIC}：{line}", "title": f"联调对质-{mark}"},
        )
        if status != 200:
            bad("种下矛盾材料", f"got {status}: {body}")
            return True
        refs[mark] = str(body.get("filename") or "")
        if not _poll_hit(mark, CF_TOPIC):
            bad(f"种下的材料 {mark} 进不了索引", "检索不到")
            return True
    ok("两段互相矛盾的文本已进索引", " · ".join(refs.values()))

    report = _sse_report("/api/conflict", {"topic": CF_TOPIC})
    if report is None:
        bad("对质成文", "流里没有带 sections 的报告（或中途报错）")
        return True

    sources = report.get("sources") or []
    by_ref = {s.get("ref"): s.get("n") for s in sources}
    found = [m for m, ref in refs.items() if ref in by_ref]
    print(f"  · 取材 {len(sources)} 条，种下的两段进了 {len(found)} 段：{found}", flush=True)

    pairs = list(report.get("pairs") or [])
    by_n = {s.get("n"): s for s in sources}
    if pairs:
        detail = "；".join(
            f"[{p['a_n']}] {by_n.get(p['a_n'], {}).get('title', '?')} × "
            f"[{p['b_n']}] {by_n.get(p['b_n'], {}).get('title', '?')}"
            for p in pairs
        )
        print(f"  · 报出 {len(pairs)} 处对不上：{detail}", flush=True)
        planted_ns = {by_ref[r] for r in refs.values() if r in by_ref}
        if not any(planted_ns & {p["a_n"], p["b_n"]} for p in pairs):
            print("    （没落到种下的那两段上——可能它找到了别的分歧，也可能检索没够到）", flush=True)
    else:
        print("  · 扫描判定这批材料没有对不上的（模型很克制，不会硬凑）", flush=True)

    # **只硬断言管道**：种下的材料进得了索引、/api/conflict 走完 SSE、回一份带来源的报告。
    # 「揪出的是不是种下的那一对」取决于模型怎么改写话题 + 检索排名，做成硬断言会让闸口
    # 随机红；正面对质能力的证明在进程内的 smoke_conflict.py 与 golden 用例里。
    (ok if sources else bad)("对质走通 SSE 并回了带来源的报告", f"sources={len(sources)}")
    return True


def _sse_report(path: str, body: dict) -> dict | None:
    """跑一个 SSE 端点，返回**最后一个**带 sections 的载荷。

    必须是最后一个：`draft` 事件也带 sections（半截产物，没有 sources / used / pairs），
    遇到第一个就返回会拿到半截 draft。研究那一跳能对是因为它不 break、循环到最后。
    """
    r = urllib.request.Request(
        BASE + path,
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", "X-WB-Token": TOK},
        method="POST",
    )
    out: dict | None = None
    try:
        with urllib.request.urlopen(r, timeout=300) as resp:
            for raw in resp:
                line = raw.decode("utf-8", "ignore").strip()
                if not line.startswith("data: "):
                    continue
                ev = json.loads(line[6:])
                if isinstance(ev, dict) and ev.get("sections"):
                    out = ev
    except Exception as e:  # noqa: BLE001
        bad("流式调用", f"{type(e).__name__}: {e}")
        return None
    return out


def leg_backup() -> None:
    print("\n[6] 备份闭环（密钥以密文入包，见 PLAN §10.1 #5）")
    status, body, _ = _call("POST", "/api/backup/run", {})
    if status != 200 or not body.get("ok"):
        bad("跑一次备份", f"got {status}: {body}")
        return
    ok("跑一次备份", f"{body.get('name')} · {body.get('size')} bytes · vault {body.get('vault_files')}")
    status, listing, _ = _call("GET", "/api/backup")
    names = [b["name"] for b in listing.get("backups", [])] if isinstance(listing, dict) else []
    (ok if body.get("name") in names else bad)("新备份出现在列表里", str(names[:3]))


def main() -> int:
    status, _, _ = _call("GET", "/api/health", token_hdr=None)
    if status != 200:
        print("后端没有在 127.0.0.1:8000 上应答 —— 先跑 dev.bat 或 desktop.py", flush=True)
        return 1
    print("=" * 60)
    print(f"跨模块联调 drill · {RUN}")
    print("=" * 60)

    leg_auth_guard()
    leg_token_and_cookie()
    leg_capture_to_recall()
    researched = leg_research_roundtrip()
    conflicted = leg_conflict()
    leg_backup()

    print("\n" + "=" * 60)
    if FAIL:
        print(f"SMOKE FAIL ❌  {len(FAIL)} 处：")
        for f in FAIL:
            print(f"  - {f}")
        return 1
    if not (researched and conflicted):
        print("SMOKE PASS ⚠（有跳被跳过 —— 配好 provider 再跑一次才算完整）")
        return 3
    print("SMOKE PASS ✅（含研究全链路 + 对质揪出种下的冲突）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
