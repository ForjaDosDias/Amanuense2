/* Amanuense — Vade Mecum do Futuro */
"use strict";

const state = {
  graph: null,
  vigency: null,
  corpusTexts: null,
  diffLog: null,
  simulation: null,
  svg: null,
  selectedNodeId: null,
  filters: { nodeType: "all", status: "all", edgeType: "all", implicit: "all", minWeight: 0 },
  currentView: "graph",
  tourIndex: 0,
  tourStepIndex: 0,
  highlightedNodes: new Set(),
  // Texto das Leis (base de legislação estruturada)
  leis: { indexLoaded: false, currentLei: null },
  // 3D immersive mode
  graphMode: "3d",
  graph3d: null,
  adjacency: new Map(),
  hoverNode: null,
  hoverLink: null,
  selNeighbors: new Set(),
  autoOrbit: false,
};

const has3D = () => typeof ForceGraph3D !== "undefined";
const LABELED_TYPES = new Set(["norma", "papel", "entidade"]);

const $  = (id) => document.getElementById(id);
const $q = (sel) => document.querySelector(sel);

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  await loadCorpusList();

  // Reconnect to any pipeline that started before we opened the page
  const resumed = await resumeRunningPipeline();
  if (resumed) return;

  try {
    const resp = await fetch("/api/graph");
    if (!resp.ok) throw new Error("no graph");
    state.graph = await resp.json();
  } catch (_) {
    hideLoading();
    switchView("empty");
    return;
  }

  try {
    const ct = await fetch("/output/corpus-texts.json");
    if (ct.ok) state.corpusTexts = await ct.json();
  } catch (_) {}
  try {
    const dl = await fetch("/output/diff-log.json");
    if (dl.ok) state.diffLog = await dl.json();
  } catch (_) {}

  hideLoading();
  state.graphMode = (has3D() && localStorage.getItem("amanuense-graph-mode") !== "2d") ? "3d" : "2d";
  switchView("graph");
  populateSidebar();
  renderGraph();
  populateRoleSelect();
  populateHierarchyView();
  populateTimelineView();
  populateTourView();
  bindEvents();
}

function hideLoading() { $("loading").classList.add("hidden"); }

// ── Pipeline resume on load ───────────────────────────────────────────────────
async function resumeRunningPipeline() {
  try {
    const resp = await fetch("/api/runs");
    if (!resp.ok) return false;
    const { runs } = await resp.json();
    if (!runs.length) return false;

    const latest = runs[0];
    if (latest.status === "running") {
      hideLoading();
      switchView("pipeline");
      initAgentSteps();
      updatePipelineView("Retomando conexão…", 0);
      connectSSE(latest.id);
      return true;
    }
  } catch (_) {}
  return false;
}

// ── Corpus management ─────────────────────────────────────────────────────────
async function loadCorpusList() {
  try {
    const resp = await fetch("/api/corpus");
    if (!resp.ok) return;
    const { documents } = await resp.json();
    renderCorpusList(documents);
  } catch (_) {}
}

function renderCorpusList(docs) {
  const list = $("corpus-list");
  if (!docs.length) {
    list.innerHTML = `<div class="corpus-empty">Nenhum documento. Adicione PDFs acima.</div>`;
    $("run-btn").disabled = true;
    return;
  }

  list.innerHTML = docs.map(d => `
    <div class="corpus-item">
      <span class="corpus-status ${d.parsed ? 'parsed' : 'pending'}" title="${d.parsed ? 'Parseado ✓' : 'Aguardando parse'}">${d.parsed ? '✓' : '⏳'}</span>
      <span class="corpus-name" title="${escapeHtml(d.description || d.id)}">${escapeHtml(d.description || d.id)}</span>
      <button class="corpus-remove" data-id="${escapeHtml(d.id)}" title="Remover documento">✕</button>
    </div>
  `).join("");

  list.querySelectorAll(".corpus-remove").forEach(btn => {
    btn.addEventListener("click", () => removeDocument(btn.dataset.id));
  });

  $("run-btn").disabled = false;
}

async function removeDocument(docId) {
  try {
    await fetch(`/api/corpus/${encodeURIComponent(docId)}`, { method: "DELETE" });
    await loadCorpusList();
  } catch (e) {
    alert("Erro ao remover: " + e.message);
  }
}

async function handleUpload(files) {
  if (!files.length) return;
  const formData = new FormData();
  for (const f of files) formData.append("files", f);

  try {
    const resp = await fetch("/api/corpus/upload", { method: "POST", body: formData });
    if (!resp.ok) throw new Error(await resp.text());
    await loadCorpusList();
  } catch (e) {
    alert("Erro no upload: " + e.message);
  }
}

// ── Pipeline runner ───────────────────────────────────────────────────────────
async function startPipeline() {
  $("run-btn").disabled = true;

  let runId;
  try {
    const resp = await fetch("/api/run", { method: "POST" });
    if (!resp.ok) {
      const err = await resp.json();
      throw new Error(err.detail || "Erro ao iniciar");
    }
    ({ run_id: runId } = await resp.json());
  } catch (e) {
    $("run-btn").disabled = false;
    alert("Erro: " + e.message);
    return;
  }

  switchView("pipeline");
  initAgentSteps();
  updatePipelineView("Iniciando…", 0);
  connectSSE(runId);
}

function connectSSE(runId) {
  const es = new EventSource(`/api/status/${runId}`);
  es.onmessage = (e) => handleProgressEvent(JSON.parse(e.data), es);
  es.onerror = () => {
    es.close();
    // SSE dropped — poll runs endpoint to check if it finished while we were disconnected
    setTimeout(checkIfFinished, 2000);
  };
}

async function checkIfFinished() {
  try {
    const resp = await fetch("/api/runs");
    if (!resp.ok) return;
    const { runs } = await resp.json();
    const latest = runs[0];
    if (latest?.status === "done") {
      updatePipelineView("Concluído!", 100);
      setTimeout(() => window.location.reload(), 1200);
    } else if (latest?.status === "error") {
      switchView("empty");
      $("run-btn").disabled = false;
      alert("Erro no pipeline: " + (latest.error_message || "erro desconhecido"));
    } else if (latest?.status === "running") {
      // Still running — reconnect SSE
      setTimeout(() => connectSSE(latest.id), 3000);
    }
  } catch (_) {}
}

const AGENT_LABELS = {
  "corpus-scanner":      "Inventariando corpus",
  "norm-analyzer":       "Analisando normas",
  "hierarchy-analyzer":  "Mapeando hierarquia",
  "revocation-analyzer": "Detectando revogações",
  "implication-analyzer":"Detectando implicações",
  "domain-analyzer":     "Classificando domínios",
  "graph-builder":       "Construindo grafo",
  "graph-reviewer":      "Revisando grafo",
  "tour-builder":        "Gerando tours",
};

const AGENT_SEQUENCE_ORDER = Object.keys(AGENT_LABELS);

function initAgentSteps() {
  const ul = $("agent-steps");
  if (!ul) return;
  ul.innerHTML = AGENT_SEQUENCE_ORDER.map(agent => `
    <li class="agent-step" id="step-${agent}">
      <span class="agent-step-icon">○</span>
      <span>${AGENT_LABELS[agent]}</span>
    </li>
  `).join("");
}

function markAgentStep(agent, status) {
  const el = $(`step-${agent}`);
  if (!el) return;
  el.className = `agent-step ${status}`;
  const icon = status === "done" ? "✓" : status === "active" ? "▶" : "○";
  el.querySelector(".agent-step-icon").textContent = icon;
}

