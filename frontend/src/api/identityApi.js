/**
 * Identity API surface used by the dashboard. Every function returns plain
 * data or throws ApiError. For local work without PostgreSQL, run the backend
 * with `npm run dev:memory`.
 */
import { request, tokenStore } from './client.js';

const enc = encodeURIComponent;

export const api = {
  // --- session ---------------------------------------------------------------
  async login(email, password) {
    const res = await request('/auth/admin/login', { method: 'POST', body: { email, password } });
    tokenStore.set(res.access_token);
    return res.admin;
  },
  async me() {
    return (await request('/auth/me')).admin;
  },
  logout() {
    tokenStore.clear();
  },
  hasSession() {
    return Boolean(tokenStore.get());
  },

  // --- overview --------------------------------------------------------------
  async overview() {
    return (await request('/overview')).data;
  },
  async activity(limit = 12) {
    return (await request('/activity', { query: { limit } })).data;
  },

  // --- users -----------------------------------------------------------------
  /** @returns {Promise<{ data: object[], meta: { page:number, page_size:number, total:number, total_pages:number } }>} */
  listUsers(params, signal) {
    return request('/users', { query: params, signal });
  },
  async getUser(id) {
    return (await request(`/users/${enc(id)}`)).data;
  },
  async createUser(body) {
    return (await request('/users', { method: 'POST', body })).data;
  },
  /** @returns {Promise<{ changed: boolean, event: string|null, user: object }>} */
  setPortalAccess(body) {
    return request('/users/portal-access', { method: 'POST', body });
  },

  // --- reference data ----------------------------------------------------------
  async listDepartments() {
    return (await request('/departments')).data;
  },
  async listDesignations() {
    return (await request('/designations')).data;
  },
  /** EMS (HRMS) role catalogue with user counts. */
  async emsRoles() {
    return (await request('/ems-roles')).data;
  },

  // --- portals -------------------------------------------------------------------
  async listPortals() {
    return (await request('/portals')).data;
  },
  async getPortal(code) {
    return (await request(`/portals/${enc(code)}`)).data;
  },
  /** @returns {Promise<{ data: object, webhook_secret: string }>} */
  createPortal(body) {
    return request('/portals', { method: 'POST', body });
  },
  async updatePortal(code, body) {
    const res = await request(`/portals/${enc(code)}`, { method: 'PATCH', body });
    return { ...res.data, roles_fetch: res.roles_fetch };
  },
  deletePortal(code) {
    return request(`/portals/${enc(code)}`, { method: 'DELETE' });
  },
  /** Fetch the portal's roles from its roles URL now. @returns {Promise<{ data: object, stats: object }>} */
  refreshRoles(code) {
    return request(`/portals/${enc(code)}/refresh-roles`, { method: 'POST' });
  },
  async rotateSecret(code) {
    return (await request(`/portals/${enc(code)}/rotate-secret`, { method: 'POST' })).webhook_secret;
  },
  async addRole(code, body) {
    return (await request(`/portals/${enc(code)}/roles`, { method: 'POST', body })).data;
  },
  async updateRole(code, role, body) {
    return (await request(`/portals/${enc(code)}/roles/${enc(role)}`, { method: 'PATCH', body })).data;
  },
  async deleteRole(code, role) {
    return (await request(`/portals/${enc(code)}/roles/${enc(role)}`, { method: 'DELETE' })).data;
  },
  /** @returns {Promise<{ summary: Record<string, number>, results: object[] }>} */
  bulkAccess(code, body) {
    return request(`/portals/${enc(code)}/access/bulk`, { method: 'POST', body });
  },
};

/** Absolute API URL that portal developers should call (shown on the Integration tab). */
export const publicApiUrl = (() => {
  const configured = import.meta.env.VITE_PUBLIC_API_URL;
  if (configured) return configured.replace(/\/$/, '');
  return new URL(import.meta.env.VITE_API_BASE_URL ?? '/api/v1', window.location.origin).href.replace(/\/api\/v1\/?$/, '');
})();
