"""Endpoints /api/leis (visualização "Texto das Leis").

Os testes de leitura exigem LEGISLACAO_DATABASE_URL apontando para um
Postgres 14+ (docker compose up -d postgres); sem a variável são pulados.
O teste de modo legado (503) roda em qualquer ambiente.
"""
import os

import pytest
from fastapi.testclient import TestClient

requer_pg = pytest.mark.skipif(
    not os.environ.get("LEGISLACAO_DATABASE_URL"),
    reason="requer Postgres (LEGISLACAO_DATABASE_URL)",
)


@pytest.fixture()
def client():
    from api.main import app

    return TestClient(app, raise_server_exceptions=True)


def test_leis_503_sem_base(client, monkeypatch):
    monkeypatch.delenv("LEGISLACAO_DATABASE_URL", raising=False)
    resp = client.get("/api/leis")
    assert resp.status_code == 503
    assert "LEGISLACAO_DATABASE_URL" in resp.json()["detail"]


# ── Integração com Postgres real ──────────────────────────────────────────────

@pytest.fixture()
def normas_teste():
    """Seed via fn_* do motor: norma 9999/2020 alterada pela 9998/2021."""
    from db.legislacao import get_conn, init_legislacao_db

    init_legislacao_db()

    def _limpar(conn):
        conn.execute(
            """
            DO $$
            DECLARE v_ids BIGINT[];
            BEGIN
                SELECT array_agg(id_norma) INTO v_ids FROM norma
                 WHERE tipo = 'Lei' AND numero IN ('9999','9998')
                   AND ano IN (2020, 2021);
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

    with get_conn() as conn:
        _limpar(conn)

        id_a = conn.execute(
            "SELECT fn_criar_norma('Lei', '9999', 2020::smallint, '2020-01-01'::date, "
            "'Lei de teste do Amanuense', NULL, 'Lei Teste')"
        ).fetchone()[0]
        id_b = conn.execute(
            "SELECT fn_criar_norma('Lei', '9998', 2021::smallint, '2021-01-01'::date, "
            "'Lei alteradora de teste')"
        ).fetchone()[0]

        art1 = conn.execute(
            "SELECT fn_inserir_dispositivo(%s, 'artigo', 'Art. 1º', 'art1', "
            "'Texto original do artigo primeiro.', 1, '2020-01-01'::date)",
            (id_a,),
        ).fetchone()[0]
        conn.execute(
            "SELECT fn_inserir_dispositivo(%s, 'paragrafo', '§ 1º', 'art1_par1', "
            "'Parágrafo do artigo primeiro.', 1, '2020-01-01'::date, p_id_pai => %s)",
            (id_a, art1),
        )
        art2 = conn.execute(
            "SELECT fn_inserir_dispositivo(%s, 'artigo', 'Art. 2º', 'art2', "
            "'Texto do artigo segundo.', 2, '2020-01-01'::date)",
            (id_a,),
        ).fetchone()[0]

        conn.execute(
            "SELECT fn_registrar_alteracao(%s, 'Texto novo do artigo primeiro.', "
            "%s, '2021-06-01'::date)",
            (art1, id_b),
        )
        conn.execute(
            "SELECT fn_registrar_revogacao(%s, %s, '2021-06-01'::date)",
            (art2, id_b),
        )
        # Remissão interna: art. 2º remete ao art. 1º (INSERT direto é permitido
        # em relacao_normativa — a proibição cobre só as tabelas de versão)
        conn.execute(
            "INSERT INTO relacao_normativa (id_norma_origem, id_dispositivo_origem, "
            "tipo_relacao, id_norma_destino, id_dispositivo_destino, data_efeito) "
            "VALUES (%s, %s, 'remete', %s, %s, '2020-01-01')",
            (id_a, art2, id_a, art1),
        )
        conn.commit()

    yield {"id_a": id_a, "id_b": id_b, "art1": art1, "art2": art2}

    with get_conn() as conn:
        _limpar(conn)
        conn.commit()


@requer_pg
def test_indice_de_leis(client, normas_teste):
    resp = client.get("/api/leis")
    assert resp.status_code == 200
    leis = {lei["id_norma"]: lei for lei in resp.json()["leis"]}

    lei = leis[normas_teste["id_a"]]
    assert lei["apelido"] == "Lei Teste"
    assert lei["num_dispositivos"] == 3
    assert lei["num_alterados"] == 2  # art1 (alteração) + art2 (revogação)


@requer_pg
def test_texto_da_lei(client, normas_teste):
    resp = client.get(f"/api/leis/{normas_teste['id_a']}")
    assert resp.status_code == 200
    data = resp.json()

    assert data["norma"]["numero"] == "9999"
    disps = data["dispositivos"]
    assert [d["id_canonico"] for d in disps] == ["art1", "art1_par1", "art2"]
    assert [d["nivel"] for d in disps] == [0, 1, 0]

    art1, par1, art2 = disps
    assert art1["situacao"] == "vigente"
    assert art1["texto"] == "Texto novo do artigo primeiro."
    assert art1["num_versoes"] == 2
    assert art1["redacao_dada_por"] == "Lei 9998/2021"
    assert art1["num_conexoes"] == 1  # remissão recebida; 'altera' fica no histórico

    assert par1["num_versoes"] == 1
    assert par1["num_conexoes"] == 0

    assert art2["situacao"] == "revogado"
    assert art2["texto"] is None
    assert art2["num_conexoes"] == 1  # remissão feita; 'revoga' fica no histórico


@requer_pg
def test_historico_do_dispositivo(client, normas_teste):
    resp = client.get(
        f"/api/leis/{normas_teste['id_a']}/dispositivos/{normas_teste['art1']}/historico"
    )
    assert resp.status_code == 200
    data = resp.json()

    assert data["dispositivo"]["numero_rotulo"] == "Art. 1º"
    v1, v2 = data["versoes"]
    assert v1["evento"] == "redacao_original"
    assert v1["vigente_ate"] == "2021-06-01"
    assert v2["evento"] == "alteracao"
    assert v2["vigente_ate"] is None
    assert v2["por_norma"] == "Lei 9998/2021"


@requer_pg
def test_conexoes_do_dispositivo(client, normas_teste):
    # art1 recebe a remissão (passiva)
    resp = client.get(
        f"/api/leis/{normas_teste['id_a']}/dispositivos/{normas_teste['art1']}/conexoes"
    )
    assert resp.status_code == 200
    conexoes = resp.json()["conexoes"]
    assert len(conexoes) == 1
    assert conexoes[0]["tipo_relacao"] == "remete"
    assert conexoes[0]["direcao"] == "passiva"
    assert conexoes[0]["outro_rotulo"] == "Art. 2º"

    # art2 faz a remissão (ativa)
    resp = client.get(
        f"/api/leis/{normas_teste['id_a']}/dispositivos/{normas_teste['art2']}/conexoes"
    )
    conexoes = resp.json()["conexoes"]
    assert len(conexoes) == 1
    assert conexoes[0]["direcao"] == "ativa"
    assert conexoes[0]["outro_rotulo"] == "Art. 1º"


@requer_pg
def test_404s(client, normas_teste):
    assert client.get("/api/leis/999999999").status_code == 404
    # dispositivo existe, mas não pertence à norma B
    resp = client.get(
        f"/api/leis/{normas_teste['id_b']}/dispositivos/{normas_teste['art1']}/historico"
    )
    assert resp.status_code == 404
