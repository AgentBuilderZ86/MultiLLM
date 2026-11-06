// Adaptateur « compatible OpenAI » (Chat Completions) : OpenAI, Mistral, Groq,
// DeepSeek, xAI, OpenRouter, Perplexity, Together, Ollama, LM Studio, etc.
import { readSSE, httpError } from "../lib/sse.js";

export async function* streamOpenAI({ config, apiKey, system, messages, signal }) {
  const baseUrl = (config.baseUrl || "https://api.openai.com/v1").replace(/\/+$/, "");
  const isOpenAI = /api\.openai\.com/.test(baseUrl);

  const body = {
    model: config.model,
    messages: [
      ...(system ? [{ role: isOpenAI ? "developer" : "system", content: system }] : []),
      ...messages.map((m) => ({ role: m.role, content: m.content })),
    ],
    stream: true,
  };
  // stream_options n'est pas accepté partout : on l'active pour les hôtes connus.
  if (isOpenAI || /openrouter|groq|deepseek|x\.ai|together|mistral/.test(baseUrl)) {
    body.stream_options = { include_usage: true };
  }
  if (config.temperature != null) body.temperature = config.temperature;
  if (config.maxTokens != null) {
    // Les modèles OpenAI récents (série o, GPT-5…) attendent max_completion_tokens.
    body[isOpenAI ? "max_completion_tokens" : "max_tokens"] = config.maxTokens;
  }
  if (config.effort && isOpenAI) body.reasoning_effort = config.effort;
  Object.assign(body, config.extraParams || {});

  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  if (/openrouter\.ai/.test(baseUrl)) {
    headers["HTTP-Referer"] = "http://localhost";
    headers["X-Title"] = "MultiLLM";
  }

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw await httpError(res, "API compatible OpenAI");

  let text = "";
  let servedModel = null;
  for await (const { data } of readSSE(res)) {
    if (data === "[DONE]") break;
    let chunk;
    try {
      chunk = JSON.parse(data);
    } catch {
      continue;
    }
    if (chunk.error) throw new Error(chunk.error.message || JSON.stringify(chunk.error));
    if (chunk.model && chunk.model !== servedModel) {
      servedModel = chunk.model;
      yield { type: "served", model: servedModel };
    }
    const choice = chunk.choices?.[0];
    const delta = choice?.delta || {};
    const reasoning = delta.reasoning_content ?? delta.reasoning;
    if (typeof reasoning === "string" && reasoning) yield { type: "thinking", text: reasoning };
    if (typeof delta.content === "string" && delta.content) {
      text += delta.content;
      yield { type: "text", text: delta.content };
    }
    if (choice?.finish_reason) yield { type: "stop", reason: choice.finish_reason };
    if (chunk.usage) {
      yield {
        type: "usage",
        input: chunk.usage.prompt_tokens ?? null,
        output: chunk.usage.completion_tokens ?? null,
      };
    }
  }
  yield { type: "assistant", raw: null, text };
}