function handleProgressEvent(event, es) {
  if (event.type === "agent_start") {
    const pct = Math.round((event.index / event.total) * 100);
    const label = `Etapa ${event.index + 1} de ${event.total} — ${AGENT_LABELS[event.agent] || event.agent}`;
    updatePipelineView(label, pct);
    markAgentStep(event.agent, "active");
  }
  if (event.type === "agent_done") {
    const pct = Math.round(((event.index + 1) / event.total) * 100);
    const label = `Etapa ${event.index + 1} de ${event.total} — ${AGENT_LABELS[event.agent] || event.agent}`;
    updatePipelineView(label, pct);
    markAgentStep(event.agent, "done");
  }
  if (event.type === "done") {
    es.close();
    updatePipelineView("Concluído!", 100);
    // Mark all remaining as done
    AGENT_SEQUENCE_ORDER.forEach(a => {
      const el = $(`step-${a}`);
      if (el && !el.classList.contains("done")) markAgentStep(a, "done");
    });
    // Switch spinner to checkmark
    $("pipeline-spinner").style.display = "none";
    const wrap = $("pipeline-icon-wrap");
    wrap.innerHTML = `<div class="pipeline-done-icon">✓</div>`;
    $("pipeline-heading").textContent = "Pipeline concluído!";
    $("ver-grafo-btn").classList.remove("hidden");
    showToast("✓ Grafo gerado com sucesso — clique em Ver Grafo para explorar");
  }
  if (event.type === "error" || event.type === "agent_error") {
    es.close();
    switchView("empty");
    $("run-btn").disabled = false;
    showToast("Erro no pipeline: " + (event.message || "erro desconhecido"), "error");
  }
}

function updatePipelineView(label, pct) {
  $("progress-panel").classList.remove("hidden");
  $("progress-agent").textContent = label;
  $("progress-bar").style.width = pct + "%";
  $("pipeline-status-msg").textContent = label;
  $("progress-bar-main").style.width = pct + "%";
}

// ── Toast ─────────────────────────────────────────────────────────────────────
function showToast(msg, type = "success") {
  const toast = $("toast");
  $("toast-msg").textContent = msg;
  toast.className = `toast${type === "error" ? " toast-error" : ""}`;
  if (type !== "error") setTimeout(() => hideToast(), 8000);
}

function hideToast() {
  $("toast").classList.add("hidden");
}

// ── Sidebar Stats ──────────────────────────────────────────────────────────────
function populateSidebar() {
  const g = state.graph;
  const nodeCount = g.nodes.length;
  const edgeCount = g.links.length;
  const vigentCount = g.nodes.filter(n => n.status === "vigente").length;
  const revogadoCount = g.nodes.filter(n => n.status === "revogado").length;

  $("stats-bar").innerHTML = `
    <span>Nós: <b>${nodeCount}</b></span>
    <span>Arestas: <b>${edgeCount}</b></span>
    <span>Vigentes: <b style="color:#27ae60">${vigentCount}</b></span>
    <span>Revogados: <b style="color:#e74c3c">${revogadoCount}</b></span>
  `;

  const nodeTypes = [...new Set(g.nodes.map(n => n.type))].sort();
  const nodeTypeSelect = $("filter-node-type");
  nodeTypes.forEach(t => {
    const opt = document.createElement("option");
    opt.value = t; opt.textContent = t;
    nodeTypeSelect.appendChild(opt);
  });

  const edgeTypes = [...new Set(g.links.map(e => e.type))].sort();
  const edgeTypeSelect = $("filter-edge-type");
  edgeTypes.forEach(t => {
    const opt = document.createElement("option");
    opt.value = t; opt.textContent = t;
    edgeTypeSelect.appendChild(opt);
  });
}

// ── D3 Graph ──────────────────────────────────────────────────────────────────
function getFilteredData() {
  const f = state.filters;
  const g = state.graph;

  let nodes = g.nodes.filter(n => {
    if (f.nodeType !== "all" && n.type !== f.nodeType) return false;
    if (f.status !== "all" && n.status !== f.status) return false;
    return true;
  });
  const nodeIds = new Set(nodes.map(n => n.id));

  let links = g.links.filter(e => {
    if (!nodeIds.has(e.source) && !nodeIds.has(e.source?.id)) return false;
    if (!nodeIds.has(e.target) && !nodeIds.has(e.target?.id)) return false;
    if (f.edgeType !== "all" && e.type !== f.edgeType) return false;
    if (f.implicit !== "all" && String(e.implicit) !== f.implicit) return false;
    if (e.weight < f.minWeight) return false;
    return true;
  });

  return { nodes: nodes.map(n => ({ ...n })), links: links.map(e => ({ ...e })) };
}

function renderGraph() {
  if (state.graphMode === "3d" && has3D()) renderGraph3D();
  else renderGraph2D();
  syncGraphModeUI();
}

// ── 3D Immersive Graph (WebGL / three.js via 3d-force-graph) ─────────────────
function renderGraph3D() {
  const stage = $("graph-stage");
  stage.classList.remove("mode-2d");
  state.simulation = null;

  const data = getFilteredData();
  buildAdjacency(data);
  updateHudStats(data);
  renderLegend(data);

  if (!state.graph3d) initGraph3D();
  state.graph3d.graphData(data);
}

function initGraph3D() {
  const canvas = $("graph-canvas");
  canvas.innerHTML = "";

  let g;
  try {
    g = ForceGraph3D({ controlType: "orbit" })(canvas);      // factory API (kapsule)
  } catch (_) {
    g = new ForceGraph3D(canvas, { controlType: "orbit" });  // class API (>= v1.73)
  }
  state.graph3d = g;

  g.backgroundColor("rgba(0,0,0,0)")
    .width(canvas.clientWidth || 900)
    .height(canvas.clientHeight || 600)
    .showNavInfo(false)
    .nodeVal(nodeVal3D)
    .nodeResolution(16)
    .nodeOpacity(0.92)
    .nodeColor(nodeColor3D)
    .nodeLabel(n => `<div class="g3d-tip"><b>${escapeHtml(n.label || n.id)}</b><br><span>${n.type} · ${n.status || ""}</span></div>`)
    .linkColor(linkColor3D)
    .linkOpacity(0.32)
    .linkWidth(linkWidth3D)
    .linkCurvature(l => l.implicit ? 0.25 : 0)
    .linkLabel(l => `<div class="g3d-tip"><b>${escapeHtml(l.type)}</b><br><span>peso ${(l.weight ?? 0).toFixed(2)}${l.implicit ? " · implícita" : ""}</span></div>`)
    .linkDirectionalArrowLength(3.5)
    .linkDirectionalArrowRelPos(1)
    .linkDirectionalParticles(linkParticles3D)
    .linkDirectionalParticleWidth(1.5)
    .linkDirectionalParticleSpeed(l => 0.002 + (l.weight ?? 0.5) * 0.004)
    .onNodeClick(n => { selectNode(n.id); })
    .onNodeHover(n => {
      canvas.style.cursor = n ? "pointer" : null;
      state.hoverNode = n || null;
      refresh3DStyles();
    })
    .onLinkHover(l => {
      state.hoverLink = l || null;
      refresh3DStyles();
    })
    .onBackgroundClick(() => deselectNode());

  // Floating text labels for the most important node types
  if (typeof SpriteText !== "undefined") {
    g.nodeThreeObjectExtend(true).nodeThreeObject(n => {
      if (!LABELED_TYPES.has(n.type)) return undefined;
      const sprite = new SpriteText((n.label || n.id).substring(0, 28), 4.5, "rgba(226,235,246,0.95)");
      sprite.fontFace = "Georgia";
      sprite.backgroundColor = "rgba(8,16,32,0.45)";
      sprite.padding = 1.5;
      sprite.borderRadius = 2;
      sprite.position.set(0, -(4 * Math.cbrt(nodeVal3D(n)) + 5), 0);
      return sprite;
    });
  }

  const charge = g.d3Force("charge");
  if (charge) charge.strength(-170);

  const controls = g.controls();
  if (controls) {
    controls.autoRotateSpeed = 0.55;
    controls.autoRotate = state.autoOrbit;
  }

  // Cinematic fly-in on first render
  g.cameraPosition({ x: 0, y: 0, z: 1100 });
  setTimeout(() => { if (state.graph3d === g) g.zoomToFit(1800, 90); }, 900);
}

