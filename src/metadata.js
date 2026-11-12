import pg from "pg";
import { driverProperties } from "./connection-options.js";
export { validateConnection } from "./connection-options.js";

export async function withTarget(connection, action) {
  const properties = driverProperties("postgres", connection.driverProperties);
  const ca = connection.caCertificate || process.env.PG_TARGET_CA;
  const client = new pg.Client({
    ...properties,
    host: connection.host,
    port: connection.port,
    database: connection.database,
    user: connection.username,
    password: connection.password,
    ssl:
      connection.sslMode !== "disable"
        ? {
            rejectUnauthorized: connection.sslMode !== "require",
            ...(connection.sslMode === "verify-ca"
              ? { checkServerIdentity: () => undefined }
              : {}),
            ...(ca ? { ca } : {}),
          }
        : false,
    connectionTimeoutMillis: properties.connectionTimeoutMillis ?? 5000,
    query_timeout: properties.query_timeout ?? 10000,
    application_name: properties.application_name ?? "dbms_metadata",
    keepAlive: connection.keepAlive ?? true,
  });
  // A target can disappear while an HTTP request is in flight.
  client.on("error", () => {});
  try {
    await client.connect();
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await client.query("SELECT set_config('statement_timeout',$1,true)", [
      String(properties.statement_timeout ?? 8000),
    ]);
    const result = await action(client);
    await client.query("ROLLBACK");
    return result;
  } finally {
    await client.end().catch(() => {});
  }
}

