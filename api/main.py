from __future__ import annotations
import json
from datetime import datetime
from pathlib import Path

from fastapi import Depends, FastAPI, File, HTTPException, UploadFile
from fastapi.responses import JSONResponse, StreamingResponse
from sqlalchemy.orm import Session

from db.models import CorpusDocument, PipelineRun
from db.session import get_db
from pipeline.config import CORPUS_DIR, OUTPUT_DIR
from pipeline.corpus_registry import detect_metadata, save_registry
from api.leis import router as leis_router
from api.runner import start_run, stream_events


app = FastAPI(title="Amanuense API")
app.include_router(leis_router)


# ── Corpus ────────────────────────────────────────────────────────────────────

@app.get("/api/corpus")
def list_corpus(db: Session = Depends(get_db)):
    docs = db.query(CorpusDocument).all()
    result = []
    for doc in docs:
        parsed_path = CORPUS_DIR / "parsed" / f"{doc.id}.md"
        result.append({
            "id": doc.id,
            "parsed": parsed_path.exists(),
            **doc.to_registry_dict(),
        })
    return {"documents": result}


@app.post("/api/corpus/upload")
async def upload_corpus(
    files: list[UploadFile] = File(...),
    db: Session = Depends(get_db),
):
    raw_dir = CORPUS_DIR / "raw"
    raw_dir.mkdir(parents=True, exist_ok=True)

    added = []
    for file in files:
        stem = Path(file.filename).stem
        doc_id = stem.lower().replace("_", "-")
        dest = raw_dir / f"{doc_id}.pdf"
        dest.write_bytes(await file.read())

        meta = detect_metadata(stem)
        existing = db.get(CorpusDocument, doc_id)
        if existing:
            for k, v in meta.items():
                setattr(existing, _meta_to_col(k), v)
        else:
            db.add(CorpusDocument(id=doc_id, **_meta_to_model(meta)))
        added.append({"id": doc_id, **meta})

    db.commit()
    return {"added": added}


@app.delete("/api/corpus/{doc_id}")
def remove_corpus(doc_id: str, db: Session = Depends(get_db)):
    doc = db.get(CorpusDocument, doc_id)
    if not doc:
        raise HTTPException(404, "Document not found")

    db.delete(doc)
    db.commit()

    for path in [
        CORPUS_DIR / "raw" / f"{doc_id}.pdf",
        CORPUS_DIR / "parsed" / f"{doc_id}.md",
    ]:
        if path.exists():
            path.unlink()

    return {"deleted": doc_id}


# ── Pipeline ──────────────────────────────────────────────────────────────────

@app.post("/api/run")
def run_pipeline(db: Session = Depends(get_db)):
    docs = db.query(CorpusDocument).all()
    if not docs:
        raise HTTPException(400, "Corpus vazio — faça upload de documentos primeiro")

    # Sync DB → registry.json so the pipeline can read it
    registry = {doc.id: doc.to_registry_dict() for doc in docs}
    save_registry(CORPUS_DIR, registry)

    run_id = datetime.now().strftime("%Y%m%dT%H%M%S")
    db.add(PipelineRun(id=run_id))
    db.commit()

    start_run(run_id)
    return {"run_id": run_id}


@app.get("/api/runs")
def list_runs(db: Session = Depends(get_db)):
    runs = db.query(PipelineRun).order_by(PipelineRun.started_at.desc()).limit(20).all()
    return {"runs": [
        {
            "id": r.id,
            "status": r.status,
            "started_at": r.started_at.isoformat() if r.started_at else None,
            "finished_at": r.finished_at.isoformat() if r.finished_at else None,
            "error_message": r.error_message,
        }
        for r in runs
    ]}


@app.get("/api/status/{run_id}")
async def get_status(run_id: str):
    async def generator():
        async for chunk in stream_events(run_id):
            yield chunk

    return StreamingResponse(
        generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.get("/api/graph")
def get_graph():
    graph_path = OUTPUT_DIR / "knowledge-graph.json"
    if not graph_path.exists():
        raise HTTPException(404, "Nenhum grafo encontrado — execute o pipeline primeiro")
    data = json.loads(graph_path.read_text(encoding="utf-8"))
    if not data.get("nodes"):
        raise HTTPException(404, "Grafo vazio — execute o pipeline primeiro")
    return JSONResponse(_to_d3(data))


def _to_d3(data: dict) -> dict:
    """Converte knowledge-graph.json bruto para formato D3 (nodes + links)."""
    from pipeline.graph.exporter import _NODE_COLORS, _EDGE_COLORS

    nodes = []
    for n in data.get("nodes", []):
        vigencia = n.get("vigenciaMeta") or {}
        status = vigencia.get("status", "vigente")
        # Normaliza enum serializado como "vigente" ou "VigencyStatus.vigente"
        if "." in str(status):
            status = str(status).split(".")[-1]
        node_type = n.get("type", "norma")
        nodes.append({
            "id": n["id"],
            "label": (n.get("name") or n["id"])[:60],
            "type": node_type,
            "status": status,
            "layer": n.get("layer", 0),
            "color": _NODE_COLORS.get(node_type, "#888888"),
            "summary": (n.get("summary") or "")[:200],
            "tags": n.get("tags") or [],
            "review": n.get("review_required", False),
        })

    links = []
    for e in data.get("edges", []):
        if e.get("deprecated"):
            continue
        edge_type = e.get("type", "")
        if "." in str(edge_type):
            edge_type = str(edge_type).split(".")[-1]
        links.append({
            "id": e.get("id", ""),
            "source": e["source"],
            "target": e["target"],
            "type": edge_type,
            "weight": e.get("weight", 0.5),
            "implicit": e.get("implicit", False),
            "color": _EDGE_COLORS.get(edge_type, "#999999"),
            "review": e.get("review_required", False),
            "stale": e.get("stale", False),
        })

    return {"nodes": nodes, "links": links}


# ── Helpers ───────────────────────────────────────────────────────────────────

def _meta_to_col(key: str) -> str:
    return {
        "dataPublicacao": "data_publicacao",
        "dataVigor": "data_vigor",
        "vigencyStatus": "vigency_status",
    }.get(key, key)


def _meta_to_model(meta: dict) -> dict:
    return {
        "authority": meta.get("authority", "BCB"),
        "type": meta.get("type", "resolucao"),
        "number": meta.get("number"),
        "year": meta.get("year", datetime.now().year),
        "data_publicacao": meta.get("dataPublicacao", ""),
        "data_vigor": meta.get("dataVigor", ""),
        "vigency_status": meta.get("vigencyStatus", "vigente"),
        "description": meta.get("description", ""),
    }
