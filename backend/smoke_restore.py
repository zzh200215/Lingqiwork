"""真实备份恢复演练，可重复跑。

这是唯一一件晚做就来不及的事：之后任何一次事故都会清空正在积累的理解
状态，而那是唯一不可重建的资产。所以这个脚本不是「读一遍备份代码觉得没问题」，
而是真的把归档解开、把后端跑在解出来的库上、把向量库从解出来的 vault 重建一遍。

安全边界（不这样写就不敢对着真实数据跑）：
- 只往 `backups/` 写一个新归档，其余全部写进 `.smoke_restore/`，跑完删掉。
- 新归档会不会挤掉旧的先算一遍；会挤掉就把这次的归档也写进临时目录。任何一次
  演练都不删除已有归档。
- 恢复目标是临时目录，永远不覆盖 `vault/` 或 `data/`。
- 起后端时把 WB_DB_PATH / WB_CONFIG_PATH / WB_CHROMA_PATH 全指到临时目录，
  所以演练里的后端碰不到线上库，也碰不到线上索引。

唯一一处对线上库的写入：`create_backup` 成功后 `pet.emit` 会记一行宠物台词 ——
和在设置页点一次「立即备份」完全一样，不是演练额外造成的。

跑法：backend/.venv/Scripts/python.exe smoke_restore.py [--keep]
"""
import hashlib
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import time
import urllib.error
import urllib.request
import zipfile
from pathlib import Path

# --- API token: the smoke scripts are exactly the kind of
# external caller the guard exists for, so they present a token. Children
# inherit it because env dicts spread os.environ. ---
_WB_TOKEN = os.environ.setdefault("WB_API_TOKEN", "smoke-token")
_WB_HEADERS = {"Content-Type": "application/json", "X-WB-Token": _WB_TOKEN}

BACKEND = Path("D:/TP/A/backend")
SCRATCH = BACKEND / ".smoke_restore"
PORT = 8787
BASE = f"http://127.0.0.1:{PORT}"
PROBE = "FastAPI"  # a word the live vault actually contains (clippings/fastapi...)

FAIL: list[str] = []


def ok(label: str, detail: str = "") -> None:
    print(f"  ok   {label}" + (f" — {detail}" if detail else ""))


def bad(label: str, detail: str = "") -> None:
    FAIL.append(label)
    print(f"  FAIL {label}" + (f" — {detail}" if detail else ""))


def head(title: str) -> None:
    print(f"\n== {title}")