export async function overview(client) {
  return (
    await client.query(`SELECT current_database() AS database, current_user AS username,
    current_setting('server_version') AS version, pg_database_size(current_database())::text AS size,
    (SELECT count(*)::int FROM pg_namespace WHERE nspname NOT LIKE 'pg_%' AND nspname <> 'information_schema') AS schemas,
    (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname <> 'information_schema' AND c.relkind IN ('r','p','v','m','f')) AS objects`)
  ).rows[0];
}
export async function schemas(client, includeSystem = false) {
  return (
    await client.query(
      `SELECT n.oid::text AS id, n.nspname AS name, pg_get_userbyid(n.nspowner) AS owner,
    obj_description(n.oid,'pg_namespace') AS comment, count(c.oid)::int AS objects,
    (n.nspname LIKE 'pg_%' OR n.nspname='information_schema') AS is_system
    FROM pg_namespace n LEFT JOIN pg_class c ON c.relnamespace=n.oid AND c.relkind IN ('r','p','v','m','f')
    WHERE ($1 OR (n.nspname NOT LIKE 'pg_%' AND n.nspname <> 'information_schema'))
    GROUP BY n.oid ORDER BY n.nspname`,
      [includeSystem],
    )
  ).rows;
}
export async function objects(client, schema) {
  return (
    await client.query(
      `SELECT c.oid::text AS id, c.relname AS name,
    CASE c.relkind WHEN 'r' THEN 'Table' WHEN 'p' THEN 'Partitioned table' WHEN 'v' THEN 'View' WHEN 'm' THEN 'Materialized view' WHEN 'f' THEN 'Foreign table' END AS kind,
    pg_get_userbyid(c.relowner) AS owner, c.reltuples::bigint::text AS estimated_rows,
    obj_description(c.oid,'pg_class') AS comment
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=$1 AND c.relkind IN ('r','p','v','m','f') ORDER BY c.relname`,
      [schema],
    )
  ).rows;
}
export async function routines(client, schema = null) {
  return (
    await client.query(
      `SELECT p.oid::text AS id, n.nspname AS schema, p.proname AS name,
    CASE p.prokind WHEN 'p' THEN 'Procedure' ELSE 'Function' END AS kind,
    pg_get_function_identity_arguments(p.oid) AS arguments,
    pg_get_function_result(p.oid) AS result, l.lanname AS language,
    pg_get_functiondef(p.oid) AS definition
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_language l ON l.oid=p.prolang
    WHERE ($1::text IS NULL OR n.nspname=$1) AND n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema'
      AND p.prokind IN ('f','p') ORDER BY n.nspname,p.proname,p.oid`,
      [schema],
    )
  ).rows;
}
export async function bulkRelations(client) {
  const relations = (
    await client.query(
      `SELECT c.oid::text AS id, n.nspname AS schema, c.relname AS name, c.relkind,
    CASE c.relkind WHEN 'r' THEN 'Table' WHEN 'p' THEN 'Partitioned table' WHEN 'v' THEN 'View' WHEN 'm' THEN 'Materialized view' WHEN 'f' THEN 'Foreign table' END AS kind,
    pg_get_userbyid(c.relowner) AS owner, obj_description(c.oid,'pg_class') AS comment,
    (SELECT inhparent::text FROM pg_inherits WHERE inhrelid=c.oid ORDER BY inhseqno LIMIT 1) AS parent_id,
    ARRAY(SELECT inhparent::text FROM pg_inherits WHERE inhrelid=c.oid ORDER BY inhseqno) AS parent_ids,
    c.reltuples::bigint::text AS estimated_rows,
    CASE WHEN c.relkind IN ('r','p','m') THEN pg_total_relation_size(c.oid)::text ELSE NULL END AS size,
    CASE WHEN c.relkind IN ('v','m') THEN pg_get_viewdef(c.oid,true) ELSE NULL END AS definition
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema' AND c.relkind IN ('r','p','v','m','f')
    ORDER BY n.nspname,c.relname`,
    )
  ).rows;
  const ids = relations.map((r) => r.id);
  const columns = (
    await client.query(
      `SELECT a.attrelid::text AS table_id,a.attnum AS position, a.attname AS name, a.atttypid::text AS type_id,
    format_type(a.atttypid,a.atttypmod) AS type, NOT a.attnotnull AS nullable,
    pg_get_expr(d.adbin,d.adrelid) AS default, col_description(a.attrelid,a.attnum) AS comment,
    a.attidentity AS identity, a.attgenerated AS generated,
    EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conrelid=a.attrelid AND k.contype='p' AND a.attnum=ANY(k.conkey)) AS primary_key
    FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    WHERE a.attrelid=ANY($1::oid[]) AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attrelid,a.attnum`,
      [ids],
    )
  ).rows;
  const constraints = (
    await client.query(
      `SELECT k.conrelid::text AS table_id,k.oid::text AS id, k.conname AS name, k.contype AS type,
       pg_get_constraintdef(k.oid,true) AS definition,
       ARRAY(SELECT a.attname::text FROM unnest(k.conkey) WITH ORDINALITY u(num,ord)
         JOIN pg_attribute a ON a.attrelid=k.conrelid AND a.attnum=u.num ORDER BY u.ord) AS attributes,
       CASE WHEN k.confrelid<>0 THEN k.confrelid::text END AS referenced_table_id,
       CASE WHEN k.confrelid<>0 THEN (SELECT quote_ident(n.nspname)||'.'||quote_ident(c.relname)
         FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.oid=k.confrelid) END AS referenced_table,
       ARRAY(SELECT a.attname::text FROM unnest(k.confkey) WITH ORDINALITY u(num,ord)
         JOIN pg_attribute a ON a.attrelid=k.confrelid AND a.attnum=u.num ORDER BY u.ord) AS referenced_attributes,
       CASE k.confdeltype WHEN 'a' THEN 'NO ACTION' WHEN 'r' THEN 'RESTRICT' WHEN 'c' THEN 'CASCADE' WHEN 'n' THEN 'SET NULL' WHEN 'd' THEN 'SET DEFAULT' END AS on_delete,
       CASE k.confupdtype WHEN 'a' THEN 'NO ACTION' WHEN 'r' THEN 'RESTRICT' WHEN 'c' THEN 'CASCADE' WHEN 'n' THEN 'SET NULL' WHEN 'd' THEN 'SET DEFAULT' END AS on_update,
       pg_get_expr(k.conbin,k.conrelid,true) AS condition,
       k.convalidated AS validated, true AS enabled, k.condeferrable AS deferrable, k.condeferred AS initially_deferred,
       CASE WHEN k.convalidated THEN 'Validated' ELSE 'Not validated' END AS status,
       obj_description(k.oid,'pg_constraint') AS comment
    FROM pg_constraint k WHERE k.conrelid=ANY($1::oid[]) ORDER BY k.conrelid,k.conname`,
      [ids],
    )
  ).rows;
  const indexes = (
    await client.query(
      `SELECT i.indrelid::text AS table_id,c.oid::text AS id, c.relname AS name, am.amname AS type,
       i.indisunique AS unique, i.indisprimary AS primary, i.indisvalid AS valid, i.indisready AS ready,
       (to_jsonb(i)->>'indnullsnotdistinct')::boolean AS nulls_not_distinct,
       ARRAY(SELECT pg_get_indexdef(i.indexrelid,s,true) FROM generate_series(1,i.indnkeyatts) s) AS attributes,
       ARRAY(SELECT pg_get_indexdef(i.indexrelid,s,true) FROM generate_series(i.indnkeyatts+1,i.indnatts) s) AS included_attributes,
       pg_get_expr(i.indpred,i.indrelid,true) AS condition, k.conname AS constraint_name,
       pg_get_indexdef(i.indexrelid) AS definition FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
       JOIN pg_am am ON am.oid=c.relam LEFT JOIN pg_constraint k ON k.conindid=i.indexrelid AND k.conrelid=i.indrelid AND k.contype IN ('p','u','x')
    WHERE i.indrelid=ANY($1::oid[]) ORDER BY i.indrelid,c.relname`,
      [ids],
    )
  ).rows;
  const partitions = (
    await client.query(
      `SELECT c.oid::text AS id, n.nspname AS schema, c.relname AS name, p.oid::text AS parent_id,
       CASE WHEN p.oid IS NOT NULL THEN quote_ident(pn.nspname)||'.'||quote_ident(p.relname) END AS parent,
       (SELECT count(*)::int-1 FROM pg_partition_ancestors(c.oid)) AS absolute_level,
       CASE pt.partstrat WHEN 'r' THEN 'RANGE' WHEN 'l' THEN 'LIST' WHEN 'h' THEN 'HASH' END AS method,
       pg_get_partkeydef(c.oid) AS partition_key,
       CASE ppt.partstrat WHEN 'r' THEN 'RANGE' WHEN 'l' THEN 'LIST' WHEN 'h' THEN 'HASH' END AS parent_method,
       pg_get_partkeydef(p.oid) AS parent_partition_key,
       pg_get_expr(c.relpartbound,c.oid,true) AS bounds
       FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       LEFT JOIN pg_inherits inh ON inh.inhrelid=c.oid AND c.relispartition
       LEFT JOIN pg_class p ON p.oid=inh.inhparent LEFT JOIN pg_namespace pn ON pn.oid=p.relnamespace
       LEFT JOIN pg_partitioned_table pt ON pt.partrelid=c.oid LEFT JOIN pg_partitioned_table ppt ON ppt.partrelid=p.oid
       WHERE c.oid=ANY($1::oid[]) AND (c.relkind='p' OR c.relispartition)
       ORDER BY n.nspname,c.relname`,
      [ids],
    )
  ).rows;
  const group = (rows) => {
    const map = new Map();
    for (const { table_id, ...row } of rows) {
      if (!map.has(table_id)) map.set(table_id, []);
      map.get(table_id).push(row);
    }
    return map;
  };
  const columnMap = group(columns),
    constraintMap = group(constraints),
    indexMap = group(indexes);
  const nodes = new Map(partitions.map((p) => [p.id, p])),
    children = new Map();
  for (const p of partitions) {
    if (!children.has(p.parent_id)) children.set(p.parent_id, []);
    children.get(p.parent_id).push(p);
  }
  return relations.map((relation) => {
    const tree = [];
    const visit = (node, level) => {
      tree.push({ ...node, level });
      for (const child of children.get(node.id) || []) visit(child, level + 1);
    };
    if (nodes.has(relation.id)) visit(nodes.get(relation.id), 0);
    return {
      ...relation,
      columns: columnMap.get(relation.id) || [],
      constraints: constraintMap.get(relation.id) || [],
      indexes: indexMap.get(relation.id) || [],
      partitions: tree,
      logical_keys: [],
      sqlserver_partitions: [],
    };
  });
}
export async function detail(client, oid) {
  return (
    (await bulkRelations(client)).find((r) => r.id === String(oid)) || null
  );
}

