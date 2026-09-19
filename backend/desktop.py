"""Native desktop shell (ROADMAP V4.1/V4.2): pywebview windows over the local server.

Run with the backend venv:  .venv/Scripts/python.exe desktop.py
- Reuses an already-running server on 127.0.0.1:8000, otherwise starts uvicorn
  in a background thread inside this process.
- Main window = the full workbench (frontend/dist), quick-ask window = quick.html,
  selection-assistant popup = selection.html, and **零柒 = 原生分层窗**
  （`desktop_pet.py`：PIL+GDI+ 直接画，不用 WebView——pywebview 的透明窗在这台
  机器上做不出真透明，弯路记录在那个文件开头）。
- Ctrl+Alt+Q anywhere toggles the quick-ask window (Khoj Mini style).
- Ctrl+Alt+W grabs the selected text (simulated Ctrl+C + clipboard diff) and pops
  up the selection assistant (Cherry Studio 选中助手 style).
- pystray tray icon: 打开工作台 / 新对话 / 快速提问 / 显示/隐藏零柒 / 开机自启 / 退出.
- Closing a window hides it; quit lives in the tray menu.

The keyboard and pystray callbacks fire on non-main threads; every window
operation (show/hide/load_html/evaluate_js) marshals onto the GUI event loop and
is thread-safe in pywebview.
"""
import json
import sys
import threading
import time
import urllib.parse
from pathlib import Path

import webview

import desktop_pet

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
HOST, DEFAULT_PORT = "127.0.0.1", 8000
URL = f"http://{HOST}:{DEFAULT_PORT}"  # rewritten by _start_server if 8000 is taken

quitting = threading.Event()

main_window: webview.Window | None = None
quick_window: webview.Window | None = None
selection_window: webview.Window | None = None
quick_shown = threading.Event()
selection_shown = threading.Event()

PET_POS_FILE = DATA_DIR / "pet_window.json"
AUTOSTART_KEY = r"Software\Microsoft\Windows\CurrentVersion\Run"
AUTOSTART_NAME = "WBWorkbench"
AUTOSTART_KEY = r"Software\Microsoft\Windows\CurrentVersion\Run"
AUTOSTART_NAME = "WBWorkbench"


def _health_ok(p: int) -> bool:
    """True only if *our* app answers on that port (another service may squat it)."""
    import json
    import urllib.request

    try:
        with urllib.request.urlopen(f"http://{HOST}:{p}/api/health", timeout=1) as r:
            return json.loads(r.read() or b"{}").get("ok") is True
    except Exception:  # noqa: BLE001
        return False


def _port_free(p: int) -> bool:
    import socket

    with socket.socket() as s:
        try:
            s.bind((HOST, p))
            return True
        except OSError:
            return False


def _start_server() -> None:
    global URL

    if _health_ok(DEFAULT_PORT):
        return  # our server is already up — reuse it
    # 8000 may be held by something else entirely (Docker Desktop binds it)
    chosen = next((p for p in (DEFAULT_PORT, *range(8010, 8030)) if _port_free(p)), None)
    if chosen is None:
        print("[desktop] no free port in 8000/8010-8029", flush=True)
        return
    URL = f"http://{HOST}:{chosen}"
    print(f"[desktop] starting server on {URL}", flush=True)

    import uvicorn

    server = uvicorn.Server(uvicorn.Config("app.main:app", host=HOST, port=chosen, log_level="info"))
    threading.Thread(target=server.run, daemon=True).start()
    for _ in range(150):  # up to ~15s for model warmup
        if _health_ok(chosen) or quitting.is_set():
            return
        time.sleep(0.1)


# --- window actions (called from hotkey / tray threads) -----------------------

def show_main(_icon=None, _item=None) -> None:
    if main_window:
        main_window.show()
        main_window.restore()


def new_conversation(_icon=None, _item=None) -> None:
    if main_window:
        main_window.show()
        main_window.restore()
        main_window.evaluate_js("window.dispatchEvent(new CustomEvent('workbench:new-chat'))")


def reset_quick() -> None:
    """Refocus the input each time the quick window pops up."""
    if quick_window:
        quick_window.evaluate_js("window.dispatchEvent(new Event('workbench:quick-reset'))")


def toggle_quick(_icon=None, _item=None) -> None:
    if quick_window is None:
        return
    if quick_shown.is_set():
        quick_window.hide()
        quick_shown.clear()
    else:
        quick_window.show()
        quick_shown.set()
        reset_quick()


def quit_app(icon=None, _item=None) -> None:
    quitting.set()
    try:
        if icon:
            icon.stop()
    except Exception:  # noqa: BLE001
        pass
    for w in (main_window, quick_window, selection_window):
        if w:
            try:
                w.destroy()
            except Exception:  # noqa: BLE001
                pass
    desktop_pet.shutdown()


class QuickApi:
    """Exposed to quick.html as window.pywebview.api."""

    def hide_quick(self) -> None:
        if quick_window:
            quick_window.hide()
            quick_shown.clear()

    def open_main(self) -> None:
        show_main()


