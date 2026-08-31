"""Document parsing: md/txt read directly, pdf via pymupdf, docx via docx2txt.

PDF pages whose text layer is empty/whitespace (scanned docs) fall back to
RapidOCR on a 200dpi render. The OCR model loads lazily on first use and is
kept as a process-wide singleton — first call pays ~2s model init, later
calls ~1-5s per page.
"""
import threading
from pathlib import Path

SUPPORTED_EXT = {".md", ".markdown", ".txt", ".pdf", ".docx"}

# plain-text source files, indexed for cloned repos (not for the vault watcher,
# which stays limited to SUPPORTED_EXT)
TEXT_EXT = {
    ".py", ".pyi", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".svelte",
    ".go", ".rs", ".java", ".kt", ".c", ".h", ".cc", ".cpp", ".hpp", ".cs", ".rb",
    ".php", ".swift", ".scala", ".sh", ".bash", ".ps1", ".sql", ".r", ".lua",
    ".json", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".env.example",
    ".html", ".css", ".scss", ".rst", ".proto", ".graphql", ".tf",
}

_MIN_PAGE_CHARS = 8  # fewer extracted chars than this -> treat page as scanned

_ocr_lock = threading.Lock()
_ocr = None


def warm_ocr() -> None:
    """Load the OCR model eagerly (call once at startup, from the main thread).

    First use from the vault-watcher thread deadlocks: the lazy `import
    onnxruntime` inside that thread never completes under uvicorn, so the
    watcher hangs forever with no error. Pre-loading here sidesteps it.
    """
    global _ocr
    if _ocr is not None:
        return
    with _ocr_lock:
        if _ocr is None:
            from rapidocr_onnxruntime import RapidOCR

            _ocr = RapidOCR()


def _get_ocr():
    if _ocr is None:
        warm_ocr()
    return _ocr


def _ocr_page(page) -> str:
    import numpy as np
    import cv2

    png = page.get_pixmap(dpi=200).tobytes("png")
    arr = cv2.imdecode(np.frombuffer(png, np.uint8), cv2.IMREAD_COLOR)
    result, _ = _get_ocr()(arr)
    return "\n".join(line[1] for line in (result or []))


def ocr_bytes(data: bytes) -> str:
    """OCR raw image bytes (screenshots, pasted images). Raises ValueError
    when the bytes don't decode as an image."""
    import numpy as np
    import cv2

    arr = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
    if arr is None:
        raise ValueError("无法解码图片内容")
    result, _ = _get_ocr()(arr)
    return "\n".join(line[1] for line in (result or [])).strip()


def parse_file(path: Path) -> str:
    """Extract plain text from a supported file. Raises ValueError on unknown type."""
    ext = path.suffix.lower()
    if ext in (".md", ".markdown", ".txt") or ext in TEXT_EXT:
        return path.read_text(encoding="utf-8", errors="replace")
    if ext == ".pdf":
        import pymupdf

        pages: list[str] = []
        with pymupdf.open(path) as doc:
            for page in doc:
                text = page.get_text().strip()
                if len(text) < _MIN_PAGE_CHARS:
                    try:
                        text = _ocr_page(page).strip() or text
                    except Exception:  # noqa: BLE001 - OCR failure keeps raw text
                        pass
                pages.append(text)
        return "\n\n".join(pages)
    if ext == ".docx":
        import docx2txt

        return docx2txt.process(str(path))
    raise ValueError(f"unsupported file type: {ext}")


def is_supported(path: Path) -> bool:
    return path.suffix.lower() in SUPPORTED_EXT


def is_repo_indexable(path: Path) -> bool:
    """Docs *and* source files — used when indexing cloned repositories."""
    ext = path.suffix.lower()
    return ext in SUPPORTED_EXT or ext in TEXT_EXT
