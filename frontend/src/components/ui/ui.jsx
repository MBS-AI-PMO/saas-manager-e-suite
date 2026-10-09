/**
 * Shared presentational primitives.
 */
import { useEffect, useRef, useState } from 'react';
import { hueFor, initials } from '../../lib/format.js';
import { Icon } from './Icon.jsx';

export function Avatar({ name, size = 36 }) {
  const hue = hueFor(name);
  return (
    <span
      className="avatar"
      aria-hidden="true"
      style={{ '--h': hue, width: size, height: size, fontSize: Math.round(size * 0.36) }}
    >
      {initials(name)}
    </span>
  );
}

export function SourceBadge({ source }) {
  const ems = source === 'EMS';
  return (
    <span className={`badge ${ems ? 'badge--ems' : 'badge--direct'}`} title={ems ? 'Synced from EMS (HRMS)' : 'Created in SaaS Manager'}>
      {ems ? 'EMS' : 'Direct'}
    </span>
  );
}

export function StatusBadge({ active, labels = ['Active', 'Inactive'] }) {
  return (
    <span className={`status ${active ? 'status--on' : 'status--off'}`}>
      <span className="status__dot" />
      {active ? labels[0] : labels[1]}
    </span>
  );
}

export function Switch({ checked, onChange, disabled, label }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={`switch ${checked ? 'switch--on' : ''}`}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className="switch__thumb" />
    </button>
  );
}

export function StatCard({ label, value, icon, tone = 'neutral', hint }) {
  return (
    <div className={`stat stat--${tone}`}>
      <div className="stat__icon">
        <Icon name={icon} size={18} />
      </div>
      <div>
        <div className="stat__value">{value ?? '—'}</div>
        <div className="stat__label">{label}</div>
        {hint && <div className="stat__hint">{hint}</div>}
      </div>
    </div>
  );
}

export function EmptyState({ icon = 'users', title, children, action }) {
  return (
    <div className="empty">
      <div className="empty__icon">
        <Icon name={icon} size={22} />
      </div>
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

export function Spinner({ size = 16 }) {
  return <span className="spinner" style={{ width: size, height: size }} aria-label="Loading" />;
}

export function Field({ label, hint, error, children, className = '' }) {
  return (
    <label className={`field ${error ? 'field--error' : ''} ${className}`}>
      <span className="field__label">{label}</span>
      {children}
      {error ? <small className="field__error">{error}</small> : hint ? <small className="field__hint">{hint}</small> : null}
    </label>
  );
}

/**
 * Modal built on native <dialog>: focus trap, Esc and inert background for free.
 * `variant="drawer"` slides in from the right.
 */
export function Modal({ open, onClose, title, subtitle, children, footer, variant = 'modal', width }) {
  const ref = useRef(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className={`modal modal--${variant}`}
      style={width ? { '--w': `${width}px` } : undefined}
      onClose={onClose}
      // Click on the backdrop (the dialog element itself) closes it.
      onClick={(e) => e.target === ref.current && onClose()}
    >
      {open && (
        <div className="modal__panel">
          <header className="modal__header">
            <div>
              <h2>{title}</h2>
              {subtitle && <p>{subtitle}</p>}
            </div>
            <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
              <Icon name="x" />
            </button>
          </header>
          <div className="modal__body">{children}</div>
          {footer && <footer className="modal__footer">{footer}</footer>}
        </div>
      )}
    </dialog>
  );
}

function legacyCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  // inside an open modal <dialog> everything outside it is inert, so add the textarea there
  (document.querySelector('dialog[open]') ?? document.body).appendChild(ta);
  ta.select();
  const ok = document.execCommand('copy');
  ta.remove();
  if (!ok) throw new Error('copy failed');
}

export function CopyField({ value, secret = false }) {
  const [copied, setCopied] = useState(false);
  const [shown, setShown] = useState(!secret);
  async function copy() {
    try {
      // navigator.clipboard exists on HTTPS/localhost only; plain-HTTP deployments use the old way
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(value);
      else legacyCopy(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked: user can still select the text */
    }
  }
  return (
    <div className="copy">
      <code className="copy__value">{shown ? value : '•'.repeat(Math.min(32, value.length))}</code>
      {secret && (
        <button type="button" className="btn btn--ghost btn--xs" onClick={() => setShown((s) => !s)}>
          {shown ? 'Hide' : 'Show'}
        </button>
      )}
      <button type="button" className="btn btn--ghost btn--xs" onClick={copy}>
        <Icon name={copied ? 'check' : 'copy'} size={14} />
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

export function Progress({ value, max }) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  return (
    <div className="progress" role="progressbar" aria-valuenow={value} aria-valuemin={0} aria-valuemax={max}>
      <span style={{ width: `${pct}%` }} />
    </div>
  );
}

export function Pager({ meta, page, onPage, loading }) {
  const pages = Math.max(1, meta.total_pages);
  const from = meta.total ? (meta.page - 1) * meta.page_size + 1 : 0;
  const to = Math.min(meta.total, meta.page * meta.page_size);
  return (
    <div className="pager">
      <span className="muted">
        {from}–{to} of {meta.total}
      </span>
      <div className="pager__controls">
        <button type="button" className="icon-btn" aria-label="Previous page" disabled={page <= 1 || loading} onClick={() => onPage(page - 1)}>
          <Icon name="chevronLeft" />
        </button>
        <span className="pager__page">
          {meta.page} / {pages}
        </span>
        <button type="button" className="icon-btn" aria-label="Next page" disabled={page >= pages || loading} onClick={() => onPage(page + 1)}>
          <Icon name="chevronRight" />
        </button>
      </div>
    </div>
  );
}

export function SkeletonRows({ rows = 6, cols }) {
  return Array.from({ length: rows }, (_, i) => (
    <tr key={i} className="skeleton-row">
      {Array.from({ length: cols }, (_, j) => (
        <td key={j}>
          <span className="skeleton" />
        </td>
      ))}
    </tr>
  ));
}
