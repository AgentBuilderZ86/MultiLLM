// Persistance simple dans des fichiers JSON (dossier data/, ignoré par git).
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const DATA_DIR = process.env.MULTILLM_DATA_DIR || path.join(process.cwd(), "data");
const MODELS_FILE = path.join(DATA_DIR, "models.json");
const HISTORY_FILE = path.join(DATA_DIR, "history.json");

async function readJson(file, fallback) {
  if (!existsSync(file)) return fallback;
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

// Écriture atomique : fichier temporaire puis renommage.
async function writeJson(file, value) {
  await mkdir(DATA_DIR, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  await rename(tmp, file);
}

// Les écritures sont sérialisées pour éviter les pertes lors d'appels concurrents.
let queue = Promise.resolve();
function serialized(fn) {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

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
      if (typeof v === "string") {
        v = v.trim() ? JSON.parse(v) : null;
      }
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

export async function listModels() {
  return readJson(MODELS_FILE, []);
}

export async function getModel(id) {
  return (await listModels()).find((m) => m.id === id) || null;
}

export function createModel(input) {
  return serialized(async () => {
    const models = await listModels();
    const model = sanitizeModel(
      { enabled: true, ...input },
      { id: randomUUID(), createdAt: new Date().toISOString() },
    );
    models.push(model);
    await writeJson(MODELS_FILE, models);
    return model;
  });
}

export function updateModel(id, input) {
  return serialized(async () => {
    const models = await listModels();
    const idx = models.findIndex((m) => m.id === id);
    if (idx === -1) return null;
    models[idx] = sanitizeModel(input, models[idx]);
    await writeJson(MODELS_FILE, models);
    return models[idx];
  });
}

export function deleteModel(id) {
  return serialized(async () => {
    const models = await listModels();
    const next = models.filter((m) => m.id !== id);
    await writeJson(MODELS_FILE, next);
    return next.length !== models.length;
  });
}

export function reorderModels(ids) {
  return serialized(async () => {
    const models = await listModels();
    const byId = new Map(models.map((m) => [m.id, m]));
    const ordered = ids.map((id) => byId.get(id)).filter(Boolean);
    for (const m of models) if (!ids.includes(m.id)) ordered.push(m);
    await writeJson(MODELS_FILE, ordered);
    return ordered;
  });
}

// La clé peut être écrite en clair ou sous la forme "env:NOM_VARIABLE".
export function resolveApiKey(model) {
  const key = model.apiKey || "";
  if (key.startsWith("env:")) return process.env[key.slice(4)] || "";
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

export async function listHistory() {
  const items = await readJson(HISTORY_FILE, []);
  return items
    .map(({ id, title, createdAt, updatedAt, modelIds, turns }) => ({
      id, title, createdAt, updatedAt, modelCount: modelIds?.length || 0, turnCount: turns?.length || 0,
    }))
    .sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
}

export async function getHistory(id) {
  return (await readJson(HISTORY_FILE, [])).find((h) => h.id === id) || null;
}

export function saveHistory(entry) {
  return serialized(async () => {
    const items = await readJson(HISTORY_FILE, []);
    const now = new Date().toISOString();
    const id = entry.id || randomUUID();
    const idx = items.findIndex((h) => h.id === id);
    const record = { ...entry, id, updatedAt: now, createdAt: idx === -1 ? now : items[idx].createdAt };
    if (idx === -1) items.push(record);
    else items[idx] = record;
    // On garde les 200 conversations les plus récentes.
    items.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
    await writeJson(HISTORY_FILE, items.slice(0, 200));
    return record;
  });
}

export function deleteHistory(id) {
  return serialized(async () => {
    const items = await readJson(HISTORY_FILE, []);
    await writeJson(HISTORY_FILE, items.filter((h) => h.id !== id));
  });
}
