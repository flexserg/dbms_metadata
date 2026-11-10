import { readFileSync } from "node:fs";

export async function initializeStorage(pool) {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    await db.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('metadata-storage-schema',0))",
    );
    const legacy = (
      await db.query(
        `SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='metadata_snapshots' AND column_name='payload'`,
      )
    ).rowCount;
    if (legacy)
      throw new Error(
        "Relational storage requires a clean database. Legacy JSONB snapshots are not migrated; use a new backing database.",
      );
    await db.query(
      readFileSync(new URL("./schema.sql", import.meta.url), "utf8"),
    );
    await db.query("COMMIT");
  } catch (e) {
    await db.query("ROLLBACK");
    throw e;
  } finally {
    db.release();
  }
}
// JSON is used only as a batched transport parameter. Every value is inserted
// into a typed relational column; no serialized current-state document is saved.
async function insertRows(db, table, rows) {
  if (!rows.length) return;
  const columns = Object.keys(rows[0])
    .map((k) => '"' + k + '"')
    .join(",");
  for (let n = 0; n < rows.length; n += 500)
    await db.query(
      `INSERT INTO ${table}(${columns}) SELECT ${columns} FROM jsonb_populate_recordset(NULL::${table},$1::jsonb)`,
      [JSON.stringify(rows.slice(n, n + 500))],
    );
}
const field = (r) => ({
  position: r.position,
  name: r.name,
  type_id: r.type_id,
  formatted_type: r.type,
  nullable: r.nullable,
  default_expression: r.default ?? null,
  identity_kind: r.identity || "",
  identity_seed: r.identity_seed ?? null,
  identity_increment: r.identity_increment ?? null,
  generated_kind: r.generated || "",
  comment: r.comment ?? null,
});
export async function writeSnapshot(db, id, job, s) {
  const o = s.overview;
  await db.query(
    `INSERT INTO metadata_snapshots(connection_id,job_id,database_name,username,server_version,database_size,schema_count,object_count)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(connection_id) DO UPDATE SET job_id=EXCLUDED.job_id,captured_at=now(),
    database_name=EXCLUDED.database_name,username=EXCLUDED.username,server_version=EXCLUDED.server_version,database_size=EXCLUDED.database_size,schema_count=EXCLUDED.schema_count,object_count=EXCLUDED.object_count`,
    [id, job, o.database, o.username, o.version, o.size, o.schemas, o.objects],
  );
  // This replacement and its history are published in one transaction. Readers
  // use repeatable read and continue to see the complete prior state until commit.
  await db.query("DELETE FROM metadata_schemas WHERE connection_id=$1", [id]);
  const schemaIds = new Map(s.schemas.map((x) => [x.name, x.id]));
  await insertRows(
    db,
    "metadata_schemas",
    s.schemas.map((r) => ({
      connection_id: id,
      id: r.id,
      name: r.name,
      owner: r.owner,
      comment: r.comment,
      is_system: r.is_system,
    })),
  );
  await insertRows(
    db,
    "metadata_relations",
    s.relations.map((r) => ({
      connection_id: id,
      id: r.id,
      schema_id: schemaIds.get(r.schema),
      name: r.name,
      kind: r.kind,
      relkind: r.relkind,
      owner: r.owner,
      comment: r.comment,
      estimated_rows: r.estimated_rows,
      size: r.size,
      definition: r.definition,
    })),
  );
  await insertRows(
    db,
    "metadata_types",
    s.types.map((t) => ({
      connection_id: id,
      id: t.id,
      schema_id: schemaIds.get(t.schema),
      name: t.name,
      formatted_type: t.type,
      kind: t.kind,
      relation_kind: t.relation_kind,
      source_relation_oid: t.relation_id || null,
      element_type_id: t.element_type_id,
      base_type_id: t.base_type_id,
      comment: t.comment,
    })),
  );
  await insertRows(
    db,
    "metadata_columns",
    s.relations.flatMap((r) =>
      r.columns.map((c) => ({
        connection_id: id,
        table_id: r.id,
        ...field(c),
      })),
    ),
  );
  await insertRows(
    db,
    "metadata_type_attributes",
    s.types.flatMap((t) =>
      t.attributes.map((a) => ({
        connection_id: id,
        owner_type_id: t.id,
        ...field(a),
      })),
    ),
  );
  await insertRows(
    db,
    "metadata_inheritance",
    s.relations.flatMap((r) =>
      (r.parent_ids || []).map((p, i) => ({
        connection_id: id,
        child_id: r.id,
        parent_id: p,
        ordinal: i + 1,
      })),
    ),
  );
  const relations = new Map(s.relations.map((r) => [r.id, r]));
  await insertRows(
    db,
    "metadata_constraints",
    s.relations.flatMap((r) =>
      r.constraints.map((k) => ({
        connection_id: id,
        table_id: r.id,
        id: k.id,
        name: k.name,
        type: k.type,
        definition: k.definition,
        referenced_table_id: k.referenced_table_id,
        on_delete: k.on_delete,
        on_update: k.on_update,
        condition: k.condition,
        validated: k.validated,
        enabled: k.enabled ?? true,
        deferrable: k.deferrable,
        initially_deferred: k.initially_deferred,
        comment: k.comment,
      })),
    ),
  );
  await insertRows(
    db,
    "metadata_constraint_columns",
    s.relations.flatMap((r) =>
      r.constraints.flatMap((k) =>
        k.attributes.map((name, i) => ({
          connection_id: id,
          constraint_id: k.id,
          table_id: r.id,
          ordinal: i + 1,
          column_position: r.columns.find((c) => c.name === name)?.position,
          referenced_table_id: k.referenced_table_id,
          referenced_column_position: k.referenced_table_id
            ? relations
                .get(k.referenced_table_id)
                ?.columns.find((c) => c.name === k.referenced_attributes[i])
                ?.position
            : null,
        })),
      ),
    ),
  );
  await insertRows(
    db,
    "metadata_indexes",
    s.relations.flatMap((r) =>
      r.indexes.map((i) => ({
        connection_id: id,
        table_id: r.id,
        id: i.id,
        name: i.name,
        method: i.type,
        is_unique: i.unique,
        is_primary: i.primary,
        valid: i.valid,
        ready: i.ready,
        condition: i.condition,
        definition: i.definition,
        constraint_id:
          r.constraints.find((k) => k.name === i.constraint_name)?.id || null,
      })),
    ),
  );
  await insertRows(
    db,
    "metadata_index_attributes",
    s.relations.flatMap((r) =>
      r.indexes.flatMap((i) =>
        [
          ...i.attributes.map((expression) => ({
            expression,
            included: false,
          })),
          ...i.included_attributes.map((expression) => ({
            expression,
            included: true,
          })),
        ].map((a, n) => ({
          connection_id: id,
          index_id: i.id,
          ordinal: n + 1,
          ...a,
        })),
      ),
    ),
  );
  const partitions = new Map();
  for (const r of s.relations)
    for (const p of r.partitions) partitions.set(p.id, p);
  await insertRows(
    db,
    "metadata_partitions",
    [...partitions.values()].map((p) => ({
      connection_id: id,
      table_id: p.id,
      method: p.method,
      partition_key: p.partition_key,
      bounds: p.bounds,
    })),
  );
  await insertRows(
    db,
    "metadata_routines",
    s.routines.map((r) => ({
      connection_id: id,
      id: r.id,
      schema_id: schemaIds.get(r.schema),
      name: r.name,
      kind: r.kind,
      arguments: r.arguments,
      result: r.result,
      language: r.language,
      definition: r.definition,
    })),
  );
  await insertRows(
    db,
    "metadata_sqlserver_partitions",
    s.relations.flatMap((r) =>
      (r.sqlserver_partitions || []).map((p) => ({
        connection_id: id,
        table_id: r.id,
        ...p,
      })),
    ),
  );
}
export async function logicalKeys(db, id) {
  return (
    await db.query(
      `SELECT k.table_id::text,k.name,COALESCE(array_agg(c.column_position ORDER BY c.ordinal) FILTER(WHERE c.ordinal IS NOT NULL),'{}'::integer[]) AS positions
    FROM metadata_logical_keys k LEFT JOIN metadata_logical_key_columns c USING(connection_id,table_id) WHERE k.connection_id=$1 GROUP BY k.table_id,k.name`,
      [id],
    )
  ).rows;
}
export async function replaceLogicalKey(db, id, tableId, input) {
  await db.query(
    "DELETE FROM metadata_logical_keys WHERE connection_id=$1 AND table_id=$2",
    [id, tableId],
  );
  if (input !== null) {
    await db.query(
      "INSERT INTO metadata_logical_keys(connection_id,table_id,name) VALUES($1,$2,$3)",
      [id, tableId, input.name.trim()],
    );
    await insertRows(
      db,
      "metadata_logical_key_columns",
      input.positions.map((p, i) => ({
        connection_id: id,
        table_id: tableId,
        ordinal: i + 1,
        column_position: p,
      })),
    );
  }
}
export function applyLogicalKeys(snapshot, keys) {
  for (const r of snapshot.relations)
    r.logical_keys = keys
      .filter((k) => k.table_id === r.id)
      .map((k) => ({
        name: k.name,
        type: "logical_primary",
        positions: k.positions,
        attributes: k.positions.map(
          (p) =>
            r.columns.find((c) => c.position === p)?.name ??
            `Missing column #${p}`,
        ),
        status: k.positions.every((p) =>
          r.columns.some((c) => c.position === p),
        )
          ? "Defined in platform"
          : "Invalid: source column removed",
      }));
}
const schemaSQL = `SELECT id::text,name,owner,comment,is_system FROM metadata_schemas WHERE connection_id=$1 ORDER BY name`;
const relationSQL = `SELECT r.id::text,s.name AS schema,r.name,r.kind,r.relkind,r.owner,r.comment,r.estimated_rows::text,r.size::text,r.definition,
  COALESCE((SELECT array_agg(i.parent_id::text ORDER BY i.ordinal) FROM metadata_inheritance i WHERE i.connection_id=r.connection_id AND i.child_id=r.id),'{}'::text[]) AS parent_ids,
  (SELECT i.parent_id::text FROM metadata_inheritance i WHERE i.connection_id=r.connection_id AND i.child_id=r.id ORDER BY i.ordinal LIMIT 1) AS parent_id
  FROM metadata_relations r JOIN metadata_schemas s ON s.connection_id=r.connection_id AND s.id=r.schema_id WHERE r.connection_id=$1`;
