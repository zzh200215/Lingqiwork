"""Knowledge-graph RAG over the vault, stored in the user's local Neo4j.

LightRAG-style dual retrieval, sized for a personal workbench:

- extraction: one LLM call per vault file → entities + typed relations (JSON)
- storage: (:KgFile)-[:KG_MENTIONS]->(:KgEntity)-[KG_REL...]->(:KgEntity);
  labels are Kg-prefixed so the feature never clashes with data the user
  already keeps in the same database
- retrieval: embed the query, cosine-match entity descriptions client-side
  (a few thousand nodes at personal scale — no server vector index needed,
  works on Neo4j 4.x and 5.x alike), expand one hop, render a context block

Everything degrades to a no-op when Neo4j is unreachable or the feature is
off; chat never breaks because of the graph.
"""
import asyncio
import hashlib
import json
import logging
import re
from pathlib import Path

from app.config import VAULT_DIR
from app.core.prefs import load_config

log = logging.getLogger(__name__)

DRIVER = None  # cached neo4j sync driver
_TOP_K = 6
_EXPAND_PER_ENTITY = 8
MAX_FILE_CHARS = 12000
SCAN_CAP = 500
SKIP_DIRS = {"digests", "feeds", "tasks", "images", ".trash", ".obsidian"}

_REL_TYPE_RE = re.compile(r"^[\u4e00-\u9fa5A-Za-z0-9_]{1,30}$")

_EXTRACTION_SYSTEM = (
    "你负责从文档中抽取知识图谱三元组。只输出一个 JSON 对象，不要代码块、不要解释：\n"
    '{"entities": [{"name": "实体名", "type": "人物|组织|项目|技术|概念|地点|事件 之一", '
    '"description": "一句话描述"}],\n'
    ' "relations": [{"source": "实体名", "target": "实体名", "type": "关系名（动词短语，如 参与/属于/使用）", '
    '"description": "一句话说明"}]}\n'
    "要求：实体名简短；只使用文档中出现过的信息；最多 20 个实体、25 条关系；"
    '没有可抽取的内容就输出 {"entities": [], "relations": []}。'
)


# ---------- connection ----------


def enabled() -> bool:
    """The chat channel only runs when the user turned the feature on."""
    return bool(load_config().get("kg_enabled"))


def _auth(cfg: dict):
    pw = cfg.get("kg_password") or ""
    if not pw:
        return None  # auth-disabled local instance
    return (cfg.get("kg_user") or "neo4j", pw)


def get_driver():
    global DRIVER
    if DRIVER is None:
        from neo4j import GraphDatabase

        cfg = load_config()
        uri = cfg.get("kg_uri") or "bolt://localhost:7687"
        DRIVER = GraphDatabase.driver(uri, auth=_auth(cfg), connection_timeout=5)
    return DRIVER


def close() -> None:
    """Drop the cached driver so the next call reconnects with new config."""
    global DRIVER
    if DRIVER is not None:
        try:
            DRIVER.close()
        except Exception:  # noqa: BLE001
            pass
        DRIVER = None


def verify() -> dict:
    """Connection test + graph counts. Never raises."""
    try:
        with get_driver().session() as s:
            s.run("RETURN 1 AS ok").single()
            counts = _counts(s)
        return {"ok": True, **counts}
    except Exception as e:  # noqa: BLE001 - every failure is a status, not a crash
        close()
        return {"ok": False, "error": f"{type(e).__name__}: {str(e)[:200]}"}


def _counts(s) -> dict:
    files = s.run("MATCH (f:KgFile) RETURN count(f) AS n").single()["n"]
    ents = s.run("MATCH (e:KgEntity) RETURN count(e) AS n").single()["n"]
    rels = s.run("MATCH (:KgEntity)-[r]->(:KgEntity) RETURN count(r) AS n").single()["n"]
    return {"files": files, "entities": ents, "relations": rels}


def _ensure_schema(s) -> None:
    s.run("CREATE CONSTRAINT kg_entity_name IF NOT EXISTS FOR (e:KgEntity) REQUIRE e.name IS UNIQUE")
    s.run("CREATE CONSTRAINT kg_file_path IF NOT EXISTS FOR (f:KgFile) REQUIRE f.path IS UNIQUE")


# ---------- extraction ----------


def _sanitize_type(t: str, default: str = "关联") -> str:
    t = (t or "").strip()
    return t if _REL_TYPE_RE.match(t) else default


