# Atlas · PostgreSQL metadata workspace

A web GUI inspired by DBeaver's database navigator. Node.js serves the interface and API; PostgreSQL stores encrypted connection profiles. Target databases are queried live.

Features: saved/testable connections; schema and relation navigation; columns, types, nullability, defaults, identity columns, comments, primary/foreign keys, constraints, indexes, view definitions, and function/procedure definitions. Includes filtering, catalog refresh, owners, estimated row counts, and storage sizes.

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

The app creates `metadata_connections` at startup; the storage role needs CREATE in its default schema. Use a dedicated target role with CONNECT, catalog visibility, and schema USAGE as needed, without write privileges. Catalog requests use read-only transactions, a five-second connection timeout, and an eight-second statement timeout.

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

## Configuration and access

| Variable      | Purpose                                                                                                                     |
| ------------- | --------------------------------------------------------------------------------------------------------------------------- |
| DATABASE_URL  | Required application storage PostgreSQL URL                                                                                 |
| APP_KEY       | Required 32-byte encryption/signing key, encoded as 64 hex characters                                                       |
| APP_PASSWORD  | Required shared workspace password, minimum 12 characters                                                                   |
| PORT          | HTTP port; default 3000                                                                                                     |
| COOKIE_SECURE | Default true; false enables HTTP cookies and disables forced HTTPS asset upgrades / HSTS; use only on trusted HTTP networks |
| TRUST_PROXY   | Set 1 only behind a trusted single reverse proxy                                                                            |
| PG_TARGET_CA  | Optional PEM CA certificate for private target database CAs                                                                 |

Target TLS supports verified certificates/hostnames or explicitly disabled TLS for trusted networks. Storage TLS uses node-postgres connection URL options. `/health/live` checks the process; `/health/ready` checks storage, not every saved target.

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
