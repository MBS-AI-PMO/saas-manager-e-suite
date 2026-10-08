/**
 * Admin sign-in. Only SaaS administrators can use this dashboard; employees
 * and portal users never sign in here.
 */
import { useState } from 'react';
import { api } from '../api/identityApi.js';
import { Icon } from './ui/Icon.jsx';
import { Field } from './ui/ui.jsx';

export function LoginScreen({ onSignedIn }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onSignedIn(await api.login(email.trim(), password));
    } catch (err) {
      setError(err.status === 401 ? 'Email or password is incorrect, or this account is not an administrator.' : err.message);
      setBusy(false);
    }
  }

  return (
    <main className="login">
      <section className="login__aside" aria-hidden="true">
        <div className="login__brand">
          <span className="logo logo--lg">
            <Icon name="shield" size={22} strokeWidth={2.2} />
          </span>
          Identity Center
        </div>
        <div>
          <h2>One place to control who can use every portal.</h2>
          <ul className="login__points">
            <li>
              <Icon name="sync" /> Employees sync automatically from EMS
            </li>
            <li>
              <Icon name="portal" /> Activate or deactivate access per portal
            </li>
            <li>
              <Icon name="key" /> Each portal keeps its own roles
            </li>
          </ul>
        </div>
        <span className="login__foot">SaaS Manager · Administrators only</span>
      </section>

      <section className="login__form-wrap">
        <form className="login__form" onSubmit={submit} noValidate>
          <h1>Sign in</h1>
          <p className="muted">Administrator access to the SaaS Manager.</p>
          <Field label="Email">
            <input className="input input--lg" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
          </Field>
          <Field label="Password">
            <input className="input input--lg" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <button className="btn btn--primary btn--lg btn--block" disabled={busy || !email || !password}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </section>
    </main>
  );
}
