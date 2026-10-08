/**
 * Thin fetch wrapper for the Identity API.
 *
 * - Adds the admin bearer token.
 * - Normalises every failure (network, non-JSON, API error body) into ApiError,
 *   so components only ever handle one error type.
 * - Calls onUnauthorized() on 401 so the app can drop back to the login screen.
 */

const BASE_URL = import.meta.env.VITE_API_BASE_URL ?? '/api/v1';
const TOKEN_KEY = 'saas-manager.admin-token';

export class ApiError extends Error {
  /**
   * @param {string} message
   * @param {{ status?: number, code?: string, details?: unknown }} [info]
   */
  constructor(message, { status = 0, code = 'UNKNOWN', details } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

// --- token storage (sessionStorage: cleared when the tab closes) -------------
export const tokenStore = {
  get() {
    try {
      return sessionStorage.getItem(TOKEN_KEY);
    } catch {
      return null;
    }
  },
  set(token) {
    try {
      sessionStorage.setItem(TOKEN_KEY, token);
    } catch {
      /* storage unavailable (private mode); session lasts until reload */
    }
  },
  clear() {
    try {
      sessionStorage.removeItem(TOKEN_KEY);
    } catch {
      /* ignore */
    }
  },
};

let unauthorizedHandler = () => {};
export function onUnauthorized(handler) {
  unauthorizedHandler = handler;
}

/**
 * @param {string} path      e.g. "/users"
 * @param {{ method?: string, body?: unknown, query?: Record<string, unknown>, signal?: AbortSignal }} [opts]
 */
export async function request(path, { method = 'GET', body, query, signal } = {}) {
  const qs = query
    ? `?${new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== null && v !== ''))}`
    : '';
  const token = tokenStore.get();

  let res;
  try {
    res = await fetch(`${BASE_URL}${path}${qs}`, {
      method,
      signal,
      headers: {
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new ApiError('Cannot reach the Identity API. Check your connection.', { code: 'NETWORK' });
  }

  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      throw new ApiError(`Unexpected response from server (HTTP ${res.status})`, { status: res.status });
    }
  }

  if (!res.ok) {
    const e = data?.error ?? {};
    if (res.status === 401 && path !== '/auth/admin/login') unauthorizedHandler();
    throw new ApiError(e.message ?? `Request failed (HTTP ${res.status})`, {
      status: res.status,
      code: e.code,
      details: e.details,
    });
  }
  return data;
}
