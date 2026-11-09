import { test } from "node:test";
import assert from "node:assert/strict";
import { vault } from "../src/security.js";
import { validateConnection } from "../src/metadata.js";
test("encrypted credentials round-trip and reject tampering or a different key", () => {
  const a = vault("ab".repeat(32));
  const b = vault("cd".repeat(32));
  const encrypted = a.seal("database-secret");
  assert.equal(a.open(encrypted), "database-secret");
  assert.notEqual(encrypted, a.seal("database-secret"));
  assert.throws(() => b.open(encrypted));
  const bytes = Buffer.from(encrypted, "base64");
  bytes[20] ^= 1;
  assert.throws(() => a.open(bytes.toString("base64")));
});
test("sessions reject signature changes and password rotation", () => {
  const v = vault("ab".repeat(32));
  const token = v.token("old-password");
  assert.equal(v.verify(token, "old-password"), true);
  assert.equal(v.verify(token, "new-password"), false);
  assert.equal(v.verify(token + "a", "old-password"), false);
  assert.equal(v.verify(undefined, "old-password"), false);
});
test("connection validation bounds ports and requires an explicit TLS policy", () => {
  const c = {
    name: "test",
    host: "localhost",
    database: "test",
    username: "reader",
    password: "",
    port: 5432,
    sslMode: "verify-full",
  };
  assert.equal(validateConnection(c).port, 5432);
  assert.throws(() => validateConnection({ ...c, port: -1 }));
  assert.throws(() => validateConnection({ ...c, sslMode: "prefer" }));
});
