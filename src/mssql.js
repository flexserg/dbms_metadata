import sql from "mssql";
export const quote = (name) => "[" + name.replaceAll("]", "]]") + "]";
export function typeName(column, types) {
  const t = types.get(String(column.user_type_id));
  if (!t) return "unknown";
  if (t.is_user_defined || t.name === "sysname")
    return quote(t.schema) + "." + quote(t.name);
  const n = t.name;
  if (
    ["varchar", "char", "varbinary", "binary", "nvarchar", "nchar"].includes(n)
  )
    return `${n}(${column.max_length === -1 ? "max" : column.max_length / (n.startsWith("n") ? 2 : 1)})`;
  if (["decimal", "numeric"].includes(n))
    return `${n}(${column.precision},${column.scale})`;
  if (["time", "datetime2", "datetimeoffset"].includes(n))
    return `${n}(${column.scale})`;
  if (n === "float") return `float(${column.precision})`;
  return n;
}
export async function withTarget(connection, action) {
  const pool = new sql.ConnectionPool({
    server: connection.host,
    port: connection.port,
    database: connection.database,
    user: connection.username,
    password: connection.password,
    connectionTimeout: 5000,
    requestTimeout: 10000,
    pool: { max: 1, min: 0, idleTimeoutMillis: 1000 },
    options: {
      encrypt: connection.sslMode !== "disable",
      trustServerCertificate: connection.sslMode === "trust-server-certificate",
      readOnlyIntent: true,
      abortTransactionOnError: true,
      ...(process.env.MSSQL_TARGET_CA
        ? { cryptoCredentialsDetails: { ca: process.env.MSSQL_TARGET_CA } }
        : {}),
    },
  });
  pool.on("error", () => {});
  let transaction;
  try {
    await pool.connect();
    transaction = new sql.Transaction(pool);
    await transaction.begin(sql.ISOLATION_LEVEL.REPEATABLE_READ);
    const client = {
      engine: "mssql",
      async query(text, params = {}, array = false) {
        const request = new sql.Request(transaction);
        request.arrayRowMode = array;
        for (const [key, value] of Object.entries(params))
          request.input(
            key,
            typeof value === "number" ? sql.Int : sql.NVarChar,
            value,
          );
        const result = await request.query(text);
        return { rows: result.recordset || [] };
      },
    };
    await client.query("SET LOCK_TIMEOUT 5000");
    return await action(client);
  } finally {
    if (transaction) await transaction.rollback().catch(() => {});
    await pool.close().catch(() => {});
  }
}
const userSchema = `s.name NOT IN ('sys','INFORMATION_SCHEMA','guest','db_owner','db_accessadmin','db_securityadmin','db_ddladmin','db_backupoperator','db_datareader','db_datawriter','db_denydatareader','db_denydatawriter')`;
export async function overview(client) {
  return (
    await client.query(`SELECT DB_NAME() AS [database],USER_NAME() AS username,
  CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(128)) AS version,
  CAST((SELECT SUM(CAST(size AS bigint))*8192 FROM sys.database_files) AS varchar(30)) AS size,
  (SELECT COUNT(*) FROM sys.schemas s WHERE ${userSchema}) AS schemas,
  (SELECT COUNT(*) FROM sys.objects o WHERE o.type IN ('U','V') AND o.is_ms_shipped=0) AS objects`)
  ).rows[0];
}
export async function capture(client) {
  const schemas = (
    await client.query(`SELECT CAST(s.schema_id AS varchar(20)) AS id,s.name,USER_NAME(s.principal_id) AS owner,
    CAST(ep.value AS nvarchar(max)) AS comment,CAST(CASE WHEN ${userSchema} THEN 0 ELSE 1 END AS bit) AS is_system
    FROM sys.schemas s LEFT JOIN sys.extended_properties ep ON ep.class=3 AND ep.major_id=s.schema_id AND ep.name='MS_Description' ORDER BY s.name`)
  ).rows;
  const rawTypes = (
    await client.query(`SELECT t.user_type_id,t.system_type_id,t.name,s.name AS [schema],t.is_user_defined,t.is_table_type,t.is_assembly_type,
    tt.type_table_object_id,CAST(ep.value AS nvarchar(max)) AS comment FROM sys.types t JOIN sys.schemas s ON s.schema_id=t.schema_id
    LEFT JOIN sys.table_types tt ON tt.user_type_id=t.user_type_id LEFT JOIN sys.extended_properties ep ON ep.class=6 AND ep.major_id=t.user_type_id AND ep.name='MS_Description' ORDER BY s.name,t.name`)
  ).rows;
  const typeMap = new Map(rawTypes.map((t) => [String(t.user_type_id), t]));
  const objects = (
    await client.query(`SELECT o.object_id,s.name AS [schema],o.name,RTRIM(o.type) AS type,
    COALESCE(USER_NAME(o.principal_id),USER_NAME(s.principal_id)) AS owner,
    CAST(ep.value AS nvarchar(max)) AS comment,OBJECT_DEFINITION(o.object_id) AS definition
    FROM sys.objects o JOIN sys.schemas s ON s.schema_id=o.schema_id LEFT JOIN sys.extended_properties ep ON ep.class=1 AND ep.major_id=o.object_id AND ep.minor_id=0 AND ep.name='MS_Description'
    WHERE o.type IN ('U','V','P','PC','FN','IF','TF','FS','FT') AND o.is_ms_shipped=0 ORDER BY s.name,o.name`)
  ).rows;
  const columns = (
    await client.query(`SELECT c.object_id,c.column_id,c.name,c.user_type_id,c.max_length,c.precision,c.scale,c.is_nullable,
    c.is_identity,CONVERT(varchar(50),ic.seed_value) AS identity_seed,CONVERT(varchar(50),ic.increment_value) AS identity_increment,
    dc.definition AS default_expression,cc.definition AS computed_expression,cc.is_persisted,
    CAST(ep.value AS nvarchar(max)) AS comment FROM sys.columns c
    LEFT JOIN sys.identity_columns ic ON ic.object_id=c.object_id AND ic.column_id=c.column_id
    LEFT JOIN sys.default_constraints dc ON dc.object_id=c.default_object_id
    LEFT JOIN sys.computed_columns cc ON cc.object_id=c.object_id AND cc.column_id=c.column_id
    LEFT JOIN sys.extended_properties ep ON ep.class=1 AND ep.major_id=c.object_id AND ep.minor_id=c.column_id AND ep.name='MS_Description'
    WHERE EXISTS(SELECT 1 FROM sys.objects o WHERE o.object_id=c.object_id AND o.is_ms_shipped=0) ORDER BY c.object_id,c.column_id`)
  ).rows;
  const rawIndexes = (
    await client.query(`SELECT i.object_id,i.index_id,i.name,i.type_desc,i.is_unique,i.is_primary_key,i.is_disabled,i.is_hypothetical,i.filter_definition,
    ds.type AS space_type,ps.name AS scheme,pf.name AS function_name,pf.boundary_value_on_right
    FROM sys.indexes i LEFT JOIN sys.data_spaces ds ON ds.data_space_id=i.data_space_id
    LEFT JOIN sys.partition_schemes ps ON ps.data_space_id=i.data_space_id LEFT JOIN sys.partition_functions pf ON pf.function_id=ps.function_id
    WHERE i.index_id>0 AND EXISTS(SELECT 1 FROM sys.objects o WHERE o.object_id=i.object_id AND o.is_ms_shipped=0) ORDER BY i.object_id,i.index_id`)
  ).rows;
  const indexColumns = (
    await client.query(`SELECT i.object_id,i.index_id,i.index_column_id,i.key_ordinal,i.is_included_column,i.is_descending_key,i.partition_ordinal,c.name
    FROM sys.index_columns i JOIN sys.columns c ON c.object_id=i.object_id AND c.column_id=i.column_id
    WHERE EXISTS(SELECT 1 FROM sys.objects o WHERE o.object_id=i.object_id AND o.is_ms_shipped=0) ORDER BY i.object_id,i.index_id,i.key_ordinal,i.index_column_id`)
  ).rows;
  const keys = (
    await client.query(
      `SELECT k.object_id,k.parent_object_id,k.name,k.type,k.unique_index_id FROM sys.key_constraints k WHERE k.is_ms_shipped=0`,
    )
  ).rows;
  const fks = (
    await client.query(
      `SELECT object_id,parent_object_id,referenced_object_id,name,delete_referential_action_desc,update_referential_action_desc,is_disabled,is_not_trusted FROM sys.foreign_keys WHERE is_ms_shipped=0`,
    )
  ).rows;
  const fkColumns = (
    await client.query(`SELECT f.constraint_object_id,f.constraint_column_id,a.name AS attribute,b.name AS referenced_attribute FROM sys.foreign_key_columns f
    JOIN sys.columns a ON a.object_id=f.parent_object_id AND a.column_id=f.parent_column_id JOIN sys.columns b ON b.object_id=f.referenced_object_id AND b.column_id=f.referenced_column_id ORDER BY f.constraint_object_id,f.constraint_column_id`)
  ).rows;
  const checks = (
    await client.query(
      `SELECT object_id,parent_object_id,parent_column_id,name,definition,is_disabled,is_not_trusted FROM sys.check_constraints WHERE is_ms_shipped=0`,
    )
  ).rows;
  const defaults = (
    await client.query(
      `SELECT d.object_id,d.parent_object_id,d.name,d.definition,c.name AS attribute FROM sys.default_constraints d JOIN sys.columns c ON c.object_id=d.parent_object_id AND c.column_id=d.parent_column_id WHERE d.is_ms_shipped=0`,
    )
  ).rows;
  const dependencies = (
    await client.query(
      `SELECT referencing_id,referenced_id,referenced_minor_id FROM sys.sql_expression_dependencies WHERE referenced_minor_id>0`,
    )
  ).rows;
  const parts = (
    await client.query(`SELECT p.object_id,p.index_id,p.partition_number,CAST(p.partition_id AS varchar(30)) AS partition_id,CAST(p.rows AS varchar(30)) AS row_count,
    ps.name AS scheme,pf.name AS function_name,pf.boundary_value_on_right,
    CASE WHEN lo.boundary_id IS NOT NULL AND lo.value IS NULL THEN N'NULL' ELSE CONVERT(nvarchar(4000),lo.value,126) END AS lower_bound,
    CASE WHEN hi.boundary_id IS NOT NULL AND hi.value IS NULL THEN N'NULL' ELSE CONVERT(nvarchar(4000),hi.value,126) END AS upper_bound,fg.name AS filegroup
    FROM sys.partitions p JOIN sys.indexes i ON i.object_id=p.object_id AND i.index_id=p.index_id
    JOIN sys.partition_schemes ps ON ps.data_space_id=i.data_space_id JOIN sys.partition_functions pf ON pf.function_id=ps.function_id
    LEFT JOIN sys.partition_range_values lo ON lo.function_id=pf.function_id AND lo.boundary_id=p.partition_number-1
    LEFT JOIN sys.partition_range_values hi ON hi.function_id=pf.function_id AND hi.boundary_id=p.partition_number
    LEFT JOIN sys.destination_data_spaces dd ON dd.partition_scheme_id=ps.data_space_id AND dd.destination_id=p.partition_number LEFT JOIN sys.filegroups fg ON fg.data_space_id=dd.data_space_id
    WHERE p.index_id IN (0,1) ORDER BY p.object_id,p.partition_number`)
  ).rows;
  const stats = (
    await client.query(`SELECT p.object_id,CAST(SUM(CASE WHEN p.index_id IN (0,1) THEN p.rows ELSE 0 END) AS varchar(30)) AS estimated_rows,
    CAST((SELECT SUM(a.total_pages)*8192 FROM sys.partitions x JOIN sys.allocation_units a ON (a.type IN (1,3) AND a.container_id=x.hobt_id) OR (a.type=2 AND a.container_id=x.partition_id) WHERE x.object_id=p.object_id) AS varchar(30)) AS size
    FROM sys.partitions p GROUP BY p.object_id`)
  ).rows;
  const parameters = (
    await client.query(
      `SELECT p.object_id,p.parameter_id,p.name,p.user_type_id,p.max_length,p.precision,p.scale,p.is_output FROM sys.parameters p ORDER BY p.object_id,p.parameter_id`,
    )
  ).rows;
  const column = (c) => ({
    position: c.column_id,
    name: c.name,
    type_id: String(c.user_type_id),
    type: typeName(c, typeMap),
    nullable: c.is_nullable,
    default: c.computed_expression ?? c.default_expression ?? null,
    identity: c.is_identity ? "mssql" : "",
    identity_seed: c.identity_seed,
    identity_increment: c.identity_increment,
    generated: c.computed_expression
      ? c.is_persisted
        ? "mssql_persisted"
        : "mssql_computed"
      : "",
    comment: c.comment,
    primary_key: false,
  });
  const types = rawTypes.map((t) => ({
    id: String(t.user_type_id),
    schema: t.schema,
    name: t.name,
    type: t.is_user_defined ? quote(t.schema) + "." + quote(t.name) : t.name,
    kind: t.is_table_type
      ? "c"
      : (t.is_user_defined && !t.is_assembly_type) || t.name === "sysname"
        ? "d"
        : "b",
    relation_kind: t.is_table_type ? "c" : null,
    relation_id: String(t.type_table_object_id || 0),
    element_type_id: null,
    base_type_id:
      !t.is_table_type &&
      !t.is_assembly_type &&
      t.user_type_id !== t.system_type_id
        ? String(t.system_type_id)
        : null,
    comment: t.comment,
    attributes: t.is_table_type
      ? columns
          .filter((c) => c.object_id === t.type_table_object_id)
          .map(({ ...c }) => {
            const { primary_key, ...a } = column(c);
            return a;
          })
      : [],
  }));
  const relationObjects = objects.filter((o) => ["U", "V"].includes(o.type)),
    relationMap = new Map(relationObjects.map((o) => [o.object_id, o]));
  const relations = relationObjects.map((o) => {
    const id = String(o.object_id),
      cols = columns.filter((c) => c.object_id === o.object_id).map(column),
      constraints = [];
    const constraint = (k, type, attributes, definition, extra = {}) => ({
      id: String(k.object_id),
      name: k.name,
      type,
      attributes,
      definition,
      referenced_table_id: null,
      referenced_table: null,
      referenced_attributes: [],
      on_delete: null,
      on_update: null,
      condition: null,
      validated: !k.is_not_trusted,
      enabled: !k.is_disabled,
      deferrable: false,
      initially_deferred: false,
      comment: null,
      ...extra,
    });
    for (const k of keys.filter((k) => k.parent_object_id === o.object_id)) {
      const attrs = indexColumns
        .filter(
          (c) =>
            c.object_id === o.object_id &&
            c.index_id === k.unique_index_id &&
            c.key_ordinal > 0,
        )
        .map((c) => c.name);
      constraints.push(
        constraint(
          k,
          k.type === "PK" ? "p" : "u",
          attrs,
          `${k.type === "PK" ? "PRIMARY KEY" : "UNIQUE"} (${attrs.map(quote).join(", ")})`,
        ),
      );
      if (k.type === "PK")
        for (const c of cols) c.primary_key = attrs.includes(c.name);
    }
    for (const k of fks.filter((k) => k.parent_object_id === o.object_id)) {
      const ref = relationMap.get(k.referenced_object_id);
      if (!ref)
        throw new Error(
          "SQL Server metadata visibility is incomplete: referenced table unavailable",
        );
      const attrs = fkColumns.filter(
          (c) => c.constraint_object_id === k.object_id,
        ),
        table = quote(ref.schema) + "." + quote(ref.name);
      const del = k.delete_referential_action_desc.replaceAll("_", " "),
        upd = k.update_referential_action_desc.replaceAll("_", " ");
      constraints.push(
        constraint(
          k,
          "f",
          attrs.map((a) => a.attribute),
          `FOREIGN KEY (${attrs.map((a) => quote(a.attribute)).join(", ")}) REFERENCES ${table} (${attrs.map((a) => quote(a.referenced_attribute)).join(", ")}) ON DELETE ${del} ON UPDATE ${upd}`,
          {
            referenced_table_id: String(ref.object_id),
            referenced_table: table,
            referenced_attributes: attrs.map((a) => a.referenced_attribute),
            on_delete: del,
            on_update: upd,
          },
        ),
      );
    }
    for (const k of checks.filter((k) => k.parent_object_id === o.object_id)) {
      const used = new Set(
        dependencies
          .filter(
            (d) =>
              d.referencing_id === k.object_id &&
              d.referenced_id === o.object_id,
          )
          .map((d) => d.referenced_minor_id),
      );
      if (k.parent_column_id) used.add(k.parent_column_id);
      constraints.push(
        constraint(
          k,
          "c",
          cols.filter((c) => used.has(c.position)).map((c) => c.name),
          "CHECK " + k.definition,
          { condition: k.definition },
        ),
      );
    }
    for (const k of defaults.filter((k) => k.parent_object_id === o.object_id))
      constraints.push(
        constraint(
          k,
          "d",
          [k.attribute],
          `DEFAULT ${k.definition} FOR ${quote(k.attribute)}`,
          { condition: k.definition },
        ),
      );
    for (const c of constraints)
      c.status = !c.enabled
        ? "Disabled"
        : c.validated
          ? "Enabled"
          : "Enabled / not trusted";
    const indexes = rawIndexes
      .filter((i) => i.object_id === o.object_id)
      .map((i) => {
        const attributes = indexColumns.filter(
            (c) => c.object_id === o.object_id && c.index_id === i.index_id,
          ),
          included = i.type_desc.includes("COLUMNSTORE")
            ? []
            : attributes
                .filter((c) => c.is_included_column)
                .map((c) => quote(c.name));
        const key = attributes
          .filter(
            (c) =>
              i.type_desc.includes("COLUMNSTORE") ||
              (!c.is_included_column &&
                (c.key_ordinal > 0 ||
                  ["XML", "SPATIAL"].includes(i.type_desc))),
          )
          .map(
            (c) =>
              quote(c.name) +
              (c.key_ordinal > 0
                ? c.is_descending_key
                  ? " DESC"
                  : " ASC"
                : ""),
          );
        return {
          id: String(BigInt(o.object_id) * 65536n + BigInt(i.index_id)),
          name: i.name,
          type: i.type_desc,
          unique: i.is_unique,
          primary: i.is_primary_key,
          valid: !i.is_disabled && !i.is_hypothetical,
          ready: !i.is_disabled,
          attributes: key,
          included_attributes: included,
          condition: i.filter_definition,
          constraint_name:
            keys.find(
              (k) =>
                k.parent_object_id === o.object_id &&
                k.unique_index_id === i.index_id,
            )?.name || null,
          definition: `CREATE ${i.is_unique ? "UNIQUE " : ""}${i.type_desc.replaceAll("_", " ")} INDEX ${quote(i.name)} ON ${quote(o.schema)}.${quote(o.name)}${i.type_desc === "CLUSTERED COLUMNSTORE" ? "" : " (" + key.join(", ") + ")"}${included.length ? " INCLUDE (" + included.join(", ") + ")" : ""}${i.filter_definition ? " WHERE " + i.filter_definition : ""}`,
        };
      });
    const physical = parts
      .filter((p) => p.object_id === o.object_id)
      .map((p) => ({
        partition_number: p.partition_number,
        partition_id: p.partition_id,
        function_name: p.function_name,
        scheme: p.scheme,
        boundary_on_right: p.boundary_value_on_right,
        lower_bound: p.lower_bound,
        upper_bound: p.upper_bound,
        filegroup: p.filegroup,
        row_count: p.row_count,
      }));
    const baseIndex = rawIndexes.find(
      (i) => i.object_id === o.object_id && i.index_id === 1,
    );
    const partitionKey = indexColumns
      .filter(
        (c) =>
          c.object_id === o.object_id &&
          c.index_id === (baseIndex ? 1 : 0) &&
          c.partition_ordinal > 0,
      )
      .map((c) => quote(c.name))
      .join(", ");
    const partitioned = !!physical.length,
      stat = stats.find((s) => s.object_id === o.object_id);
    return {
      id,
      schema: o.schema,
      name: o.name,
      kind:
        o.type === "V" ? "View" : partitioned ? "Partitioned table" : "Table",
      relkind: o.type === "V" ? "v" : partitioned ? "p" : "r",
      owner: o.owner,
      comment: o.comment,
      parent_id: null,
      parent_ids: [],
      estimated_rows: stat?.estimated_rows ?? "-1",
      size: stat?.size ?? null,
      definition: o.type === "V" ? o.definition : null,
      columns: cols,
      constraints,
      indexes,
      logical_keys: [],
      sqlserver_partitions: physical,
      partitions: partitioned
        ? [
            {
              id,
              schema: o.schema,
              name: o.name,
              parent_id: null,
              parent: null,
              level: 0,
              absolute_level: 0,
              method: "RANGE",
              partition_key: partitionKey,
              parent_method: null,
              parent_partition_key: null,
              bounds: null,
            },
          ]
        : [],
    };
  });
  for (const s of schemas)
    s.objects = relations.filter((r) => r.schema === s.name).length;
  const routines = objects
    .filter((o) => !["U", "V"].includes(o.type))
    .map((o) => ({
      id: String(o.object_id),
      schema: o.schema,
      name: o.name,
      kind: ["P", "PC"].includes(o.type) ? "Procedure" : "Function",
      arguments: parameters
        .filter((p) => p.object_id === o.object_id && p.parameter_id > 0)
        .map(
          (p) =>
            `${p.name} ${typeName(p, typeMap)}${p.is_output ? " OUTPUT" : ""}`,
        )
        .join(", "),
      result: parameters.find(
        (p) => p.object_id === o.object_id && p.parameter_id === 0,
      )
        ? typeName(
            parameters.find(
              (p) => p.object_id === o.object_id && p.parameter_id === 0,
            ),
            typeMap,
          )
        : ["IF", "TF", "FT"].includes(o.type)
          ? "TABLE"
          : null,
      language: ["PC", "FS", "FT"].includes(o.type) ? "CLR" : "T-SQL",
      definition:
        o.definition ||
        "-- Definition unavailable: encrypted module or insufficient VIEW DEFINITION permission",
    }));
  return {
    overview: await overview(client),
    schemas,
    types,
    relations,
    routines,
  };
}
export async function preview(client, id, limit = 50, offset = 0) {
  const object = (
    await client.query(
      `SELECT s.name AS [schema],o.name FROM sys.objects o JOIN sys.schemas s ON s.schema_id=o.schema_id WHERE o.object_id=@id AND o.type IN ('U','V') AND o.is_ms_shipped=0`,
      { id: Number(id) },
    )
  ).rows[0];
  if (!object) return null;
  const columns = (
    await client.query(
      `SELECT c.name,t.name AS type,t.system_type_id,t.is_assembly_type FROM sys.columns c JOIN sys.types t ON t.user_type_id=c.user_type_id WHERE c.object_id=@id ORDER BY c.column_id`,
      { id: Number(id) },
    )
  ).rows;
  const expressions = columns.map(
    (c) =>
      `${c.is_assembly_type ? quote(c.name) + ".ToString()" : [34, 165, 173, 189].includes(c.system_type_id) ? "CONVERT(varchar(max)," + quote(c.name) + ",1)" : "CONVERT(nvarchar(max)," + quote(c.name) + "," + ([59, 62].includes(c.system_type_id) ? 3 : 126) + ")"} AS ${quote(c.name)}`,
  );
  const result = await client.query(
    `SELECT ${expressions.join(", ")} FROM ${quote(object.schema)}.${quote(object.name)} ORDER BY (SELECT NULL) OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY`,
    { offset, limit },
    true,
  );
  let budget = 2_000_000,
    truncated = false;
  const rows = [];
  for (const row of result.rows) {
    if (budget <= 0) {
      truncated = true;
      break;
    }
    rows.push(
      row.map((v) => {
        if (v === null) return null;
        const text = String(v),
          cell = text.slice(0, Math.max(0, Math.min(4096, budget)));
        budget -= cell.length;
        if (cell.length < text.length) truncated = true;
        return cell + (cell.length < text.length ? "…" : "");
      }),
    );
  }
  return {
    columns: columns.map((c) => c.name),
    rows,
    limit,
    offset,
    truncated,
    has_more: result.rows.length === limit,
  };
}
