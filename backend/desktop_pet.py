"""零柒的桌面小窗（native）：一只 WinForms 分层窗，GDI+ 直接画精灵和台词。

为什么不用 WebView 渲染（P5 走过的弯路，写在这里防止再走一遍）：
- pywebview 6.2.1 的 transparent=True：WebView2 的透明像素透出的是**表单**的
  底色（#F0F0F0），不是桌面——用户看到的就是一块灰板；
- 给表单打 LAYERED + LWA_COLORKEY 抠掉那块灰：色键生效了，但 WebView2 的
  子窗口内容和分层窗天然不兼容，**精灵也一起消失**（官方文档级限制）。
所以这只窗子是原生的：PIL 读 `frontend/public/pet/*.webp` 的帧、按当前动作
播帧、GDI+ 画气泡；表单用 TransparencyKey 抠底（色键区域的点击自动穿透到
桌面，不需要额外的穿透 worker）。数据与网页挂件同一条管道
（/api/pet/state + /api/pet/feed，X-WB-Token 读 `data/api_token`）。

线程模型：表单在 pywebview 的 GUI 线程上创建（`main_window.events.shown`
回调里），事件走主消息泵；HTTP 轮询在普通 daemon 线程，只写 `shared` 字典；
WinForms.Timer 每 60ms 读 `shared` 重画。GUI 线程上不做任何网络 IO。
"""
import io
import json
import threading
import time
import urllib.request
from pathlib import Path

from PIL import Image, ImageChops

BASE_DIR = Path(__file__).resolve().parent
REPO_ROOT = BASE_DIR.parent  # desktop.py 在 backend/ 下；素材与数据都在仓库根
DATA_DIR = REPO_ROOT / "data"
ASSET_DIR = REPO_ROOT / "frontend" / "public" / "pet"
PET_POS_FILE = DATA_DIR / "pet_window.json"
PET_W, PET_H = 260, 360
SPRITE_SIZE = 96

# 动作清单与 pet_state.ACTIONS / petFace.ts 是同一份的三侧（改一处同步三处）。
ACTIONS = (
    "idle",
    "waving",
    "jumping",
    "failed",
    "waiting",
    "running",
    "running-right",
    "running-left",
    "review",
)

quitting = threading.Event()
shown = threading.Event()
dragging = threading.Event()

form = None  # PetForm，GUI 线程创建
shared = {
    "action": "idle",
    "line": "",
    "dimmed": False,
    "flash": None,  # (action, until_ts)
    "bubble": None,  # (text, until_ts)
    "returning_said": False,
}

# ---------- 纯函数（可离线单测） ----------


def wrap_line(text: str, width: int = 14, max_lines: int = 4) -> list[str]:
    """台词按宽度断行（气泡一行摆不下）。CJK 按字断，不做断词。"""
    t = (text or "").strip()
    if not t:
        return []
    lines: list[str] = []
    while t and len(lines) < max_lines:
        lines.append(t[:width])
        t = t[width:]
    if t:
        lines[-1] = lines[-1][:-1] + "…"
    return lines


def pick_action(now: float, flash, state_action: str) -> str:
    """此刻播哪个动作：一次性反应盖过状态机（与挂件的 flash 同一套语义）。"""
    if flash and now < flash[1]:
        return flash[0] if flash[0] in ACTIONS else "idle"
    return state_action if state_action in ACTIONS else "idle"


def should_say(line: str, mode: str, said: bool) -> bool:
    """空台词不说；久别重逢每次进程只说一遍（不落账，见 pet_state._away）。"""
    if not (line or "").strip():
        return False
    if mode == "returning":
        return not said
    return False


# ---------- 素材装载 ----------

_frames: dict[str, list] = {}  # action -> [System.Drawing.Bitmap]
_durations: dict[str, list[int]] = {}
_streams: list = []  # Bitmap(Stream) 要求流活到位图销毁——这里钉住防止 GC


def _harden(frame: Image.Image) -> Image.Image:
    """帧的透明通道二值化：像素画边缘不允许半透明，否则色键底色会从
    软边里渗出来（精灵边缘挂一圈灰）。"""
    a = frame.getchannel("A").point(lambda v: 255 if v >= 128 else 0)
    return frame.putalpha(a) or frame


