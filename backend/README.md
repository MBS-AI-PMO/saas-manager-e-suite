# SaaS Identity Center: API

Central identity, provisioning, and access control for target portals.
Express 5 + PostgreSQL (`pg`), RS256 JWTs, transactional outbox for portal webhooks.

```
 EMS (Laravel HRMS) ──signed webhook──▶  Identity API  ──signed events──▶  Target portals
   observers + 5-min reconciler           (this repo)    (outbox, retry)    React/Vue/Node/PHP
                                              ▲   │
          SaaS Manager dashboard (React) ─────┘   └── /auth/token (JWT) · /.well-known/jwks.json · /auth/introspect
```

## Quick start

```bash
npm install

# Normal: local/real PostgreSQL 13+ (this machine: database saas_identity, login saas_app, port 4100)
cp .env.example .env         # fill PG*, EMS_WEBHOOK_SECRET, JWT_ISSUER, PORT
npm run keys:generate        # keys/jwt-private.pem + jwt-public.pem
npm run migrate              # applies db/migrations/*.sql once each
SAAS_ADMIN_PASSWORD='a-long-password' npm run admin:create -- --email you@company.com
npm run dev                  # or: npm start

# Throwaway demo without PostgreSQL (embedded PGlite in .dev-db/)
npm run dev:memory
# Move dev:memory data into PostgreSQL (after `npm run migrate`; stop dev:memory first)
npm run import:dev-memory
```

Stop the server with Ctrl+C. A forced kill of `dev:memory` can corrupt `.dev-db`
(PGlite cannot replay a torn write-ahead log); real PostgreSQL recovers on its own.

Tests (spin up an in-memory Postgres, no setup needed):

```bash
npm test
HRMS_PATH=../HRMS npm test   # also pushes real HRMS employees through the PHP side (read-only on MySQL)
```

## Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/v1/webhooks/ems-user` | HMAC (`X-EMS-Signature`) | EMS user upserts/deletes (single or batches ≤200) |
| POST | `/api/v1/auth/admin/login` | — | Dashboard login → admin JWT |
| GET | `/api/v1/auth/me` | admin JWT | Current admin |
| GET | `/api/v1/users` | admin JWT | List/search (`search`, `source`, `status`, `department_id`, `portal_code` + `access`=`granted\|active\|inactive\|none`, `page`, `page_size`) |
| GET | `/api/v1/users/:id` | admin JWT | One user with portal access |
| POST | `/api/v1/users` | admin JWT | Create a DIRECT_SAAS user (+ initial portal access) |
| POST | `/api/v1/users/portal-access` | admin JWT | Toggle `is_active` and/or set `role_code` for one portal |
| GET | `/api/v1/overview` · `/activity` | admin JWT | Dashboard KPIs, delivery health, recent admin actions |
| GET | `/api/v1/departments` · `/designations` | admin JWT | Reference data |
| GET / POST | `/api/v1/portals` | admin JWT | List portals (roles + counts) / register a portal (secret returned once) |
| GET / PATCH / DELETE | `/api/v1/portals/:code` | admin JWT | Details / rename, URLs, enable-disable / delete (only if unused) |
| POST | `/api/v1/portals/:code/rotate-secret` | admin JWT | New webhook secret (returned once) |
| POST / PATCH / DELETE | `/api/v1/portals/:code/roles[/:role]` | admin JWT | Manage the portal's role catalogue |
| POST | `/api/v1/portals/:code/access/bulk` | admin JWT | Activate / deactivate / set role for up to 500 users |
| POST | `/api/v1/auth/token` | user credentials | Portal-scoped JWT (role + permissions) |
| POST | `/api/v1/auth/introspect` | portal Basic auth | Live token validity |
| GET | `/.well-known/jwks.json` | — | Public keys for portals |
| GET | `/health` | — | Liveness + DB check |

Errors always look like `{ "error": { "code", "message", "details?", "request_id" } }`.

Target-portal payloads and receiver code: [docs/TARGET_PORTAL_EVENTS.md](docs/TARGET_PORTAL_EVENTS.md).

## Rules worth knowing

- **EMS owns identity fields** of `source = 'EMS'` users; each sync overwrites them. **The SaaS owns portal access** for everyone; EMS never touches it.
- **Global vs per-portal status.** EMS deactivation sets the account `INACTIVE`, which blocks every portal *without* clearing the per-portal toggles. Re-activation in EMS restores exactly the previous setup.
- **No hard deletes.** An employee deleted in EMS becomes `INACTIVE`; history and audit are kept.
- **Adoption.** If EMS sends an email that already belongs to a DIRECT_SAAS user, that row is linked to EMS (`adopted`) and keeps its portal access.
- **Idempotent and ordered.** Replays are `unchanged` (payload hash); events older than the last applied one are `stale`.
- **Revocation latency.** Webhook portals: seconds. Portals without a webhook: ≤ token TTL (15 min), or immediate if they introspect.
- `user_portal_access.assigned_portal_role` has a composite FK to `portal_roles(portal_id, role_code)`, so a role from another portal can never be assigned.

## Layout

```
db/migrations/001_identity_schema.sql   DDL (UUIDs, FKs, indexes, outbox, audit)
db/seeds/                               example portals + role catalogues
src/config/env.js                       validated environment
src/db/pool.js                          pg Pool + withTransaction()
src/middleware/                         HMAC verify, admin auth, zod validation, error handler
src/services/userService.js             EMS ingestion, direct creation, listing
src/services/accessService.js           portal access governance, token grants
src/services/outboxService.js           portal event enqueue + dispatcher
src/services/tokenService.js            RS256 sign/verify, JWKS
src/routes/                             HTTP layer
scripts/                                migrate, keys, create-admin, dev-memory
test/e2e.test.js                        end-to-end suite
```
