// MultiLLM – logique de l'interface.
const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, attrs = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "style") node.style.cssText = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c != null) node.append(c instanceof Node ? c : document.createTextNode(c));
  return node;
};
const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* stockage indisponible */
    }
  },
};

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    body: options.body && typeof options.body !== "string" ? JSON.stringify(options.body) : options.body,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function toast(message, type = "") {
  const t = el("div", { class: `toast ${type}` }, message);
  $("#toasts").append(t);
  setTimeout(() => t.remove(), type === "error" ? 6000 : 3000);
}

const fmtMs = (ms) => (ms == null ? "–" : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);
const countWords = (s) => (s.trim() ? s.trim().split(/\s+/).length : 0);

// ---------- état ----------
const state = {
  models: [],
  selected: new Set(store.get("multillm.selected", [])),
  conv: newConversation(),
  running: new Map(), // clé "tour:modèle" -> AbortController
};

function newConversation() {
  return { id: null, title: "", system: "", turns: [] };
}

const modelById = (id) => state.models.find((m) => m.id === id);
const modelLabel = (id, turnResp) => modelById(id)?.label || turnResp?.label || "Modèle supprimé";

// ---------- sélection des modèles ----------
async function loadModels() {
  state.models = await api("/api/models");
  const ids = new Set(state.models.map((m) => m.id));
  for (const id of [...state.selected]) if (!ids.has(id)) state.selected.delete(id);
  if (state.selected.size === 0) state.models.filter((m) => m.enabled).forEach((m) => state.selected.add(m.id));
  renderPicker();
}

function saveSelection() {
  store.set("multillm.selected", [...state.selected]);
}

function renderPicker() {
  const picker = $("#modelPicker");
  picker.replaceChildren();
  const usable = state.models.filter((m) => m.enabled);
  if (!usable.length) {
    picker.append(el("span", { class: "muted" }, "Aucun modèle actif. "), el("a", { onclick: openModels, style: "cursor:pointer;color:var(--accent)" }, "Ajouter un modèle"));
    return;
  }
  for (const m of usable) {
    const missingKey = !m.hasApiKey && m.type !== "demo" && m.type !== "openai";
    const chip = el(
      "span",
      {
        class: `chip ${state.selected.has(m.id) ? "on" : ""} ${missingKey ? "warn" : ""}`,
        style: `--c:${m.color || "#6366f1"}`,
        title: `${m.model || ""}${missingKey ? " — clé API manquante" : ""}`,
        role: "checkbox",
        "aria-checked": String(state.selected.has(m.id)),
        tabindex: "0",
        onclick: () => {
          state.selected.has(m.id) ? state.selected.delete(m.id) : state.selected.add(m.id);
          saveSelection();
          renderPicker();
        },
        onkeydown: (e) => {
          if (e.key === " " || e.key === "Enter") {
            e.preventDefault();
            e.currentTarget.click();
          }
        },
      },
      el("span", { class: "dot" }),
      m.label,
      missingKey ? el("small", {}, "⚠ clé") : null,
    );
    picker.append(chip);
  }
  picker.append(
    el(
      "span",
      { class: "picker-actions" },
      el("a", { onclick: () => { usable.forEach((m) => state.selected.add(m.id)); saveSelection(); renderPicker(); } }, "Tous"),
      el("a", { onclick: () => { state.selected.clear(); saveSelection(); renderPicker(); } }, "Aucun"),
      el("span", { class: "muted" }, `${[...state.selected].filter((id) => modelById(id)?.enabled).length} sélectionné(s)`),
    ),
  );
}

// ---------- envoi d'un prompt ----------

