/**
 * One portal: who can use it (ACTIVE / INACTIVE + role per user, singly or in
 * bulk), its role catalogue, and its settings/integration details.
 */
import { useEffect, useMemo, useState } from 'react';
import { api } from '../api/identityApi.js';
import { IntegrationFacts, SecretDialog } from '../components/PortalDialogs.jsx';
import { Icon } from '../components/ui/Icon.jsx';
import { Avatar, EmptyState, Field, Modal, Pager, SkeletonRows, SourceBadge, StatusBadge, Switch } from '../components/ui/ui.jsx';
import { useAsync } from '../hooks/useAsync.js';
import { useUsers } from '../hooks/useUsers.js';
import { plural, timeAgo } from '../lib/format.js';
import { href, navigate } from '../lib/router.js';

const TABS = [
  ['access', 'User access'],
  ['roles', 'Roles'],
  ['settings', 'Settings & integration'],
];

export function PortalDetailPage({ code, portals, reloadPortals, notify }) {
  const [tab, setTab] = useState('access');
  const portal = portals?.find((p) => p.portal_code === code);

  if (portals && !portal) {
    return (
      <div className="page">
        <div className="card">
          <EmptyState icon="portal" title="Portal not found" action={<a className="btn" href={href('/portals')}>Back to portals</a>}>
            {code} does not exist or was deleted.
          </EmptyState>
        </div>
      </div>
    );
  }
  if (!portal) return <div className="page" />;

  const inactive = portal.granted_count - portal.active_count;

  return (
    <div className="page">
      <a className="crumb" href={href('/portals')}>
        <Icon name="chevronLeft" size={14} /> Portals
      </a>
      <header className="page-head">
        <div className="page-head__title">
          <span className="portal-row__icon portal-row__icon--lg">{portal.portal_name.slice(0, 2).toUpperCase()}</span>
          <div>
            <h1>
              {portal.portal_name} <StatusBadge active={portal.is_enabled} labels={['Enabled', 'Disabled']} />
            </h1>
            <p className="muted">
              <code className="code-chip">{portal.portal_code}</code>
              {portal.role_source === 'PORTAL' && (
                <span className="tag tag--info" title="Roles are fetched from the portal itself">
                  Roles from portal
                </span>
              )}
              {portal.role_source === 'EMS' && (
                <span className="tag tag--ems" title="Roles mirror the EMS (HRMS) roles; changes here are written back">
                  Roles from EMS
                </span>
              )}
              {portal.auto_grant_role && (
                <span className="tag tag--info" title="Every EMS user gets access automatically">
                  Auto-assign: {portal.roles.find((r) => r.role_code === portal.auto_grant_role)?.role_name}
                </span>
              )}
              {portal.base_url && (
                <a className="ext-link" href={portal.base_url} target="_blank" rel="noreferrer">
                  {portal.base_url.replace(/^https?:\/\//, '')} <Icon name="external" size={12} />
                </a>
              )}
            </p>
          </div>
        </div>
        <div className="mini-stats">
          <div>
            <strong className="text-ok">{portal.active_count}</strong>
            <span>Active</span>
          </div>
          <div>
            <strong className="text-danger">{inactive}</strong>
            <span>Inactive</span>
          </div>
          <div>
            <strong>{portal.roles.length}</strong>
            <span>Roles</span>
          </div>
        </div>
      </header>

      {!portal.is_enabled && (
        <div className="callout callout--warn">
          <Icon name="alert" />
          <span>This portal is disabled. Nobody can get a token for it until it is enabled again in Settings.</span>
        </div>
      )}

      <div className="tabs" role="tablist">
        {TABS.map(([key, label]) => (
          <button key={key} role="tab" aria-selected={tab === key} className={`tab ${tab === key ? 'is-active' : ''}`} onClick={() => setTab(key)}>
            {label}
          </button>
        ))}
      </div>

      {tab === 'access' && <AccessTab portal={portal} reloadPortals={reloadPortals} notify={notify} />}
      {tab === 'roles' && <RolesTab portal={portal} reloadPortals={reloadPortals} notify={notify} />}
      {tab === 'settings' && <SettingsTab portal={portal} reloadPortals={reloadPortals} notify={notify} />}
    </div>
  );
}

// ===========================================================================
// User access
// ===========================================================================

const ACCESS_FILTERS = [
  ['any', 'All users'],
  ['active', 'Active'],
  ['inactive', 'Inactive'],
  ['none', 'Not assigned'],
];

function AccessTab({ portal, reloadPortals, notify }) {
  const departments = useAsync(() => api.listDepartments(), []);
  const [searchInput, setSearchInput] = useState('');
  const [filters, setFilters] = useState({ portalCode: portal.portal_code, access: 'any', source: 'EMS', departmentId: '', search: '', page: 1, pageSize: 25 });
  const set = (k, v) => setFilters((f) => ({ ...f, [k]: v, page: 1 }));

  useEffect(() => {
    const t = setTimeout(() => setFilters((f) => (f.search === searchInput.trim() ? f : { ...f, search: searchInput.trim(), page: 1 })), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  const { users, meta, loading, error, reload, updateAccess, isPending } = useUsers(filters, { notify });

  // --- selection (current page only) ---------------------------------------
  const [selected, setSelected] = useState(() => new Set());
  const pageIds = useMemo(() => users.map((u) => u.id), [users]);
  const visibleSelected = pageIds.filter((id) => selected.has(id));
  const allOnPage = pageIds.length > 0 && visibleSelected.length === pageIds.length;
  const toggle = (id) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const toggleAll = () => setSelected(allOnPage ? new Set() : new Set(pageIds));

  const change = async (user, patch) => {
    await updateAccess(user, portal, patch);
    reloadPortals();
  };
  const noRoles = portal.roles.length === 0;

  return (
    <section className="card card--flush">
      {noRoles && (
        <div className="callout callout--warn callout--flush">
          <Icon name="alert" />
          <span>
            This portal has no roles yet, so nobody can be given access.{' '}
            {portal.role_source === 'PORTAL' ? 'Open the Roles tab and fetch the roles from the portal.' : 'Add roles on the Roles tab.'}
          </span>
        </div>
      )}
      <div className="toolbar">
        <div className="chips" role="group" aria-label="Access filter">
          {ACCESS_FILTERS.map(([v, label]) => (
            <button key={v} type="button" className={`chip ${filters.access === v ? 'is-active' : ''}`} aria-pressed={filters.access === v} onClick={() => set('access', v)}>
              {label}
            </button>
          ))}
        </div>
        <div className="toolbar__right">
          <div className="search">
            <Icon name="search" size={16} />
            <input type="search" placeholder="Search name, email, staff ID" aria-label="Search users" value={searchInput} onChange={(e) => setSearchInput(e.target.value)} />
          </div>
          <select className="select" aria-label="Department" value={filters.departmentId} onChange={(e) => set('departmentId', e.target.value)}>
            <option value="">All departments</option>
            {departments.data?.map((d) => (
              <option key={d.id} value={d.id}>
                {d.dept_name}
              </option>
            ))}
          </select>
          <select className="select" aria-label="Source" value={filters.source} onChange={(e) => set('source', e.target.value)}>
            <option value="EMS">EMS users</option>
            <option value="DIRECT_SAAS">Direct SaaS users</option>
            <option value="">All sources</option>
          </select>
        </div>
      </div>

      {visibleSelected.length > 0 && (
        <BulkBar
          portal={portal}
          ids={visibleSelected}
          users={users}
          onDone={() => {
            setSelected(new Set());
            reload();
            reloadPortals();
          }}
          onClear={() => setSelected(new Set())}
          notify={notify}
        />
      )}

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th className="col-check">
                <input type="checkbox" aria-label="Select all on this page" checked={allOnPage} onChange={toggleAll} />
              </th>
              <th>User</th>
              <th>Department</th>
              <th>Deployment</th>
              <th>Access</th>
              <th title={portal.role_source === 'EMS' ? 'Changing a role here changes it in the HRMS too' : undefined}>
                {portal.role_source === 'EMS' ? 'EMS role' : `Role in ${portal.portal_name}`}
              </th>
            </tr>
          </thead>
          <tbody>
            {error && (
              <tr>
                <td colSpan={6}>
                  <div className="banner banner--error">
                    {error.message}{' '}
                    <button type="button" className="link" onClick={reload}>
                      Retry
                    </button>
                  </div>
                </td>
              </tr>
            )}
            {!error && loading && users.length === 0 && <SkeletonRows cols={6} />}
            {!error && !loading && users.length === 0 && (
              <tr>
                <td colSpan={6}>
                  <EmptyState icon="users" title="No users here">
                    {filters.access === 'none' ? 'Everyone matching these filters already has access.' : 'Try another filter or search.'}
                  </EmptyState>
                </td>
              </tr>
            )}
            {users.map((user) => {
              const access = user.portal_access.find((a) => a.portal_code === portal.portal_code);
              const pending = isPending(user.id, portal.portal_code);
              const accountOff = user.status !== 'ACTIVE';
              return (
                <tr key={user.id} className={`${selected.has(user.id) ? 'is-selected' : ''} ${accountOff ? 'is-dim' : ''}`}>
                  <td className="col-check">
                    <input type="checkbox" aria-label={`Select ${user.full_name}`} checked={selected.has(user.id)} onChange={() => toggle(user.id)} />
                  </td>
                  <td>
                    <div className="person">
                      <Avatar name={user.full_name} />
                      <div className="person__text">
                        <span className="person__name">
                          {user.full_name} <SourceBadge source={user.source} />
                        </span>
                        <span className="person__sub">
                          {user.email}
                          {user.staff_id && ` · ${user.staff_id}`}
                        </span>
                      </div>
                    </div>
                  </td>
                  <td>
                    <div>{user.dept_name ?? <span className="muted">—</span>}</div>
                    <div className="muted small">{user.designation_name}</div>
                  </td>
                  <td>
                    <div>{user.deployed_project ?? <span className="muted">—</span>}</div>
                    <div className="muted small">{user.deployed_location}</div>
                  </td>
                  <td>
                    {access ? (
                      <div className={`access-toggle ${pending ? 'is-pending' : ''}`}>
                        <Switch
                          checked={access.is_active}
                          disabled={pending}
                          label={`${portal.portal_name} access for ${user.full_name}`}
                          onChange={(on) => change(user, { is_active: on })}
                        />
                        <span className={access.is_active && !accountOff ? 'text-ok strong' : 'text-danger strong'}>
                          {access.is_active ? 'ACTIVE' : 'INACTIVE'}
                        </span>
                        {accountOff && access.is_active && (
                          <span className="tag tag--warn" title="Account is INACTIVE in EMS, which blocks every portal. This setting returns when EMS reactivates them.">
                            blocked by EMS
                          </span>
                        )}
                      </div>
                    ) : (
                      <span className="muted">Not assigned</span>
                    )}
                  </td>
                  <td>
                    <select
                      className={`select select--sm ${access ? '' : 'select--grant'}`}
                      aria-label={`Role for ${user.full_name}`}
                      value={access?.role_code ?? ''}
                      disabled={pending || noRoles}
                      onChange={(e) => e.target.value && change(user, access ? { role_code: e.target.value } : { role_code: e.target.value, is_active: true })}
                    >
                      {!access && <option value="">+ Assign role…</option>}
                      {portal.roles.map((r) => (
                        <option key={r.role_code} value={r.role_code}>
                          {r.role_name}
                        </option>
                      ))}
                    </select>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <Pager meta={meta} page={filters.page} loading={loading} onPage={(p) => setFilters((f) => ({ ...f, page: p }))} />
    </section>
  );
}

function BulkBar({ portal, ids, users, onDone, onClear, notify }) {
  const [role, setRole] = useState('');
  const [busy, setBusy] = useState(false);
  const hasAccess = (u) => u.portal_access.some((a) => a.portal_code === portal.portal_code);
  const assignedIds = users.filter((u) => ids.includes(u.id) && hasAccess(u)).map((u) => u.id);
  const needRole = ids.length - assignedIds.length;

  // Deactivate / role-only changes apply to assigned users only; unassigned
  // users have nothing to deactivate.
  async function run(body, verb, targetIds = ids) {
    setBusy(true);
    try {
      const res = await api.bulkAccess(portal.portal_code, { user_ids: targetIds, ...body });
      const s = res.summary;
      const parts = [s.changed && `${plural(s.changed, 'user')} ${verb}`, s.unchanged && `${s.unchanged} already set`, s.error && `${s.error} failed`].filter(Boolean);
      notify({ tone: s.error ? 'error' : 'success', text: `${portal.portal_name}: ${parts.join(', ')}.` });
      onDone();
    } catch (err) {
      notify({ tone: 'error', text: err.message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="bulkbar" role="region" aria-label="Bulk actions">
      <strong>{plural(ids.length, 'user')} selected</strong>
      <select className="select select--sm" aria-label="Role for bulk action" value={role} onChange={(e) => setRole(e.target.value)}>
        <option value="">{needRole ? 'Choose role…' : 'Keep current role'}</option>
        {portal.roles.map((r) => (
          <option key={r.role_code} value={r.role_code}>
            {r.role_name}
          </option>
        ))}
      </select>
      <button
        type="button"
        className="btn btn--success btn--sm"
        disabled={busy || (needRole > 0 && !role)}
        title={needRole && !role ? `${plural(needRole, 'selected user')} not assigned yet: choose a role first` : undefined}
        onClick={() => run({ is_active: true, ...(role ? { role_code: role } : {}) }, 'activated')}
      >
        <Icon name="check" size={14} /> Activate
      </button>
      <button type="button" className="btn btn--danger btn--sm" disabled={busy || assignedIds.length === 0} onClick={() => run({ is_active: false }, 'deactivated', assignedIds)}>
        <Icon name="userOff" size={14} /> Deactivate
      </button>
      {role && (
        <button type="button" className="btn btn--sm" disabled={busy} onClick={() => run({ role_code: role }, 'updated')}>
          Set role only
        </button>
      )}
      <button type="button" className="btn btn--ghost btn--sm bulkbar__clear" onClick={onClear}>
        Clear
      </button>
      {needRole > 0 && !role && <span className="muted small">{plural(needRole, 'user')} not assigned yet: choose a role to activate.</span>}
    </div>
  );
}

// ===========================================================================
// Roles
// ===========================================================================

function RolesTab({ portal, reloadPortals, notify }) {
  const [editing, setEditing] = useState(null); // role_code or 'new'
  const fromEms = portal.role_source === 'EMS';
  const fromPortal = portal.role_source === 'PORTAL';
  const readOnly = fromEms || fromPortal;
  const [fetching, setFetching] = useState(false);

  async function fetchNow() {
    setFetching(true);
    try {
      const { stats } = await api.refreshRoles(portal.portal_code);
      const parts = [
        `${plural(stats.roles, 'role')} fetched`,
        stats.added && `${stats.added} new`,
        stats.renamed && `${stats.renamed} updated`,
        stats.removed && `${stats.removed} removed`,
        stats.kept_in_use && `${stats.kept_in_use} kept because users still have them`,
      ].filter(Boolean);
      notify({ tone: 'success', text: `${portal.portal_name}: ${parts.join(', ')}.` });
    } catch (err) {
      notify({ tone: 'error', text: `${portal.portal_name}: ${err.message}` });
    } finally {
      setFetching(false);
      reloadPortals();
    }
  }

  async function remove(role) {
    try {
      await api.deleteRole(portal.portal_code, role.role_code);
      notify({ tone: 'success', text: `Role ${role.role_name} removed.` });
      reloadPortals();
    } catch (err) {
      notify({ tone: 'error', text: err.message });
    }
  }

  return (
    <section className="card">
      <header className="card__head">
        <div>
          <h2>Roles in {portal.portal_name}</h2>
          <p className="muted small">
            {fromEms
              ? 'These are the EMS (HRMS) roles, kept in sync automatically. Add or rename roles in the HRMS.'
              : fromPortal
                ? `Fetched from the portal${portal.roles_synced_at ? `, last ${timeAgo(portal.roles_synced_at)}` : ''}. Add or rename roles in the portal, then fetch again.`
                : 'Sent to the portal in every token as role + permissions. Independent of EMS roles.'}
          </p>
        </div>
        {fromPortal && (
          <button type="button" className="btn btn--primary btn--sm" onClick={fetchNow} disabled={fetching}>
            <Icon name="refresh" size={14} /> {fetching ? 'Fetching…' : 'Fetch roles now'}
          </button>
        )}
        {!readOnly && (
          <button type="button" className="btn btn--primary btn--sm" onClick={() => setEditing('new')}>
            <Icon name="plus" size={14} /> Add role
          </button>
        )}
      </header>
      {fromPortal && portal.roles_sync_error && (
        <div className="callout callout--warn callout--flush">
          <Icon name="alert" />
          <span>
            Last fetch failed: {portal.roles_sync_error}
            {portal.roles_url && (
              <>
                {' '}
                (<code className="mono">{portal.roles_url}</code>)
              </>
            )}
          </span>
        </div>
      )}
      {portal.roles.length === 0 && (
        <EmptyState icon="key" title="No roles yet">
          {fromPortal ? 'Fetch the roles from the portal to start assigning users.' : 'Add the first role to start assigning users.'}
        </EmptyState>
      )}
      <ul className="role-list">
        {portal.roles.map((r) => (
          <li key={r.role_code} className="role-item">
            <div className="role-item__main">
              <div className="role-item__title">
                <strong>{r.role_name}</strong> <code className="code-chip">{r.role_code}</code>
                {r.external_role_id && (
                  <span className="muted small" title="The portal's own id for this role (sent as role_id in tokens)">
                    id: <code className="mono">{r.external_role_id}</code>
                  </span>
                )}
                <span className="muted small">{plural(Number(r.user_count), 'user')}</span>
              </div>
              <div className="perm-list">
                {r.permissions.length ? (
                  r.permissions.map((p) => (
                    <span key={p} className="perm">
                      {p}
                    </span>
                  ))
                ) : (
                  <span className="muted small">{fromEms ? 'Permissions are managed in the HRMS' : fromPortal ? 'The portal sent no permissions' : 'No permissions listed'}</span>
                )}
              </div>
            </div>
            {!readOnly && (
            <div className="role-item__actions">
              <button type="button" className="icon-btn" aria-label={`Edit ${r.role_name}`} onClick={() => setEditing(r.role_code)}>
                <Icon name="edit" size={16} />
              </button>
              <button
                type="button"
                className="icon-btn"
                aria-label={`Delete ${r.role_name}`}
                disabled={Number(r.user_count) > 0 || portal.roles.length === 1}
                title={Number(r.user_count) > 0 ? 'Move its users to another role first' : portal.roles.length === 1 ? 'A portal needs at least one role' : 'Delete role'}
                onClick={() => remove(r)}
              >
                <Icon name="trash" size={16} />
              </button>
            </div>
            )}
          </li>
        ))}
      </ul>

      <Modal open={editing !== null} onClose={() => setEditing(null)} title={editing === 'new' ? 'Add role' : 'Edit role'} width={520}>
        {editing !== null && (
          <RoleForm
            portal={portal}
            role={portal.roles.find((r) => r.role_code === editing)}
            onCancel={() => setEditing(null)}
            onSaved={(msg) => {
              setEditing(null);
              reloadPortals();
              notify({ tone: 'success', text: msg });
            }}
          />
        )}
      </Modal>
    </section>
  );
}

function RoleForm({ portal, role, onCancel, onSaved }) {
  const [name, setName] = useState(role?.role_name ?? '');
  const [codeVal, setCode] = useState(role?.role_code ?? '');
  const [perms, setPerms] = useState(role?.permissions.join(', ') ?? '');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const autoCode = name.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  const effectiveCode = role ? role.role_code : codeVal || autoCode;

  async function submit(e) {
    e.preventDefault();
    const permissions = perms.split(',').map((p) => p.trim()).filter(Boolean);
    if (!name.trim()) return setError('Enter a role name.');
    setBusy(true);
    try {
      if (role) await api.updateRole(portal.portal_code, role.role_code, { role_name: name.trim(), permissions });
      else await api.addRole(portal.portal_code, { role_code: effectiveCode, role_name: name.trim(), permissions });
      onSaved(role ? `Role ${name} updated.` : `Role ${name} added.`);
    } catch (err) {
      setError(err.details?.[0]?.message ?? err.message);
      setBusy(false);
    }
  }

  return (
    <form className="form" onSubmit={submit} noValidate>
      <Field label="Role name">
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      </Field>
      <Field label="Role code" hint={role ? 'Codes cannot be changed.' : 'Sent in tokens as "role".'}>
        <input className="input mono" value={effectiveCode} disabled={Boolean(role)} onChange={(e) => setCode(e.target.value.toUpperCase())} />
      </Field>
      <Field label="Permissions" hint="Comma separated, e.g. leave.approve, reports.view">
        <textarea className="input textarea" rows={3} value={perms} onChange={(e) => setPerms(e.target.value)} />
      </Field>
      {error && <p className="form-error">{error}</p>}
      <div className="form__actions">
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
        <button className="btn btn--primary" disabled={busy}>
          {busy ? 'Saving…' : 'Save role'}
        </button>
      </div>
    </form>
  );
}

// ===========================================================================
// Settings & integration
// ===========================================================================

function SettingsTab({ portal, reloadPortals, notify }) {
  const [form, setForm] = useState({
    portal_name: portal.portal_name,
    base_url: portal.base_url ?? '',
    webhook_url: portal.webhook_url ?? '',
    roles_url: portal.roles_url ?? '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [confirm, setConfirm] = useState(null); // 'rotate' | 'delete' | 'ems' | 'saas'
  const [secret, setSecret] = useState(null);
  const dirty =
    form.portal_name !== portal.portal_name ||
    form.base_url !== (portal.base_url ?? '') ||
    form.webhook_url !== (portal.webhook_url ?? '') ||
    form.roles_url !== (portal.roles_url ?? '');

  async function save(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const saved = await api.updatePortal(portal.portal_code, {
        portal_name: form.portal_name.trim(),
        base_url: form.base_url.trim() || null,
        webhook_url: form.webhook_url.trim() || null,
        roles_url: form.roles_url.trim() || null,
      });
      notify({ tone: 'success', text: 'Portal settings saved.' });
      if (saved.roles_fetch) notifyFetch(saved.roles_fetch);
      reloadPortals();
    } catch (err) {
      setError(err.details?.map((d) => `${d.path}: ${d.message}`).join('; ') || err.message);
    } finally {
      setBusy(false);
    }
  }

  async function setEnabled(on) {
    try {
      await api.updatePortal(portal.portal_code, { is_enabled: on });
      notify({ tone: on ? 'success' : 'info', text: `${portal.portal_name} ${on ? 'enabled' : 'disabled'}.` });
      reloadPortals();
    } catch (err) {
      notify({ tone: 'error', text: err.message });
    }
  }

  async function setAutoGrant(roleCode) {
    try {
      const updated = await api.updatePortal(portal.portal_code, { auto_grant_role: roleCode || null });
      notify({
        tone: 'success',
        text: roleCode
          ? `Auto-assign on. ${plural(updated.auto_granted ?? 0, 'EMS user')} got access now; new hires will too.`
          : 'Auto-assign off. Existing access is unchanged.',
      });
      reloadPortals();
    } catch (err) {
      notify({ tone: 'error', text: err.message });
    }
  }

  function notifyFetch(f) {
    notify(
      f.ok
        ? { tone: 'success', text: `Fetched ${plural(f.roles, 'role')} from ${portal.portal_name}.` }
        : { tone: 'error', text: `Could not fetch roles from ${portal.portal_name}: ${f.error}` },
    );
  }

  async function confirmed() {
    const action = confirm;
    setConfirm(null);
    try {
      if (action === 'ems' || action === 'saas' || action === 'portal') {
        const saved = await api.updatePortal(portal.portal_code, { role_source: action.toUpperCase() });
        if (action === 'portal') notifyFetch(saved.roles_fetch ?? { ok: false, error: 'not fetched' });
        else
          notify({
            tone: 'success',
            text: action === 'ems' ? 'Roles now come from EMS. Every user has their EMS role on this portal.' : 'Roles are now managed here.',
          });
        reloadPortals();
      } else if (action === 'rotate') {
        setSecret(await api.rotateSecret(portal.portal_code));
      } else {
        await api.deletePortal(portal.portal_code);
        notify({ tone: 'success', text: `${portal.portal_name} deleted.` });
        reloadPortals();
        navigate('/portals');
      }
    } catch (err) {
      notify({ tone: 'error', text: err.message });
    }
  }

  return (
    <div className="grid-settings">
      <section className="card">
        <header className="card__head">
          <h2>General</h2>
        </header>
        <form className="form pad" onSubmit={save} noValidate>
          <Field label="Portal name">
            <input className="input" value={form.portal_name} onChange={(e) => setForm({ ...form, portal_name: e.target.value })} />
          </Field>
          <Field label="Portal URL">
            <input className="input" value={form.base_url} onChange={(e) => setForm({ ...form, base_url: e.target.value })} placeholder="https://" />
          </Field>
          <Field label="Webhook URL" hint="Leave empty if the portal only uses tokens. With a webhook, deactivation reaches it within seconds.">
            <input className="input" value={form.webhook_url} onChange={(e) => setForm({ ...form, webhook_url: e.target.value })} placeholder="https://" />
          </Field>
          <Field label="Roles URL" hint="Where the portal lists its roles. Needed when roles come from the portal; saving fetches them right away.">
            <input className="input" value={form.roles_url} onChange={(e) => setForm({ ...form, roles_url: e.target.value })} placeholder="https://portal.company.com/iam/roles" />
          </Field>
          {error && <p className="form-error">{error}</p>}
          <div className="form__actions">
            <button className="btn btn--primary" disabled={!dirty || busy}>
              {busy ? 'Saving…' : 'Save changes'}
            </button>
          </div>
        </form>

        <div className="setting-row">
          <div>
            <strong>Roles come from</strong>
            <p className="muted small">
              {portal.role_source === 'EMS'
                ? 'EMS (HRMS): same roles as the HRMS. Role changes here are written back to the HRMS.'
                : portal.role_source === 'PORTAL'
                  ? 'The portal: fetched from the Roles URL every 15 minutes, or on demand from the Roles tab.'
                  : 'Defined here: roles are typed in on the Roles tab.'}
            </p>
          </div>
          <select
            className="select select--sm"
            aria-label="Roles come from"
            value={portal.role_source}
            onChange={(e) => {
              const v = e.target.value;
              if (v === 'PORTAL' && !portal.roles_url) {
                notify({ tone: 'error', text: 'Enter and save the Roles URL first.' });
                return;
              }
              setConfirm(v.toLowerCase());
            }}
          >
            <option value="PORTAL">Fetched from the portal</option>
            <option value="SAAS">Defined here</option>
            <option value="EMS">EMS (HRMS) roles</option>
          </select>
        </div>

        <div className="setting-row">
          <div>
            <strong>Auto-assign EMS users</strong>
            <p className="muted small">
              {portal.role_source === 'EMS'
                ? 'Every EMS employee, including new hires, gets access with their own EMS role (the selected role is the fallback). Then you only deactivate the exceptions.'
                : 'Every EMS employee, including new hires, gets this role here automatically. Then you only deactivate the exceptions. Use it for portals everyone should reach.'}
            </p>
          </div>
          <select
            className="select select--sm"
            aria-label="Auto-assign role"
            value={portal.auto_grant_role ?? ''}
            onChange={(e) => setAutoGrant(e.target.value)}
          >
            <option value="">Off</option>
            {portal.roles.map((r) => (
              <option key={r.role_code} value={r.role_code}>
                {portal.role_source === 'EMS' ? `On (fallback: ${r.role_name})` : r.role_name}
              </option>
            ))}
          </select>
        </div>

        <div className="setting-row">
          <div>
            <strong>Portal enabled</strong>
            <p className="muted small">When disabled, no one can sign in to this portal. User assignments are kept.</p>
          </div>
          <Switch checked={portal.is_enabled} onChange={setEnabled} label="Portal enabled" />
        </div>
      </section>

      <div className="stack">
        <section className="card">
          <header className="card__head">
            <h2>Integration</h2>
          </header>
          <div className="pad">
            <IntegrationFacts code={portal.portal_code} />
            <div className="setting-row setting-row--flush">
              <div>
                <strong>Webhook secret</strong>
                <p className="muted small">Signs events sent to the portal and authenticates its introspection calls.</p>
              </div>
              <button type="button" className="btn btn--sm" onClick={() => setConfirm('rotate')}>
                <Icon name="key" size={14} /> Rotate
              </button>
            </div>
          </div>
        </section>

        <section className="card card--danger">
          <header className="card__head">
            <h2>Delete portal</h2>
          </header>
          <div className="setting-row">
            <p className="muted small">
              {portal.granted_count > 0
                ? `${plural(portal.granted_count, 'user')} are assigned to this portal. Disable it instead, or remove their access first.`
                : 'Removes the portal and its roles permanently.'}
            </p>
            <button type="button" className="btn btn--danger btn--sm" disabled={portal.granted_count > 0} onClick={() => setConfirm('delete')}>
              <Icon name="trash" size={14} /> Delete
            </button>
          </div>
        </section>
      </div>

      <Modal
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        title={
          confirm === 'rotate'
            ? 'Rotate webhook secret?'
            : confirm === 'ems'
              ? 'Use EMS (HRMS) roles?'
              : confirm === 'saas'
                ? 'Manage roles in this portal?'
                : confirm === 'portal'
                  ? 'Fetch roles from the portal?'
                  : `Delete ${portal.portal_name}?`
        }
        width={460}
        footer={
          <>
            <button type="button" className="btn" onClick={() => setConfirm(null)}>
              Cancel
            </button>
            <button type="button" className={`btn ${confirm === 'delete' ? 'btn--danger' : 'btn--primary'}`} onClick={confirmed}>
              {confirm === 'rotate'
                ? 'Rotate secret'
                : confirm === 'ems'
                  ? 'Use EMS roles'
                  : confirm === 'portal'
                    ? 'Fetch roles'
                    : confirm === 'saas'
                      ? 'Switch'
                      : 'Delete portal'}
            </button>
          </>
        }
      >
        <p className="muted">
          {confirm === 'rotate'
            ? 'The current secret stops working immediately. The portal must be updated with the new secret, or it will reject events.'
            : confirm === 'ems'
              ? "This portal's roles will be replaced by the EMS roles, and every user gets the role they have in EMS. Roles you change here afterwards are written back to the HRMS."
              : confirm === 'saas'
                ? 'The current roles stay, and you can edit them on the Roles tab. Role changes are no longer written back to the HRMS.'
                : confirm === 'portal'
                  ? "The portal's roles replace the current list. Roles with the same name are linked, so users keep them; roles still in use are kept until you move their users."
                  : 'This cannot be undone.'}
        </p>
      </Modal>
      <SecretDialog portal={portal} secret={secret} onClose={() => setSecret(null)} />
    </div>
  );
}
