// Object ownership is distinct from links to incoming foreign keys or ancestors.
export const historyScope = `WITH RECURSIVE descendants(id) AS (
  SELECT $2::text WHERE $2::text IS NOT NULL
  UNION SELECT e.child_id FROM metadata_history_edges e JOIN descendants d ON e.parent_id=d.id WHERE e.connection_id=$1
)`;
export const historyFilter = `c.connection_id=$1 AND ($2::text IS NULL OR
  CASE WHEN c.entity_type IN ('table','partition','logical_key') THEN c.entity_id IN (SELECT id FROM descendants)
  WHEN c.entity_type IN ('column','sqlserver_partition') THEN split_part(c.entity_id,':',1) IN (SELECT id FROM descendants)
  WHEN c.entity_type IN ('constraint','index') THEN c.table_ids[1] IN (SELECT id FROM descendants)
  WHEN c.entity_type IN ('composite_type','type_attribute') THEN c.table_ids && ARRAY(SELECT id FROM descendants)
  ELSE false END)`;
export async function rememberEdges(db, id, snapshot) {
  const edges = new Map();
  for (const r of snapshot.relations) {
    for (const parent of r.parent_ids || (r.parent_id ? [r.parent_id] : []))
      edges.set(`${parent}:${r.id}`, { parent_id: parent, child_id: r.id });
    for (const p of r.partitions)
      if (p.parent_id)
        edges.set(`${p.parent_id}:${p.id}`, {
          parent_id: p.parent_id,
          child_id: p.id,
        });
  }
  if (edges.size)
    await db.query(
      `INSERT INTO metadata_history_edges(connection_id,parent_id,child_id)
    SELECT $1,parent_id,child_id FROM jsonb_to_recordset($2) x(parent_id text,child_id text) ON CONFLICT DO NOTHING`,
      [id, JSON.stringify([...edges.values()])],
    );
}
export async function pruneHistory(pool) {
  return pool.query(`DELETE FROM metadata_changes c USING metadata_connections p,metadata_refresh_jobs j
    WHERE c.connection_id=p.id AND c.job_id=j.id AND p.history_retention_days>0
      AND COALESCE(j.finished_at,j.started_at)<now()-make_interval(days=>p.history_retention_days)`);
}