def sha(p: Path) -> str:
    h = hashlib.sha256()
    with p.open("rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def req(path: str, timeout: int = 60):
    r = urllib.request.Request(BASE + path, headers=_WB_HEADERS)
    with urllib.request.urlopen(r, timeout=timeout) as resp:
        return json.loads(resp.read())


def wait_health(log: Path, seconds: int = 180) -> None:
    deadline = time.time() + seconds
    while time.time() < deadline:
        try:
            req("/api/health", timeout=3)
            return
        except Exception:
            time.sleep(1)
    print(log.read_text(encoding="utf-8", errors="ignore")[-2000:])
    raise SystemExit("restored backend never became healthy")


def pick_archive() -> str:
    """Always a freshly written archive, so every later comparison can be strict.

    It lands in the real `backups/` when that displaces nothing, otherwise in the
    scratch dir — same `create_backup` code either way, and no run of this drill
    ever deletes an existing archive.
    """
    from app.core import backup

    have, keep = len(backup._archives()), backup._keep()
    if have + 1 > keep:
        print(f"  --   已有 {have} 份 == 保留上限 {keep}，改把这次的归档写进临时目录（不挤掉旧的）")
        real = backup.load_config
        backup.load_config = lambda: {**real(), "backup_dir": str(SCRATCH / "backups"), "backup_keep": 99}
    info = backup.create_backup("drill")
    ok("新归档", f"{info['name']}  {info['size'] / 1024:.0f} KB  {info['vault_files']} 个文件")
    print(f"       写到 {backup.backup_dir()}")
    if info["pruned"]:
        bad("没有删掉任何旧归档", str(info["pruned"]))
    return info["name"]


def check_vault(root: Path) -> None:
    """Every vault file back, byte-identical, with its name intact."""
    from app.config import VAULT_DIR

    rv = root / "vault"
    if not rv.is_dir():
        bad("vault 恢复", "包里没有 vault/")
        return
    got = {p.relative_to(rv).as_posix(): sha(p) for p in rv.rglob("*") if p.is_file()}
    live = {p.relative_to(VAULT_DIR).as_posix(): sha(p) for p in VAULT_DIR.rglob("*") if p.is_file()}
    if got == live:
        ok("vault 逐字节一致", f"{len(got)} 个文件")
    else:
        missing = sorted(set(live) - set(got))
        changed = sorted(n for n in set(live) & set(got) if live[n] != got[n])
        bad("vault 逐字节一致", f"缺 {missing}，内容不同 {changed}")
    non_ascii = [n for n in got if not n.isascii()]
    if non_ascii:
        ok("中文文件名未损坏", f"{len(non_ascii)} 个，例如 {non_ascii[0]}")
    else:
        bad("中文文件名未损坏", "包里一个非 ASCII 名都没有，检查一下是不是被吞了")


def _tables(db: Path) -> set[str]:
    con = sqlite3.connect(f"file:{db.as_posix()}?mode=ro", uri=True)
    try:
        return {r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    finally:
        con.close()


def check_db(root: Path) -> Path | None:
    """The restored SQLite must pass integrity_check and carry every table and row
    the live one has. What it must *not* be asked is whether it has the newest
    feature's tables: `create_all` makes those on the next boot, which is exactly
    what phase 5 checks."""
    from app.config import settings
    from app.models import Base

    db = root / "data" / Path(settings.db_path).name
    if not db.is_file():
        bad("SQLite 恢复", "包里没有 data/*.db")
        return None
    live_db = Path(settings.db_path)
    con = sqlite3.connect(db)
    try:
        if con.execute("PRAGMA integrity_check").fetchone()[0] == "ok":
            ok("integrity_check")
        else:
            bad("integrity_check")
        got = {r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        live_tables = _tables(live_db)
        if got == live_tables:
            ok("表与线上一致", f"{len(got)} 张")
        else:
            bad("表与线上一致", f"缺 {sorted(live_tables - got)}，多 {sorted(got - live_tables)}")
        pending = sorted(set(Base.metadata.tables) - got)
        if pending:
            print(f"       归档里还没有的表：{pending} —— 下次启动 create_all 会补上（第 5 步验证）")
        counted = {
            t: con.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
            for t in ("conversations", "messages", "tutor_sessions", "tutor_turns")
            if t in got
        }
    finally:
        con.close()
    print(f"       行数 {counted}")
    live = sqlite3.connect(f"file:{live_db.as_posix()}?mode=ro", uri=True)
    try:
        same = {t: live.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0] for t in counted}
    finally:
        live.close()
    if same == counted:
        ok("行数与线上一致", str(counted))
    else:
        bad("行数与线上一致", f"线上 {same}")
    return db


def report_gaps(name: str) -> None:
    """What lives in data/ but is not in the archive — checked against the manifest.

    Not all of it needs to be in the archive. The point is that the list is
    written down (`backup.NOT_INCLUDED` → manifest) instead of rediscovered
    during a restore, so anything absent that the manifest does not explain is a
    real drift and gets flagged here.
    """
    from app.config import DATA_DIR
    from app.core import backup

    with zipfile.ZipFile(backup.resolve(name)) as z:
        inside = {n.split("/", 2)[1] for n in z.namelist() if n.startswith("data/")}
        manifest = json.loads(z.read("backup-manifest.json"))
    outside = sorted(p.name + ("/" if p.is_dir() else "") for p in DATA_DIR.iterdir())
    absent = [n for n in outside if n.rstrip("/") not in inside]
    print(f"       包内 data/: {sorted(inside)}")
    print(f"       未入包    : {absent}")

    declared = manifest.get("not_included") or {}
    # "data/artifacts + images + podcasts + tts" declares four names in one row
    named = {
        part.strip().removeprefix("data/")
        for key in declared
        for part in key.removeprefix("data/").split("+")
    }
    undeclared = [n for n in absent if n.rstrip("/") not in named]
    if declared and not undeclared:
        ok("未入包的东西都在 manifest 里写明了", f"{len(declared)} 条")
    elif not declared:
        bad("manifest 写明未入包的东西", "manifest 里没有 not_included")
    else:
        bad("未入包的东西都在 manifest 里写明了", f"没写的：{undeclared}")
    for k, v in declared.items():
        print(f"       {k}: {v}")


def serve(db: Path, cfg: Path) -> None:
    """Boot the real backend on the restored db — 「回到可用状态」不是 sqlite3 能读，
    而是应用自己的代码能读。索引另给一个空目录，确保碰不到线上向量库。"""
    SCRATCH.mkdir(parents=True, exist_ok=True)
    log = SCRATCH / "server.log"
    env = {
        **os.environ,
        "WB_DB_PATH": str(db),
        "WB_CONFIG_PATH": str(cfg),
        "WB_CHROMA_PATH": str(SCRATCH / "chroma_srv"),
    }
    logf = open(log, "w")
    proc = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "app.main:app", "--port", str(PORT)],
        cwd=str(BACKEND),
        env=env,
        stdout=logf,
        stderr=subprocess.STDOUT,
    )
    try:
        wait_health(log)
        ok("后端起在恢复出来的库上", f"port {PORT}")
        s = req("/api/tutor/sessions")
        ok("GET /api/tutor/sessions", f"{len(s['sessions'])} 次会话")
        st = req("/api/tutor/stats")
        ok("GET /api/tutor/stats", json.dumps(st, ensure_ascii=False))
        cs = req("/api/conversations")
        ok("GET /api/conversations", f"{len(cs)} 个对话")
        d = req("/api/dashboard")
        ok("GET /api/dashboard", f"conversations={d.get('conversations')} messages={d.get('messages')}")
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=15)
        except subprocess.TimeoutExpired:
            proc.kill()
        logf.close()
    # 灾难场景是「用旧备份 + 新代码」：启动时 create_all 必须把这一版新加的表补齐，
    # 否则恢复出来的是一个开不了新功能的库。
    from app.models import Base

    after = _tables(db)
    missing = sorted(set(Base.metadata.tables) - after)
    if missing:
        bad("启动后补齐缺的表", f"仍缺 {missing}")
    else:
        ok("启动后补齐缺的表", f"{len(after)} 张，含 tutor_sessions / tutor_turns")


