-- =============================================================================
-- Central SaaS Identity & Access Management — PostgreSQL schema (v1)
--
-- Design notes
--   * UUID primary keys everywhere (gen_random_uuid() is built in since PG 13).
--   * EMS owns identity data for source = 'EMS' rows; the SaaS owns portal
--     access for every user regardless of source.
--   * Portal roles are per-portal rows in `portal_roles`. `user_portal_access`
--     references them with a composite FK, so a role can never be assigned to
--     a portal that does not define it.
--   * Every access change is written to `portal_sync_events` (transactional
--     outbox) in the same transaction, and a dispatcher delivers it to the
--     target portal with retries. A crash can never leave the DB saying
--     "INACTIVE" while the portal never heard about it.
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- Enumerated types
-- ---------------------------------------------------------------------------
DO $$ BEGIN
    CREATE TYPE user_source AS ENUM ('EMS', 'DIRECT_SAAS');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    -- Global account status. INACTIVE overrides every per-portal flag.
    CREATE TYPE account_status AS ENUM ('ACTIVE', 'INACTIVE');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    -- Who may use the SaaS Manager dashboard itself (NULL = nobody).
    CREATE TYPE saas_admin_role AS ENUM ('SUPER_ADMIN', 'ADMIN');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE outbox_status AS ENUM ('PENDING', 'DELIVERED', 'FAILED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- Shared trigger: keep updated_at honest without relying on app code
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- departments
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS departments (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    dept_name    varchar(150) NOT NULL,
    -- EMS MySQL departments.id. Lets a rename in EMS update this row instead
    -- of creating a duplicate. NULL for SaaS-only departments.
    ems_ref_id   integer UNIQUE,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_departments_name ON departments (lower(dept_name));
DROP TRIGGER IF EXISTS trg_departments_updated ON departments;
CREATE TRIGGER trg_departments_updated BEFORE UPDATE ON departments
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- designations
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS designations (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    designation_name  varchar(150) NOT NULL,
    ems_ref_id        integer UNIQUE,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_designations_name ON designations (lower(designation_name));
DROP TRIGGER IF EXISTS trg_designations_updated ON designations;
CREATE TRIGGER trg_designations_updated BEFORE UPDATE ON designations
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- portals (target applications)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS portals (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    portal_name     varchar(150) NOT NULL,
    -- Stable machine identifier; used as the JWT `aud` claim.
    portal_code     varchar(50)  NOT NULL UNIQUE
                    CHECK (portal_code ~ '^[A-Z0-9_]{2,50}$'),
    base_url        varchar(500),
    -- Where access-change events are POSTed. NULL = portal does not take
    -- push events (it must rely on short JWT TTL + /auth/introspect).
    webhook_url     varchar(500),
    -- HMAC secret shared with the portal to sign outgoing events.
    webhook_secret  varchar(255),
    is_enabled      boolean NOT NULL DEFAULT true,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);
DROP TRIGGER IF EXISTS trg_portals_updated ON portals;
CREATE TRIGGER trg_portals_updated BEFORE UPDATE ON portals
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- portal_roles — each portal's own role catalogue (independent of EMS roles)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS portal_roles (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    portal_id    uuid NOT NULL REFERENCES portals (id) ON DELETE CASCADE,
    role_code    varchar(50)  NOT NULL CHECK (role_code ~ '^[A-Z0-9_]{2,50}$'),
    role_name    varchar(100) NOT NULL,
    -- e.g. ["content.read","content.write"]; copied into the portal JWT.
    permissions  jsonb NOT NULL DEFAULT '[]'::jsonb
                 CHECK (jsonb_typeof(permissions) = 'array'),
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT ux_portal_roles_code UNIQUE (portal_id, role_code)
);
DROP TRIGGER IF EXISTS trg_portal_roles_updated ON portal_roles;
CREATE TRIGGER trg_portal_roles_updated BEFORE UPDATE ON portal_roles
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- saas_users
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS saas_users (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    -- EMS users.id (== employees.id in the HRMS). NULL for DIRECT_SAAS users.
    ems_user_id       integer UNIQUE,
    source            user_source NOT NULL,
    full_name         varchar(200) NOT NULL,
    email             varchar(255) NOT NULL,
    -- bcrypt. NULL means the user cannot log in with a password yet.
    password_hash     varchar(255),
    department_id     uuid REFERENCES departments (id)  ON DELETE SET NULL,
    designation_id    uuid REFERENCES designations (id) ON DELETE SET NULL,
    -- Human-readable deployment, e.g. "Project Apollo, Project Zeus".
    deployed_project  varchar(500),
    deployed_location varchar(200),
    -- EMS native role (Spatie role name). Informational only: it never
    -- grants anything on a target portal.
    ems_role_name     varchar(100),
    staff_id          varchar(50),
    status            account_status NOT NULL DEFAULT 'ACTIVE',
    saas_admin_role   saas_admin_role,
    -- Sync bookkeeping: ignore EMS events older than what we already applied,
    -- and skip writes when nothing changed.
    ems_source_ts     timestamptz,
    ems_payload_hash  char(64),
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),

    -- Source and ems_user_id must agree.
    CONSTRAINT ck_saas_users_source CHECK (
        (source = 'EMS'         AND ems_user_id IS NOT NULL) OR
        (source = 'DIRECT_SAAS' AND ems_user_id IS NULL)
    ),
    CONSTRAINT ck_saas_users_email CHECK (email = lower(email) AND position('@' IN email) > 1)
);
-- Emails are stored lower-cased (see CHECK above), so a plain unique index works.
CREATE UNIQUE INDEX IF NOT EXISTS ux_saas_users_email     ON saas_users (email);
CREATE INDEX        IF NOT EXISTS ix_saas_users_department ON saas_users (department_id);
CREATE INDEX        IF NOT EXISTS ix_saas_users_designation ON saas_users (designation_id);
CREATE INDEX        IF NOT EXISTS ix_saas_users_source_status ON saas_users (source, status);
CREATE INDEX        IF NOT EXISTS ix_saas_users_name ON saas_users (lower(full_name));
DROP TRIGGER IF EXISTS trg_saas_users_updated ON saas_users;
CREATE TRIGGER trg_saas_users_updated BEFORE UPDATE ON saas_users
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- user_portal_access
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_portal_access (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id               uuid NOT NULL REFERENCES saas_users (id) ON DELETE CASCADE,
    portal_id             uuid NOT NULL REFERENCES portals (id)    ON DELETE CASCADE,
    assigned_portal_role  varchar(50) NOT NULL,
    is_active             boolean NOT NULL DEFAULT true,
    -- Bumped on every change. Embedded in portal JWTs as `ver`, so a portal
    -- can reject tokens minted before a revocation.
    access_version        integer NOT NULL DEFAULT 1,
    granted_by            uuid REFERENCES saas_users (id) ON DELETE SET NULL,
    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT ux_user_portal UNIQUE (user_id, portal_id),
    -- Role must exist in THIS portal's catalogue.
    CONSTRAINT fk_access_portal_role FOREIGN KEY (portal_id, assigned_portal_role)
        REFERENCES portal_roles (portal_id, role_code) ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS ix_access_portal_active ON user_portal_access (portal_id, is_active);
DROP TRIGGER IF EXISTS trg_user_portal_access_updated ON user_portal_access;
CREATE TRIGGER trg_user_portal_access_updated BEFORE UPDATE ON user_portal_access
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- portal_sync_events — transactional outbox for target-portal webhooks
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS portal_sync_events (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    portal_id        uuid NOT NULL REFERENCES portals (id) ON DELETE CASCADE,
    user_id          uuid REFERENCES saas_users (id) ON DELETE SET NULL,
    event_type       varchar(60) NOT NULL,
    payload          jsonb NOT NULL,
    status           outbox_status NOT NULL DEFAULT 'PENDING',
    attempts         integer NOT NULL DEFAULT 0,
    next_attempt_at  timestamptz NOT NULL DEFAULT now(),
    last_error       text,
    delivered_at     timestamptz,
    created_at       timestamptz NOT NULL DEFAULT now()
);
-- The dispatcher only ever scans due PENDING rows.
CREATE INDEX IF NOT EXISTS ix_outbox_due ON portal_sync_events (next_attempt_at)
    WHERE status = 'PENDING';
CREATE INDEX IF NOT EXISTS ix_outbox_user ON portal_sync_events (user_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- audit_log — who changed what (dashboard actions and EMS syncs)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_log (
    id          bigserial PRIMARY KEY,
    actor_id    uuid REFERENCES saas_users (id) ON DELETE SET NULL,
    actor_label varchar(100) NOT NULL,          -- 'EMS_WEBHOOK', admin email, ...
    action      varchar(60)  NOT NULL,
    target_user uuid REFERENCES saas_users (id) ON DELETE SET NULL,
    details     jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_audit_target ON audit_log (target_user, created_at DESC);

-- ---------------------------------------------------------------------------
-- Schema bookkeeping for scripts/migrate.js
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS schema_migrations (
    filename    varchar(255) PRIMARY KEY,
    applied_at  timestamptz NOT NULL DEFAULT now()
);

COMMIT;
