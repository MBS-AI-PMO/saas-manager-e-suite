/**
 * App frame: sidebar navigation (with every registered portal listed for
 * one-click access management) and a slim top bar.
 */
import { useState } from 'react';
import { href } from '../../lib/router.js';
import { Icon } from '../ui/Icon.jsx';
import { Avatar } from '../ui/ui.jsx';

export function Shell({ admin, portals, route, onSignOut, children }) {
  const [navOpen, setNavOpen] = useState(false);
  const [first, second] = route.segments;
  const is = (section, code) => first === section && (code === undefined || second === code);

  return (
    <div className={`shell ${navOpen ? 'shell--nav-open' : ''}`}>
      <aside className="sidebar" onClick={(e) => e.target.closest('a') && setNavOpen(false)}>
        <div className="sidebar__brand">
          <span className="logo" aria-hidden="true">
            <Icon name="shield" size={16} strokeWidth={2.2} />
          </span>
          <div>
            <div className="sidebar__title">Identity Center</div>
            <div className="sidebar__subtitle">SaaS Manager</div>
          </div>
        </div>

        <nav className="nav" aria-label="Main">
          <a className={`nav__item ${!first || first === 'overview' ? 'is-active' : ''}`} href={href('/overview')}>
            <Icon name="overview" /> Overview
          </a>
          <a className={`nav__item ${is('users') ? 'is-active' : ''}`} href={href('/users')}>
            <Icon name="users" /> Users
          </a>
          <a className={`nav__item ${is('portals') && !second ? 'is-active' : ''}`} href={href('/portals')}>
            <Icon name="portal" /> Portals
          </a>

          <div className="nav__section">
            <span>Portal access</span>
            <a className="nav__add" href={href('/portals/new')} title="Add portal" aria-label="Add portal">
              <Icon name="plus" size={14} />
            </a>
          </div>
          {portals === undefined && <div className="nav__hint">Loading…</div>}
          {portals?.length === 0 && <div className="nav__hint">No portals yet</div>}
          {portals?.map((p) => (
            <a
              key={p.portal_code}
              className={`nav__item nav__item--portal ${is('portals', p.portal_code) ? 'is-active' : ''}`}
              href={href(`/portals/${encodeURIComponent(p.portal_code)}`)}
            >
              <span className={`nav__dot ${p.is_enabled ? '' : 'nav__dot--off'}`} />
              <span className="nav__label">{p.portal_name}</span>
              <span className="nav__count" title="Active users">
                {p.active_count}
              </span>
            </a>
          ))}
        </nav>

        <div className="sidebar__footer">
          <Avatar name={admin.full_name ?? admin.email} size={32} />
          <div className="sidebar__who">
            <div className="sidebar__name">{admin.full_name ?? 'Administrator'}</div>
            <div className="sidebar__email">{admin.email}</div>
          </div>
          <button type="button" className="icon-btn" onClick={onSignOut} aria-label="Sign out" title="Sign out">
            <Icon name="logout" />
          </button>
        </div>
      </aside>

      <div className="scrim" onClick={() => setNavOpen(false)} />

      <div className="main">
        <header className="mobilebar">
          <button type="button" className="icon-btn" aria-label="Open menu" onClick={() => setNavOpen(true)}>
            <Icon name="menu" />
          </button>
          <span className="sidebar__title">Identity Center</span>
        </header>
        <main className="content">{children}</main>
      </div>
    </div>
  );
}