// Construit l'historique propre à un modèle : seuls les tours où ce modèle a répondu sont inclus.
function historyFor(modelId, uptoTurn) {
  const messages = [];
  for (let i = 0; i < uptoTurn; i++) {
    const t = state.conv.turns[i];
    const r = t.responses[modelId];
    if (!r || r.status !== "done" || !r.text) continue;
    messages.push({ role: "user", content: t.prompt });
    messages.push({ role: "assistant", content: r.text, ...(r.raw ? { raw: r.raw } : {}) });
  }
  messages.push({ role: "user", content: state.conv.turns[uptoTurn].prompt });
  return messages;
}

async function send() {
  const prompt = $("#promptInput").value.trim();
  if (!prompt) return;
  const ids = state.models.filter((m) => m.enabled && state.selected.has(m.id)).map((m) => m.id);
  if (!ids.length) return toast("Sélectionnez au moins un modèle.", "error");

  state.conv.system = $("#systemInput").value.trim();
  if (!state.conv.title) state.conv.title = prompt.slice(0, 80);
  const turn = { prompt, createdAt: new Date().toISOString(), responses: {} };
  for (const id of ids) {
    const m = modelById(id);
    turn.responses[id] = { label: m.label, color: m.color, model: m.model, status: "pending", text: "", thinking: "" };
  }
  state.conv.turns.push(turn);
  $("#promptInput").value = "";
  render();
  const idx = state.conv.turns.length - 1;
  scrollToTurn(idx);
  await Promise.allSettled(ids.map((id) => runModel(idx, id)));
  await persist();
}

async function runModel(turnIdx, modelId) {
  const turn = state.conv.turns[turnIdx];
  const resp = turn.responses[modelId];
  Object.assign(resp, {
    status: "streaming", text: "", thinking: "", info: [], error: null, raw: null,
    served: null, usage: null, latencyMs: null, firstTokenMs: null, stopReason: null,
  });
  const key = `${turnIdx}:${modelId}`;
  const controller = new AbortController();
  state.running.set(key, controller);
  updateRunning();
  updateCard(turnIdx, modelId);

  const started = performance.now();
  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ modelId, system: state.conv.system, messages: historyFor(modelId, turnIdx) }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let finished = false;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        const ev = JSON.parse(line);
        if (ev.type === "text") resp.text += ev.text;
        else if (ev.type === "thinking") resp.thinking += ev.text;
        else if (ev.type === "served") resp.served = ev.model;
        else if (ev.type === "info") resp.info.push(ev.message);
        else if (ev.type === "done") {
          finished = true;
          Object.assign(resp, {
            status: "done", latencyMs: ev.latencyMs, firstTokenMs: ev.firstTokenMs,
            usage: ev.usage, stopReason: ev.stopReason, raw: ev.raw || null,
          });
        } else if (ev.type === "error") {
          finished = true;
          Object.assign(resp, { status: "error", error: ev.message, latencyMs: ev.latencyMs });
        }
        scheduleCardUpdate(turnIdx, modelId);
      }
    }
    if (!finished) throw new Error("Flux interrompu avant la fin de la réponse.");
  } catch (err) {
    if (err.name === "AbortError") {
      resp.status = "stopped";
      resp.latencyMs = Math.round(performance.now() - started);
    } else {
      resp.status = "error";
      resp.error = err.message;
    }
  } finally {
    state.running.delete(key);
    updateRunning();
    updateCard(turnIdx, modelId);
    updateTurnBadges(turnIdx);
  }
}

function stopAll() {
  for (const c of state.running.values()) c.abort();
}

function updateRunning() {
  const busy = state.running.size > 0;
  $("#stopBtn").hidden = !busy;
  $("#sendBtn").disabled = busy;
}

async function persist() {
  if (!state.conv.turns.length) return;
  const payload = {
    id: state.conv.id,
    title: state.conv.title,
    system: state.conv.system,
    modelIds: [...new Set(state.conv.turns.flatMap((t) => Object.keys(t.responses)))],
    turns: state.conv.turns.map((t) => ({
      ...t,
      responses: Object.fromEntries(
        Object.entries(t.responses).map(([id, r]) => [id, { ...r, status: r.status === "streaming" ? "stopped" : r.status }]),
      ),
    })),
  };
  try {
    const saved = await api("/api/history", { method: "POST", body: payload });
    state.conv.id = saved.id;
    $("#convTitle").textContent = state.conv.title;
  } catch (err) {
    toast(`Sauvegarde impossible : ${err.message}`, "error");
  }
}

