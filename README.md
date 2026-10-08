# SaaS Manager — Identity Center

Central identity and access management for EMS (HRMS) and every target portal (IMS, …).

```
backend/    Express API + PostgreSQL migrations (db/)   → own Dockerfile, port 4100
frontend/   React (Vite) admin dashboard               → own Dockerfile (nginx), port 80
```

Deploying to Coolify: see [DEPLOY.md](DEPLOY.md).

## Run locally

```bash
# 1. API (needs PostgreSQL; see backend/README.md for first-time setup)
cd backend
npm install
npm run migrate
npm run dev          # http://localhost:4100

# 2. Dashboard
cd frontend
npm install
npm run dev          # http://localhost:5173  (/api is proxied to :4100)
```

No PostgreSQL? `cd backend && npm run dev:memory` runs the API on an embedded database.

## Docs

- [backend/README.md](backend/README.md): API endpoints, rules, layout, tests
- [backend/docs/TARGET_PORTAL_EVENTS.md](backend/docs/TARGET_PORTAL_EVENTS.md): how a portal connects (webhook events, JWT, roles endpoint)
- [frontend/README.md](frontend/README.md): dashboard structure