function destroyGraph3D() {
  if (state.graph3d) {
    try { state.graph3d._destructor(); } catch (_) {}
    state.graph3d = null;
  }
  state.hoverNode = null;
  state.hoverLink = null;
  $("graph-canvas").innerHTML = "";
}

const nodeVal3D = (n) => {
  if (n.type === "norma") return 14;
  if (n.type === "papel" || n.type === "entidade") return 8;
  if (n.type === "artigo") return 3;
  return 1.5;
};

function nodeColor3D(n) {
  const base = n.status === "revogado" ? "#67738a"
             : n.status === "suspenso" ? "#8d97a5"
             : (n.color || "#7f8c9b");
  if (state.highlightedNodes.has(n.id)) return "#ffd75e";
  if (n.id === state.selectedNodeId) return "#ffd75e";
  if (state.hoverNode) {
    if (n.id === state.hoverNode.id) return "#ffffff";
    if (state.adjacency.get(state.hoverNode.id)?.has(n.id)) return blendColor(base, "#ffffff", 0.3);
    return blendColor(base, "#0b1526", 0.7);
  }
  if (state.selectedNodeId) {
    if (state.selNeighbors.has(n.id)) return blendColor(base, "#ffffff", 0.2);
    return blendColor(base, "#0b1526", 0.6);
  }
  return base;
}

function isHoverLink(l) {
  if (state.hoverLink === l) return true;
  const s = l.source?.id ?? l.source, t = l.target?.id ?? l.target;
  if (state.hoverNode && (s === state.hoverNode.id || t === state.hoverNode.id)) return true;
  if (state.selectedNodeId && (s === state.selectedNodeId || t === state.selectedNodeId)) return true;
  return false;
}

function linkColor3D(l) {
  if (isHoverLink(l)) return "#ffd75e";
  const base = l.color || "#5577aa";
  return l.implicit ? blendColor(base, "#0b1526", 0.35) : base;
}

const linkWidth3D = (l) => isHoverLink(l) ? 1.8 : 0.4 + (l.weight ?? 0.5) * 1.0;
const linkParticles3D = (l) => isHoverLink(l) ? 4 : ((l.weight ?? 0) >= 0.65 ? 2 : 0);

function refresh3DStyles() {
  const g = state.graph3d;
  if (!g) return;
  g.nodeColor(g.nodeColor());
  g.linkColor(g.linkColor());
  g.linkWidth(g.linkWidth());
  g.linkDirectionalParticles(g.linkDirectionalParticles());
}

function buildAdjacency(data) {
  const adj = new Map();
  data.nodes.forEach(n => adj.set(n.id, new Set()));
  data.links.forEach(l => {
    const s = l.source?.id ?? l.source, t = l.target?.id ?? l.target;
    adj.get(s)?.add(t);
    adj.get(t)?.add(s);
  });
  state.adjacency = adj;
}

function focusNode3D(node, ms = 1400) {
  const g = state.graph3d;
  if (!g || node.x === undefined) return;
  const dist = 130;
  const r = Math.hypot(node.x, node.y, node.z) || 1;
  const k = 1 + dist / r;
  g.cameraPosition({ x: node.x * k, y: node.y * k, z: node.z * k }, node, ms);
}

function zoomToHighlights(ms = 1400) {
  const g = state.graph3d;
  if (!g) return;
  if (state.highlightedNodes.size) g.zoomToFit(ms, 90, n => state.highlightedNodes.has(n.id));
  else g.zoomToFit(ms, 80);
}

function resize3D() {
  const g = state.graph3d;
  if (!g) return;
  const canvas = $("graph-canvas");
  g.width(canvas.clientWidth).height(canvas.clientHeight);
}

// Re-applies tour/step highlights on whichever renderer is active
function applyHighlights() {
  if (state.graphMode === "3d" && state.graph3d) {
    refresh3DStyles();
    if (state.currentView === "graph") zoomToHighlights();
  } else if (state.currentView === "graph") {
    renderGraph2D();
  }
}

function setGraphMode(mode) {
  if (mode === state.graphMode) return;
  if (mode === "3d" && !has3D()) return;
  state.graphMode = mode;
  try { localStorage.setItem("amanuense-graph-mode", mode); } catch (_) {}
  if (mode === "2d") destroyGraph3D();
  state.simulation = null;
  renderGraph();
}

function syncGraphModeUI() {
  const is3d = state.graphMode === "3d";
  const modeBtn = $("ctrl-mode");
  if (modeBtn) modeBtn.textContent = is3d ? "◳ 2D" : "⬡ 3D";
  const orbitBtn = $("ctrl-orbit");
  if (orbitBtn) {
    orbitBtn.style.display = is3d ? "" : "none";
    orbitBtn.classList.toggle("active", state.autoOrbit);
  }
  if (modeBtn && !has3D()) modeBtn.style.display = "none";
  const hint = $("graph-hint");
  if (hint) hint.textContent = is3d
    ? "arraste para orbitar · role para aproximar · clique em um nó para explorar"
    : "arraste os nós · role para zoom · clique em um nó para detalhes";
}

function updateHudStats(data) {
  const el = $("hud-stats");
  if (el) el.textContent = `${data.nodes.length} nós · ${data.links.length} correlações`;
}

function renderLegend(data) {
  const el = $("graph-legend");
  if (!el) return;
  const byType = new Map();
  data.nodes.forEach(n => {
    const e = byType.get(n.type) || { color: n.color || "#7f8c9b", count: 0 };
    e.count++;
    byType.set(n.type, e);
  });
  const rows = [...byType.entries()].sort((a, b) => b[1].count - a[1].count).map(([type, e]) => `
    <div class="legend-row">
      <span class="legend-dot" style="color:${e.color};background:${e.color}"></span>
      <span class="legend-name">${escapeHtml(type)}</span>
      <span class="legend-count">${e.count}</span>
    </div>
  `).join("");
  el.innerHTML = `<div class="hud-eyebrow">Legenda</div>${rows}
    <div class="legend-note">arestas curvas/tracejadas = implícitas</div>`;
}

function blendColor(c1, c2, t) {
  const p = (c) => {
    if (!/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(c)) return null;
    let h = c.slice(1);
    if (h.length === 3) h = h.split("").map(x => x + x).join("");
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  };
  const a = p(c1), b = p(c2);
  if (!a || !b) return c1;
  const m = a.map((v, i) => Math.round(v + (b[i] - v) * t));
  return `rgb(${m[0]},${m[1]},${m[2]})`;
}