class SelectionApi:
    """Exposed to selection.html as window.pywebview.api."""

    def hide_selection(self) -> None:
        if selection_window:
            selection_window.hide()
            selection_shown.clear()

    def open_tutor(self, session_id: int) -> None:
        """划词助手的「教学」动作：前端先用 /api/tutor/start 建好会话，
        这里收尾——收起弹窗，主窗口深链直接打开那次会话。"""
        self.hide_selection()
        if main_window:
            main_window.load_url(f"{URL}/tutor?session={session_id}")
            main_window.show()
            main_window.restore()


# --- 零柒的桌面小窗（desktop_pet.py：原生分层窗）---------------------------------
#
# 窗体本体在 desktop_pet.py（PIL 装帧 + GDI+ 画气泡 + TransparencyKey 抠底）。
# 这里只留壳层面的三件小事：默认落点、托盘开关、GUI 线程上的启动钩子。


def _screen_size() -> tuple[int, int]:
    try:
        import ctypes

        u = ctypes.windll.user32
        return int(u.GetSystemMetrics(0)), int(u.GetSystemMetrics(1))
    except Exception:  # noqa: BLE001
        return 1920, 1080


def _pet_home() -> tuple[int, int]:
    """零柒该待的位置：存过就开在原地（夹回主屏可见范围），没存过开在右下角。"""
    pos = desktop_pet._load_pos()
    if pos is None:
        pos = (0, 0)
    sw, sh = _screen_size()
    x = max(0, min(pos[0], sw - desktop_pet.PET_W - 20))
    y = max(0, min(pos[1], sh - desktop_pet.PET_H - 40))
    if pos == (0, 0):
        x, y = sw - desktop_pet.PET_W - 20, sh - desktop_pet.PET_H - 40
    return x, y


def toggle_pet(_icon=None, _item=None) -> None:
    desktop_pet.toggle()


def _boot_pet(_window=None) -> None:
    """main_window.events.shown 回调：建零柒的分层窗 + 起数据轮询。
    位置记忆在 desktop_pet 内部落盘（data/pet_window.json），这里只算默认落点。

    ⚠️ shown 的回调并不在 GUI 线程上（pywebview 从内部线程 raise）——WinForms
    控件在后台线程上创建，连 `Text = ...` 都会 NRE（真机撞的）。借主窗体的
    `Invoke` 把创建调度回 GUI 线程；那个线程的消息泵是主循环，表单的事件、
    定时器全都活着。"""
    try:
        from System import Func, Type  # noqa: PLC0415

        from webview.platforms.winforms import BrowserView  # noqa: PLC0415

        inst = next(iter(BrowserView.instances.values()), None)
        if inst is None:
            print("[desktop] pet boot skipped: no gui form", flush=True)
            return

        def _create() -> None:
            desktop_pet.boot(URL, _pet_home(), show_main)

        if inst.InvokeRequired:
            inst.Invoke(Func[Type](_create))
        else:
            _create()
    except Exception as e:  # noqa: BLE001
        print(f"[desktop] pet boot failed: {e}", flush=True)


def _autostart_command() -> str:
    # pythonw 不带控制台窗口——开机自启要是先弹一个黑框，那不像陪伴像入侵
    py = Path(sys.executable).with_name("pythonw.exe")
    if not py.exists():
        py = Path(sys.executable)
    return f'"{py}" "{BASE_DIR / "desktop.py"}"'


def autostart_enabled() -> bool:
    try:
        import winreg

        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, AUTOSTART_KEY) as k:
            winreg.QueryValueEx(k, AUTOSTART_NAME)
            return True
    except OSError:
        return False


def toggle_autostart(_icon=None, _item=None) -> None:
    import winreg

    with winreg.CreateKey(winreg.HKEY_CURRENT_USER, AUTOSTART_KEY) as k:
        if autostart_enabled():
            winreg.DeleteValue(k, AUTOSTART_NAME)
        else:
            winreg.SetValueEx(k, AUTOSTART_NAME, 0, winreg.REG_SZ, _autostart_command())
        print(f"[desktop] autostart -> {autostart_enabled()}", flush=True)


# --- tray --------------------------------------------------------------------

def _make_tray():
    import pystray
    from PIL import Image, ImageDraw

    img = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.ellipse((4, 4, 60, 60), fill=(139, 92, 246, 255))  # violet-500
    d.ellipse((24, 24, 40, 40), fill=(250, 250, 250, 255))

    menu = pystray.Menu(
        pystray.MenuItem("打开工作台", show_main, default=True),
        pystray.MenuItem("新对话", new_conversation),
        pystray.MenuItem("快速提问 (Ctrl+Alt+Q)", toggle_quick),
        pystray.MenuItem("显示/隐藏零柒", toggle_pet, checked=lambda item: desktop_pet.shown.is_set()),
        pystray.MenuItem("开机自启", toggle_autostart, checked=lambda item: autostart_enabled()),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem("退出", quit_app),
    )
    return pystray.Icon("workbench", img, "AI 工作台", menu)


