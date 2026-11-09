import { test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { createApp } from "../src/server.js";
import { withTarget } from "../src/metadata.js";
import { randomUUID } from "node:crypto";

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
  "snapshots replace the baseline atomically; jobs retain only deltas and table history survives offline sources",
  { skip: !process.env.INTEGRATION },
  async () => {
    const database =
      process.env.TEST_DATABASE_URL ||
      "postgresql://metadata:integration-password@127.0.0.1:55432/metadata";
    const schema = "snap_" + randomUUID().replaceAll("-", "");
    const admin = new pg.Client({ connectionString: database });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema};
    CREATE TABLE ${schema}.parent(id integer PRIMARY KEY);
    CREATE TABLE ${schema}.items(id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY, parent_id integer,
      note text DEFAULT 'old', generated_note text GENERATED ALWAYS AS (upper(note)) STORED,
      CONSTRAINT items_fk FOREIGN KEY(parent_id) REFERENCES ${schema}.parent(id) ON DELETE CASCADE ON UPDATE RESTRICT,
      CONSTRAINT items_unique UNIQUE(note), CONSTRAINT items_check CHECK(length(note)>0));
    CREATE INDEX items_partial ON ${schema}.items USING btree(lower(note)) INCLUDE(parent_id) WHERE note IS NOT NULL;
    COMMENT ON COLUMN ${schema}.items.note IS 'Original comment';
    INSERT INTO ${schema}.items(note) VALUES('one'),('two');
    CREATE TABLE ${schema}.events(id integer,month integer) PARTITION BY RANGE(month);
    CREATE TABLE ${schema}.events_early PARTITION OF ${schema}.events FOR VALUES FROM (1) TO (7);
    CREATE TABLE ${schema}.events_late PARTITION OF ${schema}.events FOR VALUES FROM (7) TO (13);`);
    const { app, pool, snapshots } = await createApp({
      DATABASE_URL: database,
      APP_KEY: "ab".repeat(32),
      APP_PASSWORD: "integration-password",
      COOKIE_SECURE: "false",
    });
    const server = app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    const base = `http://127.0.0.1:${server.address().port}`;
    let cookie, id;
    async function req(path, method = "GET", body) {
      const response = await fetch(base + "/api" + path, {
        method,
        headers: {
          "Content-Type": "application/json",
          ...(cookie ? { cookie } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      return {
        status: response.status,
        data: await response.json(),
        cookie: response.headers.get("set-cookie"),
      };
    }
    async function wait(job) {
      for (let i = 0; i < 300; i++) {
        const current = (await req(`/connections/${id}/jobs`)).data.find(
          (j) => j.id === job.id,
        );
        if (["succeeded", "failed"].includes(current.status)) return current;
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.fail("Refresh did not finish");
    }
    const route = (resource) => `/connections/${id}/${resource}`;
    try {
      cookie = (
        await req("/login", "POST", { password: "integration-password" })
      ).cookie.split(";")[0];
      const parsed = new URL(database);
      const created = await req("/connections", "POST", {
        name: "Snapshot test",
        host: parsed.hostname,
        port: Number(parsed.port),
        database: parsed.pathname.slice(1),
        username: parsed.username,
        password: parsed.password,
        sslMode: "disable",
      });
      assert.equal(created.status, 201);
      id = created.data.id;
      const baseline = await wait(created.data.job);
      assert.equal(baseline.status, "succeeded", baseline.error);
      assert.equal(baseline.baseline, true);
      assert.equal(baseline.change_count, 0);
      const list = (await req(route("objects") + "?schema=" + schema)).data;
      const item = list.find((r) => r.name === "items"),
        parent = list.find((r) => r.name === "parent"),
        events = list.find((r) => r.name === "events");
      let d = (await req(route("detail") + "?oid=" + item.id)).data;
      const fk = d.constraints.find((k) => k.type === "f");
      assert.equal(fk.referenced_table, `${schema}.parent`);
      assert.deepEqual(fk.attributes, ["parent_id"]);
      assert.deepEqual(fk.referenced_attributes, ["id"]);
      assert.equal(fk.on_delete, "CASCADE");
      assert.equal(fk.on_update, "RESTRICT");
      assert.ok(
        d.columns.some(
          (c) =>
            c.name === "generated_note" &&
            c.generated === "s" &&
            c.default.includes("upper"),
        ),
      );
      const idx = d.indexes.find((i) => i.name === "items_partial");
      assert.equal(idx.type, "btree");
      assert.deepEqual(idx.included_attributes, ["parent_id"]);
      assert.ok(idx.condition.includes("IS NOT NULL"));
      assert.ok(
        d.indexes.some((i) => i.unique && i.constraint_name === "items_unique"),
      );
      assert.ok(
        d.constraints.some(
          (k) =>
            k.name === "items_check" && k.status === "Validated" && k.condition,
        ),
      );
      const parts = (await req(route("detail") + "?oid=" + events.id)).data
        .partitions;
      assert.equal(parts.length, 3);
      assert.ok(
        parts.some(
          (p) =>
            p.name === "events_early" &&
            p.parent_id === events.id &&
            p.level === 1 &&
            p.method === "RANGE" &&
            p.bounds.includes("FROM (1)"),
        ),
      );
      const data = (
        await req(route("preview") + "?oid=" + item.id + "&limit=1")
      ).data;
      assert.equal(data.rows.length, 1);
      assert.ok(data.columns.includes("generated_note"));
      assert.equal(data.has_more, true);
      assert.equal(
        (await req(route("preview") + "?oid=" + item.id + "&limit=101")).status,
        400,
      );
      let job = await wait((await req(route("refresh"), "POST", {})).data);
      assert.equal(job.status, "succeeded", job.error);
      assert.equal(job.change_count, 0);
      await admin.query(`ALTER TABLE ${schema}.items RENAME COLUMN note TO message;
      ALTER TABLE ${schema}.items ALTER COLUMN message SET DEFAULT 'new';
      COMMENT ON COLUMN ${schema}.items.message IS 'Updated comment';
      ALTER TABLE ${schema}.items ADD COLUMN added_column integer;
      DROP INDEX ${schema}.items_partial;
      ALTER TABLE ${schema}.items DROP CONSTRAINT items_fk;
      ALTER TABLE ${schema}.items ADD CONSTRAINT items_fk FOREIGN KEY(parent_id) REFERENCES ${schema}.parent(id) ON DELETE SET NULL;
      ALTER TABLE ${schema}.items RENAME TO renamed_items;`);
      // Snapshot reads must not silently query the source or expose unrefreshed DDL.
      assert.equal(
        (await req(route("detail") + "?oid=" + item.id)).data.name,
        "items",
      );
      job = await wait((await req(route("refresh"), "POST", {})).data);
      assert.equal(job.status, "succeeded", job.error);
      assert.ok(job.change_count > 0);
      d = (await req(route("detail") + "?oid=" + item.id)).data;
      assert.equal(d.name, "renamed_items");
      assert.ok(d.columns.some((c) => c.name === "message"));
      const history = (await req(route("history") + "?oid=" + item.id)).data;
      assert.ok(
        history.changes.some(
          (c) =>
            c.entity_type === "column" &&
            c.field === "name" &&
            c.previous_value === "note" &&
            c.new_value === "message",
        ),
      );
      assert.ok(
        history.changes.some(
          (c) =>
            c.entity_type === "index" &&
            c.operation === "removed" &&
            c.previous_value.name === "items_partial",
        ),
      );
      assert.ok(
        history.changes.some(
          (c) =>
            c.entity_type === "table" &&
            c.field === "name" &&
            c.new_value === "renamed_items",
        ),
      );
      assert.ok(
        (await req(route("history") + "?oid=" + parent.id)).data.changes.some(
          (c) => c.entity_type === "constraint",
        ),
      );
      const first = (
        await req(route("history") + "?oid=" + item.id + "&limit=1")
      ).data;
      assert.equal(first.changes.length, 1);
      assert.ok(first.next);
      assert.notEqual(
        (
          await req(
            route("history") +
              "?oid=" +
              item.id +
              "&limit=1&before=" +
              first.next,
          )
        ).data.changes[0].id,
        first.changes[0].id,
      );
      assert.equal(
        (
          await pool.query(
            "SELECT count(*)::int AS n FROM metadata_snapshots WHERE connection_id=$1",
            [id],
          )
        ).rows[0].n,
        1,
      );
      assert.ok(
        !Object.keys((await req(route("jobs"))).data[0]).includes("payload"),
      );
      const positions = [
        d.columns.find((c) => c.name === "id").position,
        d.columns.find((c) => c.name === "parent_id").position,
      ];
      assert.equal(
        (
          await req(route("logical-key") + "?oid=" + item.id, "PUT", {
            name: "platform_pk",
            positions,
          })
        ).status,
        200,
      );
      d = (await req(route("detail") + "?oid=" + item.id)).data;
      assert.deepEqual(d.logical_keys[0].attributes, ["id", "parent_id"]);
      assert.ok(
        (await req(route("history") + "?oid=" + item.id)).data.changes.some(
          (c) => c.entity_type === "logical_key" && c.operation === "added",
        ),
      );
      assert.equal(
        (
          await req(route("logical-key") + "?oid=" + item.id, "PUT", {
            name: "bad",
            positions: [999],
          })
        ).status,
        400,
      );
      const before = (await req(route("snapshot"))).data;
      await pool.query("UPDATE metadata_connections SET port=1 WHERE id=$1", [
        id,
      ]);
      job = await wait((await req(route("refresh"), "POST", {})).data);
      assert.equal(job.status, "failed");
      assert.deepEqual((await req(route("snapshot"))).data, before);
      assert.equal(
        (await req(route("detail") + "?oid=" + item.id)).status,
        200,
      );
      assert.equal(
        (await req(route("preview") + "?oid=" + item.id)).status,
        502,
      );
      await pool.query("UPDATE metadata_connections SET port=$2 WHERE id=$1", [
        id,
        Number(parsed.port),
      ]);
      const a = await snapshots.enqueue(id),
        b = await snapshots.enqueue(id);
      assert.equal(a.id, b.id);
      await admin.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [
        id,
      ]);
      try {
        await snapshots.run(a.id);
        assert.equal(
          (await req(route("jobs"))).data.find((j) => j.id === a.id).status,
          "queued",
        );
        assert.equal(
          (
            await req(route("logical-key") + "?oid=" + item.id, "PUT", {
              name: "locked_key",
              positions,
            })
          ).status,
          409,
        );
      } finally {
        await admin.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [
          id,
        ]);
      }
      await snapshots.run(a.id);
      assert.equal((await wait(a)).status, "succeeded");
      assert.equal(
        (await req(route("schedule"), "PATCH", { minutes: 1 })).status,
        200,
      );
      await pool.query(
        "UPDATE metadata_refresh_jobs SET started_at=now()-interval '2 minutes' WHERE connection_id=$1",
        [id],
      );
      await snapshots.tick();
      assert.ok(
        (await req(route("jobs"))).data.some(
          (j) => j.trigger === "scheduled" && j.status === "succeeded",
        ),
      );
      await req(route("schedule"), "PATCH", { minutes: 0 });
      // An abandoned running job is marked failed after its session lock disappears.
      const abandoned = await snapshots.enqueue(id);
      await pool.query(
        "UPDATE metadata_refresh_jobs SET status='running' WHERE id=$1",
        [abandoned.id],
      );
      await snapshots.tick();
      assert.equal((await wait(abandoned)).status, "failed");
      await admin.query(`DROP TABLE ${schema}.renamed_items`);
      job = await wait((await req(route("refresh"), "POST", {})).data);
      assert.equal(job.status, "succeeded", job.error);
      assert.equal(
        (await req(route("detail") + "?oid=" + item.id)).status,
        404,
      );
      assert.ok(
        (await req(route("history") + "?oid=" + item.id)).data.changes.some(
          (c) => c.entity_type === "table" && c.operation === "removed",
        ),
      );
    } finally {
      if (id)
        await pool.query("DELETE FROM metadata_connections WHERE id=$1", [id]);
      await new Promise((r) => server.close(r));
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
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
      for (let attempt = 0; attempt < 100; attempt++) {
        const jobs = (await request(`/api/connections/${id}/jobs`)).body;
        const job = jobs.find((j) => j.id === created.body.job.id);
        if (job.status === "failed") assert.fail(job.error);
        if (job.status === "succeeded") break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
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