export async function types(client) {
  const nodes = (
    await client.query(`SELECT t.oid::text AS id,n.nspname AS schema,t.typname AS name,
    format_type(t.oid,NULL) AS type,t.typtype AS kind,c.relkind AS relation_kind,t.typrelid::text AS relation_id,
    NULLIF(t.typelem,0)::text AS element_type_id,NULLIF(t.typbasetype,0)::text AS base_type_id,
    obj_description(t.oid,'pg_type') AS comment
    FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace LEFT JOIN pg_class c ON c.oid=t.typrelid
    ORDER BY n.nspname,t.typname`)
  ).rows;
  const fields = (
    await client.query(`SELECT t.oid::text AS owner_type_id,a.attnum AS position,a.attname AS name,
    a.atttypid::text AS type_id,format_type(a.atttypid,a.atttypmod) AS type,NOT a.attnotnull AS nullable,
    pg_get_expr(d.adbin,d.adrelid) AS default,a.attidentity AS identity,a.attgenerated AS generated,
    col_description(a.attrelid,a.attnum) AS comment
    FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace JOIN pg_attribute a ON a.attrelid=t.typrelid
    LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    WHERE t.typtype='c'
      AND a.attnum>0 AND NOT a.attisdropped ORDER BY t.oid,a.attnum`)
  ).rows;
  const byId = new Map(nodes.map((t) => [t.id, { ...t, attributes: [] }]));
  for (const { owner_type_id, ...field } of fields)
    byId.get(owner_type_id)?.attributes.push(field);
  return [...byId.values()];
}

