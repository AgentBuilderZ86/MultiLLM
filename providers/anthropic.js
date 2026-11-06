// Adaptateur Anthropic (Claude) via le SDK officiel @anthropic-ai/sdk.
import Anthropic from "@anthropic-ai/sdk";

// Modèles qui acceptent le repli serveur `fallbacks: "default"` en cas de refus.
const FALLBACK_MODELS = new Set(["claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"]);

export async function* streamAnthropic({ config, apiKey, system, messages, signal }) {
  const isFirstParty = !config.baseUrl || /api\.anthropic\.com/.test(config.baseUrl);
  const client = new Anthropic({
    apiKey,
    ...(config.baseUrl ? { baseURL: config.baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "") } : {}),
  });

  const params = {
    model: config.model,
    max_tokens: config.maxTokens ?? 16000,
    // Pour Claude, on renvoie le contenu de l'assistant tel quel (blocs de réflexion compris)
    // afin de conserver un historique intact d'un tour à l'autre.
    messages: messages.map((m) =>
      m.role === "assistant" && Array.isArray(m.raw) && m.raw.length
        ? { role: "assistant", content: m.raw }
        : { role: m.role, content: m.content },
    ),
  };
  if (system) params.system = system;
  // Réflexion : "auto" = comportement par défaut du modèle (rien n'est envoyé).
  if (config.thinking === "summarized") params.thinking = { type: "adaptive", display: "summarized" };
  else if (config.thinking === "adaptive") params.thinking = { type: "adaptive" };
  if (config.effort) params.output_config = { effort: config.effort };
  // Remarque : temperature/top_p/top_k sont refusés par les modèles Claude récents ; on ne les envoie pas.

  const betas = [];
  if (config.fallbacks !== false && isFirstParty && FALLBACK_MODELS.has(config.model)) {
    betas.push("server-side-fallback-2026-07-01");
    params.fallbacks = "default";
  }
  Object.assign(params, config.extraParams || {});
  if (betas.length) params.betas = betas;

  const stream = client.beta.messages.stream(params, { signal });

  for await (const event of stream) {
    switch (event.type) {
      case "message_start":
        yield { type: "served", model: event.message.model };
        break;
      case "content_block_start":
        if (event.content_block.type === "fallback") {
          const { from, to } = event.content_block;
          yield { type: "info", message: `${from?.model} a décliné la demande ; ${to?.model} a pris le relais.` };
          if (to?.model) yield { type: "served", model: to.model };
        }
        break;
      case "content_block_delta":
        if (event.delta.type === "text_delta") yield { type: "text", text: event.delta.text };
        else if (event.delta.type === "thinking_delta") yield { type: "thinking", text: event.delta.thinking };
        break;
    }
  }

  const final = await stream.finalMessage();
  if (final.model) yield { type: "served", model: final.model };
  if (final.stop_reason === "refusal") {
    const cat = final.stop_details?.category;
    yield { type: "info", message: `Le modèle a refusé de répondre${cat ? ` (catégorie : ${cat})` : ""}.` };
  }
  yield { type: "stop", reason: final.stop_reason };
  yield {
    type: "usage",
    input:
      (final.usage?.input_tokens ?? 0) +
      (final.usage?.cache_read_input_tokens ?? 0) +
      (final.usage?.cache_creation_input_tokens ?? 0),
    output: final.usage?.output_tokens ?? null,
  };
  const text = final.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
  yield { type: "assistant", raw: final.stop_reason === "refusal" ? null : final.content, text };
}
