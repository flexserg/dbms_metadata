# Atlas · Database metadata workspace

A web GUI inspired by DBeaver's database navigator for PostgreSQL and Microsoft SQL Server sources. Node.js serves the interface and API; PostgreSQL stores encrypted connection profiles, the latest complete metadata snapshot in relational tables, and a history of changes. Browsing uses persisted metadata; only refresh and data preview contact the source. Existing v1.2 relational storage upgrades additively; older JSON snapshots/history require a fresh database.

See [SQL Server connections, permissions and metadata](docs/mssql.md) for SQL authentication, TLS options and source-specific behavior.

Features: saved/testable connections; schema and relation navigation; columns, generated expressions, primary/foreign/logical keys, constraints, indexes, partitions, view definitions, and function/procedure definitions. Includes manual/scheduled refresh jobs, table change history, filtering, live data preview, owners, estimated row counts, and storage sizes.

This release explores metadata. It has no SQL editor, row editor, or full table DDL export. Row counts are planner estimates and may be unavailable until ANALYZE. System schemas and aggregates are excluded.

## Run locally

Requires Docker Compose, or Node.js 22+ and PostgreSQL 14+ (tested on Node 24 / PostgreSQL 17).

```sh
cp .env.example .env
# Edit .env with random passwords and APP_KEY (openssl rand -hex 32).
docker compose up --build -d
docker compose logs -f app
```

Open http://localhost:3000 and sign in with `APP_PASSWORD` (12+ characters). Use URL-safe characters for `POSTGRES_PASSWORD`, such as random hex. The port binds to loopback and local Compose uses HTTP cookies. In the connection dialog, you can explore the backing database with host `postgres`, port `5432`, database/user `metadata`, your database password, and TLS disabled. Other target addresses must be reachable from the application container.

For local development against an existing PostgreSQL database:

```sh
npm ci
export DATABASE_URL='postgresql://USER:PASSWORD@127.0.0.1:5432/metadata'
export APP_KEY='YOUR_64_HEX_CHARACTERS'
export APP_PASSWORD='YOUR_LONG_WORKSPACE_PASSWORD'
export COOKIE_SECURE=false
npm run dev
```

The app creates/upgrades its tables at startup; the storage role must own existing application tables and have CREATE in its default schema. Use a dedicated target role with CONNECT, catalog visibility, and schema USAGE as needed, without write privileges. Data preview additionally requires SELECT on the target relation. PostgreSQL source requests use read-only, repeatable-read transactions, a five-second connection timeout, and an eight-second timeout per statement. SQL Server uses repeatable-read transactions and source permissions to prohibit writes; see its setup guide above.

## Snapshots, refresh jobs, and history

New connections capture an initial baseline automatically. Click **Refresh metadata** to enqueue a job and view its result; **Refresh jobs** lists queued, running, succeeded, and failed attempts. An initial baseline has zero change entries because there is no earlier observation.

Set **Auto-refresh (minutes)** and save the schedule: `0` disables scheduling; `1–10080` refreshes periodically. The application checks schedules and durable queued jobs every 30 seconds. No separate CronJob is needed. Database session advisory locks serialize refreshes per connection across app replicas, and duplicate requests reuse an active job. Interrupted running jobs are marked failed after restart when the worker can acquire their released lock; queued jobs resume. Failed attempts do not replace the last successful snapshot and retry automatically at the next scheduled interval, or manually.

The latest snapshot is stored in typed relational tables with primary keys, foreign keys and ordered attribute tables. `metadata_snapshots` contains only its header and database-level statistics, with one row per connection; there is no `payload` column. Schemas, relations, columns, types/attributes, constraints/columns, indexes/attributes, inheritance, partitions and routines occupy their own tables. See [the relational data model](docs/relational-model.md), with direct SQL examples. Refresh replaces the current rows atomically in one transaction together with the job result and history. It retains no complete older snapshot.