// ── 2D Graph (D3 fallback) ────────────────────────────────────────────────────
function renderGraph2D() {
  const stage = $("graph-stage");
  if (stage) stage.classList.add("mode-2d");
  destroyGraph3D();

  const canvas = $("graph-canvas");
  canvas.innerHTML = "";
  const W = canvas.clientWidth || 900;
  const H = canvas.clientHeight || 600;

  const data = getFilteredData();
  updateHudStats(data);
  renderLegend(data);

  const { nodes, links } = data;
  if (nodes.length === 0) return;

  const svg = d3.select(canvas).append("svg")
    .attr("width", "100%").attr("height", "100%")
    .attr("viewBox", `0 0 ${W} ${H}`);
  state.svg = svg;

  const defs = svg.append("defs");
  [...new Set(links.map(e => e.color || "#999"))].forEach(color => {
    const safeId = "arrow-" + color.replace("#", "");
    defs.append("marker")
      .attr("id", safeId).attr("viewBox", "0 -5 10 10")
      .attr("refX", 18).attr("refY", 0)
      .attr("markerWidth", 6).attr("markerHeight", 6).attr("orient", "auto")
      .append("path").attr("d", "M0,-5L10,0L0,5").attr("fill", color);
  });

  const zoom = d3.zoom().scaleExtent([0.1, 4])
    .on("zoom", (event) => g_container.attr("transform", event.transform));
  svg.call(zoom);

  const g_container = svg.append("g");

  const simulation = d3.forceSimulation(nodes)
    .force("link", d3.forceLink(links).id(d => d.id).distance(d => 80 + (1 - d.weight) * 60))
    .force("charge", d3.forceManyBody().strength(-200))
    .force("center", d3.forceCenter(W / 2, H / 2))
    .force("collide", d3.forceCollide(20));
  state.simulation = simulation;

  const link = g_container.append("g").selectAll("line").data(links).join("line")
    .attr("stroke", d => d.color || "#999")
    .attr("stroke-width", d => 1 + d.weight * 2)
    .attr("stroke-dasharray", d => d.implicit ? "5,3" : null)
    .attr("stroke-opacity", d => d.stale ? 0.3 : 0.7)
    .attr("marker-end", d => `url(#arrow-${(d.color || "#999").replace("#", "")})`)
    .on("mouseenter", (event, d) => showEdgeTooltip(event, d))
    .on("mouseleave", hideTooltip);

  const nodeRadius = d => {
    if (d.type === "norma") return 16;
    if (d.type === "artigo") return 9;
    if (d.type === "papel" || d.type === "entidade") return 12;
    return 6;
  };

  const node = g_container.append("g").selectAll("g").data(nodes).join("g")
    .attr("class", "node-group")
    .call(d3.drag()
      .on("start", dragStarted)
      .on("drag", dragged)
      .on("end", dragEnded))
    .on("click", (event, d) => { event.stopPropagation(); selectNode(d.id); })
    .on("mouseenter", (event, d) => showNodeTooltip(event, d))
    .on("mouseleave", hideTooltip);

  node.append("circle")
    .attr("r", nodeRadius)
    .attr("fill", d => {
      if (d.status === "revogado") return "#aaa";
      if (d.status === "suspenso") return "#ddd";
      return d.color || "#888";
    })
    .attr("stroke", d => state.highlightedNodes.has(d.id) ? "#f1c40f" : "rgba(255,255,255,0.3)")
    .attr("stroke-width", d => state.highlightedNodes.has(d.id) ? 3 : 1)
    .attr("opacity", d => d.status === "revogado" ? 0.5 : 1);

  node.filter(d => d.type === "norma" || d.type === "papel" || d.type === "entidade")
    .append("text")
    .attr("dy", d => nodeRadius(d) + 10)
    .attr("text-anchor", "middle")
    .attr("font-size", "11px")
    .attr("font-family", "'Crimson Pro', serif")
    .attr("fill", "#3d5166")
    .text(d => d.label?.substring(0, 30) || d.id?.split(":")[1] || "");

  svg.on("click", () => deselectNode());

  simulation.on("tick", () => {
    link.attr("x1", d => d.source.x).attr("y1", d => d.source.y)
        .attr("x2", d => d.target.x).attr("y2", d => d.target.y);
    node.attr("transform", d => `translate(${d.x},${d.y})`);
  });

  function dragStarted(event) {
    if (!event.active) simulation.alphaTarget(0.3).restart();
    event.subject.fx = event.subject.x;
    event.subject.fy = event.subject.y;
  }
  function dragged(event) {
    event.subject.fx = event.x;
    event.subject.fy = event.y;
  }
  function dragEnded(event) {
    if (!event.active) simulation.alphaTarget(0);
    event.subject.fx = null;
    event.subject.fy = null;
  }
}

// ── Node Panel ────────────────────────────────────────────────────────────────
function selectNode(nodeId) {
  state.selectedNodeId = nodeId;
  const node = state.graph.nodes.find(n => n.id === nodeId);
  if (!node) return;

  state.selNeighbors = new Set(state.adjacency.get(nodeId) || []);
  if (state.graphMode === "3d" && state.graph3d) {
    const obj = state.graph3d.graphData().nodes.find(n => n.id === nodeId);
    if (obj) focusNode3D(obj);
    refresh3DStyles();
  }

  $("node-panel-title").textContent = node.label || node.id;
  $("node-panel-type").textContent = node.type.toUpperCase() + " · " + (node.status || "");
  $("node-panel-type").className = "status-" + (node.status || "vigente");

  const statusBadge = `<span class="status-badge status-${node.status || 'vigente'}">${node.status || 'vigente'}</span>`;

  let html = `<div class="panel-section">
    <div class="panel-section-label">Resumo</div>
    <div class="panel-text">${escapeHtml(node.summary || "")} ${statusBadge}</div>
  </div>`;

  if (node.tags?.length) {
    html += `<div class="panel-section">
      <div class="panel-section-label">Tags</div>
      <div class="panel-tags">${node.tags.map(t => `<span class="tag">${t}</span>`).join("")}</div>
    </div>`;
  }

  const outEdges = state.graph.links.filter(e => (e.source?.id || e.source) === nodeId);
  const inEdges  = state.graph.links.filter(e => (e.target?.id || e.target) === nodeId);

  if (outEdges.length) {
    html += `<div class="panel-section">
      <div class="panel-section-label">Correlações (saída — ${outEdges.length})</div>
      <ul class="edge-list">${outEdges.slice(0, 10).map(e => edgeHtml(e, "out")).join("")}</ul>
    </div>`;
  }
  if (inEdges.length) {
    html += `<div class="panel-section">
      <div class="panel-section-label">Correlações (entrada — ${inEdges.length})</div>
      <ul class="edge-list">${inEdges.slice(0, 10).map(e => edgeHtml(e, "in")).join("")}</ul>
    </div>`;
  }

  $("node-panel-body").innerHTML = html;

  const textSection = $("node-text-section");
  if (state.corpusTexts?.texts?.[nodeId]) {
    $("node-text-pre").textContent = state.corpusTexts.texts[nodeId].textoCompleto || "";
    textSection.style.display = "block";
  } else {
    textSection.style.display = "none";
  }

  $("node-panel").classList.add("open");
  $("node-panel-body").querySelectorAll(".edge-node-link").forEach(el => {
    el.addEventListener("click", () => selectNode(el.dataset.nodeid));
  });
}