export async function capture(client) {
  const result = {
    overview: await overview(client),
    schemas: await schemas(client, true),
    relations: await bulkRelations(client),
    routines: await routines(client),
    types: await types(client),
  };
  return result;
}

const quote = (identifier) => '"' + identifier.replaceAll('"', '""') + '"';
export async function preview(client, oid, limit = 50, offset = 0) {
  // Resolve the OID again on the live source; never interpolate caller-supplied identifiers.
  const relation = (
    await client.query(
      `SELECT n.nspname AS schema,c.relname AS name
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE c.oid=$1::oid AND c.relkind IN ('r','p','v','m','f') AND n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema'`,
      [oid],
    )
  ).rows[0];
  if (!relation) return null;
  const data = await client.query({
    text: `SELECT * FROM ${quote(relation.schema)}.${quote(relation.name)} LIMIT $1 OFFSET $2`,
    values: [limit, offset],
    rowMode: "array",
    // Return text to preserve bigint/numeric precision and avoid unsafe binary output.
    types: { getTypeParser: () => (value) => value },
  });
  let budget = 2_000_000;
  let truncated = false;
  const rows = [];
  for (const row of data.rows) {
    if (budget <= 0) {
      truncated = true;
      break;
    }
    rows.push(
      row.map((value) => {
        if (value === null) return null;
        const text = String(value),
          max = Math.max(0, Math.min(4096, budget));
        const cell = text.slice(0, max);
        budget -= cell.length;
        if (cell.length < text.length) truncated = true;
        return cell + (cell.length < text.length ? "…" : "");
      }),
    );
  }
  return {
    columns: data.fields.map((f) => f.name),
    rows,
    limit,
    offset,
    truncated,
    has_more: data.rows.length === limit,
  };
}
