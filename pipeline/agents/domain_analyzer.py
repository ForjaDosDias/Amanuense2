from __future__ import annotations
from datetime import date, datetime
from pathlib import Path
from .base import BaseAgent, load_prompt, console
from ..parsers.bcb_patterns import DEFINICAO_RE, PRAZO_RE
from ..schemas import (
    GraphNode, NodeType, EdgeType, EDGE_DEFAULT_WEIGHTS,
)
from ..utils.id_factory import definicao_id, papel_id, prazo_id, entidade_id, edge_id, doc_id_from_node
from ..utils.llm_helpers import parse_json_response

_FIXED_PAPEIS = [
    "PSP Direto", "PSP Indireto", "ITP", "Iniciador de Transação de Pagamento",
    "Usuário Final Pagador", "Usuário Final Recebedor",
    "Gestor do Arranjo", "BCB", "Banco Central do Brasil",
]

_FIXED_ENTIDADES = ["BCB", "CMN", "CIP", "FEBRABAN", "STR", "DICT", "SFN"]


def _make_fixed_nodes(vigencia_inicio: date, verificacao: date) -> list[dict]:
    nodes: list[dict] = []
    for nome in _FIXED_PAPEIS:
        nid = papel_id(nome)
        nodes.append(GraphNode(
            id=nid,
            type=NodeType.PAPEL,
            name=nome,
            summary=f"Papel regulatório: {nome}",
            tags=[nome.lower().replace(" ", "-")],
        ).model_dump(mode="json"))
    for nome in _FIXED_ENTIDADES:
        nid = entidade_id(nome)
        nodes.append(GraphNode(
            id=nid,
            type=NodeType.ENTIDADE,
            name=nome,
            summary=f"Entidade regulatória ou de mercado: {nome}",
            tags=[nome.lower()],
        ).model_dump(mode="json"))
    return nodes


