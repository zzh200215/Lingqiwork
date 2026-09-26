"""交付（把材料改写成能交出去的体裁）HTTP layer. Every rule lives in `app/core/deliver.py`.

照 `routers/compose.py` 的形态：`/deliver` 是 SSE（gathering → sources → writing →
report），`/deliver/save` 落 `vault/deliver/` + 进索引，另加一个只读的 `/deliver/genres`
把体裁与读者的定义交给界面（前端不硬编码）。校验必须在建流之前做完——SSE 一旦开流就没有
状态码可改了（`routers/tutor.py` 顶部记过这个坑）。

`/deliver/outline`（§8.1 双模的长稿那一模）：先出提纲、**不取材**，用户点头后才带着
`outline` 调 `/deliver` 取材成文。它是普通 JSON 端点，不是 SSE——一次短调用，没有过程
可视的必要（过程可视是成文那一步的事）。
"""

import json
import logging

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from app.core import deliver as core
from app.core import inflight
from app.core.deliver import Report, Section

router = APIRouter(prefix="/api/deliver", tags=["deliver"])
log = logging.getLogger(__name__)


class DeliverIn(BaseModel):
    topic: str
    genre: str = core.DEFAULT_GENRE
    audience: str = core.AUDIENCE_DEFAULT
    # 「加进这次产出」（§4-14）：钉进来的材料 spec（vault 路径 / repo: / dir:）
    pinned: list[str] = Field(default_factory=list)
    # §8.1：提纲确认区定稿的小节名。空 = 没走提纲（一键直出，或用户点了「直接写」）。
    outline: list[str] = Field(default_factory=list)


class OutlineIn(BaseModel):
    topic: str
    genre: str = core.DEFAULT_GENRE
    audience: str = core.AUDIENCE_DEFAULT


class TemplateIn(BaseModel):
    label: str
    prompt: str
    # 新建默认长稿：你会想存成模板的，多半是那种值得先定结构的稿子。
    long: bool = True


class TemplatePatch(BaseModel):
    label: str | None = None
    prompt: str | None = None
    long: bool | None = None


class SourceRef(BaseModel):
    n: int = 0
    kind: str = "kb"
    title: str = ""
    ref: str = ""


class SaveIn(BaseModel):
    title: str = ""
    sections: list[Section] = Field(default_factory=list)
    used: list[int] = Field(default_factory=list)
    sources: list[SourceRef] = Field(default_factory=list)
    # M5：体裁与读者**随存盘一起交上来**，落在文件头的 frontmatter 里。
    # 在这之前它们只活在预览的 payload 里，存完就丢了——「这份是给谁写的」只剩文件名。
    genre: str = ""
    audience: str = ""


def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


@router.get("/genres")
async def genres():
    """体裁（内置 + 你自己写的）与读者——唯一真值在 `core.deliver`。"""
    return await core.catalogue()


async def _check(topic: str, genre: str, audience: str) -> tuple[str, dict]:
    """建流/建调用之前的校验：话题非空 + 体裁（内置或自定义）与读者合法。返回 `(话题, 体裁定义)`。

    抽出来是因为 `/deliver`、`/deliver/outline` 的校验**必须一模一样**——两处各写一遍
    迟早会分叉，而分叉的表现是「提纲出得来、写不出来」（或反过来），很难查。

    体裁定义一并返回：路由刚刚才查过，让 `core.run` 再查一次是白花一次库往返
    （而 `run` 那边**仍然自己查**——它也能被别的入口直接调，不能靠路由替它把关）。
    """
    t = (topic or "").strip()
    if not t:
        raise HTTPException(400, "话题不能为空")

    spec = await core.genre_spec(genre)
    if spec is None:
        raise HTTPException(400, f"unknown genre '{genre}'")
    try:
        core.synth_prompt(genre, audience, custom=spec)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e

    from app.core import providers

    if not (providers.default_model_id() or ""):
        raise HTTPException(503, "没有已启用的 provider，请先在设置页配置模型")
    return t, spec


