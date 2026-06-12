"""Endpoints de leitura da Base de Legislação Estruturada (PostgreSQL).

Alimentam a visualização "Texto das Leis" do frontend: índice de normas,
texto vigente dispositivo a dispositivo, histórico de redações e conexões
normativas. Somente leitura — toda mutação continua passando pelas fn_* do
motor (ver db/sql/).
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException

from db.legislacao import get_conn, legislacao_enabled

router = APIRouter(prefix="/api/leis", tags=["leis"])

# Relações em que o dispositivo é o DESTINO e que já aparecem no histórico
# de redações (geradas pelas fn_* do motor) — não contam como "conexões".
_RELACOES_DE_HISTORICO = ("altera", "revoga", "acrescenta")


def _cursor(conn):
    from psycopg.rows import dict_row

    return conn.cursor(row_factory=dict_row)


def _exigir_base():
    if not legislacao_enabled():
        raise HTTPException(
            503,
            "Base de legislação estruturada desabilitada — defina "
            "LEGISLACAO_DATABASE_URL e rode `amanuense initdb`.",
        )


def _norma_label(tipo: str | None, numero: str | None, ano) -> str | None:
    if not tipo:
        return None
    return f"{tipo} {numero}/{ano}"


# ── Índice ────────────────────────────────────────────────────────────────────

@router.get("")
def listar_leis():
    _exigir_base()
    with get_conn() as conn, _cursor(conn) as cur:
        rows = cur.execute(
            """
            SELECT n.id_norma, n.tipo, n.numero, n.ano, n.apelido, n.nome_oficial,
                   n.ementa, n.status, n.data_publicacao, n.orgao_emissor,
                   (SELECT count(*) FROM dispositivo d
                     WHERE d.id_norma = n.id_norma)                  AS num_dispositivos,
                   (SELECT count(DISTINCT dv.id_dispositivo)
                      FROM dispositivo d
                      JOIN dispositivo_versao dv ON dv.id_dispositivo = d.id_dispositivo
                     WHERE d.id_norma = n.id_norma
                       AND dv.numero_versao > 1)                     AS num_alterados,
                   (SELECT coalesce(max(v.numero_versao), 1)
                      FROM versao_norma v
                     WHERE v.id_norma = n.id_norma)                  AS num_versoes
            FROM norma n
            ORDER BY n.ano DESC, n.tipo, n.numero
            """
        ).fetchall()
    return {"leis": rows}


# ── Texto da lei (dispositivos vigentes, em ordem de documento) ───────────────

@router.get("/{id_norma}")
def detalhar_lei(id_norma: int):
    _exigir_base()
    with get_conn() as conn, _cursor(conn) as cur:
        norma = cur.execute(
            """
            SELECT id_norma, tipo, numero, ano, apelido, nome_oficial, ementa,
                   status, data_publicacao, orgao_emissor, esfera, urn_lexml
            FROM norma WHERE id_norma = %s
            """,
            (id_norma,),
        ).fetchone()
        if not norma:
            raise HTTPException(404, "Norma não encontrada")

        agrupamentos = cur.execute(
            """
            SELECT id_agrupamento, tipo, numero_rotulo, nome, id_pai
            FROM agrupamento
            WHERE id_norma = %s
            ORDER BY ordem_sequencial
            """,
            (id_norma,),
        ).fetchall()

        dispositivos = cur.execute(
            """
            WITH RECURSIVE arvore AS (
                SELECT d.id_dispositivo, d.tipo, d.numero_rotulo, d.id_canonico,
                       d.id_agrupamento,
                       ARRAY[d.ordem_sequencial] AS caminho, 0 AS nivel
                FROM dispositivo d
                WHERE d.id_norma = %s AND d.id_pai IS NULL

                UNION ALL

                SELECT f.id_dispositivo, f.tipo, f.numero_rotulo, f.id_canonico,
                       f.id_agrupamento,
                       a.caminho || f.ordem_sequencial, a.nivel + 1
                FROM dispositivo f
                JOIN arvore a ON f.id_pai = a.id_dispositivo
            )
            SELECT a.id_dispositivo, a.tipo, a.numero_rotulo, a.id_canonico,
                   a.id_agrupamento, a.nivel,
                   dv.texto, dv.numero_versao,
                   CASE WHEN dv.evento = 'revogacao' THEN 'revogado'
                        ELSE 'vigente' END                            AS situacao,
                   dv.data_inicio_vigencia                            AS vigente_desde,
                   alt.tipo || ' ' || alt.numero || '/' || alt.ano    AS redacao_dada_por,
                   (SELECT count(*) FROM dispositivo_versao h
                     WHERE h.id_dispositivo = a.id_dispositivo)       AS num_versoes,
                   (SELECT count(*) FROM relacao_normativa r
                     WHERE r.id_dispositivo_origem = a.id_dispositivo
                        OR (r.id_dispositivo_destino = a.id_dispositivo
                            AND r.tipo_relacao <> ALL(%s)))           AS num_conexoes
            FROM arvore a
            JOIN dispositivo_versao dv
              ON dv.id_dispositivo = a.id_dispositivo
             AND dv.data_fim_vigencia IS NULL
            LEFT JOIN norma alt ON alt.id_norma = dv.norma_alteradora_id
            ORDER BY a.caminho
            """,
            (id_norma, list(_RELACOES_DE_HISTORICO)),
        ).fetchall()

    return {"norma": norma, "agrupamentos": agrupamentos, "dispositivos": dispositivos}


# ── Histórico de redações de um dispositivo ───────────────────────────────────

@router.get("/{id_norma}/dispositivos/{id_dispositivo}/historico")
def historico_dispositivo(id_norma: int, id_dispositivo: int):
    _exigir_base()
    with get_conn() as conn, _cursor(conn) as cur:
        disp = _carregar_dispositivo(cur, id_norma, id_dispositivo)
        versoes = cur.execute(
            """
            SELECT dv.numero_versao, dv.evento, dv.texto,
                   dv.data_inicio_vigencia AS vigente_de,
                   dv.data_fim_vigencia    AS vigente_ate,
                   alt.id_norma            AS norma_alteradora_id,
                   alt.tipo  AS alt_tipo, alt.numero AS alt_numero,
                   alt.ano   AS alt_ano,  alt.apelido AS alt_apelido
            FROM dispositivo_versao dv
            LEFT JOIN norma alt ON alt.id_norma = dv.norma_alteradora_id
            WHERE dv.id_dispositivo = %s
            ORDER BY dv.numero_versao
            """,
            (id_dispositivo,),
        ).fetchall()

    for v in versoes:
        v["por_norma"] = _norma_label(v.pop("alt_tipo"), v.pop("alt_numero"), v.pop("alt_ano"))
        v["por_norma_apelido"] = v.pop("alt_apelido")
    return {"dispositivo": disp, "versoes": versoes}


# ── Conexões normativas de um dispositivo ─────────────────────────────────────

@router.get("/{id_norma}/dispositivos/{id_dispositivo}/conexoes")
def conexoes_dispositivo(id_norma: int, id_dispositivo: int):
    _exigir_base()
    with get_conn() as conn, _cursor(conn) as cur:
        disp = _carregar_dispositivo(cur, id_norma, id_dispositivo)
        rows = cur.execute(
            """
            SELECT r.tipo_relacao, r.data_efeito, r.observacao,
                   CASE WHEN r.id_dispositivo_origem = %(id)s
                        THEN 'ativa' ELSE 'passiva' END AS direcao,
                   o.id_norma  AS outra_norma_id,
                   o.tipo AS o_tipo, o.numero AS o_numero, o.ano AS o_ano,
                   o.apelido AS outra_norma_apelido,
                   od.id_dispositivo AS outro_dispositivo_id,
                   od.numero_rotulo  AS outro_rotulo,
                   od.id_canonico    AS outro_id_canonico
            FROM relacao_normativa r
            JOIN norma o
              ON o.id_norma = CASE WHEN r.id_dispositivo_origem = %(id)s
                                   THEN r.id_norma_destino
                                   ELSE r.id_norma_origem END
            LEFT JOIN dispositivo od
              ON od.id_dispositivo = CASE WHEN r.id_dispositivo_origem = %(id)s
                                          THEN r.id_dispositivo_destino
                                          ELSE r.id_dispositivo_origem END
            WHERE r.id_dispositivo_origem = %(id)s
               OR (r.id_dispositivo_destino = %(id)s
                   AND r.tipo_relacao <> ALL(%(historico)s))
            ORDER BY r.data_efeito NULLS LAST, r.id_relacao
            """,
            {"id": id_dispositivo, "historico": list(_RELACOES_DE_HISTORICO)},
        ).fetchall()

    for r in rows:
        r["outra_norma"] = _norma_label(r.pop("o_tipo"), r.pop("o_numero"), r.pop("o_ano"))
    return {"dispositivo": disp, "conexoes": rows}


# ── Helpers ───────────────────────────────────────────────────────────────────

def _carregar_dispositivo(cur, id_norma: int, id_dispositivo: int) -> dict:
    disp = cur.execute(
        """
        SELECT d.id_dispositivo, d.tipo, d.numero_rotulo, d.id_canonico,
               n.tipo AS n_tipo, n.numero AS n_numero, n.ano AS n_ano,
               n.apelido AS norma_apelido
        FROM dispositivo d
        JOIN norma n ON n.id_norma = d.id_norma
        WHERE d.id_norma = %s AND d.id_dispositivo = %s
        """,
        (id_norma, id_dispositivo),
    ).fetchone()
    if not disp:
        raise HTTPException(404, "Dispositivo não encontrado nesta norma")
    disp["norma"] = _norma_label(disp.pop("n_tipo"), disp.pop("n_numero"), disp.pop("n_ano"))
    return disp