class DomainAnalyzerAgent(BaseAgent):
    def __init__(self) -> None:
        super().__init__("domain-analyzer")
        self._prompt = load_prompt("domain-analyzer")

    def run(self, intermediate_dir: Path, corpus_dir: Path) -> None:
        manifest_path = intermediate_dir / "corpus_scanner.json"
        if not manifest_path.exists():
            manifest_path = intermediate_dir / "scan_manifest.json"
        norm_path = intermediate_dir / "norm_analyzer.json"
        corpus_texts_path = intermediate_dir / "corpus_texts_builder.json"

        if not norm_path.exists():
            console.print("[red]ERROR:[/red] norm_analyzer.json required")
            return

        norm_data = self._load_json(norm_path)
        corpus_texts = self._load_json(corpus_texts_path)["texts"] if corpus_texts_path.exists() else {}

        # Load previous output for incremental processing
        output_path = intermediate_dir / "domain_analyzer.json"
        existing_output = self._load_json(output_path) if output_path.exists() else None

        processed_hashes: dict[str, str] = {}
        current_hashes: dict[str, str] = norm_data.get("processedDocIds", {})
        if existing_output:
            processed_hashes = existing_output.get("processedDocIds", {})

        vigencia_inicio = date(2020, 11, 16)
        verificacao = date.today()

        nodes: list[dict] = _make_fixed_nodes(vigencia_inicio, verificacao)
        edges: list[dict] = []
        seen_def_ids: set[str] = set()
        seen_edge_ids: set[str] = set()
        prazo_counter: dict[str, int] = {}

        # Restore preserved results from unchanged docs (docs removed from the
        # corpus are not preserved, otherwise their nodes would linger forever)
        if existing_output:
            new_or_changed = {
                doc_id for doc_id in current_hashes
                if current_hashes.get(doc_id) != processed_hashes.get(doc_id)
            }
            for n in existing_output.get("nodes", []):
                src_doc = n.get("sourceDoc", "")
                if src_doc and src_doc in current_hashes and src_doc not in new_or_changed:
                    nodes.append(n)
                    seen_def_ids.add(n["id"])
            for e in existing_output.get("edges", []):
                source_doc = doc_id_from_node(e.get("source", ""))
                if source_doc and source_doc in current_hashes and source_doc not in new_or_changed:
                    edges.append(e)
                    seen_edge_ids.add(e["id"])
            processed_hashes = {
                k: v for k, v in processed_hashes.items() if k in current_hashes
            }
        else:
            new_or_changed = set(current_hashes)

        for doc_id, doc_info in norm_data.get("byDocument", {}).items():
            if doc_id not in new_or_changed:
                console.print(f"[dim]  {doc_id}: unchanged, reusing domain results[/dim]")
                continue

            art_nodes = [n for n in doc_info.get("nodes", []) if n.get("type") == "artigo"]

            for art_node in art_nodes:
                art_id = art_node["id"]
                art_num = art_node.get("articleNumber", "1")
                art_text = corpus_texts.get(art_id, {}).get("textoCompleto", "")
                if not art_text:
                    art_text = art_node.get("summary", "")
                # Definição vige enquanto o artigo que a define vige
                art_vigencia = art_node.get("vigenciaMeta")

                # Regex-based definitions
                for m in DEFINICAO_RE.finditer(art_text):
                    termo = m.group(1).strip().rstrip(",;.")[:60]
                    def_id = definicao_id(doc_id, termo)
                    if def_id not in seen_def_ids:
                        seen_def_ids.add(def_id)
                        node_dict = GraphNode(
                            id=def_id,
                            type=NodeType.DEFINICAO,
                            name=termo,
                            summary=f"Definição legal: {termo} ({doc_id})",
                            tags=[termo.lower().replace(" ", "-")[:30], "definicao"],
                            vigenciaMeta=art_vigencia,
                        ).model_dump(mode="json")
                        node_dict["sourceDoc"] = doc_id
                        nodes.append(node_dict)

                    eid = edge_id(art_id, EdgeType.DEFINE.value, def_id)
                    if eid not in seen_edge_ids:
                        seen_edge_ids.add(eid)
                        edges.append({
                            "id": eid,
                            "source": art_id,
                            "target": def_id,
                            "type": EdgeType.DEFINE.value,
                            "weight": EDGE_DEFAULT_WEIGHTS[EdgeType.DEFINE],
                            "direction": "forward",
                            "implicit": False,
                            "textEvidence": m.group(0)[:200],
                            "review_required": False,
                            "deprecated": False,
                            "stale": False,
                        })

                # Regex-based prazos
                for m in PRAZO_RE.finditer(art_text):
                    prazo_counter[doc_id] = prazo_counter.get(doc_id, 0) + 1
                    pz_id = prazo_id(doc_id, art_num, prazo_counter[doc_id])
                    full_match = m.group(0).strip()

                    pz_dict = GraphNode(
                        id=pz_id,
                        type=NodeType.PRAZO,
                        name=f"Prazo: {full_match[:50]}",
                        summary=f"Prazo normativo extraído de {art_id}: {full_match}",
                        tags=["prazo", doc_id.split("-")[0]],
                    ).model_dump(mode="json")
                    pz_dict["sourceDoc"] = doc_id
                    nodes.append(pz_dict)

                    eid = edge_id(art_id, EdgeType.CONDICIONA.value, pz_id)
                    seen_edge_ids.add(eid)
                    edges.append({
                        "id": eid,
                        "source": art_id,
                        "target": pz_id,
                        "type": EdgeType.CONDICIONA.value,
                        "weight": EDGE_DEFAULT_WEIGHTS[EdgeType.CONDICIONA],
                        "direction": "forward",
                        "implicit": False,
                        "textEvidence": full_match[:200],
                        "review_required": False,
                        "deprecated": False,
                        "stale": False,
                    })

                # LLM for complex definition articles (short text < 200 chars: skip)
                if len(art_text) > 200 and any(
                    kw in art_text.lower()
                    for kw in ["considera-se", "entende-se", "denomina-se", "significa"]
                ):
                    try:
                        user_prompt = (
                            f"DOCUMENTO: {doc_id}\nARTIGO: {art_num}\nTEXTO: {art_text[:1500]}"
                        )
                        raw = self.client.call(system=self._prompt, user=user_prompt)
                        result = parse_json_response(raw, self.client, art_id)
                        for d in result.get("definicoes", []):
                            termo = d.get("termo", "").strip()[:60]
                            if not termo:
                                continue
                            def_id = definicao_id(doc_id, termo)
                            if def_id not in seen_def_ids:
                                seen_def_ids.add(def_id)
                                llm_def_dict = GraphNode(
                                    id=def_id,
                                    type=NodeType.DEFINICAO,
                                    name=termo,
                                    summary=d.get("definicao", termo),
                                    tags=[termo.lower().replace(" ", "-")[:30], "definicao"],
                                    vigenciaMeta=art_vigencia,
                                ).model_dump(mode="json")
                                llm_def_dict["sourceDoc"] = doc_id
                                nodes.append(llm_def_dict)
                            eid = edge_id(art_id, EdgeType.DEFINE.value, def_id)
                            if eid not in seen_edge_ids:
                                seen_edge_ids.add(eid)
                                edges.append({
                                    "id": eid,
                                    "source": art_id,
                                    "target": def_id,
                                    "type": EdgeType.DEFINE.value,
                                    "weight": EDGE_DEFAULT_WEIGHTS[EdgeType.DEFINE],
                                    "direction": "forward",
                                    "implicit": False,
                                    "textEvidence": d.get("textEvidence", "")[:200],
                                    "review_required": False,
                                    "deprecated": False,
                                    "stale": False,
                                })
                    except Exception as e:
                        console.print(f"[yellow]⚠[/yellow]  domain LLM failed for {art_id}: {e}")

            processed_hashes[doc_id] = current_hashes.get(doc_id, "")

        # deduplicate nodes by id
        seen_ids: set[str] = set()
        deduped: list[dict] = []
        for n in nodes:
            if n["id"] not in seen_ids:
                seen_ids.add(n["id"])
                deduped.append(n)

        output = {
            "generatedAt": datetime.now().isoformat(),
            "nodes": deduped,
            "edges": edges,
            "processedDocIds": processed_hashes,
        }
        self._save_json(intermediate_dir / "domain_analyzer.json", output)
        console.print(
            f"[green]✓[/green] domain-analyzer: {len(deduped)} nodes, {len(edges)} edges"
        )
