import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateConnection,
  driverProperties,
} from "../src/connection-options.js";
test("driver properties are typed, bounded and cannot override credentials or TLS", () => {
  assert.deepEqual(
    driverProperties("postgres", {
      application_name: "Atlas",
      query_timeout: "12000",
    }),
    { application_name: "Atlas", query_timeout: 12000 },
  );
  assert.deepEqual(driverProperties("mssql", { useUTC: "false" }), {
    useUTC: false,
  });
  for (const properties of [
    { password: "secret" },
    { ssl: false },
    { query_timeout: 0 },
    { __proto__: null, constructor: "evil" },
    { madeUpOption: "value" },
  ])
    assert.throws(() => driverProperties("postgres", properties));
  const c = {
    name: "Test",
    host: "localhost",
    database: "db",
    username: "reader",
    password: "",
    sslMode: "verify-ca",
    label: "Production",
    keepAlive: false,
  };
  assert.equal(validateConnection(c).keepAlive, false);
  assert.equal(validateConnection(c).label, "Production");
  assert.throws(() => validateConnection({ ...c, keepAlive: "false" }));
  assert.throws(() =>
    validateConnection({ ...c, caCertificate: "not a certificate" }),
  );
  assert.throws(() =>
    validateConnection({ ...c, caCertificate: "x".repeat(65537) }),
  );
});
