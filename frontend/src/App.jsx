/**
 * App root: admin session gate, routing, and the toast host.
 *
 * Only SaaS administrators can sign in here. Employees and portal users never
 * get access to this dashboard; they only get access to target portals.
 */
import { useCallback, useEffect, useState } from 'react';
import { onUnauthorized } from './api/client.js';
import { api } from './api/identityApi.js';
import { Shell } from './components/layout/Shell.jsx';
import { LoginScreen } from './components/LoginScreen.jsx';
import { Toasts } from './components/Toasts.jsx';
import { useAsync } from './hooks/useAsync.js';
import { useToasts } from './hooks/useToasts.js';
import { useRoute } from './lib/router.js';
import { OverviewPage } from './pages/OverviewPage.jsx';
import { PortalDetailPage } from './pages/PortalDetailPage.jsx';
import { PortalsPage } from './pages/PortalsPage.jsx';
import { UsersPage } from './pages/UsersPage.jsx';

export default function App() {
  // undefined = checking an existing session; null = signed out
  const [admin, setAdmin] = useState(api.hasSession() ? undefined : null);
  const { toasts, notify, dismiss } = useToasts();

  const signOut = useCallback(() => {
    api.logout();
    setAdmin(null);
  }, []);

  useEffect(() => {
    onUnauthorized(() => {
      signOut();
      notify({ tone: 'info', text: 'Your session has ended. Please sign in again.' });
    });
  }, [signOut, notify]);

  useEffect(() => {
    if (admin !== undefined) return;
    api.me().then(setAdmin, signOut);
  }, [admin, signOut]);

  if (admin === undefined) return <div className="boot" />;

  return (
    <>
      {admin === null ? <LoginScreen onSignedIn={setAdmin} /> : <Dashboard admin={admin} onSignOut={signOut} notify={notify} />}
      <Toasts toasts={toasts} dismiss={dismiss} />
    </>
  );
}

function Dashboard({ admin, onSignOut, notify }) {
  const route = useRoute();
  // Portals feed the sidebar and every page; reload after any portal change.
  const portalsQ = useAsync(() => api.listPortals(), []);
  const shared = { portals: portalsQ.data, reloadPortals: portalsQ.reload, notify };

  const [section, sub] = route.segments;
  let page;
  if (section === 'users') page = <UsersPage {...shared} />;
  else if (section === 'portals' && sub && sub !== 'new') page = <PortalDetailPage key={sub} code={sub} {...shared} />;
  else if (section === 'portals') page = <PortalsPage {...shared} creating={sub === 'new'} />;
  else page = <OverviewPage {...shared} />;

  return (
    <Shell admin={admin} portals={portalsQ.data} route={route} onSignOut={onSignOut}>
      {portalsQ.error && !portalsQ.data && (
        <div className="banner banner--error">Could not load portals: {portalsQ.error.message}</div>
      )}
      {page}
    </Shell>
  );
}
