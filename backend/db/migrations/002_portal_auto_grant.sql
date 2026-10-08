-- =============================================================================
-- Auto-assign: a portal can give every EMS user a default role automatically
-- (existing users when the setting is turned on, and every new EMS hire).
--
-- Used for portals that everyone should reach by default, such as the HRMS
-- itself, so turning on access control never locks the whole company out. The
-- admin then only deactivates the exceptions.
-- =============================================================================

BEGIN;

ALTER TABLE portals ADD COLUMN IF NOT EXISTS auto_grant_role varchar(50);

COMMENT ON COLUMN portals.auto_grant_role IS
    'When set, every EMS user gets this role (ACTIVE) on this portal automatically. Must be a role_code of this portal.';

COMMIT;