@router.post("/outline")
async def deliver_outline(body: OutlineIn):
    """先出提纲、**不取材**（§8.1 双模的长稿那一模）。确认之后才带着它调 `/deliver`。

    这里**不占 `inflight` 锁**：它是一次短调用，与正在跑的那次交付不冲突；占了锁反而会
    出现「上一次交付还在跑 → 连提纲都出不了」。成文那一步的锁照旧在 `/deliver` 上。
    """
    topic, _ = await _check(body.topic, body.genre, body.audience)
    out = await core.make_outline(topic, body.genre, body.audience)
    if out is None:
        # 502：上游（模型）没给出可用的东西——不是用户的输入有问题，所以不是 4xx
        raise HTTPException(502, "提纲没出来——默认模型不可用，或输出无法解析")
    return out


@router.post("")
async def deliver_run(body: DeliverIn):
    """One deliverable run, streamed. 校验在建流前（`_check`）。"""
    topic, _ = await _check(body.topic, body.genre, body.audience)

    if not inflight.try_acquire("deliver"):
        raise HTTPException(409, "上一次交付还在跑——等它结束再开新的")

    async def gen():
        try:
            async for event, data in core.run(
                body.genre, topic, body.audience, pinned=body.pinned, outline=body.outline
            ):
                yield _sse(event, data)
        except Exception as e:  # noqa: BLE001 - mid-stream, so report as an event
            log.exception("deliver failed")
            yield _sse("error", {"message": f"{type(e).__name__}: {e}"})
        finally:
            inflight.release("deliver")

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.post("/save")
async def save(body: SaveIn):
    """把上一次的交付落成 `vault/deliver/` 里的一篇 md 并进索引。"""
    rep = Report(title=body.title.strip(), sections=body.sections, used=body.used)
    if not rep.title and not rep.sections:
        raise HTTPException(422, "没有可保存的交付结果")
    return await core.save(
        rep,
        [s.model_dump() for s in body.sources],
        genre=body.genre,
        audience=body.audience,
    )


# ---------- 自定义体裁模板（§8.1 行2） ----------


@router.get("/templates")
async def templates():
    """你自己写的体裁模板——**带结构指令**，编辑要用（`/genres` 那份列表不带）。"""
    return await core.list_templates()


@router.post("/templates")
async def create_template(body: TemplateIn):
    """存一种新体裁。名字与内置体裁（或已有模板）重名 → 409。

    名字/结构指令不合法是 422（**你的输入有问题**），与「模型没给出东西」的 502 分开——
    界面靠状态码决定说哪句话。
    """
    try:
        return await core.create_template(body.label, body.prompt, body.long)
    except ValueError as e:
        raise HTTPException(422, str(e)) from e


@router.put("/templates/{genre_id}")
async def update_template(genre_id: str, body: TemplatePatch):
    """改一个模板。只改传进来的字段。找不到 → 404。

    **`slug` 不动**：`prompt_sha` 按体裁 id 分版本，改了它这份模板此前所有评价的版本
    key 就断了（质量闭环会把同一份模板记成两版）。所以改名随便改，id 建了就不动。
    """
    try:
        out = await core.update_template(
            genre_id, label=body.label, prompt=body.prompt, long=body.long
        )
    except ValueError as e:
        raise HTTPException(422, str(e)) from e
    if out is None:
        raise HTTPException(404, "模板不存在")
    return out


@router.delete("/templates/{genre_id}")
async def delete_template(genre_id: str):
    """删一个模板。**已经写出去的成品一份都不动**（它们在 `vault/deliver/` 里，
    文件头写的是界面名，照样读得懂）。删的只是「以后还拿它当选项吗」。"""
    if not await core.delete_template(genre_id):
        raise HTTPException(404, "模板不存在")
    return {"deleted": genre_id}


@router.get("/witness")
async def deliver_witness():
    """交付的**事后见证**（M5）：到点的一份交付，一条 + 还有几份在等着。

    与 `/api/decisions/witness` 同一个形状（只给一条，念不念、什么时候念是前端那条 nudge
    管线的事：一天一条、可关）。真值在文件系统——`vault/deliver/` 里的文件就是交出去的
    东西本身（`routers/work.py` 早就写过：「产出没有登记表，真值是文件系统」）。
    """
    from app.core import delivery

    return await delivery.witness()
