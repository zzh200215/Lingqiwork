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

## 取消（2026-09-26 加）

`request_cancel` / `cancel_requested` 是一对：**合作式**取消。为什么不做成「直接掐掉那个
请求」——因为掐请求只在**流式**接口上是真停（客户端断开，Starlette 会取消生成器）；
对一次性的长 POST（「量一遍」那样每条用例一次模型调用的循环），断开连接**服务端照样
跑完、照样花那份钱**。那种「停止」是假的，而假的停止比没有停止更糟：用户以为省下了调用。

合作式的代价是要持有者**在循环里轮询**，见 `prompt_eval.check` / `skill_eval.run`。
两处都在**每条用例之间**查一次，所以停下来的粒度是「当前这条跑完」。界面上因此写的是
「正在停…（这一条跑完就停）」，而不是「已停止」。
"""
import threading

_lock = threading.Lock()
_running: set[str] = set()
_cancels: set[str] = set()


def try_acquire(key: str) -> bool:
    """key 空闲则占住并返回 True；已经在跑则返回 False（调用者应回 409）。"""
    with _lock:
        if key in _running:
            return False
        _running.add(key)
        return True


def release(key: str) -> None:
    """放掉 key。幂等——重复放不会出错。

    **顺手清掉这一轮的取消请求**：不清的话，下一次跑同一个 key 会一上来就看到上次那个
    标记，于是「刚点开始就停了」——而那个标记是上一趟留下的，早该过期了。
    """
    with _lock:
        _running.discard(key)
        _cancels.discard(key)


def running() -> list[str]:
    """当前持有的 key。给测试和健康报告看。"""
    with _lock:
        return sorted(_running)


def request_cancel(key: str) -> bool:
    """请持有 key 的那一趟停下。**返回 False = 没有人在跑这个 key**。

    返回布尔而不是静默成功：界面上「停一个已经跑完的」要如实说「没有在跑的」，
    而不是显示「已请求停止」然后什么都没有发生。
    """
    with _lock:
        if key not in _running:
            return False
        _cancels.add(key)
        return True


def cancel_requested(key: str) -> bool:
    """持有者在循环里轮询这个：True = 有人请你停。

    **没持锁时也返回 False**——一个已经放掉的 key 不该因为残留标记而被当成「要停」。
    """
    with _lock:
        return key in _cancels and key in _running