`metadata_refresh_jobs` stores job status, timestamps, trigger, errors, and change counts. Only `metadata_changes.previous_value` and `new_value` use JSONB to accommodate heterogeneous historical field values. Additions/removals retain the added/removed object, with the missing side set to null. No-change jobs have zero change rows. Planner row estimates, disk sizes, and schema relation counts are refreshed but excluded from structural history. The API still returns JSON assembled from SQL rows; batched inserts also use transient JSON parameters decoded into typed columns, never saved as a snapshot document.

The table **Change history** tab includes only objects owned by the selected table and its descendants, including declarative partitions and ordinary/multiple inheritance. Parent-only changes, sibling tables and incoming foreign keys owned by other tables are excluded. Observed parent/child edges are retained so dropped descendants remain searchable in history. History follows renames using PostgreSQL OIDs and column positions. Connection-level history includes every retained change. History initially displays collapsed job/time groups; expanding a group loads its changes, with pagination inside each job and across job groups. Refresh jobs show the latest 100 status summaries.

Open **History settings** to set retention days per connection: `0` keeps change entries indefinitely; a positive value deletes entries older than that many days during the 30-second worker cycle. The same dialog provides manual deletion for the selected table/subtree or the entire connection, with an optional cutoff date and confirmation. Cleanup deletes change values, while keeping job status summaries and the latest snapshot. Removing a connection deletes all of its application data. Refresh existing connections once after upgrading to collect ordinary-inheritance relationships.

History describes differences observed **between captures**, not every DDL statement. Changes reverted between refreshes are not detectable. Database restore/recreation can change/reuse OIDs; use a new connection/baseline for a replaced source database. The capture covers user schemas, supported relations, columns, constraints, indexes, partition families, and functions/procedures; it is not a full PostgreSQL backup or trigger/privilege audit.

Table tabs:

| Tab            | Fields                                                                                                                                                                   |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Columns        | Name, type, NULL allowance, default/identity/generated expression, comment                                                                                               |
| Keys           | Primary and platform logical primary key names/attributes; FK names, ordered attributes, referenced table/attributes, ON DELETE/UPDATE, validation status                |
| Indexes        | All indexes including constraint indexes, access method, key expressions/attributes, INCLUDE columns, uniqueness, linked constraint, validity/readiness, full definition |
| Constraints    | UNIQUE/CHECK/EXCLUDE and other catalog constraint types, ordered attributes, condition/definition, validation status, deferrability                                      |
| Partitions     | Expandable subtree starting at the selected table (level 0); own RANGE/LIST/HASH method and key, bounds assigned by the parent                                           |
| Data preview   | Live read-only rows, 50 per UI page; API maximum 100, offset maximum 100000, cell/output truncation                                                                      |
| Change history | Job/time, object, operation, changed field, previous value, new value                                                                                                    |

**Define logical primary key** on the Keys tab stores one logical key per table in the platform. Select attributes in table column order. This does not create a source constraint or verify/enforce uniqueness. Edits are recorded immediately as `logical-key` jobs and overlaid on later source captures. Removed source columns invalidate the logical key until edited. Only source capture updates the displayed snapshot timestamp.

Composite columns expand into their attributes on the Columns tab, recursively including nested composites, arrays of composites, and domains over composites. Definitions are stored in `metadata_types` and `metadata_type_attributes` and remain available offline; recursive references are marked instead of expanding forever. Scalar/system types and namespaces are stored to enforce type-reference integrity, but system schemas remain hidden in navigation. Table details load only the type graph reachable from that table's columns. Changes to named composite attributes are linked to the tables using them, including indirect nested references.

Partition parents expand/collapse on both Objects and Partitions tabs. A selected child shows itself and descendants, not ancestors or siblings; its actual parent name is still displayed. **Own partition method/key** describe how that table partitions its children; **Bounds in parent** describe how the parent routes rows into that table. A leaf has bounds but no own method/key. A subpartitioned child can have both bounds and its own, different method/key. Hover over bounds to see the parent's partitioning scheme.

