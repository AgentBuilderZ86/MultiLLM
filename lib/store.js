// Modèles configurés et historique des comparaisons.
import { randomUUID } from "node:crypto";
import { backend } from "./backend.js";

const MODELS_KEY = "models";
const HISTORY_INDEX_KEY = "history-index";
const historyKey = (id) => `history-${id}`;

// Les écritures sont sérialisées (dans une même instance) pour éviter les pertes.
let queue = Promise.resolve();
function serialized(fn) {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

const getEnv = (name) => globalThis.Netlify?.env?.get(name) ?? process.env[name];

// ---------- Modèles ----------

export const PROVIDER_TYPES = ["openai", "anthropic", "gemini", "demo"];

const EDITABLE_FIELDS = [
  "label", "type", "model", "baseUrl", "apiKey", "enabled",
  "temperature", "maxTokens", "thinking", "effort", "fallbacks", "extraParams", "color",
];

function sanitizeModel(input, existing = {}) {
  const out = { ...existing };
  for (const key of EDITABLE_FIELDS) {
    if (!(key in input)) continue;
    let v = input[key];
    if (key === "apiKey" && (v === "" || v == null)) continue; // vide = conserver la clé existante
    if (key === "temperature" || key === "maxTokens") {
      v = v === "" || v == null ? null : Number(v);
      if (v !== null && !Number.isFinite(v)) throw new Error(`Valeur invalide pour ${key}`);
    }
    if (key === "enabled" || key === "fallbacks") v = Boolean(v);
    if (key === "extraParams") {
      if (typeof v === "string") v = v.trim() ? JSON.parse(v) : null;
      if (v != null && (typeof v !== "object" || Array.isArray(v))) {
        throw new Error("Les paramètres supplémentaires doivent être un objet JSON");
      }
    }
    if (typeof v === "string") v = v.trim();
    out[key] = v;
  }
  if (!out.label) throw new Error("Le nom affiché est obligatoire");
  if (!PROVIDER_TYPES.includes(out.type)) throw new Error(`Type de fournisseur inconnu : ${out.type}`);
  if (out.type !== "demo" && !out.model) throw new Error("L'identifiant du modèle est obligatoire");
  return out;
}

function demoModels() {
  const now = new Date().toISOString();
  return [
    { id: randomUUID(), createdAt: now, label: "Démo A", type: "demo", model: "alpha", color: "#6366f1", enabled: true },
    { id: randomUUID(), createdAt: now, label: "Démo B", type: "demo", model: "beta", color: "#10b981", enabled: true },
  ];
}

export async function listModels() {
  const db = await backend();
  const models = await db.get(MODELS_KEY);
  if (models) return models;
  // Premier lancement : deux modèles « démo » pour tester l'interface sans clé.
  if (getEnv("MULTILLM_NO_SEED")) return [];
  return serialized(async () => {
    const again = await db.get(MODELS_KEY);
    if (again) return again;
    const seeded = demoModels();
    await db.set(MODELS_KEY, seeded);
    return seeded;
  });
}

const saveModels = async (models) => (await backend()).set(MODELS_KEY, models);

export async function getModel(id) {
  return (await listModels()).find((m) => m.id === id) || null;
}

export function createModel(input) {
  return serialized(async () => {
    const models = await listModels();
    const model = sanitizeModel({ enabled: true, ...input }, { id: randomUUID(), createdAt: new Date().toISOString() });
    models.push(model);
    await saveModels(models);
    return model;
  });
}

export function updateModel(id, input) {
  return serialized(async () => {
    const models = await listModels();
    const idx = models.findIndex((m) => m.id === id);
    if (idx === -1) return null;
    models[idx] = sanitizeModel(input, models[idx]);
    await saveModels(models);
    return models[idx];
  });
}

export function deleteModel(id) {
  return serialized(async () => {
    const models = await listModels();
    const next = models.filter((m) => m.id !== id);
    await saveModels(next);
    return next.length !== models.length;
  });
}

export function reorderModels(ids) {
  return serialized(async () => {
    const models = await listModels();
    const byId = new Map(models.map((m) => [m.id, m]));
    const ordered = ids.map((id) => byId.get(id)).filter(Boolean);
    for (const m of models) if (!ids.includes(m.id)) ordered.push(m);
    await saveModels(ordered);
    return ordered;
  });
}

// La clé peut être écrite en clair ou sous la forme "env:NOM_VARIABLE".
export function resolveApiKey(model) {
  const key = model.apiKey || "";
  if (key.startsWith("env:")) return getEnv(key.slice(4)) || "";
  return key;
}

// Version sans secret, envoyée au navigateur.
export function publicModel(model) {
  const { apiKey, ...rest } = model;
  let apiKeyHint = "";
  if (apiKey?.startsWith("env:")) apiKeyHint = apiKey;
  else if (apiKey) apiKeyHint = `••••${apiKey.slice(-4)}`;
  return { ...rest, hasApiKey: Boolean(resolveApiKey(model)), apiKeyHint };
}

// ---------- Historique des comparaisons ----------
// Une entrée par conversation + un index des résumés pour la liste.

const MAX_HISTORY = 200;

export async function listHistory() {
  const index = (await (await backend()).get(HISTORY_INDEX_KEY)) || [];
  return index.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
}

export async function getHistory(id) {
  if (!/^[\w-]+$/.test(id)) return null;
  return (await backend()).get(historyKey(id));
}

export function saveHistory(entry) {
  return serialized(async () => {
    const db = await backend();
    const now = new Date().toISOString();
    const id = entry.id && /^[\w-]+$/.test(entry.id) ? entry.id : randomUUID();
    const index = (await db.get(HISTORY_INDEX_KEY)) || [];
    const existing = index.find((h) => h.id === id);
    const record = { ...entry, id, updatedAt: now, createdAt: existing?.createdAt || now };
    await db.set(historyKey(id), record);
    const summary = {
      id, title: record.title, createdAt: record.createdAt, updatedAt: now,
      modelCount: record.modelIds?.length || 0, turnCount: record.turns?.length || 0,
    };
    const next = [summary, ...index.filter((h) => h.id !== id)]
      .sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
    for (const old of next.slice(MAX_HISTORY)) await db.delete(historyKey(old.id));
    await db.set(HISTORY_INDEX_KEY, next.slice(0, MAX_HISTORY));
    return record;
  });
}

export function deleteHistory(id) {
  return serialized(async () => {
    const db = await backend();
    const index = (await db.get(HISTORY_INDEX_KEY)) || [];
    await db.delete(historyKey(id));
    await db.set(HISTORY_INDEX_KEY, index.filter((h) => h.id !== id));
  });
}
