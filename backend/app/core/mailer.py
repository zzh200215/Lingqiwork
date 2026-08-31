"""Outbound e-mail over SMTP (ROADMAP V5.2).

stdlib only — no vendor SDK. Credentials live in data/config.json next to the
provider keys; the settings API masks the password on read like it does for
api_key.
"""
import logging
import smtplib
from email.message import EmailMessage

from app.core.prefs import load_config

log = logging.getLogger(__name__)

TIMEOUT = 30


def config() -> dict:
    cfg = load_config()
    return {
        "host": (cfg.get("smtp_host") or "").strip(),
        "port": int(cfg.get("smtp_port") or 587),
        "user": (cfg.get("smtp_user") or "").strip(),
        "password": cfg.get("smtp_password") or "",
        "sender": (cfg.get("smtp_from") or cfg.get("smtp_user") or "").strip(),
        "to": (cfg.get("smtp_to") or "").strip(),
        "tls": bool(cfg.get("smtp_tls", True)),
    }


def send(subject: str, body: str, to: str | None = None) -> dict:
    """Send one plain-text mail. Raises ValueError when not configured."""
    c = config()
    recipients = [a.strip() for a in (to or c["to"]).split(",") if a.strip()]
    if not c["host"]:
        raise ValueError("未配置 SMTP 服务器")
    if not recipients:
        raise ValueError("未配置收件人")
    if not c["sender"]:
        raise ValueError("未配置发件人")

    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = c["sender"]
    msg["To"] = ", ".join(recipients)
    msg.set_content(body)

    if c["port"] == 465:  # implicit TLS
        with smtplib.SMTP_SSL(c["host"], c["port"], timeout=TIMEOUT) as s:
            if c["user"]:
                s.login(c["user"], c["password"])
            s.send_message(msg)
    else:
        with smtplib.SMTP(c["host"], c["port"], timeout=TIMEOUT) as s:
            if c["tls"]:
                s.starttls()
            if c["user"]:
                s.login(c["user"], c["password"])
            s.send_message(msg)
    log.info("mail sent to %s: %s", recipients, subject)
    return {"ok": True, "to": recipients, "subject": subject}