function edgeHtml(edge, dir) {
  const otherId = dir === "out" ? (edge.target?.id || edge.target) : (edge.source?.id || edge.source);
  const otherNode = state.graph.nodes.find(n => n.id === otherId);
  const otherLabel = otherNode ? (otherNode.label || otherId).substring(0, 40) : otherId;
  const c = edge.color || "#999";
  return `<li class="edge-item">
    <span class="edge-type-badge" style="background:${c}20;color:${c}">${edge.type}</span>
    <span class="edge-node-link" data-nodeid="${escapeHtml(otherId)}">${escapeHtml(otherLabel)}</span>${edge.implicit ? " (impl.)" : ""}
  </li>`;
}

function deselectNode() {
  state.selectedNodeId = null;
  state.selNeighbors = new Set();
  $("node-panel").classList.remove("open");
  refresh3DStyles();
}

// ── Tooltips ──────────────────────────────────────────────────────────────────
function showNodeTooltip(event, d) {
  const tip = $("tooltip");
  tip.innerHTML = `<b>${escapeHtml(d.label || d.id)}</b><br>${d.type} · ${d.status || ""}`;
  tip.style.display = "block";
  tip.style.left = (event.clientX + 12) + "px";
  tip.style.top = (event.clientY + 12) + "px";
}
function showEdgeTooltip(event, d) {
  const tip = $("tooltip");
  tip.innerHTML = `<b>${d.type}</b><br>peso: ${d.weight?.toFixed(2)}${d.implicit ? " · implícita" : ""}`;
  tip.style.display = "block";
  tip.style.left = (event.clientX + 12) + "px";
  tip.style.top = (event.clientY + 12) + "px";
}
function hideTooltip() { $("tooltip").style.display = "none"; }

// ── Hierarchy View ────────────────────────────────────────────────────────────
function populateHierarchyView() {
  const container = $("hierarchy-container");
  if (!state.graph) return;

  const normaNodes = state.graph.nodes.filter(n => n.type === "norma");
  const byLayer = {};
  normaNodes.forEach(n => { const l = n.layer || 9; (byLayer[l] = byLayer[l] || []).push(n); });

  const layerNames = {
    1: "Constituição Federal",
    2: "Lei Complementar / Lei Ordinária",
    3: "Resolução BCB/CMN",
    4: "Circular BCB",
    5: "Instrução Normativa",
    6: "Manual Operacional",
  };

  let html = "";
  Object.keys(byLayer).sort().forEach(level => {
    html += `<div class="hierarchy-level">
      <div class="hierarchy-level-title">
        <span class="hierarchy-level-badge">L${level}</span>${layerNames[level] || `Nível ${level}`}
      </div>`;
    byLayer[level].forEach(n => {
      html += `<div class="norm-card" onclick="selectNode('${escapeHtml(n.id)}'); switchView('graph');">
        <div class="norm-card-name">${escapeHtml(n.label || n.id)}</div>
        <div class="norm-card-meta">
          <span class="status-badge status-${n.status || 'vigente'}">${n.status || "vigente"}</span>
          <span style="margin-left:8px">${n.id}</span>
        </div>
      </div>`;
    });
    html += "</div>";
  });
  container.innerHTML = html || "<p>Nenhuma norma encontrada.</p>";
}

// ── Role View ─────────────────────────────────────────────────────────────────
function populateRoleSelect() {
  const select = $("role-select");
  if (!state.graph) return;
  state.graph.nodes.filter(n => n.type === "papel" || n.type === "entidade").forEach(n => {
    const opt = document.createElement("option");
    opt.value = n.id; opt.textContent = n.label || n.id;
    select.appendChild(opt);
  });
}

function renderRoleObligations(papelId) {
  const container = $("role-obligations");
  if (!papelId) { container.innerHTML = ""; return; }

  const obligationTypes = new Set(["obriga","permite","proibe","atribui_responsabilidade","aplica_a","condiciona"]);
  const edges = state.graph.links.filter(e => (e.target?.id || e.target) === papelId && obligationTypes.has(e.type));
  const papel = state.graph.nodes.find(n => n.id === papelId);

  if (!edges.length) {
    container.innerHTML = "<p>Nenhuma obrigação encontrada para este papel.</p>";
    return;
  }

  let html = `<h3 style="font-family:'EB Garamond',serif;font-size:22px;color:#0f2340;margin-bottom:16px">
    Obrigações: ${papel ? (papel.label || papel.id) : papelId}
  </h3>`;
  edges.forEach(e => {
    const srcId = e.source?.id || e.source;
    const srcNode = state.graph.nodes.find(n => n.id === srcId);
    html += `<div class="obligation-item">
      <div class="art-ref" style="color:${e.color || '#999'}">${e.type.toUpperCase()}</div>
      <div class="art-text"><b>${srcNode ? (srcNode.label || srcId).substring(0, 50) : srcId}</b>
        ${srcNode ? `<br><small>${escapeHtml(srcNode.summary || "")}</small>` : ""}
      </div>
    </div>`;
  });
  container.innerHTML = html;
}

// ── Timeline View ─────────────────────────────────────────────────────────────
function populateTimelineView() {
  const container = $("timeline-container");
  if (!state.diffLog) {
    container.innerHTML = "<p>Nenhum diff-log.json encontrado. Execute o pipeline completo.</p>";
    return;
  }
  const entries = state.diffLog.entries || [];
  if (!entries.length) { container.innerHTML = "<p>Sem alterações registradas.</p>"; return; }

  container.innerHTML = entries.slice(0, 100).map(e => `
    <div class="timeline-item">
      <div class="timeline-date">${(e.timestamp || "").substring(0, 10)}</div>
      <div class="timeline-content">
        <div class="timeline-title">${escapeHtml(e.corpusFile || "")}</div>
        <div class="timeline-desc">${escapeHtml(e.description || "")}
          <span class="tag" style="margin-left:6px">${e.changeType || ""}</span>
          <span class="tag">${e.impacto || ""}</span>
        </div>
      </div>
    </div>
  `).join("");
}

// ── Tour View ─────────────────────────────────────────────────────────────────
function populateTourView() {
  const select = $("tour-select");
  const tourData = (state.graph?.tours) || [];
  if (!tourData.length) {
    $("tour-steps-panel").innerHTML = "<p style='padding:16px;color:#888'>Nenhum tour disponível.</p>";
    return;
  }
  tourData.forEach((tour, i) => {
    const opt = document.createElement("option");
    opt.value = i; opt.textContent = tour.title;
    select.appendChild(opt);
  });
  renderTour(0);
  select.addEventListener("change", () => {
    state.tourIndex = parseInt(select.value);
    state.tourStepIndex = 0;
    renderTour(state.tourIndex);
  });
}

function renderTour(tourIdx) {
  const tours = state.graph?.tours || [];
  if (!tours[tourIdx]) return;
  const steps = tours[tourIdx].steps || [];
  $("tour-steps-panel").innerHTML = steps.map((step, i) => `
    <button class="tour-step-btn ${i === state.tourStepIndex ? 'active' : ''}" onclick="goToTourStep(${tourIdx}, ${i})">
      <div class="tour-step-num">Passo ${step.order || i + 1}</div>
      ${escapeHtml(step.title)}
    </button>
  `).join("");
  renderTourStep(tourIdx, state.tourStepIndex);
}

