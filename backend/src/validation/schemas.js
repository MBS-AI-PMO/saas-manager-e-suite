/**
 * Request body schemas (zod). These are the wire contracts:
 *   - emsWebhookSchema       EMS (Laravel) -> SaaS
 *   - createUserSchema       Dashboard -> SaaS (DIRECT_SAAS users)
 *   - portalAccessSchema     Dashboard -> SaaS (status / role changes)
 *   - portalTokenSchema      User/portal -> SaaS (JWT issuance)
 */
import { z } from 'zod';

const email = z.string().trim().toLowerCase().email().max(255);
const code = z.string().trim().toUpperCase().regex(/^[A-Z0-9_]{2,50}$/, 'Must be 2-50 chars of A-Z, 0-9, _');
const emsRef = z
  .object({ ems_id: z.number().int().positive(), name: z.string().trim().min(1).max(150) })
  .nullable()
  .optional();

// ---------------------------------------------------------------------------
// EMS -> SaaS
// ---------------------------------------------------------------------------

/** One user record as produced by HRMS App\Services\Saas\EmsUserPayloadBuilder. */
export const emsUserSchema = z.object({
  ems_user_id: z.number().int().positive(),
  staff_id: z.string().trim().max(50).nullable().optional(),
  full_name: z.string().trim().min(1).max(200),
  email,
  is_active: z.boolean(),
  department: emsRef,
  designation: emsRef,
  deployed_projects: z
    .array(z.object({ ems_id: z.number().int().positive(), title: z.string().trim().min(1).max(200), is_lead: z.boolean() }))
    .max(100)
    .default([]),
  deployed_location: emsRef,
  ems_role: emsRef,
  // Laravel bcrypt hash ($2y$...). Optional: only sent when the HRMS opts in.
  password_hash: z
    .string()
    .regex(/^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/, 'Not a bcrypt hash')
    .nullable()
    .optional(),
});

export const emsWebhookSchema = z.discriminatedUnion('event', [
  z.object({
    event_id: z.string().uuid(),
    event: z.literal('user.upserted'),
    occurred_at: z.string().datetime({ offset: true }),
    data: z.object({ users: z.array(emsUserSchema).min(1).max(200) }),
  }),
  z.object({
    event_id: z.string().uuid(),
    event: z.literal('roles.synced'),
    occurred_at: z.string().datetime({ offset: true }),
    // The complete EMS role catalogue (Spatie roles).
    data: z.object({
      roles: z.array(z.object({ ems_id: z.number().int().positive(), name: z.string().trim().min(1).max(100) })).max(500),
    }),
  }),
  z.object({
    event_id: z.string().uuid(),
    event: z.literal('user.deleted'),
    occurred_at: z.string().datetime({ offset: true }),
    data: z.object({ ems_user_ids: z.array(z.number().int().positive()).min(1).max(500) }),
  }),
]);

// ---------------------------------------------------------------------------
// Dashboard -> SaaS
// ---------------------------------------------------------------------------

const initialAccess = z.object({
  portal_code: code,
  role_code: code,
  is_active: z.boolean().default(true),
});

export const createUserSchema = z.object({
  full_name: z.string().trim().min(2).max(200),
  email,
  // Optional: omit to create the identity first and set a password later.
  password: z.string().min(10, 'Password must be at least 10 characters').max(128).optional(),
  department_id: z.string().uuid().nullable().optional(),
  designation_id: z.string().uuid().nullable().optional(),
  deployed_project: z.string().trim().max(500).nullable().optional(),
  deployed_location: z.string().trim().max(200).nullable().optional(),
  portal_access: z.array(initialAccess).max(50).default([]),
});

export const portalAccessSchema = z
  .object({
    user_id: z.string().uuid(),
    portal_code: code,
    is_active: z.boolean().optional(),
    role_code: code.optional(),
    // Optimistic concurrency: if supplied and stale, the API returns 409 so
    // two admins cannot silently overwrite each other.
    expected_version: z.number().int().positive().optional(),
  })
  .refine((b) => b.is_active !== undefined || b.role_code !== undefined, {
    message: 'Provide is_active and/or role_code',
  });

export const listUsersQuerySchema = z.object({
  search: z.string().trim().max(100).optional(),
  source: z.enum(['EMS', 'DIRECT_SAAS']).optional(),
  status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
  department_id: z.string().uuid().optional(),
  // Per-portal access view, e.g. ?portal_code=HR_PORTAL&access=active
  portal_code: code.optional(),
  access: z.enum(['any', 'granted', 'active', 'inactive', 'none']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(200).default(50),
});

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export const adminLoginSchema = z.object({
  email,
  password: z.string().min(1).max(128),
});

export const portalTokenSchema = z.object({
  email,
  password: z.string().min(1).max(128),
  portal_code: code,
});

export const introspectSchema = z.object({
  token: z.string().min(20).max(8192),
});

// ---------------------------------------------------------------------------
// Portal administration
// ---------------------------------------------------------------------------

const url = z.string().trim().url().max(500);
const permissions = z.array(z.string().trim().min(1).max(100)).max(200).default([]);

export const portalRoleSchema = z.object({
  role_code: code,
  role_name: z.string().trim().min(1).max(100),
  permissions,
});

export const createPortalSchema = z
  .object({
    portal_name: z.string().trim().min(2).max(150),
    portal_code: code,
    base_url: url.nullable().optional(),
    webhook_url: url.nullable().optional(),
    // SAAS: roles defined below. EMS: roles mirror the EMS roles (e.g. the HRMS).
    // PORTAL: roles are fetched from the portal's own roles_url.
    role_source: z.enum(['SAAS', 'EMS', 'PORTAL']).default('SAAS'),
    roles_url: url.nullable().optional(),
    // Give every EMS user this role automatically (must be one of `roles`).
    auto_grant_role: code.nullable().optional(),
    // EMS-sourced portals: fallback role for auto-assign, by EMS role id.
    auto_grant_ems_role_id: z.number().int().positive().nullable().optional(),
    roles: z.array(portalRoleSchema).max(50).default([]),
  })
  .refine((b) => b.role_source !== 'SAAS' || b.roles.length > 0, { message: 'Add at least one role', path: ['roles'] })
  .refine((b) => b.role_source !== 'PORTAL' || Boolean(b.roles_url), { message: 'Enter the roles URL', path: ['roles_url'] });

export const updatePortalSchema = z
  .object({
    portal_name: z.string().trim().min(2).max(150).optional(),
    base_url: url.nullable().optional(),
    webhook_url: url.nullable().optional(),
    is_enabled: z.boolean().optional(),
    auto_grant_role: code.nullable().optional(),
    role_source: z.enum(['SAAS', 'EMS', 'PORTAL']).optional(),
    roles_url: url.nullable().optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: 'Nothing to update' });

export const updatePortalRoleSchema = z
  .object({
    role_name: z.string().trim().min(1).max(100).optional(),
    permissions: z.array(z.string().trim().min(1).max(100)).max(200).optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: 'Nothing to update' });

export const bulkAccessSchema = z
  .object({
    user_ids: z.array(z.string().uuid()).min(1).max(500),
    is_active: z.boolean().optional(),
    // Required for users who have no access row on this portal yet.
    role_code: code.optional(),
  })
  .refine((b) => b.is_active !== undefined || b.role_code !== undefined, {
    message: 'Provide is_active and/or role_code',
  });
