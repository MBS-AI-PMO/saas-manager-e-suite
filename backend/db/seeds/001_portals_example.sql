-- Example target portals and their independent role catalogues.
-- Safe to re-run. Replace URLs/secrets with real values per environment.

INSERT INTO portals (portal_name, portal_code, base_url, webhook_url, webhook_secret) VALUES
    ('Content Portal',  'CONTENT',  'https://content.example.com',  'https://content.example.com/api/iam/events',  'change-me-content-secret'),
    ('Projects Portal', 'PROJECTS', 'https://projects.example.com', 'https://projects.example.com/iam/events',     'change-me-projects-secret')
ON CONFLICT (portal_code) DO NOTHING;

INSERT INTO portal_roles (portal_id, role_code, role_name, permissions)
SELECT p.id, r.role_code, r.role_name, r.permissions::jsonb
FROM portals p
JOIN (VALUES
    ('CONTENT',  'ADMIN',   'Admin',   '["content.read","content.write","content.publish","users.manage"]'),
    ('CONTENT',  'EDITOR',  'Editor',  '["content.read","content.write"]'),
    ('PROJECTS', 'MANAGER', 'Manager', '["project.read","project.write","report.view"]'),
    ('PROJECTS', 'VIEWER',  'Viewer',  '["project.read"]')
) AS r(portal_code, role_code, role_name, permissions) ON r.portal_code = p.portal_code
ON CONFLICT (portal_id, role_code) DO NOTHING;