function renderTourStep(tourIdx, stepIdx) {
  state.tourStepIndex = stepIdx;
  const tour = (state.graph?.tours || [])[tourIdx];
  if (!tour) return;
  const step = (tour.steps || [])[stepIdx];
  if (!step) return;

  state.highlightedNodes = new Set(step.nodeIds || []);
  applyHighlights();

  const nodeChips = (step.nodeIds || []).map(id => {
    const n = state.graph?.nodes.find(x => x.id === id);
    return `<span class="tour-node-chip" onclick="selectNode('${escapeHtml(id)}'); switchView('graph');">${escapeHtml(n ? (n.label || id).substring(0, 30) : id)}</span>`;
  }).join("");

  $("tour-content").innerHTML = `
    <h3>${escapeHtml(step.title)}</h3>
    <p>${escapeHtml(step.description || "")}</p>
    ${nodeChips ? `<div class="tour-node-chips">${nodeChips}</div>` : ""}
    <div class="tour-nav">
      <button class="tour-nav-btn" onclick="goToTourStep(${tourIdx}, ${stepIdx - 1})" ${stepIdx === 0 ? "disabled" : ""}>← Anterior</button>
      <button class="tour-nav-btn" onclick="goToTourStep(${tourIdx}, ${stepIdx + 1})" ${stepIdx >= (tour.steps || []).length - 1 ? "disabled" : ""}>Próximo →</button>
    </div>
  `;

  $("tour-steps-panel").querySelectorAll(".tour-step-btn").forEach((btn, i) => {
    btn.classList.toggle("active", i === stepIdx);
  });
}

function goToTourStep(tourIdx, stepIdx) {
  const tour = (state.graph?.tours || [])[tourIdx];
  if (!tour) return;
  if (stepIdx < 0 || stepIdx >= (tour.steps || []).length) return;
  renderTourStep(tourIdx, stepIdx);
}

// ── Texto das Leis (base de legislação estruturada) ───────────────────────────
const TIPO_NORMA_ORDEM = { artigo: 0, paragrafo: 1, inciso: 2, alinea: 3, item: 4, subitem: 5 };

function formatDateBR(iso) {
  if (!iso) return "";
  const [y, m, d] = iso.substring(0, 10).split("-");
  return `${d}/${m}/${y}`;
}

function normaTitle(n) {
  return `${n.tipo} nº ${n.numero}/${n.ano}`;
}

async function initLeisView() {
  if (state.leis.indexLoaded) return;
  const list = $("leis-index-list");
  list.innerHTML = `<div class="leis-empty">Carregando índice…</div>`;

  let resp;
  try {
    resp = await fetch("/api/leis");
  } catch (_) {
    list.innerHTML = `<div class="leis-empty">Erro de rede ao consultar a API.</div>`;
    return;
  }

  if (resp.status === 503) {
    list.innerHTML = `<div class="leis-empty">
      <b>Base de legislação estruturada desabilitada.</b><br>
      Defina <code>LEGISLACAO_DATABASE_URL</code>, rode <code>amanuense initdb</code>
      e execute o pipeline para carregar as leis.</div>`;
    return;
  }
  if (!resp.ok) {
    list.innerHTML = `<div class="leis-empty">Erro ao consultar a base (${resp.status}).</div>`;
    return;
  }

  const { leis } = await resp.json();
  state.leis.indexLoaded = true;
  renderLeisIndex(leis);
}

function renderLeisIndex(leis) {
  const list = $("leis-index-list");
  if (!leis.length) {
    list.innerHTML = `<div class="leis-empty">Nenhuma lei carregada na base ainda —
      execute o pipeline com a base estruturada habilitada.</div>`;
    return;
  }

  list.innerHTML = leis.map(l => `
    <div class="lei-index-card${l.status === "revogada" ? " lei-revogada" : ""}" data-id="${l.id_norma}">
      <div class="lei-index-title">
        ${escapeHtml(normaTitle(l))}
        ${l.apelido ? `<span class="lei-apelido">${escapeHtml(l.apelido)}</span>` : ""}
      </div>
      ${l.ementa ? `<div class="lei-index-ementa">${escapeHtml(l.ementa)}</div>` : ""}
      <div class="lei-index-meta">
        <span class="status-badge status-${l.status === "vigente" ? "vigente" : l.status === "revogada" ? "revogado" : "suspenso"}">${escapeHtml(l.status)}</span>
        <span>${l.num_dispositivos} dispositivo${l.num_dispositivos === 1 ? "" : "s"}</span>
        ${l.num_alterados > 0 ? `<span class="lei-meta-alterados">⟳ ${l.num_alterados} alterado${l.num_alterados === 1 ? "" : "s"}</span>` : ""}
        ${l.data_publicacao ? `<span>publicada em ${formatDateBR(l.data_publicacao)}</span>` : ""}
      </div>
    </div>
  `).join("");

  list.querySelectorAll(".lei-index-card").forEach(card => {
    card.addEventListener("click", () => openLei(parseInt(card.dataset.id)));
  });
}

async function openLei(idNorma) {
  const content = $("lei-doc-content");
  $("leis-index").classList.add("leis-hidden");
  $("lei-doc").classList.remove("leis-hidden");
  content.innerHTML = `<div class="leis-empty">Carregando lei…</div>`;

  let resp;
  try {
    resp = await fetch(`/api/leis/${idNorma}`);
  } catch (_) {
    content.innerHTML = `<div class="leis-empty">Erro de rede ao consultar a API.</div>`;
    return;
  }
  if (!resp.ok) {
    content.innerHTML = `<div class="leis-empty">Erro ao carregar a lei (${resp.status}).</div>`;
    return;
  }

  const data = await resp.json();
  state.leis.currentLei = data;
  renderLeiDoc(data);
  $("lei-doc").scrollTop = 0;
}

function closeLei() {
  state.leis.currentLei = null;
  $("lei-doc").classList.add("leis-hidden");
  $("leis-index").classList.remove("leis-hidden");
}

// Monta o rótulo completo de um agrupamento subindo a cadeia de pais
// ("Capítulo II — Do Tratamento" dentro de "Título I — ...")
function agrupamentoChain(id, byId) {
  const chain = [];
  let cur = byId.get(id);
  while (cur) {
    chain.unshift(cur);
    cur = cur.id_pai ? byId.get(cur.id_pai) : null;
  }
  return chain;
}

function renderLeiDoc(data) {
  const { norma, agrupamentos, dispositivos } = data;
  const agrById = new Map(agrupamentos.map(a => [a.id_agrupamento, a]));

  let html = `
    <header class="lei-doc-header">
      <div class="lei-doc-eyebrow">${escapeHtml(norma.orgao_emissor || norma.esfera || "")}</div>
      <h2>${escapeHtml(normaTitle(norma))}</h2>
      ${norma.apelido ? `<div class="lei-doc-apelido">${escapeHtml(norma.apelido)}</div>` : ""}
      ${norma.ementa ? `<p class="lei-doc-ementa">${escapeHtml(norma.ementa)}</p>` : ""}
      <div class="lei-index-meta">
        <span class="status-badge status-${norma.status === "vigente" ? "vigente" : norma.status === "revogada" ? "revogado" : "suspenso"}">${escapeHtml(norma.status)}</span>
        ${norma.data_publicacao ? `<span>publicada em ${formatDateBR(norma.data_publicacao)}</span>` : ""}
      </div>
    </header>
  `;

  if (!dispositivos.length) {
    html += `<div class="leis-empty">Nenhum dispositivo carregado para esta lei.</div>`;
    $("lei-doc-content").innerHTML = html;
    return;
  }

  let agrAtual = null;
  dispositivos.forEach(d => {
    // Cabeçalho de agrupamento (Capítulo, Seção…) quando o artigo muda de divisão
    if (d.tipo === "artigo" && d.id_agrupamento !== agrAtual) {
      agrAtual = d.id_agrupamento;
      if (d.id_agrupamento != null) {
        agrupamentoChain(d.id_agrupamento, agrById).forEach(a => {
          html += `<div class="lei-agrupamento lei-agrupamento-${escapeHtml(a.tipo)}">
            ${a.numero_rotulo ? `<span class="lei-agr-rotulo">${escapeHtml(a.numero_rotulo)}</span>` : ""}
            ${a.nome ? `<span class="lei-agr-nome">${escapeHtml(a.nome)}</span>` : ""}
          </div>`;
        });
      }
    }
    html += dispCardHtml(d);
  });

  $("lei-doc-content").innerHTML = html;

  $("lei-doc-content").querySelectorAll(".disp-mini-btn").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const dispId = parseInt(btn.dataset.disp);
      if (btn.dataset.action === "historico") openDispHistorico(norma.id_norma, dispId);
      else openDispConexoes(norma.id_norma, dispId);
    });
  });
}