// ---------- rendu ----------
function render() {
  const thread = $("#thread");
  thread.replaceChildren();
  $("#convTitle").textContent = state.conv.title || "";
  $("#systemInput").value = state.conv.system || "";
  updateSystemHint();
  if (!state.conv.turns.length) {
    thread.append(emptyState());
    return;
  }
  state.conv.turns.forEach((turn, idx) => thread.append(renderTurn(turn, idx)));
}

function emptyState() {
  return el(
    "section",
    { class: "empty" },
    el("h1", {}, "Comparez plusieurs LLM sur le même prompt"),
    el("p", {}, "Choisissez les modèles ci-dessous, écrivez votre prompt et envoyez : chaque modèle est interrogé en parallèle, et les réponses s'affichent côte à côte avec leur latence et leur consommation de tokens."),
    el("p", { class: "muted" }, "Ajoutez vos clés API dans ⚙ Modèles. Deux modèles « démo » sont fournis pour tester l'interface sans clé."),
  );
}

function renderTurn(turn, idx) {
  const cards = el("div", { class: "cards" });
  for (const id of Object.keys(turn.responses)) cards.append(el("article", { class: "card", id: cardId(idx, id) }));
  const section = el(
    "section",
    { class: "turn", id: `turn-${idx}` },
    el(
      "div",
      { class: "turn-prompt" },
      el("span", { class: "who" }, `#${idx + 1}`),
      el("span", { class: "text" }, turn.prompt),
      el("button", { class: "btn ghost small", title: "Réutiliser ce prompt", onclick: () => { $("#promptInput").value = turn.prompt; $("#promptInput").focus(); } }, "↺ Réutiliser"),
    ),
    cards,
  );
  queueMicrotask(() => {
    for (const id of Object.keys(turn.responses)) updateCard(idx, id);
    updateTurnBadges(idx);
  });
  return section;
}

const cardId = (idx, modelId) => `card-${idx}-${modelId}`;
const pendingUpdates = new Set();
function scheduleCardUpdate(idx, modelId) {
  const key = `${idx}|${modelId}`;
  if (pendingUpdates.has(key)) return;
  pendingUpdates.add(key);
  requestAnimationFrame(() => {
    pendingUpdates.delete(key);
    updateCard(idx, modelId);
  });
}

const rawView = new Set();
const STATUS_LABEL = { pending: "En attente", streaming: "En cours", done: "Terminé", error: "Erreur", stopped: "Interrompu" };

