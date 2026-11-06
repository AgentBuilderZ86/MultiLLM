// Gestionnaire de l'API (/api/*) au format Web standard (Request → Response).
// Utilisé à la fois par le serveur Node local (server.js) et par la fonction Netlify.
import { timingSafeEqual, createHash } from "node:crypto";
import * as store from "./store.js";
import { isNetlify } from "./backend.js";
import { adapters } from "../providers/index.js";

const MAX_BODY = 20 * 1024 * 1024;
const getEnv = (name) => globalThis.Netlify?.env?.get(name) ?? process.env[name];

const json = (status, value) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function readBody(request) {
  const text = await request.text();
  if (text.length > MAX_BODY) throw new HttpError(413, "Requête trop volumineuse");
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "JSON invalide");
  }
}

// ---------- authentification ----------
// Mot de passe défini par MULTILLM_PASSWORD. Obligatoire sur Netlify : sans lui,
// n'importe qui pourrait utiliser vos clés API.
const digest = (s) => createHash("sha256").update(s).digest();

function checkAuth(request) {
  const password = getEnv("MULTILLM_PASSWORD") || "";
  if (!password) {
    return isNetlify()
      ? json(503, { error: "Définissez la variable d'environnement MULTILLM_PASSWORD sur Netlify pour activer l'application.", code: "no_password" })
      : null;
  }
  let given = request.headers.get("x-multillm-password") || "";
  const auth = request.headers.get("authorization") || "";
  if (!given && auth.startsWith("Basic ")) {
    given = Buffer.from(auth.slice(6), "base64").toString("utf8").split(":").slice(1).join(":");
  }
  if (given && timingSafeEqual(digest(given), digest(password))) return null;
  return json(401, { error: given ? "Mot de passe incorrect" : "Mot de passe requis", code: "auth" });
}

// ---------- appel d'un modèle en streaming ----------

async function handleChat(request) {
  const { modelId, system = "", messages = [] } = await readBody(request);
  const config = await store.getModel(modelId);
  if (!config) return json(404, { error: "Modèle introuvable" });
  if (!Array.isArray(messages) || !messages.length || messages.at(-1).role !== "user") {
    return json(400, { error: "La conversation doit se terminer par un message utilisateur" });
  }
  const clean = messages
    .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .map((m) => ({ role: m.role, content: m.content, ...(m.raw ? { raw: m.raw } : {}) }));

  const apiKey = store.resolveApiKey(config);
  const adapter = adapters[config.type];
  const controller = new AbortController();
  request.signal?.addEventListener("abort", () => controller.abort());
  const encoder = new TextEncoder();

  const body = new ReadableStream({
    async start(out) {
      const send = (obj) => {
        try {
          out.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
        } catch {
          controller.abort(); // flux fermé côté client
        }
      };
      const started = performance.now();
      let firstTokenMs = null;
      let usage = null;
      let stopReason = null;
      let assistant = { raw: null, text: "" };
      try {
        if (config.type !== "demo" && config.type !== "openai" && !apiKey) {
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
        send({ type: "done", latencyMs: Math.round(performance.now() - started), firstTokenMs, usage, stopReason, raw: assistant.raw });
      } catch (err) {
        if (!(controller.signal.aborted || err?.name === "AbortError")) {
          let message = err?.message || String(err);
          // fetch() masque la cause réelle (DNS, connexion refusée…) : on la rend visible.
          const cause = err?.cause?.code || err?.cause?.message;
          if (cause && !message.includes(cause)) message += ` (${cause})`;
          console.error(`[${config.label}]`, message);
          send({ type: "error", message, latencyMs: Math.round(performance.now() - started) });
        }
      } finally {
        try {
          out.close();
        } catch {
          /* déjà fermé */
        }
      }
    },
    cancel() {
      controller.abort();
    },
  });

  return new Response(body, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
    },
  });
}

// ---------- routes ----------

const routes = [
  ["GET", /^\/api\/models$/, async () => json(200, (await store.listModels()).map(store.publicModel))],
  ["POST", /^\/api\/models$/, async (req) => json(201, store.publicModel(await store.createModel(await readBody(req))))],
  ["PUT", /^\/api\/models\/order$/, async (req) => {
    const { ids } = await readBody(req);
    return json(200, (await store.reorderModels(ids || [])).map(store.publicModel));
  }],
  ["PUT", /^\/api\/models\/([\w-]+)$/, async (req, [, id]) => {
    const updated = await store.updateModel(id, await readBody(req));
    return updated ? json(200, store.publicModel(updated)) : json(404, { error: "Modèle introuvable" });
  }],
  ["DELETE", /^\/api\/models\/([\w-]+)$/, async (req, [, id]) =>
    (await store.deleteModel(id)) ? json(200, { ok: true }) : json(404, { error: "Modèle introuvable" })],
  ["POST", /^\/api\/chat$/, (req) => handleChat(req)],
  ["GET", /^\/api\/history$/, async () => json(200, await store.listHistory())],
  ["GET", /^\/api\/history\/([\w-]+)$/, async (req, [, id]) => {
    const item = await store.getHistory(id);
    return item ? json(200, item) : json(404, { error: "Conversation introuvable" });
  }],
  ["POST", /^\/api\/history$/, async (req) => json(200, await store.saveHistory(await readBody(req)))],
  ["DELETE", /^\/api\/history\/([\w-]+)$/, async (req, [, id]) => {
    await store.deleteHistory(id);
    return json(200, { ok: true });
  }],
];

export async function handleApi(request) {
  try {
    const { pathname } = new URL(request.url);
    const denied = checkAuth(request);
    if (denied) return denied;
    for (const [method, pattern, handler] of routes) {
      const match = pathname.match(pattern);
      if (match && request.method === method) return await handler(request, match);
    }
    return json(404, { error: "Route inconnue" });
  } catch (err) {
    return json(err.status || 400, { error: err.message || String(err) });
  }
}
