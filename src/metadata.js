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
    await client.query("BEGIN READ ONLY");
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
      `SELECT a.attnum AS position, a.attname AS name,
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
      `SELECT conname AS name, contype AS type, pg_get_constraintdef(oid,true) AS definition
    FROM pg_constraint WHERE conrelid=$1::oid ORDER BY conname`,
      [oid],
    )
  ).rows;
  const indexes = (
    await client.query(
      `SELECT c.relname AS name, i.indisunique AS unique, i.indisprimary AS primary,
    pg_get_indexdef(i.indexrelid) AS definition FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
    WHERE i.indrelid=$1::oid ORDER BY c.relname`,
      [oid],
    )
  ).rows;
  return { ...relation, columns, constraints, indexes };
}
