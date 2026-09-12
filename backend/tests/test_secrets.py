"""Secrets are ciphertext at rest.

The point of the whole module: a backup zip hand-carried to another machine must
not carry working keys. These tests pin the sealing, the transparent read/write
through `prefs`, and the one-time migration of already-plaintext secrets.
"""
import json

import pytest

from app.config import settings
from app.core import secrets as s
from app.core.prefs import load_config, save_config

PLAIN = "sk-super-secret-value"

needs_dpapi = pytest.mark.skipif(not s._load(), reason="DPAPI unavailable off Windows")


def test_round_trip():
    assert s.unseal(s.seal(PLAIN)) == PLAIN


def test_plaintext_passes_through():
    # A hand-edited config.json holds plaintext; it must read back as-is.
    assert s.unseal(PLAIN) == PLAIN


def test_seal_is_idempotent():
    once = s.seal(PLAIN)
    assert s.seal(once) == once


def test_empty_stays_empty():
    assert s.seal("") == ""
    assert s.unseal("") == ""


def test_undecryptable_blob_is_empty_not_a_crash():
    # Simulates a blob from another machine/account: the secret reads as unset.
    assert s.unseal("dpapi:v1:bm90LWEtcmVhbC1ibG9i") == ""


@needs_dpapi
def test_sealed_value_differs_from_plaintext():
    assert PLAIN not in s.seal(PLAIN)


@needs_dpapi
def test_save_config_writes_ciphertext_only():
    save_config({"smtp_password": PLAIN})
    raw = settings.config_path.read_text(encoding="utf-8")
    assert PLAIN not in raw  # the key never touches the disk in the clear
    assert s.is_sealed(json.loads(raw)["smtp_password"])
    assert load_config()["smtp_password"] == PLAIN  # readers still see plaintext


@needs_dpapi
def test_migrate_config_seals_existing_plaintext():
    settings.config_path.write_text(
        json.dumps({"smtp_password": PLAIN, "rag_top_k": 7}), encoding="utf-8"
    )
    assert s.migrate_config() == 1
    raw = json.loads(settings.config_path.read_text(encoding="utf-8"))
    assert s.is_sealed(raw["smtp_password"])
    assert raw["rag_top_k"] == 7  # untouched
    assert load_config()["smtp_password"] == PLAIN
    assert s.migrate_config() == 0  # idempotent