Data preview opens immediately with a loading indicator, shows errors and a retry action in the tab, and ignores late responses after navigation away. Its compact grid, sticky headers and scrolling are styled separately in `public/preview.css`; metadata tables retain their normal spacing. Preview is never persisted or added to history. It uses the target role's SELECT permissions and row-level policies. Rows have no guaranteed ordering and concurrent writes can shift page boundaries. Output is limited to 4096 characters per cell and approximately two million characters per response; the source query can still read large underlying values. Views/foreign tables may execute source-side expressions under the read-only transaction.

Authenticated API endpoints (under `/api/connections/:id`): `POST /refresh` returns HTTP 202 with a job; `GET /jobs`, `/snapshot`, `/history?oid=TABLE_OID&before=CHANGE_ID&limit=100`; `PATCH /schedule` with `{ "minutes": 5 }`; `GET /preview?oid=TABLE_OID&limit=50&offset=0`; `PUT /logical-key?oid=TABLE_OID` with `{ "name": "business_pk", "positions": [1,2] }` or `{ "remove": true }`. Navigation endpoints read the saved snapshot and return 409 until a first capture succeeds.

## Deploy to k3s

The manifests include a PostgreSQL StatefulSet with a 5 GiB `local-path` PVC, an app Deployment, internal Services, health probes, and resource limits. Local-path storage is node-local and this database is not highly available. Use managed PostgreSQL and backups if higher availability is needed.

1. Build and push an image, then set its name in `deploy/k3s/app.yaml`. The default GHCR image is an example; this project does not automatically publish it. Private registries require an imagePullSecret.

   ```sh
   docker build -t YOUR_REGISTRY/dbms-metadata:1.0.0 .
   docker push YOUR_REGISTRY/dbms-metadata:1.0.0
   ```

2. Prepare a private env file **outside Git** with `POSTGRES_PASSWORD`, `DATABASE_URL`, `APP_KEY`, and `APP_PASSWORD`. Use `postgresql://metadata:URL_ENCODED_PASSWORD@postgres:5432/metadata` as DATABASE_URL, with the same password as POSTGRES_PASSWORD.

   ```sh
   kubectl apply -f deploy/k3s/namespace.yaml
   kubectl -n dbms-metadata create secret generic metadata-secrets --from-env-file=/secure/path/metadata.env
   kubectl apply -k deploy/k3s
   kubectl -n dbms-metadata rollout status statefulset/postgres
   kubectl -n dbms-metadata rollout status deployment/metadata
   ```

3. Edit `deploy/k3s/ingress.example.yaml` with your hostname and an existing TLS Secret, then apply it. It uses k3s's bundled Traefik. Configure DNS and provision the certificate separately (for example using cert-manager).

   ```sh
   kubectl apply -f deploy/k3s/ingress.example.yaml
   ```

The deployment trusts one reverse proxy and requires HTTPS cookies. Expose the app through that ingress and restrict direct Service access. The app runs non-root with a read-only root filesystem and dropped capabilities. PostgreSQL runs as UID 999 with a writable PVC. Protect Secrets with RBAC and encryption at rest. Back up the storage database and APP_KEY together: losing or changing the key makes saved passwords unreadable.

### Update an existing k3s server without a registry

**Upgrading from v1.2 relational storage:** keep the existing application database, PVC, Secret and `APP_KEY`. SQL Server support adds tables/columns automatically at startup and preserves PostgreSQL profiles, snapshots and history. Continue with the build/import commands below.

**Upgrading from v1.1 or earlier JSONB snapshot storage:** storage version 2 requires a fresh database. Legacy profiles, snapshots and history are not migrated; startup refuses the old layout. Create a new application database on the existing PostgreSQL server/PVC:

```sh
kubectl -n dbms-metadata exec postgres-0 -- createdb -U metadata metadata_v2
```

For this older layout only, update the `metadata-secrets` Secret's `DATABASE_URL` to `postgresql://metadata:URL_ENCODED_PASSWORD@postgres:5432/metadata_v2` through your private configuration. Keep the other required keys and add source connections again after upgrading.

For either upgrade path, pull this branch (preserving local Service/Ingress edits), build and import a new tag, and update only the app Deployment:

