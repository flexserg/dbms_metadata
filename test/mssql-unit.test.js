import { test } from "node:test";
import assert from "node:assert/strict";
import { typeName, quote } from "../src/mssql.js";
import { validateConnection } from "../src/metadata.js";
import { diffSnapshots } from "../src/snapshots.js";
test("SQL Server connection defaults and TLS modes are explicit", () => {
  const c = {
    name: "SQL",
    host: "localhost",
    database: "db",
    username: "reader",
    password: "test",
    engine: "mssql",
    sslMode: "verify-full",
  };
  assert.equal(validateConnection(c).port, 1433);
  assert.equal(
    validateConnection({ ...c, sslMode: "trust-server-certificate" }).sslMode,
    "trust-server-certificate",
  );
  assert.throws(() =>
    validateConnection({
      ...c,
      engine: "postgres",
      sslMode: "trust-server-certificate",
    }),
  );
  assert.throws(() => validateConnection({ ...c, engine: "unknown" }));
});
test("SQL Server names are escaped and parameterized type widths preserve metadata", () => {
  assert.equal(quote("some]name"), "[some]]name]");
  const types = new Map([
    ["1", { name: "nvarchar" }],
    ["2", { name: "decimal" }],
  ]);
  assert.equal(
    typeName({ user_type_id: 1, max_length: 100 }, types),
    "nvarchar(50)",
  );
  assert.equal(
    typeName({ user_type_id: 1, max_length: -1 }, types),
    "nvarchar(max)",
  );
  assert.equal(
    typeName({ user_type_id: 2, precision: 38, scale: 5 }, types),
    "decimal(38,5)",
  );
});
test("nullable added fields do not invent null-to-null history", () => {
  const a = {
      schemas: [],
      routines: [],
      relations: [
        {
          id: "1",
          schema: "dbo",
          name: "t",
          columns: [],
          indexes: [],
          constraints: [],
          partitions: [],
          logical_keys: [],
        },
      ],
    },
    b = structuredClone(a);
  b.relations[0].new_nullable_field = null;
  assert.deepEqual(diffSnapshots(a, b), []);
});
