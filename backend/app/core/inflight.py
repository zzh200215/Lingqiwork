"""按 key 的在跑守卫——给那些「调真模型 + 落一个文件」的引擎用。

**为什么前端那句 `if (busy) return` 不够。** 它只覆盖一个标签页。第二个标签页、
第二个客户端（MCP、脚本）、或者只是刷新后重按，都到同一个 endpoint。两次并发 =
两次真模型调用 + 两次写同一个输出文件——`recap/YYYY-MM-DD.md` 这个路径对任何
调用者都一样，所以后写的那次直接盖掉前一次，而两次的 token 都花了。

**刻意做成同步的。** 在一个 `threading.Lock` 下的 set 上做「检查并置位」是原子的，
而且全程不 await，所以不会和事件循环交错。另一种写法——用一个 `asyncio.Lock` 把整条
SSE 流罩住——那是把调用者**排队**而不是**拒绝**。这里要的是拒绝：第二个调用者该被
明确告知，而不是静静等一个看不见的队列。

进程内状态，重启即清空——这正是想要的（没有需要恢复的持久状态，也就没有过期锁）。
"""
import threading

_lock = threading.Lock()
_running: set[str] = set()


def try_acquire(key: str) -> bool:
    """key 空闲则占住并返回 True；已经在跑则返回 False（调用者应回 409）。"""
    with _lock:
        if key in _running:
            return False
        _running.add(key)
        return True


def release(key: str) -> None:
    """放掉 key。幂等——重复放不会出错。"""
    with _lock:
        _running.discard(key)


def running() -> list[str]:
    """当前持有的 key。给测试和健康报告看。"""
    with _lock:
        return sorted(_running)
