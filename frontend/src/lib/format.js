/**
 * Small display helpers.
 */

export function initials(name = '') {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0].toUpperCase())
    .join('');
}

/** Stable hue per string, so a person keeps the same avatar colour. */
export function hueFor(text = '') {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) % 360;
  return h;
}

export function timeAgo(iso) {
  if (!iso) return 'never';
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d < 30 ? `${d} d ago` : new Date(iso).toLocaleDateString();
}

export const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Suggest a portal code from its name: "HR Portal" -> "HR_PORTAL". */
export function toCode(text = '') {
  return text
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 50);
}

/**
 * Human sentence for an audit_log row. `portals` (optional) turns codes such
 * as HR_PORTAL / HR_MANAGER into their display names.
 */
export function describeActivity(a, portals = []) {
  const raw = a.details ?? {};
  const portal = portals.find((p) => p.portal_code === raw.portal);
  const roleName = (code) => portal?.roles.find((r) => r.role_code === code)?.role_name ?? code;
  const d = {
    ...raw,
    portal: portal?.portal_name ?? raw.portal,
    role: roleName(raw.role),
    after: raw.after && { ...raw.after, role: roleName(raw.after.role) },
  };
  const who = a.target_name ?? d.email ?? 'a user';
  switch (a.action) {
    case 'PORTAL_ACCESS_CHANGED': {
      const after = d.after ?? {};
      if (!d.before) return `Granted ${who} ${after.role} on ${d.portal}`;
      if (d.before.is_active !== after.is_active) return `${after.is_active ? 'Activated' : 'Deactivated'} ${who} on ${d.portal}`;
      return `Changed ${who}'s role on ${d.portal} to ${after.role}`;
    }
    case 'DIRECT_USER_CREATED':
      return `Created Direct SaaS user ${who}`;
    case 'PORTAL_CREATED':
      return `Added portal ${d.portal}`;
    case 'PORTAL_UPDATED':
      return 'is_enabled' in (d.changes ?? {})
        ? `${d.changes.is_enabled ? 'Enabled' : 'Disabled'} portal ${d.portal}`
        : `Updated portal ${d.portal}`;
    case 'PORTAL_DELETED':
      return `Deleted portal ${d.portal}`;
    case 'PORTAL_SECRET_ROTATED':
      return `Rotated webhook secret for ${d.portal}`;
    case 'PORTAL_ROLE_ADDED':
      return `Added role ${d.role} to ${d.portal}`;
    case 'PORTAL_ROLE_UPDATED':
      return `Updated role ${d.role} on ${d.portal}`;
    case 'PORTAL_ROLE_DELETED':
      return `Removed role ${d.role} from ${d.portal}`;
    default:
      return a.action.toLowerCase().replace(/_/g, ' ');
  }
}
