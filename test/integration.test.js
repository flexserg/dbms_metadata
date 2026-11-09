import { test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { createApp } from "../src/server.js";
import { withTarget } from "../src/metadata.js";

test(
  "explicit HTTP mode permits scripts and session cookies while HTTPS remains the default",
  { skip: !process.env.INTEGRATION },
  async () => {
    for (const mode of ["false", "true", undefined]) {
      const config = {
        DATABASE_URL:
          process.env.TEST_DATABASE_URL ||
          "postgresql://metadata:integration-password@127.0.0.1:55432/metadata",
        APP_PASSWORD: "integration-password",
        APP_KEY: "ab".repeat(32),
        COOKIE_SECURE: mode,
      };
      const { app, pool } = await createApp(config);
      const server = app.listen(0, "127.0.0.1");
      await new Promise((resolve) => server.once("listening", resolve));
      const url = `http://127.0.0.1:${server.address().port}`;
      try {
        const page = await fetch(url);
        assert.equal(page.status, 200);
        const csp = page.headers.get("content-security-policy");
        assert.match(csp, /script-src 'self'/);
        assert.equal(
          csp.includes("upgrade-insecure-requests"),
          mode !== "false",
        );
        assert.equal(
          page.headers.has("strict-transport-security"),
          mode !== "false",
        );
        assert.equal((await fetch(url + "/app.js")).status, 200);
        const login = await fetch(url + "/api/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ password: config.APP_PASSWORD }),
        });
        assert.equal(login.status, 200);
        const cookie = login.headers.get("set-cookie");
        assert.equal(/; Secure(?:;|$)/.test(cookie), mode !== "false");
        if (mode === "false") {
          const session = await fetch(url + "/api/session", {
            headers: { cookie: cookie.split(";")[0] },
          });
          assert.equal(session.status, 200);
        }
      } finally {
        await new Promise((resolve) => server.close(resolve));
        await pool.end();
      }
    }
  },
);

test(
  "PostgreSQL-backed API authenticates, persists encrypted connections and reads real metadata",
  { skip: !process.env.INTEGRATION },
  async () => {
    const database =
      process.env.TEST_DATABASE_URL ||
      "postgresql://metadata:integration-password@127.0.0.1:55432/metadata";
    const admin = new pg.Client({ connectionString: database });
    await admin.connect();
    await admin.query(`CREATE SCHEMA IF NOT EXISTS fixture;
    CREATE TABLE IF NOT EXISTS fixture.parent (id integer PRIMARY KEY, label text NOT NULL);
    CREATE TABLE IF NOT EXISTS fixture.child (id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY, parent_id integer REFERENCES fixture.parent(id), note text DEFAULT 'hello');
    CREATE INDEX IF NOT EXISTS child_note_idx ON fixture.child(note);
    CREATE OR REPLACE VIEW fixture.labels AS SELECT id,label FROM fixture.parent;
    CREATE OR REPLACE FUNCTION fixture.double_it(integer) RETURNS integer LANGUAGE SQL IMMUTABLE AS 'SELECT $1 * 2';`);
    const config = {
      DATABASE_URL: database,
      APP_PASSWORD: "integration-password",
      APP_KEY: "ab".repeat(32),
      COOKIE_SECURE: "false",
    };
    const { app, pool } = await createApp(config);
    const server = app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    const url = `http://127.0.0.1:${server.address().port}`;
    let cookie;
    const request = async (path, method = "GET", body) => {
      const r = await fetch(url + path, {
        method,
        headers: {
          "Content-Type": "application/json",
          ...(cookie ? { cookie } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      return {
        status: r.status,
        body: await r.json(),
        cookie: r.headers.get("set-cookie"),
      };
    };
    let id;
    try {
      assert.equal((await request("/health/ready")).status, 200);
      assert.equal((await request("/api/connections")).status, 401);
      assert.equal(
        (await request("/api/login", "POST", { password: "wrong" })).status,
        401,
      );
      const login = await request("/api/login", "POST", {
        password: config.APP_PASSWORD,
      });
      assert.equal(login.status, 200);
      cookie = login.cookie.split(";")[0];
      const parsed = new URL(database);
      const connection = {
        name: "Integration",
        host: parsed.hostname,
        port: Number(parsed.port),
        database: parsed.pathname.slice(1),
        username: parsed.username,
        password: parsed.password,
        sslMode: "disable",
      };
      assert.equal(
        (await request("/api/connections/test", "POST", connection)).body
          .database,
        "metadata",
      );
      const created = await request("/api/connections", "POST", connection);
      assert.equal(created.status, 201);
      id = created.body.id;
      const list = (await request("/api/connections")).body;
      assert.ok(list.some((c) => c.id === id));
      assert.equal(list.find((c) => c.id === id).password, undefined);
      const stored = (
        await pool.query(
          "SELECT password_encrypted FROM metadata_connections WHERE id=$1",
          [id],
        )
      ).rows[0];
      assert.ok(!stored.password_encrypted.includes(parsed.password));
      assert.ok(
        (await request(`/api/connections/${id}/schemas`)).body.some(
          (s) => s.name === "fixture",
        ),
      );
      const objects = (
        await request(`/api/connections/${id}/objects?schema=fixture`)
      ).body;
      const child = objects.find((o) => o.name === "child");
      assert.ok(child);
      const detail = (
        await request(`/api/connections/${id}/detail?oid=${child.id}`)
      ).body;
      assert.ok(
        detail.columns.some(
          (c) => c.name === "id" && c.primary_key && c.identity === "a",
        ),
      );
      assert.ok(detail.constraints.some((c) => c.type === "f"));
      assert.ok(detail.indexes.some((i) => i.name === "child_note_idx"));
      const view = objects.find((o) => o.name === "labels");
      assert.match(
        (await request(`/api/connections/${id}/detail?oid=${view.id}`)).body
          .definition,
        /SELECT/,
      );
      assert.ok(
        (
          await request(`/api/connections/${id}/routines?schema=fixture`)
        ).body.some((r) => r.name === "double_it"),
      );
      assert.equal(
        (await request(`/api/connections/${id}/detail?oid=1;DROP`)).status,
        400,
      );
      assert.deepEqual(
        (
          await request(
            `/api/connections/${id}/objects?schema=${encodeURIComponent("'; DROP SCHEMA fixture CASCADE; --")}`,
          )
        ).body,
        [],
      );
      await assert.rejects(
        withTarget(connection, (c) =>
          c.query("CREATE TABLE fixture.forbidden(id int)"),
        ),
        /read-only/,
      );
      const csrf = await fetch(url + "/api/connections", {
        method: "POST",
        headers: {
          cookie,
          "Content-Type": "application/json",
          Origin: "https://evil.example",
        },
        body: JSON.stringify(connection),
      });
      assert.equal(csrf.status, 403);
      assert.equal(
        (await request(`/api/connections/${id}`, "DELETE", {})).status,
        200,
      );
      id = null;
      await request("/api/logout", "POST", {});
    } finally {
      if (id)
        await pool.query("DELETE FROM metadata_connections WHERE id=$1", [id]);
      await new Promise((r) => server.close(r));
      await pool.end();
      await admin.end();
    }
  },
);