function dispCardHtml(d) {
  const revogado = d.situacao === "revogado";
  const temHistorico = d.num_versoes > 1;
  const temConexoes = d.num_conexoes > 0;
  const nivel = Math.min(d.nivel ?? TIPO_NORMA_ORDEM[d.tipo] ?? 0, 5);

  const badges = [];
  if (revogado) {
    badges.push(`<span class="disp-badge disp-badge-revogado">revogado${d.redacao_dada_por ? ` pela ${escapeHtml(d.redacao_dada_por)}` : ""}</span>`);
  } else if (d.numero_versao > 1 && d.redacao_dada_por) {
    badges.push(`<span class="disp-badge disp-badge-alterado">redação dada pela ${escapeHtml(d.redacao_dada_por)}</span>`);
  } else if (d.redacao_dada_por) {
    // numero_versao 1 com norma alteradora = dispositivo acrescentado por lei posterior
    badges.push(`<span class="disp-badge disp-badge-alterado">incluído pela ${escapeHtml(d.redacao_dada_por)}</span>`);
  }

  const botoes = [];
  if (temHistorico) {
    botoes.push(`<button class="disp-mini-btn" data-action="historico" data-disp="${d.id_dispositivo}"
      title="Ver redações anteriores">⟳ Histórico <span class="disp-mini-count">${d.num_versoes}</span></button>`);
  }
  if (temConexoes) {
    botoes.push(`<button class="disp-mini-btn" data-action="conexoes" data-disp="${d.id_dispositivo}"
      title="Ver correlações com outros dispositivos">⬡ Conexões <span class="disp-mini-count">${d.num_conexoes}</span></button>`);
  }

  const footer = (badges.length || botoes.length)
    ? `<div class="disp-foot">${badges.join("")}<span class="disp-foot-spacer"></span>${botoes.join("")}</div>`
    : "";

  return `<article class="disp-card disp-nivel-${nivel}${revogado ? " disp-revogado" : ""}" id="disp-${d.id_dispositivo}">
    <div class="disp-rotulo">${escapeHtml(d.numero_rotulo)}</div>
    <div class="disp-texto">${revogado ? "<em>(Revogado)</em>" : escapeHtml(d.texto || "")}</div>
    ${footer}
  </article>`;
}

// ── Modal: histórico de redações ──────────────────────────────────────────────
async function openDispHistorico(idNorma, idDisp) {
  openDispModal("Histórico de redações", "Carregando…");
  let resp;
  try {
    resp = await fetch(`/api/leis/${idNorma}/dispositivos/${idDisp}/historico`);
  } catch (_) { resp = null; }
  if (!resp || !resp.ok) {
    $("disp-modal-body").innerHTML = `<div class="leis-empty">Erro ao carregar o histórico.</div>`;
    return;
  }
  const { dispositivo, versoes } = await resp.json();

  $("disp-modal-eyebrow").textContent = `${dispositivo.norma}${dispositivo.norma_apelido ? " · " + dispositivo.norma_apelido : ""}`;
  $("disp-modal-title").textContent = `${dispositivo.numero_rotulo} — Histórico de redações`;

  const eventoLabel = { redacao_original: "Redação original", alteracao: "Alteração", revogacao: "Revogação", renumeracao: "Renumeração" };
  $("disp-modal-body").innerHTML = versoes.map(v => `
    <div class="versao-item ${v.vigente_ate ? "" : "versao-vigente"} ${v.evento === "revogacao" ? "versao-revogacao" : ""}">
      <div class="versao-head">
        <span class="versao-num">v${v.numero_versao}</span>
        <span class="versao-evento">${eventoLabel[v.evento] || v.evento}</span>
        ${v.por_norma ? `<span class="versao-por">pela ${escapeHtml(v.por_norma)}${v.por_norma_apelido ? ` (${escapeHtml(v.por_norma_apelido)})` : ""}</span>` : ""}
        <span class="versao-periodo">${formatDateBR(v.vigente_de)} → ${v.vigente_ate ? formatDateBR(v.vigente_ate) : "vigente"}</span>
      </div>
      <div class="versao-texto">${v.evento === "revogacao" ? "<em>(Dispositivo revogado)</em>" : escapeHtml(v.texto || "")}</div>
    </div>
  `).join("");
}

// ── Modal: conexões normativas ────────────────────────────────────────────────
async function openDispConexoes(idNorma, idDisp) {
  openDispModal("Conexões normativas", "Carregando…");
  let resp;
  try {
    resp = await fetch(`/api/leis/${idNorma}/dispositivos/${idDisp}/conexoes`);
  } catch (_) { resp = null; }
  if (!resp || !resp.ok) {
    $("disp-modal-body").innerHTML = `<div class="leis-empty">Erro ao carregar as conexões.</div>`;
    return;
  }
  const { dispositivo, conexoes } = await resp.json();

  $("disp-modal-eyebrow").textContent = `${dispositivo.norma}${dispositivo.norma_apelido ? " · " + dispositivo.norma_apelido : ""}`;
  $("disp-modal-title").textContent = `${dispositivo.numero_rotulo} — Conexões normativas`;

  if (!conexoes.length) {
    $("disp-modal-body").innerHTML = `<div class="leis-empty">Nenhuma conexão registrada.</div>`;
    return;
  }

  // direção ativa  = este dispositivo pratica a relação ("altera o Art. X da Lei Y")
  // direção passiva = este dispositivo sofre a relação ("regulamentado pela Lei Y")
  const verboAtivo  = { altera: "altera", revoga: "revoga", acrescenta: "acrescenta", regulamenta: "regulamenta", suspende: "suspende", remete: "remete a", conflito_potencial: "conflito potencial com" };
  const verboPassivo = { regulamenta: "regulamentado por", suspende: "suspenso por", remete: "referenciado por", conflito_potencial: "conflito potencial com" };

  $("disp-modal-body").innerHTML = conexoes.map(c => {
    const verbo = c.direcao === "ativa"
      ? (verboAtivo[c.tipo_relacao] || c.tipo_relacao)
      : (verboPassivo[c.tipo_relacao] || c.tipo_relacao);
    const alvo = `${c.outro_rotulo ? escapeHtml(c.outro_rotulo) + " da " : ""}${escapeHtml(c.outra_norma)}${c.outra_norma_apelido ? ` (${escapeHtml(c.outra_norma_apelido)})` : ""}`;
    return `<div class="conexao-item">
      <span class="conexao-dir" title="${c.direcao === "ativa" ? "relação de saída" : "relação de entrada"}">${c.direcao === "ativa" ? "→" : "←"}</span>
      <div class="conexao-body">
        <div><span class="conexao-verbo">${escapeHtml(verbo)}</span> ${alvo}</div>
        <div class="conexao-meta">
          ${c.data_efeito ? `<span>efeitos a partir de ${formatDateBR(c.data_efeito)}</span>` : ""}
          ${c.outro_id_canonico ? `<span class="conexao-canonico">${escapeHtml(c.outro_id_canonico)}</span>` : ""}
        </div>
        ${c.observacao ? `<div class="conexao-obs">${escapeHtml(c.observacao)}</div>` : ""}
      </div>
    </div>`;
  }).join("");
}

