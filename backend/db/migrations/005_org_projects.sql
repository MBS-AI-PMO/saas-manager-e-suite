-- =============================================================================
-- Project-based identities: companies, clients and projects from EMS.
--
-- EMS (the HRMS) is the source of truth for its organisation. It sends the full
-- catalogue (event org.synced) and, on every user, the user's company, client
-- and projects (as member, HR or Manager). The SaaS keeps them as real rows so
-- users can be filtered and created per project, and forwards them to portals
-- (Payroll needs company > client > project; Inventory needs projects).
--
-- Rows are never hard-deleted when EMS drops them: is_active goes false, so
-- history and links stay intact.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS companies (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    ems_ref_id  integer UNIQUE,
    name        varchar(200) NOT NULL,
    is_active   boolean NOT NULL DEFAULT true,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS clients (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    ems_ref_id  integer UNIQUE,
    name        varchar(200) NOT NULL,
    company_id  uuid REFERENCES companies (id) ON DELETE SET NULL,
    is_active   boolean NOT NULL DEFAULT true,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS projects (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    ems_ref_id  integer UNIQUE,
    title       varchar(200) NOT NULL,
    company_id  uuid REFERENCES companies (id) ON DELETE SET NULL,
    client_id   uuid REFERENCES clients (id) ON DELETE SET NULL,
    status      varchar(40),
    start_date  date,
    end_date    date,
    is_active   boolean NOT NULL DEFAULT true,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_projects_company ON projects (company_id);
CREATE INDEX IF NOT EXISTS ix_projects_client  ON projects (client_id);

-- A user can be on many projects: as a member, or as the project's HR / Manager.
CREATE TABLE IF NOT EXISTS user_projects (
    user_id       uuid NOT NULL REFERENCES saas_users (id) ON DELETE CASCADE,
    project_id    uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    project_role  varchar(20) NOT NULL DEFAULT 'member',
    created_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, project_id),
    CONSTRAINT ck_user_projects_role CHECK (project_role IN ('member', 'hr', 'manager'))
);
CREATE INDEX IF NOT EXISTS ix_user_projects_project ON user_projects (project_id);

-- The user's own company / client (the one they registered under in EMS) and
-- employment dates, forwarded to portals such as Payroll.
ALTER TABLE saas_users ADD COLUMN IF NOT EXISTS company_id   uuid REFERENCES companies (id) ON DELETE SET NULL;
ALTER TABLE saas_users ADD COLUMN IF NOT EXISTS client_id    uuid REFERENCES clients (id) ON DELETE SET NULL;
ALTER TABLE saas_users ADD COLUMN IF NOT EXISTS joining_date date;
ALTER TABLE saas_users ADD COLUMN IF NOT EXISTS exit_date    date;
ALTER TABLE saas_users ADD COLUMN IF NOT EXISTS phone        varchar(50);
CREATE INDEX IF NOT EXISTS ix_saas_users_company ON saas_users (company_id);

-- Portals that want organisation events (org.updated) — e.g. Payroll. Others
-- (Inventory) get projects inside each user's events only.
ALTER TABLE portals ADD COLUMN IF NOT EXISTS receive_org_events boolean NOT NULL DEFAULT false;

-- Last organisation catalogue received from EMS (one row), so an identical
-- re-send is recognised and costs nothing.
CREATE TABLE IF NOT EXISTS ems_org_state (
    id            smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    payload_hash  varchar(64),
    synced_at     timestamptz NOT NULL DEFAULT now()
);

-- Force the next EMS sync to rewrite every EMS user so company, client and
-- projects are filled.
UPDATE saas_users SET ems_payload_hash = NULL WHERE source = 'EMS';

COMMIT;