function updateCard(idx, modelId) {
  const card = document.getElementById(cardId(idx, modelId));
  if (!card) return;
  const r = state.conv.turns[idx].responses[modelId];
  const m = modelById(modelId);
  const color = m?.color || r.color || "#6366f1";
  card.style.setProperty("--c", color);
  const busy = r.status === "streaming" || r.status === "pending";
  const viewRaw = rawView.has(`${idx}|${modelId}`);

  // Préserve l'état ouvert/fermé du bloc de réflexion pendant le streaming.
  const thinkingOpen = card.querySelector("details.thinking")?.open || false;
  const bodyScroll = card.querySelector(".card-body")?.scrollLeft || 0;

  const body = el("div", { class: `card-body ${viewRaw ? "raw" : "md"}` });
  if (r.text) {
    if (viewRaw) body.textContent = r.text;
    else body.innerHTML = window.renderMarkdown(r.text);
  } else if (r.status === "error") {
    body.append(el("div", { class: "err" }, r.error || "Erreur inconnue"));
  } else if (busy) {
    body.append(el("span", { class: "placeholder" }, r.thinking ? "Réflexion en cours…" : "En attente de la réponse…"));
  } else {
    body.append(el("span", { class: "placeholder" }, "Aucune réponse."));
  }
  if (r.text && r.status === "error") body.append(el("div", { class: "err" }, `\n⚠ ${r.error}`));

  const foot = el("div", { class: "card-foot" });
  if (r.latencyMs != null) foot.append(el("span", { title: "Durée totale" }, `⏱ ${fmtMs(r.latencyMs)}`));
  if (r.firstTokenMs != null) foot.append(el("span", { title: "Délai avant le premier token" }, `1er token ${fmtMs(r.firstTokenMs)}`));
  if (r.usage) foot.append(el("span", { title: "Tokens entrée → sortie" }, `🔤 ${r.usage.input ?? "?"} → ${r.usage.output ?? "?"}`));
  if (r.text) foot.append(el("span", {}, `${countWords(r.text)} mots`));
  if (r.stopReason && !["end_turn", "stop", "STOP"].includes(r.stopReason)) foot.append(el("span", { title: "Raison d'arrêt" }, `⏹ ${r.stopReason}`));
  for (const b of r.badges || []) foot.append(el("span", { class: "badge" }, b));

  const lastTurn = idx === state.conv.turns.length - 1;
  const parts = [
    el(
      "div",
      { class: "card-head" },
      el("span", { class: "name" }, modelLabel(modelId, r)),
      el("span", { class: "served", title: r.served || r.model || "" }, r.served || r.model || ""),
      el("span", { class: `status ${r.status}` }, STATUS_LABEL[r.status] || r.status),
      el(
        "span",
        { class: "card-tools" },
        busy
          ? el("button", { class: "btn ghost small", title: "Arrêter ce modèle", onclick: () => state.running.get(`${idx}:${modelId}`)?.abort() }, "■")
          : null,
        el("button", { class: "btn ghost small", title: "Copier la réponse", onclick: () => copy(r.text) }, "⧉"),
        el("button", { class: "btn ghost small", title: viewRaw ? "Afficher le rendu" : "Afficher le texte brut", onclick: () => { const k = `${idx}|${modelId}`; rawView.has(k) ? rawView.delete(k) : rawView.add(k); updateCard(idx, modelId); } }, viewRaw ? "Aa" : "</>"),
        !busy && lastTurn && m
          ? el("button", { class: "btn ghost small", title: "Relancer ce modèle", onclick: async () => { await runModel(idx, modelId); await persist(); } }, "↻")
          : null,
      ),
    ),
    r.thinking
      ? el("details", { class: "thinking", open: thinkingOpen }, el("summary", {}, `Réflexion (${countWords(r.thinking)} mots)`), el("div", {}, r.thinking))
      : null,
    body,
    ...(r.info || []).map((msg) => el("div", { class: "info-line" }, `ℹ ${msg}`)),
    foot,
  ];
  card.replaceChildren(...parts.filter(Boolean));
  card.querySelector(".card-body").scrollLeft = bodyScroll;
}

// Petits badges comparatifs une fois toutes les réponses d'un tour terminées.
function updateTurnBadges(idx) {
  const turn = state.conv.turns[idx];
  const entries = Object.entries(turn.responses);
  if (entries.some(([, r]) => r.status === "streaming" || r.status === "pending")) return;
  const done = entries.filter(([, r]) => r.status === "done" && r.text);
  for (const [, r] of entries) r.badges = [];
  if (done.length >= 2) {
    const fastest = done.reduce((a, b) => (b[1].latencyMs < a[1].latencyMs ? b : a));
    const ttft = done.filter(([, r]) => r.firstTokenMs != null);
    const shortest = done.reduce((a, b) => (b[1].text.length < a[1].text.length ? b : a));
    const longest = done.reduce((a, b) => (b[1].text.length > a[1].text.length ? b : a));
    fastest[1].badges.push("⚡ plus rapide");
    if (ttft.length >= 2) ttft.reduce((a, b) => (b[1].firstTokenMs < a[1].firstTokenMs ? b : a))[1].badges.push("🚀 1er token");
    if (shortest !== longest) {
      shortest[1].badges.push("✂ plus concise");
      longest[1].badges.push("📚 plus détaillée");
    }
  }
  for (const [id] of entries) updateCard(idx, id);
}

