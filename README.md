# Amanuense

> ## ⚠️ TEMPORÁRIO — REMOVER ASSIM QUE POSSÍVEL: bypass de review na `main`
>
> Em **2026-06-22** o ruleset `protect-main` recebeu um **bypass para o papel
> "Repository admin"** (`bypass_mode: always`). Motivo: o time tem apenas 2 admins e o
> GitHub não permite aprovar o próprio PR, o que impedia o merge do release `dev → main`
> (regra exige 1 aprovação humana).
>
> **Isto enfraquece a proteção de produção.** Remover o bypass assim que houver um
> revisor disponível (terceiro colaborador ou aprovação do outro admin):
> `Settings → Rules → Rulesets → protect-main → Bypass list → remover "Repository admin"`
> (ou `gh api --method PUT repos/ForjaDosDias/Amanuense2/rulesets/17849701` com `"bypass_actors": []`).

Pipeline multi-agente que transforma PDFs de normas jurídicas em um grafo de conhecimento navegável, com foco inicial no ecossistema regulatório Pix/BCB.

```
PDF de norma → 9 agentes → knowledge-graph.json → visualizador D3.js
```

## O que faz

1. Você coloca PDFs em `corpus/raw/`
2. O pipeline extrai estrutura (artigos, incisos, parágrafos), detecta relações entre normas por regex e enriquece com LLM (DeepSeek-V3)
3. O resultado é um grafo interativo navegável no browser, com rastreamento de vigência (quem revogou quem, o que está em vigor)

## Instalação

```bash
python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
cp .env.example .env   # preencha DEEPSEEK_API_KEY
```

Para a API HTTP e banco de dados:

```bash
pip install -e ".[api]"
```

## Uso rápido

```bash
# Converter PDFs para Markdown
python scripts/parse_pdfs.py

# Rodar o pipeline completo
amanuense run

# Visualizar no browser (http://localhost:8080)
amanuense serve
```

## CLI

```bash
amanuense run                             # pipeline completo
amanuense run --resume                    # pula agentes já processados
amanuense run --agent norm-analyzer       # roda só um agente
amanuense run --file resolucao-bcb-001    # processa só um documento
amanuense run --run-id meu-run-2024       # ID customizado para o run

amanuense validate                        # valida knowledge-graph.json
amanuense validate output/meu-grafo.json  # valida arquivo específico

amanuense serve                           # frontend em http://localhost:8080
amanuense serve --port 3000
```

## Sequência de agentes

O pipeline executa 10 agentes em sequência. Cada um lê de `intermediate/<run-id>/` e escreve seu output lá.

| # | Agente | O que faz | Usa LLM |
|---|--------|-----------|---------|
| 1 | `corpus-scanner` | Inventaria `corpus/raw/`, auto-converte PDFs para Markdown | Não |
| 2 | `legislation-loader` | Gera a árvore canônica de cada norma e a carrega na base estruturada (PostgreSQL) via funções do motor de versionamento | Não |
| 3 | `norm-analyzer` | Extrai nós do grafo da árvore canônica (normas, artigos, §§, incisos, alíneas) e gera summaries + tags | Sim |
| 4 | `hierarchy-analyzer` | Cria arestas de hierarquia normativa (ex: resolução regulamenta circular) | Não |
| 5 | `revocation-analyzer` | Detecta revogações e alterações por regex e as registra na base estruturada | Não |
| 6 | `implication-analyzer` | Infere relações implícitas entre artigos com score de confiança | Sim |
| 7 | `domain-analyzer` | Extrai nós de domínio: definições legais, prazos, papéis institucionais | Sim |
| 8 | `graph-builder` | Monta o grafo final; vigência, textos e versões vêm da base estruturada | Não |
| 9 | `graph-reviewer` | Revisão de qualidade (interativa ou auto-approve se confiança ≥ 0.85) | Sim |
| 10 | `tour-builder` | Cria roteiros temáticos para 4 perfis (advogado, compliance, técnico, gestor) | Sim |

Os agentes que usam LLM têm prompts de sistema em `pipeline/prompts/<agent-name>.md`.

## Saídas geradas

Após `amanuense run`, o diretório `output/` conterá:

