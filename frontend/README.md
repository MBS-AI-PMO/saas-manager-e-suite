# SaaS Manager Dashboard

Admin-only dashboard for the Identity Center. Only SaaS administrators sign in
here; employees and other users only ever get access to target portals.

- **Overview**: identity totals, per-portal adoption, sync/delivery health, recent admin actions
- **Users**: directory of EMS + Direct SaaS identities; click a person to manage all their portal access
- **Portals**: add target portals with their own roles (secret shown once)
- **Portal page** (sidebar → portal): activate/deactivate EMS users and assign roles, singly or in bulk;
  manage roles; settings, enable/disable, secret rotation, integration endpoints

```bash
npm install
npm run dev        # http://localhost:5173, /api proxied to http://localhost:4100
npm run build && npm run lint
```

Backend: `../backend` (see the root README).

## Structure

```
src/App.jsx                         session gate + hash routes (#/overview, #/users, #/portals, #/portals/CODE)
src/api/client.js                   fetch wrapper, ApiError, admin token, 401 handling
src/api/identityApi.js              every API call the dashboard makes
src/hooks/useAsync.js               data loading (stale-while-revalidate)
src/hooks/useUsers.js               user lists + optimistic access changes with rollback
src/lib/router.js, format.js
src/components/layout/Shell.jsx     sidebar (live portal list) + mobile drawer
src/components/ui/                  Icon set and primitives (Modal/Drawer, Switch, badges, stats…)
src/components/PortalDialogs.jsx    add portal, one-time secret, integration facts
src/components/PortalAccessControl.jsx, CreateUserDialog.jsx, LoginScreen.jsx, Toasts.jsx
src/pages/OverviewPage.jsx, UsersPage.jsx, PortalsPage.jsx, PortalDetailPage.jsx
```

Access changes send `expected_version`, so two admins editing the same user
get a 409 and a refresh instead of silently overwriting each other.
