/**
 * Overview: identity totals, per-portal adoption, sync/delivery health, and
 * the latest admin actions.
 */
import { api } from '../api/identityApi.js';
import { Icon } from '../components/ui/Icon.jsx';
import { EmptyState, Progress, StatCard } from '../components/ui/ui.jsx';
import { useAsync } from '../hooks/useAsync.js';
import { describeActivity, timeAgo } from '../lib/format.js';
import { href } from '../lib/router.js';

export function OverviewPage({ portals }) {
  const overview = useAsync(() => api.overview(), []);
  const activity = useAsync(() => api.activity(10), []);
  const o = overview.data;

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Overview</h1>
          <p className="muted">Identities synced from EMS and created here, and their access across your portals.</p>
        </div>
      </header>

      {overview.error && <div className="banner banner--error">{overview.error.message}</div>}

      <section className="stats">
        <StatCard icon="users" label="Total identities" value={o?.users.total} />
        <StatCard icon="sync" label="Synced from EMS" value={o?.users.ems} tone="ems" hint={o && `Last sync ${timeAgo(o.last_ems_sync_at)}`} />
        <StatCard icon="userPlus" label="Direct SaaS users" value={o?.users.direct} tone="direct" />
        <StatCard icon="userOff" label="Inactive accounts" value={o?.users.inactive} tone="danger" hint="Deactivated in EMS" />
      </section>

      <div className="grid-main">
        <section className="card">
          <header className="card__head">
            <h2>Portals</h2>
            <a className="btn btn--ghost btn--sm" href={href('/portals/new')}>
              <Icon name="plus" size={14} /> Add portal
            </a>
          </header>
          {portals?.length === 0 ? (
            <EmptyState icon="portal" title="No portals yet" action={<a className="btn btn--primary" href={href('/portals/new')}>Add your first portal</a>}>
              Register a target application to start granting access.
            </EmptyState>
          ) : (
            <ul className="portal-list">
              {portals?.map((p) => (
                <li key={p.portal_code}>
                  <a className="portal-row" href={href(`/portals/${encodeURIComponent(p.portal_code)}`)}>
                    <span className="portal-row__icon">{p.portal_name.slice(0, 2).toUpperCase()}</span>
                    <span className="portal-row__main">
                      <span className="portal-row__name">
                        {p.portal_name}
                        {!p.is_enabled && <span className="badge badge--muted">Disabled</span>}
                      </span>
                      <Progress value={p.active_count} max={o?.users.total ?? 0} />
                    </span>
                    <span className="portal-row__count">
                      <strong>{p.active_count}</strong>
                      <span className="muted"> active</span>
                    </span>
                    <Icon name="chevronRight" className="muted" />
                  </a>
                </li>
              ))}
            </ul>
          )}
        </section>

        <div className="stack">
          <section className="card">
            <header className="card__head">
              <h2>Health</h2>
            </header>
            <dl className="kv">
              <div>
                <dt>EMS last sync</dt>
                <dd>{o ? timeAgo(o.last_ems_sync_at) : '—'}</dd>
              </div>
              <div>
                <dt>Users without any portal</dt>
                <dd>{o?.users.without_access ?? '—'}</dd>
              </div>
              <div>
                <dt>Portal events delivered (24h)</dt>
                <dd>{o?.events.delivered_24h ?? '—'}</dd>
              </div>
              <div>
                <dt>Events waiting / retrying</dt>
                <dd className={o?.events.pending ? 'text-warn' : ''}>{o?.events.pending ?? '—'}</dd>
              </div>
              <div>
                <dt>Events failed</dt>
                <dd className={o?.events.failed ? 'text-danger' : ''}>{o?.events.failed ?? '—'}</dd>
              </div>
            </dl>
          </section>

          <section className="card">
            <header className="card__head">
              <h2>Recent activity</h2>
            </header>
            {activity.data?.length === 0 && <p className="muted pad">No admin actions yet.</p>}
            <ol className="timeline">
              {activity.data?.map((a) => (
                <li key={a.id}>
                  <span className="timeline__dot" />
                  <div>
                    <div>{describeActivity(a, portals)}</div>
                    <div className="muted small">
                      {a.actor_label} · {timeAgo(a.created_at)}
                    </div>
                  </div>
                </li>
              ))}
            </ol>
          </section>
        </div>
      </div>
    </div>
  );
}