const columnSQL = `SELECT c.table_id::text,c.position,c.name,c.type_id::text,c.formatted_type AS type,c.nullable,c.default_expression AS default,c.identity_kind AS identity,c.identity_seed,c.identity_increment,c.generated_kind AS generated,c.comment,
  EXISTS(SELECT 1 FROM metadata_constraints k JOIN metadata_constraint_columns a ON a.connection_id=k.connection_id AND a.constraint_id=k.id
    WHERE k.connection_id=c.connection_id AND k.table_id=c.table_id AND k.type='p' AND a.column_position=c.position) AS primary_key
  FROM metadata_columns c WHERE c.connection_id=$1`;
const constraintSQL = `SELECT k.id::text,k.table_id::text,k.name,k.type,k.definition,k.referenced_table_id::text,
  CASE WHEN ref.id IS NOT NULL THEN CASE WHEN profile.engine='mssql' THEN '['||replace(ns.name,']',']]')||'].['||replace(ref.name,']',']]')||']' ELSE quote_ident(ns.name)||'.'||quote_ident(ref.name) END END AS referenced_table,
  k.on_delete,k.on_update,k.condition,k.validated,k.enabled,k.deferrable,k.initially_deferred,k.comment,
  CASE WHEN profile.engine='mssql' THEN CASE WHEN NOT k.enabled THEN 'Disabled' WHEN k.validated THEN 'Enabled' ELSE 'Enabled / not trusted' END ELSE CASE WHEN k.validated THEN 'Validated' ELSE 'Not validated' END END AS status,
  ARRAY(SELECT c.name FROM metadata_constraint_columns a JOIN metadata_columns c ON c.connection_id=a.connection_id AND c.table_id=a.table_id AND c.position=a.column_position WHERE a.connection_id=k.connection_id AND a.constraint_id=k.id ORDER BY a.ordinal) AS attributes,
  ARRAY(SELECT c.name FROM metadata_constraint_columns a JOIN metadata_columns c ON c.connection_id=a.connection_id AND c.table_id=a.referenced_table_id AND c.position=a.referenced_column_position WHERE a.connection_id=k.connection_id AND a.constraint_id=k.id ORDER BY a.ordinal) AS referenced_attributes
  FROM metadata_constraints k JOIN metadata_connections profile ON profile.id=k.connection_id LEFT JOIN metadata_relations ref ON ref.connection_id=k.connection_id AND ref.id=k.referenced_table_id LEFT JOIN metadata_schemas ns ON ns.connection_id=ref.connection_id AND ns.id=ref.schema_id WHERE k.connection_id=$1`;
