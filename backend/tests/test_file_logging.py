"""文件日志（CTO review #9）：root logger 必须带一个落在 data/logs/ 的轮转文件句柄。

无人值守任务出事时 stdout 不可回放，文件是唯一事后证据——这条钉住「装配时真的
挂上了」，免得哪次重构把这段当死代码删掉而无人察觉。
"""
import logging
from logging.handlers import RotatingFileHandler


def test_root_logger_has_rotating_file_handler_in_data_logs():
    from app import main  # noqa: F401 - 装配副作用就是要测的东西
    from app.config import DATA_DIR

    fhs = [
        h for h in logging.getLogger().handlers if isinstance(h, RotatingFileHandler)
    ]
    assert fhs, "root logger 没有文件句柄——无人值守任务出事将无据可查"
    assert fhs[0].baseFilename.startswith(str(DATA_DIR / "logs"))
    assert fhs[0].maxBytes >= 1_000_000  # 有上限：不能无限涨


def test_warning_record_reaches_the_file():
    from app import main  # noqa: F401
    from app.config import DATA_DIR

    probe = "file-log probe 中文一条"
    logging.getLogger("wb.test.filelog").warning(probe)
    for f in (DATA_DIR / "logs").glob("workbench.log*"):
        if probe in f.read_text(encoding="utf-8", errors="ignore"):
            break
    else:
        raise AssertionError("warning 没有落进 workbench.log（句柄没挂或级别不对）")
