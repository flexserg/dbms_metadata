import { test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createSecretStore, migrateConnectionSecrets } from "../src/secrets.js";
import { vault } from "../src/security.js";
import { createApp } from "../src/server.js";
const database =
  process.env.TEST_DATABASE_URL ||
  "postgresql://metadata:integration-password@127.0.0.1:55432/metadata";
test(
  "OpenBao KV v2 persists secrets, enforces CAS and purges all versions",
  { skip: !process.env.INTEGRATION },
  async () => {
    const store = createSecretStore(process.env),
      ref = "connections/" + randomUUID();
    try {
      await store.check();
      await store.write(ref, {
        password: "secret",
        caCertificate: "certificate",
        driverProperties: { application_name: "Atlas" },
      });
      assert.equal((await store.read(ref)).password, "secret");
      await assert.rejects(
        store.write(ref, { password: "replacement" }),
        /OpenBao/,
      );
    } finally {
      await store.remove(ref);
    }
    assert.equal(await store.read(ref, true), null);
  },
);
test(
  "legacy passwords migrate without resetting snapshots and retry safely after an external write",
  { skip: !process.env.INTEGRATION },
  async () => {
    const admin = new pg.Client({ connectionString: database });
    await admin.connect();
    const schema = "secrets_" + randomUUID().replaceAll("-", ""),
      id = randomUUID(),
      ref = "connections/" + id;
    const pool = new pg.Pool({
      connectionString: database,
      options: "-c search_path=" + schema,
    });
    const store = createSecretStore(process.env),
      crypto = vault("ab".repeat(32));
    try {
      await admin.query(
        `CREATE SCHEMA ${schema};CREATE TABLE ${schema}.metadata_connections(id uuid PRIMARY KEY,engine text,password_encrypted text,secret_ref text)`,
      );
      await pool.query(
        "INSERT INTO metadata_connections VALUES($1,'postgres',$2,NULL)",
        [id, crypto.seal("legacy-password")],
      );
      await assert.rejects(
        migrateConnectionSecrets(
          pool,
          createSecretStore({
            ...process.env,
            BAO_TOKEN: "invalid",
            BAO_TOKEN_FILE: undefined,
          }),
          crypto,
          {},
        ),
        /OpenBao/,
      );
      assert.ok(
        (
          await pool.query(
            "SELECT password_encrypted FROM metadata_connections",
          )
        ).rows[0].password_encrypted,
      );
      // Simulate a crash after OpenBao succeeded but before the SQL commit.
      await store.write(ref, {
        password: "legacy-password",
        caCertificate: "",
        driverProperties: {},
      });
      await migrateConnectionSecrets(pool, store, crypto, {});
      await migrateConnectionSecrets(pool, store, crypto, {});
      assert.deepEqual(
        (
          await pool.query(
            "SELECT password_encrypted,secret_ref FROM metadata_connections",
          )
        ).rows[0],
        { password_encrypted: null, secret_ref: ref },
      );
      assert.equal((await store.read(ref)).password, "legacy-password");
    } finally {
      await store.remove(ref);
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);
test(
  "restricted OpenBao token, safe outage behavior, secret deletion and driver properties work through HTTP",
  { skip: !process.env.INTEGRATION },
  async () => {
    const name = "atlas_" + randomUUID().replaceAll("-", "");
    const headers = {
      "Content-Type": "application/json",
      "X-Vault-Token": process.env.BAO_TOKEN,
    };
    async function bao(path, method = "POST", body) {
      const r = await fetch(process.env.BAO_ADDR + "/v1/" + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      assert.ok(r.ok);
      return r.status === 204 ? null : r.json();
    }
    await bao("sys/policies/acl/" + name, "PUT", {
      policy: readFileSync(
        new URL("../deploy/openbao/atlas-policy.hcl", import.meta.url),
        "utf8",
      ),
    });
    const token = (
      await bao("auth/token/create", "POST", {
        policies: [name],
        no_default_policy: true,
        ttl: "1h",
      })
    ).auth.client_token;
    const { app, pool, secrets } = await createApp({
      DATABASE_URL: database,
      APP_KEY: "ab".repeat(32),
      APP_PASSWORD: "integration-password",
      COOKIE_SECURE: "false",
      BAO_TOKEN: token,
      BAO_TOKEN_FILE: undefined,
    });
    const server = app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    const base = "http://127.0.0.1:" + server.address().port;
    let cookie, id;
    async function request(path, method = "GET", body) {
      const r = await fetch(base + path, {
        method,
        headers: {
          "Content-Type": "application/json",
          ...(cookie ? { cookie } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (r.headers.has("set-cookie"))
        cookie = r.headers.get("set-cookie").split(";")[0];
      return { status: r.status, data: await r.json() };
    }
    const u = new URL(database);
    const profile = {
      name: "OpenBao test",
      label: "Reporting",
      host: u.hostname,
      port: Number(u.port),
      database: u.pathname.slice(1),
      username: u.username,
      password: u.password,
      sslMode: "disable",
      keepAlive: false,
      driverProperties: { application_name: "OpenBao test" },
    };
    try {
      await request("/api/login", "POST", { password: "integration-password" });
      const created = await request("/api/connections", "POST", profile);
      assert.equal(created.status, 201);
      id = created.data.id;
      for (let i = 0; i < 100; i++) {
        const job = (await request(`/api/connections/${id}/jobs`)).data.find(
          (j) => j.id === created.data.job.id,
        );
        assert.notEqual(job.status, "failed", job.error);
        if (job.status === "succeeded") break;
        await new Promise((r) => setTimeout(r, 100));
      }
      const listed = (await request("/api/connections")).data.find(
        (c) => c.id === id,
      );
      assert.equal(listed.label, "Reporting");
      assert.equal(listed.keepAlive, false);
      assert.equal(listed.driverProperties, undefined);
      assert.equal(listed.caCertificate, undefined);
      assert.deepEqual(
        (await secrets.read("connections/" + id)).driverProperties,
        profile.driverProperties,
      );
      const saved = (
        await pool.query(
          "SELECT password_encrypted,secret_ref FROM metadata_connections WHERE id=$1",
          [id],
        )
      ).rows[0];
      assert.equal(saved.password_encrypted, null);
      assert.equal(saved.secret_ref, "connections/" + id);
      const unrelated = await fetch(
        process.env.BAO_ADDR + "/v1/secret/data/unrelated",
        { headers: { "X-Vault-Token": token } },
      );
      assert.equal(unrelated.status, 403);
      // Revoking the app's token simulates an OpenBao authentication outage.
      await bao("auth/token/revoke", "POST", { token });
      assert.equal((await request("/health/ready")).status, 503);
      assert.equal(
        (await request(`/api/connections/${id}/schemas`)).status,
        200,
      );
      assert.equal(
        (await request("/api/connections", "POST", profile)).status,
        503,
      );
      assert.equal(
        (
          await pool.query(
            "SELECT count(*)::int n FROM metadata_connections WHERE id=$1",
            [id],
          )
        ).rows[0].n,
        1,
      );
    } finally {
      if (id) {
        await createSecretStore(process.env).remove("connections/" + id);
        await pool.query("DELETE FROM metadata_connections WHERE id=$1", [id]);
      }
      await new Promise((r) => server.close(r));
      await pool.end();
      await bao("sys/policies/acl/" + name, "DELETE");
    }
  },
);
