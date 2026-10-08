-- =============================================================================
-- Roles fetched from the portal itself.
--
-- role_source = 'PORTAL': the SaaS reads the portal's role catalogue from
-- portals.roles_url (signed GET), on connect, on demand, and every 15
-- minutes; the portal may also push it (POST /api/v1/portal-sync/roles).
-- Each mirrored role keeps the portal's own id in external_role_id, which is
-- sent back to the portal in tokens and events.
-- =============================================================================

BEGIN;

ALTER TABLE portals DROP CONSTRAINT IF EXISTS ck_portals_role_source;
ALTER TABLE portals ADD CONSTRAINT ck_portals_role_source CHECK (role_source IN ('SAAS', 'EMS', 'PORTAL'));

ALTER TABLE portals ADD COLUMN IF NOT EXISTS roles_url        varchar(500);
ALTER TABLE portals ADD COLUMN IF NOT EXISTS roles_synced_at  timestamptz;
ALTER TABLE portals ADD COLUMN IF NOT EXISTS roles_sync_error text;

ALTER TABLE portal_roles ADD COLUMN IF NOT EXISTS external_role_id varchar(100);
CREATE UNIQUE INDEX IF NOT EXISTS ux_portal_roles_external ON portal_roles (portal_id, external_role_id)
    WHERE external_role_id IS NOT NULL;

COMMIT;
