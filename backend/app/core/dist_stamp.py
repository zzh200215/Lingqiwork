"""dist 与源码的一致性闸：**只提示，不拦截**。

`frontend/dist` 是手动构建的（`npm run build`），后端启动时直接把它挂到 `/`。
gap 在于：改了前端源码、忘了重新 build，服务照常起、页面照常开——
于是「调试半天发现看的是旧包」（2026-10-01 实际发生过一次）。

build 末尾会往 `dist/.wb-build.json` 写一个章（commit + 时间，见
`frontend/scripts/write-build-stamp.mjs`）；这里在启动时拿它跟 `git rev-parse HEAD`
比一下。三种状态：

* **对得上** → 安静。没消息就是好消息。
* **对不上** → 一条 warning，写明两个 commit——把「先 build 再调试」变成启动时的默认提醒。
* **比不了**（没有章 / git 不可用 / 不在仓库里）→ 各自有话则说，没有就闭嘴。
  这条闸是帮你省调试时间的，不该为了它把启动搞挂。
"""
import json
import logging
import subprocess
from pathlib import Path

log = logging.getLogger(__name__)


def current_head(repo: Path) -> str | None:
    """当前 HEAD commit；拿不到（不是 git 仓库 / git 不可用）返回 None。"""
    try:
        r = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=repo,
            capture_output=True,
            text=True,
            timeout=5,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if r.returncode != 0:
        return None
    head = r.stdout.strip()
    return head or None


def stale_reason(stamp_path: Path, head: str | None) -> str | None:
    """dist 落后时返回给人看的原因，新鲜 / 比不了返回 None。"""
    if not stamp_path.exists():
        return f"{stamp_path.parent.name}/ 没有 .wb-build.json——dist 可能没构建过，先 npm run build"
    try:
        stamp = json.loads(stamp_path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return f"{stamp_path.name} 读不出来——dist 状态未知，先 npm run build"
    stamp_commit = stamp.get("commit") if isinstance(stamp, dict) else None
    if not head or not stamp_commit:
        return None  # 有一边拿不到 commit，比不了就不猜
    if stamp_commit != head:
        return (
            f"frontend/dist 构建于 {str(stamp.get('at', '?'))[:19]}（commit {stamp_commit[:10]}…），"
            f"落后于当前代码（{head[:10]}…）——调试前先 npm run build"
        )
    return None


def check_and_warn(repo: Path, dist_dir: Path) -> None:
    reason = stale_reason(dist_dir / ".wb-build.json", current_head(repo))
    if reason:
        log.warning("%s", reason)