const indexSQL = `SELECT i.id::text,i.table_id::text,i.name,i.method AS type,i.is_unique AS unique,i.is_primary AS primary,i.valid,i.ready,i.condition,i.definition,k.name AS constraint_name,
  ARRAY(SELECT a.expression FROM metadata_index_attributes a WHERE a.connection_id=i.connection_id AND a.index_id=i.id AND NOT a.included ORDER BY a.ordinal) AS attributes,
  ARRAY(SELECT a.expression FROM metadata_index_attributes a WHERE a.connection_id=i.connection_id AND a.index_id=i.id AND a.included ORDER BY a.ordinal) AS included_attributes
  FROM metadata_indexes i LEFT JOIN metadata_constraints k ON k.connection_id=i.connection_id AND k.id=i.constraint_id WHERE i.connection_id=$1`;
const routineSQL = `SELECT r.id::text,s.name AS schema,r.name,r.kind,r.arguments,r.result,r.language,r.definition FROM metadata_routines r JOIN metadata_schemas s ON s.connection_id=r.connection_id AND s.id=r.schema_id WHERE r.connection_id=$1`;
async function readTypes(db, id, roots = null) {
  const needed = roots
    ? `WITH RECURSIVE needed(id) AS (SELECT unnest($2::bigint[]) UNION
    SELECT ref.id FROM needed d JOIN metadata_types t ON t.connection_id=$1 AND t.id=d.id CROSS JOIN LATERAL
      (SELECT t.base_type_id AS id UNION SELECT t.element_type_id UNION SELECT a.type_id FROM metadata_type_attributes a WHERE a.connection_id=$1 AND a.owner_type_id=t.id) ref WHERE ref.id IS NOT NULL)`
    : "";
  const values = roots ? [id, roots] : [id];
  const types = (
    await db.query(
      `${needed} SELECT t.id::text,s.name AS schema,t.name,t.formatted_type AS type,t.kind,t.relation_kind,t.source_relation_oid::text AS relation_id,t.element_type_id::text,t.base_type_id::text,t.comment
    FROM metadata_types t JOIN metadata_schemas s ON s.connection_id=t.connection_id AND s.id=t.schema_id WHERE t.connection_id=$1 ${roots ? "AND t.id IN (SELECT id FROM needed)" : ""} ORDER BY s.name,t.name`,
      values,
    )
  ).rows;
  const fields = (
    await db.query(
      `SELECT owner_type_id::text,position,name,type_id::text,formatted_type AS type,nullable,default_expression AS default,identity_kind AS identity,identity_seed,identity_increment,generated_kind AS generated,comment
    FROM metadata_type_attributes WHERE connection_id=$1 AND owner_type_id=ANY($2::bigint[]) ORDER BY owner_type_id,position`,
      [id, types.map((t) => t.id)],
    )
  ).rows;
  const byId = new Map(types.map((t) => [t.id, { ...t, attributes: [] }]));
  for (const { owner_type_id, ...a } of fields)
    byId.get(owner_type_id).attributes.push(a);
  return [...byId.values()];
}
async function hydrateRelations(db, id, relations) {
  const ids = relations.map((r) => r.id),
    filter = " AND c.table_id=ANY($2::bigint[])";
  const columns = (
    await db.query(columnSQL + filter + " ORDER BY c.position", [id, ids])
  ).rows;
  const physical = (
    await db.query(
      `SELECT table_id::text,partition_number,partition_id::text,function_name,scheme,boundary_on_right,lower_bound,upper_bound,filegroup,row_count::text FROM metadata_sqlserver_partitions WHERE connection_id=$1 AND table_id=ANY($2::bigint[]) ORDER BY partition_number`,
      [id, ids],
    )
  ).rows;
  const constraints = (
    await db.query(
      constraintSQL + " AND k.table_id=ANY($2::bigint[]) ORDER BY k.name",
      [id, ids],
    )
  ).rows;
  const indexes = (
    await db.query(
      indexSQL + " AND i.table_id=ANY($2::bigint[]) ORDER BY i.name",
      [id, ids],
    )
  ).rows;
  const allRelations = (await db.query(relationSQL, [id])).rows,
    byId = new Map(allRelations.map((r) => [r.id, r]));
  const partitions = (
    await db.query(
      `SELECT p.table_id::text,p.method,p.partition_key,p.bounds,
    CASE WHEN r.id IS NOT NULL THEN quote_ident(s.name)||'.'||quote_ident(r.name) END AS parent
    FROM metadata_partitions p LEFT JOIN metadata_inheritance i ON i.connection_id=p.connection_id AND i.child_id=p.table_id AND i.ordinal=1
    LEFT JOIN metadata_relations r ON r.connection_id=i.connection_id AND r.id=i.parent_id LEFT JOIN metadata_schemas s ON s.connection_id=r.connection_id AND s.id=r.schema_id
    WHERE p.connection_id=$1`,
      [id],
    )
  ).rows;
  const partitionMap = new Map(partitions.map((p) => [p.table_id, p]));
  function ancestors(r) {
    const seen = new Set(),
      result = [];
    while (r?.parent_id && !seen.has(r.parent_id)) {
      seen.add(r.parent_id);
      result.push(r.parent_id);
      r = byId.get(r.parent_id);
    }
    return result;
  }
  for (const r of relations) {
    r.columns = columns
      .filter((c) => c.table_id === r.id)
      .map(({ table_id, ...c }) => c);
    r.constraints = constraints
      .filter((c) => c.table_id === r.id)
      .map(({ table_id, ...k }) => k);
    r.indexes = indexes
      .filter((i) => i.table_id === r.id)
      .map(({ table_id, ...i }) => i);
    r.partitions = [];
    function visit(node, level) {
      const p = partitionMap.get(node.id);
      if (!p) return;
      const parentPartition = partitionMap.get(node.parent_id);
      r.partitions.push({
        id: node.id,
        schema: node.schema,
        name: node.name,
        parent_id: node.parent_id,
        parent: p.parent,
        level,
        absolute_level: ancestors(node).length,
        method: p.method,
        partition_key: p.partition_key,
        parent_method: parentPartition?.method ?? null,
        parent_partition_key: parentPartition?.partition_key ?? null,
        bounds: p.bounds,
      });
      for (const child of allRelations)
        if (child.parent_id === node.id) visit(child, level + 1);
    }
    visit(r, 0);
    r.logical_keys = [];
    r.sqlserver_partitions = physical
      .filter((p) => p.table_id === r.id)
      .map(({ table_id, ...p }) => p);
  }
  applyLogicalKeys({ relations }, await logicalKeys(db, id));
  return relations;
}
async function snapshotHeader(db, id) {
  return (
    await db.query(
      `SELECT s.captured_at,s.job_id,s.database_name AS database,s.username,s.server_version AS version,s.database_size::text AS size,s.schema_count AS schemas,s.object_count AS objects,p.engine FROM metadata_snapshots s JOIN metadata_connections p ON p.id=s.connection_id WHERE s.connection_id=$1`,
      [id],
    )
  ).rows[0];
}
export async function readSnapshot(db, id) {
  const header = await snapshotHeader(db, id);
  if (!header) return null;
  const { captured_at, job_id, ...overview } = header;
  const schemas = (await db.query(schemaSQL, [id])).rows;
  const relations = await hydrateRelations(
    db,
    id,
    (await db.query(relationSQL + " ORDER BY s.name,r.name", [id])).rows,
  );
  for (const s of schemas)
    s.objects = relations.filter((r) => r.schema === s.name).length;
  return {
    overview,
    schemas,
    relations,
    routines: (
      await db.query(routineSQL + " ORDER BY s.name,r.name,r.id", [id])
    ).rows,
    types: await readTypes(db, id),
  };
}
export async function readResource(
  pool,
  id,
  resource,
  { schema = "public", oid } = {},
) {
  const db = await pool.connect();
  try {
    await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const header = await snapshotHeader(db, id);
    if (!header)
      throw Object.assign(
        new Error(
          "No saved snapshot yet. Run Refresh metadata to capture the source.",
        ),
        { status: 409 },
      );
    let result;
    if (resource === "snapshot")
      result = { captured_at: header.captured_at, job_id: header.job_id };
    else if (resource === "overview") {
      const { captured_at, job_id, ...o } = header;
      result = o;
    } else if (resource === "schemas")
      result = (
        await db.query(
          `SELECT s.id::text,s.name,s.owner,s.comment,(SELECT count(*)::int FROM metadata_relations r WHERE r.connection_id=s.connection_id AND r.schema_id=s.id) AS objects FROM metadata_schemas s WHERE s.connection_id=$1 AND NOT s.is_system ORDER BY s.name`,
          [id],
        )
      ).rows;
    else if (resource === "objects")
      result = (
        await db.query(relationSQL + " AND s.name=$2 ORDER BY r.name", [
          id,
          schema,
        ])
      ).rows;
    else if (resource === "routines")
      result = (
        await db.query(routineSQL + " AND s.name=$2 ORDER BY r.name,r.id", [
          id,
          schema,
        ])
      ).rows;
    else if (resource === "types") {
      const definitions = await readTypes(db, id);
      result = {
        definitions,
        types: definitions.filter(
          (t) =>
            t.kind === "c" && t.relation_kind === "c" && t.schema === schema,
        ),
      };
    } else if (resource === "detail") {
      if (!/^\d{1,10}$/.test(String(oid)))
        throw Object.assign(new Error("Invalid object ID"), { status: 400 });
      const rows = await hydrateRelations(
        db,
        id,
        (await db.query(relationSQL + " AND r.id=$2", [id, oid])).rows,
      );
      if (rows.length)
        result = {
          ...rows[0],
          types: await readTypes(
            db,
            id,
            rows[0].columns.map((c) => c.type_id),
          ),
        };
    }
    if (result === undefined)
      throw Object.assign(
        new Error("Object or resource not found in latest snapshot"),
        { status: 404 },
      );
    await db.query("COMMIT");
    return result;
  } catch (e) {
    await db.query("ROLLBACK");
    throw e;
  } finally {
    db.release();
  }
}
