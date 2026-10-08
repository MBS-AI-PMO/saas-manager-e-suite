/**
 * One user × one portal row, used in the user drawer: ACTIVE/INACTIVE switch
 * plus that portal's own role dropdown (independent of the EMS role).
 */
import { Switch } from './ui/ui.jsx';

export function PortalAccessControl({ user, portal, access, pending, onChange }) {
  const accountOff = user.status !== 'ACTIVE';

  return (
    <div className={`pac ${pending ? 'is-pending' : ''} ${portal.is_enabled ? '' : 'is-dim'}`}>
      <div className="pac__portal">
        <span className="portal-row__icon">{portal.portal_name.slice(0, 2).toUpperCase()}</span>
        <div>
          <div className="pac__name">{portal.portal_name}</div>
          <div className="muted small">
            {!access ? 'Not assigned' : access.is_active && !accountOff ? 'Active' : accountOff && access.is_active ? 'Blocked: account inactive in EMS' : 'Inactive'}
            {!portal.is_enabled && ' · portal disabled'}
          </div>
        </div>
      </div>
      <div className="pac__controls">
        <select
          className={`select select--sm ${access ? '' : 'select--grant'}`}
          aria-label={`${portal.portal_name} role`}
          value={access?.role_code ?? ''}
          disabled={pending}
          onChange={(e) => e.target.value && onChange(access ? { role_code: e.target.value } : { role_code: e.target.value, is_active: true })}
        >
          {!access && <option value="">+ Assign role…</option>}
          {portal.roles.map((r) => (
            <option key={r.role_code} value={r.role_code}>
              {r.role_name}
            </option>
          ))}
        </select>
        {access && (
          <Switch
            checked={access.is_active}
            disabled={pending}
            label={`${portal.portal_name} access for ${user.full_name}`}
            onChange={(on) => onChange({ is_active: on })}
          />
        )}
      </div>
    </div>
  );
}
