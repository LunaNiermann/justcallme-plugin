/**
 * Where the API URL and key come from, in one place.
 *
 * Two sources, in priority order:
 *   1. JUSTCALLME_API_URL / JUSTCALLME_API_KEY environment variables — a CI box
 *      or shared machine can always force its own identity, same rule as the
 *      rest of the config.
 *   2. ~/.justcallme/config.json — where `/callme pair` saves what it received.
 *
 * The file fallback is what makes QR pairing land: after pairing, every hook,
 * the listener, and the CLI just work in every terminal, with zero env vars and
 * no "open a new terminal" dance.
 */

import { loadConfig, saveConfig } from './config.mjs';

const DEFAULT_API_URL = 'https://justcallme-api.onrender.com';

/** @returns {{ apiUrl: string|undefined, apiKey: string|undefined, source: string }} */
export function resolveCreds() {
  const envUrl = process.env.JUSTCALLME_API_URL?.replace(/\/$/, '');
  const envKey = process.env.JUSTCALLME_API_KEY;
  if (envUrl && envKey) return { apiUrl: envUrl, apiKey: envKey, source: 'env' };

  const config = loadConfig();
  const fileUrl = typeof config.apiUrl === 'string' ? config.apiUrl.replace(/\/$/, '') : undefined;
  const fileKey = typeof config.apiKey === 'string' ? config.apiKey : undefined;

  return {
    // Mix-and-match on purpose: env may set just the URL (say, a staging API)
    // while the key came from pairing, or vice versa.
    apiUrl: envUrl ?? fileUrl ?? (envKey || fileKey ? DEFAULT_API_URL : undefined),
    apiKey: envKey ?? fileKey,
    source: envKey || envUrl ? 'env+file' : fileKey ? 'file' : 'none',
  };
}

/** Persist pairing results into ~/.justcallme/config.json. */
export function saveCreds({ apiUrl, apiKey }) {
  const config = loadConfig();
  if (apiUrl) config.apiUrl = apiUrl.replace(/\/$/, '');
  if (apiKey) config.apiKey = apiKey;
  return saveConfig(config);
}