def index_phase(vault: Path) -> int:
    """子进程：从恢复出来的 vault 重建索引到 WB_CHROMA_PATH，再真检索一次。

    单独一个进程，是因为 chroma 的 client 是模块级单例、路径在首次打开时就定死了。
    """
    from app.core import indexer

    stats = indexer.reindex_all(vault)
    hits = indexer.search(PROBE, top_k=3)
    print(
        "INDEX "
        + json.dumps(
            {
                "files": stats["files"],
                "chunks": stats["chunks"],
                "errors": stats["errors"],
                "seconds": stats["seconds"],
                "hits": [{"source": h.get("source"), "score": round(h.get("score", 0), 3)} for h in hits],
            },
            ensure_ascii=False,
        )
    )
    return 0


def check_index(vault: Path) -> None:
    """备份不含向量库，靠的就是「能从 vault 重建」。这里把那句话跑一遍。"""
    env = {
        **os.environ,
        "WB_CHROMA_PATH": str(SCRATCH / "chroma_idx"),
        "PYTHONIOENCODING": "utf-8",
    }
    t0 = time.time()
    r = subprocess.run(
        [sys.executable, __file__, "--index", str(vault)],
        cwd=str(BACKEND),
        env=env,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=3600,
    )
    line = next((ln for ln in r.stdout.splitlines() if ln.startswith("INDEX ")), "")
    if not line:
        bad("索引重建", f"子进程没给出结果（exit {r.returncode}）：{(r.stderr or r.stdout)[-500:]}")
        return
    got = json.loads(line[6:])
    ok("索引重建", f"{got['files']} 个文件 → {got['chunks']} 个 chunk，{got['seconds']}s（总 {time.time() - t0:.0f}s）")
    if got["errors"]:
        bad("重建无报错", str(got["errors"]))
    if got["hits"]:
        ok(f"检索「{PROBE}」", str(got["hits"]))
    else:
        bad(f"检索「{PROBE}」", "重建完了但检索不到 —— 索引没真正可用")


def main() -> int:
    if "--index" in sys.argv:
        return index_phase(Path(sys.argv[sys.argv.index("--index") + 1]))

    from app.config import settings
    from app.core import backup

    keep = "--keep" in sys.argv
    shutil.rmtree(SCRATCH, ignore_errors=True)
    SCRATCH.mkdir(parents=True)
    try:
        head("0 归档")
        name = pick_archive()

        head("1 解压到临时目录（不覆盖任何线上目录）")
        root = SCRATCH / "root"
        with zipfile.ZipFile(backup.resolve(name)) as z:
            z.extractall(root)
        ok("解压", str(root))
        m = json.loads((root / "backup-manifest.json").read_text(encoding="utf-8"))
        print(f"       manifest {m['created_at']} reason={m['reason']} "
              f"vault_files={m['vault_files']} db={m['db']} index_included={m['index_included']}")

        head("2 vault")
        check_vault(root)

        head("3 SQLite")
        db = check_db(root)

        head("4 未入包的东西")
        report_gaps(name)

        head("5 后端跑在恢复出来的库上")
        if db is None:
            bad("后端起在恢复出来的库上", "没有可用的库")
        else:
            cfg = root / "data" / Path(settings.config_path).name
            serve(db, cfg if cfg.is_file() else SCRATCH / "config.json")

        head("6 向量库从恢复出来的 vault 重建")
        check_index(root / "vault")

        head("结果")
        if FAIL:
            print(f"  DRILL FAIL — {len(FAIL)} 项：{FAIL}")
            return 1
        print("  DRILL PASS — 归档能恢复成一个可用的库 + vault + 可重建的索引")
        return 0
    finally:
        if keep:
            print(f"\n(--keep) 临时目录留着：{SCRATCH}")
        else:
            for _ in range(5):
                shutil.rmtree(SCRATCH, ignore_errors=True)
                if not SCRATCH.exists():
                    break
                time.sleep(1)


if __name__ == "__main__":
    sys.exit(main())
