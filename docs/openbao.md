# OpenBao secrets and upgrade to 1.4

OpenBao KV v2 is required. PostgreSQL holds connection names, labels, network/database settings, SSL mode, TCP keep-alive and a `secret_ref`. The corresponding `connections/<UUID>` entry holds the password, CA PEM bundle and driver properties. These values are never returned by the profile API or included in metadata snapshots/history. Live credentials exist briefly in app memory during connection operations.

The app needs an initialized, unsealed OpenBao instance and access to the policy in [atlas-policy.hcl](../deploy/openbao/atlas-policy.hcl). Adjust its `secret` prefix if using another `BAO_KV_MOUNT`. The app cannot initialize/unseal OpenBao or manage policies. Do not give it a root token.

## k3s setup

The supplied deployment uses a single OpenBao StatefulSet with encrypted Raft storage on a 1 GiB local-path PVC, HTTPS and Kubernetes authentication. It is not highly available. Use an existing managed OpenBao instance or a replicated deployment if required. Restrict cluster access to port 8200; no public Service or Ingress is created.

1. Supply a server certificate/key signed by your private CA. Its SANs must include `openbao.dbms-metadata.svc` (and any other hostname you use). Keep all private key and initialization files outside Git. Create the namespace, TLS Secret and public CA ConfigMap:

   ```sh
   kubectl apply -f deploy/k3s/namespace.yaml
   kubectl -n dbms-metadata create secret tls openbao-tls \
     --cert=/secure/openbao/server.crt --key=/secure/openbao/server.key
   kubectl -n dbms-metadata create configmap openbao-ca \
     --from-file=ca.crt=/secure/openbao/ca.crt
   kubectl -n dbms-metadata apply -f deploy/k3s/openbao.yaml
   ```

2. Wait for `openbao-0` to be Running. It remains **not Ready** until initialized and unsealed; do not wait for a successful StatefulSet rollout yet. Initialize once, saving the output securely:

   ```sh
   umask 077
   kubectl -n dbms-metadata exec openbao-0 -- \
     bao operator init -key-shares=3 -key-threshold=2 -format=json \
     > /secure/openbao/initialization.json
   ```

   Distribute the unseal shares to separate custodians; keep them apart from the Raft backup. Run the following twice and enter a different share at each hidden prompt:

   ```sh
   kubectl -n dbms-metadata exec -it openbao-0 -- bao operator unseal
   ```

   The manifest uses manual unseal: repeat this after an OpenBao restart. For unattended operation configure an appropriate supported auto-unseal mechanism separately.

3. Copy the policy into the pod's temporary directory, then enter an administrator shell:

   ```sh
   kubectl -n dbms-metadata cp deploy/openbao/atlas-policy.hcl openbao-0:/tmp/atlas-policy.hcl
   kubectl -n dbms-metadata exec -it openbao-0 -- sh
   ```

   Inside that shell, read the initial root token at a hidden prompt and configure the engine and authentication. Do this once on a new instance; if already configured, inspect the existing mounts/roles instead of re-enabling them:

   ```sh
   read -s -p 'Administrator token: ' BAO_TOKEN; echo
   export BAO_TOKEN
   bao secrets enable -path=secret kv-v2
   bao write secret/config max_versions=1
   bao policy write atlas /tmp/atlas-policy.hcl
   bao auth enable kubernetes
   bao write auth/kubernetes/config kubernetes_host=https://kubernetes.default.svc
   bao write auth/kubernetes/role/atlas \
     bound_service_account_names=metadata \
     bound_service_account_namespaces=dbms-metadata \
     audience=openbao policies=atlas ttl=1h
   unset BAO_TOKEN
   exit
   ```

   `openbao-auth` has TokenReview permissions through the included ClusterRoleBinding. Its mounted service-account token and CA let the Kubernetes auth plugin validate the app's projected token. The app service account receives no Kubernetes API role. Its token has audience `openbao`; the app automatically reauthenticates as its short-lived OpenBao token expires. Revoke the bootstrap root token after verifying administrator access through your chosen durable operator authentication method.

## Upgrade an existing app

Back up the PostgreSQL database and `APP_KEY` before upgrading. Keep that key unchanged: the first v1.4 startup decrypts old AES-GCM passwords, writes them to OpenBao and clears `password_encrypted` only after the external write succeeds. Retries reuse the same secret path, including after a crash between the OpenBao write and SQL commit. A failure rolls back SQL migration and leaves the previous ciphertext intact. Existing relational snapshots/history remain available. Legacy v1.1 JSON snapshot storage still requires a fresh database.

Initialize and authorize OpenBao **before** replacing the app. Stop old app replicas to avoid mixed v1.3/v1.4 workers while credential storage changes. On your build server:

```sh
git fetch origin
git switch feat/bulk-connections-openbao
git pull --ff-only
docker build -t docker.io/library/dbms-metadata:1.4.0 .
docker save docker.io/library/dbms-metadata:1.4.0 -o /tmp/dbms-metadata-1.4.0.tar
sudo k3s ctr -n k8s.io images import /tmp/dbms-metadata-1.4.0.tar
# Import on each eligible node before scaling the app back up.
kubectl -n dbms-metadata scale deployment/metadata --replicas=0
kubectl -n dbms-metadata patch deployment metadata --type=strategic \
  --patch-file deploy/k3s/openbao-app.patch.yaml
kubectl -n dbms-metadata set image deployment/metadata app=docker.io/library/dbms-metadata:1.4.0
kubectl -n dbms-metadata scale deployment/metadata --replicas=1
kubectl -n dbms-metadata rollout status deployment/metadata --timeout=180s
```