function scrollToTurn(idx) {
  document.getElementById(`turn-${idx}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text || "");
    toast("Réponse copiée.");
  } catch {
    toast("Copie impossible dans ce navigateur.", "error");
  }
}

function updateSystemHint() {
  const v = $("#systemInput").value.trim();
  $("#systemHint").textContent = v ? `— « ${v.slice(0, 60)}${v.length > 60 ? "…" : ""} »` : "(facultative)";
}

// ---------- export ----------
function exportMarkdown() {
  if (!state.conv.turns.length) return toast("Rien à exporter.");
  const lines = [`# ${state.conv.title || "Comparaison MultiLLM"}`, ""];
  if (state.conv.system) lines.push(`> **Consigne système :** ${state.conv.system}`, "");
  state.conv.turns.forEach((t, i) => {
    lines.push(`## Tour ${i + 1}`, "", "**Prompt :**", "", t.prompt, "");
    for (const [id, r] of Object.entries(t.responses)) {
      const meta = [r.served || r.model, r.latencyMs != null ? fmtMs(r.latencyMs) : null, r.usage ? `${r.usage.input ?? "?"}→${r.usage.output ?? "?"} tokens` : null].filter(Boolean).join(" · ");
      lines.push(`### ${modelLabel(id, r)}${meta ? ` _(${meta})_` : ""}`, "", r.status === "error" ? `⚠ Erreur : ${r.error}` : r.text || "_(aucune réponse)_", "");
    }
  });
  const blob = new Blob([lines.join("\n")], { type: "text/markdown" });
  const a = el("a", { href: URL.createObjectURL(blob), download: `multillm-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.md` });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------- historique ----------
async function openHistory() {
  const list = $("#historyList");
  list.replaceChildren(el("li", { class: "muted" }, "Chargement…"));
  $("#historyDialog").showModal();
  try {
    const items = await api("/api/history");
    list.replaceChildren();
    if (!items.length) list.append(el("li", { class: "muted" }, "Aucune conversation enregistrée."));
    for (const h of items) {
      list.append(
        el(
          "li",
          {},
          el(
            "div",
            { class: "meta", onclick: () => loadConversation(h.id) },
            el("b", {}, h.title || "Sans titre"),
            el("span", {}, `${new Date(h.updatedAt).toLocaleString("fr-FR")} · ${h.turnCount} tour(s) · ${h.modelCount} modèle(s)`),
          ),
          el("button", {
            class: "btn ghost small", title: "Supprimer",
            onclick: async (e) => {
              e.stopPropagation();
              if (!confirm("Supprimer cette conversation ?")) return;
              await api(`/api/history/${h.id}`, { method: "DELETE" });
              if (state.conv.id === h.id) state.conv.id = null;
              openHistory();
            },
          }, "🗑"),
        ),
      );
    }
  } catch (err) {
    list.replaceChildren(el("li", { class: "err" }, err.message));
  }
}

async function loadConversation(id) {
  if (state.running.size) return toast("Attendez la fin des réponses en cours.", "error");
  const conv = await api(`/api/history/${id}`);
  state.conv = { id: conv.id, title: conv.title, system: conv.system || "", turns: conv.turns || [] };
  $("#historyDialog").close();
  render();
  // Re-sélectionne les modèles de cette conversation qui existent encore.
  const ids = (conv.modelIds || []).filter((mid) => modelById(mid)?.enabled);
  if (ids.length) {
    state.selected = new Set(ids);
    saveSelection();
    renderPicker();
  }
  requestAnimationFrame(() => scrollToTurn(state.conv.turns.length - 1));
}

function newConv() {
  if (state.running.size) return toast("Attendez la fin des réponses en cours.", "error");
  const system = $("#systemInput").value;
  state.conv = newConversation();
  state.conv.system = system; // on conserve la consigne système
  render();
  $("#promptInput").focus();
}

// ---------- gestion des modèles ----------
const PRESETS = [
  { name: "— Choisir un fournisseur —" },
  { name: "OpenAI", type: "openai", baseUrl: "https://api.openai.com/v1", model: "", hint: "ex. gpt-5, gpt-4.1, o3…", color: "#10a37f" },
  { name: "Anthropic (Claude)", type: "anthropic", baseUrl: "", model: "claude-opus-5-5", color: "#d97757" },
  { name: "Google Gemini", type: "gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta", model: "", hint: "ex. gemini-2.5-pro, gemini-2.5-flash…", color: "#4285f4" },
  { name: "Mistral AI", type: "openai", baseUrl: "https://api.mistral.ai/v1", model: "mistral-large-latest", color: "#fa520f" },
  { name: "DeepSeek", type: "openai", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat", color: "#4d6bfe" },
  { name: "xAI (Grok)", type: "openai", baseUrl: "https://api.x.ai/v1", model: "", hint: "ex. grok-4…", color: "#111827" },
  { name: "Groq", type: "openai", baseUrl: "https://api.groq.com/openai/v1", model: "", hint: "ex. llama-3.3-70b-versatile…", color: "#f55036" },
  { name: "OpenRouter", type: "openai", baseUrl: "https://openrouter.ai/api/v1", model: "", hint: "ex. meta-llama/llama-3.3-70b-instruct…", color: "#6467f2" },
  { name: "Perplexity", type: "openai", baseUrl: "https://api.perplexity.ai", model: "sonar", color: "#20808d" },
  { name: "Together AI", type: "openai", baseUrl: "https://api.together.xyz/v1", model: "", hint: "ex. meta-llama/Llama-3.3-70B-Instruct-Turbo…", color: "#0f6fff" },
  { name: "Ollama (local)", type: "openai", baseUrl: "http://localhost:11434/v1", model: "", hint: "ex. llama3.1, qwen2.5…", color: "#525252" },
  { name: "Autre API compatible OpenAI", type: "openai", baseUrl: "", model: "", color: "#8b5cf6" },
  { name: "Démo (sans réseau)", type: "demo", baseUrl: "", model: "gamma", color: "#a855f7" },
];

let editingId = null;

function openModels() {
  renderModelList();
  $("#modelForm").hidden = true;
  $("#modelsDialog").showModal();
}

function renderModelList() {
  const list = $("#modelList");
  list.replaceChildren();
  if (!state.models.length) list.append(el("li", { class: "muted" }, "Aucun modèle pour l'instant."));
  state.models.forEach((m, i) => {
    const missingKey = !m.hasApiKey && m.type !== "demo" && m.type !== "openai";
    list.append(
      el(
        "li",
        { class: editingId === m.id ? "active" : "" },
        el("span", { class: "dot", style: `--c:${m.color || "#6366f1"}` }),
        el(
          "div",
          { class: `meta ${m.enabled ? "" : "disabled"}` },
          el("b", {}, m.label, m.enabled ? "" : " (désactivé)"),
          el("span", {}, `${m.type} · ${m.model || "—"}${missingKey ? " · ⚠ clé manquante" : m.apiKeyHint ? ` · ${m.apiKeyHint}` : ""}`),
        ),
        el("button", { class: "btn ghost small", title: "Monter", disabled: i === 0, onclick: () => move(i, -1) }, "↑"),
        el("button", { class: "btn ghost small", title: "Descendre", disabled: i === state.models.length - 1, onclick: () => move(i, 1) }, "↓"),
        el("button", { class: "btn ghost small", title: "Tester", onclick: () => testModel(m) }, "Tester"),
        el("button", { class: "btn ghost small", title: "Modifier", onclick: () => editModel(m) }, "✎"),
        el("button", {
          class: "btn ghost small", title: "Supprimer",
          onclick: async () => {
            if (!confirm(`Supprimer « ${m.label} » ?`)) return;
            await api(`/api/models/${m.id}`, { method: "DELETE" });
            if (editingId === m.id) $("#modelForm").hidden = true;
            await loadModels();
            renderModelList();
          },
        }, "🗑"),
      ),
    );
  });
}

async function move(i, delta) {
  const ids = state.models.map((m) => m.id);
  [ids[i], ids[i + delta]] = [ids[i + delta], ids[i]];
  state.models = await api("/api/models/order", { method: "PUT", body: { ids } });
  renderModelList();
  renderPicker();
}

async function testModel(m) {
  toast(`Test de « ${m.label} »…`);
  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ modelId: m.id, messages: [{ role: "user", content: "Réponds uniquement par : OK" }] }),
    });
    const lines = (await res.text()).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const err = lines.find((l) => l.type === "error") || (res.ok ? null : lines[0]);
    if (err) throw new Error(err.message || err.error);
    const text = lines.filter((l) => l.type === "text").map((l) => l.text).join("");
    const done = lines.find((l) => l.type === "done");
    toast(`✅ ${m.label} répond (${fmtMs(done?.latencyMs)}) : « ${text.trim().slice(0, 80)} »`);
  } catch (e) {
    toast(`❌ ${m.label} : ${e.message}`, "error");
  }
}

