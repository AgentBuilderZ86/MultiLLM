// MultiLLM – serveur HTTP (aucun framework) :
//  - sert l'interface web (public/)
//  - stocke la configuration des modèles et les clés API côté serveur
//  - relaie chaque requête vers le bon fournisseur et renvoie la réponse en streaming (NDJSON)
import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { timingSafeEqual } from "node:crypto";
import * as store from "./lib/store.js";
import { adapters } from "./providers/index.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
if (existsSync(path.join(ROOT, ".env"))) process.loadEnvFile?.(path.join(ROOT, ".env"));

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "127.0.0.1";
const PASSWORD = process.env.MULTILLM_PASSWORD || "";
const PUBLIC_DIR = path.join(ROOT, "public");
const MAX_BODY = 20 * 1024 * 1024;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".ico": "image/x-icon",
};

// ---------- utilitaires HTTP ----------

function sendJson(res, status, value) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(value));
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw Object.assign(new Error("Requête trop volumineuse"), { status: 413 });
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw Object.assign(new Error("JSON invalide"), { status: 400 });
  }
}

function checkAuth(req, res) {
  if (!PASSWORD) return true;
  const header = req.headers.authorization || "";
  const [scheme, encoded] = header.split(" ");
  if (scheme === "Basic" && encoded) {
    const pass = Buffer.from(encoded, "base64").toString("utf8").split(":").slice(1).join(":");
    const a = Buffer.from(pass);
    const b = Buffer.from(PASSWORD);
    if (a.length === b.length && timingSafeEqual(a, b)) return true;
  }
  res.writeHead(401, { "WWW-Authenticate": 'Basic realm="MultiLLM"' });
  res.end("Authentification requise");
  return false;
}

async function serveStatic(req, res, pathname) {
  const rel = pathname === "/" ? "index.html" : decodeURIComponent(pathname).replace(/^\/+/, "");
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return sendJson(res, 403, { error: "Interdit" });
  try {
    const info = await stat(file);
    if (!info.isFile()) throw new Error();
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(file)] || "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    res.end(await readFile(file));
  } catch {
    sendJson(res, 404, { error: "Introuvable" });
  }
}

// ---------- appel d'un modèle en streaming ----------

async function handleChat(req, res) {
  const { modelId, system = "", messages = [] } = await readBody(req);
  const config = await store.getModel(modelId);
  if (!config) return sendJson(res, 404, { error: "Modèle introuvable" });
  if (!Array.isArray(messages) || !messages.length || messages.at(-1).role !== "user") {
    return sendJson(res, 400, { error: "La conversation doit se terminer par un message utilisateur" });
  }
  const clean = messages
    .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .map((m) => ({ role: m.role, content: m.content, ...(m.raw ? { raw: m.raw } : {}) }));

  const apiKey = store.resolveApiKey(config);
  const adapter = adapters[config.type];

  res.writeHead(200, {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Accel-Buffering": "no",
  });
  const send = (obj) => res.write(JSON.stringify(obj) + "\n");

  const controller = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) controller.abort();
  });

  const started = performance.now();
  let firstTokenMs = null;
  let usage = null;
  let stopReason = null;
  let assistant = { raw: null, text: "" };

  try {
    if (config.type !== "demo" && !apiKey && config.type !== "openai") {
      throw new Error("Aucune clé API configurée pour ce modèle (voir « Modèles »).");
    }
    for await (const ev of adapter({ config, apiKey, system, messages: clean, signal: controller.signal })) {
      if (controller.signal.aborted) break;
      switch (ev.type) {
        case "text":
        case "thinking":
          if (firstTokenMs === null) firstTokenMs = Math.round(performance.now() - started);
          send({ type: ev.type, text: ev.text });
          break;
        case "served":
          send({ type: "served", model: ev.model });
          break;
        case "info":
          send({ type: "info", message: ev.message });
          break;
        case "usage":
          usage = { input: ev.input, output: ev.output };
          break;
        case "stop":
          stopReason = ev.reason;
          break;
        case "assistant":
          assistant = { raw: ev.raw, text: ev.text };
          break;
      }
    }
    send({
      type: "done",
      latencyMs: Math.round(performance.now() - started),
      firstTokenMs,
      usage,
      stopReason,
      raw: assistant.raw,
    });
  } catch (err) {
    if (controller.signal.aborted || err?.name === "AbortError") {
      // Le client a interrompu la requête : rien à renvoyer.
    } else {
      let message = err?.message || String(err);
      // fetch() masque la cause réelle (DNS, connexion refusée…) : on la rend visible.
      const cause = err?.cause?.code || err?.cause?.message;
      if (cause && !message.includes(cause)) message += ` (${cause})`;
      console.error(`[${config.label}]`, message);
      send({
        type: "error",
        message,
        latencyMs: Math.round(performance.now() - started),
      });
    }
  } finally {
    res.end();
  }
}

