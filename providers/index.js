import { streamOpenAI } from "./openai.js";
import { streamAnthropic } from "./anthropic.js";
import { streamGemini } from "./gemini.js";
import { streamDemo } from "./demo.js";

export const adapters = {
  openai: streamOpenAI,
  anthropic: streamAnthropic,
  gemini: streamGemini,
  demo: streamDemo,
};
