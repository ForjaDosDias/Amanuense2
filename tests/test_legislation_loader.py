"""Integração do legislation-loader com PostgreSQL real.

Requer LEGISLACAO_DATABASE_URL apontando para um Postgres 14+ com btree_gist
(docker compose up -d postgres). Sem a variável, os testes são pulados.
"""
import json
import os
from datetime import date
from pathlib import Path

import pytest

pytestmark = pytest.mark.skipif(
    not os.environ.get("LEGISLACAO_DATABASE_URL"),
    reason="requer Postgres (LEGISLACAO_DATABASE_URL)",
)

MD_NORMA = """\
CAPÍTULO I
DAS DISPOSIÇÕES GERAIS

Art. 1º Esta Resolução institui o arranjo de teste.

Art. 2º São participantes:

I - instituições financeiras; e

II - instituições de pagamento.

§ 1º O caso omisso será decidido pelo BCB. (Redação dada pela Resolução BCB nº 77, de 2021)

Art. 3º Novo dever de reporte. (Incluído pela Resolução BCB nº 77, de 2021)
"""

MD_ALTERADORA = """\
Art. 1º Esta Resolução altera a Resolução BCB nº 42, de 2020.
"""

DOCS = [
    {
        "documentId": "resolucao-bcb-042-2020",
        "parsedPath": "corpus/parsed/resolucao-bcb-042-2020.md",
        "authority": "BCB", "type": "resolucao", "number": "42", "year": 2020,
        "dataPublicacao": "2020-05-01", "dataVigor": "2020-05-01",
        "description": "Resolução de teste 42/2020",
    },
    {
        "documentId": "resolucao-bcb-077-2021",
        "parsedPath": "corpus/parsed/resolucao-bcb-077-2021.md",
        "authority": "BCB", "type": "resolucao", "number": "77", "year": 2021,
        "dataPublicacao": "2021-03-15", "dataVigor": "2021-03-15",
        "description": "Resolução de teste 77/2021",
    },
]


@pytest.fixture()
def ambiente(tmp_path: Path):
    """Monta intermediate/ + corpus/ sintéticos e limpa as normas de teste do DB."""
    from db.legislacao import get_conn, init_legislacao_db, legislacao_enabled

    init_legislacao_db()
    intermediate = tmp_path / "intermediate"
    intermediate.mkdir()
    corpus = tmp_path / "corpus"
    (corpus / "parsed").mkdir(parents=True)
    (corpus / "parsed" / "resolucao-bcb-042-2020.md").write_text(MD_NORMA, encoding="utf-8")
    (corpus / "parsed" / "resolucao-bcb-077-2021.md").write_text(MD_ALTERADORA, encoding="utf-8")
    (intermediate / "scan_manifest.json").write_text(
        json.dumps({"documents": DOCS}), encoding="utf-8"
    )

    def _limpar():
        # test_arvore_gerada_sem_db remove LEGISLACAO_DATABASE_URL (modo legado);
        # esse estado vaza para o teardown do fixture — sem base não há o que limpar.
        if not legislacao_enabled():
            return
        with get_conn() as conn:
            conn.execute(
                """
                DO $$
                DECLARE v_ids BIGINT[];
                BEGIN
                    SELECT array_agg(id_norma) INTO v_ids FROM norma
                     WHERE urn_lexml LIKE 'urn:lex:br:bcb;resolucao:202%%'
                       AND numero IN ('42','77');
                    IF v_ids IS NOT NULL THEN
                        DELETE FROM relacao_normativa
                         WHERE id_norma_origem = ANY(v_ids) OR id_norma_destino = ANY(v_ids);
                        DELETE FROM dispositivo_versao WHERE id_dispositivo IN
                            (SELECT id_dispositivo FROM dispositivo WHERE id_norma = ANY(v_ids));
                        DELETE FROM dispositivo WHERE id_norma = ANY(v_ids);
                        DELETE FROM agrupamento WHERE id_norma = ANY(v_ids);
                        DELETE FROM versao_norma WHERE id_norma = ANY(v_ids);
                        DELETE FROM norma WHERE id_norma = ANY(v_ids);
                    END IF;
                END $$;
                """
            )
            conn.commit()

    _limpar()
    yield intermediate, corpus
    _limpar()


def _rodar(intermediate: Path, corpus: Path) -> dict:
    from pipeline.agents.legislation_loader import LegislationLoaderAgent

    LegislationLoaderAgent().run(intermediate, corpus)
    return json.loads((intermediate / "legislation_loader.json").read_text(encoding="utf-8"))


def test_carga_e_idempotencia(ambiente):
    from db.legislacao import get_conn

    intermediate, corpus = ambiente
    r1 = _rodar(intermediate, corpus)
    assert r1["dbEnabled"]
    assert r1["loaded"] > 0
    norma_id = r1["normas"]["resolucao-bcb-042-2020"]["norma_id"]

    with get_conn() as conn:
        # identidade + id_canonico
        tipos = dict(conn.execute(
            "SELECT tipo, count(*) FROM dispositivo WHERE id_norma = %s GROUP BY tipo",
            (norma_id,),
        ).fetchall())
        assert tipos["artigo"] == 3
        assert tipos["inciso"] == 2
        assert tipos["paragrafo"] == 1

        # § 1º com "Redação dada": criado pela alteradora na data dela
        row = conn.execute(
            "SELECT situacao, texto, numero_versao FROM fn_consultar_dispositivo("
            "%s, 'art2_par1', %s)", (norma_id, date(2021, 6, 1)),
        ).fetchone()
        assert row[0] == "vigente"
        assert "caso omisso" in row[1]

        # antes da alteradora o § 1º não existia na base (original desconhecida)
        row = conn.execute(
            "SELECT situacao FROM fn_consultar_dispositivo(%s, 'art2_par1', %s)",
            (norma_id, date(2020, 6, 1)),
        ).fetchone()
        assert row[0] == "inexistente na data"

        # art. 3º incluído pela 77/2021 → norma_introdutora preenchida + relação
        row = conn.execute(
            "SELECT d.norma_introdutora_id FROM dispositivo d "
            "WHERE d.id_norma = %s AND d.id_canonico = 'art3'", (norma_id,),
        ).fetchone()
        assert row[0] == r1["normas"]["resolucao-bcb-077-2021"]["norma_id"]
        rel = conn.execute(
            "SELECT count(*) FROM relacao_normativa WHERE id_norma_destino = %s "
            "AND tipo_relacao = 'acrescenta'", (norma_id,),
        ).fetchone()
        assert rel[0] >= 1

    # 2ª rodada: idempotente
    r2 = _rodar(intermediate, corpus)
    assert r2["loaded"] == 0
    assert r2["skipped"] >= r1["loaded"]


def test_arvore_gerada_sem_db(ambiente, monkeypatch):
    intermediate, corpus = ambiente
    monkeypatch.delenv("LEGISLACAO_DATABASE_URL", raising=False)
    r = _rodar(intermediate, corpus)
    assert not r["dbEnabled"]
    tree = json.loads(
        (intermediate / "canonical_tree" / "resolucao-bcb-042-2020.json").read_text(
            encoding="utf-8"
        )
    )
    assert [d["id_canonico"] for d in tree["dispositivos"]] == ["art1", "art2", "art3"]
