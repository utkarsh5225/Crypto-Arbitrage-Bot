import { setAuthTokenGetter } from '@workspace/api-client-react';

// Only relevant when the server is started with API_AUTH_TOKEN set (opt-in).
// The token is captured once from a `?token=…` URL param, persisted, and then
// attached to every API call (as a bearer header) and the SSE stream (as a
// query param, since EventSource can't send headers).
const STORAGE_KEY = 'apiToken';

/**
 * Capture a `?token=` param (if present) into localStorage, strip it from the
 * visible URL, and register the bearer-token getter for API calls. Call once at
 * startup, before any queries run.
 */
export function initApiToken(): void {
  try {
    const params = new URLSearchParams(window.location.search);
    const fromUrl = params.get('token');
    if (fromUrl) {
      localStorage.setItem(STORAGE_KEY, fromUrl);
      params.delete('token');
      const qs = params.toString();
      const clean = window.location.pathname + (qs ? `?${qs}` : '') + window.location.hash;
      window.history.replaceState({}, '', clean);
    }
  } catch {
    /* ignore */
  }
  setAuthTokenGetter(() => getApiToken());
}

export function getApiToken(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}
