// Adaptateur Google Gemini (API REST generativelanguage, streaming SSE).
import { readSSE, httpError } from "../lib/sse.js";

export async function* streamGemini({ config, apiKey, system, messages, signal }) {
  const baseUrl = (config.baseUrl || "https://generativelanguage.googleapis.com/v1beta").replace(/\/+$/, "");
  const model = config.model.replace(/^models\//, "");

  const generationConfig = {};
  if (config.temperature != null) generationConfig.temperature = config.temperature;
  if (config.maxTokens != null) generationConfig.maxOutputTokens = config.maxTokens;
  if (config.thinking === "summarized") generationConfig.thinkingConfig = { includeThoughts: true };

  const body = {
    contents: messages.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    })),
    ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
    ...(Object.keys(generationConfig).length ? { generationConfig } : {}),
  };
  Object.assign(body, config.extraParams || {});

  const res = await fetch(`${baseUrl}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw await httpError(res, "Gemini");

  let text = "";
  let usage = null;
  let served = false;
  for await (const { data } of readSSE(res)) {
    let chunk;
    try {
      chunk = JSON.parse(data);
    } catch {
      continue;
    }
    if (chunk.error) throw new Error(chunk.error.message || JSON.stringify(chunk.error));
    if (!served && chunk.modelVersion) {
      served = true;
      yield { type: "served", model: chunk.modelVersion };
    }
    const cand = chunk.candidates?.[0];
    for (const part of cand?.content?.parts || []) {
      if (typeof part.text !== "string" || !part.text) continue;
      if (part.thought) {
        yield { type: "thinking", text: part.text };
      } else {
        text += part.text;
        yield { type: "text", text: part.text };
      }
    }
    if (cand?.finishReason) yield { type: "stop", reason: cand.finishReason };
    if (chunk.promptFeedback?.blockReason) {
      yield { type: "info", message: `Requête bloquée par Gemini : ${chunk.promptFeedback.blockReason}` };
    }
    if (chunk.usageMetadata) usage = chunk.usageMetadata;
  }
  if (usage) {
    yield {
      type: "usage",
      input: usage.promptTokenCount ?? null,
      output: (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0) || null,
    };
  }
  yield { type: "assistant", raw: null, text };
}
