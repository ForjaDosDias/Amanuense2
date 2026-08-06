# Amanuense — Instruções para Claude Code

## O que é o projeto

Pipeline multi-agente Python que transforma PDFs de normas jurídicas (foco BCB/Pix) em grafos de conhecimento navegáveis. Usa DeepSeek-V3 como LLM via API compatível com OpenAI. O cliente se chama `ClaudeClient` por razão histórica — internamente usa `openai.OpenAI` apontando para `api.deepseek.com`.

## Stack

- Python 3.11, Pydantic v2, Click, Rich
- `pdfplumber` + `pymupdf` para extração de PDF
- `networkx` para manipulação de grafo
- Frontend: HTML/JS, sem build step — grafo 3D imersivo via `3d-force-graph`/Three.js (CDN), com fallback 2D em D3.js
- LLM: DeepSeek-V3 (`deepseek-chat`)

## Estrutura crítica

```
pipeline/agents/     # Um arquivo por agente da sequência
pipeline/prompts/    # Prompt de sistema de cada agente (arquivo .md)
pipeline/schemas/    # Todos os tipos Pydantic — fonte da verdade do grafo
pipeline/graph/      # builder.py monta o grafo final a partir dos intermediários
pipeline/utils/claude_client.py  # LLMClient (alias ClaudeClient)
db/sql/              # DDL canônico da base de legislação estruturada (PostgreSQL)
db/legislacao.py     # Conexão psycopg3 + bootstrap idempotente da base
```

Cada agente lê de `intermediate/<run-id>/` e escreve seu output lá. O `graph-builder` consome todos os intermediários e escreve em `output/`.

## Base de legislação estruturada

Com `LEGISLACAO_DATABASE_URL` definida, a base PostgreSQL é a **fonte da verdade** das leis (identidade de dispositivos, redações versionadas com vigência `[inicio, fim)`, relações normativas); o grafo é derivado dela. Sem a variável, modo legado (somente JSON).

- O DDL canônico é o SQL em `db/sql/` — **nunca** recriar/gerenciar essas tabelas via SQLAlchemy/Alembic (o Alembic gerencia só `corpus_documents`/`pipeline_runs` no SQLite de `DATABASE_URL`).
- Toda mutação na base passa pelas funções do motor (`fn_criar_norma`, `fn_inserir_dispositivo`, `fn_registrar_alteracao`, `fn_registrar_revogacao`) — nunca INSERT direto em `dispositivo`/`dispositivo_versao`/`versao_norma`.
- Anti-alucinação: todo texto de dispositivo vem do parsing da fonte (árvore canônica em `intermediate/<run>/canonical_tree/`); o que não é interpretável com confiança vai para a fila de revisão manual, nunca é inferido por LLM.
- O agente `legislation-loader` (2º da sequência) gera as árvores e faz a carga cronológica e idempotente.

## Convenções

- Nomes de IDs de nós: gerados por `pipeline/utils/id_factory.py`. Nós normativos usam `norma_id()` e `disp_node_id(doc_id, id_canonico)`; o `id_canonico` é gerado pelas funções `canon_artigo()`, `canon_paragrafo()`, `canon_inciso()`, `canon_alinea()`, `canon_item()`, `canon_subitem()` (gramática: `art65`, `art5_par2_inc3`, `art7_parun`, `art55a`).
- Schemas Pydantic ficam em `pipeline/schemas/` — novos tipos vão lá, nunca inline nos agentes.
- Prompts de agentes ficam em `pipeline/prompts/<agent-name>.md` — o `BaseAgent.load_prompt()` resolve o path.
- Novos agentes herdam de `BaseAgent` e implementam `run(intermediate_dir, corpus_dir)`.
- Registrar o agente novo em `AGENT_SEQUENCE` e no `_run_agent()` em `pipeline/run.py`.

## Comandos úteis

```bash
# Ambiente
python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"

# Rodar
amanuense run
amanuense run --resume          # pula agentes já processados
amanuense run --agent <nome>    # roda só um agente
amanuense validate              # valida knowledge-graph.json
amanuense serve                 # frontend em http://localhost:8080

# Base de legislação estruturada (opcional, vira fonte da verdade)
docker compose up -d postgres
export LEGISLACAO_DATABASE_URL=postgresql://amanuense:amanuense@localhost:5432/legislacao
amanuense initdb                # aplica db/sql/ (idempotente); --with-demo p/ seed LGPD

# Converter PDFs
python scripts/parse_pdfs.py

# Qualidade
pytest
ruff check pipeline/
mypy pipeline/
```

## O que NÃO fazer

- Não commitar `.env`, `corpus/raw/`, `corpus/parsed/`, `intermediate/`.
- Não mudar a assinatura `run(intermediate_dir, corpus_dir)` dos agentes sem atualizar todos.
- Não criar novos schemas fora de `pipeline/schemas/` — o `graph-builder` valida com `model_validate`.
- Não usar `ClaudeClient` para chamar a API real da Anthropic — o nome é alias do DeepSeek.
- Não tocar as tabelas da base de legislação via ORM/Alembic nem INSERT direto — DDL é `db/sql/`, mutação é via `fn_*`.

## Fluxo de trabalho e Git

> Regra da frota — idêntica nos 5 projetos da VPS. Atualizada em 2026-08-06.

**Todo trabalho começa por um plano.** Levantar o que já existe, decidir a abordagem e só então
implementar.

**Ao final de todo plano, sincronizar tudo:**
```bash
git add -A && git commit -m "tipo: descrição"
git push origin main        # push direto — é o fluxo atual
git push origin main:dev    # mantém a dev alinhada
```

**Por que push direto na `main`:** nenhuma aplicação da VPS tem cliente hoje, e o gate de aprovação
humana do fluxo `feature → dev → main` só atrasa o desenvolvimento. Os `bypass_actors` de admin nos
rulesets são **intencionais**, não descuido.

**A `dev` é mantida em dia de propósito.** Ela não está em uso, mas fica idêntica à `main` para que
o fluxo com PR volte sem migração no dia em que houver cliente.

**Quando houver cliente:** remover os bypasses dos rulesets e voltar para `feature → dev → main` com
PR, check `test` verde e 1 aprovação humana. A esteira já está montada — só o bypass precisa sair.

Push na `main` dispara o deploy automático na VPS (self-hosted runner).

⚠️ **Commitar ANTES de qualquer push.** Este diretório é o alvo do deploy: todo push na `main`
dispara o workflow, que faz `git reset --hard FETCH_HEAD` aqui. Qualquer alteração não commitada
é **destruída** — aconteceu em 06/08/2026 com uma edição de CLAUDE.md.
