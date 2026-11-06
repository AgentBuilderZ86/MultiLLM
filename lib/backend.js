// Stockage clé → JSON.
//  - En local : fichiers dans data/ (ou MULTILLM_DATA_DIR).
//  - Sur Netlify : Netlify Blobs (le disque des fonctions n'est pas persistant).
import { readFile, writeFile, mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";

export const isNetlify = () =>
  Boolean(globalThis.Netlify || process.env.NETLIFY || process.env.NETLIFY_BLOBS_CONTEXT);

function fileBackend() {
  const dir = process.env.MULTILLM_DATA_DIR || path.join(process.cwd(), "data");
  const fileFor = (key) => path.join(dir, `${key.replace(/[^\w.-]/g, "_")}.json`);
  return {
    async get(key) {
      try {
        return JSON.parse(await readFile(fileFor(key), "utf8"));
      } catch (err) {
        if (err.code === "ENOENT") return null;
        throw err;
      }
    },
    async set(key, value) {
      await mkdir(dir, { recursive: true });
      const file = fileFor(key);
      const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
      await rename(tmp, file);
    },
    async delete(key) {
      await rm(fileFor(key), { force: true });
    },
  };
}

async function blobsBackend() {
  const { getStore } = await import("@netlify/blobs");
  const store = getStore({ name: "multillm", consistency: "strong" });
  return {
    get: (key) => store.get(key, { type: "json" }),
    set: (key, value) => store.setJSON(key, value),
    delete: (key) => store.delete(key),
  };
}

let backendPromise;
export function backend() {
  backendPromise ||= isNetlify() ? blobsBackend() : Promise.resolve(fileBackend());
  return backendPromise;
}
