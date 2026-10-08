# Deploying the SaaS Manager on Coolify: backend + frontend as separate apps

Same layout as IMS: one repo, two apps, each with its own Dockerfile.

| Folder | What | Container port | Example domain |
|---|---|---|---|
| `backend/` | Identity API (migrations run on every start) | `4100` | `https://saas-api.your-domain.com` |
| `frontend/` | Dashboard, Vite build served by nginx | `80` | `https://saas.your-domain.com` |

```
Browser ──▶ https://saas.your-domain.com       (frontend · nginx)
   │
   └─────▶ https://saas-api.your-domain.com   (backend · Express :4100) ──▶ PostgreSQL (internal)
                 ▲          │
   HRMS ─────────┘          └──▶ signed webhooks to HRMS / IMS / other portals
```

---

## Step 1: PostgreSQL

1. **+ New → Databases → PostgreSQL** (16+). Initial database: `saas_identity`.
2. Start it; copy host, port, user and password of the **internal** connection.
3. Keep it **not** publicly available. Turn on daily backups.

## Step 2: Backend app (deploy first)

1. **+ New → Application** → this repo → branch `main`.
2. **Build Pack** `Dockerfile` · **Base Directory** `/backend` · **Dockerfile Location** `/Dockerfile`
3. **Ports Exposes** `4100` · **Domain** `https://saas-api.your-domain.com`
4. **Health check** path `/health`, port `4100`
5. **Environment variables**:

   | Key | Value |
   |---|---|
   | `NODE_ENV` | `production` |
   | `PGHOST` / `PGPORT` / `PGDATABASE` / `PGUSER` / `PGPASSWORD` | from Step 1 |
   | `PGSSL` | `false` on Coolify's internal network |
   | `CORS_ORIGINS` | `https://saas.your-domain.com` |
   | `JWT_ISSUER` | `https://saas-api.your-domain.com` |
   | `JWT_KEY_ID` | `identity-key-1` |
   | `JWT_PRIVATE_KEY` / `JWT_PUBLIC_KEY` | PEM text, see below |
   | `EMS_WEBHOOK_SECRET` | 64 hex chars; the HRMS uses the same value as `SAAS_WEBHOOK_SECRET` |

   **JWT keys.** Generate once on any machine with `cd backend && npm run keys:generate`. Then paste
   each file as a single line with `\n` in place of newlines:
   ```bash
   node -e "console.log(require('fs').readFileSync('keys/jwt-private.pem','utf8').replace(/\n/g,'\\\\n'))"
   ```
   Keep the same keys forever: changing them signs everyone out and invalidates every portal token.

6. **Deploy**. The log shows `Applying 00N_….sql … done` (first time), then `Identity API listening`.
7. Test: `https://saas-api.your-domain.com/health` → `{"status":"ok"}`.
8. **First admin.** In the backend app's Terminal:
   ```bash
   SAAS_ADMIN_PASSWORD='a-long-password' node scripts/create-admin.js --email you@company.com --name "Your Name"
   ```

## Step 3: Frontend app

1. **+ New → Application** → same repo.
2. **Build Pack** `Dockerfile` · **Base Directory** `/frontend` · **Dockerfile Location** `/Dockerfile`
3. **Ports Exposes** `80` · **Domain** `https://saas.your-domain.com`
4. **Build variables** (mark them *Build Variable*, they are baked into the bundle):

   | Key | Value |
   |---|---|
   | `VITE_API_BASE_URL` | `https://saas-api.your-domain.com/api/v1` |
   | `VITE_PUBLIC_API_URL` | `https://saas-api.your-domain.com` |

5. Deploy, open `https://saas.your-domain.com`, sign in with the admin from Step 2.

## Step 4: Connect the systems

- **HRMS**: `.env` → `SAAS_BASE_URL=https://saas-api.your-domain.com`, `SAAS_WEBHOOK_SECRET=<EMS_WEBHOOK_SECRET>`;
  run the SQL in `HRMS/docs/sql/saas_identity_production.sql`, then `php artisan sync:ems-users`.
  To govern HRMS logins: add portal `EMS_HRMS` in the dashboard (Roles from EMS, auto-assign on) and set
  `SAAS_PORTAL_SECRET` in the HRMS; see `HRMS/docs/SAAS_IDENTITY_INTEGRATION.md`.
- **IMS**: add portal `IMS` (Roles from the portal, roles URL `https://api.<ims-domain>/api/iam/roles`,
  webhook `https://api.<ims-domain>/api/iam/events`); set `IAM_BASE_URL` and `IAM_PORTAL_SECRET` in IMS and
  run `npm run iam:install`; see `inventory-managment-system/backend/src/iam/README.md`.

## Moving the local data to production (optional)

To keep the users, portals and access configured locally:
```bash
pg_dump -h 127.0.0.1 -U saas_app -d saas_identity --data-only --no-owner -f saas_data.sql
psql "<production connection>" -f saas_data.sql   # after the first deploy created the schema
```
Then point HRMS/IMS at production. Portal secrets come along, so their `.env` secrets stay valid.