Preserve `imagePullPolicy: Never`, customized Service/Ingress ports and your `COOKIE_SECURE` setting. The patch adds only OpenBao configuration, projected authentication and CA mounts. It does not create a catch-all Ingress. For a new installation, prepare OpenBao first and then apply `deploy/k3s` with your chosen app image and application Secret.

Do not roll back directly to v1.3 after migration: it expects passwords in PostgreSQL. A rollback needs a coordinated restore of the old database/key. SQL clearing does not erase historical backups or old disk pages; retain/protect those backups and rotate source passwords if cryptographic retirement of the old copies is required.

## Docker Compose

Compose includes a persistent, manually initialized OpenBao server. Its HTTP listener is confined to the Compose network, without a host port. This is appropriate for local development on a trusted host; use HTTPS for production or untrusted container networks.

After copying/editing `.env`, start infrastructure first:

```sh
docker compose up -d postgres openbao
umask 077
docker compose exec -T openbao bao operator init -key-shares=3 -key-threshold=2 -format=json \
  > /secure/openbao/compose-initialization.json
# Run twice, with different shares at the hidden prompts:
docker compose exec openbao bao operator unseal
docker compose exec openbao bao operator unseal
docker compose cp deploy/openbao/atlas-policy.hcl openbao:/tmp/atlas-policy.hcl
docker compose exec openbao sh
```

Inside the shell, authenticate using `read -s -p 'Administrator token: ' BAO_TOKEN; export BAO_TOKEN`, enable KV v2, set `max_versions=1`, and write the policy using the same commands as above. Kubernetes authentication is not used for Compose. Create a scoped token and save it to a temporary private file without printing it:

```sh
umask 077
bao token create -policy=atlas -no-default-policy -orphan -ttl=720h -field=token > /tmp/atlas-token
unset BAO_TOKEN
exit
```

Copy that file to the app's configured token-file location, then remove the temporary copy:

```sh
mkdir -p .secrets
chmod 700 .secrets
docker compose cp openbao:/tmp/atlas-token .secrets/openbao-token
chmod 644 .secrets/openbao-token
docker compose exec openbao rm /tmp/atlas-token
docker compose up --build -d app
```

The parent directory is accessible only to its owner; the file's read mode permits the non-root app UID to read the mounted Docker secret. You can set `BAO_TOKEN_FILE` in `.env` to an alternative private host path. Rotate the token before its 30-day expiry, recreate the app container if the bind-mounted file was replaced, and revoke the old token. Never use a development/root token for a deployed app.

## Configuration and failure behavior

| Variable                    | Purpose                                                                                     |
| --------------------------- | ------------------------------------------------------------------------------------------- |
| `BAO_ADDR`                  | Required OpenBao origin, e.g. `https://openbao.dbms-metadata.svc:8200`                      |
| `BAO_KV_MOUNT`              | KV v2 mount; default `secret`                                                               |
| `BAO_CA_FILE`               | CA bundle for the OpenBao HTTPS connection; certificate/hostname verification stays enabled |
| `BAO_ALLOW_HTTP`            | Explicit `true` allows HTTP on a protected internal network                                 |
| `BAO_KUBERNETES_ROLE`       | Kubernetes auth role; preferred on k3s                                                      |
| `BAO_KUBERNETES_AUTH_MOUNT` | Auth mount; default `kubernetes`                                                            |
| `BAO_KUBERNETES_JWT_FILE`   | Projected service-account token file                                                        |
| `BAO_TOKEN_FILE`            | Alternative scoped token file; read afresh per request                                      |
| `BAO_TOKEN`                 | Alternative token environment variable; convenient for disposable tests                     |
| `BAO_NAMESPACE`             | Optional Vault-compatible namespace header                                                  |

The app fails startup if OpenBao is sealed, unavailable, unauthorized or lacks the KV v2 mount. Readiness checks both PostgreSQL and OpenBao. Existing processes can still answer saved-metadata requests directly during a vault outage; new saves, refresh and preview fail safely, with no fallback to PostgreSQL secret storage. Failed refreshes preserve the last snapshot. Token and certificate values are excluded from user-facing errors.

Removing a connection permanently deletes its OpenBao KV metadata/all versions before deleting its SQL rows. Creation writes OpenBao first and attempts cleanup if SQL fails. A process/network failure between systems can leave an orphan secret; reconcile secret paths against profile IDs during operator maintenance. Do not manually delete SQL profiles as a substitute for the API's delete action.

Back up **both** PostgreSQL and OpenBao Raft storage, together with the corresponding operational key material. A PostgreSQL backup alone no longer contains source credentials. This integration stores source credentials/certificates; the app's PostgreSQL storage password, workspace password, session key, and OpenBao's own bootstrap/TLS material still require protected deployment Secrets.

## Disposable tests

Development mode is used only by automated tests:

```sh
docker run -d --name metadata-bao-test -p 127.0.0.1:58200:8200 \
  -e BAO_DEV_ROOT_TOKEN_ID=atlas-test-root -e BAO_DEV_LISTEN_ADDRESS=0.0.0.0:8200 \
  ghcr.io/openbao/openbao:2.4.4 server -dev
export BAO_ADDR=http://127.0.0.1:58200 BAO_ALLOW_HTTP=true BAO_TOKEN=atlas-test-root
npm test
# Start the disposable PostgreSQL source/backing store first.
sh fixtures/start-pg-tls.sh
TEST_PG_CA_FILE=/tmp/dbms-pg-ca.crt npm run test:integration
npx playwright test
```

The TLS fixture creates a private key in a disposable Docker volume. Stop/remove the fixture container and volume after testing. Test tokens/passwords are public disposable examples and must not be reused in deployed environments.