function fillPresets() {
  const sel = $("#presetSelect");
  sel.replaceChildren(...PRESETS.map((p, i) => el("option", { value: i }, p.name)));
}

function applyPreset(p) {
  const f = $("#modelForm");
  if (!p.type) return;
  f.type.value = p.type;
  f.baseUrl.value = p.baseUrl || "";
  f.model.value = p.model || "";
  f.model.placeholder = p.hint || "Identifiant du modèle";
  f.color.value = p.color || "#6366f1";
  if (!f.label.value || PRESETS.some((x) => x.name === f.label.value) || f.dataset.autolabel === "1") {
    f.label.value = p.model ? `${p.name.replace(/ \(.*\)$/, "")} · ${p.model}` : p.name.replace(/ \(.*\)$/, "");
    f.dataset.autolabel = "1";
  }
  syncFormVisibility();
}

function syncFormVisibility() {
  const f = $("#modelForm");
  const type = f.type.value;
  for (const node of f.querySelectorAll("[data-for]")) {
    node.hidden = !node.dataset.for.split(" ").includes(type);
  }
  const baseHints = {
    openai: "https://api.openai.com/v1",
    anthropic: "https://api.anthropic.com (par défaut)",
    gemini: "https://generativelanguage.googleapis.com/v1beta (par défaut)",
  };
  f.baseUrl.placeholder = baseHints[type] || "";
}

