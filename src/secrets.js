import http from "node:http";
import https from "node:https";
import { readFileSync } from "node:fs";

export class SecretStoreError extends Error {
  constructor() {
    super(
      "OpenBao is unavailable or access was denied. Check its seal state, authentication and KV v2 policy.",
    );
    this.code = "OPENBAO_UNAVAILABLE";
    this.status = 503;
  }
}
export function createSecretStore(config) {
  if (!config.BAO_ADDR)
    throw new Error(
      "BAO_ADDR is required; connection secrets must be stored in OpenBao",
    );
  const base = new URL(config.BAO_ADDR);
  if (
    !["http:", "https:"].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    base.pathname !== "/"
  )
    throw new Error(
      "BAO_ADDR must be an HTTP(S) origin without credentials or a path",
    );
  if (base.protocol === "http:" && config.BAO_ALLOW_HTTP !== "true")
    throw new Error(
      "Use HTTPS for OpenBao, or explicitly set BAO_ALLOW_HTTP=true on a protected internal network",
    );
  const mount = config.BAO_KV_MOUNT || "secret";
  const authMount = config.BAO_KUBERNETES_AUTH_MOUNT || "kubernetes";
  if (!/^[a-zA-Z0-9_-]+$/.test(mount) || !/^[a-zA-Z0-9_-]+$/.test(authMount))
    throw new Error("Invalid OpenBao mount");
  if (
    !config.BAO_KUBERNETES_ROLE &&
    !config.BAO_TOKEN_FILE &&
    !config.BAO_TOKEN
  )
    throw new Error(
      "Configure OpenBao Kubernetes authentication, BAO_TOKEN_FILE or BAO_TOKEN",
    );
  const ca = config.BAO_CA_FILE ? readFileSync(config.BAO_CA_FILE) : undefined;
  let session = null;
  function raw(path, method = "GET", body, token) {
    return new Promise((resolve, reject) => {
      const data = body === undefined ? undefined : JSON.stringify(body);
      const request = (base.protocol === "https:" ? https : http).request(
        new URL("/v1/" + path, base),
        {
          method,
          ca,
          signal: AbortSignal.timeout(5000),
          headers: {
            "Content-Type": "application/json",
            ...(data ? { "Content-Length": Buffer.byteLength(data) } : {}),
            ...(token ? { "X-Vault-Token": token } : {}),
            ...(config.BAO_NAMESPACE
              ? { "X-Vault-Namespace": config.BAO_NAMESPACE }
              : {}),
          },
        },
        (response) => {
          let text = "";
          response.on("data", (chunk) => {
            text += chunk;
            if (text.length > 1_000_000)
              request.destroy(new SecretStoreError());
          });
          response.on("error", () => reject(new SecretStoreError()));
          response.on("end", () => {
            let json;
            try {
              json = text ? JSON.parse(text) : {};
            } catch {
              return reject(new SecretStoreError());
            }
            resolve({ status: response.statusCode, data: json });
          });
        },
      );
      request.setTimeout(5000, () => request.destroy(new SecretStoreError()));
      request.on("error", () => reject(new SecretStoreError()));
      if (data) request.write(data);
      request.end();
    });
  }
  async function token() {
    try {
      if (config.BAO_KUBERNETES_ROLE) {
        if (!session || session.expires <= Date.now()) {
          const jwt = readFileSync(
            config.BAO_KUBERNETES_JWT_FILE ||
              "/var/run/secrets/kubernetes.io/serviceaccount/token",
            "utf8",
          ).trim();
          const r = await raw(`auth/${authMount}/login`, "POST", {
            role: config.BAO_KUBERNETES_ROLE,
            jwt,
          });
          if (r.status !== 200 || !r.data.auth?.client_token)
            throw new SecretStoreError();
          session = {
            token: r.data.auth.client_token,
            expires:
              Date.now() + Math.max(1, r.data.auth.lease_duration - 30) * 1000,
          };
        }
        return session.token;
      }
      return config.BAO_TOKEN_FILE
        ? readFileSync(config.BAO_TOKEN_FILE, "utf8").trim()
        : config.BAO_TOKEN;
    } catch {
      throw new SecretStoreError();
    }
  }
  async function request(path, method, body) {
    let r = await raw(path, method, body, await token());
    if ([401, 403].includes(r.status) && config.BAO_KUBERNETES_ROLE) {
      session = null;
      r = await raw(path, method, body, await token());
    }
    if (r.status === 404) return null;
    if (r.status < 200 || r.status >= 300) throw new SecretStoreError();
    return r.data;
  }
  const checkRef = (ref) => {
    if (!/^connections\/[a-f0-9-]{36}$/i.test(ref))
      throw new SecretStoreError();
    return ref;
  };
  return {
    async check() {
      const r = await request(`${mount}/config`);
      if (!r?.data || !Object.hasOwn(r.data, "max_versions"))
        throw new SecretStoreError();
    },
    async read(ref, optional = false) {
      const r = await request(`${mount}/data/${checkRef(ref)}`);
      if (r === null && optional) return null;
      if (!r?.data?.data || typeof r.data.data.password !== "string")
        throw new SecretStoreError();
      return r.data.data;
    },
    async write(ref, data) {
      const r = await request(`${mount}/data/${checkRef(ref)}`, "POST", {
        options: { cas: 0 },
        data,
      });
      if (!r?.data?.version) throw new SecretStoreError();
    },
    async remove(ref) {
      await request(`${mount}/metadata/${checkRef(ref)}`, "DELETE");
    },
    async resolve(profile) {
      const secret = await this.read(profile.secret_ref);
      return {
        ...profile,
        password: secret.password,
        caCertificate: secret.caCertificate || "",
        driverProperties: secret.driverProperties || {},
      };
    },
  };
}

// Keep the old ciphertext only until the external write and SQL transaction both
// succeed. Deterministic paths make a retry after a crash safe and idempotent.
export async function migrateConnectionSecrets(pool, store, crypto, config) {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    await db.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('metadata-secrets-migration',0))",
    );
    const rows = (
      await db.query(
        "SELECT id,engine,password_encrypted FROM metadata_connections WHERE secret_ref IS NULL AND password_encrypted IS NOT NULL FOR UPDATE",
      )
    ).rows;
    for (const row of rows) {
      const ref = "connections/" + row.id;
      const secret = {
        password: crypto.open(row.password_encrypted),
        caCertificate:
          (row.engine === "mssql"
            ? config.MSSQL_TARGET_CA
            : config.PG_TARGET_CA) || "",
        driverProperties: {},
      };
      const existing = await store.read(ref, true);
      if (existing) {
        if (
          existing.password !== secret.password ||
          existing.caCertificate !== secret.caCertificate
        )
          throw new SecretStoreError();
      } else await store.write(ref, secret);
      await db.query(
        "UPDATE metadata_connections SET secret_ref=$2,password_encrypted=NULL WHERE id=$1",
        [row.id, ref],
      );
    }
    await db.query("COMMIT");
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally {
    db.release();
  }
}
