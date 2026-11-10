import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.js";
import { withTarget } from "../src/targets.js";
import { mssqlFixture } from "../fixtures/mssql.js";
test(
  "SQL Server catalog capture, relational persistence, preview, history and refresh",
  { skip: !process.env.MSSQL_INTEGRATION },
  async () => {
    const fixture = await mssqlFixture();
    const { app, pool } = await createApp({
      DATABASE_URL:
        process.env.TEST_DATABASE_URL ||
        "postgresql://metadata:integration-password@127.0.0.1:55432/metadata",
      APP_KEY: "ab".repeat(32),
      APP_PASSWORD: "integration-password",
      COOKIE_SECURE: "false",
    });
    const server = app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    const base = `http://127.0.0.1:${server.address().port}`;
    let cookie, id;
    const request = async (path, method = "GET", body) => {
      const r = await fetch(base + "/api" + path, {
        method,
        headers: {
          "Content-Type": "application/json",
          ...(cookie ? { cookie } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      return {
        status: r.status,
        data: await r.json(),
        cookie: r.headers.get("set-cookie"),
      };
    };
    const route = (r) => `/connections/${id}/${r}`;
    async function wait(job) {
      for (let n = 0; n < 200; n++) {
        const current = (await request(route("jobs"))).data.find(
          (j) => j.id === job.id,
        );
        if (current.status === "failed") assert.fail(current.error);
        if (current.status === "succeeded") return current;
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.fail("Refresh timed out");
    }
    try {
      cookie = (
        await request("/login", "POST", { password: "integration-password" })
      ).cookie.split(";")[0];
      assert.equal(
        (
          await request("/connections/test", "POST", {
            ...fixture.connection,
            password: "wrong",
          })
        ).status,
        502,
      );
      const probe = await request(
        "/connections/test",
        "POST",
        fixture.connection,
      );
      assert.equal(probe.status, 200);
      assert.equal(probe.data.engine, "mssql");
      assert.equal(
        (
          await request("/connections/test", "POST", {
            ...fixture.connection,
            sslMode: "verify-full",
          })
        ).status,
        502,
        "The test server's self-signed certificate must not pass verified TLS",
      );
      const created = await request("/connections", "POST", fixture.connection);
      assert.equal(created.status, 201);
      id = created.data.id;
      await wait(created.data.job);
      const profiles = (await request("/connections")).data;
      assert.equal(profiles.find((c) => c.id === id).engine, "mssql");
      assert.equal(profiles.find((c) => c.id === id).password, undefined);
      const objects = (await request(route("objects") + "?schema=app")).data;
      const items = objects.find((r) => r.name === "Items"),
        events = objects.find((r) => r.name === "Events"),
        view = objects.find((r) => r.name === "ItemsView");
      assert.ok(items && events && view);
      let d = (await request(route("detail") + "?oid=" + items.id)).data;
      assert.equal(d.comment, "Items table");
      assert.equal(d.columns.find((c) => c.name === "id").identity, "mssql");
      assert.equal(d.columns.find((c) => c.name === "id").identity_seed, "10");
      assert.equal(
        d.columns.find((c) => c.name === "id").identity_increment,
        "5",
      );
      assert.equal(
        d.columns.find((c) => c.name === "upper_label").generated,
        "mssql_persisted",
      );
      assert.equal(
        d.columns.find((c) => c.name === "label").comment,
        "Item label",
      );
      assert.equal(
        d.columns.find((c) => c.name === "code").type,
        "[app].[Code]",
      );
      assert.equal(
        d.columns.find((c) => c.name === "price").type,
        "decimal(38,5)",
      );
      const fk = d.constraints.find((k) => k.type === "f");
      assert.deepEqual(fk.attributes, ["parent_a", "parent_b"]);
      assert.deepEqual(fk.referenced_attributes, ["a", "b"]);
      assert.equal(fk.referenced_table, "[app].[Parent]");
      assert.equal(fk.on_delete, "CASCADE");
      assert.equal(fk.on_update, "NO ACTION");
      assert.equal(
        d.constraints.find((k) => k.name === "CK_Price").status,
        "Disabled",
      );
      assert.ok(
        d.constraints.some(
          (k) => k.type === "d" && k.attributes.includes("label"),
        ),
      );
      const index = d.indexes.find((i) => i.name === "IX_Label");
      assert.deepEqual(index.attributes, ["[label] DESC"]);
      assert.deepEqual(index.included_attributes, ["[price]"]);
      assert.ok(index.condition);
      assert.equal(index.type, "NONCLUSTERED");
      assert.ok(
        d.indexes.some((i) => i.unique && i.constraint_name === "UQ_Code"),
      );
      const physical = (await request(route("detail") + "?oid=" + events.id))
        .data;
      assert.equal(physical.sqlserver_partitions.length, 3);
      const columnstore = physical.indexes.find(
        (i) => i.name === "IX_Columnstore",
      );
      assert.equal(columnstore.type, "NONCLUSTERED COLUMNSTORE");
      assert.equal(columnstore.attributes.length, 2);
      assert.deepEqual(columnstore.included_attributes, []);
      assert.equal(physical.sqlserver_partitions[0].upper_bound, "100");
      assert.equal(physical.sqlserver_partitions[1].lower_bound, "100");
      assert.equal(physical.sqlserver_partitions[1].upper_bound, "200");
      assert.equal(physical.sqlserver_partitions[0].boundary_on_right, true);
      assert.equal(physical.partitions[0].partition_key, "[bucket]");
      const rows = (await request(route("preview") + "?oid=" + items.id)).data;
      assert.equal(rows.rows[0][rows.columns.indexOf("id")], "10");
      assert.equal(
        rows.rows[0][rows.columns.indexOf("price")],
        "123456789012345678901234567890.12345",
      );
      assert.equal(
        (await request(route("preview") + "?oid=1;DROP")).status,
        400,
      );
      const routines = (await request(route("routines") + "?schema=app")).data;
      assert.ok(
        routines.some(
          (r) =>
            r.name === "ListItems" &&
            r.language === "T-SQL" &&
            r.arguments.includes("@prefix"),
        ),
      );
      assert.ok(routines.some((r) => r.name === "DoubleIt"));
      assert.match(
        (await request(route("detail") + "?oid=" + view.id)).data.definition,
        /SELECT/,
      );
      await assert.rejects(
        withTarget(fixture.connection, (c) =>
          c.query("INSERT app.Parent VALUES(3,4)"),
        ),
        /permission was denied/i,
      );
      assert.equal(
        (await wait((await request(route("refresh"), "POST", {})).data))
          .change_count,
        0,
      );
      await fixture.db
        .request()
        .batch(
          "ALTER TABLE app.Items ADD added_column int NULL;ALTER TABLE app.Items WITH CHECK CHECK CONSTRAINT CK_Price;",
        );
      await wait((await request(route("refresh"), "POST", {})).data);
      const history = (await request(route("history") + "?oid=" + items.id))
        .data.changes;
      assert.ok(
        history.some(
          (c) =>
            c.entity_type === "column" &&
            c.operation === "added" &&
            c.new_value.name === "added_column",
        ),
      );
      assert.ok(
        history.some(
          (c) =>
            c.entity_type === "constraint" &&
            c.field === "enabled" &&
            c.previous_value === false &&
            c.new_value === true,
        ),
      );
      d = (await request(route("detail") + "?oid=" + items.id)).data;
      assert.equal(
        d.constraints.find((k) => k.name === "CK_Price").status,
        "Enabled",
      );
      assert.equal(
        (
          await pool.query(
            "SELECT count(*)::int n FROM metadata_sqlserver_partitions WHERE connection_id=$1",
            [id],
          )
        ).rows[0].n,
        3,
      );
      assert.equal(
        (await request(route("history-settings"), "PATCH", { days: 7 })).status,
        200,
      );
      assert.ok(
        (await request(route("history"), "DELETE", { oid: items.id })).data
          .deleted > 0,
      );
      assert.equal(
        (await request(route("history") + "?oid=" + items.id)).data.changes
          .length,
        0,
      );
      assert.equal(
        (await wait((await request(route("refresh"), "POST", {})).data))
          .change_count,
        0,
      );
    } finally {
      if (id)
        await pool.query("DELETE FROM metadata_connections WHERE id=$1", [id]);
      await new Promise((r) => server.close(r));
      await pool.end();
      await fixture.cleanup();
    }
  },
);