def _parse_extraction(raw: str) -> dict:
    """Model reply → {"entities": [...], "relations": [...]}, filtered and
    bounded. Pure function; always returns the two keys."""
    out = {"entities": [], "relations": []}
    m = re.search(r"\{.*\}", raw or "", re.S)
    if not m:
        return out
    try:
        data = json.loads(m.group(0))
    except json.JSONDecodeError:
        return out
    if not isinstance(data, dict):
        return out

    names: set[str] = set()
    for ent in (data.get("entities") or [])[:20]:
        if not isinstance(ent, dict):
            continue
        name = str(ent.get("name") or "").strip()[:60]
        if not name or name in names:
            continue
        names.add(name)
        out["entities"].append(
            {
                "name": name,
                "type": _sanitize_type(str(ent.get("type") or ""), default="概念"),
                "description": str(ent.get("description") or "").strip()[:200],
            }
        )
    for rel in (data.get("relations") or [])[:25]:
        if not isinstance(rel, dict):
            continue
        src, dst = str(rel.get("source") or "").strip()[:60], str(rel.get("target") or "").strip()[:60]
        if src in names and dst in names and src != dst:
            out["relations"].append(
                {
                    "source": src,
                    "target": dst,
                    "type": _sanitize_type(str(rel.get("type") or "关联")),
                    "description": str(rel.get("description") or "").strip()[:200],
                }
            )
    return out


async def _llm_json(text: str, path: str) -> str:
    """One extraction call. Test seam: monkeypatch me."""
    from app.core.digest import _resolve_model_id

    model_id = _resolve_model_id()
    if not model_id:
        raise RuntimeError("没有已启用的 provider，无法抽取实体")
    from app.routers.chat import resolve_model

    resolved = await resolve_model(model_id)
    p = resolved.provider
    from app.core.llm import ProviderInfo, stream_chat

    chunks = [
        c
        async for c in stream_chat(
            ProviderInfo(kind=p.kind, base_url=p.base_url, api_key=p.api_key),
            resolved.model,
            [
                {"role": "system", "content": _EXTRACTION_SYSTEM},
                {"role": "user", "content": f"[文件 {path}]\n{text}"},
            ],
        )
    ]
    return "".join(chunks)


# ---------- graph writes ----------


def _upsert_file(path: str, digest: str, data: dict) -> None:
    """Write one file's extraction. Blocking; run in a thread."""
    driver = get_driver()
    with driver.session() as s:
        _ensure_schema(s)
        s.execute_write(
            lambda tx: tx.run(
                "MERGE (f:KgFile {path:$path}) SET f.hash=$hash, f.updated_at=datetime()",
                path=path,
                hash=digest,
            )
        )
        for ent in data["entities"]:
            s.execute_write(
                lambda tx, ent=ent: tx.run(
                    "MERGE (e:KgEntity {name:$name}) "
                    "SET e.type=$type, e.description=$description, e.embedding=null "
                    "MERGE (f:KgFile {path:$path}) MERGE (f)-[:KG_MENTIONS]->(e)",
                    path=path,
                    **ent,
                )
            )
        for rel in data["relations"]:
            rtype = _sanitize_type(rel["type"])
            s.execute_write(
                lambda tx, rel=rel, rtype=rtype: tx.run(
                    f"MATCH (a:KgEntity {{name:$src}}), (b:KgEntity {{name:$dst}}) "
                    f"MERGE (a)-[r:`{rtype}`]->(b) "
                    f"SET r.description=$description, r.file=$path",
                    **rel,
                )
            )


async def _embed_entities(names: list[str]) -> int:
    """(Re)embed the given entities' name+description onto their nodes."""
    if not names:
        return 0
    with get_driver().session() as s:
        rows = s.run(
            "MATCH (e:KgEntity) WHERE e.name IN $names RETURN e.name AS name, e.description AS d",
            names=names,
        ).data()
    if not rows:
        return 0
    from app.core import embedder

    vecs = await asyncio.to_thread(
        embedder.embed, [f"{r['name']}——{r['d'] or ''}" for r in rows]
    )
    with get_driver().session() as s:
        for r, v in zip(rows, vecs):
            s.execute_write(
                lambda tx, name=r["name"], vec=v: tx.run(
                    "MATCH (e:KgEntity {name:$name}) SET e.embedding=$vec", name=name, vec=vec
                )
            )
    return len(rows)


# ---------- vault scan + build ----------


def _scan_vault() -> list[tuple[str, Path]]:
    from app.core import ingest

    files = []
    root = VAULT_DIR.resolve()
    for p in sorted(VAULT_DIR.rglob("*")):
        if not p.is_file() or not ingest.is_supported(p):
            continue
        rel = p.relative_to(VAULT_DIR).as_posix()
        if any(part in SKIP_DIRS for part in p.relative_to(VAULT_DIR).parts):
            continue
        if p.is_relative_to(root):
            files.append((rel, p))
        if len(files) >= SCAN_CAP:
            break
    return files


def _existing_hashes() -> dict[str, str]:
    try:
        with get_driver().session() as s:
            rows = s.run("MATCH (f:KgFile) RETURN f.path AS path, f.hash AS hash").data()
        return {r["path"]: r["hash"] or "" for r in rows}
    except Exception:  # noqa: BLE001 - treat as empty graph
        return {}


