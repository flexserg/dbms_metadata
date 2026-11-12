# Connection wizard and bulk PostgreSQL capture

**New connection** first offers PostgreSQL and SQL Server with local database logos. Choose a type to open the second step with three blocks:

1. **Main parameters:** connection name, label, host, port, database, username and password.
2. **SSL parameters:** SSL mode and a CA PEM bundle, pasted or loaded from a file (up to 64 KiB). PostgreSQL supports disabled TLS, required encryption without verification, CA verification without hostname verification, and full CA/hostname verification. SQL Server retains full verification, explicit encrypted trust of the server certificate and disabled TLS. Full verification is the default.
3. **Advanced parameters:** PostgreSQL TCP keep-alive, enabled by default, and user-added driver property name/value rows. Add/remove rows as needed. Property values are validated and applied to both connection tests and subsequent refresh/preview operations.

**Change database type** returns to the first step. Main fields are retained; driver property rows reset when choosing a type so options from the other driver are not carried across. Closing and reopening the dialog clears its sensitive inputs. Certificates are CA trust bundles, rather than client authentication certificates/private keys.

## Supported driver properties

| PostgreSQL property                   | Value                                                             |
| ------------------------------------- | ----------------------------------------------------------------- |
| `application_name`                    | Text                                                              |
| `options`                             | PostgreSQL startup option string, such as `-c search_path=public` |
| `connectionTimeoutMillis`             | 100–60000 ms                                                      |
| `query_timeout`                       | 100–60000 ms                                                      |
| `statement_timeout`                   | 100–60000 ms, applied inside the read-only transaction            |
| `lock_timeout`                        | 100–60000 ms                                                      |
| `idle_in_transaction_session_timeout` | 100–60000 ms                                                      |
| `keepAliveInitialDelayMillis`         | 0–60000 ms                                                        |

| SQL Server property | Value             |
| ------------------- | ----------------- |
| `appName`           | Text              |
| `connectionTimeout` | 100–60000 ms      |
| `requestTimeout`    | 100–60000 ms      |
| `packetSize`        | 512–32768 bytes   |
| `useUTC`            | `true` or `false` |

The list reflects the Node.js drivers actually used by Atlas, rather than JDBC properties from DBeaver. Unknown properties, duplicates, invalid values and credential/TLS overrides are rejected. At most 16 custom properties are accepted. Names/types/ranges are also available from authenticated `GET /api/connection-options`. The app retains transaction protection regardless of driver properties.

## Bulk capture

PostgreSQL refresh now executes **10 catalog queries**, independent of the number of tables or schemas: overview, schemas, relations, attributes, constraints, indexes, partition nodes, routines, and the two existing data-type queries. Results carry owning relation IDs and are grouped in memory. There are no per-table queries or per-schema routine queries. Queries are adapted from the supplied `pg_metadata.sql`, preserving the app's existing support for views, materialized views, foreign tables, expressions and ordered composite keys.

Partition nodes are read once; descendant-only trees are assembled for each selected relation. Indexes retain expression keys, INCLUDE members, linked constraints and complete `pg_get_indexdef` definitions. The PostgreSQL 15+ NULLS NOT DISTINCT flag is stored in `metadata_indexes.nulls_not_distinct`; it is unavailable on older servers. Data-type retrieval remains unchanged, including nested composite graphs.

The relational snapshot model remains intact. The API assembles JSON responses from typed SQL tables. Only the latest complete snapshot is retained; refresh history continues to store field-level deltas. Credentials, CA certificates and driver properties live in [OpenBao](openbao.md), not in snapshots or history.
