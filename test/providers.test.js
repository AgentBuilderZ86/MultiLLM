// Tests de bout en bout : chaque adaptateur est branché sur un faux serveur local
// qui imite le format de streaming du fournisseur réel.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { streamOpenAI } from "../providers/openai.js";
import { streamAnthropic } from "../providers/anthropic.js";
import { streamGemini } from "../providers/gemini.js";
import { streamDemo } from "../providers/demo.js";

let mock;
let base;
const received = {};

const sse = (res, events) => {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  for (const e of events) res.write(e);
  res.end();
};

before(async () => {
  mock = http.createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    const json = body ? JSON.parse(body) : {};
    const url = new URL(req.url, "http://x");

    if (url.pathname === "/openai/chat/completions") {
      received.openai = { json, auth: req.headers.authorization };
      const chunk = (o) => `data: ${JSON.stringify(o)}\n\n`;
      return sse(res, [
        chunk({ model: "gpt-test", choices: [{ delta: { role: "assistant", content: "" } }] }),
        chunk({ model: "gpt-test", choices: [{ delta: { content: "Bon" } }] }),
        chunk({ model: "gpt-test", choices: [{ delta: { content: "jour" }, finish_reason: "stop" }] }),
        chunk({ model: "gpt-test", choices: [], usage: { prompt_tokens: 7, completion_tokens: 2 } }),
        "data: [DONE]\n\n",
      ]);
    }
    if (url.pathname === "/openai-err/chat/completions") {
      res.writeHead(401, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: { message: "Invalid API key" } }));
    }
    if (url.pathname === "/anthropic/v1/messages") {
      received.anthropic = {
        json,
        key: req.headers["x-api-key"] || req.headers.authorization?.replace(/^Bearer /, ""),
        beta: req.headers["anthropic-beta"],
      };
      const ev = (type, o) => `event: ${type}\ndata: ${JSON.stringify({ type, ...o })}\n\n`;
      return sse(res, [
        ev("message_start", {
          message: {
            id: "msg_1", type: "message", role: "assistant", model: json.model, content: [],
            stop_reason: null, stop_sequence: null, usage: { input_tokens: 11, output_tokens: 1 },
          },
        }),
        ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
        ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: "Salut " } }),
        ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: "Claude" } }),
        ev("content_block_stop", { index: 0 }),
        ev("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 4 } }),
        ev("message_stop", {}),
      ]);
    }
    if (url.pathname.startsWith("/gemini/models/")) {
      received.gemini = { json, key: req.headers["x-goog-api-key"], path: url.pathname, alt: url.searchParams.get("alt") };
      const chunk = (o) => `data: ${JSON.stringify(o)}\r\n\r\n`;
      return sse(res, [
        chunk({ candidates: [{ content: { role: "model", parts: [{ text: "Hello " }] } }], modelVersion: "gemini-test" }),
        chunk({
          candidates: [{ content: { role: "model", parts: [{ text: "Gemini" }] }, finishReason: "STOP" }],
          usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3 },
        }),
      ]);
    }
    res.writeHead(404).end();
  });
  await new Promise((r) => mock.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${mock.address().port}`;
});

after(() => mock.close());

async function collect(gen) {
  const events = [];
  for await (const e of gen) events.push(e);
  return {
    events,
    text: events.filter((e) => e.type === "text").map((e) => e.text).join(""),
    usage: events.find((e) => e.type === "usage"),
    served: events.filter((e) => e.type === "served").at(-1)?.model,
    final: events.find((e) => e.type === "assistant"),
  };
}

const history = [
  { role: "user", content: "Q1" },
  { role: "assistant", content: "R1" },
  { role: "user", content: "Q2" },
];

test("adaptateur compatible OpenAI : streaming, usage, consigne système", async () => {
  const r = await collect(
    streamOpenAI({
      config: { model: "gpt-test", baseUrl: `${base}/openai/`, temperature: 0.2, maxTokens: 50, extraParams: { top_p: 0.5 } },
      apiKey: "sk-test",
      system: "Sois bref",
      messages: history,
    }),
  );
  assert.equal(r.text, "Bonjour");
  assert.deepEqual([r.usage.input, r.usage.output], [7, 2]);
  assert.equal(r.served, "gpt-test");
  assert.equal(received.openai.auth, "Bearer sk-test");
  assert.equal(received.openai.json.messages[0].role, "system");
  assert.equal(received.openai.json.messages.length, 4);
  assert.equal(received.openai.json.max_tokens, 50);
  assert.equal(received.openai.json.temperature, 0.2);
  assert.equal(received.openai.json.top_p, 0.5);
  assert.equal(received.openai.json.stream, true);
});

test("adaptateur compatible OpenAI : erreur HTTP lisible", async () => {
  await assert.rejects(
    collect(streamOpenAI({ config: { model: "x", baseUrl: `${base}/openai-err` }, apiKey: "bad", messages: history })),
    /HTTP 401 : Invalid API key/,
  );
});

test("adaptateur Anthropic (SDK officiel) : streaming et contenu brut conservé", async () => {
  const raw = [{ type: "thinking", thinking: "", signature: "sig" }, { type: "text", text: "R1" }];
  const r = await collect(
    streamAnthropic({
      config: { model: "claude-test", baseUrl: `${base}/anthropic`, thinking: "summarized", effort: "low" },
      apiKey: "sk-ant-test",
      system: "Sois bref",
      messages: [history[0], { ...history[1], raw }, history[2]],
    }),
  );
  assert.equal(r.text, "Salut Claude");
  assert.equal(r.usage.input, 11);
  assert.equal(r.usage.output, 4);
  assert.equal(r.served, "claude-test");
  assert.deepEqual(r.final.raw, [{ type: "text", text: "Salut Claude" }]);
  const sent = received.anthropic.json;
  assert.equal(received.anthropic.key, "sk-ant-test");
  assert.equal(sent.system, "Sois bref");
  assert.deepEqual(sent.messages[1].content, raw, "le contenu assistant est renvoyé tel quel");
  assert.deepEqual(sent.thinking, { type: "adaptive", display: "summarized" });
  assert.deepEqual(sent.output_config, { effort: "low" });
  assert.equal(sent.temperature, undefined);
  assert.equal(sent.fallbacks, undefined, "pas de repli sur une URL non officielle");
});

test("adaptateur Gemini : rôles, consigne système et usage", async () => {
  const r = await collect(
    streamGemini({
      config: { model: "gemini-test", baseUrl: `${base}/gemini`, maxTokens: 100 },
      apiKey: "g-key",
      system: "Sois bref",
      messages: history,
    }),
  );
  assert.equal(r.text, "Hello Gemini");
  assert.deepEqual([r.usage.input, r.usage.output], [5, 3]);
  assert.equal(received.gemini.key, "g-key");
  assert.equal(received.gemini.alt, "sse");
  assert.equal(received.gemini.path, "/gemini/models/gemini-test:streamGenerateContent");
  assert.deepEqual(received.gemini.json.contents.map((c) => c.role), ["user", "model", "user"]);
  assert.equal(received.gemini.json.systemInstruction.parts[0].text, "Sois bref");
  assert.equal(received.gemini.json.generationConfig.maxOutputTokens, 100);
});

test("fournisseur démo : répond sans réseau", async () => {
  const r = await collect(streamDemo({ config: { model: "alpha" }, messages: [{ role: "user", content: "un deux trois" }] }));
  assert.match(r.text, /3 mots/);
});