def _hotkey_loop() -> None:
    try:
        import keyboard

        keyboard.add_hotkey("ctrl+alt+q", toggle_quick)
        keyboard.add_hotkey("ctrl+alt+w", on_selection_hotkey)
        print(
            "[desktop] hotkeys ready: ctrl+alt+q 快速提问 / ctrl+alt+w 划词助手",
            flush=True,
        )
    except Exception as e:  # noqa: BLE001
        print(f"[desktop] global hotkey unavailable: {e}", flush=True)
        return
    while not quitting.is_set():
        time.sleep(0.2)


def _on_main_closing() -> bool:
    """Return True to allow the close, False to cancel it (we hide instead)."""
    if main_window:
        main_window.hide()
    return False


def _on_quick_closing() -> bool:
    if quick_window:
        quick_window.hide()
    quick_shown.clear()
    return False


def _on_selection_closing() -> bool:
    if selection_window:
        selection_window.hide()
    selection_shown.clear()
    return False


# --- selection capture (Ctrl+Alt+W) -------------------------------------------

def _read_clipboard() -> str:
    import pyperclip

    try:
        return pyperclip.paste() or ""
    except Exception:  # noqa: BLE001 - non-text clipboard content
        return ""


def _capture_worker() -> None:
    """Grab the currently selected text and open the assistant popup.

    Wait for the hotkey modifiers to be released (so our simulated Ctrl+C
    doesn't collide with still-held Alt), snapshot the clipboard, send Ctrl+C,
    then diff. The popup opens either way: with the captured selection, with
    whatever text the clipboard already held, or empty so the user can paste
    manually (some apps refuse synthetic Ctrl+C).
    """
    import keyboard

    try:
        # let go of ctrl/alt first — SendInput Ctrl+C with Alt held sends
        # Alt+C to the target app instead
        for _ in range(50):
            if not keyboard.is_pressed("ctrl") and not keyboard.is_pressed("alt"):
                break
            time.sleep(0.02)
        time.sleep(0.05)

        before = _read_clipboard()
        keyboard.send("ctrl+c")  # keyboard 0.13 has no `pressed` context manager
        time.sleep(0.3)  # target app copies asynchronously

        after = _read_clipboard()
        captured = after if after and after != before else ""
        if captured and before:
            # don't silently trash the user's clipboard; the popup's 复制 button
            # is what should put content there. Only text clipboards can be
            # restored — if `before` was empty/non-text we leave the selection.
            try:
                import pyperclip

                pyperclip.copy(before)
            except Exception:  # noqa: BLE001
                pass
        # fall back to existing clipboard text so the hotkey is never a dead end
        text = captured or before
        source = "selection" if captured else ("clipboard" if before else "empty")
        print(
            f"[desktop] selection hotkey: source={source} chars={len(text)}",
            flush=True,
        )
        _show_selection(text)
    except Exception as e:  # noqa: BLE001
        print(f"[desktop] selection capture failed: {type(e).__name__}: {e}", flush=True)


def _show_selection(text: str) -> None:
    if selection_window is None:
        return
    sel_url = f"{URL}/selection.html#t={urllib.parse.quote(text, safe='')}"
    selection_window.load_url(sel_url)
    selection_window.show()  # harmless if already visible
    selection_shown.set()


def on_selection_hotkey() -> None:
    print("[desktop] ctrl+alt+w fired", flush=True)
    threading.Thread(target=_capture_worker, daemon=True).start()


def main() -> None:
    global main_window, quick_window, selection_window

    t = threading.Thread(target=_start_server, daemon=True)
    t.start()
    t.join()

    main_window = webview.create_window(
        "AI 工作台",
        URL,
        width=1280,
        height=860,
        min_size=(900, 600),
        background_color="#09090b",
    )
    quick_window = webview.create_window(
        "快速提问",
        f"{URL}/quick.html",
        width=640,
        height=420,
        hidden=True,
        resizable=False,
        on_top=True,
        js_api=QuickApi(),
    )
    selection_window = webview.create_window(
        "划词助手",
        f"{URL}/selection.html",
        width=460,
        height=520,
        hidden=True,
        resizable=True,
        on_top=True,
        js_api=SelectionApi(),
    )
    # X button hides to tray instead of destroying (quit lives in the tray)
    main_window.events.closing += _on_main_closing
    quick_window.events.closing += _on_quick_closing
    selection_window.events.closing += _on_selection_closing
    # 零柒：原生分层窗（desktop_pet.py）。挂在主窗的 shown 钩子上建——
    # 那个回调在 GUI 线程上跑，表单的消息泵就是主循环（winforms.py 同一线程）。
    main_window.events.shown += _boot_pet
    # NOTE: don't wire events.shown to the visibility flags — pywebview fires
    # `shown` even for windows created with hidden=True, which would make the
    # first hotkey press think the window is already up and hide it instead.

    threading.Thread(target=_hotkey_loop, daemon=True).start()
    try:
        icon = _make_tray()
        threading.Thread(target=icon.run, daemon=True).start()
    except Exception as e:  # noqa: BLE001
        print(f"[desktop] tray unavailable: {e}", flush=True)

    webview.start()
    quitting.set()


if __name__ == "__main__":
    main()