```sh
git fetch origin
git switch feat/mssql-metadata
git pull --ff-only
docker build -t docker.io/library/dbms-metadata:1.3.0 .
docker save docker.io/library/dbms-metadata:1.3.0 -o /tmp/dbms-metadata-1.3.0.tar
sudo k3s ctr -n k8s.io images import /tmp/dbms-metadata-1.3.0.tar
kubectl -n dbms-metadata set image deployment/metadata app=docker.io/library/dbms-metadata:1.3.0
kubectl -n dbms-metadata rollout status deployment/metadata --timeout=180s
```

Keep `imagePullPolicy: Never` and your existing `COOKIE_SECURE=false` setting if serving trusted HTTP. Import the image on every eligible k3s node. Save these choices in your local configuration. Do not reapply unmodified base manifests over customized Service/Ingress ports. Relational tables are initialized automatically at application startup. For local Compose, existing v1.2 storage can be reused; older JSONB storage needs a new project/volume or empty backing database.

## Configuration and access

| Variable        | Purpose                                                                                                                     |
| --------------- | --------------------------------------------------------------------------------------------------------------------------- |
| DATABASE_URL    | Required application storage PostgreSQL URL                                                                                 |
| APP_KEY         | Required 32-byte encryption/signing key, encoded as 64 hex characters                                                       |
| APP_PASSWORD    | Required shared workspace password, minimum 12 characters                                                                   |
| PORT            | HTTP port; default 3000                                                                                                     |
| COOKIE_SECURE   | Default true; false enables HTTP cookies and disables forced HTTPS asset upgrades / HSTS; use only on trusted HTTP networks |
| TRUST_PROXY     | Set 1 only behind a trusted single reverse proxy                                                                            |
| PG_TARGET_CA    | Optional PEM CA certificate for private target database CAs                                                                 |
| MSSQL_TARGET_CA | Optional PEM CA certificate for private SQL Server target CAs                                                               |

Target TLS supports verified certificates/hostnames or explicitly disabled TLS for trusted networks. SQL Server also offers explicit encrypted connections that trust a self-signed server certificate. Storage TLS uses node-postgres connection URL options. `/health/live` checks the process; `/health/ready` checks storage, not every saved target.

For a trusted HTTP-only k3s deployment, set the app Deployment's `COOKIE_SECURE` value to `"false"`. This allows the browser to load scripts over HTTP and retain the login cookie. Keep the default `"true"` when using HTTPS. After changing the Deployment, wait for its rollout and reload the page. This option does not configure TLS on the server.

All signed-in operators share access to all saved connections. Use an organizational access gateway and cluster egress policies to constrain target networks. Connection passwords use AES-256-GCM. Session cookies are HttpOnly, SameSite=Strict, and last eight hours. Password rotation invalidates existing sessions; logout removes the browser cookie but copied tokens remain valid until expiration or rotation. Login throttling is per app process. Profiles can be removed and recreated when their settings change.

## Tests

```sh
npm ci
npm test
# Use a disposable PostgreSQL database; fixtures remain for manual exploration.
TEST_DATABASE_URL=postgresql://metadata:integration-password@127.0.0.1:55432/metadata npm run test:integration
# Run after integration tests to reuse the catalog fixtures:
npx playwright install chromium
npx playwright test
```

Integration tests exercise real PostgreSQL and HTTP: authentication, encrypted persistence, schema navigation, column/identity/key/index metadata, view/function definitions, SQL parameter handling, cross-origin rejection, and read-only enforcement. Browser tests exercise login, connection creation/testing/removal, metadata navigation, filtering, view definitions, and mobile layout. If using a system browser, set `CHROMIUM_PATH=/usr/bin/chromium`. Browser tests use the disposable database on port 55432. GitHub Actions runs tests and builds the container.

For a cloud build behind a TLS-inspecting proxy, mount the supplied CA without adding it to image layers:

```sh
docker build --secret id=proxy_ca,src="$CODEX_PROXY_CERT" -t dbms-metadata:local .
```

Never commit credentials, .env files, dependency directories, or database volumes.