| Arquivo | Conteúdo |
|---------|----------|
| `knowledge-graph.json` | Grafo completo: nós + arestas + metadados de vigência |
| `vigency-index.json` | Status de cada norma (vigente / revogado / suspenso / alterado) |
| `diff-log.json` | Histórico de revogações e alterações detectadas |
| `corpus-texts.json` | Textos completos dos artigos para referência |
| `graph-data.js` | Versão JS dos dados do grafo para o frontend |
| `vigency-data.js` | Versão JS do índice de vigência para o frontend |

## Estrutura do projeto

```
pipeline/
  agents/          # Um arquivo por agente da sequência
  graph/           # builder.py, vigency.py, exporter.py, traversal.py
  parsers/         # Extração estrutural de PDFs → Markdown (artigos, incisos, alíneas)
  prompts/         # Prompts de sistema de cada agente (.md)
  schemas/         # Modelos Pydantic — fonte da verdade do grafo
  utils/           # LLMClient, id_factory.py, llm_helpers.py

api/               # FastAPI: upload de PDFs + trigger de pipeline via HTTP
db/                # SQLAlchemy models (CorpusDocument, PipelineRun) + migrations Alembic
  sql/             # DDL canônico da base de legislação estruturada (PostgreSQL)
  legislacao.py    # Conexão psycopg3 + bootstrap idempotente (amanuense initdb)

frontend/          # Visualizador HTML/JS + D3.js (sem build step)
scripts/           # parse_pdfs.py, validate_graph.py, check_vigency.py
corpus/
  raw/             # PDFs de entrada (ignorado pelo git)
  parsed/          # Markdown extraído (gerado automaticamente)
  registry.json    # Metadados de cada documento
output/            # Arquivos gerados pelo pipeline
intermediate/      # Estado entre runs (ignorado pelo git)
```

## Schemas (pipeline/schemas/)

Todos os tipos são Pydantic v2. Novos tipos sempre vão aqui, nunca inline nos agentes.

- **`node.py`** — `GraphNode`, `NodeType`, `VigencyStatus`, `NormativeLayer`, `VigenciaMeta`, `NormaMeta`
- **`edge.py`** — `GraphEdge`, `EdgeType` (31 tipos de relação), `EDGE_DEFAULT_WEIGHTS`
- **`graph.py`** — `KnowledgeGraph`, `Layer`, `TourStep`
- **`outputs.py`** — `VigencyIndex`, `DiffLog`, `CorpusTexts`
- **`legislacao.py`** — `NormaCanonica`, `DispositivoCanonico`, `EventoHistorico` (árvore canônica intermediária entre parsing e carga)

### Tipos de aresta (principais)

O grafo suporta 31 tipos de relação. Alguns exemplos:

| Categoria | Tipos |
|-----------|-------|
| Hierarquia | `regulamenta`, `complementa`, `institui` |
| Revogação | `revoga_expressamente`, `revoga_tacitamente`, `altera` |
| Implicação | `obriga`, `proibe`, `condiciona`, `excepciona`, `define` |
| Domínio | `classifica`, `exemplifica`, `referencia` |

Arestas inferidas por LLM carregam um score de confiança (0.70–1.0). Arestas abaixo do threshold são marcadas `review_required = True`.

## Base de legislação estruturada (PostgreSQL)

Com `LEGISLACAO_DATABASE_URL` definida, as leis passam a ser armazenadas em
uma base PostgreSQL 14+ que é a **fonte da verdade**: identidade estável de
cada dispositivo (`id_canonico`, ex.: `art5_par2_inc3`), redações versionadas
com vigência temporal `[inicio, fim)` sem sobreposição (EXCLUDE gist) e
relações normativas (altera/revoga/acrescenta). O grafo é derivado dela.

- DDL canônico em `db/sql/` (`01_schema.sql`, `02_versionamento.sql`) —
  aplicado por `amanuense initdb`, **nunca** por ORM/Alembic
- Toda mutação passa pelas funções do motor (`fn_criar_norma`,
  `fn_inserir_dispositivo`, `fn_registrar_alteracao`,
  `fn_registrar_revogacao`); INSERT direto nas tabelas de versão é proibido
- Consulta temporal: `fn_consultar_dispositivo(id_norma, id_canonico, data)`
  → vigente / revogado / inexistente na data; `fn_texto_consolidado` monta o
  texto compilado em qualquer data
