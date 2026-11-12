import { test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { capture, withTarget } from "../src/metadata.js";
test(
  "PostgreSQL capture uses a constant number of bulk queries across tables and schemas",
  { skip: !process.env.INTEGRATION },
  async () => {
    const database =
      process.env.TEST_DATABASE_URL ||
      "postgresql://metadata:integration-password@127.0.0.1:55432/metadata";
    const admin = new pg.Client({ connectionString: database });
    await admin.connect();
    const schema = "bulk_" + randomUUID().replaceAll("-", "");
    const url = new URL(database);
    const connection = {
      host: url.hostname,
      port: Number(url.port || 5432),
      database: url.pathname.slice(1),
      username: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      sslMode: "disable",
      keepAlive: false,
      driverProperties: {
        application_name: "Atlas bulk test",
        statement_timeout: 12000,
      },
    };
    async function run() {
      return withTarget(connection, async (client) => {
        assert.equal(
          (await client.query("SHOW application_name")).rows[0]
            .application_name,
          "Atlas bulk test",
        );
        const queries = [];
        const result = await capture({
          query: (...args) => {
            queries.push(args[0]);
            return client.query(...args);
          },
        });
        return { result, count: queries.length };
      });
    }
    try {
      const before = await run();
      await admin.query(`CREATE SCHEMA ${schema};CREATE SCHEMA ${schema}_other;
      CREATE FUNCTION ${schema}.one() RETURNS int LANGUAGE sql AS 'SELECT 1';
      CREATE FUNCTION ${schema}_other.two() RETURNS int LANGUAGE sql AS 'SELECT 2';`);
      for (let i = 0; i < 25; i++)
        await admin.query(
          `CREATE TABLE ${schema}.t${i}(id int PRIMARY KEY,note text DEFAULT 'value',CHECK(id>0));CREATE INDEX ON ${schema}.t${i}(lower(note)) INCLUDE(id) WHERE note IS NOT NULL`,
        );
      const supportsNullsNotDistinct =
        Number(
          (await admin.query("SHOW server_version_num")).rows[0]
            .server_version_num,
        ) >= 150000;
      if (supportsNullsNotDistinct)
        await admin.query(
          `CREATE UNIQUE INDEX nulls_equal ON ${schema}.t0(note) NULLS NOT DISTINCT`,
        );
      const after = await run();
      assert.equal(after.count, before.count);
      assert.equal(after.count, 10);
      const tables = after.result.relations.filter((r) => r.schema === schema);
      assert.equal(tables.length, 25);
      for (const table of tables) {
        assert.equal(table.columns.length, 2);
        assert.equal(table.constraints.length, 2);
        assert.ok(
          table.indexes.some(
            (i) =>
              i.attributes.includes("lower(note)") &&
              i.included_attributes.includes("id"),
          ),
        );
      }
      if (supportsNullsNotDistinct)
        assert.equal(
          tables
            .find((t) => t.name === "t0")
            .indexes.find((i) => i.name === "nulls_equal").nulls_not_distinct,
          true,
        );
      assert.ok(
        after.result.routines.some(
          (r) => r.schema === schema && r.name === "one",
        ),
      );
      assert.ok(
        after.result.routines.some(
          (r) => r.schema === schema + "_other" && r.name === "two",
        ),
      );
    } finally {
      await admin.query(
        `DROP SCHEMA IF EXISTS ${schema} CASCADE;DROP SCHEMA IF EXISTS ${schema}_other CASCADE`,
      );
      await admin.end();
    }
  },
);
