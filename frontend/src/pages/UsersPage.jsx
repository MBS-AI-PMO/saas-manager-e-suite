/**
 * Users: directory of every identity (EMS + Direct SaaS). Click a person to
 * open their profile and manage their access to every portal in one place.
 */
import { useEffect, useState } from 'react';
import { api } from '../api/identityApi.js';
import { CreateUserDialog } from '../components/CreateUserDialog.jsx';
import { PortalAccessControl } from '../components/PortalAccessControl.jsx';
import { Icon } from '../components/ui/Icon.jsx';
import { Avatar, EmptyState, Modal, Pager, SkeletonRows, SourceBadge, StatusBadge } from '../components/ui/ui.jsx';
import { useAsync } from '../hooks/useAsync.js';
import { useUsers } from '../hooks/useUsers.js';

export function UsersPage({ portals, reloadPortals, notify }) {
  const departments = useAsync(() => api.listDepartments(), []);
  const designations = useAsync(() => api.listDesignations(), []);
  const [searchInput, setSearchInput] = useState('');
  const [filters, setFilters] = useState({ search: '', source: '', status: '', departmentId: '', page: 1, pageSize: 25 });
  const set = (k, v) => setFilters((f) => ({ ...f, [k]: v, page: 1 }));

  useEffect(() => {
    const t = setTimeout(() => setFilters((f) => (f.search === searchInput.trim() ? f : { ...f, search: searchInput.trim(), page: 1 })), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  const { users, meta, loading, error, reload, updateAccess, isPending } = useUsers(filters, { notify });
  const [openId, setOpenId] = useState(null);
  const [creating, setCreating] = useState(false);
  const openUser = users.find((u) => u.id === openId);

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Users</h1>
          <p className="muted">Everyone the Identity Center knows about. EMS users are kept in sync automatically.</p>
        </div>
        <button type="button" className="btn btn--primary" onClick={() => setCreating(true)}>
          <Icon name="userPlus" size={16} /> Add Direct SaaS user
        </button>
      </header>

      <section className="card card--flush">
        <div className="toolbar">
          <div className="chips" role="group" aria-label="Source">
            {[
              ['', 'All'],
              ['EMS', 'EMS'],
              ['DIRECT_SAAS', 'Direct SaaS'],
            ].map(([v, label]) => (
              <button key={label} type="button" className={`chip ${filters.source === v ? 'is-active' : ''}`} aria-pressed={filters.source === v} onClick={() => set('source', v)}>
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
            <select className="select" aria-label="Account status" value={filters.status} onChange={(e) => set('status', e.target.value)}>
              <option value="">Any status</option>
              <option value="ACTIVE">Active accounts</option>
              <option value="INACTIVE">Inactive accounts</option>
            </select>
          </div>
        </div>

        <div className="table-wrap">
          <table className="table table--clickable">
            <thead>
              <tr>
                <th>User</th>
                <th>Department / Designation</th>
                <th>Deployment</th>
                <th>Portal access</th>
                <th>Account</th>
                <th aria-label="Open" />
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
                    <EmptyState title="No users match">Try a different search or filter.</EmptyState>
                  </td>
                </tr>
              )}
              {users.map((u) => (
                <tr key={u.id} onClick={() => setOpenId(u.id)} className={u.status !== 'ACTIVE' ? 'is-dim' : ''}>
                  <td>
                    <div className="person">
                      <Avatar name={u.full_name} />
                      <div className="person__text">
                        <button type="button" className="person__name link-plain" onClick={() => setOpenId(u.id)}>
                          {u.full_name} <SourceBadge source={u.source} />
                        </button>
                        <span className="person__sub">
                          {u.email}
                          {u.staff_id && ` · ${u.staff_id}`}
                        </span>
                      </div>
                    </div>
                  </td>
                  <td>
                    <div>{u.dept_name ?? <span className="muted">—</span>}</div>
                    <div className="muted small">{u.designation_name}</div>
                  </td>
                  <td>
                    <div>{u.deployed_project ?? <span className="muted">—</span>}</div>
                    <div className="muted small">{u.deployed_location}</div>
                  </td>
                  <td>
                    <div className="access-chips">
                      {u.portal_access.length === 0 && <span className="muted small">None</span>}
                      {u.portal_access.map((a) => (
                        <span
                          key={a.portal_code}
                          className={`access-chip ${a.is_active && u.status === 'ACTIVE' ? 'is-on' : 'is-off'}`}
                          title={`${a.portal_name}: ${a.is_active ? 'ACTIVE' : 'INACTIVE'} · ${a.role_code}`}
                        >
                          {a.portal_name}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td>
                    <StatusBadge active={u.status === 'ACTIVE'} />
                  </td>
                  <td className="col-chevron">
                    <Icon name="chevronRight" className="muted" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <Pager meta={meta} page={filters.page} loading={loading} onPage={(p) => setFilters((f) => ({ ...f, page: p }))} />
      </section>

      <Modal variant="drawer" open={Boolean(openUser)} onClose={() => setOpenId(null)} title={openUser?.full_name ?? ''} subtitle={openUser?.email}>
        {openUser && (
          <UserProfile
            user={openUser}
            portals={portals ?? []}
            isPending={isPending}
            onChange={async (portal, patch) => {
              await updateAccess(openUser, portal, patch);
              reloadPortals();
            }}
          />
        )}
      </Modal>

      <CreateUserDialog
        open={creating}
        portals={portals ?? []}
        departments={departments.data ?? []}
        designations={designations.data ?? []}
        onClose={() => setCreating(false)}
        onCreated={(user) => {
          setCreating(false);
          notify({ tone: 'success', text: `${user.full_name} created as a Direct SaaS user.` });
          reload();
          reloadPortals();
        }}
      />
    </div>
  );
}

function UserProfile({ user, portals, isPending, onChange }) {
  const ems = user.source === 'EMS';
  return (
    <div className="profile">
      <div className="profile__hero">
        <Avatar name={user.full_name} size={56} />
        <div>
          <div className="profile__badges">
            <SourceBadge source={user.source} />
            <StatusBadge active={user.status === 'ACTIVE'} labels={['Account active', 'Account inactive']} />
          </div>
          {ems && <p className="muted small">Profile is managed in EMS (employee #{user.ems_user_id}) and updates automatically.</p>}
        </div>
      </div>

      <dl className="kv kv--grid">
        <div>
          <dt>Staff ID</dt>
          <dd>{user.staff_id ?? '—'}</dd>
        </div>
        <div>
          <dt>Department</dt>
          <dd>{user.dept_name ?? '—'}</dd>
        </div>
        <div>
          <dt>Designation</dt>
          <dd>{user.designation_name ?? '—'}</dd>
        </div>
        <div>
          <dt>Deployed project</dt>
          <dd>{user.deployed_project ?? '—'}</dd>
        </div>
        <div>
          <dt>Location</dt>
          <dd>{user.deployed_location ?? '—'}</dd>
        </div>
        <div>
          <dt title="Informational only; never grants portal access">EMS role</dt>
          <dd>{user.ems_role_name ?? '—'}</dd>
        </div>
      </dl>

      <h3 className="section-title">Portal access</h3>
      {user.status !== 'ACTIVE' && (
        <div className="callout callout--warn">
          <Icon name="alert" />
          <span>This account is inactive in EMS, so every portal is blocked. The settings below come back when EMS reactivates the account.</span>
        </div>
      )}
      {portals.length === 0 ? (
        <p className="muted">No portals yet. Add one under Portals.</p>
      ) : (
        <div className="pac-list">
          {portals.map((p) => (
            <PortalAccessControl
              key={p.portal_code}
              user={user}
              portal={p}
              access={user.portal_access.find((a) => a.portal_code === p.portal_code)}
              pending={isPending(user.id, p.portal_code)}
              onChange={(patch) => onChange(p, patch)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