// ---------- routeur ----------

const routes = [
  ["GET", /^\/api\/models$/, async (req, res) => {
    sendJson(res, 200, (await store.listModels()).map(store.publicModel));
  }],
  ["POST", /^\/api\/models$/, async (req, res) => {
    sendJson(res, 201, store.publicModel(await store.createModel(await readBody(req))));
  }],
  ["PUT", /^\/api\/models\/order$/, async (req, res) => {
    const { ids } = await readBody(req);
    sendJson(res, 200, (await store.reorderModels(ids || [])).map(store.publicModel));
  }],
  ["PUT", /^\/api\/models\/([\w-]+)$/, async (req, res, [, id]) => {
    const updated = await store.updateModel(id, await readBody(req));
    updated ? sendJson(res, 200, store.publicModel(updated)) : sendJson(res, 404, { error: "Modèle introuvable" });
  }],
  ["DELETE", /^\/api\/models\/([\w-]+)$/, async (req, res, [, id]) => {
    (await store.deleteModel(id)) ? sendJson(res, 200, { ok: true }) : sendJson(res, 404, { error: "Modèle introuvable" });
  }],
  ["POST", /^\/api\/chat$/, (req, res) => handleChat(req, res)],
  ["GET", /^\/api\/history$/, async (req, res) => sendJson(res, 200, await store.listHistory())],
  ["GET", /^\/api\/history\/([\w-]+)$/, async (req, res, [, id]) => {
    const item = await store.getHistory(id);
    item ? sendJson(res, 200, item) : sendJson(res, 404, { error: "Conversation introuvable" });
  }],
  ["POST", /^\/api\/history$/, async (req, res) => sendJson(res, 200, await store.saveHistory(await readBody(req)))],
  ["DELETE", /^\/api\/history\/([\w-]+)$/, async (req, res, [, id]) => {
    await store.deleteHistory(id);
    sendJson(res, 200, { ok: true });
  }],
];

const server = http.createServer(async (req, res) => {
  try {
    if (!checkAuth(req, res)) return;
    const { pathname } = new URL(req.url, "http://localhost");
    if (pathname.startsWith("/api/")) {
      for (const [method, pattern, handler] of routes) {
        const match = pathname.match(pattern);
        if (match && req.method === method) return await handler(req, res, match);
      }
      return sendJson(res, 404, { error: "Route inconnue" });
    }
    if (req.method !== "GET" && req.method !== "HEAD") return sendJson(res, 405, { error: "Méthode non autorisée" });
    await serveStatic(req, res, pathname);
  } catch (err) {
    if (!res.headersSent) sendJson(res, err.status || 400, { error: err.message || String(err) });
    else res.end();
  }
});

// Premier lancement : on ajoute deux modèles « démo » pour pouvoir tester l'interface tout de suite.
if ((await store.listModels()).length === 0 && !process.env.MULTILLM_NO_SEED) {
  await store.createModel({ label: "Démo A", type: "demo", model: "alpha", color: "#6366f1" });
  await store.createModel({ label: "Démo B", type: "demo", model: "beta", color: "#10b981" });
}

server.listen(PORT, HOST, () => {
  console.log(`MultiLLM prêt sur http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}`);
  if (HOST !== "127.0.0.1" && HOST !== "localhost" && !PASSWORD) {
    console.warn("⚠  Le serveur est exposé sur le réseau sans mot de passe (définissez MULTILLM_PASSWORD).");
  }
});
