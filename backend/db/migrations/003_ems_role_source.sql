-- =============================================================================
-- Portals whose roles come from EMS.
--
-- A portal with role_source = 'EMS' (e.g. the HRMS itself) does not define its
-- own roles: its catalogue mirrors the EMS roles, each EMS user's role on it
-- follows their EMS role, and an admin's role change in the SaaS is written
-- back to EMS. Portals with role_source = 'SAAS' keep their own roles.
-- =============================================================================

BEGIN;

-- Latest EMS role catalogue (Spatie roles in the HRMS).
CREATE TABLE IF NOT EXISTS ems_roles (
    ems_id      integer PRIMARY KEY,
    role_name   varchar(100) NOT NULL,
    updated_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE portals ADD COLUMN IF NOT EXISTS role_source varchar(10) NOT NULL DEFAULT 'SAAS';
DO $$ BEGIN
    ALTER TABLE portals ADD CONSTRAINT ck_portals_role_source CHECK (role_source IN ('SAAS', 'EMS'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Which EMS role a mirrored portal role stands for.
ALTER TABLE portal_roles ADD COLUMN IF NOT EXISTS ems_role_id integer;
CREATE UNIQUE INDEX IF NOT EXISTS ux_portal_roles_ems ON portal_roles (portal_id, ems_role_id)
    WHERE ems_role_id IS NOT NULL;

-- The user's EMS role id (ems_role_name already exists).
ALTER TABLE saas_users ADD COLUMN IF NOT EXISTS ems_role_id integer;

-- Force the next EMS sync to rewrite every EMS user so ems_role_id gets filled.
UPDATE saas_users SET ems_payload_hash = NULL WHERE source = 'EMS' AND ems_role_id IS NULL;

COMMIT;
