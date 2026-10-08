/**
 * User list state: filtered/paginated fetching and optimistic portal-access
 * updates with rollback.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/identityApi.js';

const accessKey = (userId, portalCode) => `${userId}:${portalCode}`;

/**
 * @param {{ search?: string, source?: string, status?: string, departmentId?: string,
 *           portalCode?: string, access?: 'any'|'granted'|'active'|'inactive'|'none',
 *           page: number, pageSize: number }} filters
 * @param {{ notify: (toast: { tone: 'success'|'error'|'info', text: string }) => void }} deps
 */
export function useUsers(filters, { notify }) {
  const [users, setUsers] = useState([]);
  const [meta, setMeta] = useState({ page: 1, page_size: filters.pageSize, total: 0, total_pages: 1 });
  // Which request the current users/error belong to. `loading` is derived:
  // true whenever the latest request has not settled yet.
  const [settled, setSettled] = useState({ key: null, error: null });
  // Portal cells with a request in flight, keyed "userId:PORTAL".
  const [pending, setPending] = useState(() => new Set());
  const [reloadToken, setReloadToken] = useState(0);
  const usersRef = useRef(users);
  useEffect(() => {
    usersRef.current = users;
  }, [users]);

  const params = {
    search: filters.search || undefined,
    source: filters.source || undefined,
    status: filters.status || undefined,
    department_id: filters.departmentId || undefined,
    portal_code: filters.portalCode || undefined,
    access: filters.portalCode && filters.access ? filters.access : undefined,
    page: filters.page,
    page_size: filters.pageSize,
  };
  const requestKey = `${JSON.stringify(params)}#${reloadToken}`;
  const loading = settled.key !== requestKey;
  const error = loading ? null : settled.error;

  // --- fetch (aborts the previous request when filters change) --------------
  useEffect(() => {
    const controller = new AbortController();

    api
      .listUsers(JSON.parse(requestKey.slice(0, requestKey.lastIndexOf('#'))), controller.signal)
      .then((res) => {
        setUsers(res.data);
        setMeta(res.meta);
        setSettled({ key: requestKey, error: null });
      })
      .catch((err) => {
        if (err.name !== 'AbortError') setSettled({ key: requestKey, error: err });
      });

    return () => controller.abort();
  }, [requestKey]);

  const reload = useCallback(() => setReloadToken((n) => n + 1), []);

  const replaceUser = useCallback((user) => {
    setUsers((list) => list.map((u) => (u.id === user.id ? user : u)));
  }, []);

  const setCellPending = (key, on) =>
    setPending((prev) => {
      const next = new Set(prev);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });

  /**
   * Change one portal cell. The UI updates immediately; on failure the
   * previous user object is restored and an error toast is shown.
   *
   * @param {object} user
   * @param {{ portal_code: string, portal_name: string, portal_id: string }} portal
   * @param {{ is_active?: boolean, role_code?: string }} patch
   */
  const updateAccess = useCallback(
    async (user, portal, patch) => {
      const key = accessKey(user.id, portal.portal_code);
      const before = usersRef.current.find((u) => u.id === user.id);
      if (!before) return;
      const current = before.portal_access.find((a) => a.portal_code === portal.portal_code);

      // Optimistic local state
      const optimistic = structuredClone(before);
      if (current) {
        Object.assign(optimistic.portal_access.find((a) => a.portal_code === portal.portal_code), patch);
      } else {
        optimistic.portal_access.push({
          portal_id: portal.id,
          portal_code: portal.portal_code,
          portal_name: portal.portal_name,
          role_code: patch.role_code,
          is_active: patch.is_active ?? true,
          access_version: 0,
        });
      }
      replaceUser(optimistic);
      setCellPending(key, true);

      try {
        const res = await api.setPortalAccess({
          user_id: user.id,
          portal_code: portal.portal_code,
          ...patch,
          // Guards against overwriting another admin's change.
          ...(current ? { expected_version: current.access_version } : {}),
        });
        replaceUser(res.user);
        if (res.changed) notify({ tone: 'success', text: describeEvent(res.event, user, portal, patch) });
      } catch (err) {
        replaceUser(before);
        notify({ tone: 'error', text: `${portal.portal_name}: ${err.message}` });
        // Someone else changed it: pull fresh data so the admin sees the truth.
        if (err.status === 409) reload();
      } finally {
        setCellPending(key, false);
      }
    },
    [notify, reload, replaceUser],
  );

  const isPending = useCallback((userId, portalCode) => pending.has(accessKey(userId, portalCode)), [pending]);

  return { users, meta, loading, error, reload, updateAccess, isPending, replaceUser };
}

function describeEvent(event, user, portal, patch) {
  switch (event) {
    case 'access.revoked':
      // Be precise about how revocation reaches this portal.
      return portal.has_webhook
        ? `${user.full_name} deactivated on ${portal.portal_name}. The portal is being told to end their sessions.`
        : `${user.full_name} deactivated on ${portal.portal_name}. Existing sessions end when their token expires.`;
    case 'access.granted':
      return `${user.full_name} activated on ${portal.portal_name}.`;
    case 'access.role_changed':
      return `${user.full_name} is now ${roleName(portal, patch.role_code)} on ${portal.portal_name}.${
        portal.role_source === 'EMS' ? ' The role is updated in EMS too.' : ''
      }`;
    default:
      return `${user.full_name}: ${portal.portal_name} updated.`;
  }
}

const roleName = (portal, code) => portal.roles?.find((r) => r.role_code === code)?.role_name ?? code;