function editModel(m) {
  editingId = m?.id || null;
  const f = $("#modelForm");
  f.reset();
  f.dataset.autolabel = m ? "0" : "1";
  $("#formTitle").textContent = m ? `Modifier « ${m.label} »` : "Nouveau modèle";
  $("#presetSelect").value = "0";
  $("#formError").textContent = "";
  $("#apiKeyHint").textContent = m?.apiKeyHint
    ? `Clé actuelle : ${m.apiKeyHint} — laisser vide pour la conserver.`
    : "Astuce : « env:OPENAI_API_KEY » lit la clé depuis une variable d'environnement du serveur.";
  if (m) {
    f.label.value = m.label;
    f.type.value = m.type;
    f.baseUrl.value = m.baseUrl || "";
    f.model.value = m.model || "";
    f.color.value = m.color || "#6366f1";
    f.temperature.value = m.temperature ?? "";
    f.maxTokens.value = m.maxTokens ?? "";
    f.thinking.value = m.thinking || "";
    f.effort.value = m.effort || "";
    f.fallbacks.checked = m.fallbacks !== false;
    f.extraParams.value = m.extraParams ? JSON.stringify(m.extraParams) : "";
    f.enabled.checked = m.enabled !== false;
  } else {
    f.type.value = "openai";
  }
  syncFormVisibility();
  f.hidden = false;
  renderModelList();
  f.label.focus();
}

