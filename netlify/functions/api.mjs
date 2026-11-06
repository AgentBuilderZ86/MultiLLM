// Fonction Netlify : toute l'API (/api/*) est servie par le gestionnaire commun.
import { handleApi } from "../../lib/api.js";

export default async (request) => handleApi(request);

export const config = {
  path: "/api/*",
};
