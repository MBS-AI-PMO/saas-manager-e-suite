/**
 * Normalised lookups (departments, designations).
 *
 * EMS references arrive as { ems_id, name }. Resolution order:
 *   1. Row already linked to this ems_id   -> keep it, follow EMS renames.
 *   2. Unlinked row with the same name     -> link it (adopts a SaaS-created row).
 *   3. Otherwise                           -> insert a new linked row.
 */

const TABLES = {
  department: { table: 'departments', nameCol: 'dept_name' },
  designation: { table: 'designations', nameCol: 'designation_name' },
};

/**
 * @param {import('pg').PoolClient} client
 * @param {'department'|'designation'} kind
 * @param {{ ems_id: number, name: string } | null | undefined} ref
 * @returns {Promise<string|null>} uuid of the resolved row
 */
export async function resolveEmsLookup(client, kind, ref) {
  if (!ref) return null;
  const { table, nameCol } = TABLES[kind];

  // 1. Already linked
  const linked = await client.query(`SELECT id, ${nameCol} AS name FROM ${table} WHERE ems_ref_id = $1`, [ref.ems_id]);
  if (linked.rows[0]) {
    const row = linked.rows[0];
    if (row.name !== ref.name) {
      // EMS renamed it. If another row already holds the new name, keep the
      // old name rather than violate the unique index; the link still works.
      await client.query(
        `UPDATE ${table} SET ${nameCol} = $2
          WHERE id = $1
            AND NOT EXISTS (SELECT 1 FROM ${table} WHERE lower(${nameCol}) = lower($2) AND id <> $1)`,
        [row.id, ref.name],
      );
    }
    return row.id;
  }

  // 2. Same name, not linked to anything in EMS yet
  const byName = await client.query(
    `UPDATE ${table} SET ems_ref_id = $1
      WHERE lower(${nameCol}) = lower($2) AND ems_ref_id IS NULL
  RETURNING id`,
    [ref.ems_id, ref.name],
  );
  if (byName.rows[0]) return byName.rows[0].id;

  // 3. New. EMS lookups are company-scoped, so two companies can both have
  //    "Engineering". If the name is already linked to a different ems_id,
  //    disambiguate instead of violating the unique name index.
  const taken = await client.query(`SELECT 1 FROM ${table} WHERE lower(${nameCol}) = lower($1)`, [ref.name]);
  const name = taken.rows[0] ? `${ref.name} (EMS #${ref.ems_id})` : ref.name;

  // ON CONFLICT covers a concurrent webhook inserting the same ems_id.
  const inserted = await client.query(
    `INSERT INTO ${table} (${nameCol}, ems_ref_id) VALUES ($1, $2)
     ON CONFLICT (ems_ref_id) DO UPDATE SET ems_ref_id = EXCLUDED.ems_ref_id
     RETURNING id`,
    [name, ref.ems_id],
  );
  return inserted.rows[0].id;
}

export async function listDepartments(client) {
  const { rows } = await client.query('SELECT id, dept_name, ems_ref_id FROM departments ORDER BY dept_name');
  return rows;
}

export async function listDesignations(client) {
  const { rows } = await client.query(
    'SELECT id, designation_name, ems_ref_id FROM designations ORDER BY designation_name',
  );
  return rows;
}
