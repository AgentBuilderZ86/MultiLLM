// MultiLLM – serveur local (Node, sans framework) :
//  - sert l'interface web (public/)
//  - transmet /api/* au gestionnaire commun (lib/api.js), aussi utilisé sur Netlify
import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { Readable } from "node:stream";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
if (existsSync(path.join(ROOT, ".env"))) process.loadEnvFile?.(path.join(ROOT, ".env"));
const { handleApi } = await import("./lib/api.js");

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "127.0.0.1";
const PUBLIC_DIR = path.join(ROOT, "public");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json; charset=utf-8",
  ".ico": "image/x-icon",
};

async function serveStatic(res, pathname) {
  const rel = pathname === "/" ? "index.html" : decodeURIComponent(pathname).replace(/^\/+/, "");
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  try {
    if (!file.startsWith(PUBLIC_DIR + path.sep)) throw new Error("hors du dossier public");
    const info = await stat(file);
    if (!info.isFile()) throw new Error("pas un fichier");
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-cache" });
    res.end(await readFile(file));
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Introuvable");
  }
}

// Convertit la requête Node en Request Web, et la Response Web en réponse Node (streaming compris).
async function serveApi(req, res) {
  const controller = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) controller.abort();
  });
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  const request = new Request(new URL(req.url, `http://${req.headers.host || "localhost"}`), {
    method: req.method,
    headers: req.headers,
    body: hasBody ? Readable.toWeb(req) : undefined,
    duplex: hasBody ? "half" : undefined,
    signal: controller.signal,
  });
  const response = await handleApi(request);
  res.writeHead(response.status, Object.fromEntries(response.headers));
  if (!response.body) return res.end();
  const reader = response.body.getReader();
  controller.signal.addEventListener("abort", () => reader.cancel().catch(() => {}));
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      res.write(value);
    }
  } catch {
    /* client déconnecté */
  }
  res.end();
}

const server = http.createServer(async (req, res) => {
  try {
    const { pathname } = new URL(req.url, "http://localhost");
    if (pathname.startsWith("/api/")) return await serveApi(req, res);
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405);
      return res.end();
    }
    await serveStatic(res, pathname);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }
});

server.listen(PORT, HOST, () => {
  console.log(`MultiLLM prêt sur http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}`);
  if (HOST !== "127.0.0.1" && HOST !== "localhost" && !process.env.MULTILLM_PASSWORD) {
    console.warn("⚠  Le serveur est exposé sur le réseau sans mot de passe (définissez MULTILLM_PASSWORD).");
  }
});
