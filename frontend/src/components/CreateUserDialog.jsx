/**
 * Create a DIRECT_SAAS user: someone not in the EMS (contractor, vendor,
 * auditor), optionally with initial portal access. EMS employees are never
 * created here; they arrive through EMS sync.
 */
import { useState } from 'react';
import { api } from '../api/identityApi.js';
import { Field, Modal } from './ui/ui.jsx';

export function CreateUserDialog({ open, onClose, ...rest }) {
  return (
    <Modal open={open} onClose={onClose} title="Add Direct SaaS user" subtitle="For people outside the EMS. Employees are added automatically by EMS sync." width={720}>
      {open && <CreateUserForm onCancel={onClose} {...rest} />}
    </Modal>
  );
}

const EMPTY = { full_name: '', email: '', password: '', department_id: '', designation_id: '', deployed_project: '', deployed_location: '' };

function validate(form) {
  const errors = {};
  if (form.full_name.trim().length < 2) errors.full_name = 'Enter the full name.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) errors.email = 'Enter a valid email address.';
  if (form.password && form.password.length < 10) errors.password = 'Use at least 10 characters, or leave blank.';
  return errors;
}

function CreateUserForm({ onCancel, onCreated, portals, departments, designations }) {
  const [form, setForm] = useState(EMPTY);
  const [grants, setGrants] = useState({}); // { PORTAL_CODE: ROLE_CODE }
  const [errors, setErrors] = useState({});
  const [serverError, setServerError] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  async function submit(e) {
    e.preventDefault();
    const v = validate(form);
    // Every ticked portal needs a role.
    for (const [code, role] of Object.entries(grants)) {
      if (!role) v[`portal_${code}`] = 'Choose a role.';
    }
    setErrors(v);
    if (Object.keys(v).length) return;

    setBusy(true);
    setServerError(null);
    try {
      const user = await api.createUser({
        full_name: form.full_name.trim(),
        email: form.email.trim().toLowerCase(),
        ...(form.password ? { password: form.password } : {}),
        department_id: form.department_id || null,
        designation_id: form.designation_id || null,
        deployed_project: form.deployed_project.trim() || null,
        deployed_location: form.deployed_location.trim() || null,
        portal_access: Object.entries(grants).map(([portal_code, role_code]) => ({ portal_code, role_code, is_active: true })),
      });
      onCreated(user);
    } catch (err) {
      if (err.status === 409) setErrors({ email: 'This email already belongs to another user.' });
      else if (err.status === 400 && Array.isArray(err.details)) setErrors(Object.fromEntries(err.details.map((d) => [d.path.split('.')[0], d.message])));
      else setServerError(err.message);
      setBusy(false);
    }
  }

  return (
    <form className="form" onSubmit={submit} noValidate>
      <div className="grid-2">
        <Field label="Full name" error={errors.full_name}>
          <input className="input" value={form.full_name} onChange={set('full_name')} autoFocus />
        </Field>
        <Field label="Email" error={errors.email}>
          <input className="input" type="email" value={form.email} onChange={set('email')} />
        </Field>
        <Field label="Initial password" hint="Optional. At least 10 characters." error={errors.password}>
          <input className="input" type="password" autoComplete="new-password" value={form.password} onChange={set('password')} />
        </Field>
        <Field label="Department">
          <select className="select" value={form.department_id} onChange={set('department_id')}>
            <option value="">—</option>
            {departments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.dept_name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Designation">
          <select className="select" value={form.designation_id} onChange={set('designation_id')}>
            <option value="">—</option>
            {designations.map((d) => (
              <option key={d.id} value={d.id}>
                {d.designation_name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Deployed project">
          <input className="input" value={form.deployed_project} onChange={set('deployed_project')} />
        </Field>
        <Field label="Location" className="span-2">
          <input className="input" value={form.deployed_location} onChange={set('deployed_location')} />
        </Field>
      </div>

      {portals.length > 0 && (
        <fieldset className="role-editor">
          <legend>Portal access</legend>
          <p className="muted small">Tick the portals this person may use, then choose their role in each. Every portal has its own roles.</p>
          <div className="portal-pick">
            {portals.map((p) => {
              // Portals whose roles come from EMS (the HRMS) only serve EMS employees.
              const emsOnly = p.role_source === 'EMS';
              const noRoles = p.roles.length === 0;
              const on = p.portal_code in grants;
              return (
                <div key={p.portal_code} className={`portal-pick__item ${on ? 'is-on' : ''}`}>
                  <label className={`portal-pick__head ${emsOnly || noRoles ? 'is-disabled' : ''}`}>
                    <input
                      type="checkbox"
                      checked={on}
                      disabled={emsOnly || noRoles}
                      onChange={(e) =>
                        setGrants((g) => {
                          const next = { ...g };
                          // A single-role portal needs no choice: pick it automatically.
                          if (e.target.checked) next[p.portal_code] = p.roles.length === 1 ? p.roles[0].role_code : '';
                          else delete next[p.portal_code];
                          return next;
                        })
                      }
                    />
                    <span className="portal-row__icon">{p.portal_name.slice(0, 2).toUpperCase()}</span>
                    <span>
                      <strong>{p.portal_name}</strong>
                      <span className="muted small">
                        {emsOnly
                          ? ' · Only for EMS employees (roles come from EMS)'
                          : noRoles
                            ? ' · No roles yet (fetch them on the portal page)'
                            : ` · ${p.roles.length} role${p.roles.length === 1 ? '' : 's'}${p.role_source === 'PORTAL' ? ' from the portal' : ''}`}
                      </span>
                    </span>
                  </label>

                  {on && (
                    <div className="portal-pick__roles" role="radiogroup" aria-label={`Role in ${p.portal_name}`}>
                      <div className="portal-pick__q">Which role should they have in {p.portal_name}?</div>
                      {p.roles.map((r) => {
                        const checked = grants[p.portal_code] === r.role_code;
                        return (
                          <label key={r.role_code} className={`role-option ${checked ? 'is-checked' : ''}`}>
                            <input
                              type="radio"
                              name={`role-${p.portal_code}`}
                              checked={checked}
                              onChange={() => setGrants((g) => ({ ...g, [p.portal_code]: r.role_code }))}
                            />
                            <strong>{r.role_name}</strong>
                            <span className="role-option__perms">{r.permissions.length ? r.permissions.join(', ') : 'No permissions listed'}</span>
                          </label>
                        );
                      })}
                      {errors[`portal_${p.portal_code}`] && <small className="field__error">{errors[`portal_${p.portal_code}`]}</small>}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </fieldset>
      )}

      {serverError && (
        <p className="form-error" role="alert">
          {serverError}
        </p>
      )}
      <div className="form__actions">
        <button type="button" className="btn" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button className="btn btn--primary" disabled={busy}>
          {busy ? 'Creating…' : 'Create user'}
        </button>
      </div>
    </form>
  );
}
