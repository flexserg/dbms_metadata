import pg from "pg";

export function validateConnection(input) {
  const result = {};
  for (const field of ["name", "host", "database", "username"]) {
    if (
      typeof input[field] !== "string" ||
      !input[field].trim() ||
      input[field].length > 255
    )
      throw new Error(`A valid ${field} is required`);
    result[field] = input[field].trim();
  }
  result.port = Number(input.port || 5432);
  if (!Number.isInteger(result.port) || result.port < 1 || result.port > 65535)
    throw new Error("Port must be between 1 and 65535");
  if (!["disable", "verify-full"].includes(input.sslMode))
    throw new Error("Select a valid TLS mode");
  result.sslMode = input.sslMode;
  result.password = input.password;
  if (typeof result.password !== "string" || result.password.length > 4096)
    throw new Error("A password string is required");
  return result;
}

export async function withTarget(connection, action) {
  const client = new pg.Client({
    host: connection.host,
    port: connection.port,
    database: connection.database,
    user: connection.username,
    password: connection.password,
    ssl:
      connection.sslMode === "verify-full"
        ? {
            rejectUnauthorized: true,
            ...(process.env.PG_TARGET_CA
              ? { ca: process.env.PG_TARGET_CA }
              : {}),
          }
        : false,
    connectionTimeoutMillis: 5000,
    query_timeout: 10000,
    application_name: "dbms_metadata",
  });
  // A target can disappear while an HTTP request is in flight.
  client.on("error", () => {});
  try {
    await client.connect();
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await client.query("SET LOCAL statement_timeout = '8s'");
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
export async function schemas(client) {
  return (
    await client.query(`SELECT n.oid::text AS id, n.nspname AS name, pg_get_userbyid(n.nspowner) AS owner,
    obj_description(n.oid,'pg_namespace') AS comment, count(c.oid)::int AS objects
    FROM pg_namespace n LEFT JOIN pg_class c ON c.relnamespace=n.oid AND c.relkind IN ('r','p','v','m','f')
    WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname <> 'information_schema'
    GROUP BY n.oid ORDER BY n.nspname`)
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
export async function routines(client, schema) {
  return (
    await client.query(
      `SELECT p.oid::text AS id, p.proname AS name,
    CASE p.prokind WHEN 'p' THEN 'Procedure' ELSE 'Function' END AS kind,
    pg_get_function_identity_arguments(p.oid) AS arguments,
    pg_get_function_result(p.oid) AS result, l.lanname AS language,
    pg_get_functiondef(p.oid) AS definition
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_language l ON l.oid=p.prolang
    WHERE n.nspname=$1 AND p.prokind IN ('f','p') ORDER BY p.proname,p.oid`,
      [schema],
    )
  ).rows;
}
export async function detail(client, oid) {
  const relation = (
    await client.query(
      `SELECT c.oid::text AS id, n.nspname AS schema, c.relname AS name, c.relkind,
    pg_get_userbyid(c.relowner) AS owner, obj_description(c.oid,'pg_class') AS comment,
    (SELECT inhparent::text FROM pg_inherits WHERE inhrelid=c.oid ORDER BY inhseqno LIMIT 1) AS parent_id,
    ARRAY(SELECT inhparent::text FROM pg_inherits WHERE inhrelid=c.oid ORDER BY inhseqno) AS parent_ids,
    c.reltuples::bigint::text AS estimated_rows,
    CASE WHEN c.relkind IN ('r','p','m') THEN pg_total_relation_size(c.oid)::text ELSE NULL END AS size,
    CASE WHEN c.relkind IN ('v','m') THEN pg_get_viewdef(c.oid,true) ELSE NULL END AS definition
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.oid=$1::oid AND c.relkind IN ('r','p','v','m','f')`,
      [oid],
    )
  ).rows[0];
  if (!relation) return null;
  const columns = (
    await client.query(
      `SELECT a.attnum AS position, a.attname AS name, a.atttypid::text AS type_id,
    format_type(a.atttypid,a.atttypmod) AS type, NOT a.attnotnull AS nullable,
    pg_get_expr(d.adbin,d.adrelid) AS default, col_description(a.attrelid,a.attnum) AS comment,
    a.attidentity AS identity, a.attgenerated AS generated,
    EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conrelid=a.attrelid AND k.contype='p' AND a.attnum=ANY(k.conkey)) AS primary_key
    FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    WHERE a.attrelid=$1::oid AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum`,
      [oid],
    )
  ).rows;
  const constraints = (
    await client.query(
      `SELECT k.oid::text AS id, k.conname AS name, k.contype AS type,
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
       k.convalidated AS validated, k.condeferrable AS deferrable, k.condeferred AS initially_deferred,
       CASE WHEN k.convalidated THEN 'Validated' ELSE 'Not validated' END AS status,
       obj_description(k.oid,'pg_constraint') AS comment
    FROM pg_constraint k WHERE k.conrelid=$1::oid ORDER BY k.conname`,
      [oid],
    )
  ).rows;
  const indexes = (
    await client.query(
      `SELECT c.oid::text AS id, c.relname AS name, am.amname AS type,
       i.indisunique AS unique, i.indisprimary AS primary, i.indisvalid AS valid, i.indisready AS ready,
       ARRAY(SELECT pg_get_indexdef(i.indexrelid,s,true) FROM generate_series(1,i.indnkeyatts) s) AS attributes,
       ARRAY(SELECT pg_get_indexdef(i.indexrelid,s,true) FROM generate_series(i.indnkeyatts+1,i.indnatts) s) AS included_attributes,
       pg_get_expr(i.indpred,i.indrelid,true) AS condition, k.conname AS constraint_name,
       pg_get_indexdef(i.indexrelid) AS definition FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
       JOIN pg_am am ON am.oid=c.relam LEFT JOIN pg_constraint k ON k.conindid=i.indexrelid AND k.conrelid=i.indrelid AND k.contype IN ('p','u','x')
    WHERE i.indrelid=$1::oid ORDER BY c.relname`,
      [oid],
    )
  ).rows;
  const partitions = (
    await client.query(
      `WITH RECURSIVE tree AS (
      SELECT c.oid, (SELECT inhparent FROM pg_inherits WHERE inhrelid=c.oid AND c.relispartition LIMIT 1) AS parent_id, 0 AS level
        FROM pg_class c WHERE c.oid=$1::oid AND (c.relkind='p' OR c.relispartition)
      UNION ALL SELECT i.inhrelid,i.inhparent,t.level+1 FROM tree t JOIN pg_inherits i ON i.inhparent=t.oid
    ) SELECT t.oid::text AS id, n.nspname AS schema, c.relname AS name, t.parent_id::text,
       CASE WHEN p.oid IS NOT NULL THEN quote_ident(pn.nspname)||'.'||quote_ident(p.relname) END AS parent,
       t.level, (SELECT count(*)::int-1 FROM pg_partition_ancestors(c.oid)) AS absolute_level,
       CASE pt.partstrat WHEN 'r' THEN 'RANGE' WHEN 'l' THEN 'LIST' WHEN 'h' THEN 'HASH' END AS method,
       pg_get_partkeydef(c.oid) AS partition_key,
       CASE ppt.partstrat WHEN 'r' THEN 'RANGE' WHEN 'l' THEN 'LIST' WHEN 'h' THEN 'HASH' END AS parent_method,
       pg_get_partkeydef(p.oid) AS parent_partition_key,
       pg_get_expr(c.relpartbound,c.oid,true) AS bounds
       FROM tree t JOIN pg_class c ON c.oid=t.oid JOIN pg_namespace n ON n.oid=c.relnamespace
       LEFT JOIN pg_class p ON p.oid=t.parent_id LEFT JOIN pg_namespace pn ON pn.oid=p.relnamespace
       LEFT JOIN pg_partitioned_table pt ON pt.partrelid=c.oid LEFT JOIN pg_partitioned_table ppt ON ppt.partrelid=p.oid
       ORDER BY t.level,n.nspname,c.relname`,
      [oid],
    )
  ).rows;
  return {
    ...relation,
    columns,
    constraints,
    indexes,
    partitions,
    logical_keys: [],
  };
}

export async function types(client) {
  const nodes = (
    await client.query(`SELECT t.oid::text AS id,n.nspname AS schema,t.typname AS name,
    format_type(t.oid,NULL) AS type,t.typtype AS kind,c.relkind AS relation_kind,t.typrelid::text AS relation_id,
    NULLIF(t.typelem,0)::text AS element_type_id,NULLIF(t.typbasetype,0)::text AS base_type_id,
    obj_description(t.oid,'pg_type') AS comment
    FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace LEFT JOIN pg_class c ON c.oid=t.typrelid
    WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema'
      AND (t.typtype IN ('c','d') OR t.typelem<>0) ORDER BY n.nspname,t.typname`)
  ).rows;
  const fields = (
    await client.query(`SELECT t.oid::text AS owner_type_id,a.attnum AS position,a.attname AS name,
    a.atttypid::text AS type_id,format_type(a.atttypid,a.atttypmod) AS type,NOT a.attnotnull AS nullable,
    pg_get_expr(d.adbin,d.adrelid) AS default,a.attidentity AS identity,a.attgenerated AS generated,
    col_description(a.attrelid,a.attnum) AS comment
    FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace JOIN pg_attribute a ON a.attrelid=t.typrelid
    LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    WHERE t.typtype='c' AND n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema'
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
    schemas: await schemas(client),
    relations: [],
    routines: [],
    types: await types(client),
  };
  for (const schema of result.schemas) {
    for (const object of await objects(client, schema.name)) {
      result.relations.push({
        ...object,
        ...(await detail(client, object.id)),
      });
    }
    result.routines.push(
      ...(await routines(client, schema.name)).map((r) => ({
        ...r,
        schema: schema.name,
      })),
    );
  }
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