- Anti-alucinação: todo texto vem do parsing da fonte oficial; o que o parser
  não interpreta com confiança vai para a fila de revisão manual
  (`legislation_loader.json` → `review_queue`), nunca é inferido
- `amanuense initdb --with-demo` aplica `db/sql/03_demo_lgpd.sql` (exemplo
  ilustrativo com a LGPD)

```bash
docker compose up -d postgres
export LEGISLACAO_DATABASE_URL=postgresql://amanuense:amanuense@localhost:5432/legislacao
amanuense initdb
amanuense run
```

Sem a variável, o pipeline roda em **modo legado** (somente JSON, sem
versionamento temporal).

## Vigência

Com a base estruturada habilitada, status, datas e cascata de revogação dos
nós normativos vêm do motor de versionamento. No modo legado, o
`graph-builder` aplica e propaga vigência em cascata:

- Uma norma marcada como `revogada` propaga o status para seus artigos
- Alterações parciais (um artigo revogado) não afetam o status da norma-mãe
- O `vigency-index.json` registra o status final de cada nó com a cadeia de evidências

## Variáveis de ambiente

| Variável | Padrão | Descrição |
|----------|--------|-----------|
| `DEEPSEEK_API_KEY` | — | Chave da API DeepSeek (obrigatória) |
| `AMANUENSE_MODEL` | `deepseek-chat` | Modelo a usar |
| `AMANUENSE_MAX_TOKENS` | `8192` | Máximo de tokens por chamada LLM |
| `AMANUENSE_CORPUS_DIR` | `corpus` | Diretório do corpus |
| `AMANUENSE_OUTPUT_DIR` | `output` | Diretório de saída |
| `AMANUENSE_INTERMEDIATE_DIR` | `intermediate` | Estado intermediário entre runs |
| `LEGISLACAO_DATABASE_URL` | — | PostgreSQL da base de legislação estruturada (opcional; sem ela, modo legado) |

## API HTTP (opcional)

Uma API FastAPI permite operar o pipeline sem CLI:

```bash
uvicorn api.main:app --reload
```

Endpoints disponíveis:

| Método | Rota | Função |
|--------|------|--------|
| `GET` | `/api/corpus` | Lista documentos do corpus |
| `POST` | `/api/corpus/upload` | Faz upload de um PDF |
| `DELETE` | `/api/corpus/{doc_id}` | Remove um documento |
| `POST` | `/api/run` | Inicia o pipeline |

## Docker

```bash
docker-compose up
```

Sobe dois containers: `amanuense` (frontend + Nginx) e `amanuense-api` (FastAPI). Os diretórios `corpus/`, `output/` e `intermediate/` são volumes compartilhados.

## Corpus MVP (Pix/BCB)

Os documentos abaixo são reconhecidos automaticamente pelo `corpus-scanner` pelo nome do arquivo:

- `resolucao-bcb-001-2020` — Regulamento do arranjo Pix
- `circular-bcb-3952-2019` — Regulamenta o arranjo Pix
- `circular-bcb-4027-2020` — Altera o Regulamento Pix (ITP)
- `circular-bcb-4080-2021` — Requisitos e procedimentos complementares
- `manual-requisitos-tecnicos-pix` — Manual de Requisitos Técnicos
- `manual-seguranca-pix` — Manual de Segurança

## Testes e qualidade

```bash
pytest
ruff check pipeline/
mypy pipeline/
```

## Convenções para contribuição

- IDs de nós: usar sempre `norma_id()`, `artigo_id()`, `inciso_id()`, `paragrafo_id()` de `pipeline/utils/id_factory.py`
- Novos schemas: sempre em `pipeline/schemas/` — o `graph-builder` valida com `model_validate`
- Novos prompts: em `pipeline/prompts/<agent-name>.md` — `BaseAgent.load_prompt()` resolve o path
- Novos agentes: herdar de `BaseAgent`, implementar `run(intermediate_dir, corpus_dir)`, registrar em `AGENT_SEQUENCE` e `_run_agent()` em `pipeline/run.py`
- `LLMClient` (importado como `ClaudeClient` em código legado) usa DeepSeek-V3 via OpenAI SDK — não é a API da Anthropic
