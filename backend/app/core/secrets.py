"""Seal secrets at rest with Windows DPAPI, so a copied file is worthless.

`data/config.json` and the SQLite `provider_configs.api_key` column used to hold
API keys and mail/KG passwords in plaintext — and `core/backup.py` archives both,
so a backup zip hand-carried off the machine carried the whole keyring with it.
Sealing at rest fixes that at the root: the archive still contains the files, but
what is inside them is a DPAPI blob bound to this Windows user, undecryptable
anywhere else.

Format: ``dpapi:v1:<base64>``. Anything without that prefix is treated as
plaintext and passed through unchanged — that is what lets you hand-edit
config.json, and what makes the one-time migration a lazy no-op once everything
is sealed.

Cross-machine restore is the point, not a bug: a backup restored under a
different user or machine reports the secret as *unset* (with a warning) rather
than failing to start, so you re-enter the key once instead of the app dying.

No third-party dependency — DPAPI is reached through ``ctypes``.
"""
import base64
import ctypes
import json
import logging

from app.config import settings

log = logging.getLogger(__name__)

_PREFIX = "dpapi:v1:"
# A fixed app-specific entropy, so another program on the same account cannot
# unprotect our blobs merely by calling CryptUnprotectData on them.
_ENTROPY = b"workbench-v1"
_UI_FORBIDDEN = 0x1

# `config.json` keys that hold a secret. Defined here (not in prefs) so prefs can
# import it without a cycle.
SECRET_KEYS = ("websearch_api_key", "smtp_password", "kg_password")

_crypt32 = None
_kernel32 = None
_ready: bool | None = None


class _DataBlob(ctypes.Structure):
    _fields_ = [("cbData", ctypes.c_uint32), ("pbData", ctypes.c_void_p)]


def _load() -> bool:
    """Resolve crypt32/kernel32 once. False (with one warning) off Windows."""
    global _crypt32, _kernel32, _ready
    if _ready is not None:
        return _ready
    try:
        from ctypes import WinDLL  # noqa: PLC0415 - Windows-only import by design

        _crypt32 = WinDLL("crypt32", use_last_error=True)
        _kernel32 = WinDLL("kernel32", use_last_error=True)
        # Without argtypes, LocalFree receives the blob pointer as a Python int
        # and overflows on 64-bit when the pointer exceeds 2**31.
        _kernel32.LocalFree.argtypes = [ctypes.c_void_p]
        _kernel32.LocalFree.restype = ctypes.c_void_p
        _crypt32.CryptProtectData.restype = ctypes.c_bool
        _crypt32.CryptUnprotectData.restype = ctypes.c_bool
        _ready = True
    except (ImportError, AttributeError, OSError) as e:  # noqa: BLE001
        log.warning("DPAPI unavailable (%s) — secrets stay in plaintext", e)
        _ready = False
    return _ready


def _blob(data: bytes) -> tuple[_DataBlob, ctypes.Array]:
    """(blob, buffer) — the caller must keep the buffer alive for the call."""
    buf = ctypes.create_string_buffer(data, len(data))
    return _DataBlob(len(data), ctypes.cast(buf, ctypes.c_void_p)), buf


def _protect(data: bytes) -> bytes:
    in_blob, in_buf = _blob(data)
    ent_blob, ent_buf = _blob(_ENTROPY)
    out = _DataBlob()
    ok = _crypt32.CryptProtectData(
        ctypes.byref(in_blob), None, ctypes.byref(ent_blob), None, None, _UI_FORBIDDEN,
        ctypes.byref(out),
    )
    _ = (in_buf, ent_buf)  # keep the source buffers referenced across the call
    if not ok:
        raise OSError(f"CryptProtectData failed (winerror {ctypes.get_last_error()})")
    try:
        return ctypes.string_at(out.pbData, out.cbData)
    finally:
        _kernel32.LocalFree(out.pbData)


def _unprotect(data: bytes) -> bytes:
    in_blob, in_buf = _blob(data)
    ent_blob, ent_buf = _blob(_ENTROPY)
    out = _DataBlob()
    descr = ctypes.c_void_p()
    ok = _crypt32.CryptUnprotectData(
        ctypes.byref(in_blob), ctypes.byref(descr), ctypes.byref(ent_blob), None, None,
        _UI_FORBIDDEN, ctypes.byref(out),
    )
    _ = (in_buf, ent_buf)
    if not ok:
        raise OSError(f"CryptUnprotectData failed (winerror {ctypes.get_last_error()})")
    try:
        return ctypes.string_at(out.pbData, out.cbData)
    finally:
        _kernel32.LocalFree(out.pbData)
        if descr:
            _kernel32.LocalFree(descr)


def is_sealed(value: str) -> bool:
    return bool(value) and value.startswith(_PREFIX)


def seal(value: str) -> str:
    """Encrypt for this user/machine. Empty and already-sealed values are
    returned untouched, so this is safe to call on every write."""
    if not value or is_sealed(value):
        return value
    if not _load():
        return value
    try:
        return _PREFIX + base64.b64encode(_protect(value.encode("utf-8"))).decode("ascii")
    except (OSError, ValueError) as e:  # noqa: BLE001
        log.warning("could not seal a secret (%s) — left in plaintext", e)
        return value


def unseal(value: str) -> str:
    """Decrypt a sealed value; pass plaintext through; empty string on failure."""
    if not value:
        return ""
    if not is_sealed(value):
        return value
    if not _load():
        return ""
    try:
        payload = base64.b64decode(value[len(_PREFIX):], validate=True)
        return _unprotect(payload).decode("utf-8")
    except (OSError, ValueError) as e:  # noqa: BLE001
        log.warning("could not unseal a secret (%s) — likely from a different machine/account", e)
        return ""


def migrate_config() -> int:
    """Seal any plaintext secret still sitting in config.json. Idempotent.

    Reads the raw file rather than `prefs.load_config()`, which would unseal the
    very values we are here to seal.
    """
    path = settings.config_path
    if not path.exists():
        return 0
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return 0
    changed = 0
    for key in SECRET_KEYS:
        value = data.get(key)
        if isinstance(value, str) and value and not is_sealed(value):
            data[key] = seal(value)
            changed += 1
    if changed:
        path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        log.info("sealed %d plaintext secret(s) in config.json", changed)
    return changed


async def migrate_providers(db) -> int:
    """Seal plaintext `api_key` values already in the DB. Idempotent.

    Best-effort: a machine without DPAPI leaves rows alone rather than failing
    startup.
    """
    if not _load():
        return 0
    from sqlalchemy import select  # noqa: PLC0415

    from app.models import ProviderConfig  # noqa: PLC0415

    rows = (await db.execute(select(ProviderConfig))).scalars().all()
    changed = 0
    for row in rows:
        raw = row.api_key_enc
        if raw and not is_sealed(raw):
            row.api_key_enc = seal(raw)
            changed += 1
    if changed:
        await db.commit()
        log.info("sealed %d plaintext provider api_key(s)", changed)
    return changed
