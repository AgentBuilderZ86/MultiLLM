// Tests du gestionnaire d'API commun (local et Netlify), avec stockage fichier temporaire.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

let handleApi;
before(async () => {
  process.env.MULTILLM_DATA_DIR = await mkdtemp(path.join(tmpdir(), "multillm-"));
  process.env.MULTILLM_PASSWORD = "secret";
  ({ handleApi } = await import("../lib/api.js"));
});

const call = (method, url, body, password = "secret") =>
  handleApi(
    new Request(`http://localhost${url}`, {
      method,
      headers: { "Content-Type": "application/json", ...(password ? { "X-MultiLLM-Password": password } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    }),
  );

test("mot de passe obligatoire quand MULTILLM_PASSWORD est défini", async () => {
  assert.equal((await call("GET", "/api/models", null, null)).status, 401);
  assert.equal((await call("GET", "/api/models", null, "faux")).status, 401);
  assert.equal((await call("GET", "/api/models")).status, 200);
});

test("modèles : création, masquage de la clé, modification, suppression", async () => {
  const seeded = await (await call("GET", "/api/models")).json();
  assert.equal(seeded.length, 2, "deux modèles démo au premier lancement");

  const res = await call("POST", "/api/models", { label: "GPT", type: "openai", model: "gpt-x", apiKey: "sk-abcdef1234" });
  assert.equal(res.status, 201);
  const created = await res.json();
  assert.equal(created.apiKey, undefined, "la clé n'est jamais renvoyée");
  assert.equal(created.apiKeyHint, "••••1234");

  const updated = await (await call("PUT", `/api/models/${created.id}`, { label: "GPT 2", apiKey: "" })).json();
  assert.equal(updated.label, "GPT 2");
  assert.equal(updated.apiKeyHint, "••••1234", "clé vide = clé conservée");

  assert.equal((await call("POST", "/api/models", { label: "X", type: "inconnu", model: "m" })).status, 400);
  assert.equal((await call("DELETE", `/api/models/${created.id}`)).status, 200);
  assert.equal((await (await call("GET", "/api/models")).json()).length, 2);
});

test("chat : réponse en streaming NDJSON puis historique", async () => {
  const [demo] = await (await call("GET", "/api/models")).json();
  const res = await call("POST", "/api/chat", { modelId: demo.id, messages: [{ role: "user", content: "bonjour le monde" }] });
  assert.equal(res.headers.get("content-type"), "application/x-ndjson; charset=utf-8");
  const events = (await res.text()).trim().split("\n").map((l) => JSON.parse(l));
  assert.match(events.filter((e) => e.type === "text").map((e) => e.text).join(""), /3 mots/);
  assert.equal(events.at(-1).type, "done");

  const saved = await (await call("POST", "/api/history", { title: "Essai", modelIds: [demo.id], turns: [{ prompt: "p", responses: {} }] })).json();
  const list = await (await call("GET", "/api/history")).json();
  assert.equal(list[0].id, saved.id);
  assert.equal(list[0].turnCount, 1);
  assert.equal((await (await call("GET", `/api/history/${saved.id}`)).json()).title, "Essai");
  await call("DELETE", `/api/history/${saved.id}`);
  assert.equal((await (await call("GET", "/api/history")).json()).length, 0);
});