async function submitModel(e) {
  e.preventDefault();
  const f = $("#modelForm");
  const type = f.type.value;
  const payload = {
    label: f.label.value,
    type,
    baseUrl: f.baseUrl.value,
    model: f.model.value,
    color: f.color.value,
    temperature: type === "anthropic" ? null : f.temperature.value,
    maxTokens: f.maxTokens.value,
    thinking: f.thinking.value,
    effort: f.effort.value,
    fallbacks: f.fallbacks.checked,
    extraParams: f.extraParams.value,
    enabled: f.enabled.checked,
  };
  if (f.apiKey.value) payload.apiKey = f.apiKey.value;
  try {
    if (payload.extraParams.trim()) JSON.parse(payload.extraParams);
  } catch {
    $("#formError").textContent = "Les paramètres supplémentaires ne sont pas un JSON valide.";
    return;
  }
  try {
    const saved = editingId
      ? await api(`/api/models/${editingId}`, { method: "PUT", body: payload })
      : await api("/api/models", { method: "POST", body: payload });
    if (!editingId && saved.enabled) {
      state.selected.add(saved.id);
      saveSelection();
    }
    editingId = null;
    f.hidden = true;
    await loadModels();
    renderModelList();
    toast(`« ${saved.label} » enregistré.`);
  } catch (err) {
    $("#formError").textContent = err.message;
  }
}

// ---------- thème ----------
function applyTheme(theme) {
  if (theme) document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
}
function toggleTheme() {
  const dark = document.documentElement.dataset.theme
    ? document.documentElement.dataset.theme === "dark"
    : matchMedia("(prefers-color-scheme: dark)").matches;
  const next = dark ? "light" : "dark";
  applyTheme(next);
  store.set("multillm.theme", next);
}

// ---------- initialisation ----------
function init() {
  applyTheme(store.get("multillm.theme", null));
  $("#sendBtn").addEventListener("click", send);
  $("#stopBtn").addEventListener("click", stopAll);
  $("#promptInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      if (!state.running.size) send();
    }
  });
  $("#systemInput").addEventListener("input", updateSystemHint);
  $("#newConvBtn").addEventListener("click", newConv);
  $("#exportBtn").addEventListener("click", exportMarkdown);
  $("#historyBtn").addEventListener("click", openHistory);
  $("#modelsBtn").addEventListener("click", openModels);
  $("#themeBtn").addEventListener("click", toggleTheme);
  $("#addModelBtn").addEventListener("click", () => editModel(null));
  $("#cancelFormBtn").addEventListener("click", () => { editingId = null; $("#modelForm").hidden = true; renderModelList(); });
  $("#modelForm").addEventListener("submit", submitModel);
  $("#modelForm").type.addEventListener("change", syncFormVisibility);
  $("#modelForm").label.addEventListener("input", () => { $("#modelForm").dataset.autolabel = "0"; });
  $("#presetSelect").addEventListener("change", (e) => applyPreset(PRESETS[Number(e.target.value)]));
  for (const d of document.querySelectorAll("dialog")) {
    d.querySelector("[data-close]")?.addEventListener("click", () => d.close());
    d.addEventListener("click", (e) => { if (e.target === d) d.close(); });
  }
  fillPresets();
  updateSystemHint();
  loadModels().catch((err) => toast(`Chargement des modèles impossible : ${err.message}`, "error"));
}

init();
