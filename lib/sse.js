// Lecture d'un flux Server-Sent Events renvoyé par fetch().
// Produit des objets { event, data } où data est la chaîne brute.
export async function* readSSE(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let event = "message";
  let dataLines = [];

  const flush = function* () {
    if (dataLines.length) {
      yield { event, data: dataLines.join("\n") };
    }
    event = "message";
    dataLines = [];
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      let line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line === "") {
        yield* flush();
      } else if (line.startsWith(":")) {
        // commentaire / keep-alive
      } else if (line.startsWith("event:")) {
        event = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).replace(/^ /, ""));
      }
    }
  }
  buffer += decoder.decode();
  if (buffer.trim().startsWith("data:")) dataLines.push(buffer.trim().slice(5).trim());
  yield* flush();
}

// Extrait un message d'erreur lisible d'une réponse HTTP en échec.
export async function httpError(response, provider) {
  let detail = "";
  try {
    const text = await response.text();
    try {
      const json = JSON.parse(text);
      const err = Array.isArray(json) ? json[0]?.error : json.error;
      detail = err?.message || json.message || json.detail || text;
      if (typeof detail !== "string") detail = JSON.stringify(detail);
    } catch {
      detail = text;
    }
  } catch {
    /* corps illisible */
  }
  const err = new Error(`${provider} – HTTP ${response.status}${detail ? ` : ${detail.slice(0, 600)}` : ""}`);
  err.status = response.status;
  return err;
}
