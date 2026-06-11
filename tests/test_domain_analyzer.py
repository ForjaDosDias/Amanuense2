"""Regressão: nós DEFINICAO devem carregar vigenciaMeta.

DEFINICAO é tipo normativo (NORMATIVE_TYPES) e o schema GraphNode exige
vigenciaMeta — sem ela o pipeline quebrava ao inserir leis com artigos de
definições (ex.: Lei 14.133, art. 6º). A definição herda a vigência do
artigo que a define.
"""
import json
from pathlib import Path

from pipeline.agents.domain_analyzer import DomainAnalyzerAgent
from pipeline.schemas import GraphNode


def _write(path: Path, data: dict) -> None:
    path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")


def test_definicao_herda_vigencia_do_artigo(tmp_path):
    corpus_dir = tmp_path / "corpus"
    corpus_dir.mkdir()
    intermediate = tmp_path / "intermediate"
    intermediate.mkdir()

    vigencia = {
        "dataInicio": "2021-04-01",
        "dataFim": None,
        "status": "vigente",
        "versaoAtiva": None,
        "ultimaVerificacao": "2026-06-11",
    }
    _write(intermediate / "scan_manifest.json", {
        "documents": [{"documentId": "l14133", "fileHash": "hash-a"}],
    })
    _write(intermediate / "norm_analyzer.json", {
        "byDocument": {
            "l14133": {
                "nodes": [{
                    "id": "disp:l14133:art6",
                    "type": "artigo",
                    "articleNumber": "6",
                    "summary": "Definições da lei",
                    "vigenciaMeta": vigencia,
                }],
                "artCount": 1,
            },
        },
        "processedDocIds": {"l14133": "hash-a"},
    })
    # texto curto (<200 chars) casa com DEFINICAO_RE sem acionar o caminho LLM
    _write(intermediate / "corpus_texts_builder.json", {
        "texts": {
            "disp:l14133:art6": {
                "textoCompleto": "Para os fins desta Lei, considera-se "
                "Empresa estatal: entidade dotada de personalidade jurídica",
            },
        },
    })

    DomainAnalyzerAgent().run(intermediate, corpus_dir)

    out = json.loads((intermediate / "domain_analyzer.json").read_text(encoding="utf-8"))
    defs = [n for n in out["nodes"] if n["type"] == "definicao"]
    assert defs, "DEFINICAO_RE deveria ter extraído uma definição"
    for n in defs:
        node = GraphNode.model_validate(n)  # falhava: vigenciaMeta ausente
        assert node.vigenciaMeta is not None
        assert node.vigenciaMeta.dataInicio.isoformat() == "2021-04-01"