function openDispModal(titulo, corpo) {
  $("disp-modal-eyebrow").textContent = "";
  $("disp-modal-title").textContent = titulo;
  $("disp-modal-body").innerHTML = `<div class="leis-empty">${corpo}</div>`;
  $("disp-modal").classList.remove("leis-hidden");
}

function closeDispModal() {
  $("disp-modal").classList.add("leis-hidden");
}

function bindLeisEvents() {
  $("lei-back-btn").addEventListener("click", closeLei);
  $("disp-modal-close").addEventListener("click", closeDispModal);
  $("disp-modal").addEventListener("click", (e) => {
    if (e.target === $("disp-modal")) closeDispModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("disp-modal").classList.contains("leis-hidden")) closeDispModal();
  });
}

// ── Search ────────────────────────────────────────────────────────────────────
function setupSearch() {
  const input = $("search-input");
  const results = $("search-results");

  input.addEventListener("input", () => {
    const q = input.value.trim().toLowerCase();
    if (q.length < 2) { results.style.display = "none"; return; }

    const matches = (state.graph?.nodes || [])
      .filter(n => n.label?.toLowerCase().includes(q) || n.summary?.toLowerCase().includes(q) || n.tags?.some(t => t.toLowerCase().includes(q)))
      .slice(0, 12);

    if (!matches.length) { results.style.display = "none"; return; }

    results.innerHTML = matches.map(n => `
      <div class="search-result-item" data-nodeid="${escapeHtml(n.id)}">
        <span class="search-result-type">${n.type}</span>${escapeHtml((n.label || n.id).substring(0, 50))}
      </div>
    `).join("");
    results.style.display = "block";

    results.querySelectorAll(".search-result-item").forEach(el => {
      el.addEventListener("click", () => {
        selectNode(el.dataset.nodeid);
        switchView("graph");
        results.style.display = "none";
        input.value = "";
      });
    });
  });

  document.addEventListener("click", (e) => {
    if (!e.target.closest("#search-box")) results.style.display = "none";
  });
}

// ── View Switching ────────────────────────────────────────────────────────────
function switchView(viewName) {
  state.currentView = viewName;
  document.querySelectorAll(".view").forEach(v => v.classList.remove("active"));
  document.querySelectorAll(".sidebar-btn[data-view]").forEach(b => b.classList.remove("active"));
  const viewEl = $(`${viewName}-view`);
  if (viewEl) viewEl.classList.add("active");
  const btnEl = $q(`.sidebar-btn[data-view="${viewName}"]`);
  if (btnEl) btnEl.classList.add("active");
  if (viewName === "leis") initLeisView();
  if (viewName === "graph" && state.graph) {
    setTimeout(() => {
      if (state.graphMode === "3d" && has3D()) {
        if (!state.graph3d) renderGraph();
        else {
          resize3D();
          if (state.highlightedNodes.size) zoomToHighlights();
        }
      } else if (!state.simulation) {
        renderGraph();
      }
    }, 50);
  }
}

// ── Events ────────────────────────────────────────────────────────────────────
function bindEvents() {
  $("filter-node-type").addEventListener("change", (e) => { state.filters.nodeType = e.target.value; renderGraph(); });
  $("filter-status").addEventListener("change", (e) => { state.filters.status = e.target.value; renderGraph(); });
  $("filter-edge-type").addEventListener("change", (e) => { state.filters.edgeType = e.target.value; renderGraph(); });
  $("filter-implicit").addEventListener("change", (e) => { state.filters.implicit = e.target.value; renderGraph(); });
  $("filter-weight").addEventListener("input", (e) => {
    state.filters.minWeight = parseFloat(e.target.value);
    $("filter-weight-val").textContent = state.filters.minWeight.toFixed(1);
    renderGraph();
  });

  $("role-select").addEventListener("change", (e) => renderRoleObligations(e.target.value));
  $("panel-close-btn").addEventListener("click", deselectNode);

  bindHudControls();
  setupSearch();

  window.addEventListener("resize", () => {
    if (state.currentView !== "graph") return;
    if (state.graphMode === "3d" && state.graph3d) resize3D();
    else renderGraph();
  });
}

function bindHudControls() {
  $("ctrl-orbit")?.addEventListener("click", () => {
    state.autoOrbit = !state.autoOrbit;
    const controls = state.graph3d?.controls();
    if (controls) controls.autoRotate = state.autoOrbit;
    $("ctrl-orbit").classList.toggle("active", state.autoOrbit);
  });

  $("ctrl-fit")?.addEventListener("click", () => {
    if (state.graphMode === "3d" && state.graph3d) state.graph3d.zoomToFit(1200, 80);
    else renderGraph();
  });

  $("ctrl-mode")?.addEventListener("click", () => {
    setGraphMode(state.graphMode === "3d" ? "2d" : "3d");
  });

  $("ctrl-fullscreen")?.addEventListener("click", () => {
    const view = $("graph-view");
    if (document.fullscreenElement) document.exitFullscreen();
    else view.requestFullscreen?.();
  });

  document.addEventListener("fullscreenchange", () => {
    if (state.currentView !== "graph") return;
    setTimeout(() => {
      if (state.graphMode === "3d" && state.graph3d) resize3D();
      else renderGraph();
    }, 100);
  });
}

function bindCorpusEvents() {
  $("file-input").addEventListener("change", (e) => handleUpload(Array.from(e.target.files)));
  $("run-btn").addEventListener("click", startPipeline);
  $("toast-close").addEventListener("click", hideToast);
  $("ver-grafo-btn").addEventListener("click", () => window.location.reload());

  const corpusSection = $("corpus-section");
  corpusSection.addEventListener("dragover", (e) => { e.preventDefault(); corpusSection.classList.add("drag-over"); });
  corpusSection.addEventListener("dragleave", () => corpusSection.classList.remove("drag-over"));
  corpusSection.addEventListener("drop", (e) => {
    e.preventDefault();
    corpusSection.classList.remove("drag-over");
    handleUpload(Array.from(e.dataTransfer.files).filter(f => f.name.endsWith(".pdf")));
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function escapeHtml(text) {
  if (!text) return "";
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  // Navegação entre views fica fora de bindEvents(): a view "Texto das Leis"
  // lê direto da base estruturada e deve funcionar mesmo sem grafo gerado.
  document.querySelectorAll(".sidebar-btn[data-view]").forEach(btn => {
    btn.addEventListener("click", () => switchView(btn.dataset.view));
  });
  bindLeisEvents();
  bindCorpusEvents();
  init();
});
