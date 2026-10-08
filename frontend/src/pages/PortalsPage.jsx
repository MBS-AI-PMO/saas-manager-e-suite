/**
 * Portals: every registered target application, with adoption numbers.
 */
import { useState } from 'react';
import { CreatePortalDialog, SecretDialog } from '../components/PortalDialogs.jsx';
import { Icon } from '../components/ui/Icon.jsx';
import { EmptyState, StatusBadge } from '../components/ui/ui.jsx';
import { plural } from '../lib/format.js';
import { href, navigate } from '../lib/router.js';

export function PortalsPage({ portals, reloadPortals, notify, creating }) {
  const [secret, setSecret] = useState(null);

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Portals</h1>
          <p className="muted">Target applications that take their users and roles from the Identity Center.</p>
        </div>
        <a className="btn btn--primary" href={href('/portals/new')}>
          <Icon name="plus" size={16} /> Add portal
        </a>
      </header>

      {portals?.length === 0 && (
        <div className="card">
          <EmptyState icon="portal" title="No portals yet" action={<a className="btn btn--primary" href={href('/portals/new')}>Add your first portal</a>}>
            Add a portal, define its roles, then activate EMS users on it.
          </EmptyState>
        </div>
      )}

      <div className="portal-grid">
        {portals?.map((p) => (
          <a key={p.portal_code} className="portal-card" href={href(`/portals/${encodeURIComponent(p.portal_code)}`)}>
            <div className="portal-card__top">
              <span className="portal-row__icon portal-row__icon--lg">{p.portal_name.slice(0, 2).toUpperCase()}</span>
              <StatusBadge active={p.is_enabled} labels={['Enabled', 'Disabled']} />
            </div>
            <h3>{p.portal_name}</h3>
            <code className="code-chip">{p.portal_code}</code>
            <div className="portal-card__nums">
              <div>
                <strong>{p.active_count}</strong>
                <span>Active</span>
              </div>
              <div>
                <strong>{p.granted_count - p.active_count}</strong>
                <span>Inactive</span>
              </div>
              <div>
                <strong>{p.roles.length}</strong>
                <span>Roles</span>
              </div>
            </div>
            <div className="portal-card__foot">
              <span className={p.has_webhook ? 'text-ok' : 'muted'}>
                <Icon name="link" size={14} /> {p.has_webhook ? 'Webhook connected' : 'Token-only (no webhook)'}
              </span>
              {p.failed_events > 0 && <span className="text-danger">{plural(p.failed_events, 'failed event')}</span>}
            </div>
          </a>
        ))}
      </div>

      <CreatePortalDialog
        open={creating}
        onClose={() => navigate('/portals')}
        onCreated={(portal, webhookSecret, rolesFetch) => {
          reloadPortals();
          navigate('/portals'); // close the create dialog before revealing the secret
          notify({ tone: 'success', text: `${portal.portal_name} added.` });
          setSecret({ portal, value: webhookSecret, rolesFetch });
        }}
      />
      <SecretDialog
        portal={secret?.portal}
        secret={secret?.value}
        rolesFetch={secret?.rolesFetch}
        onClose={() => {
          const code = secret?.portal.portal_code;
          setSecret(null);
          if (code) navigate(`/portals/${encodeURIComponent(code)}`);
        }}
      />
    </div>
  );
}
