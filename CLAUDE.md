# Amanuense — Instruções para Claude Code

## O que é o projeto

Pipeline multi-agente Python que transforma PDFs de normas jurídicas (foco BCB/Pix) em grafos de conhecimento navegáveis. Usa DeepSeek-V3 como LLM via API compatível com OpenAI. O cliente se chama `ClaudeClient` por razão histórica — internamente usa `openai.OpenAI` apontando para `api.deepseek.com`.

## Stack

- Python 3.11, Pydantic v2, Click, Rich, tiktoken
- `pdfplumber` + `pymupdf` para extração de PDF; `pytesseract` + `Pillow` para OCR opcional
- `networkx` para manipulação de grafo
- Frontend: HTML/JS + D3.js, sem build step
- LLM: DeepSeek-V3 (`deepseek-chat`)
- API HTTP: FastAPI + SQLAlchemy + Alembic (extras opcionais em `.[api]`)
- Orquestração: Docker Compose (targets `web` e `api`)

## Estrutura crítica

```
pipeline/
  agents/          # Um arquivo por agente — corpus_scanner, norm_analyzer, …
  graph/           # builder.py (agente 7), vigency.py, exporter.py, traversal.py
  parsers/         # structure_parser.py + bcb_patterns.py — extração PDF → Markdown
  prompts/         # Prompt de sistema de cada agente (arquivo .md)
  schemas/         # Todos os tipos Pydantic — fonte da verdade do grafo
  utils/
    claude_client.py   # LLMClient (alias ClaudeClient)
    id_factory.py      # norma_id(), artigo_id(), inciso_id(), paragrafo_id()
    llm_helpers.py     # parse_json_response(), batch_call()
  config.py            # Dirs e thresholds via variáveis de ambiente
  corpus_registry.py   # Carregamento de metadados de documentos
  run.py               # CLI principal (Click) — AGENT_SEQUENCE, _run_agent()

api/               # FastAPI: /api/corpus (CRUD) + /api/run (trigger pipeline)
db/                # SQLAlchemy models (CorpusDocument, PipelineRun) + migrations Alembic
```

Cada agente lê de `intermediate/<run-id>/` e escreve seu output lá. O `graph-builder` consome todos os intermediários e escreve em `output/`.

## Sequência de agentes (AGENT_SEQUENCE em pipeline/run.py)

| # | Nome | Usa LLM | Arquivo |
|---|------|---------|---------|
| 1 | `corpus-scanner` | Não | `agents/corpus_scanner.py` |
| 2 | `norm-analyzer` | Sim | `agents/norm_analyzer.py` |
| 3 | `hierarchy-analyzer` | Não | `agents/hierarchy_analyzer.py` |
| 4 | `revocation-analyzer` | Não | `agents/revocation_analyzer.py` |
| 5 | `implication-analyzer` | Sim | `agents/implication_analyzer.py` |
| 6 | `domain-analyzer` | Sim | `agents/domain_analyzer.py` |
| 7 | `graph-builder` | Não | `graph/builder.py` |
| 8 | `graph-reviewer` | Sim | `agents/graph_reviewer.py` |
| 9 | `tour-builder` | Sim | `agents/tour_builder.py` |

## Schemas (pipeline/schemas/)

- `node.py` — `GraphNode`, `NodeType` (13 tipos), `VigencyStatus` (vigente/revogado/suspenso/alterado), `NormativeLayer` (7 camadas), `VigenciaMeta`, `NormaMeta`
- `edge.py` — `GraphEdge`, `EdgeType` (31 tipos), `EDGE_DEFAULT_WEIGHTS`, `REVOCATION_EDGE_TYPES`
- `graph.py` — `KnowledgeGraph`, `Layer`, `TourStep`
- `outputs.py` — `VigencyIndex`, `DiffLog`, `CorpusTexts` (arquivos gerados em `output/`)

Arestas inferidas por LLM têm campo `confidence` (0.70–1.0). Abaixo do threshold: `review_required = True`.

## Sistema de vigência

`graph/vigency.py` implementa `apply_vigency_updates()` e `propagate_revocation()`. O `graph-builder` propaga revogações em cascata: uma norma revogada marca todos os seus filhos. Alterações parciais (artigo individual) não afetam o status da norma-mãe. O resultado fica em `output/vigency-index.json`.

## LLMClient (pipeline/utils/claude_client.py)

- Wrapper sobre `openai.OpenAI` apontando para `https://api.deepseek.com`
- Modelo configurável via `AMANUENSE_MODEL` (padrão: `deepseek-chat`)
- Rastreia tokens e calcula custo em USD (`total_cost_usd`)
- `call(system, user, max_retries=3)` com retry exponencial
- **NÃO** é a API da Anthropic — o nome `ClaudeClient` é legado

## Convenções

- IDs de nós: sempre usar `norma_id()`, `artigo_id()`, `inciso_id()`, `paragrafo_id()` de `id_factory.py`
- Schemas: sempre em `pipeline/schemas/` — o `graph-builder` valida com `model_validate`
- Prompts: em `pipeline/prompts/<agent-name>.md` — `BaseAgent.load_prompt()` resolve o path
- Novos agentes: herdar de `BaseAgent`, implementar `run(intermediate_dir, corpus_dir)`, registrar em `AGENT_SEQUENCE` e `_run_agent()` em `pipeline/run.py`

## Comandos úteis

```bash
# Ambiente
python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
pip install -e ".[api]"   # FastAPI + SQLAlchemy + Alembic

# Converter PDFs
python scripts/parse_pdfs.py

# Rodar pipeline
amanuense run
amanuense run --resume             # pula agentes já processados
amanuense run --agent <nome>       # roda só um agente
amanuense run --file <stem>        # processa só um documento
amanuense run --run-id <id>        # ID customizado

# Validar e servir
amanuense validate
amanuense serve                    # http://localhost:8080

# API HTTP
uvicorn api.main:app --reload

# Docker
docker-compose up

# Migrations
alembic upgrade head

# Qualidade
pytest
ruff check pipeline/
mypy pipeline/
```

## O que NÃO fazer

- Não commitar `.env`, `corpus/raw/`, `corpus/parsed/`, `intermediate/`
- Não mudar a assinatura `run(intermediate_dir, corpus_dir)` dos agentes sem atualizar todos
- Não criar novos schemas fora de `pipeline/schemas/` — o `graph-builder` valida com `model_validate`
- Não usar `ClaudeClient` para chamar a API real da Anthropic — o nome é alias do DeepSeek
- Não adicionar dependências novas sem atualizar `pyproject.toml`
