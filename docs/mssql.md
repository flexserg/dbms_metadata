# SQL Server sources

Choose **SQL Server** in the connection dialog. PostgreSQL remains the application's storage database (`DATABASE_URL`); PostgreSQL and SQL Server sources can coexist in one workspace. Both use encrypted connection profiles, relational snapshots, manual/scheduled refresh, logical keys, history retention and live preview.

## Connect and grant access

Use SQL authentication and a TCP address/port (default `1433`). For a named instance, configure a static TCP port and enter it explicitly. SQL Browser discovery, Windows integrated authentication and Microsoft Entra authentication are not implemented. The source must be reachable from the app pod; no SQL Server container needs to be deployed alongside the app.

Verified TLS is the default. Use the certificate's hostname and a trusted certificate chain; set `MSSQL_TARGET_CA` to a PEM CA certificate for a private CA. **Encrypt, trust server certificate** explicitly accepts a self-signed certificate without checking its identity. Disabled TLS is available for trusted networks.

A DBA can grant the following to an existing database user mapped to a dedicated SQL login. Replace the database/user/schema names:

```sql
USE [YourDatabase];
GRANT CONNECT TO [metadata_reader];
GRANT VIEW DEFINITION TO [metadata_reader];
GRANT SELECT ON OBJECT::sys.sql_expression_dependencies TO [metadata_reader];
-- Optional: required for data preview, for each schema you want to preview.
GRANT SELECT ON SCHEMA::[dbo] TO [metadata_reader];
```

No server administrator or VIEW DATABASE STATE permission is required. Catalog visibility follows the user's permissions; encrypted modules and inaccessible definitions cannot be displayed. Explicit DENY permissions can further restrict visibility.

The adapter issues SELECT queries in a repeatable-read transaction and rolls it back on completion. SQL Server has no PostgreSQL-style read-only transaction: source permissions must prohibit writes. The driver's read-only application intent controls routing, not authorization. Connections time out after five seconds, individual requests after ten seconds, and lock waits after five seconds.

## Metadata and preview

Captured metadata includes:

- User schemas, tables, views, owners, descriptions, estimated rows and storage sizes.
- Columns, exact type length/precision/scale, NULL allowance, defaults, identity seed/increment, computed expressions and persistence, alias types and table-type attributes.
- Ordered primary, unique and foreign keys, referenced columns, update/delete actions, CHECK/default constraints and enabled/trusted status.
- Index names, methods, uniqueness, ordered keys, included columns, filters, constraint links and columnstore members. Index definitions are catalog summaries; they are not complete restoration scripts for every storage, XML or hash-index option.
- Functions/procedures, parameters and visible module definitions.
- Range partition functions, schemes, keys, RANGE LEFT/RIGHT, boundaries, filegroups and estimated partition rows.

SQL Server partitions are physical partitions within a table, rather than child tables. The **Partitions** tab displays them in a dedicated grid. They are persisted in `metadata_sqlserver_partitions`; unbounded ends display as infinity, while an actual SQL NULL boundary displays as `NULL`. Row estimates are refreshed but excluded from change history. PostgreSQL composite nesting and table inheritance remain specific to PostgreSQL; SQL Server alias, CLR and table types use its own catalog model.

Source identifiers are scoped per connection. Index identifiers combine the table's object ID with its local index ID, since SQL Server index IDs are only unique within a table. Structural changes produce the same previous/new value history and expandable refresh-job groups as PostgreSQL sources.

Preview opens immediately with a loading indicator and uses the shared compact grid and pagination limits. Values are returned as text to preserve bigint/decimal precision, with round-trip floats, ISO date/time values and hexadecimal binary data. Preview rows are never saved in the metadata database or history. A preview requires SELECT permissions and can evaluate expressions in source views.

## Upgrade on k3s

Existing **v1.2 relational storage upgrades additively at startup**. Keep its database, PVC, Secret and `APP_KEY`; existing PostgreSQL profiles and history remain available. New profile engine fields default to PostgreSQL. The older v1.1 JSON snapshot layout still requires a fresh application database, as described in the main README.

Version **1.4 requires OpenBao** for credentials, CA certificates and custom driver properties. Follow the [OpenBao setup and local build/import upgrade](openbao.md) for branch `feat/bulk-connections-openbao` and image `1.4.0`. Preserve customized Service/Ingress ports, `imagePullPolicy: Never` and your HTTP/HTTPS cookie setting. Then add a SQL Server profile in the workspace. No change to the source database schema is required.

## Development tests

The suite runs against SQL Server 2022 Developer; the adapter targets SQL Server 2019 and later. Use disposable test instances. Tests create uniquely named databases and logins and remove them afterward. Their setup account needs permission to create/drop databases and logins; this is separate from the restricted reader used by the application.

```sh
docker run -d --name metadata-mssql-test --memory=4g \
  -e ACCEPT_EULA=Y -e MSSQL_PID=Developer \
  -e MSSQL_SA_PASSWORD='Metadata_Test_2026!' \
  -e MSSQL_MEMORY_LIMIT_MB=2048 \
  -p 127.0.0.1:51433:1433 mcr.microsoft.com/mssql/server:2022-latest
# Wait until SQL Server reports it is ready for client connections.
# Also start a disposable PostgreSQL backing database on port 55432.
# Start disposable OpenBao and export its variables as shown in docs/openbao.md.
npm run test:mssql
MSSQL_INTEGRATION=1 npx playwright test e2e/mssql.spec.js
```

Override `TEST_MSSQL_HOST`, `TEST_MSSQL_PORT`, `TEST_MSSQL_USER`, `TEST_MSSQL_PASSWORD` and `TEST_DATABASE_URL` for other disposable instances. Set `CHROMIUM_PATH=/usr/bin/chromium` when using an installed system browser. GitHub Actions runs the SQL Server integration and browser tests alongside the PostgreSQL suite.
