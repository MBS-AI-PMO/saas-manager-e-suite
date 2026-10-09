/**
 * Portal dialogs: register a portal (with its role catalogue), and show a
 * freshly generated webhook secret exactly once.
 */
import { useState } from 'react';
import { useAsync } from '../hooks/useAsync.js';
import { api, publicApiUrl } from '../api/identityApi.js';
import { toCode } from '../lib/format.js';
import { Icon } from './ui/Icon.jsx';
import { CopyField, Field, Modal } from './ui/ui.jsx';

// List keys only. Not crypto.randomUUID(): browsers expose it on HTTPS/localhost only,
// so it crashed the dialog on a plain-HTTP deployment.
let roleKeySeq = 0;
const newRole = (name = '') => ({ key: `role-${++roleKeySeq}`, role_name: name, role_code: toCode(name), codeEdited: false, permissions: '' });

export function CreatePortalDialog({ open, onClose, onCreated }) {
  return (
    <Modal open={open} onClose={onClose} title="Add portal" subtitle="Register a target application and define its own roles." width={720}>
      {open && <CreatePortalForm onCancel={onClose} onCreated={onCreated} />}
    </Modal>
  );
}

function CreatePortalForm({ onCancel, onCreated }) {
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [codeEdited, setCodeEdited] = useState(false);
  const [baseUrl, setBaseUrl] = useState('');
  const [webhookUrl, setWebhookUrl] = useState('');
  const [roles, setRoles] = useState([newRole('Admin'), newRole('User')]);
  const [autoGrantKey, setAutoGrantKey] = useState(''); // role row key, '' = off
  const [roleSource, setRoleSource] = useState('SAAS');
  const [emsAuto, setEmsAuto] = useState(''); // EMS role id used as auto-assign fallback, '' = off
  const emsRoles = useAsync(() => api.emsRoles(), []);
  const fromEms = roleSource === 'EMS';
  const fromPortal = roleSource === 'PORTAL';
  const [rolesUrl, setRolesUrl] = useState('');
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);

  const effectiveCode = codeEdited ? code : toCode(name);
  const setRole = (key, patch) =>
    setRoles((rs) =>
      rs.map((r) => {
        if (r.key !== key) return r;
        const next = { ...r, ...patch };
        if ('role_name' in patch && !r.codeEdited) next.role_code = toCode(patch.role_name);
        return next;
      }),
    );

  function validate() {
    const e = {};
    if (name.trim().length < 2) e.name = 'Enter the portal name.';
    if (!/^[A-Z0-9_]{2,50}$/.test(effectiveCode)) e.code = 'Use 2–50 characters: A–Z, 0–9 and _.';
    for (const [k, v] of [['baseUrl', baseUrl], ['webhookUrl', webhookUrl]]) {
      if (v && !/^https?:\/\/\S+$/i.test(v)) e[k] = 'Enter a full URL starting with http:// or https://';
    }
    if (fromEms) {
      if (!emsRoles.data?.length) e.roles = 'No EMS roles received yet. Run "php artisan sync:ems-users" in the HRMS first.';
      return e;
    }
    if (fromPortal) {
      if (!/^https?:\/\/\S+$/i.test(rolesUrl.trim())) e.rolesUrl = 'Enter the full URL of the portal\'s roles endpoint.';
      return e;
    }
    if (!roles.length) e.roles = 'Add at least one role.';
    const codes = roles.map((r) => r.role_code);
    if (roles.some((r) => !r.role_name.trim() || !/^[A-Z0-9_]{2,50}$/.test(r.role_code))) e.roles = 'Every role needs a name and a valid code.';
    else if (new Set(codes).size !== codes.length) e.roles = 'Role codes must be unique.';
    return e;
  }

  async function submit(ev) {
    ev.preventDefault();
    const e = validate();
    setErrors(e);
    if (Object.keys(e).length) return;
    setBusy(true);
    try {
      const res = await api.createPortal({
        portal_name: name.trim(),
        portal_code: effectiveCode,
        base_url: baseUrl.trim() || null,
        webhook_url: webhookUrl.trim() || null,
        role_source: roleSource,
        roles_url: fromPortal ? rolesUrl.trim() : null,
        auto_grant_role: fromEms || fromPortal ? null : (roles.find((r) => r.key === autoGrantKey)?.role_code ?? null),
        auto_grant_ems_role_id: fromEms && emsAuto ? Number(emsAuto) : null,
        roles: fromEms || fromPortal ? [] : roles.map((r) => ({
          role_code: r.role_code,
          role_name: r.role_name.trim(),
          permissions: r.permissions.split(',').map((p) => p.trim()).filter(Boolean),
        })),
      });
      onCreated(res.data, res.webhook_secret, res.roles_fetch);
    } catch (err) {
      setErrors({ form: err.status === 409 ? err.message : err.message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate className="form">
      <div className="grid-2">
        <Field label="Portal name" error={errors.name}>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. HR Portal" autoFocus />
        </Field>
        <Field label="Portal code" hint="Used in tokens and the API. Cannot be changed later." error={errors.code}>
          <input
            className="input mono"
            value={effectiveCode}
            onChange={(e) => {
              setCodeEdited(true);
              setCode(e.target.value.toUpperCase());
            }}
            placeholder="HR_PORTAL"
          />
        </Field>
        <Field label="Portal URL" hint="Optional. Where users open the portal." error={errors.baseUrl}>
          <input className="input" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://hr.company.com" />
        </Field>
        <Field label="Webhook URL" hint="Optional. Receives instant ACTIVE/INACTIVE events." error={errors.webhookUrl}>
          <input className="input" value={webhookUrl} onChange={(e) => setWebhookUrl(e.target.value)} placeholder="https://hr.company.com/iam/events" />
        </Field>
      </div>

      <Field label="Roles come from">
        <div className="segmented-lg segmented-lg--3" role="radiogroup" aria-label="Roles come from">
          <button type="button" role="radio" aria-checked={fromPortal} className={fromPortal ? 'is-active' : ''} onClick={() => setRoleSource('PORTAL')}>
            <strong>From the portal</strong>
            <span>Fetched from the portal's roles URL and kept in sync</span>
          </button>
          <button type="button" role="radio" aria-checked={roleSource === 'SAAS'} className={roleSource === 'SAAS' ? 'is-active' : ''} onClick={() => setRoleSource('SAAS')}>
            <strong>Define here</strong>
            <span>Type the roles in by hand</span>
          </button>
          <button type="button" role="radio" aria-checked={fromEms} className={fromEms ? 'is-active' : ''} onClick={() => setRoleSource('EMS')}>
            <strong>EMS (HRMS) roles</strong>
            <span>Same roles as the HRMS; changes write back to it</span>
          </button>
        </div>
      </Field>

      {fromPortal ? (
        <fieldset className="role-editor">
          <legend>Roles from the portal</legend>
          <Field
            label="Roles URL"
            hint="The SaaS calls this with a signed GET right after you create the portal, then every 15 minutes."
            error={errors.rolesUrl}
          >
            <input className="input" value={rolesUrl} onChange={(e) => setRolesUrl(e.target.value)} placeholder="https://portal.company.com/iam/roles" />
          </Field>
          <details className="contract">
            <summary>What the portal must return</summary>
            <pre>{`GET /iam/roles  ->  200
{ "roles": [
    { "id": "editor", "name": "Editor",
      "permissions": ["post.edit", "post.publish"] },
    { "id": "viewer", "name": "Viewer" }
] }`}</pre>
            <p className="muted small">
              The request carries X-IAM-Timestamp and X-IAM-Signature (HMAC with the portal secret). The portal can also push the same
              JSON to POST /api/v1/portal-sync/roles whenever its roles change.
            </p>
          </details>
        </fieldset>
      ) : fromEms ? (
        <fieldset className="role-editor">
          <legend>Roles from EMS</legend>
          <p className="muted small">Each employee gets their own EMS role here. Changing it here changes it in the HRMS.</p>
          <div className="perm-list">
            {emsRoles.data?.map((r) => (
              <span key={r.ems_id} className="role-pill">
                {r.role_name} <span className="muted">· {r.user_count}</span>
              </span>
            ))}
            {emsRoles.data?.length === 0 && <span className="muted small">No EMS roles received yet.</span>}
          </div>
          {errors.roles && <small className="field__error">{errors.roles}</small>}
        </fieldset>
      ) : (
      <fieldset className="role-editor">
        <legend>Roles in this portal</legend>
        <p className="muted small">These are this portal's own roles. They are independent of EMS roles.</p>
        <div className="role-editor__head">
          <span>Role name</span>
          <span>Code</span>
          <span>Permissions (comma separated, optional)</span>
          <span />
        </div>
        {roles.map((r) => (
          <div key={r.key} className="role-editor__row">
            <input className="input" aria-label="Role name" value={r.role_name} onChange={(e) => setRole(r.key, { role_name: e.target.value })} placeholder="Manager" />
            <input
              className="input mono"
              aria-label="Role code"
              value={r.role_code}
              onChange={(e) => setRole(r.key, { role_code: e.target.value.toUpperCase(), codeEdited: true })}
            />
            <input
              className="input"
              aria-label="Permissions"
              value={r.permissions}
              onChange={(e) => setRole(r.key, { permissions: e.target.value })}
              placeholder="leave.approve, reports.view"
            />
            <button
              type="button"
              className="icon-btn"
              aria-label={`Remove ${r.role_name || 'role'}`}
              disabled={roles.length === 1}
              onClick={() => setRoles((rs) => rs.filter((x) => x.key !== r.key))}
            >
              <Icon name="trash" size={16} />
            </button>
          </div>
        ))}
        {errors.roles && <small className="field__error">{errors.roles}</small>}
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => setRoles((rs) => [...rs, newRole()])}>
          <Icon name="plus" size={14} /> Add role
        </button>
      </fieldset>
      )}

      {fromPortal ? null : fromEms ? (
        <Field label="Auto-assign EMS users" hint="Every employee (and every new hire) gets access with their own EMS role. The fallback is used when an employee's EMS role is unknown.">
          <select className="select" value={emsAuto} onChange={(e) => setEmsAuto(e.target.value)}>
            <option value="">Off: I will assign users myself</option>
            {emsRoles.data?.map((r) => (
              <option key={r.ems_id} value={r.ems_id}>
                Everyone with their EMS role (fallback: {r.role_name})
              </option>
            ))}
          </select>
        </Field>
      ) : (
      <Field label="Auto-assign EMS users" hint="Every EMS employee (and every new hire) gets this role automatically. Pick Off to assign people yourself.">
        <select className="select" value={autoGrantKey} onChange={(e) => setAutoGrantKey(e.target.value)}>
          <option value="">Off: I will assign users myself</option>
          {roles
            .filter((r) => r.role_name.trim())
            .map((r) => (
              <option key={r.key} value={r.key}>
                Everyone as {r.role_name}
              </option>
            ))}
        </select>
      </Field>
      )}

      {errors.form && (
        <p className="form-error" role="alert">
          {errors.form}
        </p>
      )}

      <div className="form__actions">
        <button type="button" className="btn" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button className="btn btn--primary" disabled={busy}>
          {busy ? 'Creating…' : 'Create portal'}
        </button>
      </div>
    </form>
  );
}

/** Shown after create / rotate: the only time the secret is visible. */
export function SecretDialog({ portal, secret, rolesFetch, onClose }) {
  return (
    <Modal
      open={Boolean(secret)}
      onClose={onClose}
      title="Save the portal secret"
      subtitle={portal ? `${portal.portal_name} (${portal.portal_code})` : ''}
      width={620}
      footer={
        <button type="button" className="btn btn--primary" onClick={onClose}>
          I've saved it
        </button>
      }
    >
      {secret && (
        <div className="form">
          <div className="callout callout--warn">
            <Icon name="alert" />
            <span>This secret is shown only once. Give it to the portal's developers; it cannot be viewed again (only rotated).</span>
          </div>
          <Field label="Webhook / introspection secret">
            <CopyField value={secret} secret />
          </Field>
          {rolesFetch && (
            <div className={`callout ${rolesFetch.ok ? 'callout--ok' : 'callout--warn'}`}>
              <Icon name={rolesFetch.ok ? 'check' : 'alert'} />
              <span>
                {rolesFetch.ok
                  ? `Fetched ${rolesFetch.roles} role${rolesFetch.roles === 1 ? '' : 's'} from the portal.`
                  : `Roles not fetched yet: ${rolesFetch.error}. Once the portal team has installed this secret, open the portal's Roles tab and click "Fetch roles now".`}
              </span>
            </div>
          )}
          <IntegrationFacts code={portal?.portal_code} />
        </div>
      )}
    </Modal>
  );
}

/** Endpoints a portal developer needs. */
export function IntegrationFacts({ code }) {
  return (
    <div className="facts">
      <Field label="Portal code (JWT audience)">
        <CopyField value={code ?? ''} />
      </Field>
      <Field label="Sign-in / token endpoint">
        <CopyField value={`${publicApiUrl}/api/v1/auth/token`} />
      </Field>
      <Field label="Public keys (JWKS) to verify tokens">
        <CopyField value={`${publicApiUrl}/.well-known/jwks.json`} />
      </Field>
      <Field label="Live token check (introspection)">
        <CopyField value={`${publicApiUrl}/api/v1/auth/introspect`} />
      </Field>
    </div>
  );
}