def _file_text(p: Path) -> str:
    from app.core import ingest

    text = ingest.parse_file(p)
    return text[:MAX_FILE_CHARS]


async def build(max_files: int = 8) -> dict:
    """Incrementally extract+store up to max_files changed files. Returns a
    summary; safe to call repeatedly until everything is indexed."""
    st = verify()  # fail fast on a bad password / dead server
    if not st.get("ok"):
        raise RuntimeError(f"Neo4j 连接失败：{st.get('error', '')}")
    done, unchanged, failed = 0, 0, []
    existing = _existing_hashes()
    for rel, p in _scan_vault():
        if done >= max_files:
            break
        try:
            text = _file_text(p)
            if not text.strip():
                continue
            digest = hashlib.md5(text.encode()).hexdigest()
            if existing.get(rel) == digest:
                unchanged += 1
                continue
            raw = await _llm_json(text, rel)
            data = _parse_extraction(raw)
            await asyncio.to_thread(_upsert_file, rel, digest, data)
            await _embed_entities([e["name"] for e in data["entities"]])
            done += 1
            log.info("kg: extracted %s (%d entities)", rel, len(data["entities"]))
        except Exception as e:  # noqa: BLE001 - one bad file must not stop the build
            failed.append({"file": rel, "error": f"{type(e).__name__}: {str(e)[:150]}"})
            log.warning("kg: extraction failed for %s", rel, exc_info=True)
    return {"extracted": done, "unchanged": unchanged, "failed": failed}


# ---------- retrieval ----------


def _load_entity_vectors() -> list[tuple[str, str, list[float]]]:
    rows = []
    with get_driver().session() as s:
        result = s.run(
            "MATCH (e:KgEntity) WHERE e.embedding IS NOT NULL "
            "RETURN e.name AS name, e.description AS description, e.embedding AS vec"
        )
        for r in result:
            rows.append((r["name"], r["description"] or "", list(r["vec"])))
    return rows


def _expand(names: list[str]) -> list[dict]:
    if not names:
        return []
    rels: list[dict] = []
    with get_driver().session() as s:
        for name in names:
            rows = s.run(
                "MATCH (a:KgEntity {name:$name})-[r]-(b:KgEntity) "
                "RETURN a.name AS src, type(r) AS type, coalesce(r.description,'') AS description, "
                "b.name AS dst LIMIT $lim",
                name=name,
                lim=_EXPAND_PER_ENTITY,
            ).data()
            rels.extend(rows)
    seen, out = set(), []
    for r in rels:
        key = (r["src"], r["type"], r["dst"])
        if key not in seen:
            seen.add(key)
            out.append(r)
    return out


def _embed_query(query: str) -> list[float]:
    from app.core import embedder

    return embedder.embed([query.strip()[:500]])[0]


def _cosine(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    na = sum(x * x for x in a) ** 0.5
    nb = sum(x * x for x in b) ** 0.5
    return dot / (na * nb) if na and nb else 0.0


def retrieve(query: str, top_k: int = _TOP_K) -> dict:
    """Graph channel: match entities semantically, expand one hop. Blocking."""
    qvec = _embed_query(query)
    if not qvec:
        return {"entities": [], "relations": []}
    rows = _load_entity_vectors()
    scored = sorted(
        ((name, desc, _cosine(qvec, vec)) for name, desc, vec in rows),
        key=lambda x: x[2],
        reverse=True,
    )[:top_k]
    entities = [{"name": n, "description": d, "score": round(s, 3)} for n, d, s in scored if s > 0.3]
    return {"entities": entities, "relations": _expand([e["name"] for e in entities])}


def format_context(result: dict) -> str:
    ents, rels = result.get("entities") or [], result.get("relations") or []
    if not ents:
        return ""
    lines = ["以下是与问题相关的知识图谱上下文（来自你的笔记，经实体关系抽取）：", "", "【相关实体】"]
    lines += [f"- {e['name']}（{e.get('type', '')}）：{e['description']}" for e in ents if e.get("description")]
    if rels:
        lines.append("")
        lines.append("【关联关系】")
        lines += [f"- {r['src']} —{r['type']}→ {r['dst']}：{r.get('description') or ''}" for r in rels]
    lines += ["", "如与当前问题无关可忽略；引用这些事实时请结合上下文谨慎推断。"]
    return "\n".join(lines)


def context_for_query(query: str) -> str:
    """Chat entry point: '' when the feature is off or nothing matched."""
    if not enabled():
        return ""
    try:
        return format_context(retrieve(query))
    except Exception:  # noqa: BLE001 - the graph must never break chat
        log.warning("kg retrieval failed; continuing without it", exc_info=True)
        return ""


def clear() -> int:
    """Wipe the Kg-labeled subgraph."""
    with get_driver().session() as s:
        n = s.run("MATCH (e:KgEntity) DETACH DELETE e RETURN count(e) AS n").single()["n"]
        s.run("MATCH (f:KgFile) DETACH DELETE f")
    return n