def load_sprites() -> None:
    """所有动作的全部帧 → System.Drawing.Bitmap（一次性，GUI 线程跑）。

    帧不是正方形（384×416）：先按短边适配缩放进 SPRITE_SIZE 的透明画布、
    居中贴好（等比，绝不拉伸），再做透明通道二值化。
    """
    from System.Drawing import Bitmap
    from System.IO import MemoryStream

    for action in ACTIONS:
        path = ASSET_DIR / f"{action}.webp"
        if not path.is_file():
            continue
        try:
            im = Image.open(path)
        except Exception:  # noqa: BLE001 - 缺帧就缺，不该拖垮壳
            continue
        n = getattr(im, "n_frames", 1)
        frames: list = []
        durs: list[int] = []
        for i in range(n):
            im.seek(i)
            frame = im.convert("RGBA")
            sw, sh = frame.size
            scale = min(SPRITE_SIZE / sw, SPRITE_SIZE / sh)
            nw, nh = max(1, round(sw * scale)), max(1, round(sh * scale))
            frame = frame.resize((nw, nh), Image.LANCZOS)
            canvas = Image.new("RGBA", (SPRITE_SIZE, SPRITE_SIZE), (0, 0, 0, 0))
            canvas.paste(frame, ((SPRITE_SIZE - nw) // 2, (SPRITE_SIZE - nh) // 2), frame)
            canvas = _harden(canvas)
            buf = io.BytesIO()
            canvas.save(buf, "PNG")
            ms = MemoryStream(buf.getvalue())
            _streams.append(ms)
            frames.append(Bitmap(ms))
            durs.append(int(im.info.get("duration") or 80))
        _frames[action] = frames
        _durations[action] = durs
    total = sum(len(v) for v in _frames.values())
    print(f"[desktop] sprites loaded: {total} frames across {len(_frames)} actions", flush=True)


def _bitmap_for(action: str, frame_idx: int):
    frames = _frames.get(action) or _frames.get("idle") or []
    if not frames:
        return None
    return frames[frame_idx % len(frames)]


# ---------- HTTP（daemon 线程专用，GUI 线程绝不碰） ----------


def _token() -> str:
    try:
        return (DATA_DIR / "api_token").read_text(encoding="utf-8").strip()
    except OSError:
        return ""


def _get(url: str):
    req = urllib.request.Request(url, headers={"X-WB-Token": _token()})
    with urllib.request.urlopen(req, timeout=3) as r:
        return json.loads(r.read() or b"{}")


def _poll_loop(url: str) -> None:
    """每几秒拉一次「此刻」与「新台词」，只写 shared，不碰任何控件。"""
    last_id = 0
    next_state = 0.0
    while not quitting.is_set():
        now = time.time()
        if now >= next_state:
            next_state = now + 10
            try:
                st = _get(f"{url}/api/pet/state?path=/pet-overlay")
                shared["action"] = str(st.get("action") or "idle")
                shared["line"] = str(st.get("line") or "")
                shared["dimmed"] = st.get("mode") in ("idling", "resting")
                if should_say(
                    str(st.get("line") or ""),
                    str(st.get("mode") or ""),
                    bool(shared["returning_said"]),
                ):
                    shared["returning_said"] = True
                    shared["bubble"] = (shared["line"], now + 8)
            except Exception:  # noqa: BLE001 - 拿不到就沿用上一次
                pass
        try:
            feed = _get(f"{url}/api/pet/feed?since_id={last_id}&limit=5")
            for e in reversed(feed.get("events") or []):
                last_id = max(last_id, int(e.get("id") or 0))
                text = str(e.get("text") or "").strip()
                if not text:
                    continue
                shared["bubble"] = (text, now + 8)
                shared["flash"] = (
                    ("failed" if e.get("kind") == "task_failed" else "waving"),
                    now + 3,
                )
        except Exception:  # noqa: BLE001
            pass
        time.sleep(4)


# ---------- 表单 ----------


def create_form(home, on_open_main) -> None:
    """在 **GUI 线程**上调用（main_window.events.shown 回调里）。"""
    global form
    import System.Drawing as D
    import System.Windows.Forms as W

    class PetForm(W.Form):
        def __init__(self):
            super().__init__()  # 先构造 CLR 基类——不调它，第一个属性赋值就 NRE
            self.Text = "零柒"
            # `None` 是 Python 关键字，这个枚举值只能用 getattr 取
            self.FormBorderStyle = getattr(W.FormBorderStyle, "None")
            self.StartPosition = W.FormStartPosition.Manual
            self.TopMost = True
            self.ShowInTaskbar = False
            self.Size = D.Size(PET_W, PET_H)
            self.Location = D.Point(*home)
            key = D.Color.FromArgb(240, 240, 240)
            self.BackColor = key
            self.TransparencyKey = key  # 色键抠底：同色像素透出桌面 + 点击穿透
            self.DoubleBuffered = True
            self.MouseDown += self._on_down
            self.MouseMove += self._on_move
            self.MouseUp += self._on_up
            self.MouseDoubleClick += self._on_dbl
            self.Paint += self._on_paint  # 事件而非 OnPaint 重写：pythonnet 不派发保护虚方法
            self._down_at = None
            self._moved = False
            self._frame_pos = 0.0
            self._last_tick = time.time()
            self._timer = W.Timer()
            self._timer.Interval = 60
            self._timer.Tick += self._tick
            self._timer.Start()

        def _tick(self, _sender, _args) -> None:
            now = time.time()
            self._frame_pos += (now - self._last_tick) * 1000
            self._last_tick = now
            self.Invalidate()

        def _on_paint(self, _sender, e) -> None:
            if not getattr(self, "_painted_once", False):
                self._painted_once = True
                print("[desktop] pet first paint", flush=True)
            g = e.Graphics
            try:
                g.SmoothingMode = D.Drawing2D.SmoothingMode.AntiAlias
                now = time.time()
                action = pick_action(now, shared.get("flash"), shared.get("action") or "idle")
                bmp = _bitmap_for(action, int(self._frame_pos / 80))
                if bmp is not None:
                    dim = shared.get("dimmed")
                    if dim:
                        # 「你人不在」→ 只把精灵降饱和（陪伴不是管教）
                        g.DrawImage(bmp, D.Rectangle((PET_W - SPRITE_SIZE) // 2, PET_H - SPRITE_SIZE - 6, SPRITE_SIZE, SPRITE_SIZE), 0, 0, SPRITE_SIZE, SPRITE_SIZE, D.GraphicsUnit.Pixel, _dim_attrs())
                    else:
                        g.DrawImage(bmp, (PET_W - SPRITE_SIZE) // 2, PET_H - SPRITE_SIZE - 6)
                bub = shared.get("bubble")
                if bub and now < bub[1]:
                    _draw_bubble(g, str(bub[0]), PET_W)
            except Exception:
                import traceback

                if not getattr(self, "_paint_err_logged", False):
                    self._paint_err_logged = True
                    traceback.print_exc()

        def _on_down(self, _sender, e) -> None:
            if e.Button == W.MouseButtons.Left:
                self._down_at = (e.X, e.Y)
                self._moved = False

        def _on_move(self, _sender, e) -> None:
            if self._down_at is None:
                return
            dx = e.X - self._down_at[0]
            dy = e.Y - self._down_at[1]
            if not self._moved and dx * dx + dy * dy < 36:
                return
            self._moved = True
            dragging.set()
            self.Location = D.Point(
                self.Location.X + dx, self.Location.Y + dy
            )

        def _on_up(self, _sender, e) -> None:
            if self._down_at is None:
                return
            self._down_at = None
            dragging.clear()
            if self._moved:
                _save_pos(self.Location.X, self.Location.Y)
                return
            # 点一下：Q 弹（跳一下）
            shared["flash"] = ("jumping", time.time() + 1.2)
            play_blip()

        def _on_dbl(self, _sender, _args) -> None:
            on_open_main()

        def OnFormClosing(self, e) -> None:
            # Alt+F4 只是藏回托盘；退出在托盘菜单里（desktop.quit_app）
            if not quitting.is_set():
                e.Cancel = True
                self.Hide()
                shown.clear()

    form = PetForm()
    form.Show()
    shown.set()


# ---------- 气泡 / 音效 / 位置 ----------


def _dim_attrs():
    import System.Drawing as D

    cm = D.Imaging.ColorMatrix(
        [
            [0.299, 0.299, 0.299, 0.0],
            [0.587, 0.587, 0.587, 0.0],
            [0.114, 0.114, 0.114, 0.0],
            [0.0, 0.0, 0.0, 1.0],
        ]
    )
    attrs = D.Imaging.ImageAttributes()
    attrs.SetColorMatrix(cm)
    return attrs


def _draw_bubble(g, text: str, win_w: int) -> None:
    import System.Drawing as D

    lines = wrap_line(text)
    if not lines:
        return
    font = D.Font("Microsoft YaHei UI", 11)
    line_h = int(font.GetHeight(g)) + 2
    w = max(int(font.GetHeight(g)) * 0 + _text_width(g, font, ln) for ln in lines) + 16
    w = min(max(w, 60), win_w - 12)
    h = line_h * len(lines) + 12
    x = (win_w - w) // 2
    y = PET_H - SPRITE_SIZE - 6 - h - 8
    path = D.Drawing2D.GraphicsPath()
    r = 10
    path.AddArc(x, y, 2 * r, 2 * r, 180, 90)
    path.AddArc(x + w - 2 * r, y, 2 * r, 2 * r, 270, 90)
    path.AddArc(x + w - 2 * r, y + h - 2 * r, 2 * r, 2 * r, 0, 90)
    path.AddArc(x, y + h - 2 * r, 2 * r, 2 * r, 90, 90)
    path.CloseFigure()
    g.FillPath(D.SolidBrush(D.Color.White), path)
    g.DrawPath(D.Pen(D.Color.FromArgb(229, 229, 229)), path)
    tw = D.StringFormat()
    ty = y + 5
    for ln in lines:
        g.DrawString(ln, font, D.SolidBrush(D.Color.FromArgb(38, 38, 38)), x + 8, ty)
        ty += line_h


def _text_width(g, font, text: str) -> int:
    # 两参重载；带 PointF 的三参版本 pythonnet 匹配不上（真机撞过）
    return int(g.MeasureString(text, font).Width)


def play_blip() -> None:
    """摸它一下的一声「啵」：现场合成 0.12s 的正弦滑音（winsound 走内存 wav，
    与挂件那份 WebAudio 音色一致、零素材）。"""
    import math
    import struct
    import wave
    import winsound

    try:
        rate = 22050
        n = int(rate * 0.12)
        frames = b"".join(
            struct.pack(
                "<h",
                int(
                    9000
                    * math.sin(2 * math.pi * (520 + (780 - 520) * (i / n)) * i / rate)
                    * math.exp(-3 * i / n)
                ),
            )
            for i in range(n)
        )
        buf = io.BytesIO()
        with wave.open(buf, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(rate)
            w.writeframes(frames)
        winsound.PlaySound(buf.getvalue(), winsound.SND_MEMORY | winsound.SND_ASYNC)
    except Exception:  # noqa: BLE001 - 没声就不出声
        pass


def _load_pos() -> tuple[int, int] | None:
    try:
        d = json.loads(PET_POS_FILE.read_text(encoding="utf-8"))
        if isinstance(d, dict) and isinstance(d.get("x"), int) and isinstance(d.get("y"), int):
            return int(d["x"]), int(d["y"])
    except Exception:  # noqa: BLE001
        pass
    return None


def _save_pos(x: int, y: int) -> None:
    try:
        PET_POS_FILE.write_text(json.dumps({"x": int(x), "y": int(y)}), encoding="utf-8")
    except Exception:  # noqa: BLE001
        pass  # 记不了位置就每次开在默认角落


# ---------- 生命周期（desktop.py 调） ----------


def boot(url: str, home, on_open_main) -> None:
    """GUI 线程回调里调：装载素材 + 建表单 + 起轮询线程。全部 best-effort——
    桌宠起不来不该拖垮整个壳。"""
    try:
        load_sprites()
    except Exception as e:  # noqa: BLE001
        print(f"[desktop] pet sprites failed: {e}", flush=True)
        return
    try:
        create_form(home, on_open_main)
        threading.Thread(target=_poll_loop, args=(url,), daemon=True).start()
        print("[desktop] pet window ready", flush=True)
    except Exception as e:  # noqa: BLE001
        import traceback

        print(f"[desktop] pet window failed: {e}", flush=True)
        traceback.print_exc()
        traceback.print_stack()


def toggle() -> None:
    if form is None:
        return
    if shown.is_set():
        form.Hide()
        shown.clear()
    else:
        form.Show()
        shown.set()


def shutdown() -> None:
    quitting.set()
    if form is not None:
        try:
            form.Close()
        except Exception:  # noqa: BLE001
            pass
