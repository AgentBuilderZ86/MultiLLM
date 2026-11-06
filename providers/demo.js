// Fournisseur « démo » : aucun appel réseau, réponse simulée en streaming.
// Utile pour tester l'interface avant d'avoir ajouté de vraies clés API.
const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(Object.assign(new Error("Interrompu"), { name: "AbortError" }));
    });
  });

export async function* streamDemo({ config, system, messages, signal }) {
  const last = messages.at(-1)?.content || "";
  const persona = config.model || "écho";
  const words = last.split(/\s+/).filter(Boolean);
  const reply = [
    `**Réponse simulée** (modèle démo « ${persona} », tour ${Math.ceil(messages.length / 2)}).`,
    "",
    system ? `> Consigne système reçue : _${system.slice(0, 120)}_` : "> Aucune consigne système.",
    "",
    `Votre message contient **${words.length} mots** et ${last.length} caractères.`,
    "",
    "- Ce fournisseur ne contacte aucune API.",
    "- Ajoutez un vrai modèle dans **Modèles** pour comparer de vraies réponses.",
    "",
    "```text",
    last.slice(0, 200),
    "```",
  ].join("\n");

  yield { type: "served", model: `demo/${persona}` };
  const delay = 15 + Math.floor(Math.random() * 25);
  for (const token of reply.match(/\S+\s*|\s+/g) || []) {
    await sleep(delay, signal);
    yield { type: "text", text: token };
  }
  yield { type: "stop", reason: "end_turn" };
  yield { type: "usage", input: Math.ceil(last.length / 4), output: Math.ceil(reply.length / 4) };
  yield { type: "assistant", raw: null, text: reply };
}
